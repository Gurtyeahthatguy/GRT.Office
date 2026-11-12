/** Goal Seek and Solver, alone and on a sheet. */

import { describe, it, expect } from 'vitest';
import { seekGoal, simplex, solveLinear, evolve, linearise } from '../src/js/whatif.js';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

describe('Goal Seek', () => {
  it('finds a root by secant steps', () => {
    const r = seekGoal((x) => x * x, 1, 2);
    expect(r.found).toBe(true);
    expect(r.x).toBeCloseTo(Math.SQRT2, 9);
  });

  it('finds one across a flat start and errors on one side', () => {
    const r = seekGoal((x) => (x <= 0 ? null : Math.log(x)), 5, -3);
    expect(r.found).toBe(true);
    expect(r.x).toBeCloseTo(Math.exp(-3), 9);
  });

  it('says so when no value reaches the target, and gives the closest', () => {
    const r = seekGoal((x) => x * x + 1, 3, 0);
    expect(r.found).toBe(false);
    expect(Math.abs(r.x)).toBeLessThan(1e-3);
  });

  it('stops at a jump with no root', () => {
    const r = seekGoal((x) => (x < 1 ? -1 : 1), 0, 0);
    expect(r.found).toBe(false);
  });
});

describe('the linear method', () => {
  it('solves the textbook model', () => {
    // max 3x + 5y; x <= 4; 2y <= 12; 3x + 2y <= 18 → x 2, y 6, 36.
    const r = simplex([3, 5], [{ a: [1, 0], op: '<=', b: 4 }, { a: [0, 2], op: '<=', b: 12 }, { a: [3, 2], op: '<=', b: 18 }]);
    expect(r.status).toBe('optimal');
    expect(r.x[0]).toBeCloseTo(2);
    expect(r.x[1]).toBeCloseTo(6);
    expect(r.value).toBeCloseTo(36);
  });

  it('handles equalities, at-least rows and no answer', () => {
    // min x + y with x + y >= 3, x - y = 1 → x 2, y 1.
    const r = simplex([-1, -1], [{ a: [1, 1], op: '>=', b: 3 }, { a: [1, -1], op: '=', b: 1 }]);
    expect(r.x[0]).toBeCloseTo(2);
    expect(r.x[1]).toBeCloseTo(1);
    expect(simplex([1], [{ a: [1], op: '<=', b: 1 }, { a: [1], op: '>=', b: 2 }]).status).toBe('infeasible');
    expect(simplex([1, 1], [{ a: [1, -1], op: '<=', b: 1 }]).status).toBe('unbounded');
  });

  it('lets variables go below zero unless told not to', () => {
    // min x with x >= -5.
    expect(solveLinear({ c: [-1], rows: [{ a: [1], op: '>=', b: -5 }] }).x[0]).toBeCloseTo(-5);
    expect(solveLinear({ c: [-1], rows: [{ a: [1], op: '>=', b: -5 }], nonNegative: true }).x[0]).toBeCloseTo(0);
  });

  it('branches on integers and keeps binaries to 0 and 1', () => {
    // max 5x + 4y; 6x + 4y <= 24; x + 2y <= 6; integers → 20 at (4, 0) or (2, 2)... the optimum is 20.
    const r = solveLinear({ c: [5, 4], rows: [{ a: [6, 4], op: '<=', b: 24 }, { a: [1, 2], op: '<=', b: 6 }], nonNegative: true, integers: new Set([0, 1]) });
    expect(r.status).toBe('optimal');
    expect(r.value).toBeCloseTo(20);
    expect(r.x.every((v) => Number.isInteger(v))).toBe(true);
    // Knapsack: weights 5, 4, 3 under 7, values 10, 7, 6 → the last two, 13.
    const k = solveLinear({ c: [10, 7, 6], rows: [{ a: [5, 4, 3], op: '<=', b: 7 }], binaries: new Set([0, 1, 2]) });
    expect(k.x).toEqual([0, 1, 1]);
  });

  it('knows a model that is not linear', () => {
    const f = (x) => ({ objective: x[0] * x[0], lhs: [] });
    expect(linearise(f, [1], 0)).toBe(null);
    expect(linearise((x) => ({ objective: 2 * x[0] + 3, lhs: [x[0] - x[1]] }), [1, 1], 1)).toEqual({
      objective: { a: [2, 0], b: 3 }, rows: [{ a: [1, -1], b: 0 }],
    });
  });
});

describe('the method for other models', () => {
  it('finds the bottom of a valley under a limit', () => {
    // min (x-3)² + (y+1)² with x <= 2 → (2, -1).
    const r = evolve({
      start: [0, 0],
      measure: ([x, y]) => ({ score: (x - 3) ** 2 + (y + 1) ** 2, violation: Math.max(0, x - 2) }),
    }, { evaluations: 20000 });
    expect(r.feasible).toBe(true);
    expect(r.x[0]).toBeCloseTo(2, 4);
    expect(r.x[1]).toBeCloseTo(-1, 4);
  });
});

