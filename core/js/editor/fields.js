/** What the objects in a document's text stand for: note numbers, caption numbers, bookmarks, index entries, headings. */

import { runsText, OBJECT } from './model.js';

const ROMAN = [['m', 1000], ['cm', 900], ['d', 500], ['cd', 400], ['c', 100], ['xc', 90], ['l', 50], ['xl', 40], ['x', 10], ['ix', 9], ['v', 5], ['iv', 4], ['i', 1]];

/** A number in small roman numerals, as endnotes are counted. */
export function roman(n) {
  let out = '';
  let left = n;
  for (const [letters, value] of ROMAN) while (left >= value) { out += letters; left -= value; }
  return out;
}

/** A count written in one of the list formats: 1, a, A, i or I. */
export function formatNumber(n, format = 'decimal') {
  if (format === 'lower-roman') return roman(n);
  if (format === 'upper-roman') return roman(n).toUpperCase();
  if (format === 'lower-alpha' || format === 'upper-alpha') {
    // a to z, then aa, bb, as LibreOffice counts past z.
    const letter = String.fromCharCode(97 + ((n - 1) % 26));
    const text = letter.repeat(Math.floor((n - 1) / 26) + 1);
    return format === 'upper-alpha' ? text.toUpperCase() : text;
  }
  return String(n);
}

/** Every run list of a block, with the cell or item it belongs to. */
export function* runListsOf(block) {
  if (block.kind === 'list') for (const [i, item] of block.items.entries()) yield { runs: item.runs, itemIndex: i };
  else if (block.kind === 'table') {
    const cols = block.rows[0]?.cells.length ?? 0;
    for (const [r, row] of block.rows.entries()) for (const [c, cell] of row.cells.entries()) if (!cell.covered) yield { runs: cell.runs, itemIndex: r * cols + c };
  } else if (block.kind === 'image') yield { runs: block.caption ?? [], itemIndex: null, caption: true };
  else if (block.runs) yield { runs: block.runs, itemIndex: null };
}

/** The text of a paragraph with its objects shown as they read, for headings and references. */
const plain = (runs) => runsText(runs).replaceAll(OBJECT, '').trim();

/**
 * The numbers and names the objects of a document resolve to, worked out in reading order.
 * @returns {{notes: Map, seqs: Map, bookmarks: Map, headings: Object[], entries: Object[], footnotes: Object[], endnotes: Object[]}}
 */
export function documentFields(model) {
  const notes = new Map();
  const seqs = new Map();
  const bookmarks = new Map();
  const headings = [];
  const entries = [];
  const footnotes = [];
  const endnotes = [];
  const counters = new Map();
  const numbering = model.headingNumbers ?? null;
  const settings = model.noteSettings ?? { foot: { format: 'decimal', start: 1 }, end: { format: 'lower-roman', start: 1 } };
  const counted = { foot: 0, end: 0 };
  const levels = [0, 0, 0, 0];
  for (const block of model.blocks) {
    if (block.kind === 'heading') {
      const level = block.level ?? 1;
      let number = null;
      if (numbering && level <= numbering.depth) {
        levels[level - 1] += 1;
        for (let i = level; i < levels.length; i += 1) levels[i] = 0;
        const parts = numbering.full ? levels.slice(0, level) : [levels[level - 1]];
        number = `${parts.map((n) => formatNumber(n, numbering.format)).join('.')}${numbering.after}`;
      }
      headings.push({ blockId: block.id, level, text: plain(block.runs), number });
    }
    for (const { runs, itemIndex } of runListsOf(block)) {
      for (const run of runs) {
        const object = run.object;
        if (!object) continue;
        if (object.type === 'note') {
          const list = object.kind === 'end' ? endnotes : footnotes;
          const kind = object.kind === 'end' ? 'end' : 'foot';
          // A note with a character of its own does not take a number.
          if (!object.mark) counted[kind] += 1;
          const number = counted[kind] + settings[kind].start - 1;
          const label = object.mark ?? formatNumber(number, settings[kind].format);
          notes.set(object, { number, label });
          list.push({ object, label, blockId: block.id });
        } else if (object.type === 'seq') {
          const number = (counters.get(object.name) ?? 0) + 1;
          counters.set(object.name, number);
          seqs.set(object.id, { name: object.name, number, blockId: block.id, text: plain(runs) });
        } else if (object.type === 'bookmark') {
          if (!bookmarks.has(object.name)) bookmarks.set(object.name, { blockId: block.id, itemIndex, text: plain(runs) });
        } else if (object.type === 'index') {
          entries.push({ term: object.term, sub: object.sub ?? null, blockId: block.id });
        }
      }
    }
  }
  const headingIndex = new Map(headings.map((h) => [h.blockId, h]));
  return { notes, seqs, bookmarks, headings, headingIndex, entries, footnotes, endnotes };
}

/** What a reference shows, short of a page number, which only a laid-out document knows. */
export function referenceText(object, fields) {
  const target = object.target;
  if (target.startsWith('heading:')) {
    const heading = fields.headings.find((h) => h.blockId === target.slice(8));
    return heading ? heading.text : 'Reference missing';
  }
  const seq = fields.seqs.get(target);
  if (seq) return object.show === 'text' ? seq.text : `${seq.name} ${seq.number}`;
  const mark = fields.bookmarks.get(target);
  if (mark) return mark.text || target;
  return 'Reference missing';
}

/** Where a reference points, as a block id the layout can find a page for. */
export function referenceBlock(object, fields) {
  const target = object.target;
  if (target.startsWith('heading:')) return target.slice(8);
  return fields.seqs.get(target)?.blockId ?? fields.bookmarks.get(target)?.blockId ?? null;
}
