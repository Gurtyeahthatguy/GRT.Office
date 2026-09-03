/** A note is a document with a title and tags. */

import {
  DocumentModel, makeBlock, registerBlockKinds, runsText,
} from './core/editor/model.js';

/** The kinds this module adds to the shared engine. */
export const NOTE_BLOCK_KINDS = ['todo', 'callout', 'embed'];
registerBlockKinds(...NOTE_BLOCK_KINDS);

/**
 * Callout tones. Deliberately few: a palette of twelve is a decoration set.
 */
export const CALLOUT_TONES = ['note', 'warning', 'idea'];

export class NoteDocument extends DocumentModel {
  constructor(document = null) {
    super(document);
    this.type = 'notes';
    if (!document) {
      this.title = '';
      this.tags = [];
    }
  }

  load(document) {
    super.load(document);
    this.title = typeof document?.title === 'string' ? document.title : '';
    this.tags = normaliseTags(document?.tags);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      title: this.title,
      tags: [...this.tags],
      // A note has no page.
      page: null,
    };
  }

  snapshot() {
    return { ...super.snapshot(), title: this.title, tags: [...this.tags] };
  }

  restore(state) {
    super.restore(state);
    this.title = state.title ?? '';
    this.tags = [...(state.tags ?? [])];
  }

  setTitle(title) {
    const next = String(title ?? '');
    if (next === this.title) return false;
    this.title = next;
    this.dirty = true;
    return true;
  }

  setTags(tags) {
    this.tags = normaliseTags(tags);
    this.dirty = true;
    return this.tags;
  }

  /** The note as searchable text. */
  plainText() {
    const pieces = [];
    for (const block of this.blocks) {
      if (block.kind === 'list') {
        for (const item of block.items ?? []) pieces.push(runsText(item.runs));
      } else if (block.kind === 'image') {
        if (block.caption?.length) pieces.push(runsText(block.caption));
      } else if (block.kind === 'embed') {
        if (block.target) pieces.push(String(block.target));
      } else {
        pieces.push(runsText(block.runs ?? []));
      }
    }
    return pieces.filter(Boolean).join('\n');
  }
}

/**
 * Tags, cleaned. Lower-cased and de-duplicated, because "Kant" and "kant"
 * being two different tags is a filing system that punishes typing quickly.
 */
export function normaliseTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const cleaned = String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/** Reads a tag line the way a person types it: commas, spaces, or hashes. */
export function parseTagInput(text) {
  return normaliseTags(String(text ?? '').split(/[,\s]+/).map((t) => t.replace(/^#/, '')));
}

// The blocks a note adds

export function makeTodo(done = false) {
  return makeBlock('todo', { extra: { done: Boolean(done) } });
}

export function makeCallout(tone = 'note') {
  return makeBlock('callout', {
    extra: { tone: CALLOUT_TONES.includes(tone) ? tone : 'note' },
  });
}

export function makeEmbed(target = '') {
  return makeBlock('embed', { extra: { target: String(target) } });
}

/** The container parts for a note. */
export function toParts(note) {
  return { 'content/main.json': `${JSON.stringify(note.toJSON(), null, 2)}\n` };
}

export function fromParts(parts) {
  const raw = parts?.['content/main.json'];
  if (!raw) throw new Error('That file has no note in it');
  return new NoteDocument(JSON.parse(raw));
}
