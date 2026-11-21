/** Page Layout, as Writer's status bar offers it: the pages one under another, several to a row, or as a book's spreads. */

import { usePrintStyles } from './core/print.js';

export const LAYOUTS = { single: 'Single Page per Row', multiple: 'Multiple Pages per Row', book: 'Book View' };

/**
 * The laid-out pages are the printed ones, read-only: a press on one goes back to writing at that paragraph.
 * @param {Object} app scroll, sheet, build() -> {width, height, pages}, zoom(), goTo(blockId)
 */
export function pageView(app) {
  const host = document.createElement('div');
  host.className = 'page-view hidden';
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'Pages');
  app.sheet.after(host);
  let mode = 'single';
  let building = Promise.resolve();
  let stale = false;

  async function build() {
    if (mode === 'single') return;
    usePrintStyles();
    const { width, height, pages } = await app.build();
    if (mode === 'single') return;
    const zoom = app.zoom();
    const frames = pages.map((page, index) => {
      const frame = document.createElement('div');
      frame.className = 'page-view-frame';
      frame.dataset.page = String(index + 1);
      frame.style.width = `calc(${width}mm * ${zoom})`;
      frame.style.height = `calc(${height}mm * ${zoom})`;
      page.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
      frame.append(page);
      return frame;
    });
    if (mode === 'book' && frames.length) {
      // The first page stands alone on the right, as a book's opening page does.
      const blank = document.createElement('div');
      blank.className = 'page-view-frame blank';
      blank.style.width = frames[0].style.width;
      blank.style.height = frames[0].style.height;
      frames.unshift(blank);
    }
    host.style.setProperty('--page-view-width', `calc(${width}mm * ${zoom})`);
    host.replaceChildren(...frames);
  }

  /** Builds again, one build at a time, the last asked for winning. */
  function rebuild() {
    if (mode === 'single') return building;
    if (stale) return building;
    stale = true;
    building = building.then(() => { stale = false; return build(); }).catch(() => {});
    return building;
  }

  /** The paragraph a press on a page meant: the one under it, or the last one starting above it. */
  function blockAt(event) {
    const frame = event.target.closest?.('.page-view-frame');
    if (!frame) return null;
    const direct = event.target.closest('[data-block], [data-block-container]');
    if (direct) return direct.dataset.block ?? direct.dataset.blockContainer;
    // A page holds copies of paragraphs from before it, cut off by its text area: only those that show count.
    const area = frame.querySelector('.print-body')?.getBoundingClientRect();
    let best = null;
    for (const b of frame.querySelectorAll('[data-block], [data-block-container]')) {
      if (b.parentElement?.closest('[data-block], [data-block-container]')) continue;
      const r = b.getBoundingClientRect();
      if (area && (r.bottom <= area.top || r.top >= area.bottom)) continue;
      if (!best || r.top <= event.clientY) best = b;
    }
    return best ? best.dataset.block ?? best.dataset.blockContainer : null;
  }

  host.addEventListener('click', (event) => {
    const id = blockAt(event);
    set('single');
    if (id) app.goTo(id);
  });

  function set(next) {
    if (!LAYOUTS[next]) return;
    mode = next;
    const paged = mode !== 'single';
    app.sheet.classList.toggle('hidden', paged);
    host.classList.toggle('hidden', !paged);
    host.classList.toggle('book', mode === 'book');
    if (paged) rebuild();
    else host.replaceChildren();
  }

  return { set, mode: () => mode, rebuild, element: host };
}
