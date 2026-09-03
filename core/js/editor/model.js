/** The document, and the only thing that is true about it. */

import { makeId } from './ids.js';

export const FORMAT_VERSION = 1;

export const BLOCK_KINDS = ['paragraph', 'heading', 'list', 'image', 'code', 'quote'];

/** Adds block kinds belonging to one module. */
export function registerBlockKinds(...kinds) {
  for (const kind of kinds) {
    if (!BLOCK_KINDS.includes(kind)) BLOCK_KINDS.push(kind);
  }
  return BLOCK_KINDS;
}
export const LIST_TYPES = ['bullet', 'number'];
export const ALIGNMENTS = ['left', 'center', 'right', 'justify'];

/** Run attributes that are simply on or off. */
export const MARKS = ['bold', 'italic', 'underline', 'strike', 'sup', 'sub'];

export const DEFAULT_PAGE = {
  size: 'A4',
  orientation: 'portrait',
  margins: { top: 25, right: 25, bottom: 25, left: 25 },
};

/** Page sizes in millimetres. */
export const PAGE_SIZES = {
  A4: { w: 210, h: 297, label: 'A4' },
  A5: { w: 148, h: 210, label: 'A5' },
  Letter: { w: 216, h: 279, label: 'Letter' },
  Legal: { w: 216, h: 356, label: 'Legal' },
};

const DEFAULT_STYLES = {
  body: { font: 'serif', size: 11, lineHeight: 1.5, spaceBefore: 0, spaceAfter: 6 },
  h1: { font: 'sans', size: 20, bold: true, lineHeight: 1.25, spaceBefore: 16, spaceAfter: 8 },
  h2: { font: 'sans', size: 16, bold: true, lineHeight: 1.3, spaceBefore: 12, spaceAfter: 6 },
  h3: { font: 'sans', size: 13, bold: true, lineHeight: 1.35, spaceBefore: 10, spaceAfter: 4 },
  h4: { font: 'sans', size: 11.5, bold: true, lineHeight: 1.4, spaceBefore: 8, spaceAfter: 4 },
  quote: { font: 'serif', size: 11, italic: true, lineHeight: 1.5, indent: 20, spaceAfter: 8 },
  code: { font: 'mono', size: 10, lineHeight: 1.45, indent: 12, spaceAfter: 8 },
};

/**
 * Merges adjacent runs that carry identical formatting, and drops empty ones.
 * @param {{text: string}[]} runs
 * @returns {{text: string}[]}
 */
export function normaliseRuns(runs) {
  const out = [];

  for (const run of runs ?? []) {
    if (typeof run?.text !== 'string' || run.text === '') continue;

    const clean = { text: run.text };
    for (const mark of MARKS) if (run[mark]) clean[mark] = true;
    if (run.color) clean.color = run.color;
    if (run.highlight) clean.highlight = run.highlight;
    if (run.size) clean.size = run.size;

    const last = out[out.length - 1];
    if (last && sameFormatting(last, clean)) {
      last.text += clean.text;
    } else {
      out.push(clean);
    }
  }

  return out.length > 0 ? out : [{ text: '' }];
}

export function sameFormatting(a, b) {
  for (const mark of MARKS) {
    if (!!a[mark] !== !!b[mark]) return false;
  }
  return (a.color ?? null) === (b.color ?? null)
    && (a.highlight ?? null) === (b.highlight ?? null)
    && (a.size ?? null) === (b.size ?? null);
}

/** The plain text of a run list. */
export function runsText(runs) {
  return (runs ?? []).map((run) => run.text).join('');
}

/** How many characters a run list holds. */
export function runsLength(runs) {
  return (runs ?? []).reduce((total, run) => total + run.text.length, 0);
}

/**
 * Splits a run list at a character offset.
 * @returns {[{text: string}[], {text: string}[]]}
 */
export function splitRuns(runs, offset) {
  const before = [];
  const after = [];
  let seen = 0;

  for (const run of runs ?? []) {
    const start = seen;
    const end = seen + run.text.length;

    if (end <= offset) {
      before.push({ ...run });
    } else if (start >= offset) {
      after.push({ ...run });
    } else {
      const cut = offset - start;
      before.push({ ...run, text: run.text.slice(0, cut) });
      after.push({ ...run, text: run.text.slice(cut) });
    }
    seen = end;
  }

  return [normaliseRuns(before), normaliseRuns(after)];
}

/** The slice of a run list between two offsets, formatting preserved. */
export function sliceRuns(runs, from, to) {
  const [, rest] = splitRuns(runs, from);
  const [middle] = splitRuns(rest, to - from);
  return middle;
}

