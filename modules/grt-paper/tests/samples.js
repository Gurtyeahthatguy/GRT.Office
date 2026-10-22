/** A document that uses everything the formats have to carry. */

import { DocumentModel } from '../src/js/core/editor/model.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);

export function sample() {
  const model = new DocumentModel({
    page: {
      size: 'Letter',
      orientation: 'landscape',
      margins: { top: 30, right: 18, bottom: 22, left: 24 },
      running: {
        firstDifferent: true,
        evenDifferent: true,
        header: { default: { text: 'Report', align: 'left' }, first: null, even: { text: 'Even pages', align: 'right' } },
        footer: { default: { text: 'Page {page} of {pages}', align: 'center' }, first: { text: 'Cover', align: 'center' }, even: null },
      },
    },
    blocks: [
      { kind: 'heading', level: 1, runs: [{ text: 'Main title' }] },
      {
        kind: 'paragraph',
        align: 'justify',
        runs: [
          { text: 'Plain ' }, { text: 'bold', bold: true }, { text: ' and ' },
          { text: 'all', bold: true, italic: true, underline: true, strike: true },
          { text: ' x' }, { text: '2', sup: true }, { text: ' H' }, { text: '2', sub: true },
          { text: 'O, ' }, { text: 'red', color: '#cc0000' }, { text: ', ' },
          { text: 'marked', highlight: '#ffff00' }, { text: ', ' }, { text: 'big', size: 18 },
        ],
      },
      { kind: 'paragraph', runs: [{ text: '  two leading,  two inside,\ttab, trailing ' }, { text: ' across', bold: true }] },
      { kind: 'heading', level: 4, align: 'center', runs: [{ text: 'Fourth level' }] },
      {
        kind: 'list',
        listType: 'bullet',
        items: [
          { level: 0, runs: [{ text: 'First' }] },
          { level: 1, runs: [{ text: 'Nested' }] },
          { level: 3, runs: [{ text: 'Deep jump' }] },
          { level: 0, runs: [{ text: 'Back out', italic: true }] },
        ],
      },
      { kind: 'list', listType: 'number', items: [{ level: 0, runs: [{ text: 'One' }] }, { level: 0, runs: [{ text: 'Two' }] }] },
      { kind: 'quote', runs: [{ text: 'A quotation.' }] },
      { kind: 'code', runs: [{ text: 'line one\n  indented line\nline three' }] },
      { kind: 'image', resource: 'resources/dot.png', w: 300, h: 150, align: 'center', caption: [{ text: 'A dot' }] },
      { kind: 'image', resource: 'resources/plain.png', w: 96, h: 96, align: 'right', caption: [] },
      { kind: 'paragraph', breakBefore: true, runs: [{ text: 'After a page break.' }] },
    ],
  });
  const images = new Map([['resources/dot.png', PNG], ['resources/plain.png', PNG.slice(0, 9)]]);
  return { model, images };
}

/**
 * What a reader has to give back: the blocks as the program would load them,
 * without ids, and pictures by their bytes rather than their internal names.
 */
export function shape(document, images) {
  return new DocumentModel(document).toJSON().blocks.map((block) => {
    const out = { kind: block.kind, style: block.style, align: block.align ?? 'left' };
    if (block.breakBefore) out.breakBefore = true;
    if (block.kind === 'heading') out.level = block.level;
    if (block.kind === 'list') {
      out.listType = block.listType;
      out.items = block.items.map((item) => ({ level: item.level, runs: item.runs }));
    } else if (block.kind === 'image') {
      Object.assign(out, { bytes: [...images.get(block.resource)], w: block.w, h: block.h, caption: block.caption });
    } else {
      out.runs = block.runs;
    }
    return out;
  });
}

