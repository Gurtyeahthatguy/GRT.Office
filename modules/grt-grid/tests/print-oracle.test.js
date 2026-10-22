// @vitest-environment jsdom

/** LibreOffice prints what Grid writes as Grid would, on a machine that has it. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { GridModel, normalisePrint } from '../src/js/model.js';
import { planPages, printedArea } from '../src/js/printing.js';
import {
  oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert, pdfPages,
} from '../../../scripts/oracle.mjs';
import { execFileSync } from 'node:child_process';

const ready = oracleAvailable();

function report() {
  const model = new GridModel();
  const sheet = model.sheet;
  sheet.name = 'Report';
  for (let r = 0; r < 40; r += 1) for (let c = 0; c < 4; c += 1) sheet.set(r, c, { v: `r${r}c${c}` });
  sheet.print = normalisePrint({
    size: 'A5', orientation: 'landscape', gridlines: true,
    area: { top: 0, left: 0, bottom: 39, right: 2 }, repeatRows: { top: 0, bottom: 0 }, rowBreaks: [10, 20, 30],
  });
  return model;
}

const WRITERS = {
  ods: (model) => writeOds(model.toJSON()).entries,
  xlsx: (model) => writeXlsx(model.toJSON()).entries,
};
const READERS = { ods: readOds, xlsx: readXlsx };

describe.skipIf(!ready).each(Object.keys(WRITERS))('LibreOffice prints Grid’s .%s', (format) => {
  let dir;
  beforeAll(() => {
    dir = scratch();
  });
  afterAll(() => cleanup(dir));

  it('on the same pages, paper and print area as Grid', () => {
    const model = report();
    const ours = planPages([{ sheet: model.sheet, setup: model.sheet.print, area: printedArea(model.sheet) }]);
    const file = join(dir, `report.${format}`);
    writeBlock(encodeBlock(WRITERS[format](model)), file);
    const pdf = convert(file, 'pdf', join(dir, 'pdf'));

    const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }));
    expect(Number(size[1])).toBeCloseTo(595.3, 0);
    expect(Number(size[2])).toBeCloseTo(419.5, 0);

    const pages = pdfPages(pdf).filter((text) => text.trim() !== '');
    expect(pages).toHaveLength(ours.length);
    pages.forEach((text, i) => {
      const rows = [...ours[i].page.repeat, ...ours[i].page.rows];
      for (const r of rows) expect(text, `page ${i + 1}`).toContain(`r${r}c0`);
      expect(text).not.toMatch(/c3\b/);
      expect(text).toContain('Report');
      expect(text).toContain(`Page ${i + 1} of ${ours.length}`);
    });
  }, 120000);

  it('and keeps the settings when it saves the file again', () => {
    const model = report();
    const file = join(dir, `again.${format}`);
    writeBlock(encodeBlock(WRITERS[format](model)), file);
    const filter = format === 'xlsx' ? 'xlsx:Calc MS Excel 2007 XML' : 'ods';
    const saved = convert(file, filter, join(dir, 'resaved'));
    const back = new GridModel(READERS[format](decodeBlock(readBlock(saved))).document).sheet.print;
    const expected = model.sheet.print;
    for (const field of ['size', 'orientation', 'gridlines', 'fitWidth', 'area', 'repeatRows', 'rowBreaks', 'colBreaks', 'labels']) {
      expect(back[field], field).toEqual(expected[field]);
    }
    expect(back.margin).toBeCloseTo(expected.margin, 0);
  }, 120000);
});
