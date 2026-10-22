/** A note on paper: its title, then its blocks, cut between lines. */

import { makePage, paperSize, flowBreaks, flowPage, measuringColumn, picturesReady } from './core/print.js';

const MM = 96 / 25.4;

/**
 * @param {import('./note.js').NoteDocument} note
 * @param {import('./render-notes.js').NotesRenderer} renderer used for its way of drawing blocks
 * @param {{size: string, orientation: string, margin: number}} setup
 */
export async function printablePages(note, renderer, setup, images = new Map()) {
  const paper = paperSize(setup);
  const margin = Math.max(0, setup.margin ?? 20);
  const width = paper.width - 2 * margin;
  const height = paper.height - 2 * margin - 8;
  const column = measuringColumn(width, 'surface print-body notes-print');
  try {
    if (note.title) {
      const title = document.createElement('h1');
      title.className = 'block print-title';
      title.textContent = note.title;
      column.append(title);
    }
    for (const block of note.blocks) column.append(renderer.blockElement(block, note, images));
    // Nothing on paper can be typed into or clicked.
    for (const node of column.querySelectorAll('[contenteditable], button')) {
      if (node.tagName === 'BUTTON') node.remove();
      else node.removeAttribute('contenteditable');
    }
    await picturesReady(column);
    const windows = flowBreaks(column, height * MM, {
      keepWithNext: (element) => /^H[1-6]$/.test(element.tagName),
      whole: (element) => element.matches('figure, .embed'),
    });
    const pages = windows.map((window, index) => {
      const page = makePage(paper.width, paper.height);
      const body = flowPage(column, window);
      body.className = 'surface print-body notes-print';
      Object.assign(body.style, { position: 'absolute', top: `${margin}mm`, left: `${margin}mm`, width: `${width}mm` });
      const footer = document.createElement('div');
      footer.className = 'print-footer';
      footer.textContent = windows.length > 1 ? `${note.title || 'Note'} · ${index + 1} / ${windows.length}` : '';
      Object.assign(footer.style, {
        position: 'absolute', left: `${margin}mm`, width: `${width}mm`, bottom: `${margin / 2}mm`,
        textAlign: 'center', font: '8pt system-ui, sans-serif', color: '#666',
      });
      page.append(body, footer);
      return page;
    });
    return { width: paper.width, height: paper.height, pages };
  } finally {
    column.remove();
  }
}
