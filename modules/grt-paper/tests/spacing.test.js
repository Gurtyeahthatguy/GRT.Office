// @vitest-environment jsdom

/** A paragraph's own line spacing, spacing and indent: set, drawn, and kept through the formats and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel, normalisePara } from '../src/js/core/editor/model.js';
import { Renderer } from '../src/js/core/editor/render.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

function spaced() {
  const model = new DocumentModel({ blocks: [
    { kind: 'paragraph', runs: [{ text: 'Plain' }] },
    { kind: 'paragraph', runs: [{ text: 'Double' }] },
    { kind: 'paragraph', runs: [{ text: 'Indented' }] },
  ] });
  model.setPara(model.blocks[1].id, { lineHeight: 2.3, spaceBefore: 12, spaceAfter: 18 });
  model.setPara(model.blocks[2].id, { indent: 36 });
  return model;
}

/** Each paragraph's own spacing, rounded as files keep it. */
function summary(document) {
  return new DocumentModel(document).blocks.map((b) => {
    const p = b.para ?? {};
    return {
      text: b.runs.map((r) => r.text).join(''),
      lineHeight: p.lineHeight ? Math.round(p.lineHeight * 10) / 10 : null,
      before: p.spaceBefore ? Math.round(p.spaceBefore) : null,
      after: p.spaceAfter ? Math.round(p.spaceAfter) : null,
      indent: p.indent ? Math.round(p.indent) : null,
    };
  });
}

const want = [
  { text: 'Plain', lineHeight: null, before: null, after: null, indent: null },
  { text: 'Double', lineHeight: 2.3, before: 12, after: 18, indent: null },
  { text: 'Indented', lineHeight: null, before: null, after: null, indent: 36 },
];

describe('a paragraph own spacing', () => {
  it('is kept within bounds and taken away with null', () => {
    expect(normalisePara({ lineHeight: 99, spaceBefore: -4, indent: 'x' })).toEqual({ lineHeight: 4, spaceBefore: 0 });
    expect(normalisePara({})).toBe(null);
    const model = spaced();
    model.setPara(model.blocks[2].id, { indent: null });
    expect(model.blocks[2].para).toBeUndefined();
    expect(new DocumentModel({ blocks: [{ kind: 'paragraph', runs: [{ text: 'x' }], para: { lineHeight: 'tall' } }] }).blocks[0].para).toBeUndefined();
  });

  it('is drawn over the style', () => {
    const surface = document.createElement('div');
    new Renderer(surface).draw(spaced());
    const [, double, indented] = surface.querySelectorAll('p');
    expect(double.style.lineHeight).toBe('2.3');
    expect(double.style.marginTop).toBe('16px');
    expect(indented.style.paddingLeft).toBe('48px');
  });

  it('comes back from .odt and .docx', () => {
    expect(summary(readOdt(decodeBlock(encodeBlock(writeOdt(spaced().toJSON()).entries))).document)).toEqual(want);
    expect(summary(readDocx(decodeBlock(encodeBlock(writeDocx(spaced().toJSON()).entries))).document)).toEqual(want);
  });

  it.skipIf(!oracleAvailable())('comes back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `spaced.${format}`);
        writeBlock(encodeBlock(write(spaced().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(summary(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});

function titled() {
  return new DocumentModel({ blocks: [
    { kind: 'paragraph', style: 'title', align: 'center', runs: [{ text: 'The report' }] },
    { kind: 'paragraph', style: 'subtitle', align: 'center', runs: [{ text: 'For the year' }] },
    { kind: 'paragraph', style: 'hr', runs: [{ text: '' }] },
    { kind: 'heading', level: 1, runs: [{ text: 'Start' }] },
  ] });
}

const plainStyles = (document) => new DocumentModel(document).blocks.map((b) => [b.kind, b.style]);

describe('Title, Subtitle and Horizontal Line', () => {
  const want = [['paragraph', 'title'], ['paragraph', 'subtitle'], ['paragraph', 'hr'], ['heading', 'h1']];

  it('draw the line under a horizontal line', () => {
    const surface = document.createElement('div');
    new Renderer(surface).draw(titled());
    expect(surface.querySelectorAll('p')[2].style.borderBottom).toContain('solid');
  });

  it('come back from .odt and .docx', () => {
    expect(plainStyles(readOdt(decodeBlock(encodeBlock(writeOdt(titled().toJSON()).entries))).document)).toEqual(want);
    expect(plainStyles(readDocx(decodeBlock(encodeBlock(writeDocx(titled().toJSON()).entries))).document)).toEqual(want);
  });

  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `titled.${format}`);
        writeBlock(encodeBlock(write(titled().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        const back = read(decodeBlock(readBlock(saved))).document;
        expect(plainStyles(back), format).toEqual(want);
        expect(new DocumentModel(back).styles.hr.rule, format).toBe(true);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
