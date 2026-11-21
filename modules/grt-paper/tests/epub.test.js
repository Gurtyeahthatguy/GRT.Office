// @vitest-environment jsdom

/** Paper's books: EPUB 3 with chapters, notes, formulas, pictures and drawings, clean metadata, and epubcheck's approval. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { writeEpub, FIXED_DATE } from '../src/js/core/formats/epub.js';
import { encodeBlock } from '../src/js/core/package.js';
import { DocumentModel, OBJECT } from '../src/js/core/editor/model.js';
import { oracleAvailable, scratch, cleanup, writeBlock } from '../../../scripts/oracle.mjs';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const EPUBCHECK = join(homedir(), '.cache', 'grt-dev', 'tools', 'epubcheck-5.4.0', 'epubcheck.jar');

function book() {
  const model = new DocumentModel({
    blocks: [
      { id: 'h1', kind: 'heading', level: 1, runs: [{ text: 'First chapter' }] },
      { id: 'p1', kind: 'paragraph', runs: [{ text: 'Plain, ' }, { text: 'bold', bold: true }, { text: ' & a note' }, { text: OBJECT, object: { type: 'note', kind: 'foot', runs: [{ text: 'A footnote.' }] } }, { text: ' and a formula ' }, { text: OBJECT, object: { type: 'math', tex: 'x^2', mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup></math>' } }, { text: '.' }] },
      { id: 'l1', kind: 'list', listType: 'bullet', items: [{ level: 0, runs: [{ text: 'one' }] }, { level: 1, runs: [{ text: 'one and a half' }] }, { level: 0, runs: [{ text: 'two' }] }] },
      { id: 't1', kind: 'table', rows: [{ header: true, cells: [{ runs: [{ text: 'A' }] }, { runs: [{ text: 'B' }] }] }, { cells: [{ runs: [{ text: '1' }] }, { runs: [{ text: '2' }] }] }] },
      { id: 'i1', kind: 'image', resource: 'resources/dot.png', w: 50, h: 50, caption: [{ text: 'A dot' }] },
      { id: 'h2', kind: 'heading', level: 1, runs: [{ text: 'Second chapter' }] },
      { id: 'h3', kind: 'heading', level: 2, runs: [{ text: 'A section' }, { text: OBJECT, object: { type: 'bookmark', name: 'there' } }] },
      { id: 'p2', kind: 'paragraph', runs: [{ text: 'See ' }, { text: 'there', link: '#there' }, { text: ', and an endnote' }, { text: OBJECT, object: { type: 'note', kind: 'end', runs: [{ text: 'At the end.' }] } }] },
      { id: 'c1', kind: 'chart', type: 'column', data: { categories: ['a', 'b'], series: [{ name: 'S', values: [1, 2] }] }, w: 300, h: 200 },
    ],
    drawings: [{ id: 'd1', kind: 'shape', shape: 'ellipse', x: 0, y: 0, w: 80, h: 40, anchor: { type: 'paragraph', block: 'p2' }, wrap: 'after', text: 'Hi', description: 'An ellipse' }],
  });
  return { doc: model.toJSON(), images: new Map([['resources/dot.png', PNG]]) };
}

describe('a document as EPUB', () => {
  it('has the mimetype first and unpacked, a chapter for each first heading, and a table of contents', () => {
    const { doc, images } = book();
    const { entries } = writeEpub(doc, images, { title: 'A book', language: 'it' });
    expect(entries[0]).toEqual({ name: 'mimetype', data: 'application/epub+zip', store: true });
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml', 'OEBPS/notes.xhtml', 'OEBPS/nav.xhtml', 'OEBPS/images/picture1.png']));
    const nav = entries.find((e) => e.name === 'OEBPS/nav.xhtml').data;
    expect(nav).toContain('chapter2.xhtml#h-h3');
    const second = entries.find((e) => e.name === 'OEBPS/chapter2.xhtml').data;
    expect(second).toContain('href="notes.xhtml#note2"');
    expect(second).toContain('<svg');
  });

  it('says nothing about who made it or when, and gives the same bytes twice', () => {
    const { doc, images } = book();
    const a = writeEpub(doc, images, { title: 'A book' });
    const b = writeEpub(doc, images, { title: 'A book' });
    expect(JSON.stringify(a.entries.map((e) => [e.name, String(e.data)]))).toBe(JSON.stringify(b.entries.map((e) => [e.name, String(e.data)])));
    const opf = a.entries.find((e) => e.name === 'OEBPS/content.opf').data;
    expect(opf).toContain(FIXED_DATE);
    expect(opf).not.toMatch(/dc:creator|dc:contributor|generator/);
  });

  it.skipIf(!oracleAvailable() || !existsSync(EPUBCHECK))('passes epubcheck', () => {
    const { doc, images } = book();
    const dir = scratch();
    try {
      const file = join(dir, 'book.epub');
      writeBlock(encodeBlock(writeEpub(doc, images, { title: 'A book', author: 'Someone', language: 'en' }).entries), file);
      const run = spawnSync('java', ['-jar', EPUBCHECK, file], { encoding: 'utf8', timeout: 120000 });
      if (run.status !== 0) console.log(run.stdout, run.stderr);
      expect(run.status).toBe(0);
    } finally { cleanup(dir); }
  }, 180000);
});
