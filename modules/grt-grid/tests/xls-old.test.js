// @vitest-environment jsdom

/** Excel 5, 95 and 2 to 4 files, made here record by record: LibreOffice reads each the same as Grid, which proves the files are what the format says. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readXls } from '../src/js/core/formats/xls.js';
import { writeCfb } from '../src/js/core/formats/cfb.js';
import { readOds } from '../src/js/core/formats/ods.js';
import { decodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

class B {
  constructor() { this.list = []; }
  u8(v) { this.list.push(v & 0xff); return this; }
  u16(v) { this.list.push(v & 0xff, (v >> 8) & 0xff); return this; }
  i16(v) { return this.u16(v & 0xffff); }
  u32(v) { this.list.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.list.push(...b); return this; }
  latin(text) { for (const ch of text) this.list.push(ch === '€' ? 0x80 : ch.charCodeAt(0)); return this; }
  str8(text) { return this.u8(text.length).latin(text); }
  str16(text) { return this.u16(text.length).latin(text); }
  add(bytes) { this.list.push(...bytes); return this; }
}
const record = (type, body) => new B().u16(type).u16(body.list.length).add(body.list).list;
const STRING_RESULT = [0, 0, 0, 0, 0, 0, 0xff, 0xff];

/** An Excel 95 workbook: two sheets, looks, a code page, and formulas of every kind of reference. */
function excel95() {
  const sheet1 = [];
  const cell = (row, col, xf) => new B().u16(row).u16(col).u16(xf);
  sheet1.push(record(0x0809, new B().u16(0x0500).u16(0x0010).u16(0x0dbb).u16(0x07cc)));
  sheet1.push(record(0x0200, new B().u16(0).u16(5).u16(0).u16(3).u16(0)));
  sheet1.push(record(0x007d, new B().u16(0).u16(0).u16(Math.round(30 * 256)).u16(15).u16(0).u8(0)));
  sheet1.push(record(0x0203, cell(0, 0, 15).f64(3)));
  sheet1.push(record(0x027e, cell(1, 0, 15).u32((Math.round(4.5 * 100) << 2) | 3)));
  sheet1.push(record(0x0203, cell(2, 0, 17).f64(-7)));
  sheet1.push(record(0x0204, cell(0, 1, 16).str16('città €')));
  sheet1.push(record(0x0205, cell(1, 1, 15).u8(1).u8(0)));
  const formula = (row, col, result, tokens) => record(0x0006, cell(row, col, 15).add(result).u16(0).u32(0).u16(tokens.list.length).add(tokens.list));
  const num = (v) => new B().f64(v).list;
  sheet1.push(formula(3, 0, num(14), new B().u8(0x25).u16(0xc000).u16(0xc002).u8(0).u8(0).u8(0x22).u8(1).u16(4).u8(0x1e).u16(2).u8(0x05)));
  sheet1.push(formula(3, 1, STRING_RESULT, new B().u8(0x44).u16(0xc000).u8(0).u8(0x1e).u16(2).u8(0x0d).u8(0x17).str8('big').u8(0x17).str8('small').u8(0x42).u8(3).u16(1)));
  sheet1.push(record(0x0207, new B().str16('big')));
  sheet1.push(formula(3, 2, num(42), new B().u8(0x5a).i16(-2).add([0, 0, 0, 0, 0, 0, 0, 0]).i16(1).i16(1).u16(0xc001).u8(1).u8(0x1e).u16(1).u8(0x03)));
  sheet1.push(formula(4, 0, num(3.8), new B().u8(0x25).u16(0x0000).u16(0xc001).u8(0).u8(0).u8(0x22).u8(1).u16(5).u8(0x1e).u16(1).u8(0x41).u16(27)));
  sheet1.push(record(0x000a, new B()));
  const sheet2 = [
    record(0x0809, new B().u16(0x0500).u16(0x0010).u16(0x0dbb).u16(0x07cc)),
    record(0x0203, cell(1, 1, 15).f64(41)),
    record(0x0204, cell(0, 0, 15).str16('here')),
    record(0x000a, new B()),
  ];
  const font = (bold) => record(0x0031, new B().u16(200).u16(0).u16(0x7fff).u16(bold ? 700 : 400).u16(0).u8(0).u8(0).u8(0).u8(0).str8('Arial'));
  const xf = (fontIndex, format, type) => record(0x00e0, new B().u16(fontIndex).u16(format).u16(type).u8(0x20).u8(0).u32(0x20c0).u32(0));
  const globals = (offsets) => {
    const parts = [record(0x0809, new B().u16(0x0500).u16(0x0005).u16(0x0dbb).u16(0x07cc)), record(0x0042, new B().u16(1252))];
    for (let i = 0; i < 4; i += 1) parts.push(font(false));
    parts.push(font(true));
    parts.push(record(0x041e, new B().u16(164).str8('#,##0.000')));
    for (let i = 0; i < 15; i += 1) parts.push(xf(0, 0, 0xfff5));
    parts.push(xf(0, 0, 0x0001));
    parts.push(xf(5, 0, 0x0001));
    parts.push(xf(0, 164, 0x0001));
    parts.push(record(0x0016, new B().u16(2)));
    parts.push(record(0x0017, new B().u8(6).u8(3).latin('First')));
    parts.push(record(0x0017, new B().u8(7).u8(3).latin('Second')));
    parts.push(record(0x0085, new B().u32(offsets[0]).u8(0).u8(0).str8('First')));
    parts.push(record(0x0085, new B().u32(offsets[1]).u8(0).u8(0).str8('Second')));
    parts.push(record(0x000a, new B()));
    return parts.flat();
  };
  const size = (parts) => parts.flat().length;
  const length = globals([0, 0]).length;
  const book = [...globals([length, length + size(sheet1)]), ...sheet1.flat(), ...sheet2.flat()];
  return writeCfb(new Map([['Book', Uint8Array.from(book)]]));
}

