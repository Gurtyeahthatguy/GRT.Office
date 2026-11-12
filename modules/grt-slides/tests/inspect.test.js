// @vitest-environment jsdom

/** The inspector for Slides: what it lists is gone from the clean copy, checked on the bytes of .odp and .pptx. */

import { describe, it, expect } from 'vitest';
import { SlidesModel } from '../src/js/model.js';
import { slideFindings, cleanSlidesCopy } from '../src/js/inspect.js';
import { writeOdp } from '../src/js/core/formats/odp.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { encodeBlock } from '../src/js/core/package.js';

const bytesOf = (entries) => new TextDecoder('utf-8', { fatal: false }).decode(encodeBlock(entries));

describe('the inspector of a presentation', () => {
  it('lists notes, comments, hidden slides, objects off the slide and links, and the clean copy has none', () => {
    const model = new SlidesModel();
    const first = model.slides[0];
    const box = model.addElement(first.id, { kind: 'text', x: 40, y: 40, w: 800, h: 200 });
    model.setContent(first.id, box.id, [{ text: 'Shown ' }, { text: 'here', link: 'https://tracker.example.net/' }]);
    const away = model.addElement(first.id, { kind: 'text', x: -2000, y: 40, w: 300, h: 100 });
    model.setContent(first.id, away.id, [{ text: 'Parked secret' }]);
    model.setNotes(first.id, 'Note secret');
    model.addComment(first.id, { x: 5, y: 5, text: 'Comment secret' });
    const second = model.addSlide();
    const hiddenBox = model.addElement(second.id, { kind: 'text', x: 40, y: 40, w: 800, h: 200 });
    model.setContent(second.id, hiddenBox.id, [{ text: 'Hidden slide secret' }]);
    model.slide(second.id).hidden = true;
    const found = Object.fromEntries(slideFindings(model).map((f) => [f.id, f.count]));
    expect(found).toMatchObject({ notes: 1, comments: 1, hidden: 1, offslide: 1, links: 1 });
    const copy = cleanSlidesCopy(model, ['notes', 'comments', 'hidden', 'offslide', 'links']);
    const all = JSON.stringify(copy) + bytesOf(writeOdp(copy).entries) + bytesOf(writePptx(copy).entries);
    for (const secret of ['Parked secret', 'Note secret', 'Comment secret', 'Hidden slide secret', 'tracker.example.net']) expect(all.includes(secret), secret).toBe(false);
    expect(all.includes('Shown')).toBe(true);
  });
});
