// @vitest-environment jsdom

/** Charts, formulas, layouts and masters on slides, through .odp and .pptx and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { SlidesModel, LAYOUTS } from '../src/js/model.js';
import { elementMarkup } from '../src/js/export.js';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const M = 'http://www.w3.org/1998/Math/MathML';
const DATA = { categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Sales', values: [12, 18, 15] }] };

function deck() {
  const model = new SlidesModel();
  model.setCanvas({ w: 1280, h: 720 });
  const first = model.slides[0];
  model.setLayout(first.id, 'titleContent');
  model.setContent(first.id, first.elements.find((e) => e.placeholder === 'title').id, [{ text: 'Results' }]);
  model.setContent(first.id, first.elements.find((e) => e.placeholder === 'body').id, [{ text: 'We grew.' }]);
  model.addElement(first.id, { kind: 'chart', x: 100, y: 300, w: 600, h: 360, type: 'column', title: 'Sales', data: DATA });
  model.addElement(first.id, { kind: 'formula', x: 760, y: 300, w: 400, h: 160, tex: 'a^2 + b^2', mathml: `<math xmlns="${M}"><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup></math>` });
  return model;
}

const summary = (document, formulas = true) => {
  const elements = document.slides[0].elements;
  const chart = elements.find((e) => e.kind === 'chart');
  const formula = elements.find((e) => e.kind === 'formula');
  return {
    placeholders: elements.filter((e) => e.placeholder).map((e) => [e.placeholder, (e.content ?? []).map((r) => r.text).join('')]).sort(),
    chart: chart && { type: chart.type, title: chart.title, data: { categories: chart.data.categories, series: chart.data.series.map((s) => ({ name: s.name, values: s.values })) } },
    formula: formulas ? formula && { tex: formula.tex ?? null, mathml: /<msup>/.test(formula.mathml ?? '') } : undefined,
  };
};

describe('objects on slides', () => {
  it('lay out placeholders where the layout says, keeping what was typed', () => {
    const model = deck();
    const slide = model.slides[0];
    model.setLayout(slide.id, 'twoContent');
    const body = slide.elements.find((e) => e.placeholder === 'body');
    expect(body.w).toBe(Math.round(0.43 * 1280));
    expect(slide.elements.filter((e) => e.placeholder).map((e) => e.placeholder).sort()).toEqual(['body', 'body2', 'title']);
    model.setLayout(slide.id, 'titleOnly');
    expect(slide.elements.some((e) => e.placeholder === 'body')).toBe(true);
    expect(slide.elements.some((e) => e.placeholder === 'body2')).toBe(false);
    expect(Object.keys(LAYOUTS)).toContain('section');
  });

  it('edit a master as if it were a slide', () => {
    const model = deck();
    const master = model.addMaster('Brand');
    model.addElement(master.id, { kind: 'shape', x: 0, y: 680, w: 1280, h: 40 });
    model.assignMaster(model.slides[0].id, master.id);
    expect(model.renderList(model.slides[0].id).some((e) => e.fromMaster)).toBe(true);
  });

  it('draw a chart and a formula placeholder', () => {
    const model = deck();
    const chart = model.slides[0].elements.find((e) => e.kind === 'chart');
    expect(elementMarkup(chart, model)).toContain('<svg');
    const formula = model.slides[0].elements.find((e) => e.kind === 'formula');
    expect(elementMarkup(formula, model)).toContain('a^2 + b^2');
  });

  const want = summary(deck().toJSON());
  it('come back from .odp and .pptx', () => {
    expect(summary(readOdp(decodeBlock(encodeBlock(writeOdp(deck().toJSON()).entries))).document)).toEqual(want);
    const pptx = summary(readPptx(decodeBlock(encodeBlock(writePptx(deck().toJSON()).entries))).document, false);
    expect(pptx).toEqual({ ...want, formula: undefined });
  });

  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odp', 'odp', writeOdp, readOdp], ['pptx', 'pptx:Impress MS PowerPoint 2007 XML', writePptx, readPptx]]) {
        const file = join(dir, `deck.${format}`);
        writeBlock(encodeBlock(write(deck().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        const back = summary(read(decodeBlock(readBlock(saved))).document, format === 'odp');
        expect(back.chart, format).toEqual(want.chart);
        expect(back.placeholders, format).toEqual(want.placeholders);
        if (format === 'odp') expect(back.formula.mathml).toBe(true);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});

describe('hidden slides and four boxes, through LibreOffice', () => {
  it.skipIf(!oracleAvailable())('stay hidden and keep their boxes in both formats', () => {
    const dir = scratch();
    try {
      const model = new SlidesModel();
      const second = model.addSlide(1, 'four');
      model.setHidden(second.id, true);
      second.elements.filter((e) => e.placeholder?.startsWith('body')).forEach((e, i) => model.setContent(second.id, e.id, [{ text: `Box ${i + 1}` }]));
      for (const [format, filter, write, read] of [['odp', 'odp', writeOdp, readOdp], ['pptx', 'pptx:Impress MS PowerPoint 2007 XML', writePptx, readPptx]]) {
        const file = join(dir, `boxes.${format}`);
        writeBlock(encodeBlock(write(model.toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        const { document } = read(decodeBlock(readBlock(saved)));
        expect(document.slides.map((s) => Boolean(s.hidden)), format).toEqual([false, true]);
        const texts = document.slides[1].elements.map((e) => (e.runs ?? e.content ?? []).map((r) => r.text).join('')).filter((t) => t.startsWith('Box')).sort();
        expect(texts, format).toEqual(['Box 1', 'Box 2', 'Box 3', 'Box 4']);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
