// @vitest-environment jsdom

/** Redaction in Slides: covered text and cells are gone from the copy, with the notes and comments, checked on the bytes. */

import { describe, it, expect } from 'vitest';
import { SlidesModel } from '../src/js/model.js';
import { autoRedactSlides, redactedPresentation, toggleCells, redactedCount } from '../src/js/redact.js';
import { formatPart } from '../src/js/paragraphs.js';
import { writeOdp } from '../src/js/core/formats/odp.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { encodeBlock } from '../src/js/core/package.js';

const bytesOf = (entries) => new TextDecoder('utf-8', { fatal: false }).decode(encodeBlock(entries));

describe('a redacted copy of a presentation', () => {
  it('has no covered text, cell, note or comment, in .odp or .pptx', () => {
    const model = new SlidesModel();
    const slide = model.slides[0];
    const box = model.addElement(slide.id, { kind: 'text', x: 40, y: 40, w: 800, h: 300 });
    model.setContent(slide.id, box.id, [{ text: 'Client Mario, IBAN IT60X0542811101000000123456' }]);
    model.setContent(slide.id, box.id, formatPart(model.element(slide.id, box.id).content, 7, 12, 'redact', true));
    const table = model.addElement(slide.id, { kind: 'table', x: 40, y: 400, w: 800, h: 200, rows: 2, cols: 2 });
    model.setCell(slide.id, table.id, 0, 0, 'Secret plan');
    model.setCell(slide.id, table.id, 1, 1, 'mail mario@example.it');
    model.changeTable(slide.id, table.id, (t) => toggleCells(t, { top: 0, left: 0, bottom: 0, right: 0 }));
    model.setNotes(slide.id, 'Do not mention Mario');
    model.addComment(slide.id, { x: 10, y: 10, text: 'Mario again' });
    expect(autoRedactSlides(model, ['iban', 'email'])).toBe(2);
    expect(redactedCount(model)).toBe(4);
    const copy = redactedPresentation(model.toJSON());
    const all = JSON.stringify(copy) + bytesOf(writeOdp(copy).entries) + bytesOf(writePptx(copy).entries);
    for (const secret of ['Mario', 'IT60X054', 'Secret plan', 'example.it']) expect(all.includes(secret), secret).toBe(false);
    expect(all.includes('Client')).toBe(true);
    expect(writePptx(model.toJSON()).losses.lines().join()).toMatch(/Redacted Export/);
  });
});
