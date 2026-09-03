/** Selection, navigation, editing, copying. */

import { describe, it, expect, beforeEach } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

let model;
let sheet;

const at = (row, col) => model.sheet.valueAt(row, col);

beforeEach(() => {
  model = new GridModel();
  sheet = new SheetController(model);
});

describe('selection', () => {
  it('starts at A1', () => {
    expect(sheet.selectionLabel).toBe('A1');
    expect(sheet.selectionIsSingle).toBe(true);
  });

  it('moves with the arrows', () => {
    sheet.move(1, 0);
    expect(sheet.selectionLabel).toBe('A2');
    sheet.move(0, 2);
    expect(sheet.selectionLabel).toBe('C2');
  });

  it('does not walk off the top or the left', () => {
    sheet.move(-5, -5);
    expect(sheet.selectionLabel).toBe('A1');
  });

  it('extends a range with shift', () => {
    sheet.move(2, 2, { extend: true });
    expect(sheet.selectionLabel).toBe('A1:C3');
    expect(sheet.selectionIsSingle).toBe(false);
  });

  it('collapses the range when it moves without shift', () => {
    sheet.move(2, 2, { extend: true });
    sheet.move(1, 0);
    expect(sheet.selectionIsSingle).toBe(true);
  });

  it('normalises a range selected upwards', () => {
    sheet.select(4, 4);
    sheet.move(-2, -2, { extend: true });
    expect(sheet.selection).toEqual({ top: 2, left: 2, bottom: 4, right: 4 });
  });
});

describe('jumping to the edge of the data', () => {
  beforeEach(() => {
    for (const row of [0, 1, 2]) sheet.setCell(row, 0, String(row + 1));
    sheet.setCell(9, 0, 'far');
    sheet.select(0, 0);
  });

  it('runs to the last filled cell before a gap', () => {
    sheet.move(1, 0, { jump: true });
    expect(sheet.active.row).toBe(2);
  });

  it('crosses a gap to the next filled cell', () => {
    sheet.select(2, 0);
    sheet.move(1, 0, { jump: true });
    expect(sheet.active.row).toBe(9);
  });

  it('stops rather than running away on an empty sheet', () => {
    const empty = new SheetController(new GridModel());
    empty.move(1, 0, { jump: true });
    expect(empty.active.row).toBeLessThan(3);
  });
});

describe('typing into a cell', () => {
  it('stores a number as a number', () => {
    sheet.setCell(0, 0, '42');
    expect(at(0, 0)).toBe(42);
  });

  it('stores text as text', () => {
    sheet.setCell(0, 0, 'hello');
    expect(at(0, 0)).toBe('hello');
  });

  it('keeps something that merely starts with digits as text', () => {
    sheet.setCell(0, 0, '12 apples');
    expect(at(0, 0)).toBe('12 apples');
  });

  it('turns a percentage into a fraction and formats it', () => {
    sheet.setCell(0, 0, '5%');
    expect(at(0, 0)).toBe(0.05);
    expect(model.sheet.styleAt(0, 0)).toBe('percent');
  });

  it('recognises a formula and calculates it', () => {
    sheet.setCell(0, 0, '2');
    sheet.setCell(0, 1, '3');
    sheet.setCell(0, 2, '=A1*B1');
    expect(at(0, 2)).toBe(6);
  });

  it('empties a cell when given nothing', () => {
    sheet.setCell(0, 0, '42');
    sheet.setCell(0, 0, '');
    expect(model.sheet.cell(0, 0)).toBeNull();
  });
});

describe('the edit in progress', () => {
  it('shows the formula, not the value, when a cell is selected', () => {
    sheet.setCell(0, 0, '=1+1');
    sheet.select(0, 0);
    expect(sheet.activeText).toBe('=1+1');
    expect(at(0, 0)).toBe(2);
  });

  it('commits what was typed', () => {
    sheet.beginEdit('7');
    sheet.commitEdit();
    expect(at(0, 0)).toBe(7);
  });

  it('throws the edit away when cancelled', () => {
    sheet.setCell(0, 0, 'original');
    sheet.beginEdit('replacement');
    sheet.cancelEdit();
    expect(at(0, 0)).toBe('original');
  });

  it('commits when the selection moves, rather than losing it', () => {
    sheet.beginEdit('9');
    sheet.move(1, 0);
    expect(at(0, 0)).toBe(9);
  });
});

describe('clearing', () => {
  it('empties everything selected', () => {
    for (let col = 0; col < 3; col += 1) sheet.setCell(0, col, String(col));
    sheet.selectRange(0, 0, 0, 2);
    sheet.clearSelection();

    for (let col = 0; col < 3; col += 1) expect(model.sheet.cell(0, col)).toBeNull();
  });

  it('recalculates what depended on what was cleared', () => {
    sheet.setCell(0, 0, '5');
    sheet.setCell(0, 1, '=A1*2');
    sheet.selectRange(0, 0, 0, 0);
    sheet.clearSelection();
    expect(at(0, 1)).toBe(0);
  });
});