/** An Excel 4 worksheet and an Excel 2 one: values, text, a truth value and a formula's result. */
function excel4() {
  const cell = (row, col) => new B().u16(row).u16(col).u16(15);
  return Uint8Array.from([
    ...record(0x0409, new B().u16(0).u16(0x0010).u16(0)),
    ...record(0x0203, cell(0, 0).f64(3)),
    ...record(0x0204, cell(0, 1).str16('città')),
    ...record(0x0205, cell(1, 1).u8(1).u8(0)),
    ...record(0x027e, cell(1, 0).u32((45 << 2) | 2)),
    ...record(0x0406, cell(2, 0).f64(48).u16(0).u16(7).u8(0x44).u16(0xc000).u8(0).u8(0x44).u16(0xc001).u8(0).u8(0x03)),
    ...record(0x000a, new B()),
  ]);
}

function excel2() {
  const cell = (row, col) => new B().u16(row).u16(col).u8(0).u8(0).u8(0);
  return Uint8Array.from([
    ...record(0x0009, new B().u16(2).u16(0x0010)),
    ...record(0x0003, cell(0, 0).f64(2.5)),
    ...record(0x0002, cell(1, 0).u16(7)),
    ...record(0x0004, cell(0, 1).str8('vecchio')),
    ...record(0x000a, new B()),
  ]);
}

function check95(doc) {
  const model = new GridModel(doc);
  new SheetController(model, { onChange: () => {} }).engine.recalculateAll();
  const s = model.sheets[0];
  expect(model.sheets.map((x) => x.name)).toEqual(['First', 'Second']);
  expect(s.valueAt(0, 0)).toBe(3);
  expect(s.valueAt(1, 0)).toBe(4.5);
  expect(s.valueAt(0, 1)).toBe('città €');
  expect(s.valueAt(1, 1)).toBe(true);
  expect(s.formulaAt(3, 0)).toBe('=SUM(A1:A3)*2');
  expect(s.valueAt(3, 0)).toBe(1);
  expect(s.formulaAt(3, 1)).toBe('=IF(A1>2,"big","small")');
  expect(s.valueAt(3, 1)).toBe('big');
  expect(s.formulaAt(3, 2)).toBe('=Second!B2+1');
  expect(s.valueAt(3, 2)).toBe(42);
  expect(s.formulaAt(4, 0)).toBe('=ROUND(AVERAGE($A$1:A2),1)');
  expect(s.valueAt(4, 0)).toBe(3.8);
  expect(model.sheets[1].valueAt(0, 0)).toBe('here');
  expect(doc.styles[doc.sheets[0].cells['0,1'].s]).toMatchObject({ bold: true });
  expect(doc.styles[doc.sheets[0].cells['2,0'].s]).toMatchObject({ format: '#,##0.000' });
}

