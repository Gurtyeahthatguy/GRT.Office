// @vitest-environment jsdom

/** Tables and formulas in notes, as Obsidian writes them. */

import { describe, it, expect } from 'vitest';
import { readObsidianNote, writeObsidianNote } from '../src/js/core/formats/obsidian.js';

const NOTE = [
  'Energy is $E = mc^2$, and the cost is $5 or $6.',
  '',
  '$$\\sum_{i=1}^n i$$',
  '',
  '| Item | Cost |',
  '| :--- | ---: |',
  '| Pen | 2 |',
  '| Ink | 3 |',
  '',
].join('\n');

describe('a note with tables and formulas', () => {
  const note = readObsidianNote(NOTE);
  it('reads formulas, inline and on their own line, but not prices', () => {
    const math = note.blocks.flatMap((b) => b.runs ?? []).filter((r) => r.object?.type === 'math').map((r) => [r.object.tex, !!r.object.display]);
    expect(math).toEqual([['E = mc^2', false], ['\\sum_{i=1}^n i', true]]);
    expect(note.blocks[0].runs.map((r) => r.text).join('')).toContain('$5 or $6');
  });

  it('reads a table, its heading row and alignments', () => {
    const table = note.blocks.find((b) => b.kind === 'table');
    expect(table.rows.map((r) => r.cells.map((c) => c.runs[0].text))).toEqual([['Item', 'Cost'], ['Pen', '2'], ['Ink', '3']]);
    expect(table.rows[0].header).toBe(true);
    expect(table.rows[0].cells.map((c) => c.align ?? null)).toEqual(['left', 'right']);
  });

  it('writes untouched notes back byte for byte, and changed ones as Markdown', () => {
    expect(writeObsidianNote(note)).toBe(NOTE);
    const table = note.blocks.find((b) => b.kind === 'table');
    table.rows[1].cells[1].runs = [{ text: '2|3' }];
    const written = writeObsidianNote(note);
    expect(written).toContain('| Pen | 2\\|3 |');
    expect(readObsidianNote(written).blocks.find((b) => b.kind === 'table').rows[1].cells[1].runs[0].text).toBe('2|3');
  });
});
