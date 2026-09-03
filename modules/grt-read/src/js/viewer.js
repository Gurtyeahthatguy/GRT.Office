/** Page rendering and navigation. */

import * as pdfjs from '../vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

const CMAP_URL = new URL('../vendor/cmaps/', import.meta.url).href;
const STANDARD_FONTS_URL = new URL('../vendor/standard_fonts/', import.meta.url).href;

/** How much memory the canvas cache may hold. */
function canvasBudgetBytes() {
  const gigabytes = navigator.deviceMemory || 4;
  return Math.min(gigabytes * 0.12 * 1024 ** 3, 512 * 1024 ** 2);
}

/** Render resolution. */
function outputScale() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

export class Viewer {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.container = container;
    this.docs = new Map();        // sourceId → PDFDocumentProxy.
    this.dims = new Map();        // "sourceId:index" → {width, height} at scale 1.
    this.model = null;
    this.scale = 1;
    this.pageElements = [];       // one per visible page, in view order.
    this.rendered = new Map();    // viewIndex → {canvas, bytes}.
    this.renderTasks = new Map(); // viewIndex → RenderTask.
    this.currentPage = 0;
    this.onPageChange = () => {};

    // 'select' | 'highlight' | 'redact'.
    this.markMode = 'select';
    this.onMarkDrawn = () => {};
    this.installMarkDrawing();

    this.observer = new IntersectionObserver(
      (entries) => this.handleIntersections(entries),
      {
        root: container,
        // Start rendering before a page scrolls into view, so ordinary
        // scrolling does not show blank rectangles.
        rootMargin: '200% 0px',
        threshold: 0,
      },
    );

