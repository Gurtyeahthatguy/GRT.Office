// @vitest-environment jsdom

/** Can a character actually be typed?. */

import { describe, it, expect, beforeEach } from 'vitest';
import { EditorController } from '../src/js/core/editor/controller.js';
import { NotesRenderer } from '../src/js/render-notes.js';
import { NoteDocument, makeTodo } from '../src/js/note.js';
import { makeBlock, runsText } from '../src/js/core/editor/model.js';

let note;
let surface;
let editor;
let changes;

/** Puts the browser's caret at an offset inside a block, as a click would. */
function caretAt(blockId, offset) {
  const host = surface.querySelector(`[data-block="${blockId}"]`);
  const walker = document.createTreeWalker(host, 4 /** SHOW_TEXT. */);
  let node = walker.nextNode();
  let seen = 0;

  while (node) {
    const length = node.nodeValue.length;
    if (seen + length >= offset) break;
    seen += length;
    node = walker.nextNode();
  }
  if (!node) {
    node = document.createTextNode('');
    host.append(node);
    seen = offset;
  }

  const range = document.createRange();
  range.setStart(node, Math.min(offset - seen, node.nodeValue.length));
  range.collapse(true);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectRange(blockId, from, to) {
  caretAt(blockId, from);
  const anchor = window.getSelection().getRangeAt(0);
  caretAt(blockId, to);
  const focus = window.getSelection().getRangeAt(0);

  const range = document.createRange();
  range.setStart(anchor.startContainer, anchor.startOffset);
  range.setEnd(focus.startContainer, focus.startOffset);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

const firstBlock = () => note.blocks[0];
const textOf = () => runsText(firstBlock().runs ?? []);

beforeEach(() => {
  document.body.innerHTML = '<div id="surface" contenteditable="true"></div>';
  surface = document.getElementById('surface');
  changes = [];

  note = new NoteDocument();
  const renderer = new NotesRenderer(surface, { resolveLink: () => null });
  editor = new EditorController(surface, renderer, {
    onChange: (info) => changes.push(info),
  });
  editor.attach(note);
});

// The bug that shipped

describe('typing a character', () => {
  it('puts it in the model', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('a');
    expect(textOf()).toBe('a');
  });

  it('puts it on the screen', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('a');
    expect(surface.textContent).toBe('a');
  });

  it('types a whole word one character at a time', () => {
    caretAt(firstBlock().id, 0);
    for (const character of 'hello') {
      editor.handlers.insertText(character);
      caretAt(firstBlock().id, textOf().length);
    }
    expect(textOf()).toBe('hello');
    expect(surface.textContent).toBe('hello');
  });

  it('inserts in the middle rather than always at the end', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('ac');
    caretAt(firstBlock().id, 1);
    editor.handlers.insertText('b');
    expect(textOf()).toBe('abc');
  });

  it('reports the change so the note gets saved', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('a');
    expect(changes.some((c) => c.typed)).toBe(true);
    expect(note.dirty).toBe(true);
  });

  it('CANARY: reading the selection really does find the caret', () => {
    // If this fails, every test above is passing for some other reason.
    caretAt(firstBlock().id, 0);
    const read = editor.readSelection();
    expect(read).not.toBeNull();
    expect(read.anchor.blockId).toBe(firstBlock().id);
  });
});

describe('when the caret cannot be read', () => {
  it('falls back to the end of the document rather than doing nothing', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('abc');

    // A click on the padding below the text.
    window.getSelection().removeAllRanges();

    editor.handlers.insertText('d');
    expect(textOf()).toBe('abcd');
  });
});

// Everything else the handlers do

describe('splitting and deleting', () => {
  beforeEach(() => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('hello');
  });

  it('splits a block at the caret', () => {
    caretAt(firstBlock().id, 2);
    editor.handlers.splitBlock();
    expect(note.blocks).toHaveLength(2);
    expect(runsText(note.blocks[0].runs)).toBe('he');
    expect(runsText(note.blocks[1].runs)).toBe('llo');
  });

  it('deletes backwards', () => {
    caretAt(firstBlock().id, 5);
    editor.handlers.deleteBackward();
    expect(textOf()).toBe('hell');
  });

  it('deletes forwards', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.deleteForward();
    expect(textOf()).toBe('ello');
  });

  it('deletes a selection', () => {
    selectRange(firstBlock().id, 1, 4);
    editor.handlers.deleteSelection();
    expect(textOf()).toBe('ho');
  });
});

describe('formatting', () => {
  beforeEach(() => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('hello');
  });

  it('applies a mark to a selection', () => {
    selectRange(firstBlock().id, 0, 5);
    editor.handlers.toggleMark('bold');
    expect(firstBlock().runs.every((run) => run.bold)).toBe(true);
    expect(surface.querySelector('strong')).toBeTruthy();
  });

  it('holds a mark for the next character when nothing is selected', () => {
    caretAt(firstBlock().id, 5);
    editor.handlers.toggleMark('bold');
    expect(editor.markIsOn('bold')).toBe(true);

    editor.handlers.insertText('!');
    expect(firstBlock().runs[firstBlock().runs.length - 1].bold).toBe(true);
  });

  it('stops holding the mark once it has been used', () => {
    caretAt(firstBlock().id, 5);
    editor.handlers.toggleMark('bold');
    editor.handlers.insertText('!');
    expect(editor.markIsOn('bold')).toBe(false);
  });
});

