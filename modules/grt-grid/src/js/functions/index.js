/** The library. */

import {
  ERROR, isError, isBlank, toNumber, toText, toBoolean, compare, collectNumbers, typedNumber, Matrix,
} from '../engine/values.js';
import { criterion } from './criteria.js';
import { formatValue } from '../format.js';
import { DATETIME } from './datetime.js';
import { LOOKUP } from './lookup.js';
import { ARRAYS } from './arrays.js';
import { STATISTICS } from './statistics.js';
import { MATHS } from './maths.js';
import { FINANCIAL } from './financial.js';
import { PRICING } from './pricing.js';
import { TEXT as TEXTS } from './text.js';
import { INFORMATION } from './information.js';
import { DATABASE } from './database.js';

/** Functions that must be recomputed on every pass, whatever changed. */
export const VOLATILE = new Set(['RAND', 'RANDBETWEEN', 'TODAY', 'NOW']);

const firstError = (args) => {
  for (const arg of args) {
    if (isError(arg.value)) return arg.value;
    for (const value of arg.values ?? []) if (isError(value)) return value;
  }
  return null;
};

/** Every value the arguments carry, ranges flattened. */
const spread = (args) => args.flatMap((arg) => (arg.values ?? [arg.value]));

/** Numbers from the arguments: the range rule for cells, and typed values read as numbers, as Calc does. */
function numbersOf(args) {
  const out = [];
  for (const arg of args) {
    if (arg.missing) continue;
    if (arg.matrix || arg.reference) {
      const found = collectNumbers(arg.values ?? []);
      if (isError(found)) return found;
      out.push(...found);
    } else {
      const n = typedNumber(arg.value);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** The numbers of the arguments handed to `use`, or the first error among them. */
function withNumbers(args, use) {
  const error = firstError(args);
  if (error) return error;
  const numbers = numbersOf(args);
  return isError(numbers) ? numbers : use(numbers);
}

/** A single number from one argument, refusing text as specifies. */
function numberOf(arg) {
  if (arg === undefined) return 0;
  return toNumber(arg.value);
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  // Nudged before rounding.
  return Math.round((value * factor).toPrecision(15) * 1) / factor;
};

// The library

export const FUNCTIONS = {
  /** Maths. */
  SUM: (args) => withNumbers(args, sumOf),
  PRODUCT: (args) => withNumbers(args, (numbers) => numbers.reduce((a, b) => a * b, 1)),
  ABS: (args) => oneNumber(args, Math.abs),
  SIGN: (args) => oneNumber(args, Math.sign),
  SQRT: (args) => oneNumber(args, (n) => (n < 0 ? ERROR.num : Math.sqrt(n))),
  INT: (args) => oneNumber(args, Math.floor),
  MOD: (args) => twoNumbers(args, (a, b) => (b === 0 ? ERROR.div0 : a - b * Math.floor(a / b))),
  POWER: (args) => twoNumbers(args, (a, b) => guardNumber(a ** b)),
  EXP: (args) => oneNumber(args, Math.exp),
  LN: (args) => oneNumber(args, (n) => (n <= 0 ? ERROR.num : Math.log(n))),
  LOG10: (args) => oneNumber(args, (n) => (n <= 0 ? ERROR.num : Math.log10(n))),

  ROUND: (args) => twoNumbers(args, (n, d) => round(n, Math.trunc(d))),
  ROUNDUP: (args) => twoNumbers(args, (n, d) => {
    const factor = 10 ** Math.trunc(d);
    return (n < 0 ? -Math.ceil(Math.abs(n) * factor) : Math.ceil(n * factor)) / factor;
  }),
  ROUNDDOWN: (args) => twoNumbers(args, (n, d) => {
    const factor = 10 ** Math.trunc(d);
    return (n < 0 ? -Math.floor(Math.abs(n) * factor) : Math.floor(n * factor)) / factor;
  }),
  CEILING: (args) => twoNumbers(args, (n, step) => (step === 0 ? 0 : Math.ceil(n / step) * step)),
  FLOOR: (args) => twoNumbers(args, (n, step) => (step === 0 ? ERROR.div0 : Math.floor(n / step) * step)),
  RAND: () => Math.random(),
  RANDBETWEEN: (args) => twoNumbers(args, (a, b) => (
    Math.floor(Math.random() * (Math.floor(b) - Math.ceil(a) + 1)) + Math.ceil(a)
  )),

  /** Statistics. */
  AVERAGE: (args) => withNumbers(args, (numbers) => (numbers.length === 0 ? ERROR.div0 : sumOf(numbers) / numbers.length)),
  // COUNT reads typed text that is a number, where the others refuse it; text in cells it skips, as they do.
  COUNT: (args) => firstError(args) ?? args.reduce((count, arg) => {
    if (arg.missing) return count;
    if (arg.matrix || arg.reference) return count + collectNumbers(arg.values ?? []).length;
    return count + (isError(toNumber(arg.value)) ? 0 : 1);
  }, 0),
  COUNTA: (args) => (firstError(args) ?? spread(args).filter((v) => !isBlank(v)).length),
  COUNTBLANK: (args) => (firstError(args) ?? spread(args).filter(isBlank).length),
  MIN: (args) => withNumbers(args, (numbers) => (numbers.length === 0 ? 0 : Math.min(...numbers))),
  MAX: (args) => withNumbers(args, (numbers) => (numbers.length === 0 ? 0 : Math.max(...numbers))),
  MEDIAN: (args) => {
    const error = firstError(args);
    if (error) return error;
    const found = numbersOf(args);
    if (isError(found)) return found;
    const sorted = found.sort((a, b) => a - b);
    if (sorted.length === 0) return ERROR.num;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  },
  STDEV: (args) => {
    const error = firstError(args);
    if (error) return error;
    const numbers = numbersOf(args);
    if (isError(numbers)) return numbers;
    if (numbers.length < 2) return ERROR.div0;
    const mean = sumOf(numbers) / numbers.length;
    const variance = sumOf(numbers.map((n) => (n - mean) ** 2)) / (numbers.length - 1);
    return Math.sqrt(variance);
  },

  COUNTIF: (args) => conditional(args, (matched) => matched.length),
  SUMIF: (args) => conditional(args, (matched, sumValues) => (
    sumOf(collectNumbers(sumValues ?? matched))
  )),
  AVERAGEIF: (args) => conditional(args, (matched, sumValues) => {
    const numbers = collectNumbers(sumValues ?? matched);
    return numbers.length === 0 ? ERROR.div0 : sumOf(numbers) / numbers.length;
  }),

  /** Logic. */
  IF: (args) => {
    if (args.length < 2) return ERROR.value;
    const test = toBoolean(args[0].value);
    if (isError(test)) return test;
    if (test) return args[1].value ?? null;
    return args.length > 2 ? (args[2].value ?? null) : false;
  },
  AND: (args) => everyBoolean(args, (list) => list.every(Boolean)),
  OR: (args) => everyBoolean(args, (list) => list.some(Boolean)),
  NOT: (args) => {
    const value = toBoolean(args[0]?.value);
    return isError(value) ? value : !value;
  },
  XOR: (args) => everyBoolean(args, (list) => list.filter(Boolean).length % 2 === 1),
  IFERROR: (args) => (isError(args[0]?.value) ? (args[1]?.value ?? null) : (args[0]?.value ?? null)),
  IFNA: (args) => (args[0]?.value === ERROR.na ? (args[1]?.value ?? null) : (args[0]?.value ?? null)),
  TRUE: () => true,
  FALSE: () => false,
  ISBLANK: (args) => isBlank(args[0]?.value),
  ISNUMBER: (args) => typeof args[0]?.value === 'number',
  ISTEXT: (args) => typeof args[0]?.value === 'string' && !isError(args[0]?.value),
  ISERROR: (args) => isError(args[0]?.value),
  NA: () => ERROR.na,

  /** Text. */
  CONCAT: (args) => {
    const error = firstError(args);
    if (error) return error;
    return spread(args).map(toText).join('');
  },
  CONCATENATE: (args) => FUNCTIONS.CONCAT(args),
  LEFT: (args) => textAnd(args, (text, n) => text.slice(0, Math.max(0, n ?? 1))),
  RIGHT: (args) => textAnd(args, (text, n) => (n === 0 ? '' : text.slice(-Math.max(0, n ?? 1)))),
  MID: (args) => {
    const text = toText(args[0]?.value);
    if (isError(text)) return text;
    const start = numberOf(args[1]);
    const length = numberOf(args[2]);
    if (isError(start) || isError(length)) return ERROR.value;
    if (start < 1) return ERROR.value;
    return text.slice(start - 1, start - 1 + Math.max(0, length));
  },
  LEN: (args) => {
    const text = toText(args[0]?.value);
    return isError(text) ? text : text.length;
  },
  UPPER: (args) => mapText(args, (t) => t.toUpperCase()),
  LOWER: (args) => mapText(args, (t) => t.toLowerCase()),
  PROPER: (args) => mapText(args, (t) => t.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, before, c) => before + c.toUpperCase())),
  TRIM: (args) => mapText(args, (t) => t.trim().replace(/\s+/g, ' ')),
  SUBSTITUTE: (args) => {
    const text = toText(args[0]?.value);
    const find = toText(args[1]?.value);
    const replace = toText(args[2]?.value);
    if (isError(text) || isError(find) || isError(replace)) return ERROR.value;
    if (find === '') return text;
    if (args[3] === undefined || args[3].missing) return text.split(find).join(replace);
    // Only the instance-th occurrence, counted from 1.
    const instance = Math.trunc(numberOf(args[3]));
    if (isError(instance) || instance < 1) return ERROR.value;
    let at = -1;
    for (let i = 0; i < instance; i += 1) {
      at = text.indexOf(find, at + 1);
      if (at === -1) return text;
    }
    return text.slice(0, at) + replace + text.slice(at + find.length);
  },
  FIND: (args) => {
    const needle = toText(args[0]?.value);
    const haystack = toText(args[1]?.value);
    if (isError(needle) || isError(haystack)) return ERROR.value;
    const from = args[2] ? numberOf(args[2]) - 1 : 0;
    const at = haystack.indexOf(needle, Math.max(0, from));
    return at === -1 ? ERROR.value : at + 1;
  },
  EXACT: (args) => toText(args[0]?.value) === toText(args[1]?.value),
  VALUE: (args) => toNumber(args[0]?.value),
  TEXT: (args) => {
    const value = args[0]?.value;
    if (isError(value)) return value;
    if (args[1] === undefined) return toText(value);
    const pattern = toText(args[1].value);
    if (isError(pattern)) return pattern;
    // A number shown as the format says; text goes through @ and is otherwise kept.
    if (typeof value === 'number') return formatValue(value, pattern);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    const text = isBlank(value) ? '' : String(value);
    const parsed = text.trim() !== '' ? Number(text) : NaN;
    if (Number.isFinite(parsed)) return formatValue(parsed, pattern);
    return pattern.includes('@') ? pattern.replace(/"([^"]*)"/g, '$1').replace('@', text) : text;
  },

  /** Days since 1899-12-30, the serial every spreadsheet uses. */
  TODAY: () => dateSerial(new Date()),
  NOW: () => {
    const now = new Date();
    return dateSerial(now) + (now.getHours() * 3600 + now.getMinutes() * 60) / 86400;
  },
  DATE: (args) => {
    const year = numberOf(args[0]);
    const month = numberOf(args[1]);
    const day = numberOf(args[2]);
    if (isError(year) || isError(month) || isError(day)) return ERROR.value;
    return dateSerial(new Date(year, month - 1, day));
  },
  YEAR: (args) => datePart(args, (d) => d.getFullYear()),
  MONTH: (args) => datePart(args, (d) => d.getMonth() + 1),
  DAY: (args) => datePart(args, (d) => d.getDate()),
  WEEKDAY: (args) => {
    const type = args[1] === undefined || args[1].missing ? 1 : Math.trunc(numberOf(args[1]));
    // Where each kind of week starts, and from what number it counts.
    const KINDS = { 1: [0, 1], 2: [1, 1], 3: [1, 0], 11: [1, 1], 12: [2, 1], 13: [3, 1], 14: [4, 1], 15: [5, 1], 16: [6, 1], 17: [0, 1] };
    const kind = KINDS[type];
    if (!kind) return ERROR.num;
    return datePart(args, (d) => ((d.getDay() - kind[0] + 7) % 7) + kind[1]);
  },
  DAYS: (args) => twoNumbers(args, (a, b) => Math.round(a - b)),

  /** Lookup. */
  VLOOKUP: (args) => lookup(args, 'v'),
  HLOOKUP: (args) => lookup(args, 'h'),
  INDEX: (args) => {
    const grid = args[0]?.grid;
    if (!grid) return ERROR.ref;
    const given = (arg) => arg && !arg.missing;
    let row = given(args[1]) ? Math.trunc(numberOf(args[1])) : 0;
    let col = given(args[2]) ? Math.trunc(numberOf(args[2])) : 0;
    if (isError(row) || isError(col)) return ERROR.value;
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    // A single row is indexed by its columns, as a single column is by its rows.
    if (!given(args[2])) {
      if (rows === 1 && cols > 1) { col = row; row = 1; } else if (cols === 1) col = 1;
    }
    if (row < 0 || col < 0 || row > rows || col > cols) return ERROR.ref;
    if (row === 0 && col === 0) return args[0].matrix ?? args[0].value;
    if (row === 0) return Matrix.column(grid.map((line) => line[col - 1] ?? null));
    if (col === 0) return new Matrix([grid[row - 1].map((v) => v ?? null)]);
    return grid[row - 1][col - 1] ?? null;
  },
  MATCH: (args) => {
    const needle = args[0]?.value ?? null;
    const values = args[1]?.values ?? [];
    const mode = args[2] ? Math.trunc(numberOf(args[2])) : 1;

    if (mode === 0) {
      const at = values.findIndex((value) => compare(value, needle) === 0);
      return at === -1 ? ERROR.na : at + 1;
    }

    // Sorted search: the last value not greater than the needle.
    let best = -1;
    for (let i = 0; i < values.length; i += 1) {
      const result = compare(values[i], needle);
      if (isError(result)) return result;
      if (mode > 0 ? result <= 0 : result >= 0) best = i;
    }
    return best === -1 ? ERROR.na : best + 1;
  },
  ROWS: (args) => (args[0]?.grid?.length ?? (args[0]?.values ? args[0].values.length : 1)),
  COLUMNS: (args) => (args[0]?.grid?.[0]?.length ?? 1),
};

