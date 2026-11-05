/** Conditional formatting and rules on what cells accept. */

import { describe, it, expect } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

function open(values) {
  const cells = {};
  values.forEach((v, r) => { if (v !== null) cells[`${r},0`] = { v }; });
  const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells }] });
  return { model, sheet: new SheetController(model, { onChange: () => {} }) };
}

const AREA = { top: 0, left: 0, bottom: 4, right: 0 };
const RED = { bg: '#ffcccc' };

describe('conditional formatting', () => {
  it('colours cells by comparison, by formula, and stops at the first rule that applies', () => {
    const { sheet } = open([1, 5, 9, 5, null]);
    sheet.addCondition({ area: AREA, type: 'cell', op: '>', values: ['4'], style: RED });
    sheet.addCondition({ area: AREA, type: 'formula', formula: '=MOD(A1,2)=1', style: { bold: true } });
    expect(sheet.conditionalStyleAt(0, 0)).toEqual({ bold: true });
    expect(sheet.conditionalStyleAt(2, 0)).toEqual(RED);
    expect(sheet.conditionalStyleAt(4, 0)).toBeNull();
  });

  it('follows the values as they change', () => {
    const { sheet } = open([1, 2]);
    sheet.addCondition({ area: AREA, type: 'cell', op: 'between', values: ['2', '3'], style: RED });
    expect(sheet.conditionalStyleAt(0, 0)).toBeNull();
    sheet.setCell(0, 0, '3');
    expect(sheet.conditionalStyleAt(0, 0)).toEqual(RED);
  });

  it('marks duplicates, the top values and those above the average', () => {
    const { sheet } = open([3, 7, 3, 10, 1]);
    sheet.addCondition({ area: AREA, type: 'duplicate', style: RED });
    expect([0, 1, 2].map((r) => Boolean(sheet.conditionalStyleAt(r, 0)))).toEqual([true, false, true]);
    sheet.clearConditions(AREA);
    sheet.addCondition({ area: AREA, type: 'top', count: 2, style: RED });
    expect([1, 3, 0].map((r) => Boolean(sheet.conditionalStyleAt(r, 0)))).toEqual([true, true, false]);
    sheet.clearConditions(AREA);
    sheet.addCondition({ area: AREA, type: 'average', style: RED });
    expect([1, 3, 0].map((r) => Boolean(sheet.conditionalStyleAt(r, 0)))).toEqual([true, true, false]);
  });

  it('shades a colour scale and draws data bars', () => {
    const { sheet } = open([0, 5, 10]);
    sheet.addCondition({ area: AREA, type: 'scale', points: [{ type: 'min' }, { type: 'max' }], colors: ['#000000', '#ffffff'] });
    expect(sheet.conditionalStyleAt(1, 0)).toEqual({ bg: '#808080' });
    sheet.clearConditions(AREA);
    sheet.addCondition({ area: AREA, type: 'bar', color: '#0000ff' });
    expect(sheet.conditionalStyleAt(1, 0).bar.fraction).toBeCloseTo(0.5);
  });
});

describe('validity', () => {
  it('refuses a value outside the rule, and says why', () => {
    const changes = [];
    const model = new GridModel();
    const sheet = new SheetController(model, { onChange: (info) => changes.push(info) });
    sheet.setValidation({ type: 'whole', op: 'between', values: ['1', '10'], error: { style: 'stop', message: 'From 1 to 10' } }, AREA);
    sheet.setCell(0, 0, '11');
    expect(model.sheet.valueAt(0, 0)).toBeNull();
    expect(changes.some((c) => c.refused?.message === 'From 1 to 10')).toBe(true);
    sheet.setCell(0, 0, '7');
    expect(model.sheet.valueAt(0, 0)).toBe(7);
  });

  it('offers a list of choices, typed in or read from cells, and only warns when told to', () => {
    const { sheet, model } = open([null, null, 'red', 'green']);
    sheet.setValidation({ type: 'list', source: '=$A$3:$A$4', error: { style: 'warning' } }, { top: 0, left: 1, bottom: 0, right: 1 });
    expect(sheet.choicesAt(0, 1)).toEqual(['red', 'green']);
    sheet.setCell(0, 1, 'blue');
    expect(model.sheet.valueAt(0, 1)).toBe('blue');
    sheet.setValidation({ type: 'list', list: ['yes', 'no'] }, { top: 1, left: 1, bottom: 1, right: 1 });
    sheet.setCell(1, 1, 'maybe');
    expect(model.sheet.valueAt(1, 1)).toBeNull();
  });

  it('keeps conditions and rules when the document is saved', () => {
    const { sheet, model } = open([1]);
    sheet.addCondition({ area: AREA, type: 'cell', op: '>', values: ['0'], style: RED });
    sheet.setValidation({ type: 'decimal', op: '>=', values: ['0'] }, AREA);
    const again = new SheetController(new GridModel(model.toJSON()), { onChange: () => {} });
    expect(again.conditionalStyleAt(0, 0)).toEqual(RED);
    expect(again.validationAt(0, 0).type).toBe('decimal');
  });
});
