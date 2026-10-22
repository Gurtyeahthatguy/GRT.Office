/** The deck on paper: slides, handouts and notes pages. */

import { elementMarkup } from './export.js';
import { makePage, paperSize } from './core/print.js';

const MM = 96 / 25.4;
const MARGIN = 12;

export const LAYOUTS = {
  slides: { label: 'Slides, one per page', perPage: 1 },
  'handouts-2': { label: 'Handouts, 2 slides per page', perPage: 2 },
  'handouts-3': { label: 'Handouts, 3 slides with lines for notes', perPage: 3 },
  'handouts-4': { label: 'Handouts, 4 slides per page', perPage: 4 },
  'handouts-6': { label: 'Handouts, 6 slides per page', perPage: 6 },
  notes: { label: 'Notes pages', perPage: 1 },
};

/** One slide drawn at its own size, then shrunk to fit a box of so many millimetres. */
export function slideThumbnail(model, slide, images, width, height, { frame = false } = {}) {
  const { w, h } = model.canvas;
  const scale = Math.min((width * MM) / w, (height * MM) / h);
  const holder = document.createElement('div');
  holder.className = 'print-slide-box';
  Object.assign(holder.style, {
    position: 'relative', width: `${w * scale}px`, height: `${h * scale}px`, overflow: 'hidden',
    outline: frame ? '0.5pt solid #666' : 'none',
  });
  const surface = document.createElement('div');
  surface.className = 'print-slide';
  Object.assign(surface.style, {
    position: 'absolute', left: '0', top: '0', width: `${w}px`, height: `${h}px`,
    transform: `scale(${scale})`, transformOrigin: '0 0', background: model.slideBackground(slide.id), overflow: 'hidden',
  });
  surface.innerHTML = model.renderList(slide.id).map((element) => elementMarkup(element, model, images)).join('');
  holder.append(surface);
  return holder;
}

function place(element, x, y) {
  Object.assign(element.style, { position: 'absolute', left: `${x}mm`, top: `${y}mm` });
  return element;
}

function pageNumber(page, number, total) {
  const label = document.createElement('div');
  label.className = 'print-footer';
  label.textContent = `${number} / ${total}`;
  Object.assign(label.style, {
    position: 'absolute', left: '0', right: '0', bottom: `${MARGIN / 2}mm`, textAlign: 'center',
    font: '9pt system-ui, sans-serif', color: '#555',
  });
  page.append(label);
}

/** Centres a slide in a box, returning where it lands. */
function centred(model, boxW, boxH) {
  const ratio = model.canvas.w / model.canvas.h;
  const w = Math.min(boxW, boxH * ratio);
  const h = w / ratio;
  return { w, h, dx: (boxW - w) / 2, dy: (boxH - h) / 2 };
}

/**
 * @param {import('./model.js').SlidesModel} model
 * @param {Map<string, string>} images
 * @param {{layout: string, size: string, orientation: string, frame: boolean}} setup
 * @returns {{width: number, height: number, pages: HTMLElement[]}}
 */
export function printablePages(model, images, setup) {
  const paper = paperSize(setup);
  const layout = LAYOUTS[setup.layout] ? setup.layout : 'slides';
  const { perPage } = LAYOUTS[layout];
  const slides = model.slides;
  const pages = [];
  const innerW = paper.width - 2 * MARGIN;
  const innerH = paper.height - 2 * MARGIN;

  for (let at = 0; at < slides.length; at += perPage) {
    const page = makePage(paper.width, paper.height);
    const group = slides.slice(at, at + perPage);

    if (layout === 'slides') {
      const fit = centred(model, innerW, innerH);
      page.append(place(slideThumbnail(model, group[0], images, fit.w, fit.h, setup), MARGIN + fit.dx, MARGIN + fit.dy));
    } else if (layout === 'notes') {
      const top = centred(model, innerW, innerH * 0.45);
      page.append(place(slideThumbnail(model, group[0], images, top.w, top.h, { frame: true }), MARGIN + top.dx, MARGIN));
      const notes = document.createElement('div');
      notes.className = 'print-notes';
      notes.textContent = group[0].notes ?? '';
      Object.assign(notes.style, {
        position: 'absolute', left: `${MARGIN}mm`, top: `${MARGIN + top.h + 8}mm`, width: `${innerW}mm`,
        height: `${innerH - top.h - 16}mm`, overflow: 'hidden', whiteSpace: 'pre-wrap',
        font: '12pt/1.4 system-ui, sans-serif', color: '#111',
      });
      page.append(notes);
    } else {
      const columns = layout === 'handouts-2' || layout === 'handouts-3' ? 1 : 2;
      const rows = Math.ceil(perPage / columns);
      const lined = layout === 'handouts-3';
      const cellW = lined ? innerW * 0.55 : innerW / columns;
      const cellH = (innerH - 8) / rows;
      const gap = 6;
      group.forEach((slide, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        const fit = centred(model, cellW - gap, cellH - gap);
        const x = MARGIN + col * cellW + (lined ? 0 : fit.dx);
        const y = MARGIN + row * cellH + fit.dy;
        page.append(place(slideThumbnail(model, slide, images, fit.w, fit.h, { frame: true }), x, y));
        if (lined) {
          // Ruled lines beside each slide, for the audience's own notes.
          for (let line = 1; line <= 6; line += 1) {
            const rule = document.createElement('div');
            rule.className = 'print-rule';
            Object.assign(rule.style, {
              position: 'absolute', left: `${MARGIN + cellW + gap}mm`, width: `${innerW - cellW - gap}mm`,
              top: `${y + (fit.h * line) / 7}mm`, height: '0', borderTop: '0.5pt solid #999',
            });
            page.append(rule);
          }
        }
      });
    }
    if (layout !== 'slides') pageNumber(page, pages.length + 1, Math.ceil(slides.length / perPage));
    pages.push(page);
  }
  return { width: paper.width, height: paper.height, pages };
}
