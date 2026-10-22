// @vitest-environment jsdom

/** OpenDocument spreadsheets: what Grid writes comes back as it was. */

import { describe, it, expect } from 'vitest';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { workbook, cellsOf } from './sheets.js';
import { GridModel } from '../src/js/model.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

const flat = (cells, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:body><office:spreadsheet>${extra}<table:table table:name="S"><table:table-row>${cells}</table:table-row></table:table>
</office:spreadsheet></office:body></office:document>`;

describe('what other programs write', () => {
  it('reads a date as the day it names, whatever day the document counts from', () => {
    const doc = readOds(flat('<table:table-cell office:value-type="date" office:date-value="2008-03-15"/>',
      '<table:calculation-settings><table:null-date table:date-value="1904-01-01"/></table:calculation-settings>')).document;
    expect(doc.sheets[0].cells['0,0'].v).toBe(39522);
  });

  it('reads an error saved in another language by its standard name', () => {
    const doc = readOds(flat('<table:table-cell table:formula="of:=1/0" office:value-type="float" office:value="0" calcext:value-type="error"><text:p>#WERT!</text:p></table:table-cell>'
      + '<table:table-cell table:formula="of:=X()" office:value-type="float" office:value="0" calcext:value-type="error"><text:p>Err:532</text:p></table:table-cell>')).document;
    expect(doc.sheets[0].cells['0,0'].v).toBe('#VALUE!');
    expect(doc.sheets[0].cells['0,1'].v).toBe('#DIV/0!');
  });

  it('CANARY: a string that only looks like an error stays a string', () => {
    const doc = readOds(flat('<table:table-cell office:value-type="string"><text:p>#WERT!</text:p></table:table-cell>')).document;
    expect(doc.sheets[0].cells['0,0'].v).toBe('#WERT!');
  });
});

describe('a workbook written as .ods', () => {
  it('comes back with every value and formula', () => {
    const { model } = workbook();
    const back = readOds(through(writeOds(model.toJSON()).entries));
    expect(cellsOf(back.document)).toEqual(cellsOf(model.toJSON()));
    expect(back.losses.lines()).toEqual([]);
  });

  it('comes back with the look of its cells', () => {
    const { model } = workbook();
    const back = readOds(through(writeOds(model.toJSON()).entries)).document;
    const styleOf = (key) => back.styles[back.sheets[0].cells[key].s];
    expect(styleOf('0,0')).toEqual({ bold: true, bg: '#ffee88', align: 'center' });
    expect(styleOf('1,1')).toEqual({ color: '#cc0000', format: '#,##0.00 €' });
    expect(styleOf('2,3')).toEqual({ format: 'dd/mm/yyyy' });
    expect(styleOf('2,4')).toEqual({ format: 'hh:mm:ss' });
    expect(styleOf('2,5')).toEqual({ format: '0.0%' });
  });

  it('keeps column widths, row heights and frozen rows', () => {
    const { model } = workbook();
    const back = readOds(through(writeOds(model.toJSON()).entries)).document;
    expect(back.sheets[0].cols).toEqual({ 0: { w: 180 } });
    expect(back.sheets[0].rows).toEqual({ 0: { h: 32 } });
    expect(back.sheets[0].frozen).toEqual({ rows: 1, cols: 0 });
    // The program sees them as it saw them before saving.
    const reopened = new GridModel(back).sheet;
    expect(reopened.columnWidth(0)).toBe(180);
    expect(reopened.rowHeight(0)).toBe(32);
  });

  it('as a flat .fods too', () => {
    const { model } = workbook();
    const back = readOds(writeOds(model.toJSON(), { flat: true }).text);
    expect(cellsOf(back.document)).toEqual(cellsOf(model.toJSON()));
    expect(back.document.sheets[0].frozen).toEqual({ rows: 1, cols: 0 });
  });

  it('is the same, byte for byte, written twice, and carries no metadata', () => {
    const { model } = workbook();
    const first = encodeBlock(writeOds(model.toJSON()).entries);
    expect(first).toEqual(encodeBlock(writeOds(model.toJSON()).entries));
    const names = writeOds(model.toJSON()).entries.map((e) => e.name);
    expect(names).toEqual(['mimetype', 'content.xml', 'settings.xml', 'META-INF/manifest.xml']);
  });

  it('CANARY: a changed value does not compare equal', () => {
    const { model } = workbook();
    const back = readOds(through(writeOds(model.toJSON()).entries));
    back.document.sheets[0].cells['1,1'].v = 1;
    expect(cellsOf(back.document)).not.toEqual(cellsOf(model.toJSON()));
  });
});
