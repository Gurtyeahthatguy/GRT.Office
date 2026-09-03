/** A1 notation, and moving it about. */

/** The value a reference becomes when it stops existing. */
export const REF_ERROR = '#REF!';

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
  return `${formatRef(range.from)}:${formatRef(range.to)}`;
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
      return grown;
    }
    return grown;
  }

  const removed = -count;
  if (low >= at && high < at + removed) return null;    // entirely removed.

  const clamp = (ref) => {
    const index = pick(ref);
    if (index < at) return ref;
    const moved = Math.max(at, index - removed);
    return axis === 'row' ? { ...ref, row: moved } : { ...ref, col: moved };
  };

  return { from: clamp(from), to: clamp(to) };
}
