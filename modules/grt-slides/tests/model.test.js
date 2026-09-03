/** The deck, without a browser anywhere near it. */

import { describe, it, expect } from 'vitest';
import { SlidesModel } from '../src/js/model.js';
import { UndoStack } from '../src/js/core/undo.js';

function deckWithTwoSlides() {
  const model = new SlidesModel();
  const first = model.slides[0];
  model.addElement(first.id, { kind: 'text', x: 100, y: 100, content: [{ text: 'Title' }] });
  const second = model.addSlide();
  model.addElement(second.id, { kind: 'text', x: 50, y: 50, content: [{ text: 'Second' }] });
  return { model, first, second };
}

describe('A new deck', () => {
  it('starts with one slide, because none is not a presentation', () => {
    expect(new SlidesModel().slides).toHaveLength(1);
  });

  it('is 16:9 by default', () => {
    const { canvas } = new SlidesModel();
    expect(canvas.w / canvas.h).toBeCloseTo(16 / 9, 3);
  });
});

describe('Identifiers', () => {
  it('are not sequential, so the file does not record creation order', () => {
    const model = new SlidesModel();
    const ids = Array.from({ length: 15 }, () => model.addSlide().id);

    expect(new Set(ids).size).toBe(15);
    expect(new Set(ids.map((id) => id[1])).size).toBeGreaterThan(1);
  });
});

describe('Slides', () => {
  it('refuses to delete the last one', () => {
    const model = new SlidesModel();
    expect(() => model.deleteSlide(model.slides[0].id)).toThrow(/last remaining/);
  });

  it('duplicating gives the copy new ids for everything inside', () => {
    const { model, first } = deckWithTwoSlides();
    const copy = model.duplicateSlide(first.id);

    expect(copy.id).not.toBe(first.id);
    expect(copy.elements[0].id).not.toBe(model.slide(first.id).elements[0].id);
    // Sharing ids would mean editing one slide changed the other.
    expect(copy.elements[0].content).toEqual(model.slide(first.id).elements[0].content);
  });

  it('reordering moves a slide without losing any', () => {
    const { model, first, second } = deckWithTwoSlides();
    model.moveSlide(0, 1);

    expect(model.slides.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(model.slides).toHaveLength(2);
  });
});

describe('Deleting a slide and undoing it', () => {
  it('restores the slide with its elements and its position', () => {
    const { model, first } = deckWithTwoSlides();
    const undo = new UndoStack(model);
    const originalOrder = model.slides.map((s) => s.id);

    undo.do(() => model.deleteSlide(first.id));
    expect(model.slides).toHaveLength(1);

    undo.undo();

    expect(model.slides.map((s) => s.id)).toEqual(originalOrder);
    expect(model.slide(first.id).elements).toHaveLength(1);
    expect(SlidesModel.plainText(model.slide(first.id).elements[0])).toBe('Title');
  });
});

describe('Elements', () => {
  it('a new element goes on top', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const a = model.addElement(slide.id, { kind: 'text' });
    const b = model.addElement(slide.id, { kind: 'text' });

    expect(b.z).toBeGreaterThan(a.z);
  });

  it('bringing to the front changes z, not the array order', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const a = model.addElement(slide.id, { kind: 'text' });
    const b = model.addElement(slide.id, { kind: 'text' });

    const orderBefore = slide.elements.map((e) => e.id);
    model.reorder(slide.id, [a.id], 'front');

    expect(slide.elements.map((e) => e.id)).toEqual(orderBefore);
    expect(model.element(slide.id, a.id).z).toBeGreaterThan(model.element(slide.id, b.id).z);
  });

  it('will not shrink an element to nothing', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const element = model.addElement(slide.id, { kind: 'text' });

    model.setBounds(slide.id, element.id, { x: 0, y: 0, w: 1, h: 1 });

    expect(model.element(slide.id, element.id).w).toBeGreaterThanOrEqual(24);
  });

  it('normalises a rotation past a full turn', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const element = model.addElement(slide.id, { kind: 'text' });

    model.setRotation(slide.id, [element.id], -45);

    expect(model.element(slide.id, element.id).rotation).toBe(315);
  });
});

describe('Text as runs', () => {
  it('keeps formatting per run inside one box', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const element = model.addElement(slide.id, { kind: 'text' });

    model.setContent(slide.id, element.id, [
      { text: 'plain ' }, { text: 'bold', bold: true }, { text: ' end' },
    ]);

    const stored = model.element(slide.id, element.id).content;
    expect(stored).toHaveLength(3);
    expect(stored[1].bold).toBe(true);
    expect(stored[0].bold).toBeUndefined();
    expect(SlidesModel.plainText(model.element(slide.id, element.id))).toBe('plain bold end');
  });

  it('never leaves a text box with no runs at all', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const element = model.addElement(slide.id, { kind: 'text' });

    model.setContent(slide.id, element.id, []);

    expect(model.element(slide.id, element.id).content).toEqual([{ text: '' }]);
  });
});

describe('Masters', () => {
  it('a master is an ordinary slide with a flag, drawn underneath', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const master = model.addMaster('Title and content');
    master.elements.push({ id: 'mlogo', kind: 'shape', x: 0, y: 0, w: 100, h: 100, z: 0 });

    model.assignMaster(slide.id, master.id);
    model.addElement(slide.id, { kind: 'text', z: 5 });

    const drawn = model.renderList(slide.id);
    expect(drawn).toHaveLength(2);
    expect(drawn[0].fromMaster).toBe(true);
  });

  it('assigning a master that does not exist clears it instead of breaking', () => {
    const model = new SlidesModel();
    model.assignMaster(model.slides[0].id, 'mnope');

    expect(model.slides[0].master).toBeNull();
  });
});

describe('Loading a document', () => {
  it('fills in what a script left out', () => {
    const model = new SlidesModel({
      version: 1, type: 'slides',
      slides: [{ elements: [{ kind: 'text', x: 10, y: 10, w: 100, h: 50 }] }],
    });

    expect(model.slides[0].elements[0].content).toEqual([{ text: '' }]);
    expect(model.slides[0].transition).toBe('none');
    expect(model.slides[0].elements[0].id).toBeTruthy();
  });

  it('rejects something that is not a document', () => {
    expect(() => new SlidesModel('nope')).toThrow();
  });

  it('lists the resources it refers to', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    model.addElement(slide.id, { kind: 'image', resource: 'resources/img-001.png' });
    model.addElement(slide.id, { kind: 'image', resource: 'resources/img-001.png' });
    model.addElement(slide.id, { kind: 'image', resource: 'resources/img-002.png' });

    expect(model.usedResources().sort()).toEqual([
      'resources/img-001.png', 'resources/img-002.png',
    ]);
  });
});

describe('One drag is one undo entry', () => {
  it('however many intermediate positions it passed through', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const element = model.addElement(slide.id, { kind: 'text', x: 0, y: 0 });
    const undo = new UndoStack(model);

    const before = model.snapshot();
    for (let i = 0; i < 40; i += 1) model.moveElements(slide.id, [element.id], 5, 0);
    undo.past.push(before);

    expect(undo.past).toHaveLength(1);
    expect(model.element(slide.id, element.id).x).toBe(200);

    undo.undo();
    expect(model.element(slide.id, element.id).x).toBe(0);
  });
});
