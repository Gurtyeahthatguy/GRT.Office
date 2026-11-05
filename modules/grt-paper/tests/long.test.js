// @vitest-environment jsdom

/** Long documents: notes, bookmarks, references, captions, fields, contents and index, through the formats and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel, OBJECT, normaliseRuns } from '../src/js/core/editor/model.js';
import { documentFields, referenceText } from '../src/js/core/editor/fields.js';
import { Renderer } from '../src/js/core/editor/render.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const obj = (object) => ({ text: OBJECT, object });

function documentWithEverything() {
  return new DocumentModel({
    blocks: [
      { kind: 'toc', title: 'Contents', levels: 2 },
      { id: 'intro', kind: 'heading', level: 1, runs: [{ text: 'Introduction' }] },
      { kind: 'paragraph', runs: [{ text: 'Rome' }, obj({ type: 'note', kind: 'foot', runs: [{ text: 'The capital.' }] }), { text: ' and Milan' }, obj({ type: 'index', term: 'Milan' }), { text: ' are cities' }, obj({ type: 'note', kind: 'end', runs: [{ text: 'Both in Italy.' }] }), { text: '.' }] },
      { kind: 'paragraph', runs: [{ text: 'See ' }, obj({ type: 'ref', target: 'heading:intro', show: 'number' }), { text: ' and ' }, obj({ type: 'ref', target: 'fig-a', show: 'number' }), { text: ', or the ' }, obj({ type: 'bookmark', name: 'results' }), { text: 'results' }, { text: ' online', link: 'https://example.org/' }, { text: '.' }] },
      { kind: 'heading', level: 2, runs: [{ text: 'Figures' }] },
      { kind: 'paragraph', style: 'caption', runs: [{ text: 'Figure ' }, obj({ type: 'seq', name: 'Figure', id: 'fig-a' }), { text: ': A map' }] },
      { kind: 'paragraph', runs: [{ text: 'Page ' }, obj({ type: 'field', field: 'page' }), { text: ' of ' }, obj({ type: 'field', field: 'pages' }), obj({ type: 'index', term: 'Rome', sub: 'history' })] },
      { kind: 'index', title: 'Index' },
    ],
  });
}

/** What a document's objects say, independent of ids. */
function summary(document) {
  const model = new DocumentModel(document);
  const fields = documentFields(model);
  const objects = [];
  for (const block of model.blocks) {
    for (const run of block.runs ?? []) {
      if (!run.object) continue;
      const o = run.object;
      if (o.type === 'ref') objects.push(['ref', o.show, referenceText(o, fields)]);
      else if (o.type === 'note') objects.push(['note', o.kind, o.runs.map((r) => r.text).join('')]);
      else if (o.type === 'seq') objects.push(['seq', o.name, fields.seqs.get(o.id).number]);
      else if (o.type === 'index') objects.push(['index', o.term, o.sub ?? null]);
      else if (o.type === 'bookmark') objects.push(['bookmark', o.name]);
      else objects.push([o.type, o.field]);
    }
  }
  return {
    kinds: model.blocks.map((b) => b.kind),
    toc: model.blocks.find((b) => b.kind === 'toc')?.levels,
    caption: model.blocks.find((b) => b.style === 'caption') ? 'caption' : null,
    link: model.blocks.flatMap((b) => b.runs ?? []).find((r) => r.link)?.link ?? null,
    objects,
  };
}

describe('the objects of a long document', () => {
  it('number notes, captions and references in reading order', () => {
    const model = documentWithEverything();
    const fields = documentFields(model);
    expect(fields.footnotes.map((n) => n.label)).toEqual(['1']);
    expect(fields.endnotes.map((n) => n.label)).toEqual(['i']);
    expect(summary(model.toJSON()).objects.filter((o) => o[0] === 'ref')).toEqual([['ref', 'text', 'Introduction'], ['ref', 'number', 'Figure 1']]);
  });

  it('are drawn: note numbers, contents, index, the notes at the end', () => {
    const surface = document.createElement('div');
    new Renderer(surface).draw(documentWithEverything());
    expect([...surface.querySelectorAll('[data-note] sup')].map((s) => s.textContent)).toEqual(['1', 'i']);
    expect([...surface.querySelectorAll('.block.toc .generated-line')].map((l) => l.textContent)).toEqual(['Introduction', 'Figures']);
    expect([...surface.querySelectorAll('.block.index .generated-line')].map((l) => l.firstChild.textContent)).toEqual(['Milan', 'Rome', 'history']);
    expect(surface.querySelector('.notes-area').textContent).toContain('The capital.');
  });

  it('keep the caret counting one character each', () => {
    const runs = normaliseRuns([{ text: 'a' }, obj({ type: 'bookmark', name: 'x' }), obj({ type: 'bookmark', name: 'y' }), { text: 'b' }]);
    expect(runs.map((r) => r.text).join('')).toBe(`a${OBJECT}${OBJECT}b`);
    expect(normaliseRuns([{ text: `a${OBJECT}b` }])).toEqual([{ text: 'ab' }]);
  });
});

describe('long documents through the formats', () => {
  const want = summary(documentWithEverything().toJSON());
  it('come back from .odt as they went', () => {
    expect(summary(readOdt(decodeBlock(encodeBlock(writeOdt(documentWithEverything().toJSON()).entries))).document)).toEqual(want);
  });
  it('come back from .docx as they went', () => {
    expect(summary(readDocx(decodeBlock(encodeBlock(writeDocx(documentWithEverything().toJSON()).entries))).document)).toEqual(want);
  });
  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `long.${format}`);
        writeBlock(encodeBlock(write(documentWithEverything().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(summary(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