describe('Excel 5 and older', () => {
  it('Excel 95: values, code page text, looks and formulas of every kind of reference', () => {
    const { document, losses } = readXls(excel95());
    check95(document);
    expect(losses.lines().join()).toMatch(/Excel 5 and 95/);
  });

  it('Excel 4 and 2 worksheets: their values, formulas kept as values', () => {
    const four = readXls(excel4());
    expect(four.document.sheets[0].cells).toMatchObject({ '0,0': { v: 3 }, '0,1': { v: 'città' }, '1,1': { v: true }, '1,0': { v: 45 }, '2,0': { v: 48 } });
    expect(four.losses.lines().join()).toMatch(/kept as their values/);
    const two = readXls(excel2());
    expect(two.document.sheets[0].cells).toMatchObject({ '0,0': { v: 2.5 }, '1,0': { v: 7 }, '0,1': { v: 'vecchio' } });
  });

  it('refuse damaged ones quickly, with an error and nothing else', () => {
    for (const good of [excel95(), excel4(), excel2()]) {
      let seed = 3;
      const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      for (let n = 0; n < 200; n += 1) {
        const bad = good.slice();
        for (let k = 0; k < 10; k += 1) bad[Math.floor(random() * bad.length)] = Math.floor(random() * 256);
        try { readXls(bad); } catch (error) { expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(RangeError); }
      }
    }
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Excel 5 and older', () => {
  it('reads the Excel 95 workbook made here as Grid does', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'old95.xls');
      writeFileSync(file, excel95());
      const back = readOds(decodeBlock(readBlock(convert(file, 'ods', join(dir, 'ods'))))).document;
      const model = new GridModel(back);
      new SheetController(model, { onChange: () => {} }).engine.recalculateAll();
      const s = model.sheets[0];
      expect(model.sheets.map((x) => x.name)).toEqual(['First', 'Second']);
      expect(s.valueAt(0, 1)).toBe('città €');
      expect(s.formulaAt(3, 0)).toBe('=SUM(A1:A3)*2');
      expect(s.formulaAt(3, 1)).toBe('=IF(A1>2,"big","small")');
      expect(s.formulaAt(3, 2)).toBe('=Second!B2+1');
      expect(s.formulaAt(4, 0)).toBe('=ROUND(AVERAGE($A$1:A2),1)');
      expect(s.valueAt(3, 2)).toBe(42);
      expect(back.styles[back.sheets[0].cells['0,1'].s]).toMatchObject({ bold: true });
    } finally { cleanup(dir); }
  }, 120000);

  it('reads the Excel 4 and 2 worksheets made here as Grid does', () => {
    const dir = scratch();
    try {
      // The formula's tokens are left to LibreOffice: Grid keeps Excel 4's formulas as their values.
      for (const [name, bytes, want] of [['old4.xls', excel4(), { '0,0': 3, '0,1': 'città', '1,0': 45 }], ['old2.xls', excel2(), { '0,0': 2.5, '1,0': 7, '0,1': 'vecchio' }]]) {
        writeFileSync(join(dir, name), bytes);
        const back = readOds(decodeBlock(readBlock(convert(join(dir, name), 'ods', join(dir, 'ods'))))).document;
        for (const [key, v] of Object.entries(want)) expect(back.sheets[0].cells[key]?.v).toBe(v);
      }
    } finally { cleanup(dir); }
  }, 120000);
});
