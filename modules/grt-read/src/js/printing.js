/** A PDF on paper: its pages drawn as they would be saved, each fitted to the sheet. */

import * as pdfjs from '../vendor/pdf.mjs';
import { makePage } from './core/print.js';
import { PAGE_SIZES, pageDimensions } from './core/editor/model.js';

const PT_TO_MM = 25.4 / 72;
const DPI = 200;

/** Pages as a person writes them: `1-3, 7`, from 1; null when the text is not that. */
export function parseRange(text, count) {
  const cleaned = String(text ?? '').replace(/\s+/g, '');
  if (cleaned === '') return [...Array(count).keys()];
  const out = [];
  for (const part of cleaned.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to < from || to > count) return null;
    for (let n = from; n <= to; n += 1) out.push(n - 1);
  }
  return out;
}

/**
 * Draws pages once and keeps them while the preview is open.
 * @param {Uint8Array} bytes the document as it would be saved
 */
export async function pageRenderer(bytes) {
  const doc = await pdfjs.getDocument({
    data: bytes.slice(0), disableAutoFetch: true, disableStream: true, isEvalSupported: false,
  }).promise;
  const drawn = new Map();
  return {
    count: doc.numPages,
    /** A page's size in millimetres, as it would be printed. */
    async size(index) {
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      return { width: viewport.width * PT_TO_MM, height: viewport.height * PT_TO_MM };
    },
    async image(index) {
      if (drawn.has(index)) return drawn.get(index);
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: DPI / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
      const url = URL.createObjectURL(blob);
      drawn.set(index, url);
      return url;
    },
    close() {
      for (const url of drawn.values()) URL.revokeObjectURL(url);
      drawn.clear();
      doc.destroy();
    },
  };
}

/** The paper: the first printed page's own size, or one named, turned as asked. */
async function paperFor(setup, renderer, first) {
  if (setup.size === 'document') return renderer.size(first);
  const size = pageDimensions({ size: PAGE_SIZES[setup.size] ? setup.size : 'A4' });
  return setup.orientation === 'landscape' ? { width: size.h, height: size.w } : { width: size.w, height: size.h };
}

/**
 * @param {Awaited<ReturnType<typeof pageRenderer>>} renderer
 * @param {{size: string, orientation: string, pages: string, current: number}} setup
 */
export async function printablePages(renderer, setup) {
  const chosen = parseRange(setup.pages, renderer.count) ?? [setup.current ?? 0];
  const paper = await paperFor(setup, renderer, chosen[0] ?? 0);
  const pages = [];
  for (const index of chosen) {
    const page = makePage(paper.width, paper.height);
    const own = await renderer.size(index);
    // Fitted whole, centred, never enlarged past the sheet.
    const scale = Math.min(paper.width / own.width, paper.height / own.height);
    const image = document.createElement('img');
    image.src = await renderer.image(index);
    image.alt = '';
    Object.assign(image.style, {
      position: 'absolute', width: `${own.width * scale}mm`, height: `${own.height * scale}mm`,
      left: `${(paper.width - own.width * scale) / 2}mm`, top: `${(paper.height - own.height * scale) / 2}mm`,
    });
    page.append(image);
    pages.push(page);
  }
  return { width: paper.width, height: paper.height, pages };
}
