/** Watermarks, page numbers, crop and deliberate metadata. */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DocumentModel } from '../src/js/document-model.js';
import { buildBytesFromPlan } from '../src/js/save.js';
import { contains } from './helpers.js';

async function makeTestPdf(pageTexts) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 700, size: 24, font });
  }
  return doc.save();
}

const build = (model, options = {}) =>
  buildBytesFromPlan(model, model.buildPlan(), { audit: false, ...options });

describe('Watermark', () => {
  it('reaches the output', async () => {
    const model = new DocumentModel(await makeTestPdf(['A', 'B']), 2);
    const out = await build(model, { watermark: { text: 'DRAFTMARK', opacity: 0.2 } });

    expect(contains(out, 'DRAFTMARK')).toBe(true);
  });

  it('does nothing when the text is blank', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    const plain = await build(model);
    const blank = await build(model, { watermark: { text: '   ' } });

    expect(blank.length).toBe(plain.length);
  });

  it('embeds no font program, so no foundry strings enter the file', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    const out = await build(model, { watermark: { text: 'MARKED' } });
    const raw = new TextDecoder('latin1').decode(out);

    // Only the 14 standard fonts are used; a FontFile key would mean a font
    // program was written into the document.
    expect(raw).not.toContain('/FontFile');
  });
});

describe('Page numbers', () => {
  it('writes the number on each page', async () => {
    const model = new DocumentModel(await makeTestPdf(['A', 'B', 'C']), 3);
    const out = await build(model, {
      pageNumbers: { start: 1, format: 'p{n}z', position: 'bottom-center' },
    });

    expect(contains(out, 'p1z')).toBe(true);
    expect(contains(out, 'p3z')).toBe(true);
  });

  it('honours a starting offset', async () => {
    const model = new DocumentModel(await makeTestPdf(['A', 'B']), 2);
    const out = await build(model, {
      pageNumbers: { start: 41, format: 'q{n}q', position: 'bottom-right' },
    });

    expect(contains(out, 'q41q')).toBe(true);
    expect(contains(out, 'q42q')).toBe(true);
  });

  it('expands {total}', async () => {
    const model = new DocumentModel(await makeTestPdf(['A', 'B']), 2);
    const out = await build(model, {
      pageNumbers: { start: 1, format: 'x{n}of{total}x', position: 'bottom-center' },
    });

    expect(contains(out, 'x1of2x')).toBe(true);
  });

  it('numbers what survives, not the original page count', async () => {
    const model = new DocumentModel(await makeTestPdf(['A', 'B', 'C']), 3);
    model.deletePage(1);
    const out = await build(model, {
      pageNumbers: { start: 1, format: 'n{n}of{total}n', position: 'bottom-center' },
    });

    expect(contains(out, 'n1of2n')).toBe(true);
    expect(contains(out, 'n3of3n')).toBe(false);
  });
});

describe('Deliberate metadata', () => {
  it('survives the stripping that runs just before it', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    const out = await build(model, {
      metadata: { title: 'Chosen Title', author: 'Chosen Author' },
    });

    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getTitle()).toBe('Chosen Title');
    expect(doc.getAuthor()).toBe('Chosen Author');
  });

  it('leaves untouched fields empty rather than writing placeholders', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    const out = await build(model, { metadata: { title: 'Only A Title' } });

    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getAuthor()).toBe('');
    expect(doc.getCreator()).toBe('');
  });

  it('keeps dates at the epoch whatever else is set', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    const out = await build(model, { metadata: { title: 'T', author: 'A' } });

    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getCreationDate()?.getUTCFullYear()).toBe(1970);
  });

  it('splits keywords on commas', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    const out = await build(model, { metadata: { keywords: 'one, two , three' } });

    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getKeywords()).toContain('one');
    expect(doc.getKeywords()).toContain('three');
  });
});

describe('Crop', () => {
  it('narrows the visible box without touching the media box', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    model.cropPages([0], { top: 0.1, bottom: 0.1, left: 0, right: 0 });

    const out = await build(model);
    const page = (await PDFDocument.load(out)).getPage(0);

    expect(page.getMediaBox().height).toBeCloseTo(842, 0);
    expect(page.getCropBox().height).toBeCloseTo(842 * 0.8, 0);
  });

  it('refuses a crop that would leave nothing', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    expect(() => model.cropPages([0], { top: 0.5, bottom: 0.5, left: 0, right: 0 }))
      .toThrow(/nothing visible/);
  });

  it('can be undone by clearing', async () => {
    const model = new DocumentModel(await makeTestPdf(['A']), 1);
    model.cropPages([0], { top: 0.2, bottom: 0, left: 0, right: 0 });
    model.clearCrop([0]);

    const out = await build(model);
    const page = (await PDFDocument.load(out)).getPage(0);
    expect(page.getCropBox().height).toBeCloseTo(842, 0);
  });

  it('cropping hides but does not remove — the text is still in the file', async () => {
    // Documented behaviour, not an oversight.
    const model = new DocumentModel(await makeTestPdf(['CROPPEDAWAYTEXT']), 1);
    model.cropPages([0], { top: 0.4, bottom: 0.4, left: 0, right: 0 });

    const out = await build(model);
    expect(contains(out, 'CROPPEDAWAYTEXT')).toBe(true);
  });
});

describe('Split', () => {
  it('produces chunks that cover every page exactly once', async () => {
    const model = new DocumentModel(await makeTestPdf(['A', 'B', 'C', 'D', 'E']), 5);
    const size = 2;
    const total = model.visibleCount;
    const seen = [];

    for (let chunk = 0; chunk * size < total; chunk += 1) {
      const indices = [];
      for (let i = chunk * size; i < Math.min((chunk + 1) * size, total); i += 1) {
        indices.push(i);
      }
      const bytes = await buildBytesFromPlan(model, model.buildPlanFor(indices), { audit: false });
      seen.push((await PDFDocument.load(bytes)).getPageCount());
    }

    expect(seen).toEqual([2, 2, 1]);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(5);
  });
});

describe('Decorations do not weaken the core guarantees', () => {
  it('a watermarked save is still a single-trailer regeneration', async () => {
    const model = new DocumentModel(await makeTestPdf(['A', 'SECRETPAGE', 'C']), 3);
    model.deletePage(1);

    const out = await build(model, {
      watermark: { text: 'CONFIDENTIAL' },
      pageNumbers: { start: 1, format: '{n}', position: 'bottom-center' },
      metadata: { title: 'Public Copy' },
    });

    const raw = new TextDecoder('latin1').decode(out);
    expect(raw.split('%%EOF').length - 1).toBe(1);
    expect(contains(out, 'SECRETPAGE')).toBe(false);
    expect(contains(out, 'pdf-lib')).toBe(false);
    expect(contains(out, 'xmpmeta')).toBe(false);
  });
});
