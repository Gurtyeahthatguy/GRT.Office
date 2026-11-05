// @vitest-environment jsdom

/** Sheets renamed, deleted, hidden, moved, copied and coloured, and kept so through .ods and .xlsx. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

function book() {
  const model = new GridModel({ version: 1, sheets: [
    { name: 'Data', cells: { '0,0': { v: 4 }, '1,0': { v: 6 } } },
    { name: 'Sums', cells: { '0,0': { f: '=SUM(Data!A1:A2)' }, '1,0': { f: '=Data!A1*2' } } },
    { name: 'Notes', cells: { '0,0': { v: 'kept' } } },
  ] });
  const sheet = new SheetController(model, { onChange: () => {} });
  return { model, sheet };
}

describe('sheet commands', () => {
  it('renames a sheet and every formula and name that points at it', () => {
    const { model, sheet } = book();
    sheet.engine.setName('Total', '=Data!$A$1:$A$2');
    expect(sheet.renameSheet(model.sheets[0].id, 'Figures 2026')).toBe(true);
    const sums = model.sheets[1];
    expect(sums.cell(0, 0).f).toBe("=SUM('Figures 2026'!A1:A2)");
    expect(sums.valueAt(0, 0)).toBe(10);
    expect(model.names.TOTAL).toBe("='Figures 2026'!$A$1:$A$2");
    sheet.step(-1);
    expect(model.sheets[0].name).toBe('Data');
  });

  it('refuses a name that is taken, empty or holds a forbidden character', () => {
    const { model, sheet } = book();
    const id = model.sheets[0].id;
    expect(sheet.renameSheet(id, 'sums')).toBe(false);
    expect(sheet.renameSheet(id, '  ')).toBe(false);
    expect(sheet.renameSheet(id, 'a/b')).toBe(false);
  });

  it('deletes a sheet, leaving #REF! where formulas pointed at it', () => {
    const { model, sheet } = book();
    sheet.deleteSheet(model.sheets[0].id);
    expect(model.sheets.map((s) => s.name)).toEqual(['Sums', 'Notes']);
    expect(model.sheets[0].cell(1, 0).f).toBe('=#REF!*2');
  });

  it('hides sheets but never the last one shown, and moves off a hidden one', () => {
    const { model, sheet } = book();
    sheet.switchSheet(model.sheets[1].id);
    expect(sheet.setSheetHidden(model.sheets[1].id, true)).toBe(true);
    expect(model.activeSheetId).toBe(model.sheets[2].id);
    sheet.setSheetHidden(model.sheets[0].id, true);
    expect(sheet.setSheetHidden(model.sheets[2].id, true)).toBe(false);
    sheet.setSheetHidden(model.sheets[0].id, false);
    sheet.switchSheet(model.sheets[0].id);
    sheet.stepSheet(1);
    expect(model.activeSheetId).toBe(model.sheets[2].id);
  });

  it('moves a sheet and copies one with its charts under a free name', () => {
    const { model, sheet } = book();
    model.charts.push({ id: 'chart-1', sheet: model.sheets[0].id, type: 'bar', series: [{ values: 'Data!$A$1:$A$2' }] });
    sheet.moveSheet(model.sheets[2].id, 0);
    expect(model.sheets.map((s) => s.name)).toEqual(['Notes', 'Data', 'Sums']);
    sheet.moveSheet(model.sheets[1].id, null, { copy: true });
    expect(model.sheets.map((s) => s.name)).toEqual(['Notes', 'Data', 'Data_2', 'Sums']);
    expect(model.sheets[2].valueAt(1, 0)).toBe(6);
    expect(model.charts.filter((c) => c.sheet === model.sheets[2].id)).toHaveLength(1);
    sheet.moveSheet(model.sheets[1].id, null, { copy: true });
    expect(model.sheets[2].name).toBe('Data_3');
  });

  it('renaming a sheet points chart series at the new name', () => {
    const { model, sheet } = book();
    model.charts.push({ id: 'chart-1', sheet: model.sheets[1].id, type: 'bar', series: [{ values: 'Data!$A$1:$A$2', nameRef: 'Data!$A$1' }] });
    sheet.renameSheet(model.sheets[0].id, 'Raw');
    expect(model.charts[0].series[0]).toEqual({ values: 'Raw!$A$1:$A$2', nameRef: 'Raw!$A$1' });
  });

  it('colours a tab, and only with a colour', () => {
    const { model, sheet } = book();
    sheet.setTabColour(model.sheets[0].id, '#C9211E');
    expect(model.sheets[0].tab).toBe('#c9211e');
    sheet.setTabColour(model.sheets[0].id, 'red; background: url(x)');
    expect(model.sheets[0].tab).toBe(null);
  });

  it('a file whose every sheet is hidden shows the first', () => {
    const model = new GridModel({ version: 1, sheets: [{ name: 'A', hidden: true }, { name: 'B', hidden: true }] });
    expect(model.sheets[0].hidden).toBe(false);
    expect(model.activeSheetId).toBe(model.sheets[0].id);
  });
});

function styled() {
  const { model, sheet } = book();
  sheet.setSheetHidden(model.sheets[2].id, true);
  sheet.setTabColour(model.sheets[1].id, '#2a6099');
  return model;
}

function expectStyled(document) {
  const back = new GridModel(document);
  expect(back.sheets.map((s) => s.name)).toEqual(['Data', 'Sums', 'Notes']);
  expect(back.sheets.map((s) => s.hidden)).toEqual([false, false, true]);
  expect(back.sheets[1].tab).toBe('#2a6099');
  expect(back.sheets[0].tab).toBe(null);
}

describe('hidden sheets and tab colours in files', () => {
  it('keeps them through .ods', () => {
    const { entries, losses } = writeOds(styled().exportJSON());
    const read = readOds(through(entries));
    expectStyled(read.document);
    expect(read.losses.counts.has('Hidden sheets, shown')).toBe(false);
    expect(losses.empty).toBe(true);
  });

  it('keeps them through flat .fods', () => {
    const { text } = writeOds(styled().exportJSON(), { flat: true });
    expectStyled(readOds(text).document);
  });

  it('keeps them through .xlsx', () => {
    const { entries } = writeXlsx(styled().exportJSON());
    const read = readXlsx(through(entries));
    expectStyled(read.document);
    const { data } = entries.find((e) => e.name === 'xl/workbook.xml');
    const workbook = typeof data === 'string' ? data : new TextDecoder().decode(data);
    expect(workbook).toContain('activeTab="0"');
  });
});

const ready = oracleAvailable();

describe.skipIf(!ready)('LibreOffice reads them and gives them back', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  for (const format of ['ods', 'xlsx']) {
    it(`as .${format}`, () => {
      const { entries } = (format === 'ods' ? writeOds : writeXlsx)(styled().exportJSON());
      const file = join(dir, `tabs.${format}`);
      writeBlock(encodeBlock(entries), file);
      const saved = convert(file, format === 'ods' ? 'ods' : 'xlsx:Calc MS Excel 2007 XML', join(dir, `again-${format}`));
      expectStyled((format === 'ods' ? readOds : readXlsx)(decodeBlock(readBlock(saved))).document);
    });
  }
});
