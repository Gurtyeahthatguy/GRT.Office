// @vitest-environment jsdom

/** Can the note actually be worked with?. */

import { describe, it, expect, beforeEach } from 'vitest';
import { NotesRenderer } from '../src/js/render-notes.js';
import { NoteDocument, makeTodo, makeCallout, makeEmbed } from '../src/js/note.js';
import { makeBlock } from '../src/js/core/editor/model.js';

let note;
let surface;
let renderer;
let known;

beforeEach(() => {
  document.body.innerHTML = '<div id="surface" contenteditable="true"></div>';
  surface = document.getElementById('surface');
  note = new NoteDocument();
  known = new Map([['kant', '/a/001-kant.grt']]);
  renderer = new NotesRenderer(surface, {
    resolveLink: (title) => known.get(String(title).toLowerCase()) ?? null,
  });
});

const withBlocks = (...blocks) => {
  note.blocks = blocks;
  renderer.draw(note, new Map());
};

const para = (text) => {
  const block = makeBlock('paragraph');
  block.runs = [{ text }];
  return block;
};

describe('to-do blocks', () => {
  it('draws a box and the text', () => {
    const todo = makeTodo(false);
    todo.runs = [{ text: 'buy the book' }];
    withBlocks(todo);

    expect(surface.querySelector('.todo-box')).toBeTruthy();
    expect(surface.querySelector('.todo-text').textContent).toBe('buy the book');
  });

  it('carries the block id on the box, so a click can find it', () => {
    const todo = makeTodo();
    withBlocks(todo);
    expect(surface.querySelector('.todo-box').dataset.block).toBe(todo.id);
  });

  it('resolves a click on the box even though the click may land on its tick', () => {
    const todo = makeTodo(true);
    withBlocks(todo);

    const box = surface.querySelector('.todo-box');
    const hit = box.closest('[data-action="toggle-todo"]');
    expect(hit).toBe(box);
    expect(hit.dataset.block).toBe(todo.id);
  });

  it('keeps the box out of the editable flow, so it cannot swallow the caret', () => {
    // A real <input> inside a contenteditable takes focus when clicked and
    // the text can no longer be typed into.
    withBlocks(makeTodo());
    const box = surface.querySelector('.todo-box');
    expect(box.tagName).not.toBe('INPUT');
    expect(box.getAttribute('contenteditable')).toBe('false');
  });

  it('shows a tick only when it is done', () => {
    withBlocks(makeTodo(false));
    expect(surface.querySelector('.todo-box').textContent).toBe('');

    withBlocks(makeTodo(true));
    expect(surface.querySelector('.todo-box').textContent).toBe('✓');
    expect(surface.querySelector('.todo').classList.contains('done')).toBe(true);
  });

  it('says whether it is checked, for anyone not looking at the screen', () => {
    withBlocks(makeTodo(true));
    const box = surface.querySelector('.todo-box');
    expect(box.getAttribute('role')).toBe('checkbox');
    expect(box.getAttribute('aria-checked')).toBe('true');
  });
});

describe('callouts', () => {
  it('draws its tone as a class, so the colour is CSS rather than markup', () => {
    const callout = makeCallout('warning');
    callout.runs = [{ text: 'careful' }];
    withBlocks(callout);

    const node = surface.querySelector('.callout');
    expect(node.classList.contains('tone-warning')).toBe(true);
    expect(node.textContent).toContain('careful');
  });

  it('keeps its mark out of the text', () => {
    withBlocks(makeCallout('idea'));
    expect(surface.querySelector('.callout-mark').getAttribute('contenteditable')).toBe('false');
  });
});

describe('embeds', () => {
  it('shows the target and a way to open it, and does not read the file', () => {
    withBlocks(makeEmbed('/a/b.grt'));
    expect(surface.querySelector('.embed-target').textContent).toBe('/a/b.grt');
    expect(surface.querySelector('[data-action="open-embed"]')).toBeTruthy();
  });

  it('says so when nothing is linked yet', () => {
    withBlocks(makeEmbed(''));
    expect(surface.querySelector('.embed-target').textContent).toContain('Nothing linked');
  });
});

describe('links between notes', () => {
  it('marks a link and remembers which title it is', () => {
    withBlocks(para('see [[Kant]] on this'));
    const link = surface.querySelector('.note-link');
    expect(link).toBeTruthy();
    expect(link.dataset.title).toBe('Kant');
  });

  it('resolves from the text inside the link, which is what a click hits', () => {
    withBlocks(para('see [[Kant]] on this'));
    const link = surface.querySelector('.note-link');
    const inner = link.firstChild;
    expect(inner.nodeType).toBe(3);
    expect(inner.parentElement.closest('[data-action="open-link"]')).toBe(link);
  });

  it('shows a link to a note that does not exist as unresolved, not as an error', () => {
    withBlocks(para('see [[Spinoza]]'));
    const link = surface.querySelector('.note-link');
    expect(link.classList.contains('unresolved')).toBe(true);
    expect(link.title).toContain('no note with this title yet');
  });

  it('leaves the text exactly as it was typed', () => {
    withBlocks(para('see [[Kant]] on this'));
    expect(surface.textContent).toBe('see [[Kant]] on this');
  });

  it('does not treat text that merely looks like markup as markup', () => {
    withBlocks(para('a <script>alert(1)</script> b'));
    expect(surface.querySelector('script')).toBeNull();
    expect(surface.textContent).toContain('<script>');
  });

  it('marks several links in one paragraph', () => {
    withBlocks(para('[[Kant]] and [[Hume]] and [[Kant]] again'));
    expect(surface.querySelectorAll('.note-link')).toHaveLength(3);
  });

  it('leaves a paragraph without links alone', () => {
    withBlocks(para('nothing to see'));
    expect(surface.querySelectorAll('.note-link')).toHaveLength(0);
    expect(surface.textContent).toBe('nothing to see');
  });

  it('finds links inside a to-do as well', () => {
    const todo = makeTodo();
    todo.runs = [{ text: 'read [[Kant]]' }];
    withBlocks(todo);
    expect(surface.querySelector('.note-link')).toBeTruthy();
  });
});

describe('everything else is the shared renderer', () => {
  it('still draws headings, quotes and lists', () => {
    const heading = makeBlock('heading', { level: 2 });
    heading.runs = [{ text: 'A heading' }];
    const quote = makeBlock('quote');
    quote.runs = [{ text: 'A quotation' }];
    const list = makeBlock('list');
    list.items = [{ level: 0, runs: [{ text: 'An item' }] }];

    withBlocks(heading, quote, list);

    expect(surface.querySelector('h2').textContent).toBe('A heading');
    expect(surface.querySelector('blockquote').textContent).toBe('A quotation');
    expect(surface.querySelector('li').textContent).toBe('An item');
  });

  it('gives an empty block somewhere to put the caret', () => {
    withBlocks(makeBlock('paragraph'));
    const block = surface.querySelector('[data-block]');
    expect(block.childNodes.length).toBeGreaterThan(0);
  });

  it('redraws from scratch rather than accumulating', () => {
    const todo = makeTodo();
    todo.runs = [{ text: 'once' }];
    withBlocks(todo);
    renderer.draw(note, new Map());
    renderer.draw(note, new Map());
    expect(surface.querySelectorAll('.todo')).toHaveLength(1);
  });

  it('marks every block with its id, which is how selection finds text', () => {
    withBlocks(para('a'), makeTodo(), makeCallout());
    const ids = [...surface.querySelectorAll('[data-block]')].map((n) => n.dataset.block);
    expect(new Set(ids).size).toBeGreaterThanOrEqual(3);
  });
});
