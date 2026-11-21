// @vitest-environment jsdom

/** Drawings in a text: anchored to a paragraph, a character or a page, the text running round them, kept by .odt. */

import { describe, it, expect } from 'vitest';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { DocumentModel, OBJECT } from '../src/js/core/editor/model.js';
import { cleanTextDrawings, wrapSide, drawingResources } from '../src/js/core/editor/drawings.js';
import { Renderer } from '../src/js/core/editor/render.js';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function sample() {
  const model = new DocumentModel({
    blocks: [
      { id: 'b1', kind: 'paragraph', style: 'body', runs: [{ text: 'First paragraph, long enough to wrap round a shape.' }] },
      { id: 'b2', kind: 'paragraph', style: 'body', runs: [{ text: 'Second ' }, { text: OBJECT, object: { type: 'drawing', id: 'inline1' } }, { text: ' after.' }] },
    ],
    drawings: [
      { id: 'star1', kind: 'shape', shape: 'star5', x: 40, y: 10, w: 120, h: 100, rotation: 0, anchor: { type: 'paragraph', block: 'b1' }, wrap: 'after', gap: 6, text: 'Hello', name: 'Star' },
      { id: 'pic1', kind: 'image', resource: 'resources/pic.png', x: 300, y: 20, w: 80, h: 60, rotation: 0, anchor: { type: 'char', block: 'b2' }, wrap: 'before', description: 'A dot' },
      { id: 'page1', kind: 'shape', shape: 'ellipse', x: 100, y: 200, w: 50, h: 50, rotation: 30, anchor: { type: 'page', page: 1 }, wrap: 'background' },
      { id: 'inline1', kind: 'shape', shape: 'rectangle', x: 0, y: 0, w: 30, h: 20, rotation: 0, anchor: { type: 'as-char' }, wrap: 'through' },
      { id: 'frame1', kind: 'shape', shape: 'rectangle', frame: true, x: 0, y: 0, w: 200, h: 60, rotation: 0, anchor: { type: 'paragraph', block: 'b2' }, wrap: 'optimal', text: 'In a frame', fillLook: { type: 'none' }, line: { color: '#000000', width: 1 } },
    ],
  });
  return { model, images: new Map([['resources/pic.png', PNG]]) };
}

const through = (entries) => decodeBlock(encodeBlock(entries));

describe('drawings in the model', () => {
  it('are kept with their anchor and wrap, and an anchor to no paragraph goes to the first', () => {
    const list = cleanTextDrawings([
      { id: 'a', kind: 'shape', shape: 'rectangle', x: 1, y: 2, w: 3, h: 4, anchor: { type: 'paragraph', block: 'gone' }, wrap: 'parallel' },
      { id: 'b', kind: 'nonsense' },
      { id: 'a', kind: 'shape' },
    ], [{ id: 'p1' }]);
    expect(list).toHaveLength(1);
    expect(list[0].anchor).toEqual({ type: 'paragraph', block: 'p1' });
    expect(list[0].wrap).toBe('parallel');
  });

  it('take a wrap side as Writer does', () => {
    expect(wrapSide({ x: 10, y: 0, w: 100, h: 50, wrap: 'parallel' }, 600)).toBe('right');
    expect(wrapSide({ x: 480, y: 0, w: 100, h: 50, wrap: 'parallel' }, 600)).toBe('left');
    expect(wrapSide({ x: 20, y: 0, w: 560, h: 50, wrap: 'optimal' }, 600)).toBe('none');
  });

  it('name their pictures among the document\'s resources, and undo brings them back', () => {
    const { model } = sample();
    expect(model.usedResources()).toContain('resources/pic.png');
    expect(drawingResources(model.drawings)).toEqual(['resources/pic.png']);
    const before = model.snapshot();
    model.drawings = [];
    model.restore(before);
    expect(model.drawings).toHaveLength(5);
  });

  it('are drawn before their paragraph, with a float for the wrap and the one in the line in it', () => {
    const { model } = sample();
    const surface = document.createElement('div');
    document.body.append(surface);
    new Renderer(surface).draw(model, new Map());
    const first = surface.firstElementChild;
    expect(first.classList.contains('draw-anchor')).toBe(true);
    expect(first.querySelector('[data-id="star1"]')).not.toBeNull();
    expect(surface.querySelector('.draw-wrap[data-wrap-for="star1"]')).not.toBeNull();
    expect(surface.querySelector('[data-block="b2"] .text-drawing.as-char[data-id="inline1"]')).not.toBeNull();
    // A drawing on a page is laid by the program over the pages, not in the text.
    expect(surface.querySelector('[data-id="page1"]')).toBeNull();
  });
});

