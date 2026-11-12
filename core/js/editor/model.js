/** The document, and the only thing that is true about it. */

import { makeId } from './ids.js';
import { normaliseChartData } from '../formats/chart-object.js';
import { CHART_TYPES as CHART_KINDS } from '../charts.js';

export const FORMAT_VERSION = 1;

export const BLOCK_KINDS = ['paragraph', 'heading', 'list', 'image', 'code', 'quote', 'table', 'toc', 'index', 'chart', 'section'];

/** Blocks drawn from something else, such as a picture or the headings, with no text of their own to type in. */
export const isSolid = (block) => ['image', 'toc', 'index', 'chart', 'section'].includes(block?.kind);

/** The most rows and columns a table may have, so a file cannot ask for millions. */
export const TABLE_LIMITS = { rows: 2000, cols: 64 };

/** The containers of text a block holds besides its own runs: list items, or a table's cells row by row. */
export function itemsOf(block) {
  if (block?.kind === 'list') return block.items;
  if (block?.kind === 'table') return block.rows.flatMap((row) => row.cells);
  return null;
}

/** The items the cursor can go into: every list item, every table cell not covered by a merged one. */
export function itemIndices(block) {
  const items = itemsOf(block);
  if (!items) return [null];
  return items.map((item, i) => (item.covered ? null : i)).filter((i) => i !== null);
}

/** A table's cell at a row and column, and its flat index. */
export function cellAt(block, row, col) {
  const cols = block.rows[0]?.cells.length ?? 0;
  return { cell: block.rows[row]?.cells[col] ?? null, index: row * cols + col };
}

/** A table cleaned up: every row as wide as the widest, spans inside the table, the cells they cover marked. */
export function normaliseTable(block) {
  const rows = (Array.isArray(block.rows) ? block.rows : []).slice(0, TABLE_LIMITS.rows);
  const width = Math.max(1, Math.min(TABLE_LIMITS.cols, Math.max(0, ...rows.map((r) => r?.cells?.length ?? 0))));
  block.rows = (rows.length ? rows : [{ cells: [] }]).map((row) => ({
    ...(row?.header ? { header: true } : {}),
    cells: Array.from({ length: width }, (_, c) => {
      const cell = row?.cells?.[c] ?? {};
      const out = { runs: normaliseRuns(cell.runs) };
      for (const key of ['bg', 'align', 'valign']) if (typeof cell[key] === 'string') out[key] = cell[key];
      if (cell.colspan > 1) out.colspan = Math.floor(cell.colspan);
      if (cell.rowspan > 1) out.rowspan = Math.floor(cell.rowspan);
      return out;
    }),
  }));
  for (const [r, row] of block.rows.entries()) {
    for (const [c, cell] of row.cells.entries()) {
      if (cell.covered) continue;
      const rowspan = Math.min(cell.rowspan ?? 1, block.rows.length - r);
      const colspan = Math.min(cell.colspan ?? 1, width - c);
      if (rowspan > 1) cell.rowspan = rowspan; else delete cell.rowspan;
      if (colspan > 1) cell.colspan = colspan; else delete cell.colspan;
      for (let dr = 0; dr < rowspan; dr += 1) {
        for (let dc = 0; dc < colspan; dc += 1) {
          if (dr || dc) Object.assign(block.rows[r + dr].cells[c + dc], { covered: true, runs: [{ text: '' }] });
        }
      }
    }
  }
  const widths = Array.isArray(block.widths) ? block.widths.slice(0, width).map((w) => (Number(w) > 0 ? Number(w) : 1)) : [];
  block.widths = widths.length === width ? widths : Array(width).fill(1);
  block.borders ??= 'all';
  return block;
}

/** Adds block kinds belonging to one module. */
export function registerBlockKinds(...kinds) {
  for (const kind of kinds) {
    if (!BLOCK_KINDS.includes(kind)) BLOCK_KINDS.push(kind);
  }
  return BLOCK_KINDS;
}
export const LIST_TYPES = ['bullet', 'number'];
/** How a numbered list counts, and what a bulleted one shows. */
export const NUMBER_FORMATS = ['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'];
export const BULLETS = ['•', '◦', '▪', '–', '✓', '➢'];

