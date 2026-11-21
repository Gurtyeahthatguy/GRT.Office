/** The three blocks a note has and a document does not. */

import { Renderer, runElements, styleCss } from './core/editor/render.js';
import { linkTarget } from './links.js';
import { mermaidSvg } from './core/mermaid.js';
import { drawingHolder } from './core/editor/drawings.js';
import { cleanSketch } from './core/draw/sketch.js';

/** The width a drawing is shown at, at most. */
const DRAWING_WIDTH = 720;

/** A drawing kept in the note as a code block of its own: shown as the picture, pressed to change it. */
function drawingElement(block) {
  const box = document.createElement('div');
  box.className = 'block drawing-block';
  box.dataset.block = block.id;
  box.dataset.action = 'edit-drawing';
  box.setAttribute('contenteditable', 'false');
  box.title = 'A drawing: press to change it';
  let drawing;
  try { drawing = cleanSketch(JSON.parse((block.runs ?? []).map((r) => r.text).join(''))); } catch { drawing = null; }
  if (!drawing) { box.textContent = 'A drawing that cannot be read'; return box; }
  const page = document.createElement('div');
  page.className = 'drawing-page';
  Object.assign(page.style, { width: `${drawing.w}px`, height: `${drawing.h}px`, zoom: String(Math.min(1, DRAWING_WIDTH / drawing.w)) });
  for (const o of [...drawing.objects].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) {
    const holder = drawingHolder(o, { objects: drawing.objects });
    Object.assign(holder.style, { left: `${o.x}px`, top: `${o.y}px` });
    page.append(holder);
  }
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `A drawing of ${drawing.objects.length} object(s)`);
  box.append(page);
  return box;
}

const TONE_MARK = { note: 'i', warning: '!', idea: '*' };

export class NotesRenderer extends Renderer {
  /**
   * @param {HTMLElement} surface
   * @param {{resolveLink?: (title: string) => (string|null)}} options
   */
  constructor(surface, options = {}) {
    super(surface);
    this.resolveLink = options.resolveLink ?? (() => null);
    // A note shown inside another: its blocks, null while it loads, or 'missing'.
    this.embedContent = options.embedContent ?? (() => 'missing');
    this.depth = 0;
  }

  blockElement(block, model, images) {
    if (block.kind === 'embed') return this.embedElement(block, model, images);
    if (block.kind === 'code' && block.language === 'grt-drawing') return drawingElement(block);
    if (block.kind === 'raw') {
      const element = super.blockElement({ ...block, kind: 'code', style: 'code' }, model, images);
      element.classList.add('raw');
      element.title = 'Markdown kept as it was written';
      return element;
    }

    const element = block.kind === 'todo' ? this.todoElement(block, model)
      : block.kind === 'callout' ? this.calloutElement(block, model)
        : super.blockElement(block, model, images);

    // A Mermaid block shows its diagram under the source, out of the text's way.
    if (block.kind === 'code' && /^mermaid\b/i.test(block.language ?? '')) {
      const diagram = document.createElement('div');
      diagram.className = 'mermaid-diagram';
      diagram.setAttribute('contenteditable', 'false');
      diagram.innerHTML = mermaidSvg((block.runs ?? []).map((r) => r.text).join(''));
      element.append(diagram);
    }

    // Links are marked here, once, on whatever the renderer produced.
    if (block.kind !== 'code') {
      markLinks(element, this.resolveLink);
      markComments(element);
    }

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

    box.append(mark);
    // Obsidian's callouts have a type and a title, shown above the text.
    if (block.calloutType || block.title) {
      const heading = document.createElement('div');
      heading.className = 'callout-title';
      heading.setAttribute('contenteditable', 'false');
      const type = String(block.calloutType ?? block.tone ?? 'note');
      heading.textContent = block.title || type.charAt(0).toUpperCase() + type.slice(1);
      const body = document.createElement('div');
      body.className = 'callout-body';
      body.append(heading, text);
      box.append(body);
    } else {
      box.append(text);
    }
    return box;
  }

  /** A reference to another document in the suite. */
  embedElement(block, model, images) {
    const box = document.createElement('div');
    box.className = 'block embed';
    box.dataset.block = block.id;
    box.setAttribute('contenteditable', 'false');

    // A note shown inside this one, read only; a note shown inside that is only named, so nothing can go round in circles.
    const content = block.wiki && this.depth === 0 ? this.embedContent(block.target) : null;
    if (Array.isArray(content)) {
      box.classList.add('transclusion');
      const head = document.createElement('div');
      head.className = 'embed-head';
      head.textContent = block.target;
      head.dataset.action = 'open-embed';
      head.dataset.block = block.id;
      box.append(head);
      this.depth += 1;
      try {
        for (const inner of content.slice(0, 400)) {
          const element = this.blockElement(inner, model, images);
          element.removeAttribute('data-block');
          for (const node of element.querySelectorAll('[data-block]')) node.removeAttribute('data-block');
          box.append(element);
        }
      } finally {
        this.depth -= 1;
      }
      return box;
    }

    const label = document.createElement('span');
    label.className = 'embed-target';
    label.textContent = block.target ? (content === null && block.wiki ? `${block.target} (loading)` : content === 'missing' && block.wiki ? `${block.target} (no such note)` : block.target) : 'Nothing linked yet';

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

      const title = linkTarget(match[1]);
      const target = resolveLink(title);
      const link = document.createElement('span');
      link.className = target ? 'note-link' : 'note-link unresolved';
      link.dataset.action = 'open-link';
      link.dataset.title = title;
      link.textContent = piece;
      link.title = target ? title : `${title}: no note with this title yet`;
      fragment.append(link);
    }

    node.replaceWith(fragment);
  }
}

/** Obsidian's comments, `%%…%%`, shown faintly: they are in the file but not in the reading. */
function markComments(root) {
  const walker = document.createTreeWalker(root, 4 /** NodeFilter.SHOW_TEXT. */);
  const targets = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes('%%')) targets.push(walker.currentNode);
  }
  for (const node of targets) {
    const pieces = String(node.nodeValue).split(/(%%[^%]*%%)/g);
    if (pieces.length === 1) continue;
    const fragment = document.createDocumentFragment();
    for (const piece of pieces) {
      if (/^%%[^%]*%%$/.test(piece)) {
        const span = document.createElement('span');
        span.className = 'note-comment';
        span.textContent = piece;
        fragment.append(span);
      } else if (piece) {
        fragment.append(document.createTextNode(piece));
      }
    }
    node.replaceWith(fragment);
  }
}
