// @vitest-environment jsdom

/** OpenDocument presentations, read and written. */

import { describe, it, expect } from 'vitest';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { SlidesModel } from '../src/js/model.js';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZYAwAZDsH+Wk8l1wAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
const through = (entries) => decodeBlock(encodeBlock(entries));

export function sampleDeck() {
  const model = new SlidesModel();
  model.setCanvas({ w: 1280, h: 720 });
  const first = model.slides[0];
  model.addElement(first.id, { kind: 'text', x: 80, y: 40, w: 1000, h: 120, style: 'title', content: [{ text: 'Hello  ' }, { text: 'there', italic: true, color: '#cc0000' }] });
  const body = model.addElement(first.id, { kind: 'text', x: 80, y: 200, w: 600, h: 300, content: [{ text: 'Line one\nLine two' }] });
  model.setElementText(first.id, [body.id], { size: 40, align: 'right', valign: 'middle' });
  const shape = model.addElement(first.id, { kind: 'shape', shape: 'diamond', x: 700, y: 200, w: 200, h: 200, rotation: 30 });
  model.setElementColour(first.id, [shape.id], { fill: '#336699' });
  model.addElement(first.id, { kind: 'shape', shape: 'rounded', x: 950, y: 100, w: 200, h: 80 });
  model.addElement(first.id, { kind: 'line', x: 100, y: 600, w: 300, h: 50, arrow: true, thickness: 6 });
  model.addElement(first.id, { kind: 'image', x: 900, y: 450, w: 200, h: 200, resource: 'resources/pic.png' });
  model.addElement(first.id, { kind: 'table', x: 100, y: 500, w: 400, h: 100, rows: 2, cols: 2, cells: [['A', 'B'], ['1', '2']] });
  model.setNotes(first.id, 'Say hello\nThen go on');
  model.setTransition(first.id, 'fade');
  const second = model.addSlide();
  model.setSlideBackground(second.id, '#202020');
  model.setTransition(second.id, 'slide');
  const master = model.addMaster('Branded');
  master.elements.push({ id: 'logo', kind: 'shape', shape: 'rect', x: 0, y: 0, w: 1280, h: 10, z: -1, fill: '#ff8800', rotation: 0, data: {} });
  model.assignMaster(second.id, master.id);
  return model;
}

describe('OpenDocument presentations', () => {
  it('come back as they were written', () => {
    const { entries, losses } = writeOdp(sampleDeck().toJSON(), new Map([['resources/pic.png', PNG]]));
    expect(losses.empty).toBe(true);
    const { document, images } = readOdp(through(entries));
    expect(document.canvas).toEqual({ w: 1280, h: 720 });
    expect(document.slides).toHaveLength(2);
    const [title, body, shape, rounded, line, picture, table] = document.slides[0].elements;
    expect(title).toMatchObject({ size: 72, color: '#111111', font: 'sans' });
    expect(title.content).toEqual([{ text: 'Hello  ', bold: true }, { text: 'there', bold: true, italic: true, color: '#cc0000' }]);
    expect(body).toMatchObject({ size: 40, align: 'right', valign: 'middle', content: [{ text: 'Line one\nLine two' }] });
    expect(shape).toMatchObject({ kind: 'shape', shape: 'diamond', fill: '#336699', x: 700, y: 200, w: 200, h: 200, rotation: 30 });
    expect(rounded).toMatchObject({ kind: 'shape', shape: 'rounded' });
    expect(line).toMatchObject({ kind: 'line', arrow: true, thickness: 6, x: 100, y: 600, w: 300, h: 50 });
    expect(picture).toMatchObject({ kind: 'image', x: 900, y: 500, w: 200, h: 100 });
    expect([...images.values()][0]).toEqual(PNG);
    expect(table).toMatchObject({ kind: 'table', cells: [['A', 'B'], ['1', '2']], header: true });
    expect(document.slides[0].notes).toBe('Say hello\nThen go on');
    expect(document.slides[0].transition).toBe('fade');
    expect(document.slides[1].transition).toBe('slide');
    expect(document.slides[1].background).toBe('#202020');
    expect(document.masters.map((m) => m.name)).toEqual(['Branded']);
    expect(document.masters[0].elements[0]).toMatchObject({ kind: 'shape', fill: '#ff8800', w: 1280, h: 10 });
    expect(document.slides[1].master).toBe(document.masters[0].id);
    expect(document.slides[0].master).toBeNull();
  });

  it('turn about their centre the way LibreOffice writes it', () => {
    const model = new SlidesModel();
    const shape = model.addElement(model.slides[0].id, { kind: 'shape', shape: 'ellipse', x: 700, y: 200, w: 200, h: 100, rotation: 30 });
    const { entries } = writeOdp(model.toJSON());
    const content = entries.find((e) => e.name === 'content.xml').data;
    // LibreOffice's own file for the same shape says rotate (-0.523598775598299) translate (19.537cm 4.146cm).
    expect(content).toContain('rotate (-0.523598775598');
    expect(content).toContain('translate (19.537cm 4.146cm)');
    expect(readOdp(through(entries)).document.slides[0].elements[0]).toMatchObject({ x: shape.x, y: shape.y, rotation: 30 });
  });

  it('are the same, byte for byte, written twice, flat or packed', () => {
    const images = new Map([['resources/pic.png', PNG]]);
    const packed = () => JSON.stringify(writeOdp(sampleDeck().toJSON(), images).entries, (k, v) => (v instanceof Uint8Array ? [...v] : v));
    expect(packed()).toBe(packed());
    const flat = writeOdp(sampleDeck().toJSON(), images, { flat: true });
    expect(flat.text).toBe(writeOdp(sampleDeck().toJSON(), images, { flat: true }).text);
    expect(readOdp(flat.text).document.slides[0].elements[0].content[1].text).toBe('there');
  });

  it('refuse what is not a presentation', () => {
    const { entries } = writeOdp(new SlidesModel().toJSON());
    const text = entries.map((e) => (e.name === 'mimetype' ? { ...e, data: 'application/vnd.oasis.opendocument.text' } : e));
    expect(() => readOdp(through(text))).toThrow(/not a presentation/);
  });
});