describe('on a sheet', () => {
  function sheetWith(cells) {
    const model = new GridModel();
    const sheet = new SheetController(model);
    for (const [ref, text] of Object.entries(cells)) {
      const col = ref.charCodeAt(0) - 65;
      const row = Number(ref.slice(1)) - 1;
      sheet.setCell(row, col, text);
    }
    return { model, sheet };
  }

  it('Goal Seek leaves the cells as they were until the answer is kept', () => {
    const { model, sheet } = sheetWith({ A1: '10', B1: '=A1*A1+A1' });
    model.dirty = false;
    const r = sheet.goalSeek({ formula: { row: 0, col: 1 }, variable: { row: 0, col: 0 }, target: 12 });
    expect(r.found).toBe(true);
    expect(r.x).toBeCloseTo(3, 9);
    expect(model.sheet.valueAt(0, 0)).toBe(10);
    expect(model.sheet.valueAt(0, 1)).toBe(110);
    expect(model.dirty).toBe(false);
    sheet.keepValues([{ row: 0, col: 0, value: r.x }]);
    expect(model.sheet.valueAt(0, 1)).toBeCloseTo(12, 9);
    sheet.step(-1);
    expect(model.sheet.valueAt(0, 0)).toBe(10);
  });

  it('Goal Seek refuses a variable cell with a formula', () => {
    const { sheet } = sheetWith({ A1: '=1', B1: '=A1*2' });
    expect(sheet.goalSeek({ formula: { row: 0, col: 1 }, variable: { row: 0, col: 0 }, target: 4 }).error).toMatch(/value/);
  });

  it('Solver plans a production as a linear model', () => {
    // A1, B1 made; C1 profit; D1 and E1 the two resources.
    const { sheet, model } = sheetWith({ A1: '0', B1: '0', C1: '=3*A1+5*B1', D1: '=2*B1', E1: '=3*A1+2*B1' });
    const r = sheet.solve({
      objective: { row: 0, col: 2 }, goal: 'max', variables: [{ row: 0, col: 0 }, { row: 0, col: 1 }], nonNegative: true,
      constraints: [{ cell: { row: 0, col: 0 }, op: '<=', rhs: 4 }, { cell: { row: 0, col: 3 }, op: '<=', rhs: 12 }, { cell: { row: 0, col: 4 }, op: '<=', rhs: 18 }],
    });
    expect(r.method).toBe('linear');
    expect(r.status).toBe('optimal');
    expect(r.objective).toBeCloseTo(36);
    expect(model.sheet.valueAt(0, 2)).toBe(0);
  });

  it('Solver falls back to the other method for a curve', () => {
    const { sheet } = sheetWith({ A1: '1', B1: '=(A1-4)^2+2' });
    const r = sheet.solve({ objective: { row: 0, col: 1 }, goal: 'min', variables: [{ row: 0, col: 0 }], constraints: [], seconds: 5 });
    expect(r.method).toBe('nonlinear');
    expect(r.x[0]).toBeCloseTo(4, 3);
    expect(r.objective).toBeCloseTo(2, 6);
  });

  it('Solver reaches a value and keeps integer conditions', () => {
    const { sheet } = sheetWith({ A1: '0', B1: '0', C1: '=A1*7+B1*3' });
    const r = sheet.solve({
      objective: { row: 0, col: 2 }, goal: 'value', target: 20, variables: [{ row: 0, col: 0 }, { row: 0, col: 1 }], nonNegative: true,
      constraints: [{ cell: { row: 0, col: 0 }, op: 'int' }, { cell: { row: 0, col: 1 }, op: 'int' }],
    });
    expect(r.status).toBe('optimal');
    expect(r.x[0] * 7 + r.x[1] * 3).toBe(20);
    expect(r.x).toEqual([2, 2]);
  });
});

describe('case changes on cells', () => {
  it('change text, leave numbers and formulas', () => {
    const model = new GridModel();
    const sheet = new SheetController(model);
    sheet.setCell(0, 0, 'hello world');
    sheet.setCell(1, 0, '12');
    sheet.setCell(2, 0, '="abc"');
    sheet.select(0, 0);
    sheet.select(2, 0, { extend: true });
    sheet.changeTextCase((t) => t.toUpperCase());
    expect(model.sheet.valueAt(0, 0)).toBe('HELLO WORLD');
    expect(model.sheet.valueAt(1, 0)).toBe(12);
    expect(model.sheet.formulaAt(2, 0)).toBe('="abc"');
    sheet.step(-1);
    expect(model.sheet.valueAt(0, 0)).toBe('hello world');
  });
});
