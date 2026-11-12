/** Comparing two PDFs page by page: the words each page gains and loses, and how much of its drawing differs. */

import * as pdfjs from '../vendor/pdf.mjs';
import { folderUrl } from './assets.js';
import { commonPairs } from './core/editor/compare.js';

const open = (bytes) => pdfjs.getDocument({
  data: bytes.slice(0), disableAutoFetch: true, disableStream: true, isEvalSupported: false,
  wasmUrl: folderUrl('../vendor/wasm/'), enableXfa: false,
  cMapUrl: folderUrl('../vendor/cmaps/'), cMapPacked: true, standardFontDataUrl: folderUrl('../vendor/standard_fonts/'),
});

const words = (text) => text.split(/\s+/).filter(Boolean);

/** The words of two pages as one list, each marked kept, added or removed. */
export function diffWords(before, after) {
  const a = words(before);
  const b = words(after);
  const pairs = commonPairs(a, b, undefined, 4_000_000);
  if (pairs.length === 0 && a.length && b.length && a.length * b.length > 4_000_000) {
    return [...a.map((word) => ({ word, kind: 'removed' })), ...b.map((word) => ({ word, kind: 'added' }))];
  }
  const out = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    while (i < pi) out.push({ word: a[i++], kind: 'removed' });
    while (j < pj) out.push({ word: b[j++], kind: 'added' });
    out.push({ word: b[pj], kind: 'same' });
    i = pi + 1;
    j = pj + 1;
  }
  while (i < a.length) out.push({ word: a[i++], kind: 'removed' });
  while (j < b.length) out.push({ word: b[j++], kind: 'added' });
  return out;
}

async function pageText(doc, number) {
  const page = await doc.getPage(number);
  const content = await page.getTextContent();
  return content.items.map((item) => item.str ?? '').join(' ');
}

/** The share of a page's pixels that differ, both drawn at the same small scale; 1 when the pages differ in size. */
async function drawnDifference(docA, numberA, docB, numberB) {
  const draw = async (doc, number) => {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 0.6 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  };
  const [a, b] = await Promise.all([draw(docA, numberA), draw(docB, numberB)]);
  if (Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1) return 1;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const da = a.getContext('2d').getImageData(0, 0, width, height).data;
  const db = b.getContext('2d').getImageData(0, 0, width, height).data;
  let differ = 0;
  for (let k = 0; k < da.length; k += 4) {
    if (Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]) > 96) differ += 1;
  }
  return differ / (width * height);
}

/**
 * Every page of two PDFs side by side, in order.
 * @returns {Promise<{pages: {number: number, only?: 'first'|'second', words?: Object[], added: number, removed: number, drawn: number}[]}>}
 */
export async function comparePdfs(bytesA, bytesB, { limit = 2000 } = {}) {
  // The loading tasks are what is destroyed at the end; each one frees its document.
  const tasks = [open(bytesA), open(bytesB)];
  try {
    const [docA, docB] = await Promise.all(tasks.map((task) => task.promise));
    const count = Math.min(Math.max(docA.numPages, docB.numPages), limit);
    const pages = [];
    for (let n = 1; n <= count; n += 1) {
      if (n > docA.numPages) {
        pages.push({ number: n, only: 'second', added: words(await pageText(docB, n)).length, removed: 0, drawn: 1 });
        continue;
      }
      if (n > docB.numPages) {
        pages.push({ number: n, only: 'first', added: 0, removed: words(await pageText(docA, n)).length, drawn: 1 });
        continue;
      }
      const list = diffWords(await pageText(docA, n), await pageText(docB, n));
      pages.push({
        number: n, words: list,
        added: list.filter((w) => w.kind === 'added').length,
        removed: list.filter((w) => w.kind === 'removed').length,
        drawn: await drawnDifference(docA, n, docB, n),
      });
    }
    return { pages, truncated: Math.max(docA.numPages, docB.numPages) > limit };
  } finally {
    await Promise.all(tasks.map((task) => task.destroy()));
  }
}
