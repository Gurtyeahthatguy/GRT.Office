// @vitest-environment jsdom

/** Cutting a laid-out column into pages, on made-up geometry. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { flowBreaks, flowPage, textLines } from '../src/js/core/print.js';

const LINE = 20;

/** A column of blocks so many lines high, with the geometry a browser would report. */
function column(blocks, gap = 10) {
  const host = document.createElement('div');
  let y = 0;
  const lines = new Map();
  for (const spec of blocks) {
    const block = document.createElement(spec.tag ?? 'p');
    block.textContent = spec.text ?? 'words';
    if (spec.heading) block.dataset.heading = '1';
    if (spec.breakBefore) block.dataset.breakBefore = '1';
    const top = y;
    const height = spec.lines * LINE;
    block.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height });
    lines.set(block, Array.from({ length: spec.whole ? 0 : spec.lines }, (_, k) => ({
      top: top + k * LINE + 4, bottom: top + k * LINE + 16, width: 300, height: 12,
    })));
    host.append(block);
    y += height + gap;
  }
  host.getBoundingClientRect = () => ({ top: 0, bottom: y, left: 0, right: 400, width: 400, height: y });
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let element = null;
    return {
      selectNodeContents: (node) => { element = node; },
      getClientRects: () => lines.get(element) ?? [],
    };
  });
  return host;
}

const rules = {
  keepWithNext: (el) => el.dataset.heading === '1',
  breakBefore: (el) => el.dataset.breakBefore === '1',
  whole: (el) => el.tagName === 'FIGURE',
};

afterEach(() => vi.restoreAllMocks());

describe('cutting a column into pages', () => {
  it('keeps what fits on one page', () => {
    const host = column([{ lines: 3 }, { lines: 2 }]);
    expect(flowBreaks(host, 500, rules)).toEqual([{ start: 0, end: 110 }]);
  });

  it('splits a long paragraph between lines, never through one', () => {
    const host = column([{ lines: 3 }, { lines: 20 }]);
    const pages = flowBreaks(host, 300, rules);
    expect(pages.length).toBe(2);
    // The cut falls between two lines of the second paragraph.
    const end = pages[0].end;
    expect(end).toBeGreaterThan(70);
    expect((end - 70) % LINE).toBe(0);
    expect(pages[1].start).toBe(end);
    expect(pages[1].end).toBe(470);
  });

  it('leaves at least two lines of a split paragraph on each page', () => {
    const host = column([{ lines: 3 }, { lines: 5 }]);
    const pages = flowBreaks(host, 100, rules);
    expect(pages[0]).toEqual({ start: 0, end: 60 });
    expect(pages[1].start).toBe(70);
  });

  it('does not leave a heading alone at the foot of a page', () => {
    const host = column([{ lines: 4 }, { lines: 1, heading: true }, { lines: 3, whole: true, tag: 'figure' }]);
    const pages = flowBreaks(host, 140, rules);
    expect(pages[0]).toEqual({ start: 0, end: 80 });
    expect(pages[1].start).toBe(90);
  });

  it('starts a page where a break is asked for', () => {
    const host = column([{ lines: 1 }, { lines: 1, breakBefore: true }, { lines: 1 }]);
    expect(flowBreaks(host, 1000, rules)).toEqual([{ start: 0, end: 20 }, { start: 30, end: 80 }]);
  });

  it('cuts a picture taller than the page where the page ends', () => {
    const host = column([{ lines: 30, whole: true, tag: 'figure' }]);
    const pages = flowBreaks(host, 250, rules);
    expect(pages).toEqual([{ start: 0, end: 250 }, { start: 250, end: 500 }, { start: 500, end: 600 }]);
  });

  it('gives an empty column one empty page', () => {
    const host = document.createElement('div');
    host.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, width: 0 });
    expect(flowBreaks(host, 300)).toEqual([{ start: 0, end: 0 }]);
  });
});

describe('a page of the column', () => {
  it('holds copies of the blocks it shows, placed where they were', () => {
    const host = column([{ lines: 3, text: 'one' }, { lines: 3, text: 'two' }, { lines: 3, text: 'three' }]);
    const page = flowPage(host, { start: 70, end: 150 });
    expect([...page.children].map((c) => c.textContent)).toEqual(['two', 'three']);
    expect(page.children[0].style.top).toBe('0px');
    expect(page.children[1].style.top).toBe('70px');
    expect(page.style.height).toBe('80px');
    expect(page.style.overflow).toBe('hidden');
    // The column itself is left as it was.
    expect(host.children).toHaveLength(3);
  });

  it('reads the lines of a block as one per row', () => {
    const host = column([{ lines: 4 }]);
    expect(textLines(host.children[0], 0)).toHaveLength(4);
  });
});