// Helpers

function sumOf(numbers) {
  if (isError(numbers)) return numbers;
  return numbers.reduce((a, b) => a + b, 0);
}

function guardNumber(value) {
  return Number.isFinite(value) ? value : ERROR.num;
}

function oneNumber(args, apply) {
  const value = numberOf(args[0]);
  if (isError(value)) return value;
  return guardNumber(apply(value));
}

function twoNumbers(args, apply) {
  const a = numberOf(args[0]);
  const b = numberOf(args[1]);
  if (isError(a)) return a;
  if (isError(b)) return b;
  const result = apply(a, b);
  return isError(result) ? result : guardNumber(result);
}

function mapText(args, apply) {
  const text = toText(args[0]?.value);
  return isError(text) ? text : apply(text);
}

function textAnd(args, apply) {
  const text = toText(args[0]?.value);
  if (isError(text)) return text;
  const n = args[1] ? numberOf(args[1]) : 1;
  return isError(n) ? n : apply(text, Math.trunc(n));
}

function everyBoolean(args, apply) {
  const values = spread(args).filter((v) => !isBlank(v));
  const booleans = [];
  for (const value of values) {
    const result = toBoolean(value);
    if (isError(result)) return result;
    booleans.push(result);
  }
  return booleans.length === 0 ? ERROR.value : apply(booleans);
}

