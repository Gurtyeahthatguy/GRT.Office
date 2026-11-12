// @vitest-environment jsdom

/** Writer's list commands: levels and moves with subpoints, unnumbered entries, restarts; through .odt, .docx and LibreOffice. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { shiftLevel, moveItems, toggleUnnumbered, toggleRestart, addToList, stepInLevel } from '../src/js/core/editor/lists.js';
import { point, collapsed } from '../src/js/core/editor/selection.js';
import { setBlockKind } from '../src/js/core/editor/commands.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const ITEMS = [['A', 0], ['A1', 1], ['A2', 1], ['B', 0], ['B1', 1], ['C', 0]];
function doc(listType = 'number') {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: [
    { id: 'l', kind: 'list', listType, style: 'body', align: 'left', items: ITEMS.map(([text, level]) => ({ level, runs: [{ text }] })) },
    { id: 'p', kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: 'D' }] },
  ] });
  return model;
}
const at = (i) => collapsed(point('l', 0, i));
const shape = (model) => model.block('l').items.map((item) => `${'-'.repeat(item.level)}${item.runs[0].text}${item.unnumbered ? '(u)' : ''}${item.restart ? '(r)' : ''}`);

describe('making a list', () => {
  it('of several paragraphs gives one list, the selection following its items', () => {
    const model = new DocumentModel();
    model.load({ version: 1, type: 'paper', blocks: ['a', 'b', 'c'].map((text) => ({ id: text, kind: 'paragraph', style: 'body', align: 'left', runs: [{ text }] })) });
    const after = setBlockKind(model, { anchor: point('a', 0), focus: point('c', 1) }, 'list', { listType: 'number' });
    expect(model.blocks.length).toBe(1);
    expect(model.blocks[0].items.map((i) => i.runs[0].text)).toEqual(['a', 'b', 'c']);
    expect(after.focus).toMatchObject({ blockId: 'a', itemIndex: 2, offset: 1 });
  });
});

describe('list items', () => {
  it('change level alone or with the items under them, keeping the group whole', () => {
    const model = doc();
    shiftLevel(model, at(3), 1, { withSub: true });
    expect(shape(model)).toEqual(['A', '-A1', '-A2', '-B', '--B1', 'C']);
    shiftLevel(model, at(0), -1);
    expect(shape(model)[0]).toBe('A');
  });

  it('move one at a time, or past whole groups with their subpoints', () => {
    const model = doc();
    const sel = moveItems(model, at(3), -1, { withSub: true });
    expect(shape(model)).toEqual(['B', '-B1', 'A', '-A1', '-A2', 'C']);
    expect(sel.anchor.itemIndex).toBe(0);
    moveItems(model, at(0), 1, { withSub: true });
    expect(shape(model)).toEqual(['A', '-A1', '-A2', 'B', '-B1', 'C']);
    moveItems(model, at(1), 1);
    expect(shape(model)).toEqual(['A', '-A2', '-A1', 'B', '-B1', 'C']);
  });

  it('are left unnumbered, restart the count, take in the paragraph below and step by level', () => {
    const model = doc();
    toggleUnnumbered(model, at(1));
    toggleRestart(model, at(3));
    expect(shape(model)).toEqual(['A', '-A1(u)', '-A2', 'B(r)', '-B1', 'C']);
    expect(stepInLevel(model, at(0), 1).anchor.itemIndex).toBe(3);
    expect(stepInLevel(model, at(1), 1).anchor.itemIndex).toBe(2);
    expect(stepInLevel(model, at(5), -1).anchor.itemIndex).toBe(3);
    addToList(model, collapsed(point('p', 0)));
    expect(shape(model).at(-1)).toBe('D');
    expect(model.blocks.length).toBe(1);
  });
});

function marked() {
  const model = doc();
  toggleUnnumbered(model, at(2));
  toggleRestart(model, at(3));
  return model;
}

describe('list items in files', () => {
  it('keep their marks through .odt and .docx', () => {
    const want = shape(marked());
    for (const [write, read] of [[writeOdt, readOdt], [writeDocx, readDocx]]) {
      const back = new DocumentModel(read(decodeBlock(encodeBlock(write(marked().toJSON()).entries))).document);
      back.blocks[0].id = 'l';
      expect(shape(back)).toEqual(want);
    }
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and list items', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  // Word has no entry without a number; LibreOffice reads one from a .docx as a paragraph after the list, so from .docx only the restart is checked.
  it('reads the marks from .odt and .docx and writes them back the same', () => {
    const restartOnly = () => {
      const model = doc();
      toggleRestart(model, at(3));
      return model;
    };
    for (const [format, write, filter, read, make] of [
      ['odt', writeOdt, 'docx:MS Word 2007 XML', readDocx, marked],
      ['docx', writeDocx, 'odt', readOdt, restartOnly],
    ]) {
      const want = shape(make());
      const file = join(dir, `list.${format}`);
      writeBlock(encodeBlock(write(make().toJSON()).entries), file);
      const saved = convert(file, filter, join(dir, `from-${format}`));
      const back = new DocumentModel(read(decodeBlock(readBlock(saved))).document);
      back.blocks.find((b) => b.kind === 'list').id = 'l';
      expect(shape(back), format).toEqual(want);
    }
  }, 120000);
});
