// @vitest-environment jsdom

/** Comments on slides: kept in .odp and .pptx with no name or date, read back by LibreOffice, and held to limits from a file. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { SlidesModel } from '../src/js/model.js';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

function deck() {
  const model = new SlidesModel();
  const slide = model.slides[0];
  model.addComment(slide.id, { x: 300, y: 200, text: 'Check this figure\nwith finance' });
  model.addComment(slide.id, { x: 900, y: 500, text: 'Shorter title?' });
  return { model, slide };
}

const shape = (doc) => doc.slides.map((s) => (s.comments ?? []).map((c) => ({ text: c.text, x: Math.round(c.x / 10), y: Math.round(c.y / 10) })));

describe('comments on slides', () => {
  it('are added, changed and taken away', () => {
    const { model, slide } = deck();
    const [first, second] = model.slide(slide.id).comments;
    model.setComment(slide.id, first.id, 'Done');
    model.setComment(slide.id, second.id, '  ');
    expect(model.slide(slide.id).comments.map((c) => c.text)).toEqual(['Done']);
    model.deleteComment(slide.id, first.id);
    expect(model.slide(slide.id).comments).toBeUndefined();
  });

  it('go through .odp and .pptx, places and text kept, and the files name no author', () => {
    const want = shape(deck().model.toJSON());
    const odp = writeOdp(deck().model.toJSON()).entries;
    expect(shape(readOdp(decodeBlock(encodeBlock(odp))).document)).toEqual(want);
    const pptx = writePptx(deck().model.toJSON()).entries;
    expect(shape(readPptx(decodeBlock(encodeBlock(pptx))).document)).toEqual(want);
    expect(pptx.find((e) => e.name === 'ppt/commentAuthors.xml').data).toMatch(/name=""/);
    expect(pptx.find((e) => e.name === 'ppt/comments/comment1.xml').data).not.toMatch(/dt=/);
  });

  it('from a file are held to what is sound', () => {
    const model = new SlidesModel({ slides: [{ id: 's1', elements: [], comments: [{ text: 5 }, { text: 'ok', x: 'far' }, ...Array.from({ length: 700 }, () => ({ text: 'n' }))] }] });
    expect(model.slides[0].comments.length).toBe(500);
    expect(model.slides[0].comments[0]).toMatchObject({ text: 'ok', x: 0 });
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and comments on slides', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('reads them from .odp and .pptx and writes them back in the same places', () => {
    for (const [format, write, filter, read] of [
      ['odp', writeOdp, 'pptx:Impress MS PowerPoint 2007 XML', readPptx],
      ['pptx', writePptx, 'odp', readOdp],
    ]) {
      const file = join(dir, `comments.${format}`);
      writeBlock(encodeBlock(write(deck().model.toJSON()).entries), file);
      const saved = convert(file, filter, join(dir, `from-${format}`));
      const got = read(decodeBlock(readBlock(saved))).document.slides[0].comments;
      const mine = deck().model.toJSON().slides[0].comments;
      expect(got.map((c) => c.text), format).toEqual(mine.map((c) => c.text));
      // LibreOffice moves a comment read from .pptx about 20 pixels up; the places are kept within that.
      got.forEach((c, i) => {
        expect(Math.abs(c.x - mine[i].x), format).toBeLessThanOrEqual(25);
        expect(Math.abs(c.y - mine[i].y), format).toBeLessThanOrEqual(25);
      });
    }
  }, 120000);
});
