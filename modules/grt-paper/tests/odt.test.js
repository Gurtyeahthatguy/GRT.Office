// @vitest-environment jsdom

/** OpenDocument text: what Paper writes comes back as it was. */

import { describe, it, expect } from 'vitest';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { sample, shape } from './samples.js';

function throughPackage(entries) {
  return decodeBlock(encodeBlock(entries));
}

describe('a document written as .odt', () => {
  it('comes back with every block as it was', () => {
    const { model, images } = sample();
    const { entries } = writeOdt(model.toJSON(), images);
    const back = readOdt(throughPackage(entries));
    expect(shape(back.document, back.images)).toEqual(shape(model.toJSON(), images));
  });

  it('comes back with its page, headers and footers', () => {
    const { model, images } = sample();
    const back = readOdt(throughPackage(writeOdt(model.toJSON(), images).entries));
    expect(back.document.page.size).toBe('Letter');
    expect(back.document.page.orientation).toBe('landscape');
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(back.document.page.margins[side]).toBeCloseTo(model.page.margins[side], 0);
    }
    expect(back.document.page.running).toEqual(model.page.running);
  });

  it('carries its pictures, byte for byte', () => {
    const { model, images } = sample();
    const back = readOdt(throughPackage(writeOdt(model.toJSON(), images).entries));
    expect([...back.images.values()]).toEqual([...images.values()]);
  });

  it('keeps a page size of its own, and names one it knows', () => {
    const { model, images } = sample();
    model.setPage({ size: 'custom', width: 123.4, height: 187.6 });
    const custom = readOdt(throughPackage(writeOdt(model.toJSON(), images).entries)).document.page;
    expect(custom).toMatchObject({ size: 'custom', width: 123.4, height: 187.6, orientation: 'landscape' });
    model.setPage({ size: 'A6' });
    expect(readOdt(throughPackage(writeOdt(model.toJSON(), images).entries)).document.page.size).toBe('A6');
  });

  it('comes back with its styles', () => {
    const { model, images } = sample();
    model.setStyle('h2', { size: 17.5, italic: true, spaceBefore: 14 });
    const back = readOdt(throughPackage(writeOdt(model.toJSON(), images).entries));
    expect(back.document.styles.h2).toMatchObject({ size: 17.5, italic: true, bold: true, spaceBefore: 14 });
    expect(back.document.styles.code.font).toBe('mono');
    expect(back.document.styles.h1.font).toBe('sans');
  });

  it('reports nothing lost', () => {
    const { model, images } = sample();
    expect(readOdt(throughPackage(writeOdt(model.toJSON(), images).entries)).losses.lines()).toEqual([]);
  });

  it('is the same, byte for byte, written twice', () => {
    const { model, images } = sample();
    const first = encodeBlock(writeOdt(model.toJSON(), images).entries);
    const second = encodeBlock(writeOdt(model.toJSON(), images).entries);
    expect(first).toEqual(second);
  });

  it('puts the mimetype first, stored, and carries no metadata', () => {
    const { model, images } = sample();
    const { entries } = writeOdt(model.toJSON(), images);
    expect(entries[0]).toEqual({ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true });
    const names = entries.map((entry) => entry.name);
    expect(names).not.toContain('meta.xml');
    expect(names.at(-1)).toBe('META-INF/manifest.xml');
    const text = entries.map((entry) => (typeof entry.data === 'string' ? entry.data : '')).join('');
    expect(text).not.toMatch(/meta:|dc:creator|dc:date|initial-creator|generator/);
  });
});

describe('a document written as .fodt', () => {
  it('comes back as it was, pictures inside', () => {
    const { model, images } = sample();
    const { text } = writeOdt(model.toJSON(), images, { flat: true });
    const back = readOdt(text);
    expect(shape(back.document, back.images)).toEqual(shape(model.toJSON(), images));
    expect(back.document.page.running).toEqual(model.page.running);
    expect([...back.images.values()]).toEqual([...images.values()]);
  });
});

describe('CANARY', () => {
  it('a changed document does not compare equal', () => {
    const { model, images } = sample();
    const back = readOdt(throughPackage(writeOdt(model.toJSON(), images).entries));
    back.document.blocks[1].runs[1].bold = false;
    expect(shape(back.document, back.images)).not.toEqual(shape(model.toJSON(), images));
  });
});
