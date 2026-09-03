/** The feature that must not be faked. */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DocumentModel } from '../src/js/document-model.js';
import { buildOutputBytes } from '../src/js/save.js';
import { redactContent } from '../src/js/redact.js';
import { tokenize, serialize } from '../src/js/content-stream.js';
import { contains } from './helpers.js';

/** A page with three lines of text at known heights. */
async function makeLinedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText('TOPLINEPUBLIC', { x: 60, y: 700, size: 20, font });
  page.drawText('MIDDLESECRETVALUE', { x: 60, y: 400, size: 20, font });
  page.drawText('BOTTOMLINEPUBLIC', { x: 60, y: 100, size: 20, font });
  return doc.save();
}

// Fractions from the top left, matching how the interface stores marks.
const MIDDLE_BAND = { x: 0.05, y: 0.44, width: 0.9, height: 0.12 };

describe('The check is capable of failing', () => {
  it('finds all three lines when nothing is redacted', async () => {
    const model = new DocumentModel(await makeLinedPdf(), 1);
    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'TOPLINEPUBLIC')).toBe(true);
    expect(contains(out, 'MIDDLESECRETVALUE')).toBe(true);
    expect(contains(out, 'BOTTOMLINEPUBLIC')).toBe(true);
  });
});

describe('Redaction removes rather than covers', () => {
  it('the redacted text is not recoverable from the output', async () => {
    const model = new DocumentModel(await makeLinedPdf(), 1);
    model.addMark(0, 'redact', MIDDLE_BAND);

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'MIDDLESECRETVALUE')).toBe(false);
  });

  it('leaves the rest of the page intact', async () => {
    const model = new DocumentModel(await makeLinedPdf(), 1);
    model.addMark(0, 'redact', MIDDLE_BAND);

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'TOPLINEPUBLIC')).toBe(true);
    expect(contains(out, 'BOTTOMLINEPUBLIC')).toBe(true);
  });

  it('still produces a readable PDF with the same page count', async () => {
    const model = new DocumentModel(await makeLinedPdf(), 1);
    model.addMark(0, 'redact', MIDDLE_BAND);

    const out = await buildOutputBytes(model, { audit: false });
    const doc = await PDFDocument.load(out);

    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize().width).toBeCloseTo(600, 0);
  });

  it('a highlight does NOT remove anything — it is only a mark', async () => {
    // Stated as a test so the difference between the two is never blurred.
    const model = new DocumentModel(await makeLinedPdf(), 1);
    model.addMark(0, 'highlight', MIDDLE_BAND);

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'MIDDLESECRETVALUE')).toBe(true);
  });

  it('redacting everything leaves no source text at all', async () => {
    const model = new DocumentModel(await makeLinedPdf(), 1);
    model.addMark(0, 'redact', { x: 0, y: 0, width: 1, height: 1 });

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'TOPLINEPUBLIC')).toBe(false);
    expect(contains(out, 'MIDDLESECRETVALUE')).toBe(false);
    expect(contains(out, 'BOTTOMLINEPUBLIC')).toBe(false);
  });

  it('survives being undone', async () => {
    const model = new DocumentModel(await makeLinedPdf(), 1);
    const before = model.snapshot();
    model.addMark(0, 'redact', MIDDLE_BAND);
    model.restore(before);

    const out = await buildOutputBytes(model, { audit: false });

    // The snapshot must not have shared the marks array with the live page.
    expect(contains(out, 'MIDDLESECRETVALUE')).toBe(true);
  });
});

describe('Content stream tokeniser', () => {
  it('round-trips a stream it does not change', () => {
    const source = new TextEncoder().encode(
      'q 1 0 0 1 10 20 cm BT /F1 12 Tf (hello) Tj ET Q\n',
    );
    const out = serialize(tokenize(source));
    const text = new TextDecoder('latin1').decode(out);

    for (const piece of ['q', 'cm', 'BT', '/F1', '(hello)', 'Tj', 'ET', 'Q']) {
      expect(text).toContain(piece);
    }
  });

  it('does not mistake text inside a string for an operator', () => {
    const source = new TextEncoder().encode('BT (BT ET Q q) Tj ET');
    const tokens = tokenize(source);
    const operators = tokens.filter((t) => t.type === 'operator').map((t) => t.value);

    expect(operators).toEqual(['BT', 'Tj', 'ET']);
  });

  it('handles escaped and nested parentheses', () => {
    const source = new TextEncoder().encode(String.raw`((a\)b) c) Tj`);
    const strings = tokenize(source).filter((t) => t.type === 'string');

    expect(strings).toHaveLength(1);
    expect(strings[0].value).toBe('(a)b) c');
  });

  it('keeps inline image data out of the token stream', () => {
    // Binary image bytes routinely contain sequences that look like
    // operators; tokenising them would corrupt the page.
    const source = new TextEncoder().encode(
      'q BI /W 2 /H 2 ID \x00Tj ET Q\xff\x01 EI Q',
    );
    const tokens = tokenize(source);
    const operators = tokens.filter((t) => t.type === 'operator').map((t) => t.value);

    expect(tokens.some((t) => t.type === 'inline-image')).toBe(true);
    expect(operators).toEqual(['q', 'Q']);
  });
});

describe('Redaction reports its own failures', () => {
  it('reports nothing left behind on a clean rewrite', () => {
    const source = new TextEncoder().encode(
      'BT /F1 12 Tf 1 0 0 1 50 400 Tm (SECRETWORD) Tj ET',
    );
    const result = redactContent(source, [{ x: 0, y: 380, x2: 550, y2: 430 }]);

    expect(result.removed).toContain('SECRETWORD');
    expect(result.leaked).toEqual([]);
    expect(new TextDecoder('latin1').decode(result.bytes)).not.toContain('SECRETWORD');
  });

  it('leaves text outside the region alone', () => {
    const source = new TextEncoder().encode(
      'BT /F1 12 Tf 1 0 0 1 50 700 Tm (KEEPME) Tj ET',
    );
    const result = redactContent(source, [{ x: 0, y: 100, x2: 550, y2: 200 }]);

    expect(result.removed).toEqual([]);
    expect(new TextDecoder('latin1').decode(result.bytes)).toContain('KEEPME');
  });

  it('removes an image placed inside the region', () => {
    const source = new TextEncoder().encode(
      'q 200 0 0 100 50 380 cm /Im1 Do Q',
    );
    const result = redactContent(source, [{ x: 0, y: 350, x2: 550, y2: 500 }]);

    expect(new TextDecoder('latin1').decode(result.bytes)).not.toContain('/Im1');
  });

  it('does nothing at all when there are no regions', () => {
    const source = new TextEncoder().encode('BT (ANY) Tj ET');
    const result = redactContent(source, []);

    expect(result.bytes).toBe(source);
  });
});
