// @vitest-environment jsdom

/** The inspector for Paper: everything it lists is gone from the clean copy, checked on the bytes of .odt and .docx. */

import { describe, it, expect } from 'vitest';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { textFindings, cleanTextCopy } from '../src/js/core/editor/inspect.js';
import { trackedInsert, trackedDeleteRange, addComment } from '../src/js/core/editor/review.js';
import { toggleRedact } from '../src/js/core/editor/redact.js';
import { point, collapsed } from '../src/js/core/editor/selection.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { encodeBlock } from '../src/js/core/package.js';

const bytesOf = (entries) => new TextDecoder('utf-8', { fatal: false }).decode(encodeBlock(entries));

function loaded() {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: [{ id: 'b', kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: 'Budget for Mario: see ' }, { text: 'the sheet', link: 'https://intranet.example.com/budget' }] }] });
  trackedInsert(model, collapsed(point('b', 0)), 'Draft ');
  trackedDeleteRange(model, { anchor: point('b', 6), focus: point('b', 13) });
  addComment(model, { anchor: point('b', 17), focus: point('b', 22) }, 'Ask Luigi about this');
  toggleRedact(model, { anchor: point('b', 18), focus: point('b', 23) });
  model.review = { recording: true, protect: 'aGFzaGhhc2hoYXNoaGFzaGhhc2g=' };
  return model;
}

describe('the inspector', () => {
  it('lists what the document carries', () => {
    const found = Object.fromEntries(textFindings(loaded().toJSON()).map((f) => [f.id, f.count]));
    expect(found).toEqual({ comments: 1, changes: 2, redact: 1, links: 1, paths: 0, protect: 1 });
  });

  it('leaves none of it in the clean copy, in .odt or .docx', () => {
    const copy = cleanTextCopy(loaded().toJSON(), ['comments', 'changes', 'redact', 'links', 'protect']);
    expect(textFindings(copy).every((f) => f.count === 0)).toBe(true);
    const all = JSON.stringify(copy) + bytesOf(writeOdt(copy).entries) + bytesOf(writeDocx(copy).entries);
    for (const gone of ['Luigi', 'Budget', 'intranet.example.com', 'aGFzaGhh', 'annotation', 'w:del ', 'tracked-changes', 'Mario']) {
      expect(all.includes(gone), gone).toBe(false);
    }
    expect(all.includes('Draft')).toBe(true);
  });
});
