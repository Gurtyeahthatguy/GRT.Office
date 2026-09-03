/** Formats, CSV and the file itself. */

import { describe, it, expect, beforeEach } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';
import { formatValue, alignmentFor, parseInput } from '../src/js/format.js';
import { sniff, parseCsv, toCsv, coerce } from '../src/js/core/csv.js';

describe('display formats', () => {
  it('shows a plain number plainly', () => {
    expect(formatValue(1234.5)).toBe('1234.5');
    expect(formatValue(0)).toBe('0');
  });

  it('groups thousands and fixes decimals', () => {
    expect(formatValue(1234567.891, '#,##0.00')).toBe('1,234,567.89');
    expect(formatValue(5, '#,##0.00')).toBe('5.00');
    expect(formatValue(-1234.5, '#,##0.00')).toBe('-1,234.50');
  });

  it('shows a percentage as one', () => {
    expect(formatValue(0.055, '0.00%')).toBe('5.50%');
  });

  it('pads to the zeros in the pattern', () => {
    expect(formatValue(7, '000')).toBe('007');
  });

  it('drops trailing zeros where the pattern says they are optional', () => {
    expect(formatValue(1.5, '0.##')).toBe('1.5');
    expect(formatValue(1.5, '0.00')).toBe('1.50');
  });

  it('formats a date serial', () => {
    // 46267 is 2026-09-02 in the 1899-12-30 epoch.
    expect(formatValue(46267, 'yyyy-mm-dd')).toBe('2026-09-02');
    expect(formatValue(46267, 'd mmm yyyy')).toBe('2 Sep 2026');
  });

  it('shows an error as itself, whatever the pattern', () => {
    expect(formatValue('#DIV/0!', '#,##0.00')).toBe('#DIV/0!');
  });

  it('shows a blank cell as nothing, not as zero', () => {
    expect(formatValue(null)).toBe('');
  });

  it('aligns numbers right and text left, as every spreadsheet does', () => {
    expect(alignmentFor(1)).toBe('right');
    expect(alignmentFor('a')).toBe('left');
    expect(alignmentFor('#REF!')).toBe('center');
  });

  it('does not show floating-point noise', () => {
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
  });
});

describe('reading what was typed', () => {
  it('recognises a formula', () => {
    expect(parseInput('=A1+1')).toEqual({ kind: 'formula', value: '=A1+1' });
  });

  it('recognises numbers, including negative and grouped', () => {
    expect(parseInput('42').value).toBe(42);
    expect(parseInput('-1.5').value).toBe(-1.5);
    expect(parseInput('1,234').value).toBe(1234);
  });

  it('keeps a label that begins with digits as a label', () => {
    expect(parseInput('12 apples').value).toBe('12 apples');
  });

  it('turns a percentage into a fraction', () => {
    expect(parseInput('5%')).toEqual({ kind: 'value', value: 0.05, percent: true });
  });

  it('recognises booleans', () => {
    expect(parseInput('TRUE').value).toBe(true);
  });

  it('treats nothing as blank', () => {
    expect(parseInput('   ')).toEqual({ kind: 'blank', value: null });
  });
});

// CSV punctuation is detected, not guessed

describe('working out how a CSV file is punctuated', () => {
  it('spots a comma file', () => {
    const guess = sniff('a,b,c\n1,2,3\n');
    expect(guess.separator).toBe(',');
    expect(guess.decimal).toBe('.');
    expect(guess.confident).toBe(true);
  });

  it('spots a semicolon file, and assumes a comma decimal with it', () => {
    // The semicolon convention exists precisely because the comma is the
    // decimal point in half of Europe.
    const guess = sniff('a;b;c\n1,5;2,5;3,5\n');
    expect(guess.separator).toBe(';');
    expect(guess.decimal).toBe(',');
  });

  it('spots a tab file', () => {
    expect(sniff('a\tb\n1\t2\n').separator).toBe('\t');
  });

  it('says when it is not sure, rather than picking quietly', () => {
    const guess = sniff('a,b;c\n');
    expect(guess.confident).toBe(false);
    expect(guess.reason).toContain('Ambiguous');
  });

  it('prefers the separator that gives every row the same shape', () => {
    // The hard case, and the reason counting separators is not enough.
    const guess = sniff('a;b\n1,5;2,5\n3,5;4,5\n');
    expect(guess.separator).toBe(';');
    expect(guess.decimal).toBe(',');
    expect(guess.confident).toBe(true);
  });

  it('reports how many columns it thinks there are', () => {
    expect(sniff('a,b,c\n1,2,3\n').reason).toContain('3 columns');
  });

  it('says when there is no separator at all', () => {
    expect(sniff('one\ntwo\n').reason).toContain('single column');
  });

  it('ignores separators inside quoted fields', () => {
    expect(sniff('"a;b;c;d";x\n"e;f;g;h";y\n').separator).toBe(';');
  });

  it('is not fooled by a byte order mark', () => {
    expect(sniff('﻿a,b\n1,2\n').separator).toBe(',');
  });
});

