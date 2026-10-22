// @vitest-environment jsdom

/** LibreOffice recalculates what Grid writes, on a machine that has it. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import {
  oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert,
} from '../../../scripts/oracle.mjs';
import { workbook, cellsOf } from './sheets.js';

const ready = oracleAvailable();

/** The package with every formula's result taken out. */
function withoutResults(entries) {
  return entries.map((entry) => (entry.name !== 'content.xml' ? entry : {
    ...entry,
    data: entry.data.replace(/(<table:table-cell [^>]*table:formula="[^"]*")[^>]*?(\/?>)(?:<text:p>.*?<\/text:p>)?/g, (match, open, close) => {
      const kept = open.replace(/ office:(value-type|value|date-value|time-value|boolean-value)="[^"]*"/g, '');
      return close === '/>' ? `${kept}/>` : `${kept}>`;
    }),
  }));
}

/** Every cell of `theirs` holds what Grid computed for it. */
function expectSameResults(model, document) {
  const ours = cellsOf(model.toJSON());
  const theirs = cellsOf(document);
  for (const [index, sheet] of ours.entries()) {
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const other = theirs[index].cells[key];
      expect(other, `${sheet.name}!${key}`).toBeTruthy();
      const formula = typeof cell.v === 'boolean' && !cell.f && other.f === `=${String(cell.v).toUpperCase()}()` ? null : other.f;
      expect(formula, `${sheet.name}!${key}`).toBe(cell.f);
      if (typeof cell.v === 'number') expect(other.v, `${sheet.name}!${key}`).toBeCloseTo(cell.v, 9);
      else expect(other.v, `${sheet.name}!${key}`).toBe(cell.v);
    }
  }
}

/** The workbook with every formula's cached result taken out. */
function xlsxWithoutResults(entries) {
  return entries.map((entry) => (!/^xl\/worksheets\//.test(entry.name) ? entry : {
    ...entry,
    data: entry.data.replace(/<c ([^>]*?)( t="[a-z]+")?([^>]*)><f>([^<]*)<\/f><v>[^<]*<\/v><\/c>/g, '<c $1$3><f>$4</f></c>'),
  }));
}

describe.skipIf(!ready)('LibreOffice and Grid’s .xlsx', () => {
  let dir;
  beforeAll(() => {
    dir = scratch();
  });
  afterAll(() => cleanup(dir));

  it('computes every formula to the value Grid computed, and saves it back as .xlsx', () => {
    const { model } = workbook();
    const file = join(dir, 'grid.xlsx');
    writeBlock(encodeBlock(xlsxWithoutResults(writeXlsx(model.toJSON()).entries)), file);
    const saved = convert(file, 'xlsx:Calc MS Excel 2007 XML', join(dir, 'resaved'));
    expectSameResults(model, readXlsx(decodeBlock(readBlock(saved))).document);
  }, 120000);

  it('and as .ods, from the same .xlsx', () => {
    const { model } = workbook();
    const file = join(dir, 'cross.xlsx');
    writeBlock(encodeBlock(xlsxWithoutResults(writeXlsx(model.toJSON()).entries)), file);
    const saved = convert(file, 'ods', join(dir, 'cross'));
    expectSameResults(model, readOds(decodeBlock(readBlock(saved))).document);
  }, 120000);

  it('CANARY: a result taken out is really gone before LibreOffice sees it', () => {
    const { model } = workbook();
    const sheet = xlsxWithoutResults(writeXlsx(model.toJSON()).entries).find((e) => e.name === 'xl/worksheets/sheet1.xml').data;
    expect(sheet).toMatch(/<c r="B4"[^>]*><f>SUM\(B2:B3\)<\/f><\/c>/);
  });
});

describe.skipIf(!ready)('LibreOffice and Grid’s .ods', () => {
  let dir;
  beforeAll(() => {
    dir = scratch();
  });
  afterAll(() => cleanup(dir));

  it('computes every formula to the value Grid computed', () => {
    const { model } = workbook();
    const file = join(dir, 'grid.ods');
    writeBlock(encodeBlock(withoutResults(writeOds(model.toJSON()).entries)), file);
    const saved = convert(file, 'ods', join(dir, 'resaved'));
    const back = readOds(decodeBlock(readBlock(saved)));
    const ours = cellsOf(model.toJSON());
    const theirs = cellsOf(back.document);
    for (const [index, sheet] of ours.entries()) {
      for (const [key, cell] of Object.entries(sheet.cells)) {
        const other = theirs[index].cells[key];
        expect(other, `${sheet.name}!${key}`).toBeTruthy();
        expect(other.f, `${sheet.name}!${key}`).toBe(cell.f);
        if (typeof cell.v === 'number') expect(other.v, `${sheet.name}!${key}`).toBeCloseTo(cell.v, 9);
        else expect(other.v, `${sheet.name}!${key}`).toBe(cell.v);
      }
    }
  }, 120000);

  it('CANARY: a result taken out is really gone before LibreOffice sees it', () => {
    const { model } = workbook();
    const stripped = withoutResults(writeOds(model.toJSON()).entries).find((e) => e.name === 'content.xml').data;
    expect(stripped).not.toMatch(/table:formula="of:=\[\.B2\]\*2"[^>]*office:value=/);
    expect(stripped).toMatch(/table:formula="of:=SUM\(\[\.B2:\.B3\]\)"/);
    expect(stripped).not.toMatch(/table:formula="of:=SUM\(\[\.B2:\.B3\]\)"[^>]*office:value=/);
  });
});
