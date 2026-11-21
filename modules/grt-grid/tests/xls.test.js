// @vitest-environment jsdom

/** Excel 97 workbooks: what Grid writes comes back, LibreOffice reads it the same, and what LibreOffice writes Grid reads. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readXls, writeXls } from '../src/js/core/formats/xls.js';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readCfb, writeCfb } from '../src/js/core/formats/cfb.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const LONG = 'Ω'.repeat(5000) + 'end';

function workbook() {
  const model = new GridModel({
    version: 1,
    styles: { money: { format: '#,##0.00', bold: true, color: '#c00000' }, framed: { borders: { top: { width: 1, color: '#000000' }, bottom: { width: 2, color: '#0000ff' } }, bg: '#ffff00', align: 'center', wrap: true } },
    sheets: [
      { id: 'a', name: 'First', cells: {
        '0,0': { v: 3 }, '1,0': { v: 4.5 }, '2,0': { v: -7, s: 'money' }, '3,0': { f: '=SUM(A1:A3)*2' }, '4,0': { f: '=IF(A1>2,"big","small")' },
        '0,1': { v: 'città' }, '1,1': { v: true }, '2,1': { v: '#N/A' }, '3,1': { v: LONG }, '4,1': { f: "='Second sheet'!B2+1" },
        '5,0': { f: '=ROUND(AVERAGE(A1:A2),1)' }, '6,0': { v: 45000, s: 'framed' }, '7,0': { f: '=VLOOKUP(3,A1:B3,2,FALSE)' },
      }, cols: { 0: { w: 140 } }, rows: { 2: { h: 40 } }, merges: [{ top: 8, bottom: 9, left: 0, right: 2 }] },
      { id: 'b', name: 'Second sheet', cells: { '1,1': { v: 41 }, '0,0': { v: 'here' } }, hidden: true },
    ],
  });
  new SheetController(model, { onChange: () => {} }).engine.recalculateAll();
  return model;
}

function check(doc, { exactLook = true } = {}) {
  const back = new GridModel(doc);
  new SheetController(back, { onChange: () => {} }).engine.recalculateAll();
  const s = back.sheets[0];
  expect(back.sheets.map((x) => x.name)).toEqual(['First', 'Second sheet']);
  expect(s.valueAt(0, 0)).toBe(3);
  expect(s.valueAt(3, 0)).toBe(1);
  expect(s.formulaAt(3, 0)).toBe('=SUM(A1:A3)*2');
  expect(s.valueAt(4, 0)).toBe('big');
  expect(s.valueAt(0, 1)).toBe('città');
  expect(s.valueAt(1, 1)).toBe(true);
  expect(s.valueAt(3, 1)).toBe(LONG);
  expect(s.valueAt(4, 1)).toBe(42);
  expect(s.formulaAt(4, 1)).toBe("='Second sheet'!B2+1");
  expect(s.valueAt(5, 0)).toBe(3.8);
  expect(s.valueAt(7, 0)).toBe('città');
  expect(doc.sheets[0].merges).toEqual([{ top: 8, bottom: 9, left: 0, right: 2 }]);
  expect(Math.abs((doc.sheets[0].cols[0]?.w ?? 0) - 140)).toBeLessThanOrEqual(4);
  expect(doc.sheets[1].hidden).toBe(true);
  if (exactLook) {
    const money = doc.styles[doc.sheets[0].cells['2,0'].s];
    expect(money).toMatchObject({ format: '#,##0.00', bold: true, color: '#c00000' });
    const framed = doc.styles[doc.sheets[0].cells['6,0'].s];
    expect(framed).toMatchObject({ bg: '#ffff00', align: 'center', wrap: true });
    expect(framed.borders.bottom.width).toBe(2);
  }
}

describe('Excel 97 workbooks', () => {
  it('keep their streams through the compound file, byte for byte', () => {
    const streams = new Map([['Workbook', new Uint8Array(5000).map((_, i) => i % 251)], ['small', Uint8Array.of(1, 2, 3)], ['folder/inside', new Uint8Array(70).fill(9)]]);
    const back = readCfb(writeCfb(streams));
    for (const [name, data] of streams) expect([...back.get(name)]).toEqual([...data]);
  });

  it('come back as Grid wrote them', () => {
    const { bytes, losses } = writeXls(workbook().exportJSON());
    expect(losses.empty).toBe(true);
    check(readXls(bytes).document);
  });

  it('refuse damaged files quickly, with an error and nothing else', () => {
    const good = writeXls(workbook().exportJSON()).bytes;
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const started = Date.now();
    for (let n = 0; n < 300; n += 1) {
      const bad = good.slice();
      for (let k = 0; k < 20; k += 1) bad[Math.floor(random() * bad.length)] = Math.floor(random() * 256);
      try { readXls(bad); } catch (error) { expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(RangeError); }
    }
    expect(Date.now() - started).toBeLessThan(20000);
  });

  it('say what Excel 97 cannot hold', () => {
    const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells: { '0,0': { f: '=TEXTJOIN(",",TRUE,B1:B2)' }, '70000,0': { v: 1 } } }] });
    const { losses } = writeXls(model.exportJSON());
    expect(losses.lines().join('\n')).toMatch(/Excel 97 does not have|Excel 97 cannot hold/);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Excel 97 workbooks', () => {
  it('reads what Grid writes as Grid wrote it', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'grid.xls');
      writeFileSync(file, writeXls(workbook().exportJSON()).bytes);
      const ods = convert(file, 'ods', join(dir, 'ods'));
      check(readOds(decodeBlock(readBlock(ods))).document);
    } finally { cleanup(dir); }
  }, 120000);

  it('writes what Grid reads', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'grid.ods');
      writeBlock(encodeBlock(writeOds(workbook().exportJSON()).entries), file);
      const xls = convert(file, 'xls:MS Excel 97', join(dir, 'xls'));
      check(readXls(new Uint8Array(readFileSync(xls))).document);
    } finally { cleanup(dir); }
  }, 120000);
});
