// @vitest-environment jsdom

/** Find and replace across a presentation, links on text, and the guard against expressions that never end. */

import { describe, it, expect } from 'vitest';
import { riskyPattern, searchPattern, findAll, replaceInRuns, replaceInText } from '../src/js/core/find.js';
import { SlidesModel } from '../src/js/model.js';
import { findTools } from '../src/js/find-tools.js';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';

describe('a search', () => {
  it('refuses expressions that can backtrack for ever, and lets the others through', () => {
    for (const p of ['(a+)+', '(a*)*b', '(a|aa)+', '(x+x+)+y', '((ab)*)+', '(\\w+\\s?)*$', '(a)\\1', '(?<n>a)\\k<n>', '(.*){2,}']) expect(riskyPattern(p), p).toBe(true);
    for (const p of ['a+b+', '(ab)+', '[(a+)+]', 'colou?r', '\\(a+\\)+', '(cat|dog)s?', '^\\d{3}-\\d{4}$', '(ab){3}']) expect(riskyPattern(p), p).toBe(false);
    expect(() => searchPattern('(a+)+', { regex: true })).toThrow(/for ever/);
    expect(() => searchPattern('(', { regex: true })).toThrow(/not a valid expression/);
  });

  it('takes the text as it is unless asked for an expression, and can look for whole words', () => {
    expect(findAll('a+b and a+b', searchPattern('a+b')).length).toBe(2);
    expect(findAll('cat category Cat', searchPattern('cat', { wholeWords: true })).map((m) => m.from)).toEqual([0, 13]);
    expect(findAll('cat Cat', searchPattern('cat', { matchCase: true })).length).toBe(1);
    expect(findAll('città Città', searchPattern('città', { wholeWords: true })).length).toBe(2);
  });

  it('replaces across runs, each replacement taking the look where its match starts', () => {
    const runs = [{ text: 'Old ' }, { text: 'wo', bold: true }, { text: 'rld and old world' }];
    const { runs: out, count } = replaceInRuns(runs, searchPattern('world'), 'place');
    expect(count).toBe(2);
    expect(out).toEqual([{ text: 'Old ' }, { text: 'place', bold: true }, { text: ' and old place' }]);
    expect(replaceInText('2024-01-02', searchPattern('(\\d+)-(\\d+)-(\\d+)', { regex: true }), '$3/$2/$1', { regex: true }).text).toBe('02/01/2024');
    expect(replaceInText('a$1b', searchPattern('$1'), '$&').text).toBe('a$&b');
  });
});

function deck() {
  const model = new SlidesModel();
  const first = model.slides[0];
  const box = model.addElement(first.id, { kind: 'text', x: 40, y: 40, w: 800, h: 300 });
  model.setContent(first.id, box.id, [{ text: 'Sales ' }, { text: 'grew', bold: true }, { text: '\nSales fell' }]);
  const table = model.addElement(first.id, { kind: 'table', x: 40, y: 400, w: 800, h: 200, rows: 2, cols: 2 });
  model.setCell(first.id, table.id, 1, 1, 'Sales total');
  model.setNotes(first.id, 'Say: sales are up.');
  return { model, first, box, table };
}

describe('find in a presentation', () => {
  it('finds in boxes, cells and notes, slide by slide', () => {
    const { model } = deck();
    const tools = findTools({ model: () => model, slideId: () => model.slides[0].id, change: (m) => m(), toast: () => {} });
    const found = tools.matches(searchPattern('sales'));
    expect(found.map((m) => m.kind)).toEqual(['text', 'text', 'cell', 'notes']);
    expect(found[1]).toMatchObject({ from: 11, to: 16 });
  });

  it('replaces everywhere at once', () => {
    const { model, first, box, table } = deck();
    const tools = findTools({ model: () => model, slideId: () => first.id, change: (m) => m(), toast: () => {} });
    expect(tools.replaceAll('sales', 'Revenue', {})).toBe(4);
    expect(model.element(first.id, box.id).content.map((r) => r.text).join('')).toBe('Revenue grew\nRevenue fell');
    expect(model.element(first.id, box.id).content.find((r) => r.bold).text).toBe('grew');
    expect(model.element(first.id, table.id).cells[1][1]).toBe('Revenue total');
    expect(model.slide(first.id).notes).toBe('Say: Revenue are up.');
  });
});

describe('links on slide text', () => {
  it('go through .odp and .pptx', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const box = model.addElement(slide.id, { kind: 'text', x: 40, y: 40, w: 800, h: 300 });
    model.setContent(slide.id, box.id, [{ text: 'See ' }, { text: 'our site', link: 'https://example.org/?a=1&b=2' }, { text: ' now' }]);
    for (const [write, read] of [[writeOdp, readOdp], [writePptx, readPptx]]) {
      const back = read(decodeBlock(encodeBlock(write(model.toJSON()).entries))).document;
      const runs = back.slides[0].elements.find((e) => e.kind === 'text').content;
      expect(runs.find((r) => r.link)).toMatchObject({ text: 'our site', link: 'https://example.org/?a=1&b=2' });
    }
  });
});
