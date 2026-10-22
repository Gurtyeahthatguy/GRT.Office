/** Exporting to PDF never fails on a character its font cannot draw. */

import { describe, it, expect } from 'vitest';
import { renderToPdf, drawableText } from '../src/js/core/pdf.js';

describe('text the PDF font cannot draw', () => {
  it('is replaced by its nearest equivalent, and counted', () => {
    expect(drawableText('a → b ≤ c')).toEqual({ text: 'a -> b <= c', replaced: 2 });
    expect(drawableText('Erdős Gödel')).toEqual({ text: 'Erdos Gödel', replaced: 1 });
    expect(drawableText('Привет 😀')).toEqual({ text: '?????? ?', replaced: 7 });
  });

  it('CANARY: leaves Latin text and the euro alone', () => {
    expect(drawableText('caffè € “quoted” – fine…')).toEqual({ text: 'caffè € “quoted” – fine…', replaced: 0 });
  });

  it('no longer stops the export', async () => {
    const report = { replaced: 0 };
    const page = { width: 200, height: 200, primitives: [{ type: 'text', x: 10, y: 10, text: 'Ελληνικά → 😀', size: 12 }] };
    const bytes = await renderToPdf(page, { audit: false, report });
    expect(bytes.length).toBeGreaterThan(100);
    expect(report.replaced).toBe(10);
  });
});
