// @vitest-environment jsdom

/** Review in Paper: changes recorded, accepted and rejected; comments with replies; through .odt, .docx and LibreOffice. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { DocumentModel } from '../src/js/core/editor/model.js';
import {
  trackedInsert, trackedDeleteRange, trackedDeleteStep, listChanges, settle, rejectButTrack,
  addComment, listComments, replyTo, resolve, deleteOne, deleteThread, promote, deleteAllComments,
} from '../src/js/core/editor/review.js';
import { point, collapsed } from '../src/js/core/editor/selection.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

function doc(text = 'The quick fox jumps') {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: [{ id: 'b1', kind: 'paragraph', style: 'body', align: 'left', runs: [{ text }] }] });
  return model;
}
const text = (model) => model.runsOf('b1').map((r) => r.text).join('');
const range = (from, to) => ({ anchor: point('b1', from), focus: point('b1', to) });

describe('recorded changes', () => {
  it('mark what is typed and what is taken out, and take out at once what was typed while recording', () => {
    const model = doc();
    trackedInsert(model, collapsed(point('b1', 4)), 'very ');
    trackedDeleteRange(model, range(14, 18));
    expect(text(model)).toBe('The very quick fox jumps');
    const changes = listChanges(model);
    expect(changes.map((c) => [c.kind, c.text])).toEqual([['insert', 'very '], ['delete', ' fox']]);
    // Backspace over one's own insertion takes it out for good; over the old text it only marks.
    trackedDeleteStep(model, collapsed(point('b1', 9)), -1);
    expect(listChanges(model)[0].text).toBe('very');
    const at = trackedDeleteStep(model, collapsed(point('b1', 4)), -1);
    expect(at.anchor.offset).toBe(3);
    expect(listChanges(model).map((c) => c.text)).toEqual([' ', 'very', ' fox']);
  });

  it('are accepted and rejected one by one, or turned into changes of their own', () => {
    const model = doc();
    trackedInsert(model, collapsed(point('b1', 4)), 'very ');
    trackedDeleteRange(model, range(14, 18));
    const [ins, del] = listChanges(model);
    settle(model, del, false);
    expect(text(model)).toBe('The very quick fox jumps');
    expect(listChanges(model).length).toBe(1);
    settle(model, listChanges(model)[0], true);
    expect(listChanges(model).length).toBe(0);
    expect(model.runsOf('b1')).toEqual([{ text: 'The very quick fox jumps' }]);
    const again = doc();
    trackedInsert(again, collapsed(point('b1', 4)), 'very ');
    rejectButTrack(again, listChanges(again)[0]);
    expect(listChanges(again).map((c) => c.kind)).toEqual(['delete']);
    void ins;
  });
});

describe('comments', () => {
  it('are anchored on text, answered, resolved, promoted and taken away', () => {
    const model = doc();
    const id = addComment(model, range(4, 9), 'Which fox?');
    replyTo(model, id, 'The red one');
    const [thread] = listComments(model);
    expect(thread).toMatchObject({ text: 'Which fox?', replies: [{ text: 'The red one' }] });
    expect(model.runsOf('b1').filter((r) => r.cmt === id).map((r) => r.text).join('')).toBe('quick');
    resolve(model, id, true, { thread: true });
    expect(listComments(model)[0].replies[0].done).toBe(true);
    promote(model, thread.replies[0].id);
    expect(listComments(model).map((c) => c.text)).toEqual(['Which fox?', 'The red one']);
    deleteOne(model, id);
    expect(listComments(model).map((c) => c.text)).toEqual(['The red one']);
    expect(model.runsOf('b1').some((r) => r.cmt)).toBe(false);
    deleteAllComments(model);
    expect(listComments(model)).toEqual([]);
    expect(text(model)).toBe('The quick fox jumps');
    const other = doc();
    const kept = addComment(other, range(0, 3), 'x');
    deleteThread(other, kept);
    expect(text(other)).toBe('The quick fox jumps');
  });
});

/** A document with every kind of review mark in it. */
function reviewed() {
  const model = doc('The quick fox jumps over the dog');
  trackedInsert(model, collapsed(point('b1', 4)), 'very ');
  trackedDeleteRange(model, range(14, 18));
  const id = addComment(model, range(25, 29), 'Which one?');
  replyTo(model, id, 'The lazy one');
  resolve(model, id, true);
  return model;
}

const shape = (document) => {
  const runs = document.blocks.flatMap((b) => b.runs ?? []);
  const comments = runs.filter((r) => r.object?.type === 'comment').map((r) => ({
    text: r.object.text, done: !!r.object.done, replies: (r.object.replies ?? []).map((x) => x.text),
  }));
  return {
    text: runs.filter((r) => !r.object).map((r) => r.text).join(''),
    inserted: runs.filter((r) => r.ins).map((r) => r.text).join(''),
    deleted: runs.filter((r) => r.del).map((r) => r.text).join(''),
    about: runs.filter((r) => r.cmt).map((r) => r.text).join(''),
    comments,
  };
};

const want = {
  text: 'The very quick fox jumps over the dog', inserted: 'very ', deleted: ' fox', about: 'over',
  comments: [{ text: 'Which one?', done: true, replies: ['The lazy one'] }],
};

describe('review in files', () => {
  it('goes through .odt and .docx whole, with no names in them', () => {
    const json = reviewed().toJSON();
    expect(shape(json)).toEqual(want);
    const odt = writeOdt(json).entries;
    expect(shape(readOdt(decodeBlock(encodeBlock(odt))).document)).toEqual(want);
    const docx = writeDocx(json).entries;
    expect(shape(readDocx(decodeBlock(encodeBlock(docx))).document)).toEqual(want);
    const all = JSON.stringify([...odt, ...docx].map((e) => (typeof e.data === 'string' ? e.data : '')));
    expect(all).not.toMatch(/dc:creator|w:author="[^"]/);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and review', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('reads the changes and threads from .odt and .docx and writes them back the same', () => {
    const json = reviewed().toJSON();
    for (const [format, write, filter, read] of [
      ['odt', writeOdt, 'docx:MS Word 2007 XML', readDocx],
      ['docx', writeDocx, 'odt', readOdt],
      ['odt', writeOdt, 'odt', readOdt],
    ]) {
      const file = join(dir, `review-${filter.slice(0, 3)}.${format}`);
      writeBlock(encodeBlock(write(json).entries), file);
      const saved = convert(file, filter, join(dir, `from-${format}-${filter.slice(0, 3)}`));
      expect(shape(read(decodeBlock(readBlock(saved))).document), `${format} to ${filter}`).toEqual(want);
    }
  }, 180000);
});
