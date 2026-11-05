// @vitest-environment jsdom

/** Fonts, borders, alignment and named styles, through .ods and .xlsx and through LibreOffice. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';

const through = (entries) => decodeBlock(encodeBlock(entries));
const thin = { style: 'solid', width: 1, color: '#000000' };

const LOOKS = {
  '0,0': { bold: true, italic: true, underline: true, strike: true, color: '#c00000' },
  '0,1': { font: 'DejaVu Serif', size: 14 },
  '0,2': { align: 'center', valign: 'top', wrap: true },
  '0,3': { align: 'left', indent: 2 },
  '1,0': { borders: { top: thin, bottom: { style: 'double', width: 3, color: '#0000ff' } } },
  '1,1': { borders: { left: { style: 'dashed', width: 1, color: '#000000' }, right: { style: 'solid', width: 3, color: '#000000' } } },
  '1,2': { bg: '#ffeb9c', format: '0.0' },
};

function workbook() {
  const styles = { highlight: { name: 'Highlight', bold: true, bg: '#c6efce' }, plus: { name: undefined, parent: 'highlight', bold: true, bg: '#c6efce', italic: true } };
  const cells = { '3,0': { v: 'named', s: 'highlight' }, '3,1': { v: 'named and more', s: 'plus' } };
  Object.entries(LOOKS).forEach(([key, look], i) => {
    styles[`look${i}`] = look;
    cells[key] = { v: i + 0.5, s: `look${i}` };
  });
  delete styles.plus.name;
  return new GridModel({ version: 1, sheets: [{ name: 'Sheet1', cells }], styles }).exportJSON();
}

function expectSame(document) {
  const style = (key) => {
    const { name, parent, ...look } = document.styles[document.sheets[0].cells[key].s] ?? {};
    return look;
  };
  for (const [key, look] of Object.entries(LOOKS)) expect(style(key), key).toEqual(look);
  const named = document.styles[document.sheets[0].cells['3,0'].s];
  expect(named).toMatchObject({ name: 'Highlight', bold: true, bg: '#c6efce' });
  const derived = document.styles[document.sheets[0].cells['3,1'].s];
  expect(derived).toMatchObject({ italic: true, bold: true });
  expect(document.styles[derived.parent].name).toBe('Highlight');
}

describe('cell styles through the formats', () => {
  it('come back from .ods as they went', () => {
    expectSame(readOds(through(writeOds(workbook()).entries)).document);
  });
  it('come back from .xlsx as they went', () => {
    expectSame(readXlsx(through(writeXlsx(workbook()).entries)).document);
  });
});

const ready = oracleAvailable();

describe.skipIf(!ready)('LibreOffice reads the cell styles and gives them back', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  for (const format of ['ods', 'xlsx']) {
    it(`from .${format}`, () => {
      const entries = format === 'ods' ? writeOds(workbook()).entries : writeXlsx(workbook()).entries;
      const file = join(dir, `styles.${format}`);
      writeBlock(encodeBlock(entries), file);
      const saved = convert(file, format === 'ods' ? 'ods' : 'xlsx:Calc MS Excel 2007 XML', join(dir, `again-${format}`));
      expectSame((format === 'ods' ? readOds : readXlsx)(decodeBlock(readBlock(saved))).document);
    }, 180000);
  }
});
