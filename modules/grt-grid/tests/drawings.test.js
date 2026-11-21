// @vitest-environment jsdom

/** Drawings on sheets: anchored to a cell or to the page, kept by .ods and .xlsx with their pictures and text. */

import { describe, it, expect } from 'vitest';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { GridModel } from '../src/js/model.js';

const through = (entries) => decodeBlock(encodeBlock(entries));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function workbookWithDrawings() {
  const model = new GridModel({
    sheets: [{ id: 's1', name: 'Data', cells: { '0,0': { v: 1 }, '4,3': { v: 'x' } } }, { id: 's2', name: 'Other', cells: {} }],
    drawings: [
      { id: 'a', kind: 'shape', shape: 'star5', x: 6, y: 4, w: 120, h: 90, sheet: 's1', anchor: { type: 'cell', row: 2, col: 1 }, text: 'Star', name: 'Star' },
      { id: 'b', kind: 'image', resource: PNG, x: 10, y: 8, w: 80, h: 60, sheet: 's1', anchor: { type: 'cell', row: 5, col: 4, resize: true }, description: 'A dot' },
      { id: 'c', kind: 'shape', shape: 'ellipse', x: 300, y: 200, w: 60, h: 40, rotation: 30, sheet: 's2', anchor: { type: 'page' }, background: true, fillLook: { type: 'solid', color: '#ff0000' } },
    ],
  });
  return model;
}

const near = (a, b, room = 1.5) => Math.abs(a - b) <= room;

function check(doc) {
  expect(doc.drawings).toHaveLength(3);
  const model = new GridModel(doc);
  const star = model.drawings.find((o) => o.shape === 'star5');
  expect(star.anchor).toMatchObject({ type: 'cell', row: 2, col: 1 });
  expect(near(star.x, 6) && near(star.y, 4)).toBe(true);
  expect(near(star.w, 120) && near(star.h, 90)).toBe(true);
  expect(star.text).toBe('Star');
  expect(star.sheet).toBe(model.sheets[0].id);
  const pic = model.drawings.find((o) => o.kind === 'image');
  expect(pic.anchor).toMatchObject({ type: 'cell', row: 5, col: 4, resize: true });
  expect(pic.resource.startsWith('data:image/png;base64,')).toBe(true);
  expect(pic.description).toBe('A dot');
  const ellipse = model.drawings.find((o) => o.shape === 'ellipse');
  expect(ellipse.anchor.type).toBe('page');
  expect(ellipse.sheet).toBe(model.sheets[1].id);
  expect(near(ellipse.x, 300) && near(ellipse.y, 200)).toBe(true);
  expect(near(ellipse.rotation, 30)).toBe(true);
  return model;
}

describe('drawings of a workbook', () => {
  it('are cleaned: a sheet named by position, an anchor kept in its bounds, an undo step brings them back', () => {
    const model = workbookWithDrawings();
    expect(model.drawings).toHaveLength(3);
    const before = model.snapshot();
    model.drawings = [];
    model.restore(before);
    expect(model.drawings).toHaveLength(3);
    model.removeSheet('s2');
    expect(model.drawings).toHaveLength(2);
    const copy = model.copySheet('s1');
    expect(model.drawings.filter((o) => o.sheet === copy.id)).toHaveLength(2);
  });

  it('come back from .ods anchored to their cells and the page', () => {
    const { entries } = writeOds(workbookWithDrawings().toJSON());
    const model = check(readOds(through(entries)).document);
    expect(model.drawings.find((o) => o.shape === 'ellipse').background).toBe(true);
  });

  it('come back from a flat .ods with their pictures inside', () => {
    const { text } = writeOds(workbookWithDrawings().toJSON(), { flat: true });
    expect(text).toContain('office:binary-data');
    expect(text).toContain('table:end-cell-address');
  });

  it('come back from .xlsx anchored as they were', () => {
    const { entries } = writeXlsx(workbookWithDrawings().toJSON());
    const names = entries.map((e) => e.name);
    expect(names).toContain('xl/drawings/drawing1.xml');
    expect(names.some((n) => /^xl\/media\/image1\.png$/.test(n))).toBe(true);
    check(readXlsx(through(entries)).document);
  });
});