/** How many value-against-condition tests one COUNTIF may make when given a block of conditions. */
const CONDITION_WORK = 20_000_000;

/** The shape shared by COUNTIF, SUMIF and AVERAGEIF. */
function conditional(args, finish) {
  const error = firstError([args[0]].filter(Boolean));
  if (error) return error;

  const values = args[0]?.values ?? [args[0]?.value ?? null];
  // A block of conditions gives a block of answers, one per condition, as Excel 365 does.
  const conditions = args[1]?.matrix;
  if (conditions && conditions.rows * conditions.cols > 1) {
    if (conditions.rows * conditions.cols * values.length > CONDITION_WORK) return ERROR.num;
    return Matrix.of(conditions.rows, conditions.cols, (r, c) => {
      const value = conditions.data[r][c] ?? null;
      return conditional([args[0], { value, values: [value], matrix: null }, ...args.slice(2)], finish);
    });
  }
  const test = criterion(args[1]?.value);
  if (isError(test)) return test;

  const sumValues = args[2]?.values ?? null;

  const matched = [];
  const matchedSums = sumValues ? [] : null;

  values.forEach((value, index) => {
    if (!test(value)) return;
    matched.push(value);
    if (matchedSums) matchedSums.push(sumValues[index] ?? null);
  });

  return finish(matched, matchedSums);
}

