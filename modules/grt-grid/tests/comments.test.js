// @vitest-environment jsdom

/** Comments on cells: kept in .grt, .ods and .xlsx, read back by LibreOffice, and edited as one step. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

function noted() {
  const model = new GridModel();
  const sheet = new SheetController(model);
  sheet.setCell(0, 0, '12');
  sheet.setNote('Checked\nby hand <ok> & "fine"');
  sheet.select(2, 1);
  sheet.setNote('An empty cell with a note');
  sheet.setNoteShown(true);
  return { model, sheet };
}

describe('comments', () => {
  it('are set, shown, deleted and undone as steps', () => {
    const { model, sheet } = noted();
    expect(sheet.noteAt(0, 0)).toBe('Checked\nby hand <ok> & "fine"');
    expect(model.sheet.cell(2, 1).ns).toBe(1);
    sheet.select(0, 0);
    sheet.select(2, 1, { extend: true });
    sheet.deleteNotes();
    expect(sheet.noteAt(0, 0)).toBe(null);
    expect(model.sheet.cell(2, 1)).toBe(null);
    sheet.step(-1);
    expect(sheet.noteAt(2, 1)).toBe('An empty cell with a note');
  });

  it('stay when the cell is emptied with Delete, and its look stays too', () => {
    const { model, sheet } = noted();
    sheet.select(0, 0);
    sheet.toggleLook('bold');
    sheet.clearSelection();
    expect(model.sheet.valueAt(0, 0)).toBe(null);
    expect(sheet.noteAt(0, 0)).toMatch(/Checked/);
    expect(model.sheet.cell(0, 0).s).toBeTruthy();
  });

  it('go through .ods', () => {
    const { model } = noted();
    const back = readOds(through(writeOds(model.toJSON()).entries)).document;
    expect(back.sheets[0].cells['0,0']).toMatchObject({ v: 12, n: 'Checked\nby hand <ok> & "fine"' });
    expect(back.sheets[0].cells['2,1']).toEqual({ n: 'An empty cell with a note', ns: 1 });
  });

  it('go through .xlsx', () => {
    const { model } = noted();
    const written = writeXlsx(model.toJSON()).entries;
    expect(written.map((e) => e.name)).toEqual(expect.arrayContaining(['xl/comments1.xml', 'xl/drawings/vmlDrawing1.vml']));
    const back = readXlsx(through(written)).document;
    expect(back.sheets[0].cells['0,0']).toMatchObject({ v: 12, n: 'Checked\nby hand <ok> & "fine"' });
    expect(back.sheets[0].cells['2,1'].n).toBe('An empty cell with a note');
  });

  it('leave out who wrote them, and say so', () => {
    const flat = `<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell><office:annotation><dc:creator>Someone Real</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><text:p>Hello</text:p></office:annotation></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document>`;
    const { document, losses } = readOds(flat);
    expect(document.sheets[0].cells['0,0']).toEqual({ n: 'Hello' });
    expect(losses.lines().join()).toMatch(/Names and dates on comments/);
    expect(JSON.stringify(writeOds(document).entries.map((e) => e.data))).not.toMatch(/Someone/);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Grid’s comments', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('reads them from .ods and .xlsx, and they come back the same', () => {
    const { model } = noted();
    for (const [format, write, filter] of [['ods', writeOds, 'xlsx:Calc MS Excel 2007 XML'], ['xlsx', writeXlsx, 'ods']]) {
      const file = join(dir, `notes.${format}`);
      writeBlock(encodeBlock(write(model.toJSON()).entries), file);
      const saved = convert(file, filter, join(dir, `from-${format}`));
      const back = (format === 'ods' ? readXlsx : readOds)(decodeBlock(readBlock(saved))).document;
      expect(back.sheets[0].cells['0,0'].n, format).toBe('Checked\nby hand <ok> & "fine"');
      expect(back.sheets[0].cells['2,1'].n, format).toBe('An empty cell with a note');
    }
  }, 120000);
});
