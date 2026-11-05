// @vitest-environment jsdom

/** Merged cells, hidden rows and columns, the autofilter and defined names, through .ods and .xlsx. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

function workbook() {
  const model = new GridModel({ version: 1, sheets: [{ name: 'Data', cells: {
    '0,0': { v: 'Name' }, '0,1': { v: 'City' }, '0,2': { v: 'Score' },
    '1,0': { v: 'Ada' }, '1,1': { v: 'Turin' }, '1,2': { v: 9 },
    '2,0': { v: 'Bob' }, '2,1': { v: 'Milan' }, '2,2': { v: 7 },
    '3,0': { v: 'Cleo' }, '3,1': { v: 'Turin' }, '3,2': { v: 8 },
    '6,0': { v: 'Title' }, '0,5': { f: '=SUM(Scores)' },
  } }] });
  const sheet = new SheetController(model, { onChange: () => {} });
  sheet.engine.setName('Scores', '=Data!$C$2:$C$4');
  sheet.selectRange(6, 0, 6, 2);
  sheet.merge();
  sheet.selectRange(0, 4, 0, 4);
  sheet.setHidden('col', true);
  sheet.selectRange(8, 0, 8, 0);
  sheet.setHidden('row', true);
  sheet.setFilter({ top: 0, left: 0, bottom: 3, right: 2 });
  sheet.setFilterColumn(1, { values: ['Turin'] });
  return model;
}

function expectSame(document) {
  const back = new GridModel(document);
  new SheetController(back, { onChange: () => {} });
  const sheet = back.sheet;
  expect(sheet.merges).toEqual([{ top: 6, left: 0, bottom: 6, right: 2 }]);
  expect(sheet.isHidden('col', 4)).toBe(true);
  expect(sheet.isHidden('row', 8)).toBe(true);
  expect(sheet.filter.area).toEqual({ top: 0, left: 0, bottom: 3, right: 2 });
  expect(sheet.filter.columns['1'].values).toEqual(['Turin']);
  expect([...sheet.filtered]).toEqual([2]);
  expect(sheet.rows.get(2)?.hidden).toBeUndefined();
  expect(back.names.SCORES).toBe('=Data!$C$2:$C$4');
  expect(sheet.valueAt(0, 5)).toBe(24);
}

describe('sheet features through the formats', () => {
  it('come back from .ods as they went', () => {
    expectSame(readOds(through(writeOds(workbook().exportJSON()).entries)).document);
  });
  it('come back from .xlsx as they went', () => {
    expectSame(readXlsx(through(writeXlsx(workbook().exportJSON()).entries)).document);
  });
});

const ready = oracleAvailable();

describe.skipIf(!ready)('LibreOffice reads them and gives them back', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  for (const format of ['ods', 'xlsx']) {
    it(`from .${format}`, () => {
      const entries = format === 'ods' ? writeOds(workbook().exportJSON()).entries : writeXlsx(workbook().exportJSON()).entries;
      const file = join(dir, `features.${format}`);
      writeBlock(encodeBlock(entries), file);
      const saved = convert(file, format === 'ods' ? 'ods' : 'xlsx:Calc MS Excel 2007 XML', join(dir, `again-${format}`));
      expectSame((format === 'ods' ? readOds : readXlsx)(decodeBlock(readBlock(saved))).document);
    }, 180000);
  }
});
