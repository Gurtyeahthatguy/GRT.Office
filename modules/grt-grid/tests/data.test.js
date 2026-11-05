/** Sorting, filtering, duplicates, splitting, series, subtotals, merging and moving cells. */

import { describe, it, expect } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

function open(rows) {
  const cells = {};
  rows.forEach((line, r) => line.forEach((v, c) => {
    if (v === null) return;
    cells[`${r},${c}`] = typeof v === 'string' && v.startsWith('=') ? { f: v } : { v };
  }));
  const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells }] });
  const sheet = new SheetController(model, { onChange: () => {} });
  const at = (r, c) => model.sheet.valueAt(r, c);
  const column = (c, from = 0, to = rows.length - 1) => Array.from({ length: to - from + 1 }, (_, i) => at(from + i, c));
  return { model, sheet, at, column };
}

const PEOPLE = [
  ['Name', 'City', 'Score', 'Double'],
  ['Ada', 'Turin', 9, '=C2*2'],
  ['Bob', 'Milan', 7, '=C3*2'],
  ['Cleo', 'Turin', 8, '=C4*2'],
  ['Dan', 'Rome', 7, '=C5*2'],
];

describe('sorting', () => {
  it('finds the data around the cell, keeps the header, and moves formulas with their rows', () => {
    const { sheet, column } = open(PEOPLE);
    sheet.select(2, 2);
    expect(sheet.hasHeader(sheet.dataArea())).toBe(true);
    sheet.sort({ keys: [{ index: 2, order: -1 }, { index: 0, order: 1 }] });
    expect(column(0)).toEqual(['Name', 'Ada', 'Cleo', 'Bob', 'Dan']);
    expect(column(3)).toEqual(['Double', 18, 16, 14, 14]);
  });

  it('comes undone in one step', () => {
    const { sheet, column } = open(PEOPLE);
    sheet.select(1, 0);
    sheet.sort({ keys: [{ index: 0, order: -1 }] });
    expect(column(0, 1)).toEqual(['Dan', 'Cleo', 'Bob', 'Ada']);
    sheet.step(-1);
    expect(column(0, 1)).toEqual(['Ada', 'Bob', 'Cleo', 'Dan']);
  });
});

describe('the autofilter', () => {
  it('hides the rows a column does not let through, and SUBTOTAL leaves them out', () => {
    const { sheet, model, at } = open([...PEOPLE, [null, null, '=SUBTOTAL(9,C2:C5)', '=SUM(C2:C5)']]);
    sheet.setFilter({ top: 0, left: 0, bottom: 4, right: 3 });
    sheet.setFilterColumn(1, { values: ['Turin'] });
    expect([...model.sheet.filtered]).toEqual([2, 4]);
    expect(model.sheet.rowHeight(2)).toBe(0);
    sheet.engine.recalculateAll();
    expect(at(5, 2)).toBe(17);
    expect(at(5, 3)).toBe(31);
    sheet.setFilterColumn(1, null);
    expect(model.sheet.filtered.size).toBe(0);
  });

  it('takes conditions, and the largest values', () => {
    const { sheet, model } = open(PEOPLE);
    sheet.setFilter({ top: 0, left: 0, bottom: 4, right: 3 });
    sheet.setFilterColumn(0, { conditions: [{ op: 'begins', value: 'c' }, { op: '=', value: 'Bob' }], join: 'or' });
    expect([...model.sheet.filtered]).toEqual([1, 4]);
    sheet.setFilterColumn(0, null);
    sheet.setFilterColumn(2, { top: { count: 2 } });
    expect([...model.sheet.filtered]).toEqual([2, 4]);
  });

  it('is saved with the sheet and hides the same rows when the file opens', () => {
    const { sheet, model } = open(PEOPLE);
    sheet.setFilter({ top: 0, left: 0, bottom: 4, right: 3 });
    sheet.setFilterColumn(2, { conditions: [{ op: '>', value: '7' }] });
    const again = new GridModel(model.toJSON());
    new SheetController(again, { onChange: () => {} });
    expect([...again.sheet.filtered]).toEqual([2, 4]);
  });
});

