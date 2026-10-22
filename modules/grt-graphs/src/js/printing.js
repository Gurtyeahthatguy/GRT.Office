/** The diagram on paper: shrunk to one page, or at full size across several. */

import { toSvg, bounds } from './export.js';
import { makePage, paperSize } from './core/print.js';

const MM = 96 / 25.4;

/** The diagram's drawing, showing one window of it in a box of so many millimetres. */
function drawing(svg, view, width, height) {
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  const element = holder.querySelector('svg');
  element.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  element.setAttribute('width', `${width}mm`);
  element.setAttribute('height', `${height}mm`);
  element.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  element.classList.add('print-drawing');
  return element;
}

/**
 * @param {import('./model.js').GraphModel} model
 * @param {{mode: 'fit'|'tiled', size: string, orientation: string, margin: number}} setup
 * @returns {{width: number, height: number, pages: HTMLElement[]}}
 */
export function printablePages(model, setup) {
  const paper = paperSize(setup);
  const margin = Math.max(0, setup.margin ?? 10);
  const innerW = paper.width - 2 * margin;
  const innerH = paper.height - 2 * margin;
  const box = bounds(model);
  const svg = toSvg(model);
  const place = (element) => {
    Object.assign(element.style, { position: 'absolute', left: `${margin}mm`, top: `${margin}mm` });
    return element;
  };

  if (setup.mode !== 'tiled') {
    const page = makePage(paper.width, paper.height);
    page.append(place(drawing(svg, box, innerW, innerH)));
    return { width: paper.width, height: paper.height, pages: [page] };
  }

  const tileW = innerW * MM;
  const tileH = innerH * MM;
  const columns = Math.max(1, Math.ceil(box.width / tileW - 1e-6));
  const rows = Math.max(1, Math.ceil(box.height / tileH - 1e-6));
  const pages = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const page = makePage(paper.width, paper.height);
      const view = { x: box.x + column * tileW, y: box.y + row * tileH, width: tileW, height: tileH };
      const element = drawing(svg, view, innerW, innerH);
      element.setAttribute('preserveAspectRatio', 'xMinYMin meet');
      page.append(place(element));
      const label = document.createElement('div');
      label.className = 'print-footer';
      label.textContent = `Row ${row + 1} of ${rows}, column ${column + 1} of ${columns}`;
      Object.assign(label.style, {
        position: 'absolute', left: '0', right: '0', bottom: `${margin / 3}mm`, textAlign: 'center',
        font: '8pt system-ui, sans-serif', color: '#666',
      });
      page.append(label);
      pages.push(page);
    }
  }
  return { width: paper.width, height: paper.height, pages };
}
