/** What leaves the program. */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from '../src/vendor/pdf-lib.esm.js';
import { PaperModel } from '../src/js/core/editor/model.js';
import { toMarkdown, toHtml, toPlainText, toPrintPages, outline, wrapText } from '../src/js/export.js';
import { renderToPdf } from '../src/js/core/pdf.js';
import { auditBytes } from '../src/js/core/metadata.js';

function document() {
  return new PaperModel({
    blocks: [
      { id: 'h1', kind: 'heading', level: 1, style: 'h1', runs: [{ text: 'The Title' }] },
      {
        id: 'p1',
        kind: 'paragraph',
        runs: [{ text: 'Plain then ' }, { text: 'bold', bold: true }, { text: '.' }],
      },
      { id: 'h2', kind: 'heading', level: 2, style: 'h2', runs: [{ text: 'A Section' }] },
      {
        id: 'l1',
        kind: 'list',
        listType: 'bullet',
        items: [
          { level: 0, runs: [{ text: 'first item' }] },
          { level: 1, runs: [{ text: 'nested item' }] },
        ],
      },
      { id: 'q1', kind: 'quote', style: 'quote', runs: [{ text: 'A quotation.' }] },
    ],
  });
}

describe('Markdown', () => {
  it('turns headings, lists and marks into Markdown', () => {
    const { text } = toMarkdown(document());

    expect(text).toContain('# The Title');
    expect(text).toContain('## A Section');
    expect(text).toContain('**bold**');
    expect(text).toContain('- first item');
    expect(text).toContain('  - nested item');
    expect(text).toContain('> A quotation.');
  });

  it('escapes characters that would otherwise become formatting', () => {
    const model = new PaperModel({
      blocks: [{ id: 'b', kind: 'paragraph', runs: [{ text: 'a * b _ c [d]' }] }],
    });

    const { text } = toMarkdown(model);
    expect(text).toContain('\\*');
    expect(text).toContain('\\_');
    expect(text).toContain('\\[');
  });

  it('says what it cannot carry', () => {
    // an export that silently drops things is discovered too late.
    const model = new PaperModel({
      blocks: [
        { id: 'b', kind: 'paragraph', align: 'center', runs: [{ text: 'x', underline: true }] },
        { id: 'i', kind: 'image', resource: 'resources/a.png', w: 100, h: 80 },
      ],
    });

    const { lost } = toMarkdown(model);
    const joined = lost.join(' ');

    expect(joined).toMatch(/underlin/i);
    expect(joined).toMatch(/alignment/i);
    expect(joined).toMatch(/image/i);
    expect(joined).toMatch(/pagination|margins/i);
  });

  it('always warns about pagination, because Markdown has none', () => {
    expect(toMarkdown(document()).lost.join(' ')).toMatch(/page size/i);
  });
});

describe('HTML', () => {
  it('is a complete page with the document in it', () => {
    const html = toHtml(document());

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<h1>The Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<blockquote>');
  });

  it('carries no software name, comment or date', () => {
    const html = toHtml(document());

    for (const term of ['GRT', 'Paper', 'generator', '<!--', '2026', '1970']) {
      expect(html).not.toContain(term);
    }
  });

  it('needs nothing from the network', () => {
    const html = toHtml(document());

    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<link');
  });

  it('escapes text that would otherwise become markup', () => {
    const model = new PaperModel({
      blocks: [{ id: 'b', kind: 'paragraph', runs: [{ text: '<script>alert(1)</script>' }] }],
    });

    const html = toHtml(model);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('inlines an image and marks a missing one', () => {
    const model = new PaperModel({
      blocks: [{ id: 'i', kind: 'image', resource: 'resources/a.png', w: 200, h: 100 }],
    });

    expect(toHtml(model, new Map([['resources/a.png', 'data:image/png;base64,AAA']])))
      .toContain('data:image/png;base64,AAA');
    expect(toHtml(model)).toContain('dashed');
  });

  it('is the same bytes every time', () => {
    const model = document();
    expect(toHtml(model)).toBe(toHtml(model));
  });
});

describe('Plain text', () => {
  it('keeps the words and the list markers, and nothing else', () => {
    const text = toPlainText(document());

    expect(text).toContain('The Title');
    expect(text).toContain('- first item');
    expect(text).not.toContain('**');
    expect(text).not.toContain('<');
  });
});

describe('PDF', () => {
  it('produces one readable document with the metadata cleared', async () => {
    const pages = toPrintPages(document());
    const bytes = await renderToPdf(pages[0], { audit: false });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });

    expect(doc.getPageCount()).toBe(1);
    expect(doc.getAuthor()).toBe('');
    expect(doc.getProducer()).toBe('');
    expect(doc.getCreationDate()?.getUTCFullYear()).toBe(1970);
  });

  it('leaves no generator fingerprint in the bytes', async () => {
    const pages = toPrintPages(document());
    const bytes = await renderToPdf(pages[0], { audit: false });

    expect(auditBytes(bytes)).toEqual([]);
  });

  it('is a single-trailer file, never an incremental append', async () => {
    const pages = toPrintPages(document());
    const bytes = await renderToPdf(pages[0], { audit: false });
    const raw = new TextDecoder('latin1').decode(bytes);

    expect(raw.split('%%EOF').length - 1).toBe(1);
  });

  it('uses the page size the document asks for', () => {
    const model = document();
    model.setPage({ size: 'A5' });

    const [page] = toPrintPages(model);
    // A5 is 148 mm wide; in points that is about 420.
    expect(page.width).toBeCloseTo(419.5, 0);
  });

  it('landscape swaps the sides', () => {
    const model = document();
    model.setPage({ orientation: 'landscape' });

    const [page] = toPrintPages(model);
    expect(page.width).toBeGreaterThan(page.height);
  });

  it('a long document runs onto more than one page', () => {
    const model = new PaperModel({
      blocks: Array.from({ length: 120 }, (_, i) => ({
        id: `b${i}`, kind: 'paragraph', runs: [{ text: `Paragraph number ${i}, with some words in it.` }],
      })),
    });

    expect(toPrintPages(model).length).toBeGreaterThan(1);
  });

  it('a manual break starts a new page', () => {
    const model = new PaperModel({
      blocks: [
        { id: 'a', kind: 'paragraph', runs: [{ text: 'before' }] },
        { id: 'b', kind: 'paragraph', breakBefore: true, runs: [{ text: 'after' }] },
      ],
    });

    expect(toPrintPages(model)).toHaveLength(2);
  });
});

