/** Tests for the project's central requirement. */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DocumentModel } from '../src/js/document-model.js';
import { buildOutputBytes } from '../src/js/save.js';
import { readMetadata, stripMetadata } from '../src/js/core/metadata.js';
import { deepText, contains } from './helpers.js';

/** Creates a test PDF with recognisable text on every page. */
async function makeTestPdf(pageTexts, metadata = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const text of pageTexts) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 700, size: 24, font });
  }

  if (metadata.author) doc.setAuthor(metadata.author);
  if (metadata.title) doc.setTitle(metadata.title);
  if (metadata.creator) doc.setCreator(metadata.creator);

  return doc.save();
}

// Searching the raw bytes is not enough.
const asText = (bytes) => deepText(bytes);

describe('Full document regeneration', () => {
  it('the content of a deleted page does NOT survive in the final bytes', async () => {
    // THIS IS THE MOST IMPORTANT TEST IN THE ENTIRE PROJECT.
    const src = await makeTestPdf([
      'PUBLIC PAGE ONE',
      'CONFIDENTIAL CONTENT TO BE REMOVED',
      'PUBLIC PAGE THREE',
    ]);

    const model = new DocumentModel(src, 3);
    model.deletePage(1);

    const out = await buildOutputBytes(model, { audit: false });
    const text = asText(out);

    expect(text).not.toContain('CONFIDENTIAL');
    expect(text).not.toContain('REMOVED');
    // The counterpart assertion.
    expect(contains(out, 'PUBLIC')).toBe(true);
  });

  it('keeps the pages that were not deleted', async () => {
    const src = await makeTestPdf(['ALFA', 'BETA', 'GAMMA']);
    const model = new DocumentModel(src, 3);
    model.deletePage(1);

    const out = await buildOutputBytes(model, { audit: false });
    const doc = await PDFDocument.load(out);

    expect(doc.getPageCount()).toBe(2);
  });

  it('does not add an incremental update section', async () => {
    // A regenerated file has a single xref table / a single trailer.
    const src = await makeTestPdf(['ONE', 'TWO']);
    const model = new DocumentModel(src, 2);
    model.rotatePage(0, 90);

    const out = await buildOutputBytes(model, { audit: false });
    // Counted on the raw bytes on purpose.
    const raw = new TextDecoder('latin1').decode(out);
    const occurrences = raw.split('%%EOF').length - 1;

    expect(occurrences).toBe(1);
  });
});

describe('Metadata stripping', () => {
  it('removes author, title and creator present in the original', async () => {
    const src = await makeTestPdf(['TEXT'], {
      author: 'Mario Rossi',
      title: 'Confidential Document',
      creator: 'Microsoft Word',
    });

    // Guards against the assertions going vacuous.
    expect(contains(src, 'Mario Rossi')).toBe(true);

    const model = new DocumentModel(src, 1);
    const out = await buildOutputBytes(model, { audit: false });
    const text = asText(out);

    expect(text).not.toContain('Mario Rossi');
    expect(text).not.toContain('Confidential Document');
    expect(text).not.toContain('Microsoft Word');
  });

  it("does not leave pdf-lib's default Producer", async () => {
    const src = await makeTestPdf(['TEXT']);
    const model = new DocumentModel(src, 1);

    const out = await buildOutputBytes(model, { audit: false });

    expect(asText(out)).not.toContain('pdf-lib');
  });

  it('removes the XMP block from the catalog', async () => {
    const src = await makeTestPdf(['TEXT']);
    const model = new DocumentModel(src, 1);

    const out = await buildOutputBytes(model, { audit: false });

    expect(asText(out)).not.toContain('xmpmeta');
  });

  it('zeroes the dates instead of setting them to the current time', async () => {
    const src = await makeTestPdf(['TEXT']);
    const model = new DocumentModel(src, 1);

    const out = await buildOutputBytes(model, { audit: false });
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const { info } = readMetadata(doc);

    // A current-year timestamp would reveal when the file was created, and
    // indirectly the time zone of whoever produced it.
    expect(info.creationDate?.getUTCFullYear()).toBe(1970);
  });

  it('stripMetadata is idempotent', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();

    stripMetadata(doc);
    stripMetadata(doc);

    const { info, hasXmp } = readMetadata(doc);
    expect(info.author).toBe('');
    expect(hasXmp).toBe(false);
  });
});

describe('Document model', () => {
  it('refuses to delete the last page', async () => {
    const src = await makeTestPdf(['ALONE']);
    const model = new DocumentModel(src, 1);

    expect(() => model.deletePage(0)).toThrow();
  });

  it('normalises negative rotations', async () => {
    const src = await makeTestPdf(['A']);
    const model = new DocumentModel(src, 1);

    model.rotatePage(0, -90);
    expect(model.pages[0].rotation).toBe(270);
  });

  it('a snapshot allows a deletion to be undone', async () => {
    const src = await makeTestPdf(['A', 'B']);
    const model = new DocumentModel(src, 2);

    const before = model.snapshot();
    model.deletePage(0);
    expect(model.visibleCount).toBe(1);

    model.restore(before);
    expect(model.visibleCount).toBe(2);
  });
});
