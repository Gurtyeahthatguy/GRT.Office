/** The three blocks a note has and a document does not. */

import { Renderer, runElements, styleCss } from './core/editor/render.js';

const TONE_MARK = { note: 'i', warning: '!', idea: '*' };

export class NotesRenderer extends Renderer {
  /**
   * @param {HTMLElement} surface
   * @param {{resolveLink?: (title: string) => (string|null)}} options
   */
  constructor(surface, options = {}) {
    super(surface);
    this.resolveLink = options.resolveLink ?? (() => null);
  }

  blockElement(block, model, images) {
    if (block.kind === 'embed') return this.embedElement(block);

    const element = block.kind === 'todo' ? this.todoElement(block, model)
      : block.kind === 'callout' ? this.calloutElement(block, model)
        : super.blockElement(block, model, images);

    // Links are marked here, once, on whatever the renderer produced.
    if (block.kind !== 'code') markLinks(element, this.resolveLink);

    return element;
  }

  todoElement(block, model) {
    const style = model.styles[block.style] ?? model.styles.body ?? {};

    const row = document.createElement('div');
    row.className = 'block todo';
    row.dataset.block = block.id;
    row.classList.toggle('done', Boolean(block.done));
    Object.assign(row.style, styleCss(style, model));

    // The box is not a real <input>.
    const box = document.createElement('span');
    box.className = 'todo-box';
    box.dataset.action = 'toggle-todo';
    box.dataset.block = block.id;
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(Boolean(block.done)));
    // The attribute, not the property.
    box.setAttribute('contenteditable', 'false');
    box.textContent = block.done ? '✓' : '';

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.dataset.blockText = block.id;
    text.append(...runElements(block.runs));

    row.append(box, text);
    return row;
  }

  calloutElement(block, model) {
    const style = model.styles[block.style] ?? model.styles.body ?? {};

    const box = document.createElement('aside');
    box.className = `block callout tone-${block.tone ?? 'note'}`;
    box.dataset.block = block.id;
    Object.assign(box.style, styleCss(style, model));

    const mark = document.createElement('span');
    mark.className = 'callout-mark';
    mark.setAttribute('contenteditable', 'false');
    mark.textContent = TONE_MARK[block.tone] ?? TONE_MARK.note;

    const text = document.createElement('div');
    text.className = 'callout-text';
    text.dataset.blockText = block.id;
    text.append(...runElements(block.runs));

    box.append(mark, text);
    return box;
  }

  /** A reference to another document in the suite. */
  embedElement(block) {
    const box = document.createElement('div');
    box.className = 'block embed';
    box.dataset.block = block.id;
    box.setAttribute('contenteditable', 'false');

    const label = document.createElement('span');
    label.className = 'embed-target';
    label.textContent = block.target || 'Nothing linked yet';

    const open = document.createElement('button');
    open.className = 'embed-open';
    open.dataset.action = 'open-embed';
    open.dataset.block = block.id;
    open.textContent = 'Open';

    box.append(label, open);
    return box;
  }

}

/** Wraps every `[[title]]` in the tree in a span. */
function markLinks(root, resolveLink) {
  const walker = document.createTreeWalker(root, 4 /** NodeFilter.SHOW_TEXT. */);
  const targets = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes('[[')) targets.push(walker.currentNode);
  }

  for (const node of targets) {
    const pieces = String(node.nodeValue).split(/(\[\[[^\]\n]+\]\])/g);
    if (pieces.length === 1) continue;

    const fragment = document.createDocumentFragment();
    for (const piece of pieces) {
      const match = /^\[\[([^\]\n]+)\]\]$/.exec(piece);
      if (!match) {
        if (piece) fragment.append(document.createTextNode(piece));
        continue;
      }

      const title = match[1].trim();
      const target = resolveLink(title);
      const link = document.createElement('span');
      link.className = target ? 'note-link' : 'note-link unresolved';
      link.dataset.action = 'open-link';
      link.dataset.title = title;
      link.textContent = piece;
      link.title = target ? title : `${title} — no note with this title yet`;
      fragment.append(link);
    }

    node.replaceWith(fragment);
  }
}
