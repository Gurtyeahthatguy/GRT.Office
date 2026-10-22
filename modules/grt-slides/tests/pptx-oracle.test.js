// @vitest-environment jsdom

/** LibreOffice opens the PowerPoint files Slides writes, on a machine that has it. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { SlidesModel } from '../src/js/model.js';
import {
  oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert, pdfPages,
} from '../../../scripts/oracle.mjs';

const ready = oracleAvailable();
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZYAwAZDsH+Wk8l1wAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

function deck() {
  const model = new SlidesModel();
  model.setCanvas({ w: 1280, h: 720 });
  const first = model.slides[0];
  model.addElement(first.id, { kind: 'text', x: 80, y: 40, w: 1000, h: 120, style: 'title', content: [{ text: 'Opening words' }] });
  model.addElement(first.id, { kind: 'shape', shape: 'ellipse', x: 700, y: 200, w: 200, h: 200 });
  model.addElement(first.id, { kind: 'line', x: 100, y: 600, w: 300, h: 50, arrow: true });
  model.addElement(first.id, { kind: 'image', x: 900, y: 450, w: 200, h: 200, resource: 'resources/pic.png' });
  model.addElement(first.id, { kind: 'table', x: 100, y: 300, w: 400, h: 100, rows: 2, cols: 2, cells: [['Name', 'Total'], ['Ada', '12']] });
  model.setNotes(first.id, 'Speak slowly');
  const second = model.addSlide();
  model.addElement(second.id, { kind: 'text', x: 80, y: 40, w: 1000, h: 120, content: [{ text: 'Closing words' }] });
  model.setSection(second.id, 'End');
  const master = model.addMaster('Branded');
  master.elements.push({ id: 'bar', kind: 'shape', shape: 'rect', x: 0, y: 0, w: 1280, h: 20, z: -1, fill: '#ff8800', rotation: 0, data: {} });
  model.assignMaster(second.id, master.id);
  return model;
}

describe.skipIf(!ready)('LibreOffice and Slides’ .pptx', () => {
  let dir;
  beforeAll(() => {
    dir = scratch();
  });
  afterAll(() => cleanup(dir));

  it('shows every slide with its text, on a page of the slide’s shape', () => {
    const file = join(dir, 'deck.pptx');
    writeBlock(encodeBlock(writePptx(deck().toJSON(), new Map([['resources/pic.png', PNG]])).entries), file);
    const pdf = convert(file, 'pdf', join(dir, 'pdf'));
    const pages = pdfPages(pdf).filter((text) => text.trim() !== '');
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('Opening words');
    expect(pages[0]).toMatch(/Name\s+Total/);
    expect(pages[1]).toContain('Closing words');
    const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }));
    expect(Number(size[1]) / Number(size[2])).toBeCloseTo(16 / 9, 2);
  }, 120000);

  it('saves it again as .pptx with what Slides wrote still in it', () => {
    const file = join(dir, 'again.pptx');
    writeBlock(encodeBlock(writePptx(deck().toJSON(), new Map([['resources/pic.png', PNG]])).entries), file);
    const saved = convert(file, 'pptx:Impress MS PowerPoint 2007 XML', join(dir, 'resaved'));
    const { document } = readPptx(decodeBlock(readBlock(saved)));
    expect(document.slides).toHaveLength(2);
    const kinds = document.slides[0].elements.map((e) => e.kind).sort();
    expect(kinds).toEqual(['image', 'line', 'shape', 'table', 'text']);
    expect(document.slides[0].notes).toBe('Speak slowly');
    expect(document.slides[1].section).toBeNull();
    const texts = document.slides.flatMap((s) => s.elements.filter((e) => e.kind === 'text').map((e) => e.content.map((r) => r.text).join('')));
    expect(texts).toEqual(['Opening words', 'Closing words']);
    // The master's bar is drawn under the second slide, wherever LibreOffice keeps it.
    const bars = [...document.masters.flatMap((m) => m.elements), ...document.slides[1].elements].filter((e) => e.fill === '#ff8800');
    expect(bars.length).toBeGreaterThan(0);
  }, 120000);
});
