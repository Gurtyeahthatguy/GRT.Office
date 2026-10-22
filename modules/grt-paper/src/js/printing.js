/** The document as printed pages: laid out as on screen, cut between lines. */

import { Renderer, fontStack, PT, MM } from './core/editor/render.js';
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
    new Renderer(column).draw(model, images);
    await picturesReady(column);
    const windows = flowBreaks(column, box.contentHeight * MM, {
      keepWithNext: (element) => model.block(blockId(element))?.kind === 'heading',
      breakBefore: (element) => !!model.block(blockId(element))?.breakBefore,
      whole: (element) => element.matches('figure'),
    });

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
      page.append(text);
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
