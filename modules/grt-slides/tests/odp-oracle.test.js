// @vitest-environment jsdom

/** LibreOffice opens the OpenDocument presentations Slides writes, on a machine that has it. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { writeOdp, readOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import {
  oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert, pdfPages,
} from '../../../scripts/oracle.mjs';
import { sampleDeck } from './odp.test.js';

const ready = oracleAvailable();
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZYAwAZDsH+Wk8l1wAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
const images = new Map([['resources/pic.png', PNG]]);

/** What matters of an element for comparing two readings of one slide. */
const shape = (e) => ({
  kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, rotation: Math.round(e.rotation ?? 0),
  ...(e.kind === 'text' ? { text: e.content.map((r) => r.text).join(''), size: e.size } : {}),
  ...(e.kind === 'shape' ? { shape: e.shape, fill: e.fill } : {}),
});

describe.skipIf(!ready)('LibreOffice and Slides’ .odp', () => {
  let dir;
  beforeAll(() => {
    dir = scratch();
  });
  afterAll(() => cleanup(dir));

  it('shows every slide with its text', () => {
    const file = join(dir, 'deck.odp');
    writeBlock(encodeBlock(writeOdp(sampleDeck().toJSON(), images).entries), file);
    const pages = pdfPages(convert(file, 'pdf', join(dir, 'pdf')));
    expect(pages.filter((text) => text.trim() !== '')).toHaveLength(1);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0]).toContain('Hello');
    expect(pages[0]).toContain('Line two');
    expect(pages[0]).toMatch(/A\s+B/);
  }, 120000);

  it('reads it as Slides wrote it, and writes the same slides as PowerPoint', () => {
    const file = join(dir, 'cross.odp');
    writeBlock(encodeBlock(writeOdp(sampleDeck().toJSON(), images).entries), file);
    const pptx = readPptx(decodeBlock(readBlock(convert(file, 'pptx:Impress MS PowerPoint 2007 XML', join(dir, 'pptx'))))).document;
    const ours = readOdp(decodeBlock(readBlock(file))).document;
    expect(pptx.slides[0].elements.map(shape)).toEqual(ours.slides[0].elements.map(shape));
    expect(pptx.slides[0].notes).toBe('Say hello\nThen go on');
    expect(pptx.slides.map((s) => s.transition)).toEqual(['fade', 'slide']);
    expect(pptx.slides[1].background).toBe('#202020');
  }, 120000);

  it('and reads LibreOffice’s own .odp of Slides’ PowerPoint file as the PowerPoint reader does', () => {
    const file = join(dir, 'theirs.pptx');
    writeBlock(encodeBlock(writePptx(sampleDeck().toJSON(), images).entries), file);
    const odp = readOdp(decodeBlock(readBlock(convert(file, 'odp', join(dir, 'odp'))))).document;
    const pptx = readPptx(decodeBlock(readBlock(file))).document;
    expect(odp.slides[0].elements.map(shape)).toEqual(pptx.slides[0].elements.map(shape));
    expect(odp.slides[0].notes).toBe('Say hello\nThen go on');
    expect(odp.slides.map((s) => s.transition)).toEqual(['fade', 'slide']);
  }, 120000);
});
