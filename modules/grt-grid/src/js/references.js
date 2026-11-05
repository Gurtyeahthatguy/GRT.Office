/** A1 notation, and moving it about. */

/** The value a reference becomes when it stops existing. */
export const REF_ERROR = '#REF!';

/** The size of a sheet, as LibreOffice and Excel have it. */
export const ROW_COUNT = 1048576;
export const COL_COUNT = 16384;

// Column names

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index) {
  if (!Number.isInteger(index) || index < 0) return '';
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

/** A → 0, Z → 25, AA → 26. */
export function columnIndex(name) {
  const text = String(name ?? '').toUpperCase();
  if (!/^[A-Z]+$/.test(text)) return -1;

  let n = 0;
  for (const character of text) {
    n = n * 26 + (character.charCodeAt(0) - 64);
  }
  return n - 1;
}

// Single references

const REF = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;

/**
 * Reads `A1`, `$A1`, `A$1` or `$A$1`.
 * @returns {?{row: number, col: number, rowAbs: boolean, colAbs: boolean}}
 */
export function parseRef(text) {
  const match = REF.exec(String(text ?? '').trim());
  if (!match) return null;

  const col = columnIndex(match[2]);
  const row = Number.parseInt(match[4], 10) - 1;
  if (col < 0 || row < 0) return null;

  return { row, col, colAbs: match[1] === '$', rowAbs: match[3] === '$' };
}

export function formatRef(ref) {
  if (!ref) return REF_ERROR;
  if (ref.row < 0 || ref.col < 0) return REF_ERROR;
  return `${ref.colAbs ? '$' : ''}${columnName(ref.col)}${ref.rowAbs ? '$' : ''}${ref.row + 1}`;
}

/** The key a cell has in the sparse map. */
export function key(row, col) {
  return `${row},${col}`;
}

export function parseKey(text) {
  const [row, col] = String(text).split(',').map(Number);
  return { row, col };
}

/** `A1` from a row and a column, for display. */
export function a1(row, col) {
  return `${columnName(col)}${row + 1}`;
}

// Ranges

/** Reads `A1:B10` into two references. */
export function parseRange(text) {
  const [left, right] = String(text ?? '').split(':');
  if (right === undefined) return null;

  const from = parseRef(left);
  const to = parseRef(right);
  if (!from || !to) return null;

  return { from, to };
}

export function formatRange(range) {
  if (range.whole === 'col') {
    const side = (ref) => `${ref.colAbs ? '$' : ''}${columnName(ref.col)}`;
    return `${side(range.from)}:${side(range.to)}`;
  }
  if (range.whole === 'row') {
    const side = (ref) => `${ref.rowAbs ? '$' : ''}${ref.row + 1}`;
    return `${side(range.from)}:${side(range.to)}`;
  }
  return `${formatRef(range.from)}:${formatRef(range.to)}`;
}

/** `A:C` or `2:5`, a range of whole columns or rows; null when it is neither. */
export function wholeRange(first, second) {
  const column = /^(\$?)([A-Za-z]{1,3})$/;
  const row = /^(\$?)(\d{1,7})$/;
  const a = column.exec(first);
  const b = column.exec(second);
  if (a && b) {
    const from = { row: 0, col: columnIndex(a[2]), rowAbs: true, colAbs: a[1] === '$' };
    const to = { row: ROW_COUNT - 1, col: columnIndex(b[2]), rowAbs: true, colAbs: b[1] === '$' };
    return from.col < COL_COUNT && to.col < COL_COUNT ? { from, to, whole: 'col' } : null;
  }
  const c = row.exec(first);
  const d = row.exec(second);
  if (c && d) {
    const from = { row: Number(c[2]) - 1, col: 0, rowAbs: c[1] === '$', colAbs: true };
    const to = { row: Number(d[2]) - 1, col: COL_COUNT - 1, rowAbs: d[1] === '$', colAbs: true };
    return from.row >= 0 && to.row >= 0 && from.row < ROW_COUNT && to.row < ROW_COUNT ? { from, to, whole: 'row' } : null;
  }
  return null;
}

/** Every cell in a range, row by row. */
export function* cellsInRange(range) {
  const top = Math.min(range.from.row, range.to.row);
  const bottom = Math.max(range.from.row, range.to.row);
  const left = Math.min(range.from.col, range.to.col);
  const right = Math.max(range.from.col, range.to.col);

  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      yield { row, col };
    }
  }
}

