// @vitest-environment jsdom

/** What LibreOffice makes of Paper's files, on a machine that has it. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { readRtf } from '../src/js/core/formats/rtf-read.js';
import { readMarkdown } from '../src/js/core/formats/markdown-read.js';
import { readFileSync } from 'node:fs';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { DocumentModel, runsText } from '../src/js/core/editor/model.js';
import {
  oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert, pdfPages, pdfWords,
} from '../../../scripts/oracle.mjs';

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
  144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0, 201,
  254, 146, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

function document() {
  return new DocumentModel({
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: { top: 25, right: 20, bottom: 25, left: 20 },
      running: {
        firstDifferent: true,
        evenDifferent: true,
        header: { default: { text: 'Odd header', align: 'left' }, first: null, even: { text: 'Even header', align: 'right' } },
        footer: { default: { text: 'Page {page} of {pages}', align: 'center' }, first: { text: 'Cover', align: 'center' }, even: null },
      },
    },
    blocks: [
      { kind: 'heading', level: 1, runs: [{ text: 'Oracle title' }] },
      { kind: 'paragraph', runs: [{ text: 'Plain ' }, { text: 'bold', bold: true }, { text: '  spaced  ' }, { text: 'italic', italic: true }] },
      { kind: 'list', listType: 'number', items: [{ level: 0, runs: [{ text: 'One' }] }, { level: 1, runs: [{ text: 'One point one' }] }] },
      { kind: 'code', runs: [{ text: 'a = 1\n  b = 2' }] },
      { kind: 'image', resource: 'resources/dot.png', w: 120, h: 60, align: 'center', caption: [{ text: 'Caption text' }] },
      { kind: 'paragraph', breakBefore: true, runs: [{ text: 'Second page.' }] },
      { kind: 'paragraph', breakBefore: true, runs: [{ text: 'Third page.' }] },
    ],
  });
}

const images = new Map([['resources/dot.png', PNG]]);

/** Each block as a line: its kind, its text, and a mark where a page starts. */
function texts(doc) {
  return new DocumentModel(doc).toJSON().blocks.map((block) => {
    const page = block.breakBefore ? '↡' : '';
    if (block.kind === 'list') return page + block.items.map((item) => `${item.level}:${runsText(item.runs)}`).join('|');
    if (block.kind === 'image') return `${page}image:${runsText(block.caption)}`;
    return `${page}${block.kind}:${runsText(block.runs)}`;
  });
}


/** Where LibreOffice put a word: left, centre or right of the page. */
function placement(words, page, text) {
  const word = words.find((w) => w.page === page && w.text === text);
  if (!word) return null;
  const middle = (word.x0 + word.x1) / 2;
  if (middle < word.width / 3) return 'left';
  if (middle > (word.width * 2) / 3) return 'right';
  return 'center';
}

const ready = oracleAvailable();

describe.skipIf(!ready)('LibreOffice and Paper’s .odt', () => {
  let dir;
  let file;

  beforeAll(() => {
    dir = scratch();
    file = join(dir, 'paper.odt');
    writeBlock(encodeBlock(writeOdt(document().toJSON(), images).entries), file);
  });
  afterAll(() => cleanup(dir));

  it('opens it, and what it saves comes back with the same text and pictures', () => {
    const saved = convert(file, 'odt', join(dir, 'resaved'));
    const back = readOdt(decodeBlock(readBlock(saved)));
    expect(texts(back.document)).toEqual(texts(document().toJSON()));
    expect([...back.images.values()]).toEqual([PNG]);
    expect(back.document.page.running).toEqual(document().page.running);
  }, 120000);

  it('keeps the formatting of the runs through its own save', () => {
    const saved = convert(file, 'odt', join(dir, 'resaved-runs'));
    const back = readOdt(decodeBlock(readBlock(saved)));
    expect(new DocumentModel(back.document).toJSON().blocks[1].runs).toEqual(document().toJSON().blocks[1].runs);
  }, 120000);

  it('prints the headers and footers on the pages they belong to', () => {
    const pages = pdfPages(convert(file, 'pdf', join(dir, 'pdf')));
    if (!pages) return;
    const [first, second, third] = pages;
    expect(first).toContain('Cover');
    expect(first).not.toMatch(/Odd header|Even header/);
    expect(second).toContain('Even header');
    expect(second).not.toMatch(/Page \d/);
    expect(third).toContain('Odd header');
    expect(third).toContain('Page 3 of 3');
    const words = pdfWords(join(dir, 'pdf', 'paper.pdf'));
    expect(placement(words, 1, 'Cover')).toBe('center');
    expect(placement(words, 2, 'Even')).toBe('right');
    expect(placement(words, 3, 'Odd')).toBe('left');
  }, 120000);
});

