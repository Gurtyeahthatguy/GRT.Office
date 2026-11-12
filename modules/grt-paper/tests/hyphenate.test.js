// @vitest-environment jsdom

/** Hyphenation by Liang's method, on a pattern file of the same form as LibreOffice's. */

import { describe, it, expect } from 'vitest';
import { parsePatterns, breakPoints, hyphenPlaces, SOFT_HYPHEN } from '../src/js/core/hyphenate.js';

// The patterns of Liang's thesis for "hyphenation", in a file as LibreOffice writes them.
const FILE = 'UTF-8\nLEFTHYPHENMIN 2\nRIGHTHYPHENMIN 3\nhy3ph\nhe2n\nhena4\nhen5at\n1na\nn2at\n1tio\n2io\no2n\nNEXTLEVEL\nab/c=d,1,1\n';
const show = (word, compiled) => {
  let out = word;
  for (const at of breakPoints(word, compiled).reverse()) out = `${out.slice(0, at)}-${out.slice(at)}`;
  return out;
};

describe('hyphenation', () => {
  const compiled = parsePatterns(FILE);

  it('reads patterns and the letters each side must keep', () => {
    expect([compiled.left, compiled.right]).toEqual([2, 3]);
    expect(compiled.patterns.get('hyph')).toEqual([0, 0, 3, 0, 0]);
    expect(compiled.patterns.has('abc=d,1,1')).toBe(false);
  });

  it('breaks words where the patterns say, keeping the minimum on each side', () => {
    expect(show('hyphenation', compiled)).toBe('hy-phen-ation');
    expect(show('Hyphenation', compiled)).toBe('Hy-phen-ation');
    expect(show('hy', compiled)).toBe('hy');
  });

  it('places soft hyphens only in long words that have none', () => {
    const text = `a hyphenation and hy${SOFT_HYPHEN}phenation`;
    const places = hyphenPlaces(text, compiled, { minLength: 6 });
    expect(places).toEqual([4, 8]);
  });
});

describe('Italian, with the patterns GRT carries', async () => {
  const { readFileSync } = await import('node:fs');
  const italian = parsePatterns(readFileSync(`${process.cwd()}/../../core/dictionaries/hyph_it_IT.dic`, 'utf8'));

  it('breaks Italian words by their syllables', () => {
    expect(['parola', 'sillabazione', 'programma', 'dell’albero', 'aiuola'].map((w) => show(w, italian)))
      .toEqual(['pa-ro-la', 'sil-la-ba-zio-ne', 'pro-gram-ma', 'del-l’al-be-ro', 'aiuo-la']);
  });
});

describe('hyphenating a document', async () => {
  const { DocumentModel, makeBlock, normaliseRuns, itemIndices } = await import('../src/js/core/editor/model.js');
  const { applyEdits } = await import('../src/js/core/autocorrect.js');
  const { hyphenateBlocks } = await import('../src/js/core/hyphenate.js');
  const { writeDocx } = await import('../src/js/core/formats/docx-write.js');
  const { readDocx } = await import('../src/js/core/formats/docx-read.js');
  const { encodeBlock, decodeBlock } = await import('../src/js/core/package.js');
  const { readFileSync } = await import('node:fs');
  const italian = parsePatterns(readFileSync(`${process.cwd()}/../../core/dictionaries/hyph_it_IT.dic`, 'utf8'));
  const tools = { applyEdits, normaliseRuns, itemIndices };

  it('puts soft hyphens in long words, keeps each run its look, leaves other languages, and takes them away again', () => {
    const model = new DocumentModel();
    const block = makeBlock('paragraph');
    block.runs = [{ text: 'una ' }, { text: 'sillabazione', bold: true }, { text: ' e ' }, { text: 'Rechtschreibung', lang: 'de-DE' }];
    model.blocks = [block];
    const only = (lang) => (lang.startsWith('it') ? italian : null);
    const result = hyphenateBlocks(model, model.blocks, only, 'it-IT', { minLength: 6, ...tools });
    expect(result).toEqual({ changed: 1, hyphens: 4, skipped: 0 });
    expect(model.blocks[0].runs.map((r) => r.text.replaceAll(SOFT_HYPHEN, '-'))).toEqual(['una ', 'sil-la-ba-zio-ne', ' e ', 'Rechtschreibung']);
    expect(model.blocks[0].runs[1].bold).toBe(true);
    // Done twice, nothing is added: the words have their marks.
    expect(hyphenateBlocks(model, model.blocks, only, 'it-IT', { ...tools }).hyphens).toBe(0);
    const back = new DocumentModel(readDocx(decodeBlock(encodeBlock(writeDocx(model.toJSON()).entries))).document);
    expect(back.blocks[0].runs.map((r) => r.text).join('')).toBe(model.blocks[0].runs.map((r) => r.text).join(''));
    hyphenateBlocks(model, model.blocks, () => italian, 'it-IT', { remove: true, ...tools });
    expect(model.blocks[0].runs.map((r) => r.text).join('')).toBe('una sillabazione e Rechtschreibung');
  });
});
