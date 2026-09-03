// @vitest-environment jsdom

/** The in-place editing loop. */

import { describe, it, expect, beforeEach } from 'vitest';
import { editInPlace } from '../src/js/editing.js';

let node;
let committed;
let ended;

/**
 * The loop with a plain string behind it, which is a table cell in miniature.
 */
function edit(value, extra = {}) {
  return editInPlace(node, {
    className: 'editing',
    seed: () => { node.textContent = value; },
    read: () => node.textContent,
    changed: (text) => text !== value,
    commit: (text) => committed.push(text),
    after: () => { ended += 1; },
    ...extra,
  });
}

const press = (key, init = {}) => node.dispatchEvent(
  new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
);

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  node = document.getElementById('host');
  committed = [];
  ended = 0;
});

describe('starting', () => {
  it('marks the node, opens it for typing and puts the value in it', () => {
    edit('Hello');

    expect(node.classList.contains('editing')).toBe(true);
    expect(node.contentEditable).toBe('true');
    expect(node.textContent).toBe('Hello');
  });

  it('leaves the caret at the end when asked to select everything', () => {
    edit('Hello', { selectAll: true });
    expect(window.getSelection().isCollapsed).toBe(true);
  });
});

describe('finishing', () => {
  it('keeps what was typed when the node loses the caret', () => {
    edit('Hello');
    node.textContent = 'Hello there';
    node.dispatchEvent(new window.FocusEvent('blur'));

    expect(committed).toEqual(['Hello there']);
  });

  it('throws it away on Escape', () => {
    edit('Hello');
    node.textContent = 'Never typed';
    press('Escape');

    expect(committed).toEqual([]);
    expect(ended).toBe(1);
  });

  it('CANARY: an edit that changed nothing commits nothing', () => {
    // Opening a box, looking at it and clicking away is not an action anyone
    // expects to have to undo.
    edit('Hello');
    node.dispatchEvent(new window.FocusEvent('blur'));

    expect(committed).toEqual([]);
    expect(ended).toBe(1);
  });

  it('gives the node back when it is done', () => {
    edit('Hello');
    press('Escape');

    expect(node.classList.contains('editing')).toBe(false);
    expect(node.contentEditable).toBe('false');
  });

  it('finishes once, however many times it is told to', () => {
    // Blur arrives while the edit is being torn down.
    const finish = edit('Hello');
    node.textContent = 'Changed';

    finish(true);
    node.dispatchEvent(new window.FocusEvent('blur'));
    finish(true);

    expect(committed).toEqual(['Changed']);
    expect(ended).toBe(1);
  });

  it('stops listening, so a later key does nothing', () => {
    edit('Hello');
    press('Escape');

    node.textContent = 'After the fact';
    node.dispatchEvent(new window.FocusEvent('blur'));

    expect(committed).toEqual([]);
    expect(ended).toBe(1);
  });
});

describe('keys', () => {
  it('keeps the document out of it while a caret is in the node', () => {
    // Without this the program's own Delete would remove the very element
    // being typed into.
    let reachedDocument = false;
    document.addEventListener('keydown', () => { reachedDocument = true; });

    edit('Hello');
    press('Delete');

    expect(reachedDocument).toBe(false);
  });

  it('hands anything else to the caller', () => {
    const seen = [];
    edit('Hello', {
      keys: (event, finish) => {
        seen.push(event.key);
        if (event.key === 'Enter') { finish(true); return true; }
        return false;
      },
    });

    node.textContent = 'Committed by Enter';
    press('Tab');
    press('Enter');

    expect(seen).toEqual(['Tab', 'Enter']);
    expect(committed).toEqual(['Committed by Enter']);
  });

  it('does not hand Escape to the caller: it is always a cancel', () => {
    const seen = [];
    edit('Hello', { keys: (event) => { seen.push(event.key); return false; } });

    press('Escape');
    expect(seen).toEqual([]);
    expect(committed).toEqual([]);
  });
});
