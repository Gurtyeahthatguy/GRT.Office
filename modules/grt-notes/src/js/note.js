/** A note is a document with a title and tags. */

import {
  DocumentModel, makeBlock, registerBlockKinds, runsText,
} from './core/editor/model.js';
import { readObsidianNote, writeObsidianNote, settleSignatures } from './core/formats/obsidian.js';

/** The kinds this module adds to the shared engine; raw is Markdown kept as it was written. */
export const NOTE_BLOCK_KINDS = ['todo', 'callout', 'embed', 'raw'];
registerBlockKinds(...NOTE_BLOCK_KINDS);

/** Callout tones. */
export const CALLOUT_TONES = ['note', 'warning', 'idea'];

export class NoteDocument extends DocumentModel {
  constructor(document = null) {
    super(document);
    this.type = 'notes';
    if (!document) {
      this.title = '';
      this.tags = [];
      this.properties = [];
      this.markdown = null;
    }
  }

  load(document) {
    super.load(document);
    this.title = typeof document?.title === 'string' ? document.title : '';
    this.tags = normaliseTags(document?.tags);
    this.properties = Array.isArray(document?.properties) ? structuredClone(document.properties) : [];
    this.markdown = document?.markdown ?? null;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      title: this.title,
      tags: [...this.tags],
      ...(this.properties.length > 0 ? { properties: structuredClone(this.properties) } : {}),
      // A note has no page.
      page: null,
    };
  }

  snapshot() {
    return { ...super.snapshot(), title: this.title, tags: [...this.tags], properties: structuredClone(this.properties) };
  }

  restore(state) {
    super.restore(state);
    this.title = state.title ?? '';
    this.tags = [...(state.tags ?? [])];
    this.properties = structuredClone(state.properties ?? []);
  }

  setProperties(properties) {
    this.properties = structuredClone(properties);
    this.dirty = true;
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
    if (this.markdown) {
      const existing = this.properties.find((p) => p.key === 'tags');
      if (existing) existing.value = [...this.tags];
      else if (this.tags.length > 0) this.properties.push({ key: 'tags', type: 'list', value: [...this.tags] });
    }
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
      } else if (block.kind === 'raw') {
        pieces.push(runsText(block.runs ?? []));
      } else if (block.kind === 'embed') {
        if (block.target) pieces.push(String(block.target));
      } else {
        pieces.push(runsText(block.runs ?? []));
      }
    }
    return pieces.filter(Boolean).join('\n');
  }
}

/** Tags, lower-cased and de-duplicated. */
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

/** A note from an Obsidian Markdown file, its title the file's name. */
export function fromMarkdown(text, title) {
  const read = readObsidianNote(text);
  const tagProperty = read.properties.find((p) => p.key === 'tags' || p.key === 'tag');
  const tags = tagProperty ? [].concat(tagProperty.value ?? []).map(String) : [];
  const note = new NoteDocument({ blocks: read.blocks, properties: read.properties, markdown: read.markdown, title, tags });
  settleSignatures(note.blocks);
  note.dirty = false;
  return note;
}

export function toMarkdown(note) {
  return writeObsidianNote({ blocks: note.blocks, properties: note.properties, markdown: note.markdown });
}

export function fromParts(parts) {
  const raw = parts?.['content/main.json'];
  if (!raw) throw new Error('That file has no note in it');
  return new NoteDocument(JSON.parse(raw));
}
