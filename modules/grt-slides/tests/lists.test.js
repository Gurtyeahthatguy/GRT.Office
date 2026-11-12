// @vitest-environment jsdom

/** Lists, levels, spacing and font effects in a text box: in the model, through .odp and .pptx and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { SlidesModel } from '../src/js/model.js';
import { setList, shiftLevel, moveParagraphs, numbersFor, labelFor, parasFor, readEdit, editMarkup } from '../src/js/paragraphs.js';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const LINES = ['Plan', 'First point', 'A detail', 'Second point', 'Step one', 'Step two', 'Closing'];
const PARAS = [{ level: 0 }, { level: 0, list: 'bullet' }, { level: 1, list: 'bullet' }, { level: 0, list: 'bullet' }, { level: 1, list: 'number' }, { level: 1, list: 'number' }, { level: 0 }];

function deck() {
  const model = new SlidesModel();
  const slide = model.slides[0];
  const box = model.addElement(slide.id, { kind: 'text', x: 40, y: 40, w: 800, h: 500 });
  const content = LINES.flatMap((line, i) => [...(i ? [{ text: '\n' }] : []), { text: line }]);
  content[2] = { text: 'First point', bold: true, double: true };
  content[6] = { text: 'Second point', smallcaps: true, size: 40 };
  model.setContent(slide.id, box.id, content, PARAS);
  model.setSpacing(slide.id, box.id, { lineHeight: 1.5, spaceAfter: 12 });
  return { model, slide, box };
}

const shape = (document) => {
  const box = document.slides.flatMap((s) => s.elements).find((e) => e.kind === 'text' && e.content.some((r) => r.text.includes('Plan')));
  return {
    lines: box.content.map((r) => r.text).join('').split('\n'),
    paras: parasFor(box),
    first: box.content.find((r) => r.text === 'First point'),
    second: box.content.find((r) => r.text === 'Second point'),
  };
};

describe('paragraphs of a text box', () => {
  it('number their items per level and start again when the list breaks', () => {
    const paras = PARAS.map((p) => ({ ...p }));
    expect(numbersFor(paras)).toEqual([0, 0, 0, 0, 1, 2, 0]);
    expect(labelFor(paras[4], 1)).toBe('a.');
    expect(labelFor(paras[1], 0)).toBe('•');
  });

  it('change list, level and order without losing the text', () => {
    const { box } = deck();
    expect(setList(box, 'number', 1, 3).slice(1, 4).map((p) => p.list)).toEqual(['number', 'number', 'number']);
    expect(shiftLevel(box, 1, 0, 0)[0].level).toBe(1);
    const moved = moveParagraphs(box, 1, 1, 2);
    expect(moved.content.map((r) => r.text).join('').split('\n')).toEqual(['Plan', 'Second point', 'First point', 'A detail', 'Step one', 'Step two', 'Closing']);
    expect(moved.paras[2]).toEqual({ level: 0, list: 'bullet' });
  });

  it('come back whole from the markup they are edited in', () => {
    const { box } = deck();
    const node = document.createElement('div');
    node.innerHTML = editMarkup(box);
    const back = readEdit(node);
    expect(back.paras).toEqual(parasFor(box));
    expect(back.content).toEqual(box.content);
  });
});

describe('lists through the formats', () => {
  const want = { lines: LINES, paras: PARAS, first: { text: 'First point', bold: true, double: true }, second: { text: 'Second point', smallcaps: true, size: 40 } };

  it('come back from .odp', () => {
    const back = readOdp(decodeBlock(encodeBlock(writeOdp(deck().model.toJSON()).entries))).document;
    expect(shape(back)).toEqual(want);
    const box = back.slides[0].elements.find((e) => e.kind === 'text');
    expect([box.lineHeight, box.spaceAfter]).toEqual([1.5, 12]);
  });

  it('come back from .pptx', () => {
    const back = readPptx(decodeBlock(encodeBlock(writePptx(deck().model.toJSON()).entries))).document;
    expect(shape(back)).toEqual(want);
    const box = back.slides[0].elements.find((e) => e.kind === 'text' && e.paras);
    expect([box.lineHeight, box.spaceAfter]).toEqual([1.5, 12]);
  });

  it.skipIf(!oracleAvailable())('come back from LibreOffice in .pptx', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'lists.pptx');
      writeBlock(encodeBlock(writePptx(deck().model.toJSON()).entries), file);
      const saved = convert(file, 'pptx:Impress MS PowerPoint 2007 XML', join(dir, 'again'));
      expect(shape(readPptx(decodeBlock(readBlock(saved))).document)).toEqual(want);
    } finally {
      cleanup(dir);
    }
  }, 180000);

  it.skipIf(!oracleAvailable())('come back from LibreOffice in .odp', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'lists.odp');
      writeBlock(encodeBlock(writeOdp(deck().model.toJSON()).entries), file);
      const saved = convert(file, 'odp', join(dir, 'again'));
      expect(shape(readOdp(decodeBlock(readBlock(saved))).document)).toEqual(want);
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