function lookup(args, direction) {
  const needle = args[0]?.value ?? null;
  const grid = args[1]?.grid;
  if (!grid || grid.length === 0) return ERROR.ref;

  const index = Math.trunc(numberOf(args[2]));
  if (isError(index) || index < 1) return ERROR.value;

  // The fourth argument defaults to TRUE in Excel; here it defaults to FALSE.
  const approximate = args[3] === undefined ? false : toBoolean(args[3].value) === true;

  const line = (i) => (direction === 'v' ? grid[i] : grid.map((r) => r[i]));
  const outer = direction === 'v' ? grid.length : (grid[0]?.length ?? 0);

  let best = -1;
  for (let i = 0; i < outer; i += 1) {
    const first = direction === 'v' ? grid[i]?.[0] : grid[0]?.[i];
    const result = compare(first, needle);
    if (isError(result)) return result;
    if (result === 0) { best = i; break; }
    if (approximate && result < 0) best = i;
  }

  if (best === -1) return ERROR.na;
  const found = line(best);
  const cell = direction === 'v' ? found?.[index - 1] : found?.[index - 1];
  return cell === undefined ? ERROR.ref : cell;
}

/** Days since 1899-12-30, the serial number every spreadsheet uses. */
function dateSerial(date) {
  const epoch = Date.UTC(1899, 11, 30);
  const at = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((at - epoch) / 86400000);
}

function fromSerial(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial) * 86400000);
}

function datePart(args, apply) {
  const serial = numberOf(args[0]);
  if (isError(serial)) return serial;
  const date = fromSerial(serial);
  return apply(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export { dateSerial, fromSerial };

// The families kept in their own files join the library; a name defined here is not replaced.
for (const family of [DATETIME, LOOKUP, ARRAYS, STATISTICS, MATHS, FINANCIAL, PRICING, TEXTS, INFORMATION, DATABASE]) {
  for (const [name, implementation] of Object.entries(family)) {
    if (!(name in FUNCTIONS)) FUNCTIONS[name] = implementation;
  }
}
