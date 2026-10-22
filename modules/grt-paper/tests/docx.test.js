// @vitest-environment jsdom

/** Word documents: what Paper writes comes back as it was. */

import { describe, it, expect } from 'vitest';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';

import { sample, shape } from './samples.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

describe('a document written as .docx', () => {
  it('comes back with every block as it was', () => {
    const { model, images } = sample();
    const back = readDocx(through(writeDocx(model.toJSON(), images).entries));
    expect(shape(back.document, back.images)).toEqual(shape(model.toJSON(), images));
  });

  it('comes back with its page, headers and footers', () => {
    const { model, images } = sample();
    const back = readDocx(through(writeDocx(model.toJSON(), images).entries));
    expect(back.document.page.size).toBe('Letter');
    expect(back.document.page.orientation).toBe('landscape');
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(back.document.page.margins[side]).toBeCloseTo(model.page.margins[side], 0);
    }
    expect(back.document.page.running).toEqual(model.page.running);
  });

  it('keeps a page size of its own, and names one it knows', () => {
    const { model, images } = sample();
    model.setPage({ size: 'custom', width: 123.4, height: 187.6 });
    const custom = readDocx(through(writeDocx(model.toJSON(), images).entries)).document.page;
    expect(custom).toMatchObject({ size: 'custom', width: 123.4, height: 187.6, orientation: 'landscape' });
    model.setPage({ size: 'A6' });
    expect(readDocx(through(writeDocx(model.toJSON(), images).entries)).document.page.size).toBe('A6');
  });

  it('comes back with its styles', () => {
    const { model, images } = sample();
    model.setStyle('h2', { size: 17.5, italic: true, spaceBefore: 14 });
    const back = readDocx(through(writeDocx(model.toJSON(), images).entries));
    expect(back.document.styles.h2).toMatchObject({ size: 17.5, italic: true, bold: true, spaceBefore: 14 });
    expect(back.document.styles.code.font).toBe('mono');
  });

  it('reports nothing lost', () => {
    const { model, images } = sample();
    expect(readDocx(through(writeDocx(model.toJSON(), images).entries)).losses.lines()).toEqual([]);
  });

  it('is the same, byte for byte, written twice', () => {
    const { model, images } = sample();
    expect(encodeBlock(writeDocx(model.toJSON(), images).entries))
      .toEqual(encodeBlock(writeDocx(model.toJSON(), images).entries));
  });

  it('carries no document properties, author or dates', () => {
    const { model, images } = sample();
    const { entries } = writeDocx(model.toJSON(), images);
    const names = entries.map((entry) => entry.name);
    expect(names.some((name) => name.startsWith('docProps/'))).toBe(false);
    const text = entries.map((entry) => (typeof entry.data === 'string' ? entry.data : '')).join('');
    expect(text).not.toMatch(/dc:creator|lastModifiedBy|dcterms|w:rsid|Company|TotalTime/);
  });

  it('CANARY: a changed document does not compare equal', () => {
    const { model, images } = sample();
    const back = readDocx(through(writeDocx(model.toJSON(), images).entries));
    back.document.blocks[0].runs[0].text = 'Changed';
    expect(shape(back.document, back.images)).not.toEqual(shape(model.toJSON(), images));
  });
});