/** Applies or removes a mark across a range. */
export function formatRuns(runs, from, to, mark, value = null) {
  if (from === to) return normaliseRuns(runs);

  const [before, rest] = splitRuns(runs, from);
  const [middle, after] = splitRuns(rest, to - from);

  const isMark = MARKS.includes(mark);
  const decided = value !== null
    ? value
    : !middle.every((run) => (isMark ? !!run[mark] : run[mark] === value));

  const changed = middle.map((run) => {
    const copy = { ...run };
    if (isMark) {
      if (decided) copy[mark] = true;
      else delete copy[mark];
    } else if (decided === false || decided === null || decided === '') {
      delete copy[mark];
    } else {
      copy[mark] = decided;
    }
    return copy;
  });

  return normaliseRuns([...before, ...changed, ...after]);
}

export class DocumentModel {
  constructor(document = null) {
    this.page = structuredClone(DEFAULT_PAGE);
    this.styles = structuredClone(DEFAULT_STYLES);
    this.blocks = [];
    this.fonts = [];
    this.path = null;
    this.dirty = false;
    // What this document calls itself in the container.
    this.type = 'paper';

    if (document) this.load(document);
    if (this.blocks.length === 0) this.blocks.push(makeBlock('paragraph'));
  }

  // Reading

  block(id) {
    return this.blocks.find((b) => b.id === id) ?? null;
  }

  indexOf(id) {
    return this.blocks.findIndex((b) => b.id === id);
  }

  /** Runs of a block, or of one item of a list block. */
  runsOf(id, itemIndex = null) {
    const block = this.block(id);
    if (!block) return [];
    if (block.kind === 'list') {
      return block.items[itemIndex ?? 0]?.runs ?? [];
    }
    return block.runs ?? [];
  }

  setRuns(id, runs, itemIndex = null) {
    const block = this.block(id);
    if (!block) return;

    if (block.kind === 'list') {
      const item = block.items[itemIndex ?? 0];
      if (item) item.runs = normaliseRuns(runs);
    } else {
      block.runs = normaliseRuns(runs);
    }
    this.dirty = true;
  }

  /** The whole document as plain text, for the word count and text export. */
  text() {
    return this.blocks.map((block) => {
      if (block.kind === 'list') {
        return block.items.map((item) => runsText(item.runs)).join('\n');
      }
      if (block.kind === 'image') return '';
      return runsText(block.runs);
    }).join('\n');
  }

  /** Words and characters. */
  counts() {
    const text = this.text();
    const words = text.split(/\s+/).filter(Boolean).length;
    return {
      words,
      characters: text.length,
      charactersNoSpaces: text.replace(/\s/g, '').length,
      blocks: this.blocks.length,
    };
  }

  // Blocks

  insertBlock(block, atIndex = this.blocks.length) {
    const created = { ...makeBlock(block.kind ?? 'paragraph'), ...block };
    created.id ??= makeId('b');
    this.blocks.splice(Math.max(0, Math.min(atIndex, this.blocks.length)), 0, created);
    this.dirty = true;
    return created;
  }

  removeBlock(id) {
    // A document with no blocks has nowhere to put the cursor.
    if (this.blocks.length <= 1) return false;
    const index = this.indexOf(id);
    if (index === -1) return false;
    this.blocks.splice(index, 1);
    this.dirty = true;
    return true;
  }

  moveBlock(fromIndex, toIndex) {
    const [block] = this.blocks.splice(fromIndex, 1);
    if (!block) return;
    this.blocks.splice(Math.max(0, Math.min(toIndex, this.blocks.length)), 0, block);
    this.dirty = true;
  }

  /** Changes a block's kind and style together. */
  setBlockKind(id, kind, options = {}) {
    const block = this.block(id);
    if (!block || !BLOCK_KINDS.includes(kind)) return;

    const text = block.kind === 'list'
      ? block.items.map((item) => item.runs)
      : [block.runs ?? [{ text: '' }]];

    const rebuilt = makeBlock(kind, options);
    rebuilt.id = block.id;
    rebuilt.align = block.align;

    if (kind === 'list') {
      rebuilt.items = text.map((runs) => ({ level: 0, runs: normaliseRuns(runs) }));
    } else {
      // Collapsing a list into a paragraph joins its items rather than losing
      // all but the first.
      rebuilt.runs = normaliseRuns(text.flatMap((runs, i) =>
        (i === 0 ? runs : [{ text: ' ' }, ...runs])));
    }

    this.blocks[this.indexOf(id)] = rebuilt;
    this.dirty = true;
    return rebuilt;
  }

  setBlockStyle(id, style) {
    const block = this.block(id);
    if (!block || !this.styles[style]) return;
    block.style = style;
    this.dirty = true;
  }

  setAlign(id, align) {
    const block = this.block(id);
    if (!block || !ALIGNMENTS.includes(align)) return;
    block.align = align;
    this.dirty = true;
  }

  // Styles and page

  setStyle(name, patch) {
    if (!this.styles[name]) return;
    this.styles[name] = { ...this.styles[name], ...patch };
    this.dirty = true;
  }

