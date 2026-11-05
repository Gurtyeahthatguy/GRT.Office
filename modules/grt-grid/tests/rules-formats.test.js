// @vitest-environment jsdom

/** Conditional formats and validity rules through .ods and .xlsx, and through LibreOffice. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const through = (entries) => decodeBlock(encodeBlock(entries));
const A = { top: 0, left: 0, bottom: 7, right: 0 };
const RED = { bg: '#ffcccc', bold: true };

const CONDITIONS = [
  { area: A, type: 'cell', op: '>', values: ['=4'], style: RED },
  { area: A, type: 'cell', op: 'between', values: ['=2', '=3'], style: { color: '#0000ff' } },
  { area: A, type: 'formula', formula: '=MOD(A1,2)=1', style: { italic: true } },
  { area: A, type: 'duplicate', style: RED },
  { area: A, type: 'top', count: 2, style: RED },
  { area: A, type: 'average', below: true, style: RED },
  { area: A, type: 'text', op: 'contains', value: 'x', style: RED },
  { area: A, type: 'error', style: RED },
  { area: { top: 0, left: 1, bottom: 7, right: 1 }, type: 'scale', points: [{ type: 'min' }, { type: 'percentile', value: '50' }, { type: 'max' }], colors: ['#ff0000', '#ffff00', '#00ff00'] },
];
const VALIDATIONS = [
  { area: { top: 0, left: 3, bottom: 4, right: 3 }, type: 'whole', op: 'between', values: ['=1', '=10'], error: { style: 'stop', title: 'No', message: 'From 1 to 10' } },
  { area: { top: 0, left: 4, bottom: 4, right: 4 }, type: 'list', list: ['red', 'green'], error: { style: 'warning', title: '', message: 'Pick one' } },
  { area: { top: 0, left: 5, bottom: 4, right: 5 }, type: 'list', source: '=$A$1:$A$3' },
  { area: { top: 0, left: 6, bottom: 4, right: 6 }, type: 'custom', formula: '=G1>A1' },
  { area: { top: 0, left: 7, bottom: 4, right: 7 }, type: 'length', op: '<=', values: ['=5'] },
];

const document = () => ({
  version: 1, type: 'grid', styles: {}, charts: [], sheets: [{
    name: 'S', cells: Object.fromEntries([1, 5, 9, 5, 2, 7, 3, 8].map((v, r) => [`${r},0`, { v }])),
    conditions: structuredClone(CONDITIONS), validations: structuredClone(VALIDATIONS),
  }],
});

/** What a rule says, without what the formats may write differently but mean the same. */
const essence = (rule) => {
  const { stop, style, allowBlank, input, ...rest } = rule;
  // A rule that says nothing about refusing refuses, in every format.
  if (rest.type && ['whole', 'decimal', 'list', 'date', 'time', 'length', 'custom'].includes(rest.type)) {
    rest.error = { style: rest.error?.style ?? 'stop', message: rest.error?.message ?? '' };
  }
  if (rest.values) rest.values = rest.values.map((v) => String(v).replace(/^=/, ''));
  if (rest.points) rest.points = rest.points.map((p) => ({ type: p.type, ...(p.type === 'percentile' || p.type === 'number' || p.type === 'percent' ? { value: String(p.value) } : {}) }));
  return { ...rest, ...(style ? { style } : {}) };
};

function expectSame(sheet) {
  if (process.env.GRT_SHOW) console.log(JSON.stringify({ c: sheet.conditions.map(essence), v: sheet.validations.map(essence) }, null, 1));
  expect(sheet.conditions.map(essence)).toEqual(CONDITIONS.map(essence));
  expect(sheet.validations.map(essence)).toEqual(VALIDATIONS.map(essence));
}

describe('conditional formats and validity through the formats', () => {
  it('come back from .ods', () => expectSame(readOds(through(writeOds(document()).entries)).document.sheets[0]));
  it('come back from .xlsx', () => expectSame(readXlsx(through(writeXlsx(document()).entries)).document.sheets[0]));
});

describe.skipIf(!oracleAvailable())('LibreOffice reads them and gives them back', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));
  for (const format of ['ods', 'xlsx']) {
    it(`from .${format}`, () => {
      const entries = format === 'ods' ? writeOds(document()).entries : writeXlsx(document()).entries;
      const file = join(dir, `rules.${format}`);
      writeBlock(encodeBlock(entries), file);
      const saved = convert(file, format === 'ods' ? 'ods' : 'xlsx:Calc MS Excel 2007 XML', join(dir, `again-${format}`));
      expectSame((format === 'ods' ? readOds : readXlsx)(decodeBlock(readBlock(saved))).document.sheets[0]);
    }, 180000);
  }
});
