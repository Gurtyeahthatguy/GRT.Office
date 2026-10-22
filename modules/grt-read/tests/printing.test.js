// @vitest-environment jsdom

/** Printing a PDF: which pages, and on what paper. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/vendor/pdf.mjs', () => ({ getDocument: () => ({ promise: Promise.resolve(null) }) }));
const { parseRange, printablePages } = await import('../src/js/printing.js');

/** A document of so many pages, each a size in millimetres. */
function fake(sizes) {
  return {
    count: sizes.length,
    size: async (index) => sizes[index],
    image: async (index) => `blob:page-${index}`,
  };
}

describe('the pages to print', () => {
  it('reads ranges as people write them', () => {
    expect(parseRange('', 5)).toEqual([0, 1, 2, 3, 4]);
    expect(parseRange('1-2, 5', 5)).toEqual([0, 1, 4]);
    expect(parseRange('3', 5)).toEqual([2]);
    expect(parseRange('0', 5)).toBeNull();
    expect(parseRange('2-9', 5)).toBeNull();
    expect(parseRange('two', 5)).toBeNull();
  });
});

describe('the paper', () => {
  it('is the document’s own unless another is chosen, every page fitted whole and centred', async () => {
    const pdf = fake([{ width: 210, height: 297 }, { width: 297, height: 210 }]);
    const own = await printablePages(pdf, { size: 'document', pages: '' });
    expect([own.width, own.height]).toEqual([210, 297]);
    expect(own.pages).toHaveLength(2);
    const turned = own.pages[1].querySelector('img');
    expect(turned.style.width).toBe('210mm');
    expect(parseFloat(turned.style.top)).toBeCloseTo((297 - 210 * (210 / 297)) / 2, 3);
    expect(turned.getAttribute('src')).toBe('blob:page-1');

    const letter = await printablePages(pdf, { size: 'Letter', orientation: 'landscape', pages: '2' });
    expect([letter.width, letter.height]).toEqual([279, 216]);
    expect(letter.pages).toHaveLength(1);
  });

  it('prints the page in view when the range cannot be read', async () => {
    const pdf = fake([{ width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }]);
    const result = await printablePages(pdf, { size: 'document', pages: '7', current: 2 });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].querySelector('img').getAttribute('src')).toBe('blob:page-2');
  });
});
