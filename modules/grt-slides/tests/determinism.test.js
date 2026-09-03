/** Two saves, identical bytes. */

import { describe, it, expect } from 'vitest';
import { SlidesModel } from '../src/js/model.js';
import { toHtml } from '../src/js/export.js';

function deck() {
  const model = new SlidesModel();
  const first = model.slides[0];
  model.addElement(first.id, {
    kind: 'text', x: 160, y: 200, w: 1600, h: 300, style: 'title',
    content: [{ text: 'Title' }, { text: ' bold', bold: true }],
  });
  model.addElement(first.id, { kind: 'shape', x: 100, y: 700, w: 300, h: 200 });
  const second = model.addSlide();
  model.addElement(second.id, { kind: 'image', resource: 'resources/a.png', x: 0, y: 0, w: 400, h: 300 });
  model.setNotes(second.id, 'Say the thing');
  return model;
}

const serialise = (model) => JSON.stringify(model.toJSON(), null, 2);

describe('The document the module hands to the container', () => {
  it('is byte-identical when serialised twice', () => {
    const model = deck();
    expect(serialise(model)).toBe(serialise(model));
  });

  it('is byte-identical after a load and re-save', () => {
    const model = deck();
    const once = serialise(model);
    const reloaded = new SlidesModel(JSON.parse(once));

    expect(serialise(reloaded)).toBe(once);
  });

  it('carries no timestamp anywhere', () => {
    const text = serialise(deck());

    for (const year of ['2024', '2025', '2026', '2027']) {
      expect(text).not.toContain(year);
    }
    expect(text.toLowerCase()).not.toContain('date');
    expect(text.toLowerCase()).not.toContain('modified');
  });

  it('keeps images as references rather than inlining them', () => {
    // images live in the container's resources, never base64 in the JSON,
    // so the document stays readable and the file does not balloon.
    const text = serialise(deck());

    expect(text).toContain('resources/a.png');
    expect(text).not.toContain('base64');
    expect(text).not.toContain('data:image');
  });

  it('survives a round trip with every element intact', () => {
    const model = deck();
    const reloaded = new SlidesModel(JSON.parse(serialise(model)));

    expect(reloaded.slides).toHaveLength(2);
    expect(reloaded.slides[0].elements).toHaveLength(2);
    expect(reloaded.slides[1].notes).toBe('Say the thing');
    expect(reloaded.usedResources()).toEqual(['resources/a.png']);
  });
});

describe('The exported HTML is stable too', () => {
  it('two exports of the same deck are identical', () => {
    const model = deck();
    expect(toHtml(model)).toBe(toHtml(model));
  });

  it('an export after a reload matches the original', () => {
    const model = deck();
    const reloaded = new SlidesModel(JSON.parse(serialise(model)));

    expect(toHtml(reloaded)).toBe(toHtml(model));
  });
});
