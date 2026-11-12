/** What a cell can hold, and how the types meet. */

export const ERROR = {
  div0: '#DIV/0!',
  value: '#VALUE!',
  ref: '#REF!',
  name: '#NAME?',
  na: '#N/A',
  num: '#NUM!',
  null: '#NULL!',
  spill: '#SPILL!',
  calc: '#CALC!',
};

/** A block of values: what a range is, and what a function like FILTER returns. */
export class Matrix {
  constructor(data) {
    this.data = data.length > 0 ? data : [[null]];
    this.rows = this.data.length;
    let cols = 0;
    for (const row of this.data) if (row.length > cols) cols = row.length;
    this.cols = cols;
  }

  static of(rows, cols, fill) {
    return new Matrix(Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => fill(r, c))));
  }

  static column(values) {
    return new Matrix(values.map((value) => [value]));
  }

  at(row, col) {
    // A single row or column stretches to fit, as array arithmetic does.
    const r = this.rows === 1 ? 0 : row;
    const c = this.cols === 1 ? 0 : col;
    if (r >= this.rows || c >= this.cols) return ERROR.na;
    return this.data[r][c] ?? null;
  }

  get flat() {
    return this.data.flat();
  }

  get first() {
    return this.data[0][0] ?? null;
  }
}

export const isMatrix = (value) => value instanceof Matrix;

const ERROR_VALUES = new Set(Object.values(ERROR));

export function isError(value) {
  return typeof value === 'string' && ERROR_VALUES.has(value);
}

export function isBlank(value) {
  return value === null || value === undefined || value === '';
}

/** A value as a number, or an error. */
export function toNumber(value) {
  if (isError(value)) return value;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : ERROR.num;
  if (typeof value === 'boolean') return value ? 1 : 0;

  const text = String(value).trim();
  if (text === '') return 0;

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : ERROR.value;
}

export function toText(value) {
  if (isError(value)) return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return formatNumberForText(value);
  return String(value);
}

export function toBoolean(value) {
  if (isError(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;

  const text = String(value).trim().toUpperCase();
  if (text === 'TRUE') return true;
  if (text === 'FALSE') return false;
  const parsed = Number(text);
  if (Number.isFinite(parsed)) return parsed !== 0;
  return ERROR.value;
}

/** A number as text, without the surprises of `String(0.1 + 0.2)`. */
export function formatNumberForText(value) {
  if (!Number.isFinite(value)) return ERROR.num;
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);

  const rounded = Number.parseFloat(value.toPrecision(15));
  return String(rounded);
}

/** Rank for the cross-type ordering: numbers, then text, then booleans. */
function typeRank(value) {
  if (typeof value === 'number') return 0;
  if (typeof value === 'string') return 1;
  if (typeof value === 'boolean') return 2;
  return 0;      // blank compares as a number, which is what makes it 0.
}

/**
 * Compares two values the way a spreadsheet does.
 * @returns {number|string} negative, zero, positive or an error
 */
export function compare(left, right) {
  if (isError(left)) return left;
  if (isError(right)) return right;

  const a = left === null || left === undefined ? 0 : left;
  const b = right === null || right === undefined ? 0 : right;

  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA - rankB;

  if (typeof a === 'number') return a - b;
  if (typeof a === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);

  // Text comparison is case-insensitive, as in Excel: "a" = "A" is TRUE.
  const textA = String(a).toLowerCase();
  const textB = String(b).toLowerCase();
  return textA < textB ? -1 : textA > textB ? 1 : 0;
}

/** Flattens arguments for a function that works over ranges. */
/** A value typed into a function's arguments as a number: text there, even "5", is an error, as in Calc. */
export function typedNumber(value) {
  return typeof value === 'string' ? ERROR.value : toNumber(value);
}

export function collectNumbers(values) {
  const numbers = [];
  for (const value of values) {
    if (isError(value)) return value;
    if (value === null || value === undefined || value === '') continue;
    // Calc keeps TRUE and FALSE in cells as 1 and 0, so they count.
    if (typeof value === 'boolean') { numbers.push(value ? 1 : 0); continue; }
    if (typeof value === 'number') { numbers.push(value); continue; }

    // Text in cells is skipped, even text that looks like a number, as Calc and Excel do.
  }
  return numbers;
}
