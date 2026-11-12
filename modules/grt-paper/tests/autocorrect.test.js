/** AutoCorrect: what typing puts right, the same over written text, and the edits that carry it into styled runs. */

import { describe, it, expect } from 'vitest';
import {
  correctOnType, correctText, editsBetween, applyEdits, cleanTable, cleanOptions, DEFAULT_OPTIONS, DEFAULT_REPLACEMENTS,
} from '../src/js/core/autocorrect.js';

const typed = (text) => correctText(text);

describe('while typing', () => {
  it('turns straight quotes into curly ones by what stands before', () => {
    expect(correctOnType('', '"')).toEqual({ remove: 0, insert: '“' });
    expect(correctOnType('he said', '"')).toEqual({ remove: 0, insert: '”' });
    expect(correctOnType("l", "'")).toEqual({ remove: 0, insert: '’' });
    expect(correctOnType('a (', "'")).toEqual({ remove: 0, insert: '‘' });
    expect(typed('"Hello," she said, "it\'s late."')).toBe('“Hello,” she said, “it’s late.”');
  });

  it('starts sentences with a capital, but not after a short form, a number or an ellipsis', () => {
    expect(typed('hello world. this is it! is it? yes')).toBe('Hello world. This is it! Is it? Yes');
    expect(typed('See fig. two and e.g. this, ecc. poi')).toBe('See fig. two and e.g. this, ecc. poi');
    expect(typed('Point 1. second')).toBe('Point 1. second');
    expect(typed('Well... maybe')).toBe('Well… maybe');
    expect(typed('www.example.org is a site')).toBe('www.example.org is a site');
    expect(typed('hello. world, again')).toBe('Hello. World, again');
    expect(typed('iPhone and eBay')).toBe('iPhone and eBay');
  });

  it('corrects two capitals at the start of a word, and leaves short forms alone', () => {
    expect(typed('THese quick BRown foxes')).toBe('These quick Brown foxes');
    expect(typed('The IDs, the PCs and 5 MHz in the USA')).toBe('The IDs, the PCs and 5 MHz in the USA');
  });

  it('replaces from the table at the end of a word only', () => {
    expect(typed('Copyright (c) 2026, teh end -> here')).toBe('Copyright © 2026, the end → here');
    expect(typed('Perchè no? (perchè sì)')).toBe('Perché no? (Perché sì)');
    expect(typed('so... maybe teh')).toBe('So… maybe the');
    expect(typed('gathered')).toBe('Gathered');
    expect(typed('x1/2 and 1/2')).toBe('x1/2 and ½');
  });

  it('makes dashes of a lone hyphen between words and of two hyphens inside one', () => {
    expect(typed('A - B and well-known, yes--no')).toBe('A – B and well-known, yes—no');
    expect(typed('- item')).toBe('- item');
  });

  it('does nothing that is turned off, and can drop a second space', () => {
    const off = cleanOptions({ quotes: false, capitalise: false, twoCapitals: false, replace: false, dashes: false });
    expect(correctText('"teh THe - x', off)).toBe('"teh THe - x');
    expect(correctText('a  b', { ...DEFAULT_OPTIONS, capitalise: false, doubleSpaces: true })).toBe('a b');
    expect(correctOnType('a', 'ab')).toBeNull();
  });
});

describe('tables and options from a settings file', () => {
  it('keeps only pairs it can use', () => {
    expect(cleanTable([['a', 'b'], ['a', 'c'], ['', 'x'], ['two words', 'x'], 'junk', ['same', 'same'], [1, 2]])).toEqual([['a', 'b'], ['1', '2']]);
    expect(cleanTable('nonsense')).toEqual([]);
    expect(cleanTable(DEFAULT_REPLACEMENTS)).toHaveLength(DEFAULT_REPLACEMENTS.length);
    expect(cleanOptions({ quotes: 'yes', dashes: false, other: 1 })).toEqual({ ...DEFAULT_OPTIONS, dashes: false });
  });
});

describe('carrying corrections into styled runs', () => {
  it('finds the smallest edits, last first', () => {
    expect(editsBetween('same', 'same')).toEqual([]);
    // Edits come last first, so each one's offsets still hold when it is made.
    const fromEnd = editsBetween('teh cat adn dog', 'the cat and dog').map((e) => e.from);
    expect(fromEnd).toEqual([...fromEnd].sort((a, b) => b - a));
    const edits = editsBetween('hello (c) world', 'Hello © world');
    let text = 'hello (c) world';
    for (const e of edits) text = text.slice(0, e.from) + e.text + text.slice(e.to);
    expect(text).toBe('Hello © world');
  });

  it('keeps each run its look, and objects where they are', () => {
    const runs = [{ text: 'hello ' }, { text: 'teh', bold: true }, { text: '￼', object: { type: 'note' } }, { text: ' end. next' }];
    const before = runs.map((r) => r.text).join('');
    const after = correctText(before);
    expect(after).toBe('Hello the￼ end. Next');
    const out = applyEdits(runs, editsBetween(before, after));
    expect(out.map((r) => r.text).join('')).toBe(after);
    expect(out.find((r) => r.bold).text).toBe('the');
    expect(out.find((r) => r.object).text).toBe('￼');
    expect(out[0]).toEqual({ text: 'Hello ' });
  });

  it('applies any edits to any runs without losing text', () => {
    const cases = [['abc', 'xabc'], ['abc', 'abcx'], ['abc', ''], ['', 'abc'], ['a b c', 'A — B c!'], ['one two', 'two one']];
    for (const [a, b] of cases) {
      const runs = a.length > 2 ? [{ text: a.slice(0, 2), bold: true }, { text: a.slice(2) }] : [{ text: a }];
      expect(applyEdits(runs, editsBetween(a, b)).map((r) => r.text).join('')).toBe(b);
    }
  });
});
