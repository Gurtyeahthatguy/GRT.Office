/** Paste special, random numbers and the ways of showing a sheet. */

import { describe, it, expect } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

function setup() {
  const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells: {
    '0,0': { v: 'name', s: 'bold' }, '0,1': { v: 2 }, '0,2': { f: '=B1*10' },
    '1,0': { v: 'other' }, '1,1': { v: 3 },
  } }], styles: { bold: { bold: true } } });
  const sheet = new SheetController(model, { onChange: () => {} });
  sheet.selectRange(0, 0, 1, 2);
  const copied = sheet.copy();
  return { model, sheet, copied, at: (r, c) => model.sheet.cell(r, c) };
}

describe('paste special', () => {
  it('pastes only text, only numbers or only formulas', () => {
    const { sheet, copied, at } = setup();
    sheet.selectRange(5, 0, 5, 0);
    sheet.pasteSpecial(copied, { numbers: false, formulas: false, formats: false });
    expect(at(5, 0).v).toBe('name');
    expect(at(5, 0).s).toBeUndefined();
    expect(at(5, 1)).toBeFalsy();
    sheet.pasteSpecial(copied, { text: false, formulas: false });
    expect(at(5, 1).v).toBe(2);
    sheet.pasteSpecial(copied, { text: false, numbers: false });
    expect(at(5, 2).f).toBe('=B6*10');
    expect(sheet.sheet.valueAt(5, 2)).toBe(20);
  });

  it('turns the block on its side, its formulas following', () => {
    const { sheet, copied, at } = setup();
    sheet.selectRange(10, 0, 10, 0);
    sheet.pasteSpecial(copied, { transpose: true });
    expect(at(10, 0).v).toBe('name');
    expect(at(11, 0).v).toBe(2);
    expect(at(10, 1).v).toBe('other');
    expect(at(12, 0).f).toBe('=A12*10');
  });

  it('adds to the numbers already there, and skips empty cells', () => {
    const { model, sheet, at } = setup();
    model.sheet.set(20, 0, { v: 5 });
    model.sheet.set(21, 0, { v: 9 });
    sheet.engine.rebuild();
    sheet.selectRange(0, 1, 2, 1);
    const block = sheet.copy();
    sheet.selectRange(20, 0, 20, 0);
    sheet.pasteSpecial(block, { operation: 'add', skipEmpty: true });
    expect(at(20, 0).v).toBe(7);
    expect(at(21, 0).v).toBe(12);
    sheet.pasteSpecial(block, { operation: 'divide', text: false });
    expect(at(20, 0).v).toBe(3.5);
  });

  it('is one step to undo', () => {
    const { sheet, copied, at } = setup();
    sheet.selectRange(5, 0, 5, 0);
    sheet.pasteSpecial(copied, { transpose: true });
    sheet.step(-1);
    expect(at(5, 0)).toBeFalsy();
  });
});

describe('random numbers', () => {
  it('fills the selection within the bounds, rounded as asked', () => {
    const { model, sheet } = setup();
    sheet.selectRange(30, 0, 39, 1);
    sheet.fillRandom({ kind: 'integer', a: 1, b: 6 });
    const values = [];
    for (let r = 30; r <= 39; r += 1) for (let c = 0; c <= 1; c += 1) values.push(model.sheet.valueAt(r, c));
    expect(values.every((v) => Number.isInteger(v) && v >= 1 && v <= 6)).toBe(true);
    sheet.fillRandom({ kind: 'uniform', a: 10, b: 0, decimals: 2 }, () => 0.123456);
    expect(model.sheet.valueAt(30, 0)).toBe(1.23);
    sheet.fillRandom({ kind: 'normal', a: 100, b: 0 });
    expect(model.sheet.valueAt(35, 1)).toBe(100);
    expect(sheet.fillRandom({ kind: 'uniform', a: Number.NaN, b: 1 })).toBe(false);
  });
});

describe('ways of showing a sheet', () => {
  it('are turned on and off and are not saved', () => {
    const { model, sheet } = setup();
    sheet.toggleView('formulas');
    sheet.toggleView('gridlines');
    expect(sheet.view).toMatchObject({ formulas: true, gridlines: false });
    sheet.toggleView('nonsense');
    expect(JSON.stringify(model.toJSON())).not.toContain('gridlines');
  });
});
