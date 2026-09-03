/** Tokenizer, parser, and the A1 notation underneath them. */

import { describe, it, expect } from 'vitest';
import { tokenize, TOKEN } from '../src/js/parser/tokenizer.js';
import { parse, NODE, transform, walk } from '../src/js/parser/parser.js';
import { print } from '../src/js/engine/recalc.js';
import {
  columnName, columnIndex, parseRef, formatRef, parseRange, cellsInRange,
  translate, shiftForStructuralChange, shiftRangeForStructuralChange, a1,
} from '../src/js/references.js';

describe('column names', () => {
  it('counts in base 26 with no zero', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });

  it('round-trips', () => {
    for (const index of [0, 1, 25, 26, 27, 701, 702, 1000]) {
      expect(columnIndex(columnName(index))).toBe(index);
    }
  });

  it('refuses what is not a column', () => {
    expect(columnIndex('A1')).toBe(-1);
    expect(columnIndex('')).toBe(-1);
    expect(columnIndex('1')).toBe(-1);
  });
});

describe('references', () => {
  it('reads all four forms of absoluteness', () => {
    expect(parseRef('A1')).toEqual({ row: 0, col: 0, rowAbs: false, colAbs: false });
    expect(parseRef('$A1')).toEqual({ row: 0, col: 0, rowAbs: false, colAbs: true });
    expect(parseRef('A$1')).toEqual({ row: 0, col: 0, rowAbs: true, colAbs: false });
    expect(parseRef('$A$1')).toEqual({ row: 0, col: 0, rowAbs: true, colAbs: true });
  });

  it('round-trips through text', () => {
    for (const text of ['A1', '$A1', 'A$1', '$A$1', 'ZZ100', 'B7']) {
      expect(formatRef(parseRef(text))).toBe(text);
    }
  });

  it('refuses nonsense', () => {
    expect(parseRef('A0')).toBeNull();
    expect(parseRef('1A')).toBeNull();
    expect(parseRef('')).toBeNull();
  });

  it('reads a range and walks it in order', () => {
    const range = parseRange('A1:B2');
    expect([...cellsInRange(range)]).toEqual([
      { row: 0, col: 0 }, { row: 0, col: 1 },
      { row: 1, col: 0 }, { row: 1, col: 1 },
    ]);
  });

  it('normalises a range written backwards', () => {
    expect([...cellsInRange(parseRange('B2:A1'))]).toHaveLength(4);
  });

  it('labels a cell for display', () => {
    expect(a1(0, 0)).toBe('A1');
    expect(a1(9, 27)).toBe('AB10');
  });
});

describe('moving a reference', () => {
  it('moves the relative parts only', () => {
    const ref = parseRef('$A1');
    expect(translate(ref, 2, 3)).toEqual({ row: 2, col: 0, rowAbs: false, colAbs: true });
  });

  it('refuses to move off the sheet', () => {
    expect(translate(parseRef('A1'), -1, 0)).toBeNull();
  });

  it('moves absolute references for a structural change, unlike a copy', () => {
    // A dollar sign fixes a reference against copying, not against the sheet
    // changing shape underneath it.
    const ref = parseRef('$A$5');
    expect(shiftForStructuralChange(ref, { axis: 'row', at: 2, count: 1 }).row).toBe(5);
  });

  it('leaves a reference above the change alone', () => {
    expect(shiftForStructuralChange(parseRef('A1'), { axis: 'row', at: 5, count: 1 }).row).toBe(0);
  });

  it('reports a reference to a deleted row as gone', () => {
    expect(shiftForStructuralChange(parseRef('A3'), { axis: 'row', at: 2, count: -1 })).toBeNull();
  });

  it('grows a range that straddles an insertion', () => {
    const range = parseRange('A1:A10');
    const grown = shiftRangeForStructuralChange(range, { axis: 'row', at: 5, count: 2 });
    expect(grown.from.row).toBe(0);
    expect(grown.to.row).toBe(11);
  });

  it('drops a range entirely inside a deletion', () => {
    const range = parseRange('A3:A4');
    expect(shiftRangeForStructuralChange(range, { axis: 'row', at: 2, count: -5 })).toBeNull();
  });
});