export function rangeContains(range, row, col) {
  const top = Math.min(range.from.row, range.to.row);
  const bottom = Math.max(range.from.row, range.to.row);
  const left = Math.min(range.from.col, range.to.col);
  const right = Math.max(range.from.col, range.to.col);
  return row >= top && row <= bottom && col >= left && col <= right;
}

export function rangeSize(range) {
  const rows = Math.abs(range.to.row - range.from.row) + 1;
  const cols = Math.abs(range.to.col - range.from.col) + 1;
  return rows * cols;
}

// Moving references

/** Translates a reference by an offset, as copying a formula does. */
export function translate(ref, rowDelta, colDelta) {
  const row = ref.rowAbs ? ref.row : ref.row + rowDelta;
  const col = ref.colAbs ? ref.col : ref.col + colDelta;
  if (row < 0 || col < 0) return null;
  return { row, col, rowAbs: ref.rowAbs, colAbs: ref.colAbs };
}

/**
 * Adjusts a reference for rows or columns inserted or deleted.
 * @param {Object} ref
 * @param {{axis: 'row'|'col', at: number, count: number}} change `count`
 * @returns {?Object} null when the referenced cell was deleted
 */
export function shiftForStructuralChange(ref, { axis, at, count }) {
  const index = axis === 'row' ? ref.row : ref.col;

  if (count > 0) {
    if (index < at) return { ...ref };
    return axis === 'row'
      ? { ...ref, row: ref.row + count }
      : { ...ref, col: ref.col + count };
  }

  const removed = -count;
  if (index < at) return { ...ref };
  // The cell itself was one of the ones removed.
  if (index < at + removed) return null;

  return axis === 'row'
    ? { ...ref, row: ref.row - removed }
    : { ...ref, col: ref.col - removed };
}

/** The same, for a range. */
export function shiftRangeForStructuralChange(range, change) {
  const { axis, at, count } = change;
  // A range of whole columns does not move when rows come and go, nor whole rows with columns.
  if ((range.whole === 'col' && axis === 'row') || (range.whole === 'row' && axis === 'col')) return range;
  const pick = (ref) => (axis === 'row' ? ref.row : ref.col);

  const from = { ...range.from };
  const to = { ...range.to };
  const low = Math.min(pick(from), pick(to));
  const high = Math.max(pick(from), pick(to));

  if (count > 0) {
    // Inserting inside the range extends its far edge; inserting above moves
    // the whole thing.
    const adjust = (ref) => {
      const index = pick(ref);
      if (index < at) return ref;
      return axis === 'row' ? { ...ref, row: ref.row + count } : { ...ref, col: ref.col + count };
    };
    const grown = { from: adjust(from), to: adjust(to) };
    if (at > low && at <= high) {
      // Straddled: the near edge stays, the far edge has already moved.
      return range.whole ? { ...grown, whole: range.whole } : grown;
    }
    return range.whole ? { ...grown, whole: range.whole } : grown;
  }

  const removed = -count;
  if (low >= at && high < at + removed) return null;    // entirely removed.

  // An edge inside the removed rows lands on the nearest row that is left, inside the range.
  const move = (ref, far) => {
    const index = pick(ref);
    const moved = index < at ? index
      : index >= at + removed ? index - removed
        : far ? at - 1 : at;
    return axis === 'row' ? { ...ref, row: moved } : { ...ref, col: moved };
  };
  const fromIsFar = pick(from) > pick(to);

  return { from: move(from, fromIsFar), to: move(to, !fromIsFar), ...(range.whole ? { whole: range.whole } : {}) };
}

/** F4 in a formula: the reference at the cursor goes A1, $A$1, A$1, $A1 and back. */
export function cycleReference(text, caret) {
  const re = /(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\w(])/g;
  let match;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret < start || caret > end) continue;
    const [, c, letters, r, digits] = match;
    const next = !c && !r ? ['$', '$'] : c && r ? ['', '$'] : !c && r ? ['$', ''] : ['', ''];
    const made = `${next[0]}${letters}${next[1]}${digits}`;
    return { text: text.slice(0, start) + made + text.slice(end), caret: start + made.length };
  }
  return null;
}
