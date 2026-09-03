/** The requirement the whole project rests on. */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DocumentModel } from '../src/js/document-model.js';
import { buildOutputBytes, buildBytesFromPlan } from '../src/js/save.js';
import { deepText, contains } from './helpers.js';

async function makeTestPdf(pageTexts) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 700, size: 24, font });
  }
  return doc.save();
}

describe('The check itself is sound', () => {
  it('finds text that IS in the document, once streams are expanded', async () => {
    // Guards the guard.
    const src = await makeTestPdf(['CANARYSTRING']);
    const model = new DocumentModel(src, 1);
    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'CANARYSTRING')).toBe(true);
  });

  it('confirms plain-byte searching would NOT have worked', async () => {
    // Documents the trap: this is why deepText exists.
    const src = await makeTestPdf(['CANARYSTRING']);
    const plain = new TextDecoder('latin1').decode(src);

    expect(plain.includes('CANARYSTRING')).toBe(false);
  });

  it('finds metadata that IS present, despite UTF-16 encoding', async () => {
    // The second canary, and the one that caught a real hole.
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setAuthor('CANARYAUTHOR');
    const src = await doc.save();

    expect(new TextDecoder('latin1').decode(src)).not.toContain('CANARYAUTHOR');
    expect(contains(src, 'CANARYAUTHOR')).toBe(true);
  });
});

describe('Full document regeneration', () => {
  it('a deleted page is unrecoverable from the output', async () => {
    const src = await makeTestPdf([
      'PUBLICPAGEONE',
      'CONFIDENTIALCONTENT',
      'PUBLICPAGETHREE',
    ]);

    const model = new DocumentModel(src, 3);
    model.deletePage(1);

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'CONFIDENTIALCONTENT')).toBe(false);
    expect(contains(out, 'PUBLICPAGEONE')).toBe(true);
    expect(contains(out, 'PUBLICPAGETHREE')).toBe(true);
  });

  it('an extracted subset carries none of the pages left behind', async () => {
    const src = await makeTestPdf(['WANTEDONE', 'UNWANTEDSECRET', 'WANTEDTWO']);
    const model = new DocumentModel(src, 3);

    const out = await buildBytesFromPlan(model, model.buildPlanFor([0, 2]), {
      audit: false,
    });

    expect(contains(out, 'UNWANTEDSECRET')).toBe(false);
    expect(contains(out, 'WANTEDONE')).toBe(true);
  });

  it('a page deleted from an appended file is gone too', async () => {
    const first = await makeTestPdf(['KEEPTHISONE']);
    const second = await makeTestPdf(['DROPTHISONE', 'KEEPTHATONE']);

    const model = new DocumentModel(first, 1);
    model.appendSource(second, 2);
    model.deletePage(1);

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'DROPTHISONE')).toBe(false);
    expect(contains(out, 'KEEPTHISONE')).toBe(true);
    expect(contains(out, 'KEEPTHATONE')).toBe(true);
  });

  it('content from both sources survives a merge', async () => {
    const first = await makeTestPdf(['SOURCEONETEXT']);
    const second = await makeTestPdf(['SOURCETWOTEXT']);

    const model = new DocumentModel(first, 1);
    model.appendSource(second, 1);

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'SOURCEONETEXT')).toBe(true);
    expect(contains(out, 'SOURCETWOTEXT')).toBe(true);
  });

  it('writes a single trailer, never an incremental append', async () => {
    const src = await makeTestPdf(['ONE', 'TWO']);
    const model = new DocumentModel(src, 2);
    model.rotatePage(0, 90);

    const out = await buildOutputBytes(model, { audit: false });
    const occurrences = new TextDecoder('latin1').decode(out).split('%%EOF').length - 1;

    expect(occurrences).toBe(1);
  });

  it('leaves no identifying metadata anywhere in the file', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('BODY', { x: 50, y: 700, size: 24, font });
    doc.setAuthor('Mario Rossi');
    doc.setTitle('Confidential Report');
    doc.setCreator('Microsoft Word');
    const src = await doc.save();

    // Present to begin with.
    expect(contains(src, 'Mario Rossi')).toBe(true);
    expect(contains(src, 'Microsoft Word')).toBe(true);

    const model = new DocumentModel(src, 1);
    const out = await buildOutputBytes(model, { audit: false });
    const text = deepText(out);

    expect(text).not.toContain('Mario Rossi');
    expect(text).not.toContain('Confidential Report');
    expect(text).not.toContain('Microsoft Word');
    expect(text).not.toContain('pdf-lib');
    expect(text).not.toContain('xmpmeta');
  });
});

describe('The production audit function, not just the tests', () => {
  it('auditBytes sees generator names stored as UTF-16 metadata', async () => {
    // auditBytes feeds the fingerprint panel.
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setProducer('Acrobat Distiller');
    const bytes = await doc.save({ useObjectStreams: false });

    const { auditBytes } = await import('../src/js/core/metadata.js');
    expect(auditBytes(bytes)).toContain('Acrobat');
  });

  it('auditBytes reports nothing for a file this program produced', async () => {
    const src = await makeTestPdf(['BODY']);
    const model = new DocumentModel(src, 1);
    const out = await buildOutputBytes(model, { audit: false });

    const { auditBytes } = await import('../src/js/core/metadata.js');
    expect(auditBytes(out)).toEqual([]);
  });
});
