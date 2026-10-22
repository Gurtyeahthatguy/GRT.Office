// @vitest-environment jsdom

/** How sheets print, through OpenDocument and Excel files. */

import { describe, it, expect } from 'vitest';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { GridModel, normalisePrint } from '../src/js/model.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

function printed() {
  const model = new GridModel();
  const first = model.sheet;
  first.name = 'Sales 2026';
  for (let r = 0; r < 40; r += 1) for (let c = 0; c < 6; c += 1) first.set(r, c, { v: r * 10 + c });
  first.print = normalisePrint({
    size: 'A5', orientation: 'landscape', margin: 12.5, fitWidth: true, gridlines: true, labels: false,
    area: { top: 0, left: 0, bottom: 35, right: 4 }, repeatRows: { top: 0, bottom: 1 }, rowBreaks: [12, 24], colBreaks: [3],
  });
  const second = model.addSheet('Plain');
  second.set(0, 0, { v: 'x' });
  return model;
}

const FORMATS = {
  ods: (doc) => readOds(through(writeOds(doc).entries)),
  fods: (doc) => readOds(writeOds(doc, { flat: true }).text),
  xlsx: (doc) => readXlsx(through(writeXlsx(doc).entries)),
};

describe.each(Object.keys(FORMATS))('how sheets print, through .%s', (format) => {
  it('comes back as it was set', () => {
    const model = printed();
    const { document, losses } = FORMATS[format](model.toJSON());
    expect(losses.empty).toBe(true);
    const back = new GridModel(document);
    expect(back.sheets[0].print).toEqual(model.sheets[0].print);
    // A sheet nobody set up comes back set up as nobody did.
    expect(back.sheets[1].toJSON().print).toBeUndefined();
    expect(back.sheets[0].cell(39, 5).v).toBe(395);
  });

  it('keeps a paper of its own size, and the sheet name and page numbers', () => {
    const model = new GridModel();
    model.sheet.set(0, 0, { v: 1 });
    model.sheet.print = normalisePrint({ size: 'custom', width: 200, height: 300, gridlines: true });
    const { document } = FORMATS[format](model.toJSON());
    const print = new GridModel(document).sheet.print;
    expect([print.size, print.width, print.height, print.labels, print.gridlines]).toEqual(['custom', 200, 300, true, true]);
  });

  it('is the same, byte for byte, written twice', () => {
    const write = format === 'xlsx' ? (doc) => JSON.stringify(writeXlsx(doc).entries)
      : format === 'ods' ? (doc) => JSON.stringify(writeOds(doc).entries) : (doc) => writeOds(doc, { flat: true }).text;
    expect(write(printed().toJSON())).toBe(write(printed().toJSON()));
  });
});
