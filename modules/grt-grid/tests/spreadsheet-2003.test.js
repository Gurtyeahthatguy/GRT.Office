// @vitest-environment jsdom

/** Excel 2003 XML workbooks: formulas between R1C1 and A1, what Grid writes comes back, and LibreOffice agrees both ways. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readSpreadsheet2003, writeSpreadsheet2003, r1c1ToA1, a1ToR1c1 } from '../src/js/core/formats/spreadsheet-2003.js';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

function workbook() {
  const model = new GridModel({
    version: 1,
    styles: { money: { format: '#,##0.00', bold: true, color: '#c00000' }, framed: { borders: { top: { width: 1, color: '#000000' }, bottom: { width: 2, color: '#0000ff' } }, bg: '#ffff00', align: 'center', wrap: true } },
    sheets: [
      { id: 'a', name: 'First', cells: {
        '0,0': { v: 3 }, '1,0': { v: 4.5 }, '2,0': { v: -7, s: 'money' }, '3,0': { f: '=SUM(A1:A3)*2' }, '4,0': { f: '=IF(A1>2,"big","small")' },
        '0,1': { v: 'città & <co>' }, '1,1': { v: true }, '2,1': { v: '#N/A' }, '4,1': { f: "='Second sheet'!B2+1" },
        '5,0': { f: '=ROUND(AVERAGE($A$1:A2),1)' }, '6,0': { v: 45000, s: 'framed', n: 'A note' }, '7,0': { f: '=VLOOKUP(3,A1:B3,2,FALSE)' },
      }, cols: { 0: { w: 140 } }, rows: { 2: { h: 40 } }, merges: [{ top: 8, bottom: 9, left: 0, right: 2 }], frozen: { rows: 1, cols: 0 } },
      { id: 'b', name: 'Second sheet', cells: { '1,1': { v: 41 }, '0,0': { v: 'here' } }, hidden: true },
    ],
  });
  new SheetController(model, { onChange: () => {} }).engine.recalculateAll();
  return model;
}

function check(doc, { booleans = true, frozen = true, heights = true, hidden = true, notes = true, format = '#,##0.00' } = {}) {
  const back = new GridModel(doc);
  new SheetController(back, { onChange: () => {} }).engine.recalculateAll();
  const s = back.sheets[0];
  expect(back.sheets.map((x) => x.name)).toEqual(['First', 'Second sheet']);
  expect(s.valueAt(0, 0)).toBe(3);
  expect(s.valueAt(3, 0)).toBe(1);
  expect(s.formulaAt(3, 0)).toBe('=SUM(A1:A3)*2');
  expect(s.valueAt(4, 0)).toBe('big');
  expect(s.valueAt(0, 1)).toBe('città & <co>');
  if (booleans) expect(s.valueAt(1, 1)).toBe(true);
  expect(s.valueAt(4, 1)).toBe(42);
  expect(s.formulaAt(4, 1)).toBe("='Second sheet'!B2+1");
  expect(s.formulaAt(5, 0)).toBe('=ROUND(AVERAGE($A$1:A2),1)');
  expect(s.valueAt(5, 0)).toBe(3.8);
  expect(s.valueAt(7, 0)).toBe('città & <co>');
  expect(doc.sheets[0].merges).toEqual([{ top: 8, bottom: 9, left: 0, right: 2 }]);
  expect(Math.abs((doc.sheets[0].cols[0]?.w ?? 0) - 140)).toBeLessThanOrEqual(4);
  if (heights) expect(Math.abs((doc.sheets[0].rows[2]?.h ?? 0) - 40)).toBeLessThanOrEqual(2);
  if (frozen) expect(doc.sheets[0].frozen).toEqual({ rows: 1, cols: 0 });
  if (hidden) expect(doc.sheets[1].hidden).toBe(true);
  if (notes) expect(doc.sheets[0].cells['6,0'].n).toBe('A note');
  const money = doc.styles[doc.sheets[0].cells['2,0'].s];
  expect(money).toMatchObject({ format, bold: true, color: '#c00000' });
  const framed = doc.styles[doc.sheets[0].cells['6,0'].s];
  expect(framed).toMatchObject({ bg: '#ffff00', align: 'center', wrap: true });
  expect(framed.borders.bottom.width).toBe(2);
}

describe('Excel 2003 XML workbooks', () => {
  it('turn R1C1 references into A1 and back, relative and absolute, past strings and sheet names', () => {
    expect(r1c1ToA1('=R[-1]C+RC[1]*R1C1', 4, 2)).toBe('=C4+D5*$A$1');
    expect(r1c1ToA1('=SUM(R[-3]C:R[-1]C)&"R1C1"&\'R2C2\'!R2C2', 3, 0)).toBe('=SUM(A1:A3)&"R1C1"&\'R2C2\'!$B$2');
    expect(r1c1ToA1('=ROUND(RC[-1],2)+SUM(C[1]:C[1])+SUM(R1:R2)', 0, 1)).toBe('=ROUND(A1,2)+SUM(C:C)+SUM($1:$2)');
    expect(a1ToR1c1('=C4+D5*$A$1', 4, 2)).toBe('=R[-1]C+RC[1]*R1C1');
    expect(a1ToR1c1('=SUM(A1:A3)&"A1"', 3, 0)).toBe('=SUM(R[-3]C:R[-1]C)&"A1"');
    expect(a1ToR1c1('=TEXTJOIN(",",TRUE,B1:B2)', 0, 0)).toBe('=TEXTJOIN(",",TRUE,RC[1]:R[1]C[1])');
  });

  it('come back as Grid wrote them', () => {
    const { text, losses } = writeSpreadsheet2003(workbook().exportJSON());
    expect(losses.empty).toBe(true);
    check(readSpreadsheet2003(text).document);
  });

  it('refuse what is not one, and entities, with an error', () => {
    expect(() => readSpreadsheet2003('<?xml version="1.0"?><x/>')).toThrow(/not an Excel 2003/);
    expect(() => readSpreadsheet2003('<!DOCTYPE x [<!ENTITY a "b">]><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"/>')).toThrow(/entities/);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Excel 2003 XML workbooks', () => {
  it('reads what Grid writes as Grid wrote it', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'grid.xml');
      writeFileSync(file, writeSpreadsheet2003(workbook().exportJSON()).text);
      const ods = convert(file, 'ods', join(dir, 'ods'));
      // LibreOffice's import drops Boolean cells, which Excel writes as 1 and 0, takes every row height as optimal, shows hidden sheets and no frozen panes, and leaves comments out.
      check(readOds(decodeBlock(readBlock(ods))).document, { booleans: false, heights: false, hidden: false, frozen: false, notes: false });
    } finally { cleanup(dir); }
  }, 120000);

  it('writes what Grid reads', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'grid.ods');
      writeBlock(encodeBlock(writeOds(workbook().exportJSON()).entries), file);
      const xml = convert(file, 'xml:MS Excel 2003 XML', join(dir, 'xml'));
      // LibreOffice's export writes neither frozen panes nor hidden sheets, and names #,##0.00 Fixed, which Excel reads as 0.00.
      check(readSpreadsheet2003(readFileSync(xml, 'utf8')).document, { frozen: false, hidden: false, format: '0.00' });
    } finally { cleanup(dir); }
  }, 120000);
});
