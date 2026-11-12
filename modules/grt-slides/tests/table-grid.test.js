// @vitest-environment jsdom

/** Tables on slides: rows and columns put in and taken out, merged cells and sizes, through .odp, .pptx and LibreOffice. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { SlidesModel } from '../src/js/model.js';
import {
  normaliseTable, tableGrid, insertRows, deleteRows, insertCols, deleteCols, mergeCells, unmergeCells, distribute, fitToText,
} from '../src/js/tables.js';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const grid = (texts) => normaliseTable({ kind: 'table', x: 0, y: 0, w: 900, h: 300, rows: texts.length, cols: texts[0].length, cells: texts.map((r) => [...r]) });

function deck() {
  const model = new SlidesModel();
  const slide = model.slides[0];
  const table = model.addElement(slide.id, { kind: 'table', x: 100, y: 100, w: 1200, h: 400, rows: 3, cols: 3, header: true });
  model.changeTable(slide.id, table.id, (t) => {
    t.cells = [['Name', 'Q1', 'Q2'], ['North', '10', '12'], ['South', '8', '9']];
    t.colW = [0.5, 0.25, 0.25];
    t.rowH = [0.3, 0.35, 0.35];
    mergeCells(t, { top: 0, left: 1, bottom: 0, right: 2 });
  });
  return { model, slide, table: model.element(slide.id, table.id) };
}

const shape = (document) => {
  // Read as the program reads it: lengths become shares of the table.
  const t = normaliseTable(structuredClone(document.slides.flatMap((s) => s.elements).find((e) => e.kind === 'table')));
  return {
    cells: t.cells, merges: t.merges,
    colW: t.colW?.map((v) => Math.round(v * 100) / 100), rowH: t.rowH?.map((v) => Math.round(v * 100) / 100),
  };
};

describe('a table', () => {
  it('is held to its limits whatever a file says', () => {
    const t = normaliseTable({ rows: 1e9, cols: -4, cells: 'x', colW: [1, 2], merges: [{ top: 0, left: 0, bottom: 99, right: 0 }, { top: 0, left: 0, bottom: 1, right: 1 }] });
    expect([t.rows, t.cols]).toEqual([30, 2]);
    expect(t.cells.length).toBe(30);
    expect(t.colW).toEqual([1 / 3, 2 / 3]);
    expect(t.merges).toEqual([{ top: 0, left: 0, bottom: 1, right: 1 }]);
  });

  it('lays out merged cells as one box and the others where their sizes say', () => {
    const { table } = deck();
    const { cells } = tableGrid(table);
    expect(cells.length).toBe(8);
    expect(cells[1]).toMatchObject({ row: 0, col: 1, colSpan: 2, x: 600, w: 600, h: 120, text: 'Q1\nQ2' });
  });

  it('takes rows and columns in where they are asked, keeping the sizes of the others', () => {
    const t = grid([['a', 'b'], ['c', 'd']]);
    insertRows(t, 1, 2);
    expect(t.cells.map((r) => r.join())).toEqual(['a,b', ',', ',', 'c,d']);
    expect(t.h).toBe(600);
    deleteRows(t, 1, 2);
    expect(t.cells.map((r) => r.join())).toEqual(['a,b', 'c,d']);
    expect(t.h).toBe(300);
    insertCols(t, 0);
    expect(t.cells[0]).toEqual(['', 'a', 'b']);
    deleteCols(t, 0);
    expect(t.cells[0]).toEqual(['a', 'b']);
    expect(deleteRows(t, 0, 2)).toBe(true);
    expect(t.rows).toBe(1);
  });

  it('moves and grows merged blocks with the rows around them', () => {
    const t = grid([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
    mergeCells(t, { top: 1, left: 0, bottom: 2, right: 0 });
    expect(t.cells[1][0]).toBe('d\ng');
    insertRows(t, 2);
    expect(t.merges).toEqual([{ top: 1, left: 0, bottom: 3, right: 0 }]);
    insertRows(t, 0);
    expect(t.merges).toEqual([{ top: 2, left: 0, bottom: 4, right: 0 }]);
    deleteRows(t, 2, 2);
    // Cut down to one cell, the block is no longer a merge.
    expect(t.merges).toBeUndefined();
    unmergeCells(t, { top: 0, left: 0, bottom: t.rows - 1, right: 2 });
    expect(t.merges).toBeUndefined();
  });

  it('shares sizes evenly, and fits them to the text', () => {
    const t = grid([['a short one', 'b'], ['c', 'd']]);
    t.colW = [0.9, 0.1];
    distribute(t, 'col', 0, 1);
    expect(t.colW).toBeUndefined();
    fitToText(t, 'col', 'minimal', 0, 1, (text) => ({ width: text.length * 10, height: 20 }));
    // The text and the padding either side, or the narrowest a column goes.
    expect(t.w).toBe(130 + 40);
    expect(t.colW[0]).toBeCloseTo(130 / 170);
  });
});

describe('a table in a file', () => {
  it('keeps merged cells and sizes through .odp and .pptx', () => {
    const want = shape(deck().model.toJSON());
    expect(want.merges).toEqual([{ top: 0, left: 1, bottom: 0, right: 2 }]);
    expect(shape(readOdp(decodeBlock(encodeBlock(writeOdp(deck().model.toJSON()).entries))).document)).toEqual(want);
    expect(shape(readPptx(decodeBlock(encodeBlock(writePptx(deck().model.toJSON()).entries))).document)).toEqual(want);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and tables', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('reads them from .odp and .pptx and writes them back the same', () => {
    const want = shape(deck().model.toJSON());
    for (const [format, write, filter, read] of [
      ['odp', writeOdp, 'pptx:Impress MS PowerPoint 2007 XML', readPptx],
      ['pptx', writePptx, 'odp', readOdp],
    ]) {
      const file = join(dir, `table.${format}`);
      writeBlock(encodeBlock(write(deck().model.toJSON()).entries), file);
      const saved = convert(file, filter, join(dir, `from-${format}`));
      expect(shape(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
    }
  }, 120000);
});
