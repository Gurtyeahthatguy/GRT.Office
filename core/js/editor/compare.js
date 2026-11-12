/**
 * Compare and merge: the differences between two versions of a document, written into one of them as recorded changes,
 * paragraph by paragraph and, inside a paragraph, word by word.
 */

import { normaliseRuns, sliceRuns, makeBlock } from './model.js';
import { freshId } from './review.js';

/** The longest sequence two lists share, as pairs of indices; the work is bounded, past it nothing is paired. */
export function commonPairs(a, b, same = (x, y) => x === y, limit = 25_000_000) {
  const n = a.length;
  const m = b.length;
  if (n * m > limit) return [];
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = same(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (same(a[i], b[j])) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return out;
}

/** Words and the spaces between them, so a change is never half a word. */
const tokens = (text) => text.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu) ?? [];

const textOf = (runs) => runs.map((run) => run.text).join('');
const plain = (run) => {
  const { ins: _i, del: _d, chgnote: _n, cmt: _c, ...rest } = run;
  return rest;
};

/** The old and new runs of a paragraph as one list, words gone marked as taken out and words new as put in. */
export function diffRuns(oldRuns, newRuns, ids) {
  const before = tokens(textOf(oldRuns));
  const after = tokens(textOf(newRuns));
  const pairs = commonPairs(before, after, undefined, 4_000_000);
  if (pairs.length === 0 && before.length && after.length && before.length * after.length > 4_000_000) {
    return [...oldRuns.filter((r) => !r.object).map((r) => ({ ...plain(r), del: ids.del })), ...newRuns.map((r) => (r.object ? r : { ...plain(r), ins: ids.ins }))];
  }
  const out = [];
  const offset = (list, upTo) => list.slice(0, upTo).reduce((sum, t) => sum + t.length, 0);
  let i = 0;
  let j = 0;
  const take = (toI, toJ) => {
    if (toI > i) {
      for (const run of sliceRuns(oldRuns, offset(before, i), offset(before, toI))) if (!run.object) out.push({ ...plain(run), del: ids.del });
    }
    if (toJ > j) {
      for (const run of sliceRuns(newRuns, offset(after, j), offset(after, toJ))) out.push(run.object ? run : { ...plain(run), ins: ids.ins });
    }
  };
  for (const [pi, pj] of pairs) {
    take(pi, pj);
    out.push(...sliceRuns(newRuns, offset(after, pj), offset(after, pj + 1)));
    i = pi + 1;
    j = pj + 1;
  }
  take(before.length, after.length);
  return normaliseRuns(out);
}

const TEXT_KINDS = new Set(['paragraph', 'heading', 'quote', 'code']);
const comparable = (block) => TEXT_KINDS.has(block.kind) ? textOf(block.runs ?? []) : JSON.stringify(block.items ?? block.rows ?? block.resource ?? block.kind);

/**
 * Writes into `model` (the version that stays) the differences from `other` (the version compared against):
 * with `mode` 'compare' the model is the newer one and what the older had and it lacks shows as taken out;
 * with 'merge' the other is the newer one and its differences come in as changes to accept or reject.
 * @returns {{inserted: number, deleted: number, untouched: number}}
 */
export function compareInto(model, other, mode = 'compare') {
  const mine = model.blocks;
  const theirs = other.blocks ?? [];
  const [older, newer] = mode === 'compare' ? [theirs, mine] : [mine, theirs];
  const pairs = commonPairs(older.map(comparable), newer.map(comparable));
  const ids = { ins: freshId('i'), del: freshId('d') };
  const result = [];
  const counts = { inserted: 0, deleted: 0, untouched: 0 };
  const changed = (block) => block.runs?.some((r) => r.ins || r.del);
  // A paragraph only the older has comes back with its text marked as taken out.
  const gone = (block) => {
    if (!TEXT_KINDS.has(block.kind)) {
      counts.untouched += 1;
      return null;
    }
    counts.deleted += 1;
    const copy = makeBlock(block.kind === 'heading' ? 'heading' : 'paragraph', block.kind === 'heading' ? { level: block.level } : {});
    copy.style = block.style;
    copy.runs = normaliseRuns((block.runs ?? []).filter((r) => !r.object).map((r) => ({ ...plain(r), del: ids.del })));
    return copy;
  };
  const added = (block) => {
    if (!TEXT_KINDS.has(block.kind)) {
      counts.untouched += 1;
      return structuredClone(block);
    }
    counts.inserted += 1;
    return { ...structuredClone(block), runs: normaliseRuns((block.runs ?? []).map((r) => (r.object ? r : { ...plain(r), ins: ids.ins }))) };
  };
  let i = 0;
  let j = 0;
  const between = (toI, toJ) => {
    // Paragraphs changed in place are paired in order and compared word by word; the rest are whole.
    while (i < toI && j < toJ) {
      const a = older[i];
      const b = newer[j];
      if (TEXT_KINDS.has(a.kind) && TEXT_KINDS.has(b.kind)) {
        const block = structuredClone(b);
        block.runs = diffRuns(a.runs ?? [], b.runs ?? [], ids);
        if (changed(block)) counts.inserted += 1;
        result.push(block);
      } else {
        const lost = gone(a);
        if (lost) result.push(lost);
        result.push(added(b));
      }
      i += 1;
      j += 1;
    }
    for (; i < toI; i += 1) {
      const lost = gone(older[i]);
      if (lost) result.push(lost);
    }
    for (; j < toJ; j += 1) result.push(added(newer[j]));
  };
  for (const [pi, pj] of pairs) {
    between(pi, pj);
    result.push(structuredClone(newer[pj]));
    i = pi + 1;
    j = pj + 1;
  }
  between(older.length, newer.length);
  // The blocks keep the ids the document had where they are its own.
  model.blocks = result;
  model.dirty = true;
  return counts;
}