  setPage(patch) {
    this.page = {
      ...this.page,
      ...patch,
      margins: { ...this.page.margins, ...(patch.margins ?? {}) },
    };
    this.dirty = true;
  }

  /** The text area of a page, in millimetres. */
  pageBox() {
    const size = PAGE_SIZES[this.page.size] ?? PAGE_SIZES.A4;
    const portrait = this.page.orientation !== 'landscape';
    const w = portrait ? size.w : size.h;
    const h = portrait ? size.h : size.w;
    const m = this.page.margins;

    return {
      width: w,
      height: h,
      contentWidth: w - m.left - m.right,
      contentHeight: h - m.top - m.bottom,
    };
  }

  addFont(name, resource) {
    const id = `custom-${this.fonts.length + 1}`;
    this.fonts.push({ id, name, resource });
    this.dirty = true;
    return id;
  }

  usedResources() {
    const used = new Set();
    for (const font of this.fonts) if (font.resource) used.add(font.resource);
    for (const block of this.blocks) {
      if (block.kind === 'image' && block.resource) used.add(block.resource);
    }
    return [...used];
  }

  // Whole document

  toJSON() {
    return {
      version: FORMAT_VERSION,
      type: this.type,
      page: structuredClone(this.page),
      styles: structuredClone(this.styles),
      fonts: structuredClone(this.fonts),
      blocks: structuredClone(this.blocks),
    };
  }

  load(document) {
    if (!document || typeof document !== 'object') {
      throw new Error('Not a document');
    }

    this.page = {
      ...structuredClone(DEFAULT_PAGE),
      ...(document.page ?? {}),
      margins: { ...DEFAULT_PAGE.margins, ...(document.page?.margins ?? {}) },
    };
    this.styles = { ...structuredClone(DEFAULT_STYLES), ...(document.styles ?? {}) };
    this.fonts = Array.isArray(document.fonts) ? structuredClone(document.fonts) : [];
    this.blocks = Array.isArray(document.blocks) ? structuredClone(document.blocks) : [];

    // Missing fields are filled in rather than rejected.
    for (const block of this.blocks) {
      block.id ??= makeId('b');
      block.kind ??= 'paragraph';
      block.style ??= defaultStyleFor(block);
      block.align ??= 'left';

      if (block.kind === 'list') {
        block.listType ??= 'bullet';
        block.items = (block.items ?? []).map((item) => ({
          level: Math.max(0, Math.min(item.level ?? 0, 5)),
          runs: normaliseRuns(item.runs),
        }));
        if (block.items.length === 0) block.items = [{ level: 0, runs: [{ text: '' }] }];
      } else if (block.kind === 'image') {
        block.w ??= 400;
        block.h ??= 260;
        block.caption = normaliseRuns(block.caption ?? []);
      } else {
        block.runs = normaliseRuns(block.runs);
        if (block.kind === 'heading') block.level ??= 1;
      }
    }

    this.dirty = false;
  }

  // Undo

  snapshot() {
    return {
      page: structuredClone(this.page),
      styles: structuredClone(this.styles),
      fonts: structuredClone(this.fonts),
      blocks: structuredClone(this.blocks),
      dirty: this.dirty,
    };
  }

  restore(snapshot) {
    this.page = structuredClone(snapshot.page);
    this.styles = structuredClone(snapshot.styles);
    this.fonts = structuredClone(snapshot.fonts ?? []);
    this.blocks = structuredClone(snapshot.blocks);
    this.dirty = snapshot.dirty;
  }
}

/** The name GRT Paper knew this class by. */
export { DocumentModel as PaperModel };

/** A new block of a kind, with the fields that kind needs. */
export function makeBlock(kind = 'paragraph', options = {}) {
  const block = {
    id: makeId('b'),
    kind,
    style: options.style ?? defaultStyleFor({ kind, level: options.level }),
    align: 'left',
  };

  if (kind === 'list') {
    block.listType = LIST_TYPES.includes(options.listType) ? options.listType : 'bullet';
    block.items = [{ level: 0, runs: [{ text: '' }] }];
  } else if (kind === 'image') {
    block.resource = options.resource ?? null;
    block.w = options.w ?? 400;
    block.h = options.h ?? 260;
    block.align = 'center';
    block.caption = [];
  } else {
    block.runs = [{ text: '' }];
    if (kind === 'heading') block.level = Math.max(1, Math.min(options.level ?? 1, 4));
  }

  // Fields belonging to a kind the core does not know about.
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (key !== 'id' && key !== 'kind') block[key] = value;
  }

  return block;
}

function defaultStyleFor(block) {
  if (block.kind === 'heading') return `h${Math.max(1, Math.min(block.level ?? 1, 4))}`;
  if (block.kind === 'quote') return 'quote';
  if (block.kind === 'code') return 'code';
  return 'body';
}