    // Tracks which page the user is actually looking at, for the indicator
    // and for the thumbnail highlight.
    this.currentObserver = new IntersectionObserver(
      (entries) => this.handleCurrentPage(entries),
      { root: container, threshold: 0.5 },
    );
  }

  /**
   * Parses a PDF and remembers it under a source id.
   * @returns {Promise<number>} page count
   */
  async addSource(sourceId, bytes) {
    const task = pdfjs.getDocument({
      data: bytes.slice(0),
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONTS_URL,
      // Nothing in this program may reach the network, not even for a font a
      // document asks for by URL.
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
    });
    const doc = await task.promise;
    this.docs.set(sourceId, doc);
    return doc.numPages;
  }

  /** Frees every PDF.js resource. */
  async reset() {
    this.observer.disconnect();
    this.currentObserver.disconnect();
    for (const task of this.renderTasks.values()) task.cancel();
    this.renderTasks.clear();
    for (const entry of this.rendered.values()) releaseCanvas(entry.canvas);
    this.rendered.clear();
    for (const doc of this.docs.values()) await doc.destroy();
    this.docs.clear();
    this.dims.clear();
    this.pageElements = [];
    this.container.replaceChildren();
  }

  /** Reads the intrinsic size of every page that will be shown. */
  async measure(plan) {
    const missing = plan.filter(
      (step) => !this.dims.has(`${step.sourceId}:${step.originalIndex}`),
    );

    // In batches, so a 500-page document does not open five hundred parallel
    // page requests at once.
    const batchSize = 32;
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (step) => {
          const doc = this.docs.get(step.sourceId);
          const page = await doc.getPage(step.originalIndex + 1);
          const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
          this.dims.set(`${step.sourceId}:${step.originalIndex}`, {
            width: viewport.width,
            height: viewport.height,
            baseRotation: page.rotate,
          });
        }),
      );
    }
  }

  /** Rebuilds the page list from the model. */
  async layout(model) {
    this.model = model;
    const plan = model.buildPlan();
    await this.measure(plan);

    this.observer.disconnect();
    this.currentObserver.disconnect();
    for (const task of this.renderTasks.values()) task.cancel();
    this.renderTasks.clear();
    for (const entry of this.rendered.values()) releaseCanvas(entry.canvas);
    this.rendered.clear();

    this.pageElements = plan.map((step, viewIndex) => {
      const element = document.createElement('div');
      element.className = 'page';
      element.dataset.viewIndex = String(viewIndex);

      const size = this.pageSize(step);
      element.style.width = `${size.width}px`;
      element.style.height = `${size.height}px`;

      const number = document.createElement('span');
      number.className = 'page-number';
      number.textContent = String(viewIndex + 1);
      element.append(number);

      // Marks are drawn as plain elements over the canvas rather than into
      // it, so they survive a re-render and cost nothing to move or remove.
      for (const mark of step.marks ?? []) {
        element.append(markElement(mark));
      }

      return element;
    });

    this.container.replaceChildren(...this.pageElements);
    for (const element of this.pageElements) {
      this.observer.observe(element);
      this.currentObserver.observe(element);
    }
  }

  /**
   * On-screen size of a page, accounting for zoom and the model's rotation.
   */
  pageSize(step) {
    const dims = this.dims.get(`${step.sourceId}:${step.originalIndex}`);
    if (!dims) return { width: 595 * this.scale, height: 842 * this.scale };

    // A quarter turn swaps width and height; a half turn does not.
    const quarterTurned = step.rotation % 180 !== 0;
    const width = quarterTurned ? dims.height : dims.width;
    const height = quarterTurned ? dims.width : dims.height;
    return { width: width * this.scale, height: height * this.scale };
  }

  handleIntersections(entries) {
    for (const entry of entries) {
      const viewIndex = Number(entry.target.dataset.viewIndex);
      if (entry.isIntersecting) this.renderPage(viewIndex);
    }
    this.evict();
  }

  handleCurrentPage(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const viewIndex = Number(entry.target.dataset.viewIndex);
      if (viewIndex !== this.currentPage) {
        this.currentPage = viewIndex;
        this.onPageChange(viewIndex);
      }
    }
  }

  async renderPage(viewIndex) {
    if (this.rendered.has(viewIndex) || this.renderTasks.has(viewIndex)) return;

    const element = this.pageElements[viewIndex];
    const step = this.model?.buildPlan()[viewIndex];
    if (!element || !step) return;

    const doc = this.docs.get(step.sourceId);
    if (!doc) return;

    const page = await doc.getPage(step.originalIndex + 1);
    // The model's rotation is relative to whatever the page already carried.
    const rotation = (page.rotate + step.rotation) % 360;
    const viewport = page.getViewport({ scale: this.scale, rotation });

    const ratio = outputScale();
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = canvas.getContext('2d', { alpha: false });
    const task = page.render({
      canvasContext: context,
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    });
    this.renderTasks.set(viewIndex, task);

    try {
      await task.promise;
    } catch (err) {
      // A cancelled render is the normal outcome of scrolling quickly past a
      // page, not a failure worth reporting.
      if (err?.name !== 'RenderingCancelledException') throw err;
      return;
    } finally {
      this.renderTasks.delete(viewIndex);
    }

    // The page may have been rebuilt underneath us while rendering.
    if (this.pageElements[viewIndex] !== element) {
      releaseCanvas(canvas);
      return;
    }

    const existing = element.querySelector('canvas');
    if (existing) releaseCanvas(existing);
    element.prepend(canvas);
    this.rendered.set(viewIndex, { canvas, bytes: canvas.width * canvas.height * 4 });
    this.evict();
  }

  /**
   * Drops the least recently needed canvases until the cache fits its budget.
   */
  evict() {
    const budget = canvasBudgetBytes();
    let total = 0;
    for (const entry of this.rendered.values()) total += entry.bytes;
    if (total <= budget) return;

    const byDistance = [...this.rendered.keys()].sort(
      (a, b) => Math.abs(b - this.currentPage) - Math.abs(a - this.currentPage),
    );

    for (const viewIndex of byDistance) {
      if (total <= budget) break;
      // Never evict what is on screen right now.
      if (Math.abs(viewIndex - this.currentPage) <= 1) continue;

      const entry = this.rendered.get(viewIndex);
      const element = this.pageElements[viewIndex];
      if (element) element.querySelector('canvas')?.remove();
      releaseCanvas(entry.canvas);
      this.rendered.delete(viewIndex);
      total -= entry.bytes;
    }
  }

  /** Rubber-band drawing for highlights and redactions. */
  installMarkDrawing() {
    let band = null;
    let host = null;
    let origin = null;

    const positionFrom = (event) => {
      const box = host.getBoundingClientRect();
      return {
        x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
        y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
      };
    };

    this.container.addEventListener('mousedown', (event) => {
      if (this.markMode === 'select' || event.button !== 0) return;
      const page = event.target.closest('.page');
      if (!page) return;

      event.preventDefault();
      host = page;
      origin = positionFrom(event);

      band = document.createElement('div');
      band.className = `mark mark-${this.markMode} drawing`;
      host.append(band);
    });

    this.container.addEventListener('mousemove', (event) => {
      if (!band) return;
      const current = positionFrom(event);
      const rect = {
        x: Math.min(origin.x, current.x),
        y: Math.min(origin.y, current.y),
        width: Math.abs(current.x - origin.x),
        height: Math.abs(current.y - origin.y),
      };
      Object.assign(band.style, {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
      });
      band.dataset.rect = JSON.stringify(rect);
    });

    const finish = () => {
      if (!band) return;
      const rect = band.dataset.rect ? JSON.parse(band.dataset.rect) : null;
      const viewIndex = Number(host.dataset.viewIndex);
      band.remove();
      band = null;
      host = null;

      // A click with no drag is not a mark; it would otherwise leave an
      // invisible zero-sized region in the document.
      if (rect && rect.width > 0.005 && rect.height > 0.005) {
        this.onMarkDrawn(viewIndex, this.markMode, rect);
      }
    };

    this.container.addEventListener('mouseup', finish);
    this.container.addEventListener('mouseleave', finish);
  }

  /** Re-renders everything at a new zoom level. */
  async setScale(scale, model) {
    this.scale = Math.min(Math.max(scale, 0.1), 8);
    await this.layout(model);
  }

  /** Zoom that makes the widest visible page fit the window. */
  fitWidth(model) {
    const plan = model.buildPlan();
    if (plan.length === 0) return this.scale;
    const widest = Math.max(
      ...plan.map((step) => this.pageSize(step).width / this.scale),
    );
    const available = this.container.clientWidth - 48;
    return available > 0 ? available / widest : this.scale;
  }

  scrollToPage(viewIndex) {
    const element = this.pageElements[viewIndex];
    if (element) element.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /**
   * Finds pages whose text contains the query.
   * @returns {Promise<number[]>} view indices, in order
   */
  async findText(query, model) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const plan = model.buildPlan();
    const hits = [];

    for (let viewIndex = 0; viewIndex < plan.length; viewIndex += 1) {
      const step = plan[viewIndex];
      const doc = this.docs.get(step.sourceId);
      if (!doc) continue;
      const page = await doc.getPage(step.originalIndex + 1);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str ?? '').join(' ');
      if (text.toLowerCase().includes(needle)) hits.push(viewIndex);
    }

    return hits;
  }
}

/**
 * Zeroing the dimensions releases the backing buffer immediately instead of
 * waiting for the garbage collector, which on a document being scrolled
 * quickly is the difference between steady memory use and a climb.
 */
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

/** One highlight or redaction, positioned in page-relative percentages. */
function markElement(mark) {
  const element = document.createElement('div');
  element.className = `mark mark-${mark.type}`;
  element.style.left = `${mark.rect.x * 100}%`;
  element.style.top = `${mark.rect.y * 100}%`;
  element.style.width = `${mark.rect.width * 100}%`;
  element.style.height = `${mark.rect.height * 100}%`;
  return element;
}