describe('copy and paste', () => {
  beforeEach(() => {
    sheet.setCell(0, 0, '1');
    sheet.setCell(1, 0, '2');
    sheet.setCell(0, 1, '=A1*10');
  });

  it('carries values', () => {
    sheet.selectRange(0, 0, 1, 0);
    const payload = sheet.copy();

    sheet.select(0, 4);
    sheet.paste(payload);

    expect(at(0, 4)).toBe(1);
    expect(at(1, 4)).toBe(2);
  });

  it('translates a formula by how far it moved', () => {
    sheet.selectRange(0, 1, 0, 1);
    const payload = sheet.copy();

    sheet.select(1, 1);
    sheet.paste(payload);

    expect(model.sheet.formulaAt(1, 1)).toBe('=A2*10');
    expect(at(1, 1)).toBe(20);
  });

  it('produces plain text for other programs', () => {
    sheet.selectRange(0, 0, 1, 1);
    expect(sheet.copy().text).toContain('\t');
  });

  it('takes tab-separated text from elsewhere', () => {
    sheet.select(5, 0);
    sheet.paste({ text: 'a\tb\r\nc\td\r\n' });

    expect(at(5, 0)).toBe('a');
    expect(at(5, 1)).toBe('b');
    expect(at(6, 0)).toBe('c');
  });

  it('reads numbers out of pasted text', () => {
    sheet.select(5, 0);
    sheet.paste({ text: '1\t2.5\n' });
    expect(at(5, 0)).toBe(1);
    expect(at(5, 1)).toBe(2.5);
  });
});

describe('filling down', () => {
  it('translates a formula as it goes', () => {
    sheet.setCell(0, 0, '1');
    sheet.setCell(1, 0, '2');
    sheet.setCell(2, 0, '3');
    sheet.setCell(0, 1, '=A1*2');

    sheet.selectRange(0, 1, 2, 1);
    sheet.fillDown();

    expect(at(1, 1)).toBe(4);
    expect(at(2, 1)).toBe(6);
  });

  it('continues a numeric series from two cells', () => {
    sheet.setCell(0, 0, '10');
    sheet.setCell(1, 0, '20');
    sheet.selectRange(0, 0, 4, 0);
    sheet.fillDown();

    expect(at(2, 0)).toBe(30);
    expect(at(4, 0)).toBe(50);
  });

  it('repeats anything that is not a series', () => {
    sheet.setCell(0, 0, 'x');
    sheet.selectRange(0, 0, 2, 0);
    sheet.fillDown();
    expect(at(2, 0)).toBe('x');
  });
});

describe('undo', () => {
  it('takes one edit back', () => {
    sheet.setCell(0, 0, '1');
    sheet.setCell(0, 0, '2');
    sheet.step(-1);
    expect(at(0, 0)).toBe(1);
  });

  it('puts it forward again', () => {
    sheet.setCell(0, 0, '1');
    sheet.setCell(0, 0, '2');
    sheet.step(-1);
    sheet.step(1);
    expect(at(0, 0)).toBe(2);
  });

  it('restores calculated values, not just the cells that were typed', () => {
    sheet.setCell(0, 0, '5');
    sheet.setCell(0, 1, '=A1*2');
    sheet.setCell(0, 0, '50');
    expect(at(0, 1)).toBe(100);

    sheet.step(-1);
    expect(at(0, 0)).toBe(5);
    expect(at(0, 1)).toBe(10);
  });

  it('keeps calculating after an undo, which needs the engine rebuilt', () => {
    sheet.setCell(0, 0, '5');
    sheet.setCell(0, 1, '=A1*2');
    sheet.setCell(0, 0, '50');
    sheet.step(-1);

    sheet.setCell(0, 0, '7');
    expect(at(0, 1)).toBe(14);
  });

  it('puts the selection back where the change was', () => {
    // Driven the way the program does it: select, then edit there.
    sheet.select(3, 3);
    sheet.beginEdit('1');
    sheet.commitEdit();

    sheet.select(0, 0);
    sheet.step(-1);
    expect(sheet.active).toEqual({ row: 3, col: 3 });
  });

  it('treats a whole paste as one step', () => {
    sheet.setCell(0, 0, '1');
    sheet.select(5, 0);
    sheet.paste({ text: 'a\tb\nc\td\n' });

    sheet.step(-1);
    expect(model.sheet.cell(5, 0)).toBeNull();
    expect(at(0, 0)).toBe(1);
  });

  it('does nothing at the ends of the history', () => {
    expect(sheet.step(-1)).toBe(false);
    expect(sheet.step(1)).toBe(false);
  });
});

