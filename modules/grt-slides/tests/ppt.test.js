// @vitest-environment jsdom

/** PowerPoint 97 presentations: what Slides writes LibreOffice reads, what LibreOffice writes Slides reads, damaged files refused. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readPpt, writePpt } from '../src/js/core/formats/ppt.js';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { encodeBlock, decodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const deck = () => ({ version: 1, type: 'slides', canvas: { w: 1920, h: 1080 }, slides: [
  { id: 's1', elements: [
    { id: 'a', kind: 'text', x: 100, y: 80, w: 1700, h: 150, rotation: 0, content: [{ text: 'Il titolo' }], style: 'body' },
    { id: 'b', kind: 'shape', shape: 'ellipse', x: 300, y: 400, w: 400, h: 300, rotation: 0, fillLook: { type: 'solid', color: '#ff0000' }, line: { color: '#0000ff', width: 3 } },
  ] },
  { id: 's2', elements: [
    { id: 'c', kind: 'text', x: 100, y: 100, w: 800, h: 300, rotation: 0, content: [{ text: 'Seconda\nriga due' }], style: 'body' },
    { id: 'd', kind: 'image', resource: 'resources/p.png', x: 1000, y: 300, w: 400, h: 400, rotation: 0 },
  ] },
] });
const near = (a, b) => Math.abs(a - b) <= 4;

function check(doc, images) {
  expect(doc.slides).toHaveLength(2);
  // A text box may come back as a shape holding the words, as LibreOffice draws it.
  const words = (e) => (e.content ? e.content.map((r) => r.text).join('') : typeof e.text === 'string' ? e.text : (e.text ?? []).map?.((r) => r.text).join('') ?? '');
  const texts = doc.slides.map((s) => s.elements.map(words).filter(Boolean).join('|'));
  expect(texts[0]).toContain('Il titolo');
  expect(texts[1]).toContain('Seconda\nriga due');
  const ellipse = doc.slides[0].elements.find((e) => e.kind === 'shape' && e.shape === 'ellipse');
  expect(ellipse.fillLook.color).toBe('#ff0000');
  expect(near(ellipse.x * (1920 / (doc.canvas?.w ?? 1920)), 300) && near(ellipse.w * (1920 / (doc.canvas?.w ?? 1920)), 400)).toBe(true);
  const picture = doc.slides[1].elements.find((e) => e.kind === 'image');
  expect([...images.get(picture.resource).slice(0, 4)]).toEqual([...PNG.slice(0, 4)]);
}

describe('PowerPoint 97 presentations', () => {
  it('come back as Slides wrote them', () => {
    const { bytes, losses } = writePpt(deck(), new Map([['resources/p.png', PNG]]));
    expect(losses.empty).toBe(true);
    const read = readPpt(bytes);
    check(read.document, read.images);
  });

  it('refuse damaged files quickly, with an error and nothing else', () => {
    const good = writePpt(deck(), new Map([['resources/p.png', PNG]])).bytes;
    let seed = 5;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const started = Date.now();
    for (let n = 0; n < 300; n += 1) {
      const bad = good.slice();
      for (let k = 0; k < 20; k += 1) bad[Math.floor(random() * bad.length)] = Math.floor(random() * 256);
      try { readPpt(bad); } catch (error) { expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(RangeError); }
    }
    expect(Date.now() - started).toBeLessThan(20000);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and PowerPoint 97 presentations', () => {
  it('reads what Slides writes as Slides wrote it', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'slides.ppt');
      writeFileSync(file, writePpt(deck(), new Map([['resources/p.png', PNG]])).bytes);
      const read = readOdp(decodeBlock(readBlock(convert(file, 'odp', join(dir, 'odp')))));
      check(read.document, read.images);
    } finally { cleanup(dir); }
  }, 120000);

  it('writes what Slides reads', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'slides.odp');
      writeBlock(encodeBlock(writeOdp(deck(), new Map([['resources/p.png', PNG]])).entries), file);
      const read = readPpt(new Uint8Array(readFileSync(convert(file, 'ppt:MS PowerPoint 97', join(dir, 'ppt')))));
      check(read.document, read.images);
    } finally { cleanup(dir); }
  }, 120000);
});
