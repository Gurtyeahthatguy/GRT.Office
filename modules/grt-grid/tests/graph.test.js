/** The most important file in this module. */

import { describe, it, expect, beforeEach } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { Engine } from '../src/js/engine/recalc.js';
import { DependencyGraph, nodeId } from '../src/js/engine/graph.js';

let model;
let engine;
let sheetId;

const value = (row, col) => model.sheet.valueAt(row, col);
const setValue = (row, col, v) => engine.setValue(sheetId, row, col, v);
const setFormula = (row, col, f) => engine.setFormula(sheetId, row, col, f);

beforeEach(() => {
  model = new GridModel();
  engine = new Engine(model);
  sheetId = model.sheet.id;
});

// The graph on its own

describe('the graph itself', () => {
  let graph;
  const id = (row, col) => nodeId('s1', row, col);

  beforeEach(() => { graph = new DependencyGraph(); });

  it('records both directions', () => {
    graph.setDependencies(id(0, 2), { cells: [id(0, 0), id(0, 1)] });
    expect(graph.directDependentsOf(id(0, 0))).toContain(id(0, 2));
    expect(graph.directDependentsOf(id(0, 1))).toContain(id(0, 2));
  });

  it('forgets what a cell used to read when it is given a new formula', () => {
    graph.setDependencies(id(0, 2), { cells: [id(0, 0)] });
    graph.setDependencies(id(0, 2), { cells: [id(0, 1)] });

    expect(graph.directDependentsOf(id(0, 0)).size).toBe(0);
    expect(graph.directDependentsOf(id(0, 1))).toContain(id(0, 2));
  });

  it('finds a dependent through a range without recording every cell', () => {
    graph.setDependencies(id(5, 0), {
      ranges: [{ sheetId: 's1', from: { row: 0, col: 0 }, to: { row: 999, col: 0 } }],
    });

    // One edge, not a thousand.
    expect(graph.rangeWatchers).toHaveLength(1);
    expect(graph.directDependentsOf(id(500, 0))).toContain(id(5, 0));
    expect(graph.directDependentsOf(id(500, 1)).size).toBe(0);
  });

  it('keeps sheets apart', () => {
    graph.setDependencies('s2!0,0', { cells: ['s1!0,0'] });
    expect(graph.directDependentsOf('s1!0,0')).toContain('s2!0,0');
    expect(graph.directDependentsOf('s2!0,0').size).toBe(0);
  });

  it('collects everything downstream, transitively', () => {
    graph.setDependencies(id(0, 1), { cells: [id(0, 0)] });
    graph.setDependencies(id(0, 2), { cells: [id(0, 1)] });
    graph.setDependencies(id(0, 3), { cells: [id(0, 2)] });

    const affected = graph.affectedBy([id(0, 0)]);
    expect([...affected].sort()).toEqual([id(0, 0), id(0, 1), id(0, 2), id(0, 3)].sort());
  });

  it('does not collect what is upstream', () => {
    graph.setDependencies(id(0, 1), { cells: [id(0, 0)] });
    expect(graph.affectedBy([id(0, 1)]).has(id(0, 0))).toBe(false);
  });

  it('orders a chain so each cell comes after what it reads', () => {
    graph.setDependencies(id(0, 1), { cells: [id(0, 0)] });
    graph.setDependencies(id(0, 2), { cells: [id(0, 1)] });

    const { order, cyclic } = graph.topologicalOrder([id(0, 0), id(0, 1), id(0, 2)]);
    expect(cyclic).toEqual([]);
    expect(order.indexOf(id(0, 1))).toBeLessThan(order.indexOf(id(0, 2)));
  });

  it('ignores edges leaving the set, which is what makes it incremental', () => {
    graph.setDependencies(id(0, 1), { cells: [id(0, 0)] });
    const { order } = graph.topologicalOrder([id(0, 1)]);
    expect(order).toEqual([id(0, 1)]);
  });

  it('does not loop for ever on a cycle', () => {
    graph.setDependencies(id(0, 0), { cells: [id(0, 1)] });
    graph.setDependencies(id(0, 1), { cells: [id(0, 0)] });
    expect(() => graph.affectedBy([id(0, 0)])).not.toThrow();
  });
});

// cycles

