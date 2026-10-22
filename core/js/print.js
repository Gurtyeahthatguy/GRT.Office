/** Printing: pages of a fixed size, shown first, then handed to the system's print dialog. */

import { PAGE_SIZES, pageDimensions } from './editor/model.js';
import { escapeHtml } from './panel.js';

const STYLE_ID = 'grt-print-style';
const PAGE_ID = 'grt-print-page';

const CSS = `
#print-view { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column;
  background: var(--bg-sunken, #d8d8d8); color: var(--text, #111); }
#print-view .print-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 8px 12px; background: var(--bg-raised, #fff); border-bottom: 1px solid var(--border, #ccc); }
#print-view .print-toolbar label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
#print-view .print-controls { display: contents; }
#print-view .print-spacer { flex: 1; }
#print-view .print-count { font-size: 12px; color: var(--text-dim, #555); }
#print-view .print-pages { flex: 1; overflow: auto; padding: 18px; display: flex; flex-direction: column;
  align-items: center; gap: 18px; }
#print-view .print-frame { flex: none; }
.print-page { position: relative; overflow: hidden; background: #fff; color: #000; box-sizing: border-box;
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.35); transform-origin: top left;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print {
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important;
    height: auto !important; min-height: 0 !important; overflow: visible !important; display: block !important; }
  body > *:not(#print-view) { display: none !important; }
  #print-view { position: static !important; display: block !important; background: none !important; }
  #print-view .print-toolbar { display: none !important; }
  #print-view .print-pages { display: block !important; padding: 0 !important; overflow: visible !important; }
  #print-view .print-frame { width: auto !important; height: auto !important; }
  .print-page { box-shadow: none !important; transform: none !important; margin: 0 !important;
    break-after: page; page-break-after: always; }
  .print-frame:last-child .print-page { break-after: auto; page-break-after: auto; }
}`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/** The printed page's own size, for the print dialog's paper. */
function setPaper(width, height) {
  let style = document.getElementById(PAGE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = PAGE_ID;
    document.head.append(style);
  }
  // A page exactly as high as the paper rounds over it and leaves a blank page after it.
  style.textContent = `@page { size: ${width}mm ${height}mm; margin: 0; }
@media print { .print-page { height: calc(${height}mm - 1px) !important; } }`;
}

/** A blank page of a size, in millimetres, to draw on. */
export function makePage(width, height) {
  const page = document.createElement('div');
  page.className = 'print-page';
  page.style.width = `${width}mm`;
  page.style.height = `${height}mm`;
  return page;
}

