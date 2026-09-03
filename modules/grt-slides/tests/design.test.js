/** Colours, fonts, backgrounds and transitions. */

import { describe, it, expect } from 'vitest';
import { SlidesModel, FONTS, PRESETS, fontStack } from '../src/js/model.js';
import { toHtml, slideToSvg, elementMarkup, slideToPrintPage } from '../src/js/export.js';

function deck() {
  const model = new SlidesModel();
  const slide = model.slides[0];
  const text = model.addElement(slide.id, {
    kind: 'text', x: 0, y: 0, w: 800, h: 200, style: 'title',
    content: [{ text: 'Heading' }],
  });
  const shape = model.addElement(slide.id, {
    kind: 'shape', shape: 'rect', x: 0, y: 300, w: 200, h: 100,
  });
  return { model, slide, text, shape };
}

describe('Named styles reach everything', () => {
  it('changing a style changes every element using it', () => {
    const { model, slide } = deck();
    model.addElement(slide.id, { kind: 'text', style: 'title', content: [{ text: 'Second' }] });

    model.setStyle('title', { color: '#ff0000' });
    const html = toHtml(model);

    expect((html.match(/#ff0000/g) ?? []).length).toBe(2);
  });

  it('the font choice reaches the markup as a real stack', () => {
    const { model } = deck();
    model.setStyle('title', { font: 'mono' });

    expect(toHtml(model)).toContain(fontStack('mono'));
  });

  it('every offered font has a stack behind it', () => {
    for (const id of Object.keys(FONTS)) {
      expect(fontStack(id)).toMatch(/\w/);
    }
    // An unknown name must not produce "undefined" in a style attribute.
    expect(fontStack('nonsense')).toBe(fontStack('sans'));
  });
});

describe('Element overrides beat the style', () => {
  it('a text colour override wins', () => {
    const { model, slide, text } = deck();
    model.setStyle('title', { color: '#111111' });
    model.setElementColour(slide.id, [text.id], { colour: '#00ff00' });

    const markup = elementMarkup(model.element(slide.id, text.id), model);
    expect(markup).toContain('#00ff00');
    expect(markup).not.toContain('#111111');
  });

  it('clearing the override goes back to the style', () => {
    const { model, slide, text } = deck();
    model.setElementColour(slide.id, [text.id], { colour: '#00ff00' });
    model.setElementColour(slide.id, [text.id], { colour: '' });

    expect(model.element(slide.id, text.id).color).toBeUndefined();
    expect(elementMarkup(model.element(slide.id, text.id), model))
      .toContain(model.styles.title.color);
  });

  it('a shape fill overrides the accent colour', () => {
    const { model, slide, shape } = deck();
    model.setElementColour(slide.id, [shape.id], { fill: '#123456' });

    expect(elementMarkup(model.element(slide.id, shape.id), model)).toContain('#123456');
  });

  it('a font override applies to the element only', () => {
    const { model, slide, text } = deck();
    model.setElementFont(slide.id, [text.id], 'serif');

    expect(elementMarkup(model.element(slide.id, text.id), model))
      .toContain(fontStack('serif'));
  });

  it('an unknown font is refused rather than written through', () => {
    const { model, slide, text } = deck();
    model.setElementFont(slide.id, [text.id], 'comic');

    expect(model.element(slide.id, text.id).font).toBeUndefined();
  });
});

describe('Per-slide backgrounds', () => {
  it('a slide can override the deck', () => {
    const { model, slide } = deck();
    model.setSlideBackground(slide.id, '#010203');

    expect(model.slideBackground(slide.id)).toBe('#010203');
    expect(toHtml(model)).toContain('#010203');
  });

  it('clearing it goes back to the theme', () => {
    const { model, slide } = deck();
    model.setSlideBackground(slide.id, '#010203');
    model.setSlideBackground(slide.id, null);

    expect(model.slideBackground(slide.id)).toBe(model.theme.background);
  });

  it('reaches the SVG and the PDF page as well as the HTML', () => {
    const { model, slide } = deck();
    model.setSlideBackground(slide.id, '#0a0b0c');

    expect(slideToSvg(model, slide.id)).toContain('#0a0b0c');
    expect(slideToPrintPage(model, slide.id).primitives[0].fill).toBe('#0a0b0c');
  });
});

describe('Presets', () => {
  it('each one sets a theme and every style', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      const model = new SlidesModel();
      model.applyPreset(id);

      expect(model.theme.background).toBe(preset.theme.background);
      for (const name of ['title', 'body', 'caption']) {
        expect(model.styles[name].color).toBe(preset.styles[name].color);
      }
    }
  });

  it('a slide with its own background keeps it through a preset', () => {
    // An explicit choice on one slide should survive a change of look.
    const { model, slide } = deck();
    model.setSlideBackground(slide.id, '#ff00ff');
    model.applyPreset('ink');

    expect(model.slideBackground(slide.id)).toBe('#ff00ff');
  });

  it('an unknown preset changes nothing', () => {
    const model = new SlidesModel();
    const before = JSON.stringify(model.toJSON());
    model.applyPreset('nope');

    expect(JSON.stringify(model.toJSON())).toBe(before);
  });
});

describe('Transitions', () => {
  it('are stored per slide and reach the exported file', () => {
    const { model, slide } = deck();
    model.setTransition(slide.id, 'fade');

    expect(toHtml(model)).toContain('class="slide t-fade"');
  });

  it('can be set on every slide at once', () => {
    const { model } = deck();
    model.addSlide();
    model.setAllTransitions('slide');

    expect(model.slides.every((s) => s.transition === 'slide')).toBe(true);
  });

  it('an unknown transition is refused', () => {
    const { model, slide } = deck();
    model.setTransition(slide.id, 'explode');

    expect(model.slide(slide.id).transition).toBe('none');
  });

  it('the exported file honours a request for reduced motion', () => {
    // An animation nobody asked for is worse than none, and someone who has
    // told their system so has already asked.
    expect(toHtml(deck().model)).toContain('prefers-reduced-motion');
  });
});

describe('The slide shape stays stable', () => {
  it('a fresh slide already carries every key a reloaded one has', () => {
    // A key that appears only after a reload makes the second save of a
    // document differ from the first.
    const fresh = new SlidesModel();
    const reloaded = new SlidesModel(JSON.parse(JSON.stringify(fresh.toJSON())));

    expect(Object.keys(reloaded.slides[0]).sort())
      .toEqual(Object.keys(fresh.slides[0]).sort());
  });
});

describe('Canvas sizes', () => {
  it('scales what is on the slides so nothing falls off the edge', async () => {
    const { CANVAS_PRESETS } = await import('../src/js/model.js');
    const { model, slide, text } = deck();
    model.addElement(slide.id, { kind: 'text', x: 1800, y: 1000, w: 100, h: 60 });

    model.setCanvas(CANVAS_PRESETS['4:3']);

    for (const element of model.slide(slide.id).elements) {
      expect(element.x + element.w).toBeLessThanOrEqual(model.canvas.w + 1);
      expect(element.y + element.h).toBeLessThanOrEqual(model.canvas.h + 1);
    }
    expect(model.element(slide.id, text.id).w).toBeGreaterThan(0);
  });

  it('leaves everything where it is when asked not to scale', () => {
    const { model, slide, text } = deck();
    const before = { ...model.element(slide.id, text.id) };

    model.setCanvas({ w: 1000, h: 800 }, { scaleElements: false });

    expect(model.element(slide.id, text.id).x).toBe(before.x);
    expect(model.element(slide.id, text.id).w).toBe(before.w);
  });

  it('refuses a size that is not a size', () => {
    const { model } = deck();
    const before = { ...model.canvas };
    model.setCanvas({ w: 0, h: -5 });

    expect(model.canvas).toEqual(before);
  });

  it('scales the elements on a master too', () => {
    const { model } = deck();
    const master = model.addMaster('m');
    master.elements.push({ id: 'mx', kind: 'shape', x: 100, y: 100, w: 200, h: 100, z: 0 });

    model.setCanvas({ w: model.canvas.w / 2, h: model.canvas.h / 2 });

    expect(master.elements[0].x).toBe(50);
    expect(master.elements[0].w).toBe(100);
  });
});

describe('Shapes and lines', () => {
  it('every shape in the palette produces markup of its own', async () => {
    const { SHAPES } = await import('../src/js/model.js');
    const { shapePath } = await import('../src/js/export.js');

    const seen = new Set();
    for (const shape of SHAPES) {
      const markup = shapePath(shape, '#123456');
      expect(markup).toContain('#123456');
      seen.add(markup);
    }
    // Seven shapes that all drew the same thing would be a palette in name
    // only.
    expect(seen.size).toBeGreaterThan(4);
  });

  it('a line is drawn, and can carry an arrow', () => {
    const { model, slide } = deck();
    const line = model.addElement(slide.id, {
      kind: 'line', x: 0, y: 0, w: 400, h: 200, arrow: true,
    });

    const markup = elementMarkup(model.element(slide.id, line.id), model);
    expect(markup).toContain('<line');
    expect(markup).toContain('marker-end');
  });

  it('an unknown shape falls back rather than vanishing', () => {
    const { model, slide } = deck();
    const element = model.addElement(slide.id, { kind: 'shape', shape: 'spaceship' });

    expect(model.element(slide.id, element.id).shape).toBe('rect');
  });
});
