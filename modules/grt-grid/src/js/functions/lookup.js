/** Looking things up, and the functions that build blocks out of blocks. */

import { ERROR, isError, isBlank, toNumber, toText, toBoolean, compare, Matrix } from '../engine/values.js';
import { columnName } from '../references.js';

/** An argument as a block, a single value as a block of one. */
const blockOf = (arg) => (arg?.matrix ?? new Matrix([[arg?.value ?? null]]));

function intArg(arg, fallback) {
  if (!arg || arg.missing) return fallback;
  const n = toNumber(arg.value);
  return isError(n) ? n : Math.trunc(n);
}

function boolArg(arg, fallback) {
  if (!arg || arg.missing) return fallback;
  return toBoolean(arg.value);
}

const transpose = (m) => Matrix.of(m.cols, m.rows, (r, c) => m.data[c][r] ?? null);
const rowsOf = (m) => m.data.map((row) => Array.from({ length: m.cols }, (_, c) => row[c] ?? null));

/** A text pattern with wildcards, for XLOOKUP's match mode 2. */
function wildcardTest(needle) {
  let out = '';
  const text = String(needle);
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '~' && i + 1 < text.length) { i += 1; out += text[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } else if (c === '*') out += '[\\s\\S]*';
    else if (c === '?') out += '[\\s\\S]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const pattern = new RegExp(`^${out}$`, 'i');
  return (value) => typeof value === 'string' && pattern.test(value);
}

/** The position XMATCH and XLOOKUP find, zero-based, or -1. */
function xmatch(needle, values, matchMode, searchMode) {
  if (![0, -1, 1, 2].includes(matchMode) || ![1, -1, 2, -2].includes(searchMode)) return ERROR.value;
  if (Math.abs(searchMode) === 2) {
    // A binary search over values sorted ascending (2) or descending (-2).
    let low = 0;
    let high = values.length - 1;
    let found = -1;
    let best = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      let result = compare(values[middle], needle);
      if (isError(result)) result = 1;
      if (searchMode === -2) result = -result;
      if (result === 0) { found = middle; break; }
      if (result < 0) { if (matchMode === -1 && searchMode === 2) best = middle; if (matchMode === 1 && searchMode === -2) best = middle; low = middle + 1; } else { if (matchMode === 1 && searchMode === 2) best = middle; if (matchMode === -1 && searchMode === -2) best = middle; high = middle - 1; }
    }
    return found !== -1 ? found : (matchMode === 0 ? -1 : best);
  }
  const order = searchMode === 1 ? values.map((_, i) => i) : values.map((_, i) => values.length - 1 - i);
  if (matchMode === 2) {
    const test = typeof needle === 'string' ? wildcardTest(needle) : (v) => compare(v, needle) === 0;
    return order.find((i) => test(values[i])) ?? -1;
  }
  let best = -1;
  for (const i of order) {
    const result = compare(values[i], needle);
    if (isError(result) || (typeof values[i] !== typeof needle && !(values[i] === null && typeof needle === 'number'))) {
      if (!(typeof values[i] === 'number' && typeof needle === 'number')) continue;
    }
    if (result === 0) return i;
    if (matchMode === -1 && result < 0 && (best === -1 || compare(values[i], values[best]) > 0)) best = i;
    if (matchMode === 1 && result > 0 && (best === -1 || compare(values[i], values[best]) < 0)) best = i;
  }
  return best;
}

/** The values of a block in one line, by rows or by columns, maybe without blanks or errors. */
function lineOf(m, ignore, byColumn) {
  const out = [];
  const outer = byColumn ? m.cols : m.rows;
  const inner = byColumn ? m.rows : m.cols;
  for (let a = 0; a < outer; a += 1) {
    for (let b = 0; b < inner; b += 1) {
      const value = byColumn ? m.data[b][a] : m.data[a][b];
      const v = value ?? null;
      if ((ignore === 1 || ignore === 3) && isBlank(v)) continue;
      if ((ignore === 2 || ignore === 3) && isError(v)) continue;
      out.push(v);
    }
  }
  return out;
}