describe('drawings in .odt', () => {
  it('come back anchored, wrapped and placed as they were', () => {
    const { model, images } = sample();
    const { entries } = writeOdt(model.toJSON(), images);
    const back = readOdt(through(entries));
    const doc = back.document;
    const byName = (id) => doc.drawings.find((o) => o.kind === model.drawings.find((d) => d.id === id).kind && Math.abs(o.w - model.drawings.find((d) => d.id === id).w) < 0.5 && Math.abs(o.h - model.drawings.find((d) => d.id === id).h) < 0.5);
    expect(doc.drawings).toHaveLength(5);
    const star = byName('star1');
    expect(star.shape).toBe('star5');
    expect(star.anchor.type).toBe('paragraph');
    expect(star.anchor.block).toBe(doc.blocks[0].id);
    expect(star.wrap).toBe('after');
    expect(star.text).toBe('Hello');
    expect(star.x).toBeCloseTo(40, 0);
    expect(star.y).toBeCloseTo(10, 0);
    expect(star.gap).toBeCloseTo(6, 0);
    const pic = byName('pic1');
    expect(pic.kind).toBe('image');
    expect(pic.anchor.type).toBe('char');
    expect(pic.wrap).toBe('before');
    expect(pic.description).toBe('A dot');
    expect([...back.images.values()]).toContainEqual(PNG);
    const onPage = doc.drawings.find((o) => o.anchor.type === 'page');
    expect(onPage.wrap).toBe('background');
    expect(onPage.rotation).toBeCloseTo(30, 0);
    expect(onPage.x).toBeCloseTo(100, 0);
    expect(onPage.y).toBeCloseTo(200, 0);
    const inline = doc.drawings.find((o) => o.anchor.type === 'as-char');
    const run = doc.blocks[1].runs.find((r) => r.object?.type === 'drawing');
    expect(run.object.id).toBe(inline.id);
    const frame = doc.drawings.find((o) => o.frame);
    expect(frame.text).toBe('In a frame');
    expect(frame.wrap).toBe('optimal');
  });

  it('write the same bytes twice', () => {
    const { model, images } = sample();
    const a = writeOdt(model.toJSON(), images, { flat: true }).text;
    const b = writeOdt(model.toJSON(), images, { flat: true }).text;
    expect(a).toBe(b);
    expect(a).toContain('office:binary-data');
    expect(a).toContain('style:wrap="right"');
  });
});

describe('drawings in .docx', () => {
  it('come back floating, wrapped and placed as they were', () => {
    const { model, images } = sample();
    const { entries, losses } = writeDocx(model.toJSON(), images);
    const back = readDocx(through(entries));
    const doc = back.document;
    const shapes = doc.drawings;
    expect(shapes).toHaveLength(5);
    const star = shapes.find((o) => o.shape === 'star5');
    expect(star.anchor.block).toBe(doc.blocks[0].id);
    expect(star.wrap).toBe('after');
    expect(star.text).toBe('Hello');
    expect(star.x).toBeCloseTo(40, 0);
    expect(star.y).toBeCloseTo(10, 0);
    const pic = shapes.find((o) => o.kind === 'image');
    expect(pic.wrap).toBe('before');
    expect(pic.description).toBe('A dot');
    expect(pic.anchor.block).toBe(doc.blocks[1].id);
    const onPage = shapes.find((o) => o.anchor.type === 'page');
    expect(onPage.wrap).toBe('background');
    expect(onPage.x).toBeCloseTo(100, 0);
    expect(onPage.y).toBeCloseTo(200, 0);
    expect(onPage.rotation).toBeCloseTo(30, 0);
    const inline = shapes.find((o) => o.anchor.type === 'as-char');
    expect(doc.blocks[1].runs.some((r) => r.object?.type === 'drawing' && r.object.id === inline.id)).toBe(true);
    expect(shapes.find((o) => o.text === 'In a frame').wrap).toBe('optimal');
    expect(losses.lines().join()).not.toMatch(/could not be written/);
  });
});

describe('DrawingML colours', () => {
  it('a theme colour is read without a colour map, as Word drawings have none', async () => {
    const { colorOf } = await import('../src/js/core/formats/drawingml.js');
    const fill = new DOMParser().parseFromString('<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:schemeClr val="accent1"/></a:solidFill>', 'application/xml').documentElement;
    expect(colorOf(fill, { colors: { accent1: '4f81bd' } }, null)).toBe('#4f81bd');
    expect(colorOf(fill, null, null)).toBeNull();
  });
});
