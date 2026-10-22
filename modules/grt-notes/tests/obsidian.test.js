// @vitest-environment jsdom

/** Obsidian's Markdown, read into blocks and written back. */

import { describe, it, expect } from 'vitest';
import { readObsidianNote, writeObsidianNote, readProperties, propertyLines } from '../src/js/core/formats/obsidian.js';
import { normaliseRuns } from '../src/js/core/editor/model.js';

const SAMPLE = `---
title: "A note: with a colon"
tags:
  - reading
  - philosophy/kant
rating: 4.5
done: false
due: 2026-10-17
when: 2026-10-17T09:30
aliases: [Kant notes, Critique]
nested:
  key: value
---
# Critique of Pure Reason

Some *emphasis*, **strong**, ~~struck~~ and ==highlighted== text.
A line that continues with a [[Other note|alias]] and a [[Note#Heading]].
%%A comment that Obsidian hides%% and a footnote.[^1]

> [!warning]- A folded warning
> Careful with this.
> It has two lines.

> A plain quote.

- [ ] First task
- [x] Second task

1. One
2. Two
\t- nested
3. Three

5) five
6) six

\`\`\`js
const x = 1;
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

---

<div>html</div>

![[Embedded note]]

$$
e^{i\\pi} + 1 = 0
$$

Escaped \\*not emphasis\\* and &amp; an entity.

[^1]: The footnote text.
`;

describe('reading Obsidian’s Markdown', () => {
  const note = readObsidianNote(SAMPLE);
  const kinds = note.blocks.map((b) => b.kind);

  it('makes blocks of what the editor knows, and keeps the rest as written', () => {
    expect(kinds).toEqual([
      'heading', 'paragraph', 'callout', 'quote', 'todo', 'todo', 'list', 'list', 'code',
      'raw', 'raw', 'raw', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
    ]);
  });

  it('reads formatting into marks and leaves links, comments and footnotes as their text', () => {
    const runs = note.blocks[1].runs;
    expect(runs.find((r) => r.italic).text).toBe('emphasis');
    expect(runs.find((r) => r.bold).text).toBe('strong');
    expect(runs.find((r) => r.strike).text).toBe('struck');
    expect(runs.find((r) => r.highlight).text).toBe('highlighted');
    const text = runs.map((r) => r.text).join('');
    expect(text).toContain('[[Other note|alias]]');
    expect(text).toContain('%%A comment that Obsidian hides%%');
    expect(text).toContain('footnote.[^1]');
    expect(note.blocks[15].runs[0].text).toBe('[^1]: The footnote text.');
  });

  it('reads callouts, tasks and lists', () => {
    const callout = note.blocks[2];
    expect(callout).toMatchObject({ calloutType: 'warning', fold: '-', title: 'A folded warning', tone: 'warning' });
    expect(callout.runs.map((r) => r.text).join('')).toBe('Careful with this.\nIt has two lines.');
    expect(note.blocks[4]).toMatchObject({ kind: 'todo', done: false });
    expect(note.blocks[5]).toMatchObject({ kind: 'todo', done: true });
    expect(note.blocks[6].items.map((i) => [i.level, i.runs[0].text])).toEqual([[0, 'One'], [0, 'Two'], [1, 'nested'], [0, 'Three']]);
    expect(note.blocks[7]).toMatchObject({ start: 5, marker: ')' });
  });

  it('reads properties with their types', () => {
    expect(note.properties.map((p) => [p.key, p.type, p.value])).toEqual([
      ['title', 'text', 'A note: with a colon'],
      ['tags', 'list', ['reading', 'philosophy/kant']],
      ['rating', 'number', 4.5],
      ['done', 'checkbox', false],
      ['due', 'date', '2026-10-17'],
      ['when', 'datetime', '2026-10-17T09:30'],
      ['aliases', 'list', ['Kant notes', 'Critique']],
      ['nested', 'raw', null],
    ]);
  });
});

describe('writing it back', () => {
  it('gives the same file, character for character, when nothing changed', () => {
    for (const text of [SAMPLE, SAMPLE.replace(/\n/g, '\r\n'), `﻿${SAMPLE}`, SAMPLE.trimEnd(), '', '\n', 'Just a line', '---\na: 1\n---', '---\na: 1\n---\n\n\nText\n\n\n']) {
      expect(writeObsidianNote(readObsidianNote(text))).toBe(text);
    }
  });

  it('writes anew only the block that changed', () => {
    const note = readObsidianNote(SAMPLE);
    note.blocks[4].done = true;
    note.blocks[1].runs = normaliseRuns([{ text: 'Rewritten with ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'marked', highlight: '#fff3a8' }]);
    const out = writeObsidianNote(note);
    const expected = SAMPLE
      .replace(/Some \*emphasis\*.*\n.*\n%%A comment that Obsidian hides%% and a footnote\.\[\^1\]/, 'Rewritten with **bold** and ==marked==')
      .replace('- [ ] First task\n- [x] Second task', '- [x] First task\n- [x] Second task');
    expect(out).toBe(expected);
  });

  it('writes a changed property in Obsidian’s way and keeps the others’ lines', () => {
    const note = readObsidianNote(SAMPLE);
    note.properties.find((p) => p.key === 'rating').value = 5;
    note.properties.find((p) => p.key === 'tags').value = ['reading'];
    note.properties.push({ key: 'source', type: 'text', value: 'Library: shelf 3' });
    const out = writeObsidianNote(note);
    expect(out.split('\n').slice(0, 15)).toEqual([
      '---', 'title: "A note: with a colon"', 'tags:', '  - reading', 'rating: 5', 'done: false', 'due: 2026-10-17',
      'when: 2026-10-17T09:30', 'aliases: [Kant notes, Critique]', 'nested:', '  key: value', 'source: "Library: shelf 3"', '---',
      '# Critique of Pure Reason', '',
    ]);
  });

  it('writes new blocks with Obsidian’s spacing', () => {
    const note = readObsidianNote('First paragraph.\n');
    const todo = { ...note.blocks[0], id: 'x', kind: 'todo', done: false, runs: [{ text: 'Do it' }], md: undefined };
    const second = { ...todo, id: 'y', runs: [{ text: 'And this' }] };
    note.blocks.push(todo, second, { id: 'z', kind: 'callout', tone: 'idea', calloutType: 'tip', title: 'Hint', runs: [{ text: 'Short.' }] });
    expect(writeObsidianNote(note)).toBe('First paragraph.\n\n- [ ] Do it\n- [ ] And this\n\n> [!tip] Hint\n> Short.\n');
  });

  it('starts a properties block when the first property is added', () => {
    const note = readObsidianNote('Body\n');
    note.properties.push({ key: 'status', type: 'text', value: 'draft' }, { key: 'tags', type: 'list', value: ['a b', 'c'] });
    expect(writeObsidianNote(note)).toBe('---\nstatus: draft\ntags:\n  - a b\n  - c\n---\nBody\n');
  });
});

describe('properties on their own', () => {
  it('quote text that would read as something else', () => {
    expect(propertyLines({ key: 'k', type: 'text', value: '42' })).toEqual(['k: "42"']);
    expect(propertyLines({ key: 'k', type: 'text', value: 'true' })).toEqual(['k: "true"']);
    expect(propertyLines({ key: 'k', type: 'text', value: '# not a comment' })).toEqual(['k: "# not a comment"']);
    expect(propertyLines({ key: 'k', type: 'number', value: 42 })).toEqual(['k: 42']);
    expect(readProperties(['k: "42"'])[0]).toMatchObject({ type: 'text', value: '42' });
  });
});
