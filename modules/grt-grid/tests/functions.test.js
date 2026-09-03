/** The function library, and the type rules underneath it. */

import { describe, it, expect, beforeEach } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { Engine } from '../src/js/engine/recalc.js';
import { FUNCTIONS, VOLATILE } from '../src/js/functions/index.js';
import { toNumber, toText, toBoolean, compare, ERROR } from '../src/js/engine/values.js';

let model;
let engine;
let sheetId;

/** Evaluates a formula in an empty sheet, or one prepared by `fill`. */
function run(formula, fill = {}) {
  model = new GridModel();
  engine = new Engine(model);
  sheetId = model.sheet.id;

  for (const [ref, value] of Object.entries(fill)) {
    const col = ref.charCodeAt(0) - 65;
    const row = Number.parseInt(ref.slice(1), 10) - 1;
    engine.setValue(sheetId, row, col, value);
  }

  engine.setFormula(sheetId, 100, 0, formula);
  return model.sheet.valueAt(100, 0);
}

describe('the type rules', () => {
  it('treats a blank cell as zero in arithmetic', () => {
    expect(run('=A1+1')).toBe(1);
  });

  it('refuses text in arithmetic', () => {
    expect(run('=A1+1', { A1: 'apples' })).toBe('#VALUE!');
  });

  it('accepts numeric text in arithmetic, as Excel does', () => {
    expect(run('="5"+1')).toBe(6);
    expect(run('=A1*2', { A1: '5' })).toBe(10);
  });

  it('treats booleans as one and zero', () => {
    expect(run('=TRUE+1')).toBe(2);
    expect(run('=FALSE+1')).toBe(1);
  });

  it('skips text and blanks inside a range', () => {
    expect(run('=SUM(A1:A4)', { A1: 1, A2: 'label', A4: 3 })).toBe(4);
  });

  it('counts only the numbers', () => {
    expect(run('=COUNT(A1:A4)', { A1: 1, A2: 'label', A4: 3 })).toBe(2);
    expect(run('=COUNTA(A1:A4)', { A1: 1, A2: 'label', A4: 3 })).toBe(3);
  });

  it('orders numbers before text before booleans', () => {
    expect(compare(1, 'a')).toBeLessThan(0);
    expect(compare('a', true)).toBeLessThan(0);
  });

  it('compares text without regard to case', () => {
    expect(run('="a"="A"')).toBe(true);
  });

  it('converts in both directions predictably', () => {
    expect(toNumber('')).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('x')).toBe(ERROR.value);
    expect(toText(true)).toBe('TRUE');
    expect(toText(1.5)).toBe('1.5');
    expect(toBoolean('TRUE')).toBe(true);
    expect(toBoolean(0)).toBe(false);
  });

  it('does not show floating-point noise', () => {
    // 0.1 + 0.2 startles people in spreadsheets more than anywhere else.
    expect(toText(0.1 + 0.2)).toBe('0.3');
    expect(run('=0.1+0.2')).toBeCloseTo(0.3, 12);
  });
});

describe('maths', () => {
  it('sums, multiplies and rounds', () => {
    expect(run('=SUM(1,2,3)')).toBe(6);
    expect(run('=PRODUCT(2,3,4)')).toBe(24);
    expect(run('=ROUND(2.345,2)')).toBe(2.35);
    expect(run('=ROUND(2.5,0)')).toBe(3);
    expect(run('=ROUNDUP(2.01,1)')).toBe(2.1);
    expect(run('=ROUNDDOWN(2.99,1)')).toBe(2.9);
  });

  it('rounds a half up rather than to even', () => {
    // 1.005 is stored as slightly less than 1.005; rounding naively gives
    // 1.00 and gets reported as a bug every single time.
    expect(run('=ROUND(1.005,2)')).toBe(1.01);
  });

  it('does the rest of the arithmetic', () => {
    expect(run('=ABS(-3)')).toBe(3);
    expect(run('=INT(2.9)')).toBe(2);
    expect(run('=INT(-2.1)')).toBe(-3);
    expect(run('=MOD(7,3)')).toBe(1);
    expect(run('=MOD(-7,3)')).toBe(2);
    expect(run('=POWER(2,10)')).toBe(1024);
    expect(run('=SQRT(16)')).toBe(4);
  });

  it('reports impossible arithmetic rather than NaN', () => {
    expect(run('=SQRT(-1)')).toBe('#NUM!');
    expect(run('=1/0')).toBe('#DIV/0!');
    expect(run('=MOD(1,0)')).toBe('#DIV/0!');
    expect(run('=LN(0)')).toBe('#NUM!');
  });
});