describe('circular references', () => {
  it('detects a direct cycle and marks both cells', () => {
    setFormula(0, 0, '=B1');
    setFormula(0, 1, '=A1');

    expect(value(0, 0)).toBe('#REF!');
    expect(value(0, 1)).toBe('#REF!');
  });

  it('detects an indirect cycle across three cells', () => {
    setFormula(0, 0, '=B1');
    setFormula(0, 1, '=C1');
    setFormula(0, 2, '=A1');

    expect(value(0, 0)).toBe('#REF!');
    expect(value(0, 1)).toBe('#REF!');
    expect(value(0, 2)).toBe('#REF!');
  });

  it('leaves the rest of the sheet calculating', () => {
    setValue(2, 0, 5);
    setValue(2, 1, 7);
    setFormula(2, 2, '=A3+B3');

    setFormula(0, 0, '=B1');
    setFormula(0, 1, '=A1');

    expect(value(2, 2)).toBe(12);
  });

  it('recovers when the cycle is broken', () => {
    setFormula(0, 0, '=B1');
    setFormula(0, 1, '=A1');
    expect(value(0, 0)).toBe('#REF!');

    setValue(0, 1, 4);
    expect(value(0, 0)).toBe(4);
  });

  it('catches a cell that refers to itself', () => {
    setFormula(0, 0, '=A1+1');
    expect(value(0, 0)).toBe('#REF!');
  });

  it('catches a cycle through a range', () => {
    setFormula(0, 0, '=SUM(A1:A5)');
    expect(value(0, 0)).toBe('#REF!');
  });
});

// only the dependents are recalculated

describe('incremental recalculation', () => {
  beforeEach(() => {
    setValue(0, 0, 1);          // A1.
    setValue(0, 1, 2);          // B1.
    setFormula(1, 0, '=A1*2');  // A2 reads A1.
    setFormula(2, 0, '=A2+1');  // A3 reads A2.
    setFormula(1, 1, '=B1*2');  // B2 reads B1, nothing to do with A.
  });

  it('recalculates the transitive dependents', () => {
    engine.evaluations = 0;
    setValue(0, 0, 10);

    expect(value(1, 0)).toBe(20);
    expect(value(2, 0)).toBe(21);
  });

  it('recalculates ONLY them, counted', () => {
    engine.evaluations = 0;
    setValue(0, 0, 10);

    // A2 and A3, and not B2.
    expect(engine.evaluations).toBe(2);
  });

  it('CANARY: the counter does move, so the assertion above means something', () => {
    engine.evaluations = 0;
    setValue(0, 1, 9);
    expect(engine.evaluations).toBe(1);
    expect(value(1, 1)).toBe(18);
  });

  it('touches nothing when an unrelated blank cell is filled', () => {
    engine.evaluations = 0;
    setValue(50, 50, 'hello');
    expect(engine.evaluations).toBe(0);
  });

  it('evaluates in dependency order, not in the order cells were written', () => {
    // A3 depends on A2, which depends on A1.
    setValue(0, 0, 100);
    expect(value(1, 0)).toBe(200);
    expect(value(2, 0)).toBe(201);
  });

  it('recalculates a range dependent when any cell in the range changes', () => {
    setFormula(5, 0, '=SUM(C1:C10)');
    engine.evaluations = 0;
    setValue(4, 2, 7);
    expect(engine.evaluations).toBe(1);
    expect(value(5, 0)).toBe(7);
  });

  it('does not recalculate a range dependent for a cell outside it', () => {
    setFormula(5, 0, '=SUM(C1:C10)');
    engine.evaluations = 0;
    setValue(20, 2, 7);
    expect(engine.evaluations).toBe(0);
  });
});

// errors travel as values

describe('errors', () => {
  it('propagate to dependents without an exception', () => {
    setValue(0, 0, 1);
    setValue(0, 1, 0);
    setFormula(0, 2, '=A1/B1');
    setFormula(0, 3, '=C1+1');
    setFormula(0, 4, '=D1*2');

    expect(value(0, 2)).toBe('#DIV/0!');
    expect(value(0, 3)).toBe('#DIV/0!');
    expect(value(0, 4)).toBe('#DIV/0!');
  });

  it('clear once the cause is fixed', () => {
    setValue(0, 1, 0);
    setValue(0, 0, 1);
    setFormula(0, 2, '=A1/B1');
    expect(value(0, 2)).toBe('#DIV/0!');

    setValue(0, 1, 2);
    expect(value(0, 2)).toBe(0.5);
  });

  it('a formula that will not parse is a cell error, not a crash', () => {
    expect(() => setFormula(0, 0, '=1+')).not.toThrow();
    expect(value(0, 0)).toBe('#NAME?');
  });

  it('an unknown function name is #NAME?, and the sheet carries on', () => {
    setValue(1, 0, 5);
    setFormula(0, 0, '=NOSUCHFUNCTION(1)');
    setFormula(1, 1, '=A2*2');

    expect(value(0, 0)).toBe('#NAME?');
    expect(value(1, 1)).toBe(10);
  });

  it('keeps the text of a formula that does not parse', () => {
    setFormula(0, 0, '=1+');
    expect(model.sheet.formulaAt(0, 0)).toBe('=1+');
  });
});

// inserting rows

