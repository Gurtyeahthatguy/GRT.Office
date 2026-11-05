// @vitest-environment jsdom

/** Charts through .ods and .xlsx, and through LibreOffice. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';
import { chartFromArea, chartSpec } from '../src/js/charts.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

const KINDS = [
  { type: 'column', title: 'Sales', yTitle: 'Units', legend: 'bottom' },
  { type: 'bar', stacked: 'stacked' },
  { type: 'line', legend: 'none' },
  { type: 'area', stacked: 'percent' },
  { type: 'pie', title: 'Share' },
  { type: 'scatter' },
];

function workbook() {
  const model = new GridModel({ version: 1, sheets: [{ name: 'Sales', cells: {
    '0,0': { v: 'Month' }, '0,1': { v: 'Rome' }, '0,2': { v: 'Milan' },
    '1,0': { v: 'Jan' }, '1,1': { v: 10 }, '1,2': { v: 7 },
    '2,0': { v: 'Feb' }, '2,1': { v: 12 }, '2,2': { v: 9 },
    '3,0': { v: 'Mar' }, '3,1': { v: 8 }, '3,2': { v: 11 },
  } }, { name: 'Other', cells: { '0,0': { v: 1 } } }] });
  const sheet = new SheetController(model, { onChange: () => {} });
  KINDS.forEach((kind, i) => {
    const area = kind.type === 'scatter' ? { top: 1, left: 1, bottom: 3, right: 2 } : { top: 0, left: 0, bottom: 3, right: 2 };
    const made = chartFromArea(model.sheet, area, { type: kind.type });
    sheet.insertChart({ ...made, ...kind, anchor: { row: i * 16, col: 5, dx: 0, dy: 0 }, width: 400, height: 250 });
  });
  return model;
}

/** What a chart says, without the ids and sizes a file may round. */
function summary(document) {
  const model = new GridModel(document);
  const sheet = new SheetController(model, { onChange: () => {} });
  return model.charts.map((chart) => {
    const spec = chartSpec(chart, sheet.engine, model);
    return {
      sheet: model.sheets.findIndex((s) => s.id === chart.sheet),
      type: chart.type, stacked: chart.stacked || false, title: chart.title ?? '', yTitle: chart.yTitle ?? '', legend: chart.legend,
      anchor: [chart.anchor.row, chart.anchor.col],
      size: [Math.round(chart.width / 4), Math.round(chart.height / 4)],
      categories: spec.categories ?? null,
      series: spec.series.map((s) => [s.name, s.values, s.x]),
    };
  });
}

describe('charts through the formats', () => {
  const expected = summary(workbook().exportJSON());
  it('the workbook has the charts it should', () => {
    expect(expected.map((c) => c.type)).toEqual(['column', 'bar', 'line', 'area', 'pie', 'scatter']);
    expect(expected[0].series[0]).toEqual(['Rome', [10, 12, 8], null]);
  });
  it('come back from .ods as they went', () => {
    expect(summary(readOds(through(writeOds(workbook().exportJSON()).entries)).document)).toEqual(expected);
  });
  it('come back from a flat .fods as they went', () => {
    expect(summary(readOds(writeOds(workbook().exportJSON(), { flat: true }).text).document)).toEqual(expected);
  });
  it('come back from .xlsx as they went', () => {
    expect(summary(readXlsx(through(writeXlsx(workbook().exportJSON()).entries)).document)).toEqual(expected);
  });
});

const ready = oracleAvailable();

describe.skipIf(!ready)('LibreOffice reads the charts and gives them back', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  for (const format of ['ods', 'xlsx']) {
    it(`from .${format}`, () => {
      const document = workbook().exportJSON();
      const entries = format === 'ods' ? writeOds(document).entries : writeXlsx(document).entries;
      const file = join(dir, `charts.${format}`);
      writeBlock(encodeBlock(entries), file);
      const saved = convert(file, format === 'ods' ? 'ods' : 'xlsx:Calc MS Excel 2007 XML', join(dir, `again-${format}`));
      const back = summary((format === 'ods' ? readOds : readXlsx)(decodeBlock(readBlock(saved))).document);
      const loose = (list) => list.map(({ size, anchor, ...rest }) => rest);
      expect(loose(back)).toEqual(loose(summary(document)));
      back.forEach((chart, i) => expect(chart.anchor).toEqual(summary(document)[i].anchor));
    }, 180000);
  }
});