describe('statistics', () => {
  const data = { A1: 1, A2: 2, A3: 3, A4: 4 };

  it('averages, and refuses to average nothing', () => {
    expect(run('=AVERAGE(A1:A4)', data)).toBe(2.5);
    expect(run('=AVERAGE(B1:B4)')).toBe('#DIV/0!');
  });

  it('finds the extremes and the middle', () => {
    expect(run('=MIN(A1:A4)', data)).toBe(1);
    expect(run('=MAX(A1:A4)', data)).toBe(4);
    expect(run('=MEDIAN(A1:A4)', data)).toBe(2.5);
    expect(run('=MEDIAN(A1:A3)', data)).toBe(2);
  });

  it('computes a sample standard deviation', () => {
    expect(run('=STDEV(A1:A4)', data)).toBeCloseTo(1.29099, 4);
  });

  it('counts and sums conditionally', () => {
    expect(run('=COUNTIF(A1:A4,">2")', data)).toBe(2);
    expect(run('=SUMIF(A1:A4,">2")', data)).toBe(7);
    expect(run('=COUNTIF(A1:A4,2)', data)).toBe(1);
  });

  it('sums a different range from the one it tested', () => {
    expect(run('=SUMIF(A1:A4,">2",B1:B4)', { ...data, B3: 10, B4: 20 })).toBe(30);
  });

  it('understands a not-equal criterion', () => {
    expect(run('=COUNTIF(A1:A4,"<>2")', data)).toBe(3);
  });
});

describe('logic', () => {
  it('chooses', () => {
    expect(run('=IF(TRUE,"yes","no")')).toBe('yes');
    expect(run('=IF(FALSE,"yes","no")')).toBe('no');
    expect(run('=IF(1>2,"yes")')).toBe(false);
  });

  it('combines', () => {
    expect(run('=AND(TRUE,TRUE)')).toBe(true);
    expect(run('=AND(TRUE,FALSE)')).toBe(false);
    expect(run('=OR(FALSE,TRUE)')).toBe(true);
    expect(run('=NOT(TRUE)')).toBe(false);
    expect(run('=XOR(TRUE,TRUE)')).toBe(false);
  });

  it('catches errors', () => {
    expect(run('=IFERROR(1/0,"caught")')).toBe('caught');
    expect(run('=IFERROR(2+2,"caught")')).toBe(4);
    expect(run('=ISERROR(1/0)')).toBe(true);
  });

  it('inspects a value', () => {
    expect(run('=ISBLANK(A1)')).toBe(true);
    expect(run('=ISNUMBER(A1)', { A1: 5 })).toBe(true);
    expect(run('=ISTEXT(A1)', { A1: 'x' })).toBe(true);
  });

  it('does not evaluate the branch it did not take, as far as errors go', () => {
    // IF returns the value; the untaken branch was still evaluated, which is
    // what a strict evaluator does.
    expect(run('=IF(TRUE,1,1/0)')).toBe(1);
  });
});

describe('text', () => {
  it('joins and slices', () => {
    expect(run('=CONCAT("a","b","c")')).toBe('abc');
    expect(run('=LEFT("hello",2)')).toBe('he');
    expect(run('=RIGHT("hello",2)')).toBe('lo');
    expect(run('=MID("hello",2,3)')).toBe('ell');
    expect(run('=LEN("hello")')).toBe(5);
  });

  it('changes case and trims', () => {
    expect(run('=UPPER("abc")')).toBe('ABC');
    expect(run('=LOWER("ABC")')).toBe('abc');
    expect(run('=PROPER("john smith")')).toBe('John Smith');
    expect(run('=TRIM("  a   b  ")')).toBe('a b');
  });

  it('substitutes and finds', () => {
    expect(run('=SUBSTITUTE("a-b-c","-","+")')).toBe('a+b+c');
    expect(run('=FIND("l","hello")')).toBe(3);
    expect(run('=FIND("z","hello")')).toBe('#VALUE!');
  });

  it('concatenates with the operator too', () => {
    expect(run('="a"&"b"')).toBe('ab');
    expect(run('=1&2')).toBe('12');
  });
});

