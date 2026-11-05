// @vitest-environment jsdom

/** Pivot tables: what they add up, how they lay it out, and GETPIVOTDATA. */

import { describe, it, expect } from 'vitest';
import { computePivot, groupItem, pivotData } from '../src/js/pivot.js';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const SOURCE = {
  fields: ['Region', 'Product', 'Date', 'Sales', 'Qty'],
  records: [
    ['North', 'Pen', 45000, 10, 2], ['North', 'Ink', 45031, 20, 4], ['South', 'Pen', 45100, 5, 1],
    ['South', 'Pen', 45400, 7, 1], ['North', 'Pen', 45410, 3, 1],
  ],
};
const shown = (result) => result.cells.map((line) => line.map((v) => (v === null ? '' : v)));

describe('a pivot table', () => {
  it('sums a field by the items of another, with a total', () => {
    expect(shown(computePivot({ rows: ['Region'], values: [{ field: 'Sales', fn: 'sum' }] }, SOURCE))).toEqual([
      ['Region', 'Sum - Sales'], ['North', 33], ['South', 12], ['Total Result', 45],
    ]);
  });

  it('nests row fields with a subtotal after each group, and several data fields side by side', () => {
    expect(shown(computePivot({ rows: ['Region', 'Product'], values: [{ field: 'Sales' }, { field: 'Qty', fn: 'count' }] }, SOURCE))).toEqual([
      ['Region', 'Product', 'Sum - Sales', 'Count - Qty'],
      ['North', 'Ink', 20, 1], ['', 'Pen', 13, 2], ['North Result', '', 33, 3],
      ['South', 'Pen', 12, 2], ['South Result', '', 12, 2],
      ['Total Result', '', 45, 5],
    ]);
  });

  it('spreads a field across the columns, leaving empty what no record has', () => {
    expect(shown(computePivot({ rows: ['Region'], cols: ['Product'], values: [{ field: 'Sales' }] }, SOURCE))).toEqual([
      ['Sum - Sales', 'Product', '', ''],
      ['Region', 'Ink', 'Pen', 'Total Result'],
      ['North', 20, 13, 33], ['South', '', 12, 12], ['Total Result', 20, 25, 45],
    ]);
  });

  it('groups dates by year, filters, and works a calculated field out on the sums', () => {
    expect(shown(computePivot({
      rows: ['Date'], groups: { Date: { by: 'year' } }, filters: [{ field: 'Region', values: ['North'] }],
      values: [{ field: 'Sales' }, { field: 'Price', name: 'Price', formula: '=Sales/Qty' }],
    }, SOURCE))).toEqual([
      ['Region', 'North', ''], [], ['Date', 'Sum - Sales', 'Price'], ['2023', 30, 5], ['2024', 3, 3], ['Total Result', 33, 33 / 7],
    ].map((l) => [...l, '', '', ''].slice(0, 3)));
  });

  it('groups numbers into ranges and dates into quarters and months', () => {
    expect(groupItem(17, { by: 'range', start: 0, step: 10 }).label).toBe('10-19');
    expect(groupItem(45031, { by: 'quarter' }).label).toBe('Q2');
    expect(groupItem(45031, { by: 'month' }).label).toBe('Apr');
    expect(groupItem(45031, { by: 'yearMonth' }).label).toBe('2023-04');
  });

  it('GETPIVOTDATA reads one value by its items, and #REF! for a field not in the table', () => {
    const pivot = { rows: ['Region'], cols: ['Product'], values: [{ field: 'Sales' }] };
    expect(pivotData(pivot, SOURCE, 'Sum - Sales', [['Region', 'North'], ['Product', 'Pen']])).toBe(13);
    expect(pivotData(pivot, SOURCE, 'Sales', [])).toBe(45);
    expect(pivotData(pivot, SOURCE, 'Sales', [['Date', 45000]])).toBe('#REF!');
  });

  it('works through a hundred thousand records without trouble', () => {
    const records = Array.from({ length: 100000 }, (_, i) => [`R${i % 50}`, `P${i % 7}`, 45000 + (i % 400), i % 13, 1]);
    const started = Date.now();
    const result = computePivot({ rows: ['Region'], cols: ['Product'], values: [{ field: 'Sales' }] }, { fields: SOURCE.fields, records });
    expect(result.cells).toHaveLength(53);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

function workbook() {
  const cells = {};
  SOURCE.fields.forEach((f, c) => { cells[`0,${c}`] = { v: f }; });
  SOURCE.records.forEach((record, r) => record.forEach((v, c) => { cells[`${r + 1},${c}`] = { v }; }));
  const model = new GridModel({ version: 1, sheets: [{ name: 'Data', cells }] });
  return { model, sheet: new SheetController(model, { onChange: () => {} }) };
}

describe('pivot tables in Grid', () => {
  it('lands on a new sheet, refreshes when asked, and GETPIVOTDATA follows it', () => {
    const { model, sheet } = workbook();
    const { id } = sheet.createPivot({ source: 'Data!$A$1:$E$6', rows: ['Region'], values: [{ field: 'Sales' }] });
    expect(model.sheets).toHaveLength(2);
    const out = model.sheets[1];
    expect(out.name).toBe('Pivot Table_Data_1');
    expect(out.valueAt(1, 0)).toBe('North');
    expect(out.valueAt(1, 1)).toBe(33);
    expect(model.styles[out.cell(3, 0).s].name).toBe('Pivot Table Result');
    sheet.setCell(0, 4, '=GETPIVOTDATA("Sum - Sales",A1,"Region","South")');
    expect(out.valueAt(0, 4)).toBe(12);

    model.activeSheetId = model.sheets[0].id;
    sheet.setCell(3, 3, '100');
    expect(out.valueAt(2, 1)).toBe(12);
    sheet.refreshPivots();
    expect(out.valueAt(2, 1)).toBe(107);
    expect(out.valueAt(0, 4)).toBe(107);

    sheet.updatePivot(id, { rows: ['Product'] });
    expect([out.valueAt(1, 0), out.valueAt(2, 0), out.valueAt(3, 0)]).toEqual(['Ink', 'Pen', 'Total Result']);
    sheet.step(-1);
    expect(model.sheets[1].valueAt(1, 0)).toBe('North');
  });

  it('keeps its source when rows are inserted inside it, and refuses to say yes to covering cells', () => {
    const { model, sheet } = workbook();
    sheet.createPivot({ source: 'Data!$A$1:$E$6', rows: ['Region'], values: [{ field: 'Sales' }] }, { sheetId: model.sheets[0].id, row: 0, col: 7 });
    const pivot = model.sheets[0].pivots[0];
    sheet.insertRows(2, 1);
    expect(pivot.source).toBe('Data!$A$1:$E$7');
    expect(pivot.area.top).toBe(0);
    const result = sheet.pivotResult(pivot);
    expect(sheet.pivotCovers(result, { row: 0, col: 3 })).toBe(true);
    expect(sheet.pivotCovers(result, { row: 0, col: 7 }, model.sheets[0], pivot.area)).toBe(false);
  });
});

describe('pivot tables through .ods, and through LibreOffice', async () => {
  const { join } = await import('node:path');
  const { readOds, writeOds } = await import('../src/js/core/formats/ods.js');
  const { readXlsx, writeXlsx } = await import('../src/js/core/formats/xlsx.js');
  const { decodeBlock, encodeBlock } = await import('../src/js/core/package.js');
  const { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } = await import('../../../scripts/oracle.mjs');

  function made() {
    const { model, sheet } = workbook();
    sheet.createPivot({
      source: 'Data!$A$1:$E$6', rows: ['Region'], cols: ['Product'], values: [{ field: 'Sales', fn: 'sum' }, { field: 'Qty', fn: 'count' }],
      filters: [{ field: 'Date' }], groups: { Date: { by: 'year' } },
    });
    return model;
  }
  const fieldsOf = (document) => {
    const sheet = document.sheets.find((s) => s.pivots?.length);
    const { id, ...pivot } = sheet.pivots[0];
    return { sheet: sheet.name, totals: { rows: true, cols: true }, subtotals: true, ...pivot };
  };

  it('come back from .ods as they went', () => {
    const document = made().exportJSON();
    const back = readOds(decodeBlock(encodeBlock(writeOds(document).entries))).document;
    expect(fieldsOf(back)).toEqual(fieldsOf(document));
    expect(back.sheets[1].cells['5,0'].v).toBe('North');
  });

  it('come back from .xlsx as they went, but for the grouping Excel keeps apart', () => {
    const document = made().exportJSON();
    const back = readXlsx(decodeBlock(encodeBlock(writeXlsx(document).entries))).document;
    const { groups, ...want } = fieldsOf(document);
    const { groups: none, ...got } = fieldsOf(back);
    expect(got).toEqual(want);
  });

  it.skipIf(!oracleAvailable())('LibreOffice reads them from .xlsx and gives them back', () => {
    const dir = scratch();
    try {
      const document = made().exportJSON();
      const file = join(dir, 'pivot.xlsx');
      writeBlock(encodeBlock(writeXlsx(document).entries), file);
      const saved = convert(file, 'xlsx:Calc MS Excel 2007 XML', join(dir, 'again'));
      const back = readXlsx(decodeBlock(readBlock(saved))).document;
      const pick = ({ rows, cols, values, filters, source }) => ({ rows, cols, values, filters: filters.map((f) => f.field), source });
      expect(pick(fieldsOf(back))).toEqual(pick(fieldsOf(document)));
    } finally {
      cleanup(dir);
    }
  }, 180000);

  it.skipIf(!oracleAvailable())('LibreOffice keeps them and gives them back', () => {
    const dir = scratch();
    try {
      const document = made().exportJSON();
      const file = join(dir, 'pivot.ods');
      writeBlock(encodeBlock(writeOds(document).entries), file);
      const saved = convert(file, 'ods', join(dir, 'again'));
      const back = readOds(decodeBlock(readBlock(saved))).document;
      const { area: a, ...want } = fieldsOf(document);
      const { area: b, ...got } = fieldsOf(back);
      expect(got).toEqual(want);
      expect(b.top).toBe(a.top);
      expect(b.left).toBe(a.left);
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
