// @vitest-environment jsdom

/** A note opened as a presentation: a title slide, a slide for each heading with what follows it as points, long ones carried over. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { noteToSlides } from '../src/js/core/formats/note-slides.js';
import { writeOdp, readOdp } from '../src/js/core/formats/odp.js';
import { encodeBlock, decodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, convert, pdfPages } from '../../../scripts/oracle.mjs';

const note = {
  title: 'Il viaggio',
  blocks: [
    { kind: 'paragraph', runs: [{ text: 'Prima dei titoli.' }] },
    { kind: 'heading', level: 1, runs: [{ text: 'Partenza' }] },
    { kind: 'paragraph', runs: [{ text: 'Si parte ' }, { text: 'presto', bold: true }, { text: '.' }] },
    { kind: 'list', listType: 'bullet', items: [{ level: 0, runs: [{ text: 'valigia' }] }, { level: 1, runs: [{ text: 'passaporto' }] }] },
    { kind: 'heading', level: 2, runs: [{ text: 'Tappe' }] },
    { kind: 'list', listType: 'number', items: Array.from({ length: 12 }, (_, i) => ({ level: 0, runs: [{ text: `Tappa ${i + 1}` }] })) },
    { kind: 'table', rows: [] },
  ],
};

describe('A note as a presentation', () => {
  it('has a title slide, a slide for each heading, points with their levels, long lists carried over', () => {
    const { document, losses } = noteToSlides(note);
    const titles = document.slides.map((s) => s.elements.find((e) => e.placeholder === 'title').content.map((r) => r.text).join(''));
    expect(titles).toEqual(['Il viaggio', 'Partenza', 'Tappe', 'Tappe (continued)']);
    expect(document.slides[0].elements.find((e) => e.placeholder === 'subtitle').content.map((r) => r.text).join('')).toBe('Prima dei titoli.');
    const start = document.slides[1].elements.find((e) => e.placeholder === 'body');
    expect(start.content.map((r) => r.text).join('')).toBe('Si parte presto.\nvaligia\npassaporto');
    expect(start.content.find((r) => r.text === 'presto').bold).toBe(true);
    expect(start.paras).toEqual([{ level: 0 }, { level: 0, list: 'bullet' }, { level: 1, list: 'bullet' }]);
    expect(losses.lines().join()).toMatch(/Tables/);
  });

  it('comes back from the .odp it is written to', () => {
    const { entries } = writeOdp(noteToSlides(note).document, new Map());
    const back = readOdp(decodeBlock(encodeBlock(entries))).document;
    expect(back.slides).toHaveLength(4);
    const texts = back.slides.map((s) => s.elements.map((e) => (e.content ?? []).map((r) => r.text).join('')).join(' | '));
    expect(texts[0]).toContain('Prima dei titoli.');
    expect(texts[1]).toContain('Partenza');
    expect(texts[2]).toContain('Tappa 10');
    expect(texts[3]).toContain('Tappa 12');
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and a note as a presentation', () => {
  it('shows each slide with its words', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'note.odp');
      writeBlock(encodeBlock(writeOdp(noteToSlides(note).document, new Map()).entries), file);
      const pages = pdfPages(convert(file, 'pdf', join(dir, 'pdf')))?.filter((p) => p.trim());
      if (!pages) return;
      expect(pages).toHaveLength(4);
      expect(pages[1]).toMatch(/Partenza[\s\S]*Si parte presto[\s\S]*valigia[\s\S]*passaporto/);
      expect(pages[3]).toMatch(/Tappe \(continued\)[\s\S]*Tappa 11/);
    } finally { cleanup(dir); }
  }, 120000);
});