describe('dates', () => {
  it('uses the serial every spreadsheet uses', () => {
    // 1900-01-01 is serial 2 in the 1899-12-30 epoch.
    expect(run('=DATE(1900,1,1)')).toBe(2);
    expect(run('=DATE(2026,9,2)')).toBe(46267);
  });

  it('takes a date apart', () => {
    const serial = run('=DATE(2026,9,2)');
    expect(run(`=YEAR(${serial})`)).toBe(2026);
    expect(run(`=MONTH(${serial})`)).toBe(9);
    expect(run(`=DAY(${serial})`)).toBe(2);
  });

  it('counts days between dates', () => {
    expect(run('=DAYS(DATE(2026,1,10),DATE(2026,1,1))')).toBe(9);
  });

  it('marks the clock-reading functions volatile', () => {
    for (const name of ['TODAY', 'NOW', 'RAND']) expect(VOLATILE.has(name)).toBe(true);
  });
});

describe('lookup', () => {
  const table = {
    A1: 'apple', B1: 10,
    A2: 'banana', B2: 20,
    A3: 'cherry', B3: 30,
  };

  it('looks a value up in a column', () => {
    expect(run('=VLOOKUP("banana",A1:B3,2)', table)).toBe(20);
  });

  it('reports a miss rather than the nearest thing', () => {
    // Excel defaults an unspecified fourth argument to TRUE, which returns a
    // plausible wrong answer on unsorted data.
    expect(run('=VLOOKUP("durian",A1:B3,2)', table)).toBe('#N/A');
  });

  it('can be asked for an approximate match explicitly', () => {
    expect(run('=VLOOKUP("bb",A1:B3,2,TRUE)', table)).toBe(20);
  });

  it('indexes into a range', () => {
    expect(run('=INDEX(A1:B3,2,2)', table)).toBe(20);
    expect(run('=INDEX(A1:B3,9,1)', table)).toBe('#REF!');
  });

  it('matches a position', () => {
    expect(run('=MATCH("cherry",A1:A3,0)', table)).toBe(3);
    expect(run('=MATCH("durian",A1:A3,0)', table)).toBe('#N/A');
  });

  it('combines INDEX and MATCH, which is what people actually use', () => {
    expect(run('=INDEX(B1:B3,MATCH("cherry",A1:A3,0))', table)).toBe(30);
  });
});

describe('errors travelling through functions', () => {
  it('a range containing an error poisons the result', () => {
    expect(run('=SUM(A1:A3)', { A1: 1, A2: '#DIV/0!', A3: 3 })).toBe('#DIV/0!');
  });

  it('IFERROR is the way out', () => {
    expect(run('=IFERROR(SUM(A1:A3),0)', { A1: 1, A2: '#DIV/0!' })).toBe(0);
  });

  it('a function that is not there is #NAME?', () => {
    expect(run('=NOPE(1)')).toBe('#NAME?');
  });
});

describe('the library as a whole', () => {
  it('has at least fifty functions', () => {
    expect(Object.keys(FUNCTIONS).length).toBeGreaterThanOrEqual(50);
  });

  it('has every function the specification names', () => {
    const required = `SUM ABS ROUND ROUNDUP ROUNDDOWN INT MOD SQRT POWER RAND
      AVERAGE COUNT COUNTA COUNTIF MIN MAX MEDIAN STDEV SUMIF
      IF AND OR NOT IFERROR TRUE FALSE
      CONCAT LEFT RIGHT MID LEN UPPER LOWER TRIM SUBSTITUTE FIND TEXT
      TODAY NOW DATE YEAR MONTH DAY WEEKDAY
      VLOOKUP HLOOKUP INDEX MATCH`.split(/\s+/).filter(Boolean);

    const missing = required.filter((name) => !(name in FUNCTIONS));
    expect(missing).toEqual([]);
  });

  it('contains nothing that could reach a network', () => {
    // Excel's WEBSERVICE has no equivalent here, by principle.
    for (const name of Object.keys(FUNCTIONS)) {
      expect(name).not.toMatch(/WEB|HTTP|URL|SERVICE|FETCH/);
    }
  });
});
