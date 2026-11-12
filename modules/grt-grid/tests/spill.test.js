/** Formulas that give a block: it spills into the cells beside, and steps back when they are taken. */

import { describe, it, expect } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { Engine } from '../src/js/engine/recalc.js';
import { SheetController } from '../src/js/controller.js';

function sheet(cells) {
  const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells }] });
  const engine = new Engine(model);
  engine.recalculateAll();
  return { model, engine, id: model.sheet.id, at: (r, c) => model.sheet.valueAt(r, c) };
}

describe('a formula that gives a block', () => {
  it('spills into the cells below and beside it', () => {
    const { at } = sheet({ '0,0': { f: '=SEQUENCE(3,2)' } });
    expect([at(0, 0), at(0, 1), at(1, 0), at(2, 1)]).toEqual([1, 2, 3, 6]);
    expect(at(3, 0)).toBeNull();
  });

  it('says #SPILL! when a cell in the way is taken, and spills again once it is free', () => {
    const { engine, id, at } = sheet({ '0,0': { f: '=SEQUENCE(3)' } });
    engine.setValue(id, 2, 0, 'mine');
    expect(at(0, 0)).toBe('#SPILL!');
    expect(at(1, 0)).toBeNull();
    expect(at(2, 0)).toBe('mine');
    engine.clear(id, 2, 0);
    expect([at(0, 0), at(1, 0), at(2, 0)]).toEqual([1, 2, 3]);
  });

  it('is read whole by A1#, and by formulas that point into it', () => {
    const { engine, id, at } = sheet({
      '0,0': { v: 5 }, '1,0': { v: 2 }, '2,0': { v: 9 },
      '0,2': { f: '=SORT(A1:A3)' }, '0,4': { f: '=SUM(C1#)' }, '0,5': { f: '=C3*10' },
    });
    expect([at(0, 2), at(1, 2), at(2, 2)]).toEqual([2, 5, 9]);
    expect(at(0, 4)).toBe(16);
    expect(at(0, 5)).toBe(90);
    engine.setValue(id, 2, 0, 1);
    expect([at(0, 2), at(2, 2)]).toEqual([1, 5]);
    expect(at(0, 4)).toBe(8);
    expect(at(0, 5)).toBe(50);
  });

  it('runs again when the document opens, since spills are not saved', () => {
    const first = sheet({ '0,0': { f: '=SEQUENCE(2)' } });
    const saved = first.model.toJSON();
    expect(saved.sheets[0].cells['1,0']).toBeUndefined();
    const again = new GridModel(saved);
    new Engine(again);
    expect(again.sheet.valueAt(1, 0)).toBe(2);
  });
});

describe('names, LET and whole columns', () => {
  it('reads a defined name, and follows it when it changes', () => {
    const { engine, at } = sheet({ '0,0': { v: 4 }, '1,0': { v: 6 }, '0,1': { f: '=SUM(Prices)*Rate' } });
    engine.setName('Prices', '=S!$A$1:$A$2');
    engine.setName('Rate', '=2');
    expect(at(0, 1)).toBe(20);
    engine.setName('Rate', '=3');
    expect(at(0, 1)).toBe(30);
    engine.setName('Rate', '');
    expect(at(0, 1)).toBe('#NAME?');
  });

  it('binds names with LET, and sums a whole column up to its last value', () => {
    const { at } = sheet({ '0,0': { v: 1 }, '5000,0': { v: 2 }, '0,1': { f: '=LET(x,SUM(A:A),y,x*2,x+y)' } });
    expect(at(0, 1)).toBe(9);
  });

  it('keeps an argument left out empty', () => {
    const { at } = sheet({ '0,0': { f: '=IF(TRUE(),,5)' }, '1,0': { f: '=IF(FALSE(),,5)' } });
    expect([at(0, 0), at(1, 0)]).toEqual([0, 5]);
  });
});

describe('a formula read from LibreOffice or an older Excel', () => {
  const cells = { '0,0': { v: 1 }, '1,0': { v: 2 }, '2,0': { v: 3 } };

  it('takes the value on its own row instead of spilling', () => {
    const { at } = sheet({ ...cells, '1,1': { f: '=A1:A3*10', i: 1 }, '1,2': { f: '=A1:A3*10' } });
    expect(at(1, 1)).toBe(20);
    expect(at(2, 1) ?? null).toBe(null);
    expect(at(1, 2)).toBe(10);
    expect(at(2, 2)).toBe(20);
  });

  it('carries the row through functions that work value by value', () => {
    const { at } = sheet({ ...cells, '2,1': { f: '=IF(COUNTIF(A1:A2,A1:A3),"",A1:A3)', i: 1 } });
    expect(at(2, 1)).toBe(3);
  });

  it('gives #VALUE! on a row the range does not reach, and the first value of a block from no range', () => {
    const { at } = sheet({ ...cells, '5,1': { f: '=A1:A3', i: 1 }, '5,2': { f: '=SEQUENCE(3)', i: 1 } });
    expect(at(5, 1)).toBe('#VALUE!');
    expect(at(5, 2)).toBe(1);
  });

  it('reads Excel 365\'s @, which its files keep as SINGLE', () => {
    const { at } = sheet({ ...cells, '2,3': { f: '=SINGLE(A1:A3)+1' } });
    expect(at(2, 3)).toBe(4);
  });

  it('stays so when it is filled down', () => {
    const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells: { ...cells, '0,1': { f: '=A1:A3*10', i: 1 } } }] });
    const grid = new SheetController(model);
    grid.selectRange(0, 1, 2, 1);
    grid.fillDown();
    expect([0, 1, 2].map((r) => model.sheet.valueAt(r, 1))).toEqual([10, 20, 30]);
    expect(model.sheet.cell(2, 1).i).toBe(1);
  });
});