describe('reading CSV', () => {
  it('splits rows and fields', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('handles a quoted field containing the separator', () => {
    expect(parseCsv('"a,b",c\n')).toEqual([['a,b', 'c']]);
  });

  it('handles a doubled quote inside a quoted field', () => {
    expect(parseCsv('"he said ""no""",x\n')).toEqual([['he said "no"', 'x']]);
  });

  it('handles a newline inside a quoted field', () => {
    expect(parseCsv('"two\nlines",x\n')).toEqual([['two\nlines', 'x']]);
  });

  it('accepts CRLF as well as LF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips a byte order mark', () => {
    expect(parseCsv('﻿a,b\n')[0][0]).toBe('a');
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']]);
  });
});

describe('turning CSV fields into values', () => {
  it('reads a number with a full stop', () => {
    expect(coerce('1.5')).toBe(1.5);
  });

  it('reads a number with a comma when told the decimal is a comma', () => {
    expect(coerce('1.234,5', { decimal: ',' })).toBe(1234.5);
  });

  it('leaves text as text', () => {
    expect(coerce('hello')).toBe('hello');
    expect(coerce('12 apples')).toBe('12 apples');
  });

  it('treats an empty field as blank, not as zero', () => {
    expect(coerce('')).toBeNull();
  });
});

describe('writing CSV', () => {
  it('quotes only what has to be quoted', () => {
    expect(toCsv([['a', 'b,c', 'd"e']])).toBe('a,"b,c","d""e"\r\n');
  });

  it('round-trips', () => {
    const rows = [['a,b', 'c"d'], ['multi\nline', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

// two saves produce identical bytes

describe('saving', () => {
  let model;
  let sheet;

  beforeEach(() => {
    model = new GridModel();
    sheet = new SheetController(model);
    sheet.setCell(0, 0, '10');
    sheet.setCell(0, 1, '20');
    sheet.setCell(0, 2, '=A1+B1');
    sheet.setCell(1, 0, 'label');
    sheet.applyStyle('header');
  });

  const serialise = () => `${JSON.stringify(model.toJSON(), null, 2)}\n`;

  it('produces identical text twice', () => {
    expect(serialise()).toBe(serialise());
  });

  it('produces identical text after a round trip', () => {
    const once = serialise();
    const reloaded = new GridModel(JSON.parse(once));
    expect(`${JSON.stringify(reloaded.toJSON(), null, 2)}\n`).toBe(once);
  });

  it('orders cells by row and column, not as strings', () => {
    const fresh = new GridModel();
    const control = new SheetController(fresh);
    control.setCell(10, 0, '1');
    control.setCell(2, 0, '2');

    const keys = Object.keys(fresh.toJSON().sheets[0].cells);
    expect(keys).toEqual(['2,0', '10,0']);
  });

  it('stores the formula and its value together, so a file opens showing numbers', () => {
    const saved = model.toJSON().sheets[0].cells['0,2'];
    expect(saved.f).toBe('=A1+B1');
    expect(saved.v).toBe(30);
  });

  it('says it is a spreadsheet', () => {
    expect(model.toJSON().type).toBe('grid');
  });

  it('records nothing about who made it or when', () => {
    const text = serialise().toLowerCase();
    for (const leak of ['creator', 'author', 'lastmodified', 'created', 'user']) {
      expect(text).not.toContain(leak);
    }
  });

  it('CANARY: that search would find such a field if one were written', () => {
    expect(JSON.stringify({ creator: 'someone' }).toLowerCase()).toContain('creator');
  });

  it('reloads a saved sheet with its values intact', () => {
    const reloaded = new GridModel(JSON.parse(serialise()));
    expect(reloaded.sheet.valueAt(0, 2)).toBe(30);
    expect(reloaded.sheet.formulaAt(0, 2)).toBe('=A1+B1');
  });

  it('recalculates correctly after reloading', () => {
    const reloaded = new GridModel(JSON.parse(serialise()));
    const control = new SheetController(reloaded);
    control.setCell(0, 0, '100');
    expect(reloaded.sheet.valueAt(0, 2)).toBe(120);
  });
});

// The sparse model

describe('the sparse model', () => {
  it('holds only the cells that exist', () => {
    const model = new GridModel();
    const sheet = new SheetController(model);
    sheet.setCell(9999, 99, '1');

    // One cell, not a million.
    expect(model.sheet.cells.size).toBe(1);
  });

  it('reports a blank cell as blank rather than as an object', () => {
    const model = new GridModel();
    expect(model.sheet.cell(5, 5)).toBeNull();
    expect(model.sheet.valueAt(5, 5)).toBeNull();
  });

  it('removes a cell entirely when it is emptied', () => {
    const model = new GridModel();
    const sheet = new SheetController(model);
    sheet.setCell(0, 0, '1');
    sheet.setCell(0, 0, '');
    expect(model.sheet.cells.size).toBe(0);
  });

  it('finds where the content stops', () => {
    const model = new GridModel();
    const sheet = new SheetController(model);
    sheet.setCell(2, 3, '1');
    sheet.setCell(7, 1, '2');
    expect(model.sheet.usedBounds()).toEqual({ top: 2, left: 1, bottom: 7, right: 3 });
  });

  it('has no bounds when it is empty', () => {
    expect(new GridModel().sheet.usedBounds()).toBeNull();
  });

  it('opens a large sparse sheet quickly', () => {
    const model = new GridModel();
    const sheet = new SheetController(model);

    const started = Date.now();
    for (let row = 0; row < 5000; row += 1) sheet.setCellQuietly(row, 0, String(row));
    const elapsed = Date.now() - started;

    expect(model.sheet.cells.size).toBe(5000);
    expect(elapsed).toBeLessThan(4000);
  });
});
