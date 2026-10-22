// @vitest-environment jsdom

/** A note going out as a text document. */

import { describe, it, expect } from 'vitest';
import { fromMarkdown } from '../src/js/note.js';
import { noteToDocument } from '../src/js/export.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

describe('a note as an OpenDocument or Word file', () => {
  const note = fromMarkdown('# Steps\n\n> [!warning] Careful\n> Hot.\n\n- [x] Boil\n- [ ] Pour\n\nPlain **bold** text.\n', 'Tea');

  it('has its title, its headings a level down, tasks with their boxes and callouts as quotations', () => {
    const { document } = noteToDocument(note);
    const text = (b) => (b.runs ?? []).map((r) => r.text).join('');
    expect(document.blocks.map((b) => [b.kind, b.level ?? null, text(b)])).toEqual([
      ['heading', 1, 'Tea'], ['heading', 2, 'Steps'], ['quote', null, 'Careful: Hot.'],
      ['paragraph', null, '☑ Boil'], ['paragraph', null, '☐ Pour'], ['paragraph', null, 'Plain bold text.'],
    ]);
  });

  it('opens again from either file with the same text', () => {
    const { document } = noteToDocument(note);
    for (const back of [readOdt(through(writeOdt(document, new Map()).entries)).document, readDocx(through(writeDocx(document, new Map()).entries)).document]) {
      const texts = back.blocks.map((b) => (b.runs ?? []).map((r) => r.text).join(''));
      expect(texts).toEqual(['Tea', 'Steps', 'Careful: Hot.', '☑ Boil', '☐ Pour', 'Plain bold text.']);
    }
  });
});