function sortRows(rows, keys) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const { values, order } of keys) {
        let result = compare(values[a.index], values[b.index]);
        if (isError(result)) result = 0;
        // Blanks go last, whichever way the sort runs.
        const blankA = isBlank(values[a.index]);
        const blankB = isBlank(values[b.index]);
        if (blankA !== blankB) return blankA ? 1 : -1;
        if (result !== 0) return order * result;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

const ERROR_TYPES = { '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4, '#NAME?': 5, '#NUM!': 6, '#N/A': 7 };
const ERROR_CODES = { '#NULL!': 521, '#DIV/0!': 532, '#VALUE!': 519, '#REF!': 524, '#NAME?': 525, '#NUM!': 503, '#N/A': 32767 };

/** Blocks put side by side or one under another, short ones filled with #N/A. */
function stack(args, across) {
  const blocks = args.filter((a) => !a.missing).map(blockOf);
  if (blocks.length === 0) return ERROR.value;
  if (across) {
    const rows = Math.max(...blocks.map((b) => b.rows));
    return new Matrix(Array.from({ length: rows }, (_, r) => blocks.flatMap((b) => (
      Array.from({ length: b.cols }, (_, c) => (r < b.rows ? (b.data[r][c] ?? null) : ERROR.na))))));
  }
  const cols = Math.max(...blocks.map((b) => b.cols));
  return new Matrix(blocks.flatMap((b) => rowsOf(b).map((row) => [...row, ...Array(cols - row.length).fill(ERROR.na)])));
}

function wrap(vector, count, pad, byColumns) {
  const n = Math.trunc(count);
  if (n < 1) return ERROR.num;
  const lines = Math.ceil(vector.length / n);
  const cell = (outer, inner) => {
    const i = outer * n + inner;
    return i < vector.length ? vector[i] : pad;
  };
  return byColumns ? Matrix.of(n, lines, (r, c) => cell(c, r)) : Matrix.of(lines, n, (r, c) => cell(r, c));
}

export const LOOKUP = {
  XMATCH: (args) => {
    const needle = args[0]?.value ?? null;
    const values = blockOf(args[1]).flat;
    const matchMode = intArg(args[2], 0);
    const searchMode = intArg(args[3], 1);
    if (isError(matchMode) || isError(searchMode)) return ERROR.value;
    const at = xmatch(needle, values, matchMode, searchMode);
    if (isError(at)) return at;
    return at === -1 ? ERROR.na : at + 1;
  },
  XLOOKUP: (args) => {
    const needle = args[0]?.value ?? null;
    const where = blockOf(args[1]);
    const result = blockOf(args[2]);
    const matchMode = intArg(args[4], 0);
    const searchMode = intArg(args[5], 1);
    if (isError(matchMode) || isError(searchMode)) return ERROR.value;
    const vertical = where.cols === 1;
    if (!vertical && where.rows !== 1) return ERROR.value;
    const length = vertical ? where.rows : where.cols;
    if ((vertical ? result.rows : result.cols) !== length) return ERROR.value;
    const at = xmatch(needle, where.flat, matchMode, searchMode);
    if (isError(at)) return at;
    if (at === -1) return args[3] && !args[3].missing ? (args[3].matrix ?? args[3].value) : ERROR.na;
    if (vertical) return result.cols === 1 ? (result.data[at][0] ?? null) : new Matrix([rowsOf(result)[at]]);
    return result.rows === 1 ? (result.data[0][at] ?? null) : Matrix.of(result.rows, 1, (r) => result.data[r][at] ?? null);
  },
  LOOKUP: (args) => {
    const needle = args[0]?.value ?? null;
    const where = blockOf(args[1]);
    let keys;
    let answers;
    if (args[2] && !args[2].missing) {
      keys = where.flat;
      answers = blockOf(args[2]).flat;
    } else if (where.cols > where.rows) {
      keys = where.data[0];
      answers = where.data[where.rows - 1];
    } else {
      keys = where.data.map((row) => row[0]);
      answers = where.data.map((row) => row[where.cols - 1]);
    }
    let best = -1;
    for (let i = 0; i < keys.length; i += 1) {
      if (isBlank(keys[i])) continue;
      const result = compare(keys[i], needle);
      if (isError(result)) continue;
      if (typeof keys[i] !== typeof needle) continue;
      if (result <= 0) best = i;
      else break;
    }
    if (best === -1) return ERROR.na;
    return answers[Math.min(best, answers.length - 1)] ?? null;
  },
  FILTER: (args) => {
    const data = blockOf(args[0]);
    const include = blockOf(args[1]);
    const truthy = (v) => !isError(v) && toBoolean(v) === true;
    let out;
    if (include.cols === 1 && include.rows === data.rows) {
      for (const v of include.flat) if (isError(v)) return v;
      out = rowsOf(data).filter((_, r) => truthy(include.data[r][0]));
      out = out.length ? new Matrix(out) : null;
    } else if (include.rows === 1 && include.cols === data.cols) {
      for (const v of include.flat) if (isError(v)) return v;
      const keep = include.data[0].map(truthy);
      const rows = rowsOf(data).map((row) => row.filter((_, c) => keep[c]));
      out = rows[0].length ? new Matrix(rows) : null;
    } else return ERROR.value;
    if (out) return out;
    return args[2] && !args[2].missing ? (args[2].matrix ?? args[2].value) : ERROR.calc;
  },
  SORT: (args) => {
    const data = blockOf(args[0]);
    const index = intArg(args[1], 1);
    const order = intArg(args[2], 1);
    const byColumn = boolArg(args[3], false);
    for (const v of [index, order, byColumn]) if (isError(v)) return v;
    if (order !== 1 && order !== -1) return ERROR.value;
    const source = byColumn ? transpose(data) : data;
    if (index < 1 || index > source.cols) return ERROR.value;
    const rows = rowsOf(source);
    const sorted = new Matrix(sortRows(rows, [{ values: rows.map((row) => row[index - 1]), order }]));
    return byColumn ? transpose(sorted) : sorted;
  },
  SORTBY: (args) => {
    const data = blockOf(args[0]);
    const rows = rowsOf(data);
    const keys = [];
    for (let i = 1; i < args.length; i += 2) {
      const by = blockOf(args[i]);
      const order = intArg(args[i + 1], 1);
      if (isError(order) || (order !== 1 && order !== -1)) return ERROR.value;
      if (by.cols === 1 && by.rows === data.rows) keys.push({ values: by.data.map((row) => row[0]), order });
      else if (by.rows === 1 && by.cols === data.cols) return LOOKUP.SORTBY([{ matrix: transpose(data) }, ...args.slice(1).map((arg, j) => (j % 2 === 0 ? { matrix: transpose(blockOf(arg)) } : arg))]);
      else return ERROR.value;
    }
    if (keys.length === 0) return ERROR.value;
    if (keys.some((k) => k.values.length !== rows.length)) return ERROR.value;
    const sorted = new Matrix(sortRows(rows, keys));
    return data.cols !== rows[0].length ? transpose(sorted) : sorted;
  },
  UNIQUE: (args) => {
    const data = blockOf(args[0]);
    const byColumn = boolArg(args[1], false);
    const once = boolArg(args[2], false);
    if (isError(byColumn) || isError(once)) return ERROR.value;
    const source = byColumn ? transpose(data) : data;
    const rows = rowsOf(source);
    const keyOf = (row) => JSON.stringify(row.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)));
    const counts = new Map();
    for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const k = keyOf(row);
      if (seen.has(k)) continue;
      seen.add(k);
      if (once && counts.get(k) > 1) continue;
      out.push(row);
    }
    if (out.length === 0) return ERROR.calc;
    const result = new Matrix(out);
    return byColumn ? transpose(result) : result;
  },
  CHOOSECOLS: (args) => {
    const data = blockOf(args[0]);
    const picks = [];
    for (const arg of args.slice(1)) {
      for (const v of arg.values) {
        const n = Math.trunc(toNumber(v));
        if (!Number.isFinite(n) || n === 0 || Math.abs(n) > data.cols) return ERROR.value;
        picks.push(n > 0 ? n - 1 : data.cols + n);
      }
    }
    if (picks.length === 0) return ERROR.value;
    return Matrix.of(data.rows, picks.length, (r, c) => data.data[r][picks[c]] ?? null);
  },
  CHOOSEROWS: (args) => {
    const data = blockOf(args[0]);
    const picks = [];
    for (const arg of args.slice(1)) {
      for (const v of arg.values) {
        const n = Math.trunc(toNumber(v));
        if (!Number.isFinite(n) || n === 0 || Math.abs(n) > data.rows) return ERROR.value;
        picks.push(n > 0 ? n - 1 : data.rows + n);
      }
    }
    if (picks.length === 0) return ERROR.value;
    return Matrix.of(picks.length, data.cols, (r, c) => data.data[picks[r]][c] ?? null);
  },
  TAKE: (args) => {
    const data = blockOf(args[0]);
    const rows = intArg(args[1], data.rows);
    const cols = intArg(args[2], data.cols);
    if (isError(rows) || isError(cols) || rows === 0 || cols === 0) return ERROR.calc;
    const r0 = rows > 0 ? 0 : Math.max(0, data.rows + rows);
    const r1 = rows > 0 ? Math.min(data.rows, rows) : data.rows;
    const c0 = cols > 0 ? 0 : Math.max(0, data.cols + cols);
    const c1 = cols > 0 ? Math.min(data.cols, cols) : data.cols;
    return Matrix.of(r1 - r0, c1 - c0, (r, c) => data.data[r0 + r][c0 + c] ?? null);
  },
  DROP: (args) => {
    const data = blockOf(args[0]);
    const rows = intArg(args[1], 0);
    const cols = intArg(args[2], 0);
    if (isError(rows) || isError(cols)) return ERROR.value;
    const r0 = rows > 0 ? rows : 0;
    const r1 = rows < 0 ? data.rows + rows : data.rows;
    const c0 = cols > 0 ? cols : 0;
    const c1 = cols < 0 ? data.cols + cols : data.cols;
    if (r1 <= r0 || c1 <= c0) return ERROR.calc;
    return Matrix.of(r1 - r0, c1 - c0, (r, c) => data.data[r0 + r][c0 + c] ?? null);
  },
  EXPAND: (args) => {
    const data = blockOf(args[0]);
    const rows = intArg(args[1], data.rows);
    const cols = intArg(args[2], data.cols);
    if (isError(rows) || isError(cols)) return ERROR.value;
    if (rows < data.rows || cols < data.cols) return ERROR.value;
    const pad = args[3] && !args[3].missing ? args[3].value : ERROR.na;
    return Matrix.of(rows, cols, (r, c) => (r < data.rows && c < data.cols ? (data.data[r][c] ?? null) : pad));
  },
  HSTACK: (args) => stack(args, true),
  VSTACK: (args) => stack(args, false),
  TOCOL: (args) => {
    const ignore = intArg(args[1], 0);
    const byColumn = boolArg(args[2], false);
    if (isError(ignore) || isError(byColumn)) return ERROR.value;
    const values = lineOf(blockOf(args[0]), ignore, byColumn);
    return values.length ? Matrix.column(values) : ERROR.calc;
  },
  TOROW: (args) => {
    const ignore = intArg(args[1], 0);
    const byColumn = boolArg(args[2], false);
    if (isError(ignore) || isError(byColumn)) return ERROR.value;
    const values = lineOf(blockOf(args[0]), ignore, byColumn);
    return values.length ? new Matrix([values]) : ERROR.calc;
  },
  WRAPROWS: (args) => {
    const data = blockOf(args[0]);
    if (data.rows > 1 && data.cols > 1) return ERROR.value;
    const count = toNumber(args[1]?.value);
    if (isError(count)) return count;
    return wrap(data.flat, count, args[2] && !args[2].missing ? args[2].value : ERROR.na, false);
  },
  WRAPCOLS: (args) => {
    const data = blockOf(args[0]);
    if (data.rows > 1 && data.cols > 1) return ERROR.value;
    const count = toNumber(args[1]?.value);
    if (isError(count)) return count;
    return wrap(data.flat, count, args[2] && !args[2].missing ? args[2].value : ERROR.na, true);
  },
  TEXTSPLIT: (args) => {
    const text = toText(args[0]?.value);
    if (isError(text)) return text;
    const list = (arg) => (!arg || arg.missing ? [] : arg.values.map(toText).filter((t) => !isError(t) && t !== ''));
    const columns = list(args[1]);
    const rowsBy = list(args[2]);
    const ignoreEmpty = boolArg(args[3], false);
    const ignoreCase = intArg(args[4], 0) === 1;
    const pad = args[5] && !args[5].missing ? args[5].value : ERROR.na;
    if (columns.length === 0 && rowsBy.length === 0) return ERROR.value;
    const splitter = (delims) => {
      if (delims.length === 0) return null;
      const escaped = delims.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return new RegExp(escaped.join('|'), ignoreCase ? 'i' : '');
    };
    const byRow = splitter(rowsBy);
    const byCol = splitter(columns);
    let lines = byRow ? text.split(byRow) : [text];
    if (ignoreEmpty) lines = lines.filter((l) => l !== '');
    const cells = lines.map((line) => {
      let parts = byCol ? line.split(byCol) : [line];
      if (ignoreEmpty) parts = parts.filter((p) => p !== '');
      return parts;
    });
    const width = Math.max(1, ...cells.map((row) => row.length));
    return Matrix.of(Math.max(1, cells.length), width, (r, c) => (cells[r]?.[c] !== undefined ? cells[r][c] : pad));
  },
  ADDRESS: (args) => {
    const row = intArg(args[0], null);
    const col = intArg(args[1], null);
    const abs = intArg(args[2], 1);
    const a1 = boolArg(args[3], true);
    for (const v of [row, col, abs, a1]) if (isError(v)) return v;
    if (row === null || col === null || row < 1 || col < 1 || abs < 1 || abs > 4) return ERROR.value;
    const sheet = args[4] && !args[4].missing ? toText(args[4].value) : null;
    let text;
    if (a1) {
      const colPart = (abs === 1 || abs === 3 ? '$' : '') + columnName(col - 1);
      const rowPart = (abs === 1 || abs === 2 ? '$' : '') + row;
      text = colPart + rowPart;
    } else {
      text = `R${abs === 1 || abs === 2 ? row : `[${row}]`}C${abs === 1 || abs === 3 ? col : `[${col}]`}`;
    }
    if (sheet) text = `${/^[A-Za-z_][\w.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!${text}`;
    return text;
  },
  'ERROR.TYPE': (args) => ERROR_TYPES[args[0]?.value] ?? ERROR.na,
  ERRORTYPE: (args) => ERROR_CODES[args[0]?.value] ?? ERROR.na,
  HYPERLINK: (args) => {
    if (args[1] && !args[1].missing) return args[1].value ?? null;
    return args[0]?.value ?? null;
  },
  STYLE: () => 0,
};