describe.skipIf(!ready)('LibreOffice and Paper’s .docx', () => {
  let dir;
  let file;

  beforeAll(() => {
    dir = scratch();
    file = join(dir, 'paper.docx');
    writeBlock(encodeBlock(writeDocx(document().toJSON(), images).entries), file);
  });
  afterAll(() => cleanup(dir));

  it('opens it, and what it saves as .docx comes back with the same text and pictures', () => {
    const saved = convert(file, 'docx:MS Word 2007 XML', join(dir, 'resaved'));
    const back = readDocx(decodeBlock(readBlock(saved)));
    expect(texts(back.document)).toEqual(texts(document().toJSON()));
    expect([...back.images.values()]).toEqual([PNG]);
    expect(back.document.page.running).toEqual(document().page.running);
    expect(new DocumentModel(back.document).toJSON().blocks[1].runs).toEqual(document().toJSON().blocks[1].runs);
  }, 120000);

  it('prints the headers and footers on the pages they belong to', () => {
    const pages = pdfPages(convert(file, 'pdf', join(dir, 'pdf')));
    if (!pages) return;
    const [first, second, third] = pages;
    expect(first).toContain('Cover');
    expect(first).not.toMatch(/Odd header|Even header/);
    expect(second).toContain('Even header');
    expect(third).toContain('Odd header');
    expect(third).toContain('Page 3 of 3');
    const words = pdfWords(join(dir, 'pdf', 'paper.pdf'));
    expect(placement(words, 1, 'Cover')).toBe('center');
    expect(placement(words, 2, 'Even')).toBe('right');
    expect(placement(words, 3, 'Odd')).toBe('left');
  }, 120000);

  it('turns Paper’s .odt into a .docx that reads back the same', () => {
    const odt = join(dir, 'cross.odt');
    writeBlock(encodeBlock(writeOdt(document().toJSON(), images).entries), odt);
    const docx = convert(odt, 'docx:MS Word 2007 XML', join(dir, 'cross'));
    const back = readDocx(decodeBlock(readBlock(docx)));
    const unbroken = (lines) => lines.map((line) => line.replace(/^↡/, ''));
    expect(unbroken(texts(back.document))).toEqual(unbroken(texts(document().toJSON())));
    const words = (running) => JSON.stringify(running, (key, value) => (key === 'align' ? undefined : value));
    expect(words(back.document.page.running)).toEqual(words(document().page.running));
  }, 120000);
});

describe.skipIf(!ready)('LibreOffice’s RTF and Markdown, read by Paper', () => {
  let dir;
  beforeAll(() => {
    dir = scratch();
  });
  afterAll(() => cleanup(dir));

  it('reads the RTF LibreOffice makes of Paper’s .odt', () => {
    const odt = join(dir, 'source.odt');
    writeBlock(encodeBlock(writeOdt(document().toJSON(), images).entries), odt);
    const rtf = convert(odt, 'rtf', join(dir, 'rtf'));
    const back = readRtf(new Uint8Array(readFileSync(rtf)));
    const unbroken = (lines) => lines.map((line) => line.replace(/^↡/, ''));
    expect(unbroken(texts(back.document))).toEqual(unbroken(texts(document().toJSON())));
    expect([...back.images.values()].length).toBe(1);
    // LibreOffice's RTF export leaves out headers of even pages altogether.
    const expected = structuredClone(document().page.running);
    expected.evenDifferent = false;
    expected.header.even = null;
    const words = (running) => JSON.stringify(running, (key, value) => (key === 'align' ? undefined : value));
    expect(words(back.document.page.running)).toEqual(words(expected));
  }, 120000);

  it('reads Markdown with the same blocks as Paper’s own Markdown export would give', async () => {
    const md = [
      '# Oracle title', '', 'Plain **bold**  spaced  *italic*', '', '1. One', '   1. One point one', '',
      '```', 'a = 1', '  b = 2', '```', '', '![Caption text](dot.png)',
    ].join('\n');
    const back = await readMarkdown(md, async (src) => (src === 'dot.png' ? PNG : null));
    expect(texts(back.document)).toEqual(texts({
      blocks: document().toJSON().blocks.slice(0, 5).map((b) => ({ ...b, breakBefore: false })),
    }).map((line) => line.replace('bold  spaced  italic', 'bold spaced italic')));
    expect(back.document.blocks[4]).toMatchObject({ kind: 'image', w: 1, h: 1 });
  });
});
