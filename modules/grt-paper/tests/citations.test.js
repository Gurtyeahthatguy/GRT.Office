// @vitest-environment jsdom

/** Citations: kept with what they cite through .odt and .docx, and read back by LibreOffice from .odt. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const CITE = { type: 'cite', key: 'Doe2020', kind: 'book', author: 'Doe, Jane', title: 'On Foxes', year: '2020', publisher: 'Acme', url: 'https://example.org/foxes' };
function doc() {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: [{ id: 'b', kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: 'See ' }, { text: '￼', object: CITE }, { text: ' for more.' }] }] });
  return model;
}
const cites = (document) => document.blocks.flatMap((b) => b.runs ?? []).filter((r) => r.object?.type === 'cite').map((r) => r.object);
const text = (document) => document.blocks.flatMap((b) => b.runs ?? []).filter((r) => !r.object).map((r) => r.text).join('');

describe('citations', () => {
  it('are held to a short name and the fields a source has', () => {
    const model = new DocumentModel();
    model.load({ version: 1, type: 'paper', blocks: [{ id: 'b', kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: '￼', object: { type: 'cite', key: 'a b<c>', kind: 'spell', title: 'x'.repeat(900), evil: 1 } }] }] });
    expect(cites(model.toJSON())).toEqual([{ type: 'cite', key: 'abc', kind: 'book', title: 'x'.repeat(500) }]);
  });

  it('go through .odt and .docx with what they cite', () => {
    for (const [write, read] of [[writeOdt, readOdt], [writeDocx, readDocx]]) {
      const back = new DocumentModel(read(decodeBlock(encodeBlock(write(doc().toJSON()).entries))).document).toJSON();
      expect(cites(back)).toEqual([CITE]);
      expect(text(back)).toBe('See  for more.');
    }
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and citations', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('keeps a citation and its source through an .odt it saves again', () => {
    const file = join(dir, 'cite.odt');
    writeBlock(encodeBlock(writeOdt(doc().toJSON()).entries), file);
    const saved = convert(file, 'odt', join(dir, 'again'));
    expect(cites(new DocumentModel(readOdt(decodeBlock(readBlock(saved))).document).toJSON())).toEqual([CITE]);
  }, 120000);
});
