/** Tables on slides: their grid, merged cells, rows and columns put in and taken out, and sizes fitted to the text. */

export const TABLE_LIMITS = { rows: 30, cols: 12 };

const clampCount = (value, limit, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, limit) : fallback;
};

/** Shares that add up to one, or null when the list does not fit the count. */
function shares(list, count) {
  if (!Array.isArray(list) || list.length !== count) return null;
  const clean = list.map((v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (!(total > 0) || clean.some((v) => v === 0)) return null;
  return clean.map((v) => v / total);
}

/** Merged blocks that lie inside the table, cover more than one cell and do not overlap. */
function cleanMerges(merges, rows, cols) {
  const out = [];
  for (const m of Array.isArray(merges) ? merges.slice(0, 400) : []) {
    const area = {
      top: Math.floor(Number(m?.top)), left: Math.floor(Number(m?.left)),
      bottom: Math.floor(Number(m?.bottom)), right: Math.floor(Number(m?.right)),
    };
    if (![area.top, area.left, area.bottom, area.right].every(Number.isFinite)) continue;
    if (area.top < 0 || area.left < 0 || area.bottom >= rows || area.right >= cols) continue;
    if (area.bottom < area.top || area.right < area.left || (area.bottom === area.top && area.right === area.left)) continue;
    if (out.some((o) => !(area.bottom < o.top || area.top > o.bottom || area.right < o.left || area.left > o.right))) continue;
    out.push(area);
  }
  return out;
}

/** A table element made safe and whole: its size within limits, every cell a string, sizes and merges that fit. */
export function normaliseTable(element) {
  element.rows = clampCount(element.rows, TABLE_LIMITS.rows, 3);
  element.cols = clampCount(element.cols, TABLE_LIMITS.cols, 2);
  element.header = element.header !== false;
  const source = Array.isArray(element.cells) ? element.cells : [];
  element.cells = Array.from({ length: element.rows }, (_, r) => Array.from({ length: element.cols }, (_, c) => {
    const value = source[r]?.[c];
    return typeof value === 'string' ? value.slice(0, 10_000) : '';
  }));
  const colW = shares(element.colW, element.cols);
  const rowH = shares(element.rowH, element.rows);
  if (colW && colW.some((v) => Math.abs(v - 1 / element.cols) > 1e-6)) element.colW = colW; else delete element.colW;
  if (rowH && rowH.some((v) => Math.abs(v - 1 / element.rows) > 1e-6)) element.rowH = rowH; else delete element.rowH;
  const merges = cleanMerges(element.merges, element.rows, element.cols);
  if (merges.length) element.merges = merges; else delete element.merges;
  // Cells marked to be covered in a redacted copy, by row and column.
  const covered = Array.isArray(element.redact)
    ? [...new Set(element.redact.filter((k) => typeof k === 'string' && /^\d{1,2},\d{1,2}$/.test(k)).filter((k) => {
      const [r, c] = k.split(',').map(Number);
      return r < element.rows && c < element.cols;
    }))] : [];
  if (covered.length) element.redact = covered; else delete element.redact;
  return element;
}

export const colShares = (element) => element.colW ?? Array.from({ length: element.cols }, () => 1 / element.cols);
export const rowShares = (element) => element.rowH ?? Array.from({ length: element.rows }, () => 1 / element.rows);

/** The merged block a cell belongs to, or null. */
export function mergeAt(element, row, col) {
  return (element.merges ?? []).find((m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right) ?? null;
}

/**
 * Where each shown cell sits, in the slide's pixels relative to the table: cells under a merge are left out.
 * @returns {{xs: number[], ys: number[], cells: {row: number, col: number, rowSpan: number, colSpan: number, x: number, y: number, w: number, h: number, text: string}[]}}
 */
export function tableGrid(element) {
  const xs = [0];
  for (const share of colShares(element)) xs.push(xs[xs.length - 1] + share * element.w);
  const ys = [0];
  for (const share of rowShares(element)) ys.push(ys[ys.length - 1] + share * element.h);
  const cells = [];
  for (let row = 0; row < element.rows; row += 1) {
    for (let col = 0; col < element.cols; col += 1) {
      const merge = mergeAt(element, row, col);
      if (merge && (merge.top !== row || merge.left !== col)) continue;
      const rowSpan = merge ? merge.bottom - merge.top + 1 : 1;
      const colSpan = merge ? merge.right - merge.left + 1 : 1;
      cells.push({
        row, col, rowSpan, colSpan,
        x: xs[col], y: ys[row], w: xs[col + colSpan] - xs[col], h: ys[row + rowSpan] - ys[row],
        text: element.cells[row]?.[col] ?? '',
      });
    }
  }
  return { xs, ys, cells };
}

/** An area grown until no merge sticks out of it. */
export function widen(element, area) {
  const out = { ...area };
  for (let changed = true; changed;) {
    changed = false;
    for (const m of element.merges ?? []) {
      const touches = !(m.bottom < out.top || m.top > out.bottom || m.right < out.left || m.left > out.right);
      if (!touches) continue;
      const next = { top: Math.min(out.top, m.top), left: Math.min(out.left, m.left), bottom: Math.max(out.bottom, m.bottom), right: Math.max(out.right, m.right) };
      if (next.top !== out.top || next.left !== out.left || next.bottom !== out.bottom || next.right !== out.right) {
        Object.assign(out, next);
        changed = true;
      }
    }
  }
  return out;
}

/** Shifts and trims merges for rows or columns put in (count > 0) or taken out (count < 0) at an index. */
function shiftMerges(element, axis, at, count) {
  const [lo, hi] = axis === 'row' ? ['top', 'bottom'] : ['left', 'right'];
  const out = [];
  for (const m of element.merges ?? []) {
    const next = { ...m };
    if (count > 0) {
      // A block below moves down; one the new rows go through grows by them.
      if (m[lo] >= at) {
        next[lo] += count;
        next[hi] += count;
      } else if (m[hi] >= at) next[hi] += count;
    } else {
      const end = at - count - 1;
      const cut = (i) => (i < at ? i : i > end ? i + count : at);
      next[lo] = cut(m[lo]);
      next[hi] = m[hi] > end ? m[hi] + count : m[hi] >= at ? at - 1 : m[hi];
      if (next[hi] < next[lo]) continue;
    }
    out.push(next);
  }
  element.merges = out;
}

/** Puts in rows at an index, as tall as the rows around them; within the limit. */
export function insertRows(element, at, count = 1) {
  const n = Math.max(0, Math.min(count, TABLE_LIMITS.rows - element.rows));
  if (n === 0) return false;
  const shares0 = rowShares(element);
  const each = shares0[Math.min(at, element.rows - 1)] ?? 1 / element.rows;
  element.cells.splice(at, 0, ...Array.from({ length: n }, () => Array.from({ length: element.cols }, () => '')));
  const next = [...shares0];
  next.splice(at, 0, ...Array.from({ length: n }, () => each));
  // The table grows by the new rows, so the others keep their height.
  const total = next.reduce((a, b) => a + b, 0);
  element.h *= total;
  element.rowH = next.map((v) => v / total);
  element.rows += n;
  shiftMerges(element, 'row', at, n);
  normaliseTable(element);
  return true;
}

export function deleteRows(element, at, count = 1) {
  const n = Math.max(0, Math.min(count, element.rows - at, element.rows - 1));
  if (n === 0) return false;
  const shares0 = rowShares(element);
  const gone = shares0.slice(at, at + n).reduce((a, b) => a + b, 0);
  element.cells.splice(at, n);
  const next = [...shares0];
  next.splice(at, n);
  element.h *= 1 - gone;
  element.rowH = next.map((v) => v / (1 - gone));
  element.rows -= n;
  shiftMerges(element, 'row', at, -n);
  normaliseTable(element);
  return true;
}

export function insertCols(element, at, count = 1) {
  const n = Math.max(0, Math.min(count, TABLE_LIMITS.cols - element.cols));
  if (n === 0) return false;
  const shares0 = colShares(element);
  const each = shares0[Math.min(at, element.cols - 1)] ?? 1 / element.cols;
  for (const row of element.cells) row.splice(at, 0, ...Array.from({ length: n }, () => ''));
  const next = [...shares0];
  next.splice(at, 0, ...Array.from({ length: n }, () => each));
  const total = next.reduce((a, b) => a + b, 0);
  element.w *= total;
  element.colW = next.map((v) => v / total);
  element.cols += n;
  shiftMerges(element, 'col', at, n);
  normaliseTable(element);
  return true;
}

export function deleteCols(element, at, count = 1) {
  const n = Math.max(0, Math.min(count, element.cols - at, element.cols - 1));
  if (n === 0) return false;
  const shares0 = colShares(element);
  const gone = shares0.slice(at, at + n).reduce((a, b) => a + b, 0);
  for (const row of element.cells) row.splice(at, n);
  const next = [...shares0];
  next.splice(at, n);
  element.w *= 1 - gone;
  element.colW = next.map((v) => v / (1 - gone));
  element.cols -= n;
  shiftMerges(element, 'col', at, -n);
  normaliseTable(element);
  return true;
}

/** Merges an area into its top-left cell, the texts of the others kept below its own. */
export function mergeCells(element, area) {
  const block = widen(element, area);
  if (block.top === block.bottom && block.left === block.right) return false;
  const texts = [];
  for (let r = block.top; r <= block.bottom; r += 1) {
    for (let c = block.left; c <= block.right; c += 1) {
      if (element.cells[r][c] !== '') texts.push(element.cells[r][c]);
      element.cells[r][c] = '';
    }
  }
  element.cells[block.top][block.left] = texts.join('\n');
  element.merges = (element.merges ?? []).filter((m) => m.bottom < block.top || m.top > block.bottom || m.right < block.left || m.left > block.right);
  element.merges.push(block);
  normaliseTable(element);
  return true;
}

export function unmergeCells(element, area) {
  const before = (element.merges ?? []).length;
  element.merges = (element.merges ?? []).filter((m) => m.bottom < area.top || m.top > area.bottom || m.right < area.left || m.left > area.right);
  const changed = element.merges.length !== before;
  normaliseTable(element);
  return changed;
}

/** Makes rows, or columns, between two indexes the same size, the table keeping its own. */
export function distribute(element, axis, from, to) {
  const list = axis === 'row' ? [...rowShares(element)] : [...colShares(element)];
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(list.length - 1, Math.max(from, to));
  if (hi <= lo) return false;
  const total = list.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
  for (let i = lo; i <= hi; i += 1) list[i] = total / (hi - lo + 1);
  if (axis === 'row') element.rowH = list; else element.colW = list;
  normaliseTable(element);
  return true;
}

/**
 * Sizes rows, or columns, to their text: 'minimal' shrinks each to what it needs, the table with them;
 * 'optimal' shares the table's size out by what each needs.
 * @param {(text: string, width: number) => {width: number, height: number}} measure the size a text takes, at a width or unbounded
 */
export function fitToText(element, axis, mode, from, to, measure) {
  const { xs } = tableGrid(element);
  const count = axis === 'row' ? element.rows : element.cols;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(count - 1, Math.max(from, to));
  const pad = 2 * 10;
  const needs = [];
  for (let i = lo; i <= hi; i += 1) {
    let need = axis === 'row' ? 24 : 40;
    for (let j = 0; j < (axis === 'row' ? element.cols : element.rows); j += 1) {
      const [row, col] = axis === 'row' ? [i, j] : [j, i];
      const merge = mergeAt(element, row, col);
      if (merge) continue;
      const text = element.cells[row][col];
      if (axis === 'row') need = Math.max(need, measure(text, xs[col + 1] - xs[col] - pad).height + pad);
      else need = Math.max(need, measure(text, Infinity).width + pad);
    }
    needs.push(need);
  }
  const size = axis === 'row' ? element.h : element.w;
  const list = (axis === 'row' ? rowShares(element) : colShares(element)).map((share) => share * size);
  if (mode === 'minimal') {
    for (let i = lo; i <= hi; i += 1) list[i] = needs[i - lo];
  } else {
    const room = list.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
    const wanted = needs.reduce((a, b) => a + b, 0);
    for (let i = lo; i <= hi; i += 1) list[i] = Math.max(needs[i - lo], (needs[i - lo] / wanted) * room);
  }
  const total = list.reduce((a, b) => a + b, 0);
  if (axis === 'row') {
    element.h = total;
    element.rowH = list.map((v) => v / total);
  } else {
    element.w = total;
    element.colW = list.map((v) => v / total);
  }
  normaliseTable(element);
  return true;
}
