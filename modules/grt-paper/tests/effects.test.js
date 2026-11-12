// @vitest-environment jsdom

/** Font effects, case changes and size steps: in the editor, and through .odt, .docx and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { point } from '../src/js/core/editor/selection.js';
import { transformCase, resizeText } from '../src/js/core/editor/commands.js';
import { changeCase, stepSize } from '../src/js/core/text-case.js';
import { searchCharacters } from '../src/js/core/special-chars.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const EFFECTS = ['double', 'overline', 'shadow', 'outline', 'smallcaps'];
const sample = () => new DocumentModel({ blocks: [{ kind: 'paragraph', runs: EFFECTS.map((mark) => ({ text: `${mark} `, [mark]: true })).concat([{ text: 'plain' }]) }] });
const marksOf = (document) => document.blocks[0].runs.filter((r) => r.text.trim()).map((r) => [r.text.trim(), EFFECTS.filter((m) => r[m])]);
const want = [...EFFECTS.map((m) => [m, [m]]), ['plain', []]];
const through = (entries) => decodeBlock(encodeBlock(entries));

describe('case changes', () => {
  it('give each of LibreOffice\'s forms', () => {
    expect(changeCase('hello wORLD. again', 'upper')).toBe('HELLO WORLD. AGAIN');
    expect(changeCase('Hello World', 'lower')).toBe('hello world');
    expect(changeCase('hello wORLD. again', 'sentence')).toBe('Hello world. Again');
    expect(changeCase('hello wORLD élan', 'title')).toBe('Hello World Élan');
    expect(changeCase('Hello', 'toggle')).toBe('hELLO');
    expect(['lower', 'sentence', 'title', 'upper'].reduce((t) => changeCase(t, 'cycle'), 'two words')).toBe('two words');
  });

  it('keep the formatting of each run in the document', () => {
    const model = new DocumentModel({ blocks: [{ kind: 'paragraph', runs: [{ text: 'big ', bold: true }, { text: 'Straße' }] }] });
    const id = model.blocks[0].id;
    const after = transformCase(model, { anchor: point(id, 0), focus: point(id, 10) }, 'upper');
    expect(model.blocks[0].runs).toEqual([{ text: 'BIG ', bold: true }, { text: 'STRASSE' }]);
    expect(after.focus.offset).toBe(11);
  });
});

describe('size steps', () => {
  it('follow LibreOffice\'s list of sizes', () => {
    expect([stepSize(11, 1), stepSize(12, -1), stepSize(96, 1), stepSize(6, -1)]).toEqual([12, 11, 106, 5]);
    const model = new DocumentModel({ blocks: [{ kind: 'paragraph', runs: [{ text: 'abc' }] }] });
    const id = model.blocks[0].id;
    resizeText(model, { anchor: point(id, 0), focus: point(id, 3) }, 1, () => 11);
    expect(model.blocks[0].runs).toEqual([{ text: 'abc', size: 12 }]);
  });
});

describe('special characters', () => {
  it('are found by their code or typed', () => {
    expect(searchCharacters('U+20AC')).toEqual(['€']);
    expect(searchCharacters('00e9')).toEqual(['é']);
    expect(searchCharacters('ab a')).toEqual(['a', 'b', ' ']);
  });
});

describe('font effects through the formats', () => {
  it('come back from .odt; .docx keeps all but overline, and says so', () => {
    expect(marksOf(readOdt(through(writeOdt(sample().toJSON()).entries)).document)).toEqual(want);
    const docx = writeDocx(sample().toJSON());
    expect(docx.losses.lines().join()).toMatch(/Overline/);
    expect(marksOf(readDocx(through(docx.entries)).document)).toEqual(want.map(([t, m]) => [t, m.filter((x) => x !== 'overline')]));
  });

  it.skipIf(!oracleAvailable())('come back from LibreOffice', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `effects.${format}`);
        writeBlock(encodeBlock(write(sample().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        const expected = format === 'odt' ? want : want.map(([t, m]) => [t, m.filter((x) => x !== 'overline')]);
        expect(marksOf(read(decodeBlock(readBlock(saved))).document), format).toEqual(expected);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
