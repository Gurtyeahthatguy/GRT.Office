// @vitest-environment jsdom

/** Words found for spelling, the checker's memory and ignore list, and the simple grammar rules. */

import { describe, it, expect, vi } from 'vitest';
import { wordsOf, createSpellChecker } from '../src/js/core/spelling.js';
import { grammarIssues } from '../src/js/core/grammar.js';

describe('words to check', () => {
  it('finds words with their apostrophes and leaves addresses, numbers and code alone', () => {
    expect(wordsOf('Dell’albero, po’ di sole.').map((w) => w.word)).toEqual(['Dell’albero', 'po’', 'di', 'sole']);
    expect(wordsOf('see https://example.org/x and mail@site.it or www.a.com').map((w) => w.word)).toEqual(['see', 'and', 'or']);
    expect(wordsOf('abc123 x_y 3rd naïve').map((w) => w.word)).toEqual(['naïve']);
    expect(wordsOf('汉语 한국 Ελλάδα Москва città').map((w) => w.word)).toEqual(['città']);
    const [first] = wordsOf('  ciao');
    expect([first.from, first.to]).toEqual([2, 6]);
  });
});

describe('the checker', () => {
  it('asks once for each word, honours the ignore list and takes an apostrophe at the end either way', async () => {
    const dictionary = new Set(['ciao', 'po’', 'mondo', 'bene']);
    const call = vi.fn(async (cmd, args) => (cmd === 'spell_check' ? args.words.map((w) => dictionary.has(w)) : cmd === 'spell_added' ? [] : null));
    const checker = createSpellChecker({ call });
    expect((await checker.misspelled('ciao mondoo, un po’ di bene', 'it-IT')).map((w) => w.word)).toEqual(['mondoo', 'un', 'di']);
    const asked = call.mock.calls.filter(([cmd]) => cmd === 'spell_check').flatMap(([, a]) => a.words);
    await checker.misspelled('ciao ciao mondoo', 'it-IT');
    expect(call.mock.calls.filter(([cmd]) => cmd === 'spell_check').flatMap(([, a]) => a.words)).toEqual(asked);
    checker.ignore('mondoo');
    expect((await checker.misspelled('mondoo bene', 'it')).map((w) => w.word)).toEqual([]);
    expect((await checker.misspelled('‘bene’', 'it')).map((w) => w.word)).toEqual([]);
    await checker.add('un');
    expect(call).toHaveBeenCalledWith('spell_add', { word: 'un' });
    expect((await checker.misspelled('un', 'it')).map((w) => w.word)).toEqual([]);
  });
});

describe('grammar', () => {
  const kinds = (text, lang) => grammarIssues(text, lang).map((i) => [i.kind, text.slice(i.from, i.to), i.replacement]);

  it('finds a word twice, extra spaces and a space before a mark', () => {
    expect(kinds('The the cat sat  on the mat , then left .', 'en')).toEqual([
      ['repeat', 'The the', 'The'], ['spaces', '  ', ' '], ['space-before', ' ,', ','], ['space-before', ' .', '.'],
    ]);
    expect(kinds('Bonjour : merci !', 'fr')).toEqual([]);
    expect(kinds('che che bello, no no', 'it')).toEqual([]);
  });

  it('wants a capital after a full stop, but not after a short form or a number', () => {
    expect(kinds('Done. then more! and? Yes, see fig. two, e.g. this, 3. item', 'en')).toEqual([
      ['capital', 'then', 'Then'], ['capital', 'and', 'And'],
    ]);
    expect(kinds('Fine. iPhone too.', 'en')).toEqual([]);
  });

  it('finds brackets and quotes left open or closing nothing, and knows an apostrophe', () => {
    // The ) closes the (, so the [ and the “ are what stay open.
    expect(kinds('(one [two) “three', 'en').map(([k, t]) => [k, t])).toEqual([['unclosed', '['], ['unclosed', '“']]);
    expect(kinds('a) b', 'en').map(([k, t]) => [k, t])).toEqual([['unopened', ')']]);
    expect(kinds('l’amico e ‘citazione’', 'it')).toEqual([]);
    expect(kinds('‘aperta e l’altro', 'it').map(([k, t]) => [k, t])).toEqual([['unclosed', '‘']]);
  });
});
