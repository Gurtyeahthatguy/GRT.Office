/** Page sidebar: selection and reordering. */

const THUMB_WIDTH = 132;

export class Thumbnails {
  /**
   * @param {HTMLElement} container
   * @param {Viewer} viewer shared, so page sizes are measured only once
   */
  constructor(container, viewer) {
    this.container = container;
    this.viewer = viewer;
    this.model = null;
    this.elements = [];
    this.selection = new Set();
    this.dragIndex = null;

    this.onSelect = () => {};
    this.onActivate = () => {};
    this.onReorder = () => {};

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.render(Number(entry.target.dataset.viewIndex));
          }
        }
      },
      { root: container, rootMargin: '300% 0px', threshold: 0 },
    );
  }

  async layout(model) {
    this.model = model;
    const plan = model.buildPlan();
    this.observer.disconnect();

    // Selections refer to positions that may no longer exist after a delete.
    this.selection = new Set(
      [...this.selection].filter((i) => i < plan.length),
    );

    this.elements = plan.map((step, viewIndex) => this.build(step, viewIndex));
    this.container.replaceChildren(...this.elements);
    for (const element of this.elements) this.observer.observe(element);
    this.refreshSelection();
  }

  build(step, viewIndex) {
    const element = document.createElement('div');
    element.className = 'thumb';
    element.dataset.viewIndex = String(viewIndex);
    element.draggable = true;

    // The placeholder holds the right aspect ratio from the start, so the
    // sidebar does not reflow as thumbnails appear.
    const size = this.viewer.pageSize(step);
    const ratio = size.height / size.width;
    const placeholder = document.createElement('div');
    placeholder.className = 'thumb-placeholder';
    placeholder.style.height = `${Math.round(THUMB_WIDTH * ratio)}px`;
    element.append(placeholder);

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = String(viewIndex + 1);
    element.append(label);

    element.addEventListener('click', (event) => this.click(viewIndex, event));
    element.addEventListener('dblclick', () => this.onActivate(viewIndex));
    element.addEventListener('dragstart', (event) => {
      this.dragIndex = viewIndex;
      element.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag without data being set.
      event.dataTransfer.setData('text/plain', String(viewIndex));
    });
    element.addEventListener('dragend', () => {
      element.classList.remove('dragging');
      this.clearDropMarkers();
      this.dragIndex = null;
    });
    element.addEventListener('dragover', (event) => {
      if (this.dragIndex === null) return;
      event.preventDefault();
      this.clearDropMarkers();
      element.classList.add('drop-before');
    });
    element.addEventListener('drop', (event) => {
      event.preventDefault();
      this.clearDropMarkers();
      if (this.dragIndex === null || this.dragIndex === viewIndex) return;
      this.onReorder(this.dragIndex, viewIndex);
    });

    return element;
  }

  clearDropMarkers() {
    for (const element of this.elements) {
      element.classList.remove('drop-before', 'drop-after');
    }
  }

  click(viewIndex, event) {
    if (event.shiftKey && this.selection.size > 0) {
      // Range selection extends from the lowest existing selection, which is
      // what makes shift-clicking down a long document behave predictably.
      const anchor = Math.min(...this.selection);
      const [from, to] = anchor <= viewIndex
        ? [anchor, viewIndex]
        : [viewIndex, anchor];
      for (let i = from; i <= to; i += 1) this.selection.add(i);
    } else if (event.ctrlKey || event.metaKey) {
      if (this.selection.has(viewIndex)) this.selection.delete(viewIndex);
      else this.selection.add(viewIndex);
    } else {
      this.selection = new Set([viewIndex]);
      this.onActivate(viewIndex);
    }
    this.refreshSelection();
    this.onSelect([...this.selection].sort((a, b) => a - b));
  }

  refreshSelection() {
    this.elements.forEach((element, i) => {
      element.classList.toggle('selected', this.selection.has(i));
    });
  }

  setCurrent(viewIndex) {
    this.elements.forEach((element, i) => {
      element.classList.toggle('current', i === viewIndex);
    });
    const element = this.elements[viewIndex];
    if (element) {
      const box = element.getBoundingClientRect();
      const parent = this.container.getBoundingClientRect();
      if (box.top < parent.top || box.bottom > parent.bottom) {
        element.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  get selected() {
    return [...this.selection].sort((a, b) => a - b);
  }

  clearSelection() {
    this.selection.clear();
    this.refreshSelection();
    this.onSelect([]);
  }

  async render(viewIndex) {
    const element = this.elements[viewIndex];
    if (!element || element.dataset.rendered === 'yes') return;
    element.dataset.rendered = 'yes';

    const step = this.model?.buildPlan()[viewIndex];
    const doc = step && this.viewer.docs.get(step.sourceId);
    if (!doc) return;

    const page = await doc.getPage(step.originalIndex + 1);
    const rotation = (page.rotate + step.rotation) % 360;
    const unit = page.getViewport({ scale: 1, rotation });
    const viewport = page.getViewport({
      scale: THUMB_WIDTH / unit.width,
      rotation,
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    try {
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
      }).promise;
    } catch {
      element.dataset.rendered = 'no';
      return;
    }

    // The list may have been rebuilt while this was rendering.
    if (this.elements[viewIndex] !== element) {
      canvas.width = 0;
      return;
    }

    element.querySelector('.thumb-placeholder')?.replaceWith(canvas);
  }
}