describe('Wrapping and the outline', () => {
  it('breaks a long line rather than letting it run off the page', () => {
    expect(wrapText('word '.repeat(60), 400, 11).length).toBeGreaterThan(1);
  });

  it('an empty line still produces one line', () => {
    expect(wrapText('', 400, 11)).toEqual(['']);
  });

  it('the outline lists the headings with their levels', () => {
    expect(outline(document())).toEqual([
      { id: 'h1', level: 1, text: 'The Title' },
      { id: 'h2', level: 2, text: 'A Section' },
    ]);
  });
});

describe('Determinism', () => {
  it('two serialisations of the same document are identical', () => {
    const model = document();
    expect(JSON.stringify(model.toJSON())).toBe(JSON.stringify(model.toJSON()));
  });

  it('and a reload changes nothing', () => {
    // A key that appears only after a reload would make the second save
    // differ from the first.
    const model = document();
    const once = JSON.stringify(model.toJSON(), null, 2);
    const reloaded = new PaperModel(JSON.parse(once));

    expect(JSON.stringify(reloaded.toJSON(), null, 2)).toBe(once);
  });

  it('carries no timestamp anywhere', () => {
    const text = JSON.stringify(document().toJSON());

    for (const year of ['2024', '2025', '2026', '2027']) {
      expect(text).not.toContain(year);
    }
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

  const withImage = () => new PaperModel({
    blocks: [
      { id: 'p', kind: 'paragraph', runs: [{ text: 'Before the picture.' }] },
      { id: 'i', kind: 'image', resource: 'resources/a.png', w: 400, h: 260 },
    ],
  });

  it('an image becomes an image primitive, not an empty frame', () => {
    // The first version drew an outline and nothing else, so every exported
    // PDF came out with holes where the pictures were.
    const bytes = new Map([['resources/a.png', onePixelPng()]]);
    const [page] = toPrintPages(withImage(), bytes);

    const image = page.primitives.find((p) => p.type === 'image');
    expect(image).toBeDefined();
    expect(image.bytes).toBeInstanceOf(Uint8Array);
    expect(page.primitives.some((p) => p.type === 'rect' && p.stroke)).toBe(false);
  });

  it('and the engine embeds it', async () => {
    const bytes = new Map([['resources/a.png', onePixelPng()]]);
    const [page] = toPrintPages(withImage(), bytes);
    const pdf = await renderToPdf(page, { audit: false });

    // A PDF that carries a picture has an image XObject in it.
    expect(new TextDecoder('latin1').decode(pdf)).toContain('/Image');
  });

  it('a missing picture is still an outline, so the gap is visible', () => {
    const [page] = toPrintPages(withImage(), new Map());

    expect(page.primitives.some((p) => p.type === 'image')).toBe(false);
    expect(page.primitives.some((p) => p.type === 'rect' && p.stroke)).toBe(true);
  });

  it('a picture too wide for the column is scaled to fit it', () => {
    const model = new PaperModel({
      blocks: [{ id: 'i', kind: 'image', resource: 'r', w: 4000, h: 3000 }],
    });
    const [page] = toPrintPages(model, new Map([['r', onePixelPng()]]));
    const image = page.primitives.find((p) => p.type === 'image');

    expect(image.w).toBeLessThanOrEqual(page.width);
    expect(image.x).toBeGreaterThanOrEqual(0);
  });

  it('a caption is written under the picture', () => {
    const model = new PaperModel({
      blocks: [{
        id: 'i', kind: 'image', resource: 'r', w: 200, h: 120,
        caption: [{ text: 'Figure one' }],
      }],
    });
    const [page] = toPrintPages(model, new Map([['r', onePixelPng()]]));

    expect(page.primitives.some((p) => p.type === 'text' && p.text === 'Figure one')).toBe(true);
  });

  it('the document still exports cleanly with a picture in it', async () => {
    const bytes = new Map([['resources/a.png', onePixelPng()]]);
    const [page] = toPrintPages(withImage(), bytes);
    const pdf = await renderToPdf(page, { audit: false });

    expect(auditBytes(pdf)).toEqual([]);
    expect(new TextDecoder('latin1').decode(pdf).split('%%EOF').length - 1).toBe(1);
  });
});