/** The page settings every program shares: size and orientation, and margins when asked. */
export function pageControls(setup, { margins = false } = {}) {
  let sizes = Object.entries(PAGE_SIZES).map(([id, s]) =>
    `<option value="${id}"${setup.size === id ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('');
  if (setup.size === 'custom') {
    const own = pageDimensions(setup);
    sizes += `<option value="custom" selected>${own.w}×${own.h} mm</option>`;
  }
  const margin = margins ? `<label>Margins (mm)<input type="number" data-print-field="margin" min="0" max="50"
    value="${setup.margin ?? 10}" style="width:4em" /></label>` : '';
  return `
    <label>Paper<select data-print-field="size">${sizes}</select></label>
    <label>Orientation<select data-print-field="orientation">
      <option value="portrait"${setup.orientation !== 'landscape' ? ' selected' : ''}>Portrait</option>
      <option value="landscape"${setup.orientation === 'landscape' ? ' selected' : ''}>Landscape</option>
    </select></label>${margin}`;
}

/** The paper's width and height in millimetres, as it lies. */
export function paperSize(setup) {
  const size = pageDimensions(setup);
  return setup.orientation === 'landscape' ? { width: size.h, height: size.w } : { width: size.w, height: size.h };
}

let open = false;

export function isPrintPreviewOpen() {
  return open;
}

/**
 * Shows the pages, lets their settings change, and prints them on request.
 * @param {object} options
 * @param {string} options.title
 * @param {object} options.setup the settings the pages are built from
 * @param {(setup: object) => string} options.controls the settings' HTML, fields marked data-print-field
 * @param {(setup: object) => Promise<{width: number, height: number, pages: HTMLElement[]}>|object} options.build
 * @returns {Promise<object>} the settings as they were when the preview closed
 */
export function printPreview({ title, setup, controls = () => '', build }) {
  ensureStyle();
  open = true;
  let current = { ...setup };

  const view = document.createElement('div');
  view.id = 'print-view';
  view.innerHTML = `
    <div class="print-toolbar" role="toolbar" aria-label="Print">
      <strong>${escapeHtml(title)}</strong>
      <span class="print-controls"></span>
      <span class="print-spacer"></span>
      <span class="print-count" aria-live="polite"></span>
      <button type="button" data-print="close">Close</button>
      <button type="button" class="primary" data-print="go">Print…</button>
    </div>
    <div class="print-pages"></div>`;
  document.body.append(view);
  const pagesHost = view.querySelector('.print-pages');
  const controlsHost = view.querySelector('.print-controls');
  const count = view.querySelector('.print-count');

  const readControls = () => {
    const values = {};
    for (const field of controlsHost.querySelectorAll('[data-print-field]')) {
      const key = field.dataset.printField;
      if (field.type === 'checkbox') values[key] = field.checked;
      else if (field.type === 'number') values[key] = Number(field.value);
      else values[key] = field.value;
    }
    return values;
  };

  let building = Promise.resolve();
  let paper = null;
  const rebuild = () => {
    count.textContent = 'Preparing pages…';
    building = building.then(async () => {
      const { width, height, pages } = await build(current);
      paper = { width, height };
      setPaper(width, height);
      const available = Math.max(200, pagesHost.clientWidth - 64);
      const natural = (width * 96) / 25.4;
      const scale = Math.min(1, available / natural);
      pagesHost.replaceChildren(...pages.map((page) => {
        const frame = document.createElement('div');
        frame.className = 'print-frame';
        frame.style.width = `${natural * scale}px`;
        frame.style.height = `${((height * 96) / 25.4) * scale}px`;
        page.style.transform = scale < 1 ? `scale(${scale})` : '';
        frame.append(page);
        return frame;
      }));
      count.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
    });
    return building;
  };

  controlsHost.innerHTML = controls(current);
  controlsHost.addEventListener('change', () => {
    current = { ...current, ...readControls() };
    controlsHost.innerHTML = controls(current);
    rebuild();
  });

  return new Promise((resolve) => {
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      view.remove();
      open = false;
      resolve(current);
    };
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }
    document.addEventListener('keydown', onKey, true);
    view.querySelector('[data-print="close"]').onclick = close;
    view.querySelector('[data-print="go"]').onclick = async () => {
      await building;
      await picturesReady(pagesHost);
      try {
        await window.__TAURI__.core.invoke('print_page', paper);
      } catch {
        window.print();
      }
    };
    rebuild();
  });
}

// Flowing text onto pages

/** The lines of text in an element, top and bottom, relative to a point. */
export function textLines(element, origin) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = [...(range.getClientRects?.() ?? [])]
    .filter((r) => r.height > 0 && r.width > 0)
    .map((r) => ({ top: r.top - origin, bottom: r.bottom - origin }))
    .sort((a, b) => a.top - b.top);
  const lines = [];
  for (const rect of rects) {
    const last = lines[lines.length - 1];
    if (last && rect.top < last.bottom - 1) last.bottom = Math.max(last.bottom, rect.bottom);
    else lines.push({ ...rect });
  }
  return lines;
}

/**
 * Cuts a column laid out at its printed width into windows a page high,
 * between blocks or between lines, never through a line.
 * @param {HTMLElement} column its children are the blocks
 * @param {number} height the page's text height in pixels
 * @param {object} [rules]
 * @param {(block: HTMLElement) => boolean} [rules.keepWithNext] not left at the foot of a page
 * @param {(block: HTMLElement) => boolean} [rules.breakBefore] starts a page
 * @param {(block: HTMLElement) => boolean} [rules.whole] never split
 * @returns {{start: number, end: number}[]}
 */
export function flowBreaks(column, height, rules = {}) {
  const { keepWithNext = () => false, breakBefore = () => false, whole = () => false } = rules;
  height = Math.max(height, 24);
  const origin = column.getBoundingClientRect().top;
  const blocks = [...column.children].map((element) => {
    const rect = element.getBoundingClientRect();
    return { element, top: rect.top - origin, bottom: rect.bottom - origin };
  }).filter((b) => b.bottom > b.top || b.element.childNodes.length > 0);
  if (blocks.length === 0) return [{ start: 0, end: 0 }];

  // Every place a page may end, and where the next one then starts.
  const cuts = [];
  blocks.forEach((block, i) => {
    if (!whole(block.element)) {
      const lines = textLines(block.element, origin);
      // Two lines at least stay on each side of a split.
      for (let k = 1; k < lines.length - 1; k += 1) {
        if (k < 2 || lines.length - k < 2) continue;
        const at = (lines[k - 1].bottom + lines[k].top) / 2;
        if (at > block.top && at < block.bottom) cuts.push({ end: at, next: at, rank: 1 });
      }
    }
    const following = blocks[i + 1];
    if (following) {
      cuts.push({
        end: block.bottom,
        next: following.top,
        forced: breakBefore(following.element),
        rank: keepWithNext(block.element) ? 2 : 0,
      });
    }
  });
  cuts.sort((a, b) => a.end - b.end);
  const last = blocks[blocks.length - 1].bottom;

  const pages = [];
  let start = Math.min(0, blocks[0].top);
  while (start < last - 0.5) {
    const limit = start + height;
    const forced = cuts.find((c) => c.forced && c.next > start && c.end <= limit);
    if (forced) {
      pages.push({ start, end: forced.end });
      start = forced.next;
      continue;
    }
    if (last <= limit) {
      pages.push({ start, end: last });
      break;
    }
    const open = cuts.filter((c) => c.next > start && c.end <= limit && c.end > start);
    const cut = open.filter((c) => c.rank < 2).pop() ?? open.pop();
    if (cut) {
      pages.push({ start, end: cut.end });
      start = cut.next;
    } else {
      // A picture or a line taller than the page is cut where the page ends.
      pages.push({ start, end: limit });
      start = limit;
    }
  }
  return pages.length > 0 ? pages : [{ start: 0, end: 0 }];
}

/** One page's window of a laid-out column, as copies of the blocks that show in it. */
export function flowPage(column, { start, end }) {
  const box = column.getBoundingClientRect();
  const body = document.createElement('div');
  body.style.position = 'relative';
  body.style.overflow = 'hidden';
  body.style.height = `${Math.max(0, end - start)}px`;
  for (const element of column.children) {
    const rect = element.getBoundingClientRect();
    const top = rect.top - box.top;
    const bottom = rect.bottom - box.top;
    if ((bottom <= start && bottom > top) || (top >= end && top > start)) continue;
    const copy = element.cloneNode(true);
    Object.assign(copy.style, {
      position: 'absolute',
      top: `${top - start}px`,
      left: `${rect.left - box.left}px`,
      width: `${rect.width}px`,
      margin: '0',
      boxSizing: 'border-box',
    });
    body.append(copy);
  }
  return body;
}

/** A column, out of sight, where content is laid out at its printed width before it is cut into pages. */
export function measuringColumn(widthMm, className = '') {
  const column = document.createElement('div');
  column.className = className;
  Object.assign(column.style, {
    position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden',
    width: `${widthMm}mm`, background: '#fff', color: '#111',
  });
  document.body.append(column);
  return column;
}

/** Waits until the pictures in an element have their sizes. */
export async function picturesReady(element) {
  await Promise.all([...element.querySelectorAll('img')].map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
  if (document.fonts?.ready) await document.fonts.ready;
}