describe('rows and columns', () => {
  it('inserts a row and keeps the formulas right', () => {
    sheet.setCell(0, 0, '1');
    sheet.setCell(4, 0, '5');
    sheet.setCell(9, 0, '=A1+A5');

    sheet.insertRows(2, 1);
    expect(model.sheet.formulaAt(10, 0)).toBe('=A1+A6');
    expect(at(10, 0)).toBe(6);
  });

  it('can be undone', () => {
    sheet.setCell(9, 0, '=A1+A5');
    sheet.insertRows(2, 1);
    sheet.step(-1);
    expect(model.sheet.formulaAt(9, 0)).toBe('=A1+A5');
  });

  it('deletes columns', () => {
    sheet.setCell(0, 0, '1');
    sheet.setCell(0, 2, '3');
    sheet.deleteColumns(1, 1);
    expect(at(0, 1)).toBe(3);
  });
});

describe('several sheets', () => {
  it('adds one and switches to it', () => {
    sheet.addSheet('Data');
    expect(model.sheets).toHaveLength(2);

    const second = model.sheets[1];
    sheet.switchSheet(second.id);
    expect(sheet.sheetId).toBe(second.id);
  });

  it('keeps the cells of each sheet separate', () => {
    sheet.setCell(0, 0, 'first');
    sheet.addSheet('Data');
    sheet.switchSheet(model.sheets[1].id);
    expect(model.sheet.valueAt(0, 0)).toBeNull();
  });
});

describe('CSV', () => {
  it('imports rows and columns', () => {
    const result = sheet.importCsv('a,b\n1,2\n');
    expect(result).toEqual({ rows: 2, columns: 2 });
    expect(at(0, 0)).toBe('a');
    expect(at(1, 0)).toBe(1);
  });

  it('honours a comma decimal separator when told to', () => {
    sheet.importCsv('1,5;2,5\n', { separator: ';', decimal: ',' });
    expect(at(0, 0)).toBe(1.5);
    expect(at(0, 1)).toBe(2.5);
  });

  it('exports what is there and nothing else', () => {
    sheet.setCell(0, 0, 'a');
    sheet.setCell(1, 1, '2');
    expect(sheet.exportCsv()).toBe('a,\r\n,2\r\n');
  });

  it('exports calculated values, not formulas', () => {
    sheet.setCell(0, 0, '2');
    sheet.setCell(0, 1, '=A1*3');
    expect(sheet.exportCsv()).toBe('2,6\r\n');
  });

  it('can be undone', () => {
    sheet.setCell(0, 0, 'before');
    sheet.importCsv('x,y\n');
    sheet.step(-1);
    expect(at(0, 0)).toBe('before');
  });
});

describe('the edit buffer, whatever order the events arrive in', () => {
  /** Found by driving the real program in a browser rather than by a test. */
  it('accepts text without an edit having been started first', () => {
    sheet.updateEdit('42');
    sheet.commitEdit();
    expect(at(0, 0)).toBe(42);
  });

  it('keeps the character that started the edit when begin is called again', () => {
    // Typing a character calls beginEdit(character); the formula bar's focus
    // handler then calls beginEdit() with nothing.
    sheet.beginEdit('7');
    sheet.beginEdit();
    expect(sheet.editing).toBe('7');

    sheet.commitEdit();
    expect(at(0, 0)).toBe(7);
  });

  it('writes nothing when the edit says what the cell already said', () => {
    sheet.setCell(0, 0, 'unchanged');
    const before = sheet.undo.past.length;

    sheet.beginEdit();
    expect(sheet.commitEdit()).toBe(false);

    expect(at(0, 0)).toBe('unchanged');
    expect(sheet.undo.past.length).toBe(before);
  });

  it('does not empty a cell just because the bar was focused and left', () => {
    sheet.setCell(0, 0, '5');
    sheet.beginEdit();
    sheet.select(1, 0);
    expect(at(0, 0)).toBe(5);
  });

  it('still writes when the text really did change', () => {
    sheet.setCell(0, 0, 'before');
    sheet.beginEdit();
    sheet.updateEdit('after');
    expect(sheet.commitEdit()).toBe(true);
    expect(at(0, 0)).toBe('after');
  });

  it('forgets the buffer when cancelled', () => {
    sheet.setCell(0, 0, 'kept');
    sheet.beginEdit();
    sheet.updateEdit('discarded');
    sheet.cancelEdit();
    sheet.commitEdit();
    expect(at(0, 0)).toBe('kept');
  });
});
