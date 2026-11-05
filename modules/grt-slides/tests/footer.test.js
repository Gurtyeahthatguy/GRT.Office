// @vitest-environment jsdom

/** Slide footers, numbers and dates, and master objects hidden on a slide: drawn, and kept through .odp, .pptx and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { SlidesModel, normaliseFooter } from '../src/js/model.js';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

function deck() {
  const model = new SlidesModel();
  model.setCanvas({ w: 1280, h: 720 });
  const master = model.addMaster('Brand');
  model.addElement(master.id, { kind: 'shape', shape: 'rect', x: 0, y: 0, w: 1280, h: 20, fill: '#2a6099' });
  const first = model.slides[0];
  model.assignMaster(first.id, master.id);
  const second = model.addSlide();
  const third = model.addSlide();
  model.setFooter([second.id, third.id], { text: 'Quarterly review', number: true, date: 'fixed', dateText: '5 November 2026' });
  model.setFooter([first.id], { number: true, date: 'auto' });
  model.setMasterObjects(third.id, false);
  return model;
}

const summary = (document) => new SlidesModel(document).slides.map((s) => ({
  footer: s.footer ? { ...s.footer, dateText: s.footer.date === 'auto' ? '' : s.footer.dateText } : null,
  hideMaster: Boolean(s.hideMaster),
}));

const want = [
  { footer: { text: '', number: true, date: 'auto', dateText: '' }, hideMaster: false },
  { footer: { text: 'Quarterly review', number: true, date: 'fixed', dateText: '5 November 2026' }, hideMaster: false },
  { footer: { text: 'Quarterly review', number: true, date: 'fixed', dateText: '5 November 2026' }, hideMaster: true },
];

describe('slide footers', () => {
  it('keep only what is shown', () => {
    expect(normaliseFooter({ text: '', number: false })).toBe(null);
    expect(normaliseFooter({ number: true, date: 'sometimes' })).toEqual({ text: '', number: true, date: null, dateText: '' });
  });

  it('are drawn along the foot of the slide, numbered by place', () => {
    const model = deck();
    const parts = model.renderList(model.slides[2].id).filter((e) => e.footerPart);
    expect(parts.map((e) => [e.footerPart, e.content[0].text])).toEqual([['date', '5 November 2026'], ['footer', 'Quarterly review'], ['number', '3']]);
    expect(parts.every((e) => e.fromMaster)).toBe(true);
  });

  it('a new slide takes the footer of the one before', () => {
    const model = deck();
    expect(model.addSlide().footer.text).toBe('Quarterly review');
  });

  it('hiding master objects leaves the master assigned', () => {
    const model = deck();
    model.assignMaster(model.slides[2].id, model.masters[0].id);
    expect(model.renderList(model.slides[2].id).some((e) => e.kind === 'shape')).toBe(false);
    model.setMasterObjects(model.slides[2].id, true);
    expect(model.renderList(model.slides[2].id).some((e) => e.kind === 'shape')).toBe(true);
  });

  it('come back from .odp and .pptx', () => {
    expect(summary(readOdp(decodeBlock(encodeBlock(writeOdp(deck().toJSON()).entries))).document)).toEqual(want);
    expect(summary(readPptx(decodeBlock(encodeBlock(writePptx(deck().toJSON()).entries))).document)).toEqual(want);
  });

  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odp', 'odp', writeOdp, readOdp], ['pptx', 'pptx:Impress MS PowerPoint 2007 XML', writePptx, readPptx]]) {
        const file = join(dir, `deck.${format}`);
        writeBlock(encodeBlock(write(deck().toJSON()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(summary(read(decodeBlock(readBlock(saved))).document), format).toEqual(want);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
