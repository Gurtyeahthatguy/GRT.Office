// @vitest-environment jsdom

/** Text in cells, even text that looks like a number, is skipped by SUM and its kin; text typed into a formula is read. Checked against LibreOffice. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';
import { key } from '../src/js/references.js';

const FORMULAS = [
  'SUM(A1:A4)', 'SUM(A1)', 'SUM(A1;A2)', 'AVERAGE(A1:A4)', 'COUNT(A1:A4)', 'COUNTA(A1:A4)', 'MAX(A1:A4)', 'MIN(A1:A4)',
  'PRODUCT(A1:A4)', 'SUM("5";1)', 'SUM(TRUE();1)', 'AVERAGE("4";2)', 'MAX("7";2)', 'SUMSQ(A1:A4)', 'AVERAGEA(A1:A4)', 'COUNT("5";1)', 'COUNT("x";1)', 'PRODUCT("2";3)', 'MEDIAN("3";1)', 'STDEV("3";1;2)', 'STDEV(A1:A4)',
];

function sheet() {
  const cells = { [key(0, 0)]: { v: '5' }, [key(1, 0)]: { v: 3 }, [key(2, 0)]: { v: 'x' }, [key(3, 0)]: { v: true } };
  FORMULAS.forEach((f, r) => { cells[key(r, 2)] = { f: `=${f.replaceAll(';', ',')}` }; });
  const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells }] });
  new SheetController(model, { onChange: () => {} }).engine.recalculateAll();
  return model;
}

/** The package with every formula's result taken out, so LibreOffice computes them itself. */
const withoutResults = (entries) => entries.map((entry) => (entry.name !== 'content.xml' ? entry : {
  ...entry,
  data: entry.data.replace(/(<table:table-cell [^>]*table:formula="[^"]*")[^>]*?(\/?>)(?:<text:p>.*?<\/text:p>)?/g, (match, open, close) => {
    const kept = open.replace(/ office:(value-type|value|date-value|time-value|boolean-value|string-value)="[^"]*"/g, '');
    return close === '/>' ? `${kept}/>` : `${kept}>`;
  }),
}));

describe('text in cells', () => {
  it('is skipped by SUM, AVERAGE, COUNT, MAX and their kin, a logical value counts, and typed text is an error, as in Calc', () => {
    const model = sheet();
    const value = (f) => model.sheet.valueAt(FORMULAS.indexOf(f), 2);
    expect(['SUM(A1:A4)', 'SUM(A1)', 'COUNT(A1:A4)', 'SUM("5";1)', 'SUM(TRUE();1)'].map(value)).toEqual([4, 0, 2, '#VALUE!', 2]);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and text in cells', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('gives the same value for every formula', () => {
    const model = sheet();
    const file = join(dir, 'text.ods');
    writeBlock(encodeBlock(withoutResults(writeOds(model.toJSON()).entries)), file);
    const back = readOds(decodeBlock(readBlock(convert(file, 'ods', join(dir, 'again'))))).document.sheets[0].cells;
    const differences = FORMULAS.map((f, r) => [f, model.sheet.valueAt(r, 2), back[key(r, 2)]?.v ?? null])
      .filter(([, ours, theirs]) => !(typeof ours === 'number' && typeof theirs === 'number' ? Math.abs(ours - theirs) < 1e-9 : ours === theirs))
      .map(([f, ours, theirs]) => `${f}: Grid ${JSON.stringify(ours)}, LibreOffice ${JSON.stringify(theirs)}`);
    expect(differences).toEqual([]);
  }, 120000);
});