describe('the tokenizer', () => {
  it('splits a formula into its parts', () => {
    const { tokens } = tokenize('=SUM(A1:B2)+1');
    expect(tokens.map((t) => t.type)).toEqual([
      TOKEN.identifier, TOKEN.open, TOKEN.reference, TOKEN.colon,
      TOKEN.reference, TOKEN.close, TOKEN.operator, TOKEN.number,
    ]);
  });

  /** names this case. */
  it('reads doubled quotes inside a string as one quote', () => {
    const { tokens } = tokenize('="he said ""no"""');
    expect(tokens[0].value).toBe('he said "no"');
  });

  it('reads decimals and exponents', () => {
    expect(tokenize('=1.5').tokens[0].value).toBe(1.5);
    expect(tokenize('=1.5e3').tokens[0].value).toBe(1500);
    expect(tokenize('=1e-2').tokens[0].value).toBe(0.01);
  });

  it('reads booleans and error values', () => {
    expect(tokenize('=TRUE').tokens[0]).toEqual({ type: TOKEN.boolean, value: true });
    expect(tokenize('=#DIV/0!').tokens[0]).toEqual({ type: TOKEN.error, value: '#DIV/0!' });
  });

  it('separates a sheet name from its reference', () => {
    const { tokens } = tokenize('=Data!A1');
    expect(tokens[0]).toEqual({ type: TOKEN.sheet, value: 'Data' });
    expect(tokens[1].type).toBe(TOKEN.reference);
  });

  it('reads a quoted sheet name with a space in it', () => {
    expect(tokenize("='My Sheet'!A1").tokens[0]).toEqual({ type: TOKEN.sheet, value: 'My Sheet' });
  });

  it('reports an unterminated string instead of guessing', () => {
    expect(tokenize('="unfinished').error).toBeTruthy();
  });

  it('accepts either comma or semicolon as a separator', () => {
    expect(tokenize('=IF(1;2;3)').tokens.filter((t) => t.type === TOKEN.separator)).toHaveLength(2);
  });
});

describe('the parser', () => {
  const ast = (text) => parse(text).ast;

  it('applies the usual precedence', () => {
    const tree = ast('=1+2*3');
    expect(tree.op).toBe('+');
    expect(tree.right.op).toBe('*');
  });

  it('makes comparison the loosest', () => {
    expect(ast('=1+2>3').op).toBe('>');
  });

  it('makes exponent right-associative', () => {
    // 2^3^2 is 2^(3^2) = 512, not (2^3)^2 = 64.
    const tree = ast('=2^3^2');
    expect(tree.right.op).toBe('^');
  });

  it('respects brackets', () => {
    expect(ast('=(1+2)*3').op).toBe('*');
  });

  /** names this case. */
  it('parses functions nested several levels deep', () => {
    const tree = ast('=IF(SUM(A1:A5)>10,MAX(B1:B5),MIN(C1:C5))');
    expect(tree.type).toBe(NODE.call);
    expect(tree.name).toBe('IF');
    expect(tree.args[0].left.name).toBe('SUM');
    expect(tree.args[1].name).toBe('MAX');
  });

  it('parses a call with no arguments', () => {
    expect(ast('=TODAY()').args).toEqual([]);
  });

  it('parses unary minus and postfix percent', () => {
    expect(ast('=-A1').type).toBe(NODE.unary);
    expect(ast('=50%').type).toBe(NODE.percent);
  });

  /** names this case. */
  it('reports a syntax error rather than throwing', () => {
    for (const bad of ['=1+', '=SUM(', '=)', '=*2', '=A1:', '=IF(1,2']) {
      const result = parse(bad);
      expect(result.error).toBeTruthy();
      expect(result.ast).toBeNull();
    }
  });

  it('refuses trailing rubbish', () => {
    expect(parse('=1 2').error).toBeTruthy();
  });
});

describe('walking and rewriting a tree', () => {
  it('visits every node', () => {
    const seen = [];
    walk(parse('=SUM(A1:A5)+B1').ast, (node) => seen.push(node.type));
    expect(seen).toContain(NODE.range);
    expect(seen).toContain(NODE.ref);
    expect(seen).toContain(NODE.call);
  });

  it('rewrites nodes without touching the rest', () => {
    const changed = transform(parse('=A1+1').ast, (node) => (
      node.type === NODE.number ? { ...node, value: 99 } : node
    ));
    expect(print(changed)).toBe('=A1+99'.slice(1));
  });
});

describe('printing a tree back to text', () => {
  const round = (text) => `=${print(parse(text).ast)}`;

  it('keeps simple formulas as they were', () => {
    for (const text of ['=A1+B1', '=SUM(A1:B10)', '=IF(A1>0,1,2)', '=$A$1', '=-A1', '=50%']) {
      expect(round(text)).toBe(text);
    }
  });

  it('keeps brackets that matter and drops ones that do not', () => {
    expect(round('=(A1+B1)*C1')).toBe('=(A1+B1)*C1');
    expect(round('=A1+(B1*C1)')).toBe('=A1+B1*C1');
  });

  it('keeps brackets on the right of a subtraction', () => {
    expect(round('=A1-(B1-C1)')).toBe('=A1-(B1-C1)');
  });

  it('re-escapes doubled quotes', () => {
    expect(round('="he said ""no"""')).toBe('="he said ""no"""');
  });

  it('quotes a sheet name that needs it', () => {
    expect(round("='My Sheet'!A1")).toBe("='My Sheet'!A1");
    expect(round('=Data!A1')).toBe('=Data!A1');
  });
});
