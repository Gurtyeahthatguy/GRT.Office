/** Markdown export. */

import { describe, it, expect } from 'vitest';
import { noteToMarkdown, archiveToMarkdown } from '../src/js/export.js';
import { NoteDocument, makeTodo, makeCallout, makeEmbed } from '../src/js/note.js';
import { makeBlock } from '../src/js/core/editor/model.js';

function noteWith(blocks, { title = '', tags = [] } = {}) {
  const note = new NoteDocument();
  note.blocks = blocks;
  note.setTitle(title);
  note.setTags(tags);
  return note;
}

const para = (text, marks = {}) => {
  const block = makeBlock('paragraph');
  block.runs = [{ text, ...marks }];
  return block;
};

describe('one note', () => {
  it('writes the title as a heading and the tags beneath it', () => {
    const { text } = noteToMarkdown(noteWith([para('body')], { title: 'Kant', tags: ['philosophy'] }));
    expect(text).toContain('# Kant');
    expect(text).toContain('#philosophy');
  });

  it('writes emphasis', () => {
    const { text } = noteToMarkdown(noteWith([para('bold', { bold: true })]));
    expect(text).toContain('**bold**');
  });

  it('writes a to-do as a Markdown checkbox', () => {
    const done = makeTodo(true);
    done.runs = [{ text: 'finished' }];
    const open = makeTodo(false);
    open.runs = [{ text: 'pending' }];

    const { text } = noteToMarkdown(noteWith([done, open]));
    expect(text).toContain('- [x] finished');
    expect(text).toContain('- [ ] pending');
  });

  it('writes a code block in a fence', () => {
    const code = makeBlock('code');
    code.runs = [{ text: 'const x = 1;' }];
    const { text } = noteToMarkdown(noteWith([code]));
    expect(text).toContain('```\nconst x = 1;\n```');
  });

  it('turns a callout into a quotation and says so', () => {
    const callout = makeCallout('warning');
    callout.runs = [{ text: 'careful' }];

    const { text, lost } = noteToMarkdown(noteWith([callout]));
    expect(text).toContain('> **WARNING**');
    expect(text).toContain('careful');
    expect(lost.join(' ')).toContain('callout');
  });

  it('reports what an embed becomes', () => {
    const { lost } = noteToMarkdown(noteWith([makeEmbed('/a/b.grt')]));
    expect(lost.join(' ')).toContain('embedded');
  });

  it('reports the formatting Markdown cannot carry', () => {
    const { lost } = noteToMarkdown(noteWith([para('x', { underline: true })]));
    expect(lost).toContain('underlining');
  });

  it('says nothing was lost when nothing was', () => {
    expect(noteToMarkdown(noteWith([para('plain')])).lost).toEqual([]);
  });

  it('escapes Markdown punctuation so text survives as text', () => {
    const { text } = noteToMarkdown(noteWith([para('a * b _ c')]));
    expect(text).toContain('\\*');
    expect(text).toContain('\\_');
  });

  it('leaves links between notes as they were written, and says so', () => {
    const { text, lost } = noteToMarkdown(noteWith([para('see [[Kant]]')]));
    expect(text).toContain('Kant');
    expect(lost.join(' ')).toContain('links between notes');
  });
});

// the archive export keeps the tree

describe('the whole archive', () => {
  const entries = [
    {
      note: noteWith([para('one')], { title: 'Kant' }),
      notebook: 'University', section: 'Philosophy', file: '001-kant',
    },
    {
      note: noteWith([para('two')], { title: 'Reti' }),
      notebook: 'University', section: 'Informatica', file: '001-reti',
    },
    {
      note: noteWith([para('three')], { title: 'Ideas' }),
      notebook: 'Projects', section: null, file: '001-ideas',
    },
  ];

  it('puts each note in its notebook and section folder', () => {
    const { files } = archiveToMarkdown(entries);
    expect(files.map((f) => f.path).sort()).toEqual([
      'Projects/ideas.md',
      'University/Informatica/reti.md',
      'University/Philosophy/kant.md',
    ]);
  });

  it('writes a note with no section directly in its notebook', () => {
    const { files } = archiveToMarkdown(entries);
    expect(files.find((f) => f.text.includes('three')).path).toBe('Projects/ideas.md');
  });

  it('keeps every note', () => {
    const { files } = archiveToMarkdown(entries);
    expect(files).toHaveLength(3);
  });

  it('does not let two notes with the same title overwrite each other', () => {
    const clash = [
      { note: noteWith([para('a')], { title: 'Same' }), notebook: 'N', section: null, file: '001-a' },
      { note: noteWith([para('b')], { title: 'Same' }), notebook: 'N', section: null, file: '002-b' },
    ];
    const { files } = archiveToMarkdown(clash);
    expect(new Set(files.map((f) => f.path)).size).toBe(2);
    expect(files.map((f) => f.path)).toEqual(['N/same.md', 'N/same-2.md']);
  });

  it('gathers what was lost across the whole archive, without repeating it', () => {
    const withLoss = [
      { note: noteWith([para('a', { underline: true })]), notebook: 'N', section: null, file: '1' },
      { note: noteWith([para('b', { underline: true })]), notebook: 'N', section: null, file: '2' },
    ];
    expect(archiveToMarkdown(withLoss).lost).toEqual(['underlining']);
  });

  it('handles an empty archive', () => {
    expect(archiveToMarkdown([])).toEqual({ files: [], lost: [] });
  });

  it('strips separators out of folder names rather than making sub-folders', () => {
    const odd = [{
      note: noteWith([para('x')], { title: 'T' }),
      notebook: 'A/B', section: null, file: '1',
    }];
    expect(archiveToMarkdown(odd).files[0].path).toBe('AB/t.md');
  });
});
