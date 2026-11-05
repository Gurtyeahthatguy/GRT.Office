// @vitest-environment jsdom

/** Heading numbers, how notes count and notes with a character of their own: drawn, and kept through the formats and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel, OBJECT } from '../src/js/core/editor/model.js';
import { documentFields, formatNumber } from '../src/js/core/editor/fields.js';
import { Renderer } from '../src/js/core/editor/render.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const note = (text, extra = {}) => ({ text: OBJECT, object: { type: 'note', kind: 'foot', runs: [{ text }], ...extra } });

function numbered() {
  return new DocumentModel({
    headingNumbers: { format: 'decimal', full: true, after: '.', depth: 3 },
    noteSettings: { foot: { format: 'lower-alpha', start: 3 } },
    blocks: [
      { kind: 'heading', level: 1, runs: [{ text: 'Start' }] },
      { kind: 'paragraph', runs: [{ text: 'One' }, note('first'), { text: ' two' }, note('starred', { mark: '*' }), { text: ' three' }, note('second')] },
      { kind: 'heading', level: 2, runs: [{ text: 'Detail' }] },
      { kind: 'heading', level: 1, runs: [{ text: 'Next' }] },
    ],
  });
}

/** What the document says about numbers, as files keep it. */
function summary(document) {
  const model = new DocumentModel(document);
  const fields = documentFields(model);
  return {
    numbers: model.headingNumbers,
    headings: fields.headings.map((h) => h.number),
    notes: fields.footnotes.map((f) => f.label),
    texts: fields.footnotes.map((f) => f.object.runs.map((r) => r.text).join('').trim()),
  };
}

const want = {
  numbers: { format: 'decimal', full: true, after: '.', depth: 3 },
  headings: ['1.', '1.1.', '2.'],
  notes: ['c', '*', 'd'],
  texts: ['first', 'starred', 'second'],
};

describe('numbers', () => {
  it('are written in each format', () => {
    expect([1, 4, 27, 53].map((n) => formatNumber(n, 'upper-alpha'))).toEqual(['A', 'D', 'AA', 'AAA']);
    expect(formatNumber(14, 'upper-roman')).toBe('XIV');
    expect(formatNumber(3, 'lower-alpha')).toBe('c');
  });

  it('count headings and notes, a special mark taking none', () => {
    expect(summary(numbered().toJSON())).toEqual(want);
  });

  it('show only the last level when asked, and stop at the depth', () => {
    const model = numbered();
    model.headingNumbers = { format: 'upper-roman', full: false, after: '', depth: 1 };
    expect(documentFields(model).headings.map((h) => h.number)).toEqual(['I', null, 'II']);
  });

  it('are drawn before the heading and in the contents', () => {
    const model = numbered();
    model.blocks.unshift({ id: 'toc', kind: 'toc', style: 'body', align: 'left', title: 'Contents', levels: 3 });
    const surface = document.createElement('div');
    new Renderer(surface).draw(model);
    expect(surface.querySelector('h2').dataset.number).toBe('1.1.');
    expect(surface.querySelector('.generated-line').textContent).toContain('1. Start');
  });

  it('come back from .odt and .docx', () => {
    expect(summary(readOdt(decodeBlock(encodeBlock(writeOdt(numbered().toJSON()).entries))).document)).toEqual(want);
    expect(summary(readDocx(decodeBlock(encodeBlock(writeDocx(numbered().toJSON()).entries))).document)).toEqual(want);
  });

  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `numbered.${format}`);
        writeBlock(encodeBlock(write(numbered().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(summary(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
