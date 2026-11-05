// @vitest-environment jsdom

/** Sections in columns: drawn in columns, and carried through .odt and .docx and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { Renderer } from '../src/js/core/editor/render.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const p = (text) => ({ kind: 'paragraph', runs: [{ text }] });
const document = () => new DocumentModel({ blocks: [p('Intro'), { kind: 'section', columns: 2 }, p('Left and'), p('right'), { kind: 'section', columns: 1 }, p('After')] }).toJSON();

/** Each paragraph's text with the columns it flows in. */
function layout(doc) {
  let columns = 1;
  const out = [];
  for (const block of doc.blocks) {
    if (block.kind === 'section') columns = block.columns;
    else if (block.runs?.some((r) => r.text)) out.push([block.runs.map((r) => r.text).join(''), columns]);
  }
  return out;
}

describe('sections in columns', () => {
  it('flow the blocks after their mark in columns', () => {
    const surface = window.document.createElement('div');
    new Renderer(surface).draw(new DocumentModel(document()));
    const flow = surface.querySelector('.section-columns');
    expect(flow.style.columnCount).toBe('2');
    expect(flow.textContent).toBe('Left andright');
  });
  const want = layout(document());
  it('come back from .odt and .docx', () => {
    expect(layout(readOdt(decodeBlock(encodeBlock(writeOdt(document()).entries))).document)).toEqual(want);
    expect(layout(readDocx(decodeBlock(encodeBlock(writeDocx(document()).entries))).document)).toEqual(want);
  });
  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `columns.${format}`);
        writeBlock(encodeBlock(write(document()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(layout(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
