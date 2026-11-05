// @vitest-environment jsdom

/** Styles of the person's own: paragraph and character styles and list formats, through the formats and LibreOffice. */

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

function styled() {
  const model = new DocumentModel({ blocks: [{ kind: 'paragraph', runs: [{ text: 'Plain' }] }] });
  const abstract = model.addStyle('Abstract', 'body');
  model.setStyle(abstract, { italic: true, size: 10, indent: 20, color: '#335577', spaceAfter: 12 });
  const emphasis = model.addCharStyle('Key term', { bold: true, color: '#aa0000' });
  model.insertBlock({ kind: 'paragraph', style: abstract, runs: [{ text: 'A short ' }, { text: 'summary', cstyle: emphasis }, { text: '.' }] }, 1);
  model.insertBlock({ kind: 'list', listType: 'number', format: 'lower-roman', items: [{ level: 0, runs: [{ text: 'one' }] }, { level: 0, runs: [{ text: 'two' }] }] }, 2);
  model.insertBlock({ kind: 'list', listType: 'bullet', bullet: '–', items: [{ level: 0, runs: [{ text: 'dash' }] }] }, 3);
  return model;
}

/** What the styles say, independent of keys. */
function summary(document) {
  const model = new DocumentModel(document);
  const block = model.blocks.find((b) => b.runs?.some((r) => r.text.includes('summary')));
  const style = model.styles[block.style];
  const run = block.runs.find((r) => r.text === 'summary');
  const char = model.charStyles[run.cstyle];
  const lists = model.blocks.filter((b) => b.kind === 'list').map((b) => [b.listType, b.format ?? null, b.bullet ?? null]);
  return {
    style: { name: style.name, italic: !!style.italic, size: style.size, indent: Math.round(style.indent), color: style.color, spaceAfter: Math.round(style.spaceAfter) },
    char: { name: char?.name, bold: !!char?.bold, color: char?.color },
    lists,
  };
}

describe('styles of the person own', () => {
  it('are drawn as they are set', () => {
    const surface = document.createElement('div');
    new Renderer(surface).draw(styled());
    const paragraph = [...surface.querySelectorAll('p')].find((p) => p.textContent.includes('summary'));
    expect(paragraph.style.fontStyle).toBe('italic');
    expect(paragraph.querySelector('.char-style').style.fontWeight).toBe('700');
    expect(surface.querySelector('ol').style.listStyleType).toBe('lower-roman');
  });
  const want = summary(styled().toJSON());
  it('come back from .odt and .docx', () => {
    expect(summary(readOdt(decodeBlock(encodeBlock(writeOdt(styled().toJSON()).entries))).document)).toEqual(want);
    expect(summary(readDocx(decodeBlock(encodeBlock(writeDocx(styled().toJSON()).entries))).document)).toEqual(want);
  });
  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `styled.${format}`);
        writeBlock(encodeBlock(write(styled().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(summary(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
