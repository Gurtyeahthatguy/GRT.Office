// @vitest-environment jsdom

/** Charts in Paper: their own data, drawn, and carried through .odt and .docx and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { Renderer } from '../src/js/core/editor/render.js';
import { dataFromText, dataToText } from '../src/js/core/formats/chart-object.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { dataFromSheet } from '../src/js/charts.js';

const DATA = { categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Rome', values: [10, 12, 8] }, { name: 'Milan', values: [7, null, 11] }] };
const KINDS = [{ type: 'column', title: 'Sales', legend: 'bottom' }, { type: 'bar', stacked: 'stacked' }, { type: 'line', yTitle: 'Units' }, { type: 'pie', title: 'Share' }];

const document = () => new DocumentModel({
  blocks: [{ kind: 'paragraph', runs: [{ text: 'Charts' }] }, ...KINDS.map((kind) => ({ kind: 'chart', w: 400, h: 240, data: DATA, ...kind }))],
}).toJSON();

const charts = (doc) => doc.blocks.filter((b) => b.kind === 'chart').map(({ type, stacked = false, title = '', yTitle = '', legend, data }) => ({
  type, stacked, title, yTitle, legend, data: { categories: data.categories, series: data.series.map((s) => ({ name: s.name, values: s.values })) },
}));

describe('a chart with its own data', () => {
  it('reads data typed as lines and gives it back the same', () => {
    const data = dataFromText('\tRome\tMilan\nJan\t10\t7\nFeb\t12\t\nMar\t8\t11');
    expect(data).toEqual(DATA);
    expect(dataFromText(dataToText(DATA))).toEqual(DATA);
  });

  it('is drawn in the text', () => {
    const surface = window.document.createElement('div');
    new Renderer(surface).draw(new DocumentModel(document()));
    expect(surface.querySelectorAll('.block.chart svg')).toHaveLength(4);
    expect(surface.querySelector('.block.chart svg').textContent).toContain('Sales');
  });

  it('takes a block of a sheet: names on top, categories down the side', () => {
    const sheet = { cells: { '0,1': { v: 'Rome' }, '1,0': { v: 'Jan' }, '1,1': { v: 10 }, '2,0': { v: 'Feb' }, '2,1': { v: 12 } } };
    expect(dataFromSheet(sheet, 'A1:B3')).toEqual({ categories: ['Jan', 'Feb'], series: [{ name: 'Rome', values: [10, 12] }] });
  });
});

describe('charts through the formats', () => {
  const want = charts(document());
  it('come back from .odt and .docx as they went', () => {
    expect(charts(readOdt(decodeBlock(encodeBlock(writeOdt(document()).entries))).document)).toEqual(want);
    expect(charts(readOdt(writeOdt(document(), new Map(), { flat: true }).text).document)).toEqual(want);
    expect(charts(readDocx(decodeBlock(encodeBlock(writeDocx(document()).entries))).document)).toEqual(want);
  });
  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `charts.${format}`);
        writeBlock(encodeBlock(write(document()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(charts(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
