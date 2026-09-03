/** What leaves the program. */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from '../src/vendor/pdf-lib.esm.js';
import { SlidesModel } from '../src/js/model.js';
import { toHtml, slideToSvg, slideToPrintPage, wrapText, runMarkup } from '../src/js/export.js';
import { renderToPdf } from '../src/js/core/pdf.js';
import { auditBytes } from '../src/js/core/metadata.js';

function sampleDeck() {
  const model = new SlidesModel();
  const first = model.slides[0];
  model.addElement(first.id, {
    kind: 'text', x: 160, y: 200, w: 1600, h: 300, style: 'title',
    content: [{ text: 'A talk about ' }, { text: 'something', bold: true }],
  });
  const second = model.addSlide();
  model.addElement(second.id, {
    kind: 'text', x: 160, y: 200, w: 1600, h: 400, style: 'body',
    content: [{ text: 'The second slide' }],
  });
  model.addElement(second.id, { kind: 'shape', x: 100, y: 700, w: 300, h: 200 });
  return model;
}

describe('The exported HTML leaves no fingerprint', () => {
  it('names no software and carries no comment', () => {
    const html = toHtml(sampleDeck());

    for (const term of ['GRT', 'Slides', 'generator', 'Generator', 'PowerPoint']) {
      expect(html).not.toContain(term);
    }
    expect(html).not.toContain('<!--');
    expect(html).not.toContain('name="generator"');
  });

  it('carries no date, in any form', () => {
    const html = toHtml(sampleDeck());

    for (const year of ['2024', '2025', '2026', '2027', '1970']) {
      expect(html).not.toContain(year);
    }
  });

  it('does not put the file name in the title by default', () => {
    // A file name often carries more than its author intends.
    const model = sampleDeck();
    model.path = '/home/someone/Q3 layoffs draft.grt';

    expect(toHtml(model)).toContain('<title>Presentation</title>');
  });

  it('is the same bytes every time', () => {
    const model = sampleDeck();
    expect(toHtml(model)).toBe(toHtml(model));
  });
});

describe('The exported HTML is a working presentation', () => {
  it('contains one section per slide', () => {
    const html = toHtml(sampleDeck());
    // Matched on the opening tag rather than an exact class attribute.
    expect((html.match(/<section class="slide /g) ?? []).length).toBe(2);
  });

  it('brings its own keyboard navigation', () => {
    const html = toHtml(sampleDeck());

    for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'Home', 'End']) {
      expect(html).toContain(key);
    }
  });

  it('supports the black and white screen keys presenters expect', () => {
    // Standard practice for moving attention between slides.
    // off the screen.
    const html = toHtml(sampleDeck());
    expect(html).toContain("k==='b'");
    expect(html).toContain("k==='w'");
  });

  it('needs no network resource of any kind', () => {
    const html = toHtml(sampleDeck());

    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<link');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('inlines images as data URLs', () => {
    const model = sampleDeck();
    model.addElement(model.slides[0].id, {
      kind: 'image', resource: 'resources/img-001.png', x: 0, y: 0, w: 100, h: 100,
    });

    const html = toHtml(model, new Map([['resources/img-001.png', 'data:image/png;base64,AAAA']]));

    expect(html).toContain('data:image/png;base64,AAAA');
  });

  it('marks a missing image instead of dropping it silently', () => {
    const model = sampleDeck();
    model.addElement(model.slides[0].id, {
      kind: 'image', resource: 'resources/gone.png', x: 0, y: 0, w: 100, h: 100,
    });

    expect(toHtml(model)).toContain('class="el missing"');
  });

  it('escapes text that would otherwise break the page', () => {
    const model = new SlidesModel();
    model.addElement(model.slides[0].id, {
      kind: 'text', content: [{ text: '</script><script>alert(1)</script>' }],
    });

    const html = toHtml(model);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('Runs keep their formatting', () => {
  it('bold, italic and underline each get their own tag', () => {
    expect(runMarkup({ text: 'x', bold: true })).toContain('<strong>');
    expect(runMarkup({ text: 'x', italic: true })).toContain('<em>');
    expect(runMarkup({ text: 'x', underline: true })).toContain('<u>');
  });

  it('escapes before wrapping, not after', () => {
    expect(runMarkup({ text: '<b>', bold: true })).toBe('<strong>&lt;b&gt;</strong>');
  });
});

describe('SVG export', () => {
  it('produces one document per slide with the background painted', () => {
    const model = sampleDeck();
    const svg = slideToSvg(model, model.slides[0].id);

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('#ffffff');
  });

  it('carries no software name', () => {
    const model = sampleDeck();
    expect(slideToSvg(model, model.slides[0].id)).not.toContain('GRT');
  });
});

describe('PDF export', () => {
  it('produces a readable page per slide with metadata cleared', async () => {
    const model = sampleDeck();
    const bytes = await renderToPdf(slideToPrintPage(model, model.slides[0].id), { audit: false });

    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getAuthor()).toBe('');
    expect(doc.getCreationDate()?.getUTCFullYear()).toBe(1970);
  });

  it('leaves no generator fingerprint in the bytes', async () => {
    const model = sampleDeck();
    const bytes = await renderToPdf(slideToPrintPage(model, model.slides[0].id), { audit: false });

    expect(auditBytes(bytes)).toEqual([]);
  });

  it('uses the slide size as the page size', async () => {
    const model = sampleDeck();
    const page = slideToPrintPage(model, model.slides[0].id);

    expect(page.width).toBe(model.canvas.w);
    expect(page.height).toBe(model.canvas.h);
  });
});

describe('Text wrapping', () => {
  it('breaks a long line rather than letting it run off the slide', () => {
    expect(wrapText('one two three four five six seven eight nine', 300, 32).length)
      .toBeGreaterThan(1);
  });

  it('keeps explicit line breaks', () => {
    expect(wrapText('first\nsecond', 2000, 32)).toEqual(['first', 'second']);
  });
});

describe('Images reach the PDF', () => {
  /** The smallest valid PNG: one transparent pixel. */
  const onePixelPng = () => new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
    0x0d, 0x0a, 0x2d, 0xb4,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  function deckWithImage() {
    const model = new SlidesModel();
    model.addElement(model.slides[0].id, {
      kind: 'image', resource: 'resources/a.png', x: 100, y: 100, w: 400, h: 300,
    });
    return model;
  }

  it('an image becomes an image primitive, not an empty frame', () => {
    // Both this module and GRT Paper drew an outline and nothing else,
    // because the shared engine had no image primitive at all.
    const model = deckWithImage();
    const page = slideToPrintPage(model, model.slides[0].id,
      new Map([['resources/a.png', onePixelPng()]]));

    expect(page.primitives.some((p) => p.type === 'image')).toBe(true);
  });

  it('and the engine embeds it', async () => {
    const model = deckWithImage();
    const page = slideToPrintPage(model, model.slides[0].id,
      new Map([['resources/a.png', onePixelPng()]]));
    const pdf = await renderToPdf(page, { audit: false });

    expect(new TextDecoder('latin1').decode(pdf)).toContain('/Image');
    expect(auditBytes(pdf)).toEqual([]);
  });

  it('a missing picture stays an outline, so the gap is visible', () => {
    const model = deckWithImage();
    const page = slideToPrintPage(model, model.slides[0].id, new Map());

    expect(page.primitives.some((p) => p.type === 'image')).toBe(false);
    expect(page.primitives.some((p) => p.type === 'rect' && p.stroke)).toBe(true);
  });
});
