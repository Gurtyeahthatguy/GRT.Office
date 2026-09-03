/**
 * The note document: what it adds to the shared editor, and what it drops.
 */

import { describe, it, expect } from 'vitest';
import {
  NoteDocument, normaliseTags, parseTagInput, makeTodo, makeCallout, makeEmbed,
  toParts, fromParts, NOTE_BLOCK_KINDS, CALLOUT_TONES,
} from '../src/js/note.js';
import { makeBlock, BLOCK_KINDS, runsText } from '../src/js/core/editor/model.js';

function noteWith(blocks) {
  const note = new NoteDocument();
  note.blocks = blocks;
  return note;
}

function paragraph(text) {
  const block = makeBlock('paragraph');
  block.runs = [{ text }];
  return block;
}

describe('the shared engine, borrowed', () => {
  it('is the same model GRT Paper uses', () => {
    const note = new NoteDocument();
    expect(note.blocks).toHaveLength(1);
    expect(typeof note.setRuns).toBe('function');
    expect(typeof note.snapshot).toBe('function');
  });

  it('registers the three kinds a note adds', () => {
    for (const kind of NOTE_BLOCK_KINDS) expect(BLOCK_KINDS).toContain(kind);
  });

  it('calls itself a note in the container, not a document', () => {
    expect(new NoteDocument().toJSON().type).toBe('notes');
  });

  it('has no page, because a note does not have pages', () => {
    expect(new NoteDocument().toJSON().page).toBeNull();
  });
});

describe('title and tags', () => {
  it('reports whether the title actually changed', () => {
    const note = new NoteDocument();
    expect(note.setTitle('Kant')).toBe(true);
    expect(note.setTitle('Kant')).toBe(false);
  });

  it('lower-cases tags and drops duplicates', () => {
    expect(normaliseTags(['Kant', 'kant', 'Philosophy'])).toEqual(['kant', 'philosophy']);
  });

  it('turns spaces inside a tag into hyphens', () => {
    expect(normaliseTags(['pure reason'])).toEqual(['pure-reason']);
  });

  it('reads a tag line however it was typed', () => {
    expect(parseTagInput('#kant, philosophy  #ethics')).toEqual(['kant', 'philosophy', 'ethics']);
  });

  it('ignores anything that is not a list', () => {
    expect(normaliseTags('kant')).toEqual([]);
    expect(normaliseTags(null)).toEqual([]);
  });
});

describe('the blocks a note adds', () => {
  it('makes a to-do that remembers whether it is done', () => {
    expect(makeTodo().done).toBe(false);
    expect(makeTodo(true).done).toBe(true);
  });

  it('makes a callout with a tone, refusing one it does not have', () => {
    expect(makeCallout('warning').tone).toBe('warning');
    expect(makeCallout('rainbow').tone).toBe('note');
    expect(CALLOUT_TONES).toContain(makeCallout().tone);
  });

  it('makes an embed pointing somewhere', () => {
    expect(makeEmbed('/a/b.grt').target).toBe('/a/b.grt');
  });

  it('gives every added block runs, so it can be typed into', () => {
    for (const block of [makeTodo(), makeCallout(), makeEmbed('x')]) {
      expect(Array.isArray(block.runs)).toBe(true);
    }
  });
});

describe('searchable text', () => {
  it('includes ordinary paragraphs', () => {
    const note = noteWith([paragraph('the categorical imperative')]);
    expect(note.plainText()).toContain('categorical imperative');
  });

  it('includes code blocks', () => {
    const code = makeBlock('code');
    code.runs = [{ text: 'const answer = 42;' }];
    expect(noteWith([code]).plainText()).toContain('const answer = 42;');
  });

  it('includes callouts', () => {
    const callout = makeCallout('warning');
    callout.runs = [{ text: 'do not forget the deadline' }];
    expect(noteWith([callout]).plainText()).toContain('do not forget the deadline');
  });

  it('includes to-dos, done or not', () => {
    const todo = makeTodo(true);
    todo.runs = [{ text: 'buy the book' }];
    expect(noteWith([todo]).plainText()).toContain('buy the book');
  });

  it('includes list items', () => {
    const list = makeBlock('list');
    list.items = [{ level: 0, runs: [{ text: 'first' }] }, { level: 0, runs: [{ text: 'second' }] }];
    const text = noteWith([list]).plainText();
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  it('includes an image caption but not the image', () => {
    const image = makeBlock('image');
    image.caption = [{ text: 'the frontispiece' }];
    expect(noteWith([image]).plainText()).toBe('the frontispiece');
  });
});

describe('saving and loading', () => {
  it('round-trips title, tags and blocks', () => {
    const note = noteWith([paragraph('hello')]);
    note.setTitle('Kant');
    note.setTags(['philosophy']);

    const back = fromParts(toParts(note));
    expect(back.title).toBe('Kant');
    expect(back.tags).toEqual(['philosophy']);
    expect(runsText(back.blocks[0].runs)).toBe('hello');
  });

  it('round-trips the added block kinds', () => {
    const todo = makeTodo(true);
    todo.runs = [{ text: 'done thing' }];
    const callout = makeCallout('idea');
    callout.runs = [{ text: 'an idea' }];

    const back = fromParts(toParts(noteWith([todo, callout])));
    expect(back.blocks[0].kind).toBe('todo');
    expect(back.blocks[0].done).toBe(true);
    expect(back.blocks[1].kind).toBe('callout');
    expect(back.blocks[1].tone).toBe('idea');
  });

  /** two saves of the same note produce identical bytes. */
  it('serialises identically twice', () => {
    const note = noteWith([paragraph('stable')]);
    note.setTitle('Kant');
    note.setTags(['a', 'b']);
    expect(JSON.stringify(toParts(note))).toBe(JSON.stringify(toParts(note)));
  });

  it('serialises identically after a round trip', () => {
    const note = noteWith([paragraph('stable')]);
    note.setTitle('Kant');
    const once = toParts(note);
    expect(JSON.stringify(toParts(fromParts(once)))).toBe(JSON.stringify(once));
  });

  it('refuses a file with no note in it, rather than producing an empty one', () => {
    expect(() => fromParts({})).toThrow();
  });
});

describe('undo', () => {
  it('snapshots the title and tags as well as the text', () => {
    const note = noteWith([paragraph('one')]);
    note.setTitle('First');
    note.setTags(['x']);

    const snapshot = note.snapshot();
    note.setTitle('Second');
    note.setTags(['y']);
    note.restore(snapshot);

    expect(note.title).toBe('First');
    expect(note.tags).toEqual(['x']);
  });
});
