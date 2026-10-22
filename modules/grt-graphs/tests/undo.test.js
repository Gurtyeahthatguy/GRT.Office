/** The shared undo stack, and what a save does to it. */

import { describe, it, expect } from 'vitest';
import { UndoStack } from '../src/js/core/undo.js';

/** The smallest document: some text, and whether it differs from the file. */
function documentWith(text = '') {
  return {
    text,
    dirty: false,
    snapshot() {
      return { text: this.text, dirty: this.dirty };
    },
    restore(state) {
      this.text = state.text;
      this.dirty = state.dirty;
    },
  };
}

function type(doc, undo, text) {
  undo.do(() => {
    doc.text += text;
    doc.dirty = true;
  });
}

function save(doc, undo) {
  doc.dirty = false;
  undo.markSaved();
}

describe('saving and then undoing', () => {
  it('undoing past a save counts as a change, because the file still has it', () => {
    const doc = documentWith();
    const undo = new UndoStack(doc);
    type(doc, undo, 'a');
    save(doc, undo);
    undo.undo();
    expect(doc.text).toBe('');
    expect(doc.dirty).toBe(true);
  });

  it('redoing back to what was saved counts as saved again', () => {
    const doc = documentWith();
    const undo = new UndoStack(doc);
    type(doc, undo, 'a');
    save(doc, undo);
    undo.undo();
    undo.redo();
    expect(doc.text).toBe('a');
    expect(doc.dirty).toBe(false);
  });

  it('undoing a change made after the save returns to the saved state', () => {
    const doc = documentWith();
    const undo = new UndoStack(doc);
    type(doc, undo, 'a');
    save(doc, undo);
    type(doc, undo, 'b');
    expect(doc.dirty).toBe(true);
    undo.undo();
    expect(doc.text).toBe('a');
    expect(doc.dirty).toBe(false);
  });

  it('redo history ahead of a save is a change too', () => {
    const doc = documentWith();
    const undo = new UndoStack(doc);
    type(doc, undo, 'a');
    type(doc, undo, 'b');
    undo.undo();
    save(doc, undo);
    undo.redo();
    expect(doc.text).toBe('ab');
    expect(doc.dirty).toBe(true);
  });

  it('CANARY: without a save, undoing to the start is unchanged', () => {
    const doc = documentWith();
    const undo = new UndoStack(doc);
    type(doc, undo, 'a');
    undo.undo();
    expect(doc.dirty).toBe(false);
  });
});
