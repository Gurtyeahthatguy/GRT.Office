/** Multi-source documents, extraction and undo. */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DocumentModel } from '../src/js/document-model.js';
import { buildOutputBytes, buildBytesFromPlan } from '../src/js/save.js';
import { UndoStack } from '../src/js/core/undo.js';
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

describe('Appending another document', () => {
  it('adds the pages of the second file after the first', async () => {
    const first = await makeTestPdf(['FIRSTALPHA', 'FIRSTBETA']);
    const second = await makeTestPdf(['SECONDGAMMA']);

    const model = new DocumentModel(first, 2);
    model.appendSource(second, 1);

    expect(model.visibleCount).toBe(3);

    const out = await buildOutputBytes(model, { audit: false });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  it('keeps content from both sources in the right order', async () => {
    const first = await makeTestPdf(['ONEONE']);
    const second = await makeTestPdf(['TWOTWO']);

    const model = new DocumentModel(first, 1);
    model.appendSource(second, 1);

    const plan = model.buildPlan();
    expect(plan.map((s) => s.sourceId)).toEqual([0, 1]);

    const out = await buildOutputBytes(model, { audit: false });
    expect(contains(out, 'ONEONE')).toBe(true);
    expect(contains(out, 'TWOTWO')).toBe(true);
  });

  it('reordering across sources is honoured when saving', async () => {
    const first = await makeTestPdf(['AAA', 'BBB']);
    const second = await makeTestPdf(['CCC']);

    const model = new DocumentModel(first, 2);
    model.appendSource(second, 1);
    // Move the appended page to the front.
    model.movePage(2, 0);

    const plan = model.buildPlan();
    expect(plan[0].sourceId).toBe(1);
    expect(plan.map((s) => s.sourceId)).toEqual([1, 0, 0]);
  });

  it('a page deleted from the appended file does not reach the output', async () => {
    const first = await makeTestPdf(['KEEPTHIS']);
    const second = await makeTestPdf(['DROPTHIS', 'KEEPTHATTOO']);

    const model = new DocumentModel(first, 1);
    model.appendSource(second, 2);
    model.deletePage(1);

    const out = await buildOutputBytes(model, { audit: false });

    expect(contains(out, 'DROPTHIS')).toBe(false);
    expect(contains(out, 'KEEPTHIS')).toBe(true);
  });
});

describe('Extracting a subset of pages', () => {
  it('writes only the requested pages', async () => {
    const src = await makeTestPdf(['WANTEDONE', 'UNWANTED', 'WANTEDTWO']);
    const model = new DocumentModel(src, 3);

    const plan = model.buildPlanFor([0, 2]);
    const out = await buildBytesFromPlan(model, plan, { audit: false });

    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(contains(out, 'UNWANTED')).toBe(false);
  });

  it('refuses an empty plan rather than writing a broken file', async () => {
    const src = await makeTestPdf(['ONLY']);
    const model = new DocumentModel(src, 1);

    await expect(buildBytesFromPlan(model, [], { audit: false }))
      .rejects.toThrow(/No pages/);
  });
});

describe('Undo stack', () => {
  it('undoes and redoes a deletion', async () => {
    const src = await makeTestPdf(['A', 'B', 'C']);
    const model = new DocumentModel(src, 3);
    const undo = new UndoStack(model);

    undo.do(() => model.deletePage(1));
    expect(model.visibleCount).toBe(2);

    undo.undo();
    expect(model.visibleCount).toBe(3);

    undo.redo();
    expect(model.visibleCount).toBe(2);
  });

  it('undoing an append drops the source as well as its pages', async () => {
    const first = await makeTestPdf(['A']);
    const second = await makeTestPdf(['B', 'C']);

    const model = new DocumentModel(first, 1);
    const undo = new UndoStack(model);

    undo.do(() => model.appendSource(second, 2));
    expect(model.visibleCount).toBe(3);
    expect(model.sources.length).toBe(2);

    undo.undo();
    expect(model.visibleCount).toBe(1);
    // Leaving the orphaned source behind would keep a whole PDF in memory for
    // a document that no longer references it.
    expect(model.sources.length).toBe(1);
  });

  it('a new change makes the redo history unreachable', async () => {
    const src = await makeTestPdf(['A', 'B', 'C']);
    const model = new DocumentModel(src, 3);
    const undo = new UndoStack(model);

    undo.do(() => model.deletePage(0));
    undo.undo();
    expect(undo.canRedo).toBe(true);

    undo.do(() => model.rotatePage(0, 90));
    expect(undo.canRedo).toBe(false);
  });
});

describe('Page ordering', () => {
  it('a moved page ends up exactly at the requested index', async () => {
    const src = await makeTestPdf(['A', 'B', 'C', 'D']);
    const model = new DocumentModel(src, 4);

    model.movePage(0, 2);
    expect(model.buildPlan().map((s) => s.originalIndex)).toEqual([1, 2, 0, 3]);

    const back = new DocumentModel(src, 4);
    back.movePage(3, 1);
    expect(back.buildPlan().map((s) => s.originalIndex)).toEqual([0, 3, 1, 2]);
  });

  it('deleting several pages at once resolves indices before hiding any', async () => {
    const src = await makeTestPdf(['A', 'B', 'C', 'D']);
    const model = new DocumentModel(src, 4);

    model.deletePages([0, 2]);
    expect(model.buildPlan().map((s) => s.originalIndex)).toEqual([1, 3]);
  });

  it('refuses to delete every page', async () => {
    const src = await makeTestPdf(['A', 'B']);
    const model = new DocumentModel(src, 2);

    expect(() => model.deletePages([0, 1])).toThrow();
  });
});
