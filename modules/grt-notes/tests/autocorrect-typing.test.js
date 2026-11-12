// @vitest-environment jsdom

/** AutoCorrect while typing: the word a character ends is put right, as an undo step of its own. */

import { describe, it, expect, beforeEach } from 'vitest';
import { EditorController } from '../src/js/core/editor/controller.js';
import { NotesRenderer } from '../src/js/render-notes.js';
import { NoteDocument } from '../src/js/note.js';
import { makeBlock, runsText } from '../src/js/core/editor/model.js';
import { DEFAULT_OPTIONS, DEFAULT_REPLACEMENTS } from '../src/js/core/autocorrect.js';

let note;
let surface;
let editor;
let rules;

function caretAtEnd() {
  const block = note.blocks[0];
  const host = surface.querySelector(`[data-block="${block.id}"]`);
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

const type = (text) => {
  for (const character of text) {
    caretAtEnd();
    editor.handlers.insertText(character);
  }
};
const textOf = () => runsText(note.blocks[0].runs ?? []);

beforeEach(() => {
  document.body.innerHTML = '<div id="surface" contenteditable="true"></div>';
  surface = document.getElementById('surface');
  note = new NoteDocument();
  rules = { options: { ...DEFAULT_OPTIONS }, table: DEFAULT_REPLACEMENTS };
  editor = new EditorController(surface, new NotesRenderer(surface, { resolveLink: () => null }), { autocorrect: () => rules });
  editor.attach(note);
});

describe('AutoCorrect while typing', () => {
  it('puts words right as they end', () => {
    type('"teh end." the (c) one');
    expect(textOf()).toBe('“The end.” The © one');
  });

  it('gives back what was typed on Ctrl+Z, keeping the character', () => {
    type('teh ');
    expect(textOf()).toBe('The ');
    editor.step(-1);
    expect(textOf()).toBe('teh ');
  });

  it('keeps the look of the word it corrects', () => {
    note.blocks[0].runs = [{ text: 'a ' }, { text: 'teh', bold: true }];
    editor.attach(note);
    type(' ');
    // The space typed takes the look of the letter before it, as any typed character does.
    expect(note.blocks[0].runs).toEqual([{ text: 'a ' }, { text: 'the ', bold: true }]);
  });

  it('does nothing when off, in code, or while composing', () => {
    rules.options.whileTyping = false;
    type('teh ');
    expect(textOf()).toBe('teh ');
    rules.options.whileTyping = true;
    const code = makeBlock('code');
    note.blocks = [code];
    editor.attach(note);
    type('"teh ');
    expect(textOf()).toBe('"teh ');
    note.blocks = [makeBlock('paragraph')];
    editor.attach(note);
    caretAtEnd();
    editor.handlers.insertText('"', { composed: true });
    expect(textOf()).toBe('"');
  });

  it('marks its change when changes are recorded', () => {
    // Text already there is marked as taken out; what was typed under recording is simply put right.
    note.blocks[0].runs = [{ text: 'teh' }];
    note.review = { recording: true };
    editor.attach(note);
    type(' ');
    const runs = note.blocks[0].runs;
    expect(runs.filter((r) => !r.del).map((r) => r.text).join('')).toBe('The ');
    expect(runs.filter((r) => r.del).map((r) => r.text).join('')).toBe('teh');
    expect(runs.filter((r) => r.ins).map((r) => r.text).join('')).toBe('The ');
  });
});
