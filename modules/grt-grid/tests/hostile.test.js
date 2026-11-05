// @vitest-environment jsdom

/** Spreadsheets made to hurt the engine: each one opens, or shows errors in its cells, quickly. */

import { describe, it, expect } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const ROWS = 100000;

/** Opens a document as the program does, within the time, and gives back the first sheet. */
function opens(cells, seconds = 10) {
  const start = performance.now();
  const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells }] });
  const controller = new SheetController(model, { onChange: () => {} });
  expect((performance.now() - start) / 1000).toBeLessThan(seconds);
  return { sheet: model.sheet, controller };
}

describe('formulas built to break the engine', () => {
  it('a running total down a hundred thousand rows', () => {
    const cells = { '0,0': { v: 1 } };
    for (let r = 1; r < ROWS; r += 1) cells[`${r},0`] = { f: `=A${r}+1` };
    const { sheet, controller } = opens(cells);
    expect(sheet.valueAt(ROWS - 1, 0)).toBe(ROWS);
    controller.engine.setValue(sheet.id, 0, 0, 2);
    expect(sheet.valueAt(ROWS - 1, 0)).toBe(ROWS + 1);
  });

  it('a cycle a hundred thousand cells long', () => {
    const cells = { '0,0': { f: `=A${ROWS}+1` } };
    for (let r = 1; r < ROWS; r += 1) cells[`${r},0`] = { f: `=A${r}+1` };
    const { sheet } = opens(cells);
    expect(String(sheet.valueAt(5, 0))).toMatch(/^#/);
  });

  it('brackets nested a hundred thousand times', () => {
    const { sheet } = opens({ '0,0': { f: `=${'('.repeat(ROWS)}1${')'.repeat(ROWS)}` } });
    expect(String(sheet.valueAt(0, 0))).toMatch(/^#/);
  });

  it('a sum over every cell of the sheet', () => {
    const { sheet } = opens({ '0,1': { v: 5 }, '0,0': { f: '=SUM(B1:XFD1048576)+COUNTA(B:B)+SUMPRODUCT(B1:B1048576,B1:B1048576)' } });
    expect(String(sheet.valueAt(0, 0))).toMatch(/^(#|\d)/);
  });

  it('a lookup and a text that grow without end', () => {
    const { sheet } = opens({ '0,0': { f: '=REPT("x",2^31)' }, '1,0': { f: '=VLOOKUP(1,B1:XFD1048576,16384,FALSE)' } });
    expect(String(sheet.valueAt(0, 0))).toMatch(/^#/);
    expect(String(sheet.valueAt(1, 0))).toMatch(/^#/);
  });
});

describe('a CSV made to hurt the import', () => {
  it('a million columns on one line', () => {
    const { controller } = opens({});
    const start = performance.now();
    try {
      controller.importCsv('a,'.repeat(1_000_000));
    } catch (err) {
      expect(err).not.toBeInstanceOf(RangeError);
    }
    expect((performance.now() - start) / 1000).toBeLessThan(10);
  });
});

describe('a CSV written for someone else', () => {
  it('shows text that looks like a formula instead of letting Excel run it', async () => {
    const { toCsv } = await import('../src/js/core/csv.js');
    const rows = [['=cmd|\' /C calc\'!A0', '+1+1', '-2+3', '@SUM(A1)', '\tx', 'plain', -5, 3.5, '#DIV/0!']];
    expect(toCsv(rows, { neutralise: true })).toBe(`'=cmd|' /C calc'!A0,'+1+1,'-2+3,'@SUM(A1),'\tx,plain,-5,3.5,#DIV/0!\r\n`);
    expect(toCsv(rows)).toMatch(/^=cmd/);
  });

  it('is what the export writes', () => {
    const { controller, sheet } = opens({ '0,0': { v: '=HYPERLINK("http://x")' }, '0,1': { v: 4 } });
    expect(sheet.valueAt(0, 0)).toBe('=HYPERLINK("http://x")');
    expect(controller.exportCsv()).toBe(`"'=HYPERLINK(""http://x"")",4\r\n`);
  });
});