describe('inserting and deleting rows', () => {
  beforeEach(() => {
    setValue(0, 0, 1);            // A1.
    setValue(4, 0, 5);            // A5.
    setFormula(9, 0, '=A1+A5');   // A10, references either side of row 2.
    setFormula(9, 1, '=SUM(A1:A5)'); // B10, a range spanning the insertion point.
  });

  it('moves the cells below the insertion point', () => {
    engine.applyStructuralChange(sheetId, { axis: 'row', at: 2, count: 1 });
    expect(model.sheet.valueAt(0, 0)).toBe(1);
    expect(model.sheet.valueAt(5, 0)).toBe(5);
    expect(model.sheet.valueAt(4, 0)).toBeNull();
  });

  it('rewrites a reference below the insertion point and leaves one above', () => {
    engine.applyStructuralChange(sheetId, { axis: 'row', at: 2, count: 1 });
    expect(model.sheet.formulaAt(10, 0)).toBe('=A1+A6');
  });

  it('grows a range that straddles the insertion point', () => {
    engine.applyStructuralChange(sheetId, { axis: 'row', at: 2, count: 1 });
    expect(model.sheet.formulaAt(10, 1)).toBe('=SUM(A1:A6)');
  });

  it('keeps the answers right afterwards', () => {
    engine.applyStructuralChange(sheetId, { axis: 'row', at: 2, count: 1 });
    expect(model.sheet.valueAt(10, 0)).toBe(6);
    expect(model.sheet.valueAt(10, 1)).toBe(6);
  });

  it('turns a reference to a deleted row into #REF!', () => {
    engine.applyStructuralChange(sheetId, { axis: 'row', at: 4, count: -1 });
    expect(model.sheet.formulaAt(8, 0)).toContain('#REF!');
    expect(model.sheet.valueAt(8, 0)).toBe('#REF!');
  });

  it('shifts references back up after a deletion above them', () => {
    engine.applyStructuralChange(sheetId, { axis: 'row', at: 1, count: -1 });
    expect(model.sheet.formulaAt(8, 0)).toBe('=A1+A4');
  });

  it('does the same for columns', () => {
    const fresh = new GridModel();
    const engine2 = new Engine(fresh);
    const id = fresh.sheet.id;
    engine2.setValue(id, 0, 0, 2);
    engine2.setValue(id, 0, 4, 3);
    engine2.setFormula(id, 0, 9, '=A1*E1');

    engine2.applyStructuralChange(id, { axis: 'col', at: 2, count: 1 });
    expect(fresh.sheet.formulaAt(0, 10)).toBe('=A1*F1');
    expect(fresh.sheet.valueAt(0, 10)).toBe(6);
  });
});

// copying a formula

describe('copying formulas', () => {
  it('translates relative references', () => {
    expect(engine.translateFormula('=A1+B1', 1, 0)).toBe('=A2+B2');
    expect(engine.translateFormula('=A1+B1', 0, 1)).toBe('=B1+C1');
  });

  it('leaves absolute references alone', () => {
    expect(engine.translateFormula('=$A$1+B1', 1, 0)).toBe('=$A$1+B2');
    expect(engine.translateFormula('=$A1+A$1', 1, 1)).toBe('=$A2+B$1');
  });

  it('translates both ends of a range', () => {
    expect(engine.translateFormula('=SUM(A1:A5)', 2, 0)).toBe('=SUM(A3:A7)');
  });

  /** names this one specifically. */
  it('does NOT touch something that looks like a reference inside a string', () => {
    expect(engine.translateFormula('="see A1 for details"', 5, 0))
      .toBe('="see A1 for details"');
  });

  it('translates the reference and not the string, in the same formula', () => {
    expect(engine.translateFormula('="A1: "&A1', 1, 0)).toBe('="A1: "&A2');
  });

  it('produces #REF! when a reference would leave the sheet', () => {
    expect(engine.translateFormula('=A1', -1, 0)).toContain('#REF!');
  });

  it('keeps nested calls intact', () => {
    expect(engine.translateFormula('=IF(SUM(A1:A5)>10,B1,C1)', 1, 0))
      .toBe('=IF(SUM(A2:A6)>10,B2,C2)');
  });

  it('does not lose brackets that change the meaning', () => {
    expect(engine.translateFormula('=(A1+B1)*C1', 1, 0)).toBe('=(A2+B2)*C2');
  });
});

// Across sheets

describe('several sheets', () => {
  it('reads a cell on another sheet', () => {
    const second = model.addSheet('Data');
    engine.setValue(second.id, 0, 0, 42);
    engine.rebuild();
    setFormula(0, 0, '=Data!A1');
    expect(value(0, 0)).toBe(42);
  });

  it('recalculates across sheets when the source changes', () => {
    const second = model.addSheet('Data');
    engine.setValue(second.id, 0, 0, 1);
    setFormula(0, 0, '=Data!A1*10');
    expect(value(0, 0)).toBe(10);

    engine.setValue(second.id, 0, 0, 5);
    expect(value(0, 0)).toBe(50);
  });

  it('reports #REF! for a sheet that is not there', () => {
    setFormula(0, 0, '=Nowhere!A1');
    expect(value(0, 0)).toBe('#REF!');
  });
});