/** The fields a style may set, paragraph or character, and their kinds. */
const STYLE_FIELDS = {
  font: 'string', size: 'number', lineHeight: 'number', bold: 'boolean', italic: 'boolean', underline: 'boolean', strike: 'boolean',
  color: 'color', highlight: 'color', spaceBefore: 'number', spaceAfter: 'number', indent: 'number', firstLine: 'number', name: 'string',
  rule: 'boolean',
};

/** A style as stored: only the fields styles have, of the right kinds, within sane bounds. */
export function normaliseStyle(style) {
  const out = {};
  for (const [field, kind] of Object.entries(STYLE_FIELDS)) {
    const value = style?.[field];
    if (value === undefined || value === null) continue;
    if (kind === 'number' && Number.isFinite(Number(value))) out[field] = Math.max(-200, Math.min(400, Number(value)));
    else if (kind === 'boolean') out[field] = !!value;
    else if (kind === 'color' && /^#[0-9a-f]{6}$/i.test(value)) out[field] = value.toLowerCase();
    else if (kind === 'string' && typeof value === 'string') out[field] = value.slice(0, 100);
  }
  return out;
}

/** A paragraph's own spacing, over its style's: line height as a multiple, the rest in points. */
const PARA_LIMITS = { lineHeight: [0.5, 4], spaceBefore: [0, 200], spaceAfter: [0, 200], indent: [0, 400] };

/** A paragraph's own spacing as stored, or null when it sets nothing. */
export function normalisePara(para) {
  const out = {};
  for (const [field, [low, high]] of Object.entries(PARA_LIMITS)) {
    const value = Number(para?.[field]);
    if (para?.[field] !== undefined && para?.[field] !== null && Number.isFinite(value)) out[field] = Math.round(Math.max(low, Math.min(high, value)) * 100) / 100;
  }
  return Object.keys(out).length ? out : null;
}

/** How headings are numbered, or null when they are not: one format for every level, down to `depth`. */
export function normaliseHeadingNumbers(numbers) {
  if (!numbers || !NUMBER_FORMATS.includes(numbers.format)) return null;
  return {
    format: numbers.format,
    full: numbers.full !== false,
    after: typeof numbers.after === 'string' ? numbers.after.slice(0, 5) : '',
    depth: Math.max(1, Math.min(4, Math.round(Number(numbers.depth) || 4))),
  };
}

/** How footnotes and endnotes are counted: their format and first number. */
export const NOTE_DEFAULTS = { foot: { format: 'decimal', start: 1 }, end: { format: 'lower-roman', start: 1 } };

export function normaliseNoteSettings(settings) {
  const one = (kind) => {
    const given = settings?.[kind] ?? {};
    return {
      format: NUMBER_FORMATS.includes(given.format) ? given.format : NOTE_DEFAULTS[kind].format,
      start: Math.max(1, Math.min(9999, Math.round(Number(given.start) || 1))),
    };
  };
  return { foot: one('foot'), end: one('end') };
}

/** A key for a style of the person's own, from its name. */
export const styleKey = (name, prefix = 'c') => `${prefix}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'style'}`;
export const ALIGNMENTS = ['left', 'center', 'right', 'justify'];

/** Run attributes that are simply on or off. */
export const MARKS = ['bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'double', 'overline', 'shadow', 'outline', 'smallcaps'];

/** Headers and footers: a slot is one line, `{page}` and `{pages}` filled in when drawn. */
export const SLOT_ALIGNMENTS = ['left', 'center', 'right'];

export const DEFAULT_RUNNING = {
  firstDifferent: false,
  evenDifferent: false,
  header: { default: null, first: null, even: null },
  footer: { default: null, first: null, even: null },
};

export const DEFAULT_PAGE = {
  size: 'A4',
  orientation: 'portrait',
  margins: { top: 25, right: 25, bottom: 25, left: 25 },
  running: DEFAULT_RUNNING,
};

/** A slot as stored, or null when it says nothing. */
export function normaliseSlot(slot) {
  if (!slot || typeof slot.text !== 'string' || slot.text === '') return null;
  return { text: slot.text, align: SLOT_ALIGNMENTS.includes(slot.align) ? slot.align : 'center' };
}

export function normaliseRunning(running) {
  const out = structuredClone(DEFAULT_RUNNING);
  out.firstDifferent = !!running?.firstDifferent;
  out.evenDifferent = !!running?.evenDifferent;
  for (const part of ['header', 'footer']) {
    for (const which of ['default', 'first', 'even']) {
      out[part][which] = normaliseSlot(running?.[part]?.[which]);
    }
  }
  return out;
}

/** The slot drawn on page `number` (from 1), with its fields filled in; null when empty. */
export function slotFor(running, part, number, total) {
  const slots = running?.[part];
  if (!slots) return null;
  let slot = slots.default;
  if (running.firstDifferent && number === 1) slot = slots.first;
  else if (running.evenDifferent && number % 2 === 0) slot = slots.even;
  if (!slot) return null;
  return {
    align: slot.align,
    text: slot.text.replaceAll('{pages}', String(total)).replaceAll('{page}', String(number)),
  };
}

/** Page sizes in millimetres, portrait. */
export const PAGE_SIZES = {
  A3: { w: 297, h: 420, label: 'A3' },
  A4: { w: 210, h: 297, label: 'A4' },
  A5: { w: 148, h: 210, label: 'A5' },
  A6: { w: 105, h: 148, label: 'A6' },
  B5: { w: 176, h: 250, label: 'B5' },
  Letter: { w: 216, h: 279, label: 'Letter' },
  Legal: { w: 216, h: 356, label: 'Legal' },
  Executive: { w: 184, h: 267, label: 'Executive' },
  Tabloid: { w: 279, h: 432, label: 'Tabloid' },
};

const CUSTOM_LIMITS = { min: 25, max: 1200 };

/** A page's size, portrait, in millimetres: a named one, or its own width and height. */
export function pageDimensions(page) {
  if (page?.size === 'custom' && page.width > 0 && page.height > 0) {
    return { w: Math.min(page.width, page.height), h: Math.max(page.width, page.height) };
  }
  return PAGE_SIZES[page?.size] ?? PAGE_SIZES.A4;
}

/** The fields for a size read from a file: a named size that fits, or a custom one. */
export function pageSizeFields(width, height) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  for (const [id, size] of Object.entries(PAGE_SIZES)) {
    if (Math.abs(size.w - short) <= 2 && Math.abs(size.h - long) <= 2) return { size: id };
  }
  const clamp = (mm) => Math.round(Math.max(CUSTOM_LIMITS.min, Math.min(CUSTOM_LIMITS.max, mm)) * 10) / 10;
  return { size: 'custom', width: clamp(short), height: clamp(long) };
}

const DEFAULT_STYLES = {
  body: { font: 'serif', size: 11, lineHeight: 1.5, spaceBefore: 0, spaceAfter: 6 },
  h1: { font: 'sans', size: 20, bold: true, lineHeight: 1.25, spaceBefore: 16, spaceAfter: 8 },
  h2: { font: 'sans', size: 16, bold: true, lineHeight: 1.3, spaceBefore: 12, spaceAfter: 6 },
  h3: { font: 'sans', size: 13, bold: true, lineHeight: 1.35, spaceBefore: 10, spaceAfter: 4 },
  h4: { font: 'sans', size: 11.5, bold: true, lineHeight: 1.4, spaceBefore: 8, spaceAfter: 4 },
  quote: { font: 'serif', size: 11, italic: true, lineHeight: 1.5, indent: 20, spaceAfter: 8 },
  code: { font: 'mono', size: 10, lineHeight: 1.45, indent: 12, spaceAfter: 8 },
  caption: { font: 'serif', size: 10, italic: true, lineHeight: 1.4, spaceBefore: 2, spaceAfter: 8 },
  title: { font: 'sans', size: 28, bold: true, lineHeight: 1.2, spaceBefore: 12, spaceAfter: 6 },
  subtitle: { font: 'sans', size: 18, lineHeight: 1.25, spaceBefore: 3, spaceAfter: 6 },
  // LibreOffice's Horizontal Line: a small empty paragraph ruled underneath.
  hr: { font: 'serif', size: 6, lineHeight: 1.15, spaceBefore: 0, spaceAfter: 14, rule: true },
};

/** The character an object in the text stands on: a note, a bookmark, a reference, a field. */
export const OBJECT = '\uFFFC';

export const OBJECT_TYPES = ['note', 'bookmark', 'ref', 'seq', 'field', 'index', 'math', 'comment', 'cite', 'merge'];

/** The kinds of source a citation names, as Writer's bibliography has them. */
export const CITE_KINDS = ['book', 'article', 'website', 'thesis', 'report', 'misc'];
export const CITE_FIELDS = ['author', 'title', 'year', 'publisher', 'url'];
export const FIELDS = ['page', 'pages', 'date', 'time', 'chapter'];

const word = (value, limit = 200) => (typeof value === 'string' ? value.slice(0, limit) : null);

/** An object as stored, or null when it is not one Paper knows. */
export function normaliseObject(object) {
  switch (object?.type) {
    case 'note': {
      // A note's text has no objects of its own, so notes never nest.
      const runs = normaliseRuns((object.runs ?? []).filter((run) => !run.object)).map((run) => ({ ...run, text: run.text.replaceAll(OBJECT, '') }));
      // A note may show a character of its own choosing instead of a number.
      const mark = typeof object.mark === 'string' ? [...object.mark.replaceAll(OBJECT, '').trim()].slice(0, 4).join('') : '';
      return { type: 'note', kind: object.kind === 'end' ? 'end' : 'foot', runs: normaliseRuns(runs), ...(mark ? { mark } : {}) };
    }
    case 'bookmark': return word(object.name) ? { type: 'bookmark', name: word(object.name) } : null;
    case 'ref': {
      if (!word(object.target)) return null;
      let show = ['text', 'number', 'page'].includes(object.show) ? object.show : 'number';
      // A heading is referred to by its words or its page; its number is its words.
      if (object.target.startsWith('heading:') && show === 'number') show = 'text';
      return { type: 'ref', target: word(object.target), show };
    }
    case 'seq': return { type: 'seq', name: word(object.name, 60) || 'Figure', id: word(object.id, 60) || `seq${Math.random().toString(36).slice(2, 10)}` };
    case 'field': return FIELDS.includes(object.field) ? { type: 'field', field: object.field } : null;
    case 'math': {
      // A formula keeps its TeX when it has one, and the MathML the files carry.
      const tex = typeof object.tex === 'string' && object.tex.trim() ? object.tex.slice(0, 5000) : null;
      const mathml = typeof object.mathml === 'string' && /^\s*<math[\s>]/.test(object.mathml) ? object.mathml.slice(0, 100000) : null;
      if (!tex && !mathml) return null;
      return { type: 'math', ...(tex ? { tex } : {}), ...(mathml ? { mathml } : {}), ...(object.display ? { display: true } : {}) };
    }
    case 'index': return word(object.term) ? { type: 'index', term: word(object.term), ...(word(object.sub) ? { sub: word(object.sub) } : {}) } : null;
    case 'comment': return normaliseComment(object);
    case 'cite': return normaliseCite(object);
    // A mail merge field: the column of the data whose value takes its place, record by record.
    case 'merge': return word(object.name, 100)?.trim() ? { type: 'merge', name: word(object.name, 100).trim() } : null;
    default: return null;
  }
}

/** A link is kept when it goes to a place in the document, or to a web or mail address. */
const safeLink = (href) => (typeof href === 'string' && /^(#[^\s]{1,200}|https?:\/\/[^\s]{1,2000}|mailto:[^\s]{1,500})$/i.test(href) ? href : null);

/**
 * Merges adjacent runs that carry identical formatting, and drops empty ones.
 * @param {{text: string}[]} runs
 * @returns {{text: string}[]}
 */
export function normaliseRuns(runs) {
  const out = [];

  for (const run of runs ?? []) {
    if (typeof run?.text !== 'string' || run.text === '') continue;

    // An object is one character of its own; the character alone, without its object, means nothing.
    const object = run.object ? normaliseObject(run.object) : null;
    const text = object ? OBJECT : run.text.replaceAll(OBJECT, '');
    if (text === '') continue;

    const clean = { text };
    for (const mark of MARKS) if (run[mark]) clean[mark] = true;
    if (typeof run.cstyle === 'string' && run.cstyle) clean.cstyle = run.cstyle.slice(0, 60);
    if (run.color) clean.color = run.color;
    if (run.highlight) clean.highlight = run.highlight;
    if (run.size) clean.size = run.size;
    const lang = cleanLang(run.lang);
    if (lang) clean.lang = lang;
    const link = safeLink(run.link);
    if (link) clean.link = link;
    // Tracked changes: text put in or taken out, with the id of its change and a note on it; and the comment a stretch belongs to.
    const inserted = changeId(run.ins);
    const deleted = changeId(run.del);
    if (inserted) clean.ins = inserted;
    if (deleted) clean.del = deleted;
    if ((inserted || deleted) && typeof run.chgnote === 'string' && run.chgnote.trim()) clean.chgnote = run.chgnote.slice(0, 10_000);
    const comment = changeId(run.cmt);
    if (comment && comment !== true) clean.cmt = comment;
    // A stretch marked to be covered in a redacted copy.
    if (run.redact) clean.redact = true;
    if (object) {
      clean.object = object;
      out.push(clean);
      continue;
    }

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
  if (a.object || b.object) return false;
  for (const mark of MARKS) {
    if (!!a[mark] !== !!b[mark]) return false;
  }
  return (a.color ?? null) === (b.color ?? null)
    && (a.link ?? null) === (b.link ?? null)
    && (a.cstyle ?? null) === (b.cstyle ?? null)
    && (a.highlight ?? null) === (b.highlight ?? null)
    && (a.size ?? null) === (b.size ?? null)
    && (a.lang ?? null) === (b.lang ?? null)
    && (a.ins ?? null) === (b.ins ?? null)
    && (a.del ?? null) === (b.del ?? null)
    && (a.chgnote ?? null) === (b.chgnote ?? null)
    && (a.cmt ?? null) === (b.cmt ?? null)
    && !!a.redact === !!b.redact;
}

/** A change's or a comment's id as runs carry it: a short word, or true for a change without one. */
function changeId(value) {
  if (value === true) return true;
  return typeof value === 'string' && /^[\w.-]{1,40}$/.test(value) ? value : null;
}

/** A citation: the short name it shows, the kind of source, and what is known of it. */
function normaliseCite(object) {
  const key = typeof object.key === 'string' ? object.key.trim().replace(/[^\p{L}\p{N}_.:-]/gu, '').slice(0, 60) : '';
  if (!key) return null;
  const out = { type: 'cite', key, kind: CITE_KINDS.includes(object.kind) ? object.kind : 'book' };
  for (const field of CITE_FIELDS) {
    if (typeof object[field] === 'string' && object[field].trim()) out[field] = object[field].replaceAll(OBJECT, '').trim().slice(0, 500);
  }
  return out;
}

/** A comment's text and its replies, each with whether it is resolved; no names or dates. */
function normaliseComment(object) {
  const id = changeId(object.id);
  if (!id || id === true) return null;
  const text = (value) => (typeof value === 'string' ? value.replaceAll(OBJECT, '').slice(0, 100_000) : '');
  const replies = (Array.isArray(object.replies) ? object.replies : []).slice(0, 200)
    .map((reply, i) => ({ id: changeId(reply?.id) && reply.id !== true ? reply.id : `${id}-r${i + 1}`, text: text(reply?.text), ...(reply?.done ? { done: true } : {}) }))
    .filter((reply) => reply.text.trim() !== '');
  return { type: 'comment', id, text: text(object.text), ...(object.done ? { done: true } : {}), ...(replies.length ? { replies } : {}) };
}

/** A text's language as runs keep it: a tag such as it-IT or en, or zxx for text that is not checked. */
export function cleanLang(value) {
  if (typeof value !== 'string') return null;
  const match = /^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{2}|\d{3}))?$/.exec(value.trim());
  if (!match) return null;
  const language = match[1].toLowerCase();
  if (language === 'zxx') return 'zxx';
  return match[2] ? `${language}-${match[2].toUpperCase()}` : language;
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
    this.styles = Object.fromEntries(Object.entries(DEFAULT_STYLES).map(([key, style]) => [key, normaliseStyle(style)]));
    this.charStyles = {};
    this.blocks = [];
    this.fonts = [];
    this.review = normaliseReview(null);
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

  /** Runs of a block, or of one item of a list or cell of a table. */
  runsOf(id, itemIndex = null) {
    const block = this.block(id);
    if (!block) return [];
    const items = itemsOf(block);
    if (items) return items[itemIndex ?? itemIndices(block)[0] ?? 0]?.runs ?? [];
    return block.runs ?? [];
  }

  setRuns(id, runs, itemIndex = null) {
    const block = this.block(id);
    if (!block) return;

    const items = itemsOf(block);
    if (items) {
      const item = items[itemIndex ?? itemIndices(block)[0] ?? 0];
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
      if (block.kind === 'table') return block.rows.map((row) => row.cells.map((cell) => runsText(cell.runs)).join('\t')).join('\n');
      if (isSolid(block)) return '';
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
    if (block.para) rebuilt.para = { ...block.para };

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

  /** Sets or, with null, takes away a paragraph's own line height, spacing or indent. */
  setPara(id, patch) {
    const block = this.block(id);
    if (!block || !('runs' in block || block.kind === 'list')) return;
    const merged = { ...(block.para ?? {}) };
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete merged[field];
      else merged[field] = value;
    }
    const para = normalisePara(merged);
    if (para) block.para = para;
    else delete block.para;
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
    this.styles[name] = normaliseStyle({ ...this.styles[name], ...patch });
    this.dirty = true;
  }

  /** A paragraph style of the person's own, taken from another, under a name of its own. */
  addStyle(name, from = 'body') {
    let key = styleKey(name);
    for (let n = 2; this.styles[key]; n += 1) key = `${styleKey(name)}-${n}`;
    this.styles[key] = normaliseStyle({ ...(this.styles[from] ?? {}), name });
    this.dirty = true;
    return key;
  }

  /** A character style: a look a run takes by name. */
  addCharStyle(name, look = {}) {
    let key = styleKey(name, 'k');
    for (let n = 2; this.charStyles[key]; n += 1) key = `${styleKey(name, 'k')}-${n}`;
    this.charStyles[key] = normaliseStyle({ ...look, name });
    this.dirty = true;
    return key;
  }

  removeStyle(key) {
    if (!key.startsWith('c-') || !this.styles[key]) return;
    delete this.styles[key];
    for (const block of this.blocks) if (block.style === key) block.style = 'body';
    this.dirty = true;
  }

  setPage(patch) {
    this.page = {
      ...this.page,
      ...patch,
      margins: { ...this.page.margins, ...(patch.margins ?? {}) },
      running: normaliseRunning(patch.running ?? this.page.running),
    };
    this.dirty = true;
  }

  /** The text area of a page, in millimetres. */
  pageBox() {
    const size = pageDimensions(this.page);
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
      charStyles: structuredClone(this.charStyles ?? {}),
      fonts: structuredClone(this.fonts),
      blocks: structuredClone(this.blocks),
      ...(this.headingNumbers ? { headingNumbers: { ...this.headingNumbers } } : {}),
      ...(JSON.stringify(this.noteSettings) !== JSON.stringify(NOTE_DEFAULTS) ? { noteSettings: structuredClone(this.noteSettings) } : {}),
      ...(this.review?.recording || this.review?.protect ? { review: { ...this.review } } : {}),
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
      running: normaliseRunning(document.page?.running),
    };
    this.styles = Object.fromEntries(Object.entries(DEFAULT_STYLES).map(([key, style]) => [key, normaliseStyle(style)]));
    for (const [key, style] of Object.entries(document.styles ?? {}).slice(0, 500)) this.styles[key] = normaliseStyle({ ...(this.styles[key] ?? {}), ...style });
    this.charStyles = {};
    for (const [key, style] of Object.entries(document.charStyles ?? {}).slice(0, 500)) this.charStyles[key] = normaliseStyle(style);
    this.fonts = Array.isArray(document.fonts) ? structuredClone(document.fonts) : [];
    this.blocks = Array.isArray(document.blocks) ? structuredClone(document.blocks) : [];
    this.headingNumbers = normaliseHeadingNumbers(document.headingNumbers);
    this.noteSettings = normaliseNoteSettings(document.noteSettings);
    this.review = normaliseReview(document.review);

    // Missing fields are filled in rather than rejected.
    for (const block of this.blocks) {
      block.id ??= makeId('b');
      block.kind ??= 'paragraph';
      block.style ??= defaultStyleFor(block);
      block.align ??= 'left';
      if (block.para !== undefined) {
        const para = normalisePara(block.para);
        if (para) block.para = para;
        else delete block.para;
      }

      if (block.kind === 'list') {
        block.listType ??= 'bullet';
        if (!NUMBER_FORMATS.includes(block.format)) delete block.format;
        if (!BULLETS.includes(block.bullet)) delete block.bullet;
        block.items = (block.items ?? []).map((item) => ({
          level: Math.max(0, Math.min(item.level ?? 0, 5)),
          runs: normaliseRuns(item.runs),
          // An item shown without its number or bullet, and one numbering starts again from.
          ...(item.unnumbered ? { unnumbered: true } : {}),
          ...(item.restart ? { restart: true } : {}),
        }));
        if (block.items.length === 0) block.items = [{ level: 0, runs: [{ text: '' }] }];
      } else if (block.kind === 'chart') {
        block.w = Math.max(80, Math.min(2000, Number(block.w) || 480));
        block.h = Math.max(60, Math.min(2000, Number(block.h) || 300));
        block.data = normaliseChartData(block.data);
        block.type = CHART_KINDS.includes(block.type) ? block.type : 'column';
        block.legend = ['right', 'left', 'top', 'bottom', 'none'].includes(block.legend) ? block.legend : 'right';
        if (block.link && (typeof block.link.path !== 'string' || typeof block.link.range !== 'string')) delete block.link;
      } else if (block.kind === 'section') {
        // Where a run of text starts flowing in columns; one column ends the run.
        block.columns = Math.max(1, Math.min(4, Math.round(Number(block.columns) || 1)));
        block.gap = Math.max(0, Math.min(30, Number(block.gap) || 6));
      } else if (block.kind === 'toc' || block.kind === 'index') {
        block.title = typeof block.title === 'string' ? block.title.slice(0, 200) : (block.kind === 'toc' ? 'Contents' : 'Index');
        if (block.kind === 'toc') block.levels = Math.max(1, Math.min(4, Number(block.levels) || 3));
      } else if (block.kind === 'image') {
        block.w ??= 400;
        block.h ??= 260;
        block.caption = normaliseRuns(block.caption ?? []);
      } else if (block.kind === 'table') {
        normaliseTable(block);
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
      charStyles: structuredClone(this.charStyles ?? {}),
      fonts: structuredClone(this.fonts),
      blocks: structuredClone(this.blocks),
      headingNumbers: this.headingNumbers ? { ...this.headingNumbers } : null,
      noteSettings: structuredClone(this.noteSettings),
      review: { ...this.review },
      dirty: this.dirty,
    };
  }

  restore(snapshot) {
    this.page = structuredClone(snapshot.page);
    this.styles = structuredClone(snapshot.styles);
    this.charStyles = structuredClone(snapshot.charStyles ?? {});
    this.fonts = structuredClone(snapshot.fonts ?? []);
    this.blocks = structuredClone(snapshot.blocks);
    this.headingNumbers = snapshot.headingNumbers ? { ...snapshot.headingNumbers } : null;
    this.noteSettings = normaliseNoteSettings(snapshot.noteSettings);
    this.review = normaliseReview(snapshot.review);
    this.dirty = snapshot.dirty;
  }
}

/** Whether changes are being recorded, and the hash that guards turning that off; never a name or a date. */
function normaliseReview(review) {
  return {
    recording: Boolean(review?.recording),
    protect: typeof review?.protect === 'string' && /^[A-Za-z0-9+/=]{20,100}$/.test(review.protect) ? review.protect : null,
  };
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
  } else if (kind === 'table') {
    const rows = Math.max(1, Math.min(options.rows ?? 2, TABLE_LIMITS.rows));
    const cols = Math.max(1, Math.min(options.cols ?? 2, TABLE_LIMITS.cols));
    block.rows = Array.from({ length: rows }, (_, r) => ({
      ...(r === 0 && options.header ? { header: true } : {}),
      cells: Array.from({ length: cols }, () => ({ runs: [{ text: '' }] })),
    }));
    block.widths = Array(cols).fill(1);
    block.borders = 'all';
  } else if (kind === 'chart') {
    block.type = options.type ?? 'column';
    block.data = normaliseChartData(options.data ?? { categories: ['A', 'B', 'C'], series: [{ name: 'Series 1', values: [3, 5, 4] }] });
    block.w = options.w ?? 480;
    block.h = options.h ?? 300;
    block.align = 'center';
  } else if (kind === 'section') {
    block.columns = options.columns ?? 2;
    block.gap = options.gap ?? 6;
  } else if (kind === 'toc' || kind === 'index') {
    block.title = options.title ?? (kind === 'toc' ? 'Contents' : 'Index');
    if (kind === 'toc') block.levels = options.levels ?? 3;
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