describe('undo', () => {
  it('takes typing back, and forward again', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('a');
    editor.typing.end();
    caretAt(firstBlock().id, 1);
    editor.handlers.insertText('b');

    editor.step(-1);
    expect(textOf()).toBe('a');

    editor.step(1);
    expect(textOf()).toBe('ab');
  });

  it('does nothing at the start of history rather than throwing', () => {
    expect(editor.step(-1)).toBe(false);
    expect(editor.step(1)).toBe(false);
  });

  it('restores the title and the tags too, not only the text', () => {
    note.setTitle('First');
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('a');

    note.setTitle('Second');
    editor.step(-1);
    expect(note.title).toBe('First');
  });

  it('groups a run of typing into one step', () => {
    caretAt(firstBlock().id, 0);
    for (const character of 'word') {
      editor.handlers.insertText(character);
      caretAt(firstBlock().id, textOf().length);
    }
    editor.step(-1);
    expect(textOf()).toBe('');
  });

  it('redraws what it restored', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('abc');
    editor.step(-1);
    expect(surface.textContent).toBe('');
  });
});

describe('to-do blocks', () => {
  it('toggles without losing the text', () => {
    const todo = makeTodo(false);
    todo.runs = [{ text: 'buy the book' }];
    note.blocks = [todo];
    editor.attach(note);

    expect(editor.toggleTodo(todo.id)).toBe(true);
    expect(todo.done).toBe(true);
    expect(runsText(todo.runs)).toBe('buy the book');
    expect(surface.querySelector('.todo').classList.contains('done')).toBe(true);
  });

  it('can be undone', () => {
    const todo = makeTodo(false);
    note.blocks = [todo];
    editor.attach(note);

    editor.toggleTodo(todo.id);
    editor.step(-1);
    expect(note.blocks[0].done).toBe(false);
  });

  it('ignores a block that is not there', () => {
    expect(editor.toggleTodo('nonsense')).toBe(false);
  });
});

describe('pasting', () => {
  it('takes plain text', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.paste({ html: '', text: 'one\ntwo' });
    expect(note.blocks.map((b) => runsText(b.runs ?? []))).toContain('one');
    expect(note.blocks.map((b) => runsText(b.runs ?? []))).toContain('two');
  });

  it('takes formatted HTML, which returns an object and not an array', () => {
    // The first version of this called blocksFromHtml(html) and read .length
    // off the result, so every paste of formatted text silently did nothing.
    caretAt(firstBlock().id, 0);
    editor.handlers.paste({ html: '<p>hello <b>world</b></p>', text: 'hello world' });
    expect(runsText(note.blocks[0].runs)).toContain('hello');
    expect(note.blocks.some((b) => (b.runs ?? []).some((r) => r.bold))).toBe(true);
  });

  it('does nothing with an empty clipboard rather than throwing', () => {
    caretAt(firstBlock().id, 0);
    expect(() => editor.handlers.paste({ html: '', text: '' })).not.toThrow();
  });
});

describe('copying', () => {
  it('returns the selected text and some HTML', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('hello');
    selectRange(firstBlock().id, 0, 5);

    const payload = editor.handlers.copy();
    expect(payload.text).toBe('hello');
    expect(payload.html).toContain('hello');
  });

  it('returns nothing when nothing is selected', () => {
    caretAt(firstBlock().id, 0);
    expect(editor.handlers.copy()).toBeNull();
  });

  it('escapes text so the clipboard HTML cannot carry markup', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('<b>x</b>');
    selectRange(firstBlock().id, 0, 8);
    expect(editor.handlers.copy().html).toContain('&lt;b&gt;');
  });
});

describe('inserting blocks', () => {
  it('adds a to-do at the caret', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertBlock(makeTodo());
    expect(note.blocks.some((b) => b.kind === 'todo')).toBe(true);
    expect(surface.querySelector('.todo')).toBeTruthy();
  });

  it('adds a code block', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertBlock(makeBlock('code'));
    expect(surface.querySelector('pre')).toBeTruthy();
  });
});

describe('replacing a block, as link completion does', () => {
  it('rewrites the text and moves the caret past the link', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('see [[kan');

    editor.replaceBlockText(firstBlock().id, 'see [[Kant]]', 12);
    expect(textOf()).toBe('see [[Kant]]');
    expect(editor.selection.anchor.offset).toBe(12);
    expect(surface.querySelector('.note-link')).toBeTruthy();
  });

  it('can be undone', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('see [[kan');
    editor.replaceBlockText(firstBlock().id, 'see [[Kant]]', 12);
    editor.step(-1);
    expect(textOf()).toBe('see [[kan');
  });
});

describe('attaching another note', () => {
  it('draws it and forgets the previous undo history', () => {
    caretAt(firstBlock().id, 0);
    editor.handlers.insertText('first');

    const second = new NoteDocument();
    second.blocks = [makeBlock('paragraph')];
    second.setRuns(second.blocks[0].id, [{ text: 'second' }]);
    editor.attach(second);

    expect(surface.textContent).toBe('second');
    expect(editor.step(-1)).toBe(false);
  });
});

describe('attaching a document', () => {
  /**
   * Added after the refactor that moved this controller into the core broke
   * GRT Paper.
   */
  it('always leaves a caret, so a host can read the selection at once', () => {
    const fresh = new NoteDocument();
    editor.attach(fresh);
    expect(editor.selection).not.toBeNull();
    expect(editor.selection.anchor.blockId).toBe(fresh.blocks[0].id);
    expect(editor.selection.anchor.offset).toBe(0);
  });

  it('puts the caret at the start, not the end', () => {
    const fresh = new NoteDocument();
    fresh.setRuns(fresh.blocks[0].id, [{ text: 'existing text' }]);
    editor.attach(fresh);
    expect(editor.selection.anchor.offset).toBe(0);
  });

  it('survives a document with no blocks at all', () => {
    const empty = new NoteDocument();
    empty.blocks = [];
    expect(() => editor.attach(empty)).not.toThrow();
    expect(editor.selection).toBeNull();
  });
});
