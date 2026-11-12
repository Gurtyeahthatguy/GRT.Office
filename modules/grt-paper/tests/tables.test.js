// @vitest-environment jsdom

/** Tables in Paper: editing them, and carrying them through .odt and .docx and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel, makeBlock, itemIndices } from '../src/js/core/editor/model.js';
import { point, collapsed, startOfNext, endOfPrevious } from '../src/js/core/editor/selection.js';
import { insertText, splitBlock, deleteBackward, deleteRange } from '../src/js/core/editor/commands.js';
import {
  insertRow, deleteRows, insertColumn, deleteColumns, mergeCells, splitCell, setHeaderRows,
} from '../src/js/core/editor/tables.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const text = (cell) => cell.runs.map((r) => r.text).join('');
const grid = (block) => block.rows.map((row) => row.cells.map((cell) => (cell.covered ? '#' : text(cell))));

function document() {
  const model = new DocumentModel({ blocks: [{ kind: 'paragraph', runs: [{ text: 'Before' }] }] });
  const table = makeBlock('table', { rows: 3, cols: 3, header: true });
  model.insertBlock(table, 1);
  model.insertBlock({ kind: 'paragraph', runs: [{ text: 'After' }] }, 2);
  const cell = (r, c) => point(table.id, 0, r * 3 + c);
  ['Name', 'City', 'Score', 'Ada', 'Turin', '9', 'Bob', 'Milan', '7'].forEach((value, i) => {
    insertText(model, collapsed(cell(Math.floor(i / 3), i % 3)), value);
  });
  return { model, table: model.block(table.id), cell };
}

describe('a table being edited', () => {
  it('takes text in each cell, and Enter makes a new line in the cell', () => {
    const { model, table, cell } = document();
    expect(grid(table)).toEqual([['Name', 'City', 'Score'], ['Ada', 'Turin', '9'], ['Bob', 'Milan', '7']]);
    splitBlock(model, collapsed({ ...cell(1, 1), offset: 5 }));
    expect(text(table.rows[1].cells[1])).toBe('Turin\n');
  });

  it('moves from cell to cell and out of the table', () => {
    const { model, table, cell } = document();
    expect(startOfNext(cell(0, 2), model)).toEqual(point(table.id, 0, 3));
    expect(startOfNext(cell(2, 2), model).blockId).toBe(model.blocks[2].id);
    expect(endOfPrevious(cell(0, 0), model).blockId).toBe(model.blocks[0].id);
  });

  it('never merges cells by deleting, and keeps its shape when a range across cells is cut', () => {
    const { model, table, cell } = document();
    deleteBackward(model, collapsed(cell(1, 0)));
    expect(grid(table)[1]).toEqual(['Ada', 'Turin', '9']);
    deleteRange(model, { anchor: { ...cell(1, 0), offset: 1 }, focus: { ...cell(1, 2), offset: 0 } });
    expect(grid(table)[1]).toEqual(['A', '', '9']);
  });

  it('grows and shrinks by rows and columns', () => {
    const { model, cell } = document();
    insertRow(model, collapsed(cell(1, 0)), true);
    insertColumn(model, collapsed(cell(0, 0)), false);
    const table = model.blocks[1];
    expect(grid(table).map((r) => r.length)).toEqual([4, 4, 4, 4]);
    expect(grid(table)[2]).toEqual(['', '', '', '']);
    deleteRows(model, collapsed(point(table.id, 0, 2 * 4)));
    deleteColumns(model, collapsed(point(table.id, 0, 0)));
    expect(grid(model.blocks[1])).toEqual([['Name', 'City', 'Score'], ['Ada', 'Turin', '9'], ['Bob', 'Milan', '7']]);
  });

  it('merges a block of cells into one and splits it again', () => {
    const { model, table, cell } = document();
    mergeCells(model, { anchor: cell(1, 0), focus: cell(2, 1) });
    const merged = model.blocks[1];
    expect(grid(merged)).toEqual([['Name', 'City', 'Score'], ['Ada\nTurin\nBob\nMilan', '#', '9'], ['#', '#', '7']]);
    expect(itemIndices(merged)).toEqual([0, 1, 2, 3, 5, 8]);
    splitCell(model, collapsed(point(merged.id, 0, 3)));
    expect(grid(model.blocks[1])[2]).toEqual(['', '', '7']);
    expect(table.id).toBe(merged.id);
  });
});

function richTable() {
  const { model, cell } = document();
  mergeCells(model, { anchor: cell(2, 0), focus: cell(2, 1) });
  const table = model.blocks[1];
  table.rows[1].cells[2].bg = '#ffeb9c';
  table.widths = [2, 1, 1];
  return model;
}

const shape = (doc) => {
  const table = doc.blocks.find((b) => b.kind === 'table');
  return { grid: grid(table), header: table.rows.map((r) => !!r.header), bg: table.rows[1].cells[2].bg, widths: table.widths.map((w) => Math.round((w / table.widths.reduce((a, b) => a + b, 0)) * 100)) };
};

describe('a table whose rows differ in length', () => {
  it('is as wide as its longest row, so no cell is lost', () => {
    const model = new DocumentModel({ blocks: [{ kind: 'table', rows: [
      { cells: [{ runs: [{ text: '' }] }, { runs: [{ text: '' }] }, { runs: [{ text: 'A3' }] }] },
      { cells: [{ runs: [{ text: 'B1' }] }, { runs: [{ text: 'B2' }] }] },
    ] }] });
    expect(grid(model.blocks[0])).toEqual([['', '', 'A3'], ['B1', 'B2', '']]);
  });
});

describe('tables through the formats', () => {
  const want = shape(richTable().toJSON());
  it('come back from .odt as they went', () => {
    expect(shape(readOdt(decodeBlock(encodeBlock(writeOdt(richTable().toJSON()).entries))).document)).toEqual(want);
  });
  it('come back from .docx as they went', () => {
    expect(shape(readDocx(decodeBlock(encodeBlock(writeDocx(richTable().toJSON()).entries))).document)).toEqual(want);
  });
  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `table.${format}`);
        writeBlock(encodeBlock(write(richTable().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(shape(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});

describe('a table pasted from a web page', async () => {
  const { blocksFromHtml } = await import('../src/js/core/editor/paste.js');
  it('arrives as a table, merged cells and heading row included', () => {
    const { blocks } = blocksFromHtml('<table><tr><th>Name</th><th>City</th></tr><tr><td rowspan="2"><b>Ada</b></td><td>Turin</td></tr><tr><td>Rome</td></tr></table>', document);
    const table = blocks.find((b) => b.kind === 'table');
    expect(grid(table)).toEqual([['Name', 'City'], ['Ada', 'Turin'], ['#', 'Rome']]);
    expect(table.rows[0].header).toBe(true);
    expect(table.rows[1].cells[0].runs[0].bold).toBe(true);
  });
});
