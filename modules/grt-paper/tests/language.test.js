// @vitest-environment jsdom

/** The language of text: kept in the model, set for a selection, a paragraph or all, and carried through .odt and .docx. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { DocumentModel, makeBlock, cleanLang, normaliseRuns } from '../src/js/core/editor/model.js';
import { point } from '../src/js/core/editor/selection.js';
import { setLanguage, scopeSelection } from '../src/js/core/language.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';

function documentOf(...texts) {
  const model = new DocumentModel();
  model.blocks = texts.map((text) => {
    const block = makeBlock('paragraph');
    block.runs = [{ text }];
    return block;
  });
  return model;
}

describe('languages in the model', () => {
  it('keeps tags it understands, written one way', () => {
    expect(['it-IT', 'it_it', 'EN', 'zxx', 'de-CH', 'es-419'].map(cleanLang)).toEqual(['it-IT', 'it-IT', 'en', 'zxx', 'de-CH', 'es-419']);
    expect(['', 'italiano', 'it-IT;x', 42, '../x'].map(cleanLang)).toEqual([null, null, null, null, null]);
    expect(normaliseRuns([{ text: 'a', lang: 'it-IT' }, { text: 'b', lang: 'it-IT' }, { text: 'c' }])).toEqual([{ text: 'ab', lang: 'it-IT' }, { text: 'c' }]);
  });

  it('sets the language of a selection, its paragraph, or all text, and takes it away', () => {
    const model = documentOf('Ciao mondo', 'Hello world');
    const [a, b] = model.blocks;
    setLanguage(model, { anchor: point(a.id, 5), focus: point(a.id, 10) }, 'selection', 'it-IT');
    expect(a.runs).toEqual([{ text: 'Ciao ' }, { text: 'mondo', lang: 'it-IT' }]);
    setLanguage(model, { anchor: point(b.id, 2), focus: point(b.id, 2) }, 'paragraph', 'en-GB');
    expect(b.runs).toEqual([{ text: 'Hello world', lang: 'en-GB' }]);
    setLanguage(model, null, 'all', 'zxx');
    expect(model.blocks.map((x) => x.runs)).toEqual([[{ text: 'Ciao mondo', lang: 'zxx' }], [{ text: 'Hello world', lang: 'zxx' }]]);
    setLanguage(model, null, 'all', '');
    expect(model.blocks.map((x) => x.runs)).toEqual([[{ text: 'Ciao mondo' }], [{ text: 'Hello world' }]]);
    expect(setLanguage(model, { anchor: point(a.id, 1), focus: point(a.id, 1) }, 'selection', 'it-IT')).toBe(false);
    expect(scopeSelection(model, null, 'paragraph')).toBeNull();
  });
});

const sample = () => {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: [{ id: 'b', kind: 'paragraph', style: 'body', align: 'left',
    runs: [{ text: 'Plain, ' }, { text: 'in italiano, ', lang: 'it-IT' }, { text: 'not checked', lang: 'zxx' }] }] });
  return model;
};
const langs = (document) => document.blocks[0].runs.map((r) => [r.text, r.lang ?? null]);
const WANTED = [['Plain, ', null], ['in italiano, ', 'it-IT'], ['not checked', 'zxx']];

describe('languages in files', () => {
  it('travel through .odt and .docx', () => {
    for (const [write, read] of [[writeOdt, readOdt], [writeDocx, readDocx]]) {
      const back = new DocumentModel(read(decodeBlock(encodeBlock(write(sample().toJSON()).entries))).document).toJSON();
      expect(langs(back)).toEqual(WANTED);
    }
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and languages', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('keeps each stretch\'s language through files it saves again', () => {
    for (const [ext, write, read, filter] of [['odt', writeOdt, readOdt, 'odt'], ['docx', writeDocx, readDocx, 'docx:MS Word 2007 XML']]) {
      const file = join(dir, `lang.${ext}`);
      writeBlock(encodeBlock(write(sample().toJSON()).entries), file);
      const saved = convert(file, filter, join(dir, `out-${ext}`));
      expect(langs(new DocumentModel(read(decodeBlock(readBlock(saved))).document).toJSON())).toEqual(WANTED);
    }
  });
});
