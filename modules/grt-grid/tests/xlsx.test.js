// @vitest-environment jsdom

/** Excel workbooks: what Grid writes comes back as it was. */

import { describe, it, expect } from 'vitest';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { workbook, cellsOf } from './sheets.js';
import { GridModel } from '../src/js/model.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

describe('a workbook written as .xlsx', () => {
  it('comes back with every value and formula', () => {
    const { model } = workbook();
    const back = readXlsx(through(writeXlsx(model.toJSON()).entries));
    expect(cellsOf(back.document)).toEqual(cellsOf(model.toJSON()));
    expect(back.losses.lines()).toEqual([]);
  });

  it('comes back with the look of its cells', () => {
    const { model } = workbook();
    const back = readXlsx(through(writeXlsx(model.toJSON()).entries)).document;
    const styleOf = (key) => back.styles[back.sheets[0].cells[key].s];
    expect(styleOf('0,0')).toEqual({ bold: true, bg: '#ffee88', align: 'center' });
    expect(styleOf('1,1')).toEqual({ color: '#cc0000', format: '#,##0.00 "€"' });
    expect(styleOf('2,3')).toEqual({ format: 'dd/mm/yyyy' });
    expect(styleOf('2,4')).toEqual({ format: 'hh:mm:ss' });
    expect(styleOf('2,5')).toEqual({ format: '0.0%' });
  });

  it('keeps column widths, row heights and frozen rows', () => {
    const { model } = workbook();
    const back = readXlsx(through(writeXlsx(model.toJSON()).entries)).document;
    expect(back.sheets[0].cols).toEqual({ 0: { w: 180 } });
    expect(back.sheets[0].rows).toEqual({ 0: { h: 32 } });
    expect(back.sheets[0].frozen).toEqual({ rows: 1, cols: 0 });
    // The program sees them as it saw them before saving.
    const reopened = new GridModel(back).sheet;
    expect(reopened.columnWidth(0)).toBe(180);
    expect(reopened.rowHeight(0)).toBe(32);
  });

  it('is the same, byte for byte, written twice, and carries no document properties', () => {
    const { model } = workbook();
    expect(encodeBlock(writeXlsx(model.toJSON()).entries)).toEqual(encodeBlock(writeXlsx(model.toJSON()).entries));
    const names = writeXlsx(model.toJSON()).entries.map((e) => e.name);
    expect(names.some((name) => name.startsWith('docProps/'))).toBe(false);
  });

  it('CANARY: a changed formula does not compare equal', () => {
    const { model } = workbook();
    const back = readXlsx(through(writeXlsx(model.toJSON()).entries));
    back.document.sheets[0].cells['3,1'].f = '=SUM(B2:B4)';
    expect(cellsOf(back.document)).not.toEqual(cellsOf(model.toJSON()));
  });
});