describe('other commands on data', () => {
  it('removes repeated rows and closes the gaps', () => {
    const { sheet, column } = open([['A'], ['x'], ['y'], ['X'], ['z'], ['y']]);
    sheet.select(1, 0);
    expect(sheet.removeDuplicates({ area: { top: 0, left: 0, bottom: 5, right: 0 }, header: true })).toBe(2);
    expect(column(0)).toEqual(['A', 'x', 'y', 'z', null, null]);
  });

  it('splits text into columns, quotes respected', () => {
    const { sheet, at } = open([['a,"b,c",3']]);
    sheet.select(0, 0);
    sheet.textToColumns({ separators: [','] });
    expect([at(0, 0), at(0, 1), at(0, 2)]).toEqual(['a', 'b,c', 3]);
  });

  it('fills a series of months', () => {
    const { sheet, column } = open([[45306]]);
    sheet.selectRange(0, 0, 3, 0);
    sheet.fillSeries({ type: 'date', unit: 'month', step: 1 });
    expect(column(0, 0, 3)).toEqual([45306, 45337, 45366, 45397]);
  });

  it('adds a subtotal after each group and a grand total that does not count them twice', () => {
    const { sheet, at } = open([['City', 'Sales'], ['Milan', 3], ['Milan', 4], ['Rome', 5]]);
    sheet.subtotals({ area: { top: 0, left: 0, bottom: 3, right: 1 }, groupCol: 0, columns: [1] });
    expect([at(3, 0), at(3, 1), at(5, 0), at(5, 1), at(6, 0), at(6, 1)]).toEqual(['Milan Total', 7, 'Rome Total', 5, 'Grand Total', 12]);
  });

  it('turns formulas into the values they show', () => {
    const { sheet, model } = open([[2, '=A1*3']]);
    sheet.select(0, 1);
    sheet.formulasToValues();
    expect(model.sheet.cell(0, 1)).toEqual({ v: 6 });
  });
});

describe('merging and moving cells', () => {
  it('merges a block into its first cell and unmerges it', () => {
    const { sheet, model } = open([['top', 'x'], ['y', null]]);
    sheet.selectRange(0, 0, 1, 1);
    expect(sheet.mergeLoses()).toBe(true);
    sheet.merge();
    expect(model.sheet.merges).toEqual([{ top: 0, left: 0, bottom: 1, right: 1 }]);
    expect(model.sheet.valueAt(0, 1)).toBeNull();
    expect(new GridModel(model.toJSON()).sheet.merges).toHaveLength(1);
    sheet.unmerge();
    expect(model.sheet.merges).toEqual([]);
  });

  it('inserts cells and the references to the ones pushed down follow them', () => {
    const { sheet, at, model } = open([[1, '=A2+A3'], [2, null], [3, null]]);
    sheet.select(1, 0);
    sheet.insertCells('down');
    expect([at(1, 0), at(2, 0), at(3, 0)]).toEqual([null, 2, 3]);
    expect(model.sheet.formulaAt(0, 1)).toBe('=A3+A4');
    expect(at(0, 1)).toBe(5);
  });

  it('deletes cells, and a reference to a deleted one breaks', () => {
    const { sheet, at, model } = open([[1, '=A2'], [2, '=A3'], [3, null]]);
    sheet.select(1, 0);
    sheet.deleteCells('up');
    expect([at(0, 0), at(1, 0)]).toEqual([1, 3]);
    expect(model.sheet.formulaAt(0, 1)).toBe('=#REF!');
    expect(model.sheet.formulaAt(1, 1)).toBe('=A2');
    expect(at(1, 1)).toBe(3);
  });

  it('hides rows and freezes panes', () => {
    const { sheet, model } = open([[1], [2], [3]]);
    sheet.selectRange(1, 0, 1, 0);
    sheet.setHidden('row', true);
    expect(model.sheet.rowHeight(1)).toBe(0);
    sheet.select(1, 1);
    sheet.freeze();
    expect(model.sheet.frozen).toEqual({ rows: 1, cols: 1 });
  });
});
