// @vitest-environment jsdom

/** Mail merge: fields filled record by record, and kept as fields in .odt and .docx. */

import { describe, it, expect } from 'vitest';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { mergeFields, mergeRecord } from '../src/js/core/editor/merge.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';

function letter() {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: [{ id: 'b', kind: 'paragraph', style: 'body', align: 'left', runs: [
    { text: 'Dear ' }, { text: '￼', object: { type: 'merge', name: 'Name' }, bold: true }, { text: ', you owe ' }, { text: '￼', object: { type: 'merge', name: 'Amount' } }, { text: '.' },
  ] }] });
  return model;
}
const text = (json) => json.blocks[0].runs.map((r) => (r.object ? `«${r.object.name}»` : r.text)).join('');

describe('mail merge', () => {
  it('fills each field with its column, in the field\'s look, matching names whatever their case', () => {
    const json = letter().toJSON();
    expect(mergeFields(json)).toEqual(['Name', 'Amount']);
    const filled = mergeRecord(json, ['name', 'AMOUNT'], ['Ada', 12.5]);
    expect(text(filled)).toBe('Dear Ada, you owe 12.5.');
    expect(filled.blocks[0].runs.find((r) => r.text === 'Ada').bold).toBe(true);
    expect(text(mergeRecord(json, ['Name'], ['Bob']))).toBe('Dear Bob, you owe .');
  });

  it('keeps its fields as fields in .odt and .docx', () => {
    for (const [write, read] of [[writeOdt, readOdt], [writeDocx, readDocx]]) {
      const back = new DocumentModel(read(decodeBlock(encodeBlock(write(letter().toJSON()).entries))).document).toJSON();
      expect(text(back)).toBe('Dear «Name», you owe «Amount».');
    }
  });
});
