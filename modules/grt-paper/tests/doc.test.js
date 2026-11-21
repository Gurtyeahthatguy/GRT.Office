// @vitest-environment jsdom

/** Word 97 documents: what Paper writes LibreOffice reads, what LibreOffice writes Paper reads, and damaged files are refused. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readDoc, writeDoc } from '../src/js/core/formats/doc.js';
import { readCfb, writeCfb } from '../src/js/core/formats/cfb.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { encodeBlock, decodeBlock } from '../src/js/core/package.js';
import { DocumentModel, OBJECT, runsText } from '../src/js/core/editor/model.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function sample() {
  return new DocumentModel({ blocks: [
    { kind: 'heading', level: 1, runs: [{ text: 'Titolo' }] },
    { kind: 'paragraph', runs: [{ text: 'Testo ' }, { text: 'grassetto', bold: true }, { text: ' e ' }, { text: 'rosso', color: '#ff0000', italic: true }, { text: ' con nota' }, { text: OBJECT, object: { type: 'note', kind: 'foot', runs: [{ text: 'La nota.' }] } }, { text: ', più ' }, { text: 'sopra', sup: true }] },
    { kind: 'heading', level: 2, runs: [{ text: 'Sezione' }] },
    { kind: 'list', listType: 'number', items: [{ level: 0, runs: [{ text: 'uno' }] }, { level: 0, runs: [{ text: 'due' }] }] },
    { kind: 'table', rows: [{ cells: [{ runs: [{ text: 'A1' }] }, { runs: [{ text: 'B1' }] }] }, { cells: [{ runs: [{ text: 'A2' }] }, { runs: [{ text: 'B2', bold: true }] }] }] },
    { kind: 'paragraph', align: 'center', runs: [{ text: 'Centrato' }] },
  ] }).toJSON();
}

const texts = (blocks) => blocks.flatMap((b) => (b.kind === 'table' ? b.rows.flatMap((r) => r.cells.map((c) => runsText(c.runs))) : b.kind === 'list' ? b.items.map((i) => runsText(i.runs)) : [runsText(b.runs ?? [])])).map((t) => t.replace(/￼/g, '').trim()).filter(Boolean);

function check(doc) {
  const blocks = doc.blocks;
  expect(texts(blocks)).toEqual(expect.arrayContaining(['Titolo', 'Sezione', 'A1', 'B2', 'Centrato']));
  expect(blocks.find((b) => b.kind === 'heading' && runsText(b.runs) === 'Titolo').level).toBe(1);
  expect(blocks.find((b) => b.kind === 'heading' && runsText(b.runs) === 'Sezione').level).toBe(2);
  const para = blocks.find((b) => b.kind === 'paragraph' && runsText(b.runs).startsWith('Testo'));
  expect(para.runs.find((r) => r.text === 'grassetto').bold).toBe(true);
  expect(para.runs.find((r) => r.text === 'rosso')).toMatchObject({ italic: true, color: '#ff0000' });
  expect(para.runs.find((r) => r.text === 'sopra').sup).toBe(true);
  const note = para.runs.find((r) => r.object?.type === 'note');
  expect(runsText(note.object.runs).trim()).toBe('La nota.');
  const table = blocks.find((b) => b.kind === 'table');
  expect(table.rows.map((r) => r.cells.map((c) => runsText(c.runs)))).toEqual([['A1', 'B1'], ['A2', 'B2']]);
  expect(blocks.find((b) => runsText(b.runs ?? []) === 'Centrato').align).toBe('center');
}

describe('Word 97 documents', () => {
  it('come back as Paper wrote them, the lists as numbered paragraphs', () => {
    const { bytes, losses } = writeDoc(sample());
    check(readDoc(bytes).document);
    expect(losses.lines().join()).toMatch(/Lists/);
  });

  it('refuse damaged files quickly, with an error and nothing else', () => {
    const good = writeDoc(sample()).bytes;
    let seed = 11;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const started = Date.now();
    for (let n = 0; n < 300; n += 1) {
      const bad = good.slice();
      for (let k = 0; k < 20; k += 1) bad[Math.floor(random() * bad.length)] = Math.floor(random() * 256);
      try { readDoc(bad); } catch (error) { expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(RangeError); }
    }
    expect(Date.now() - started).toBeLessThan(20000);
  });

  it('read a piece that claims more text than the file holds only as far as the file goes', () => {
    const streams = readCfb(writeDoc(sample()).bytes);
    const word = streams.get('WordDocument');
    const wv = new DataView(word.buffer, word.byteOffset, word.byteLength);
    const table = streams.get(wv.getUint16(10, true) & 0x0200 ? '1Table' : '0Table');
    const lwAt = 34 + wv.getUint16(32, true) * 2;
    const fcAt = lwAt + 2 + wv.getUint16(lwAt, true) * 4;
    let at = wv.getUint32(fcAt + 2 + 33 * 8, true);
    while (table[at] === 0x01) at += 3 + new DataView(table.buffer, table.byteOffset).getInt16(at + 1, true);
    // The end of the first piece, pushed past forty million characters.
    new DataView(table.buffer, table.byteOffset).setUint32(at + 5 + 4, 40_000_000, true);
    const bad = writeCfb(streams);
    const started = Date.now();
    const read = readDoc(bad);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(texts(read.document.blocks).join('').length).toBeLessThan(10000);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Word 97 documents', () => {
  it('reads what Paper writes as Paper wrote it', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'paper.doc');
      writeFileSync(file, writeDoc(sample()).bytes);
      check(readOdt(decodeBlock(readBlock(convert(file, 'odt', join(dir, 'odt'))))).document);
    } finally { cleanup(dir); }
  }, 120000);

  it('writes a Word 97 template that LibreOffice reads as one', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'paper.dot');
      const bytes = writeDoc(sample(), { template: true }).bytes;
      writeFileSync(file, bytes);
      expect(readDoc(bytes).document.blocks.length).toBe(readDoc(writeDoc(sample()).bytes).document.blocks.length);
      check(readOdt(decodeBlock(readBlock(convert(file, 'odt', join(dir, 'odt'))))).document);
    } finally { cleanup(dir); }
  }, 120000);

  it('writes what Paper reads, lists and pictures included', () => {
    const dir = scratch();
    try {
      const doc = sample();
      doc.blocks.push({ kind: 'image', resource: 'resources/dot.png', w: 40, h: 40, caption: [] });
      const file = join(dir, 'paper.odt');
      writeBlock(encodeBlock(writeOdt(doc, new Map([['resources/dot.png', PNG]])).entries), file);
      const read = readDoc(new Uint8Array(readFileSync(convert(file, 'doc:MS Word 97', join(dir, 'doc')))));
      check(read.document);
      const list = read.document.blocks.find((b) => b.kind === 'list');
      expect(list.listType).toBe('number');
      expect(list.items.map((i) => runsText(i.runs))).toEqual(['uno', 'due']);
      expect([...read.images.values()][0].slice(0, 4)).toEqual(PNG.slice(0, 4));
    } finally { cleanup(dir); }
  }, 120000);
});
