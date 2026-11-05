/** The document as printed pages: laid out as on screen, cut between lines. */

import { Renderer, fontStack, PT, MM, noteLine } from './core/editor/render.js';
import { documentFields } from './core/editor/fields.js';
import { fillPageNumbers } from './long.js';
import { slotFor } from './core/editor/model.js';
import { makePage, flowBreaks, flowPage, measuringColumn, picturesReady } from './core/print.js';

const blockId = (element) => element.dataset.block ?? element.dataset.blockContainer;

/**
 * @param {PaperModel} model
 * @param {Map<string, string>} images resource path to a URL the page can show
 * @returns {Promise<{width: number, height: number, pages: HTMLElement[]}>}
 */
export async function printablePages(model, images = new Map()) {
  const box = model.pageBox();
  const margins = model.page.margins;
  const column = measuringColumn(box.contentWidth, 'surface print-body');
  try {
    new Renderer(column).draw(model, images, { footnotesAtEnd: false });
    await picturesReady(column);
    // Each footnote sits at the foot of the page its number is on, so its height is known before the pages are cut.
    const origin = column.getBoundingClientRect().top;
    const fields = documentFields(model);
    const footnoteBox = document.createElement('div');
    footnoteBox.className = 'surface print-body print-footnotes';
    column.after(footnoteBox);
    Object.assign(footnoteBox.style, { position: 'fixed', left: '-100000px', top: '0', width: `${box.contentWidth}mm`, fontSize: '0.85em' });
    const refs = [...column.querySelectorAll('[data-note="foot"]')].map((holder, i) => {
      const line = noteLine(fields.footnotes[i] ?? { object: { kind: 'foot', runs: [] }, label: holder.dataset.noteLabel });
      footnoteBox.append(line);
      return { top: holder.getBoundingClientRect().top - origin, line, height: line.getBoundingClientRect().height };
    });
    const SEPARATOR = 10;
    const footnotesIn = (start, end) => refs.filter((ref) => ref.top >= start - 0.5 && ref.top < end - 0.5);
    const windows = flowBreaks(column, box.contentHeight * MM, {
      keepWithNext: (element) => model.block(blockId(element))?.kind === 'heading',
      breakBefore: (element) => !!model.block(blockId(element))?.breakBefore,
      whole: (element) => element.matches('figure, .section-columns'),
      reserve: (start, end) => {
        const own = footnotesIn(start, end);
        return own.length ? own.reduce((sum, ref) => sum + ref.height, SEPARATOR) : 0;
      },
    });
    footnoteBox.remove();

    // Page numbers of the contents, the index and references, from where their targets landed.
    const pageAt = (top) => {
      const index = windows.findIndex((w) => top >= w.start - 0.5 && top < w.end - 0.5);
      return index === -1 ? windows.length : index + 1;
    };
    fillPageNumbers(column, (id) => {
      const target = column.querySelector(`[data-block="${CSS.escape(id)}"], [data-block-container="${CSS.escape(id)}"]`);
      return target ? pageAt(target.getBoundingClientRect().top - origin) : null;
    }, windows.length);

    const body = model.styles.body ?? {};
    const running = {
      fontFamily: fontStack(body.font, model),
      fontSize: `${(body.size ?? 11) * 0.85 * PT}px`,
      color: '#333',
    };
    const pages = windows.map((window, index) => {
      const page = makePage(box.width, box.height);
      const text = flowPage(column, window);
      text.className = 'surface print-body';
      Object.assign(text.style, {
        position: 'absolute', top: `${margins.top}mm`, left: `${margins.left}mm`, width: `${box.contentWidth}mm`,
      });
      for (const field of text.querySelectorAll('.field-page')) field.textContent = String(index + 1);
      page.append(text);
      const own = footnotesIn(window.start, window.end);
      if (own.length) {
        const feet = document.createElement('div');
        feet.className = 'surface print-body print-footnotes';
        Object.assign(feet.style, {
          position: 'absolute', bottom: `${margins.bottom}mm`, left: `${margins.left}mm`, width: `${box.contentWidth}mm`,
          fontSize: '0.85em', borderTop: '0.5pt solid #333', paddingTop: '3px',
        });
        feet.append(...own.map((ref) => ref.line.cloneNode(true)));
        page.append(feet);
      }
      for (const part of ['header', 'footer']) {
        const slot = slotFor(model.page.running, part, index + 1, windows.length);
        if (!slot) continue;
        const line = document.createElement('div');
        line.className = `print-${part}`;
        line.textContent = slot.text;
        Object.assign(line.style, running, {
          position: 'absolute', left: `${margins.left}mm`, width: `${box.contentWidth}mm`,
          textAlign: slot.align, whiteSpace: 'pre', overflow: 'hidden',
          [part === 'header' ? 'top' : 'bottom']: `${(part === 'header' ? margins.top : margins.bottom) * 0.4}mm`,
        });
        page.append(line);
      }
      return page;
    });
    return { width: box.width, height: box.height, pages };
  } finally {
    column.remove();
  }
}
