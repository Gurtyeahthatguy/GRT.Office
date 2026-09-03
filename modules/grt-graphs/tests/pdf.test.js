/** Exporting through the suite's shared print engine. */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from '../src/vendor/pdf-lib.esm.js';
import { GraphModel } from '../src/js/model.js';
import { toPrintPage } from '../src/js/export.js';
import { renderToPdf } from '../src/js/core/pdf.js';
import { auditBytes, readableForms } from '../src/js/core/metadata.js';

function sample() {
  const model = new GraphModel();
  const a = model.addNode({ x: 40, y: 40, text: 'START', shape: 'ellipse' });
  const b = model.addNode({ x: 340, y: 40, text: 'CHOICE', shape: 'diamond' });
  const c = model.addNode({ x: 340, y: 200, text: 'FINISH' });
  model.addEdge({ from: a.id, to: b.id, label: 'GO' });
  model.addEdge({ from: b.id, to: c.id });
  return model;
}

describe('The exported PDF', () => {
  it('is a readable PDF with one page', async () => {
    const bytes = await renderToPdf(toPrintPage(sample()), { audit: false });
    const doc = await PDFDocument.load(bytes);

    expect(doc.getPageCount()).toBe(1);
  });

  it('carries no metadata at all', async () => {
    const bytes = await renderToPdf(toPrintPage(sample()), { audit: false });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });

    expect(doc.getAuthor()).toBe('');
    expect(doc.getProducer()).toBe('');
    expect(doc.getCreator()).toBe('');
    expect(doc.getCreationDate()?.getUTCFullYear()).toBe(1970);
  });

  it('leaves no generator fingerprint in the bytes', async () => {
    const bytes = await renderToPdf(toPrintPage(sample()), { audit: false });

    // The same check GRT Read runs on everything it writes.
    expect(auditBytes(bytes)).toEqual([]);
    expect(readableForms(bytes)).not.toContain('xmpmeta');
  });

  it('is a single-trailer file, never an incremental append', async () => {
    const bytes = await renderToPdf(toPrintPage(sample()), { audit: false });
    const raw = new TextDecoder('latin1').decode(bytes);

    expect(raw.split('%%EOF').length - 1).toBe(1);
  });

  it('embeds no font program', async () => {
    // Standard fonts only: a font program would carry a foundry's own
    // strings.
    const bytes = await renderToPdf(toPrintPage(sample()), { audit: false });

    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('/FontFile');
  });
});

describe('The page handed to the engine', () => {
  it('covers the whole drawing', () => {
    const page = toPrintPage(sample());

    expect(page.width).toBeGreaterThan(400);
    expect(page.height).toBeGreaterThan(200);
  });

  it('shifts a diagram drawn at negative coordinates onto the paper', () => {
    const model = new GraphModel();
    model.addNode({ x: -400, y: -300, w: 100, h: 40 });

    const page = toPrintPage(model);
    const rect = page.primitives.find((p) => p.type === 'rect');

    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
  });

  it('describes every node and every connector', () => {
    const page = toPrintPage(sample());

    expect(page.primitives.filter((p) => p.type === 'polyline')).toHaveLength(2);
    expect(page.primitives.filter((p) => p.type === 'ellipse')).toHaveLength(1);
    expect(page.primitives.filter((p) => p.type === 'rect')).toHaveLength(1);
    expect(page.primitives.filter((p) => p.type === 'polygon')).toHaveLength(1);
  });

  it('skips a connector whose endpoint is gone', () => {
    const model = new GraphModel({
      nodes: [{ id: 'n1', x: 0, y: 0, w: 100, h: 40 }],
      edges: [{ id: 'e1', from: 'n1', to: 'missing' }],
    });

    expect(toPrintPage(model).primitives.some((p) => p.type === 'polyline')).toBe(false);
  });
});

describe('Filled shapes', () => {
  it('a diamond is filled, not just outlined', async () => {
    // The engine had no filled-polygon primitive at first, so diamonds and
    // parallelograms came out as bare outlines.
    const model = new GraphModel();
    model.addNode({ x: 0, y: 0, shape: 'diamond', text: 'D', style: 'accent' });

    const bytes = await renderToPdf(toPrintPage(model), { audit: false });
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);

    expect(page).toBeDefined();
    // The polygon primitive must carry a fill for the engine to have anything
    // to fill with.
    const polygon = toPrintPage(model).primitives.find((p) => p.type === 'polygon');
    expect(polygon.fill).toBeTruthy();
  });

  it('still writes a clean PDF once shapes are filled', async () => {
    const model = new GraphModel();
    model.addNode({ x: 0, y: 0, shape: 'diamond' });
    model.addNode({ x: 300, y: 0, shape: 'parallelogram' });

    const bytes = await renderToPdf(toPrintPage(model), { audit: false });

    expect(auditBytes(bytes)).toEqual([]);
    expect(new TextDecoder('latin1').decode(bytes).split('%%EOF').length - 1).toBe(1);
  });
});
