/** `[[note]]`. */

import { runsText } from './core/editor/model.js';

const LINK = /\[\[([^\]\n]+)\]\]/g;

/** Every `[[title]]` in a piece of text, in order, without duplicates. */
export function linksIn(text) {
  const found = [];
  const seen = new Set();
  for (const match of String(text ?? '').matchAll(LINK)) {
    const title = match[1].trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    found.push(title);
  }
  return found;
}

/** Every link in a whole note. */
export function linksInNote(note) {
  const pieces = [];
  for (const block of note.blocks ?? []) {
    if (block.kind === 'list') {
      for (const item of block.items ?? []) pieces.push(runsText(item.runs));
    } else {
      pieces.push(runsText(block.runs ?? []));
    }
  }
  return linksIn(pieces.join('\n'));
}

/** An index from title to path, for resolving links. */
export function buildTitleIndex(notes) {
  const byTitle = new Map();
  const ambiguous = new Set();

  for (const note of notes) {
    const key = String(note.title ?? '').trim().toLowerCase();
    if (!key) continue;
    if (byTitle.has(key)) ambiguous.add(key);
    else byTitle.set(key, note.path);
  }

  return { byTitle, ambiguous };
}

export function resolve(title, titleIndex) {
  const key = String(title ?? '').trim().toLowerCase();
  return titleIndex.byTitle.get(key) ?? null;
}

export function isAmbiguous(title, titleIndex) {
  return titleIndex.ambiguous.has(String(title ?? '').trim().toLowerCase());
}

/** Which notes point at this one. */
export function backlinksTo(path, notes, titleIndex) {
  const found = [];
  for (const note of notes) {
    if (note.path === path) continue;
    for (const title of note.links ?? []) {
      if (resolve(title, titleIndex) === path) {
        found.push({ path: note.path, title: note.title, via: title });
        break;
      }
    }
  }
  return found;
}

/** Completion for a half-typed `[[`. */
export function complete(prefix, titles, limit = 8) {
  const needle = String(prefix ?? '').trim().toLowerCase();
  if (!needle) return titles.slice(0, limit);

  const starts = [];
  const contains = [];
  for (const title of titles) {
    const lower = title.toLowerCase();
    if (lower.startsWith(needle)) starts.push(title);
    else if (lower.includes(needle)) contains.push(title);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** The `[[` currently being typed, if the caret is inside one. */
export function pendingLink(text, caret) {
  const before = String(text ?? '').slice(0, caret);
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const between = before.slice(open + 2);
  if (between.includes(']') || between.includes('\n')) return null;
  return { from: open, query: between };
}
