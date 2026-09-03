/** The library. */

import {
  ERROR, isError, isBlank, toNumber, toText, toBoolean, compare, collectNumbers,
} from '../engine/values.js';

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

/** Numbers from the arguments, applying the range rule from values.js. */
function numbersOf(args) {
  const collected = collectNumbers(spread(args));
  return collected;
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
  SUM: (args) => firstError(args) ?? sumOf(numbersOf(args)),
  PRODUCT: (args) => firstError(args) ?? numbersOf(args).reduce((a, b) => a * b, 1),
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
  AVERAGE: (args) => {
    const error = firstError(args);
    if (error) return error;
    const numbers = numbersOf(args);
    return numbers.length === 0 ? ERROR.div0 : sumOf(numbers) / numbers.length;
  },
  COUNT: (args) => (firstError(args) ?? numbersOf(args).length),
  COUNTA: (args) => (firstError(args) ?? spread(args).filter((v) => !isBlank(v)).length),
  COUNTBLANK: (args) => (firstError(args) ?? spread(args).filter(isBlank).length),
  MIN: (args) => {
    const error = firstError(args);
    if (error) return error;
    const numbers = numbersOf(args);
    return numbers.length === 0 ? 0 : Math.min(...numbers);
  },
  MAX: (args) => {
    const error = firstError(args);
    if (error) return error;
    const numbers = numbersOf(args);
    return numbers.length === 0 ? 0 : Math.max(...numbers);
  },
  MEDIAN: (args) => {
    const error = firstError(args);
    if (error) return error;
    const sorted = numbersOf(args).sort((a, b) => a - b);
    if (sorted.length === 0) return ERROR.num;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  },
  STDEV: (args) => {
    const error = firstError(args);
    if (error) return error;
    const numbers = numbersOf(args);
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
  PROPER: (args) => mapText(args, (t) => t.replace(/\b\w/g, (c) => c.toUpperCase())),
  TRIM: (args) => mapText(args, (t) => t.trim().replace(/\s+/g, ' ')),
  SUBSTITUTE: (args) => {
    const text = toText(args[0]?.value);
    const find = toText(args[1]?.value);
    const replace = toText(args[2]?.value);
    if (isError(text) || isError(find) || isError(replace)) return ERROR.value;
    if (find === '') return text;
    return text.split(find).join(replace);
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
  TEXT: (args) => toText(args[0]?.value),

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
  WEEKDAY: (args) => datePart(args, (d) => d.getDay() + 1),
  DAYS: (args) => twoNumbers(args, (a, b) => Math.round(a - b)),

  /** Lookup. */
  VLOOKUP: (args) => lookup(args, 'v'),
  HLOOKUP: (args) => lookup(args, 'h'),
  INDEX: (args) => {
    const grid = args[0]?.grid;
    if (!grid) return ERROR.ref;
    const row = Math.trunc(numberOf(args[1]));
    const col = args[2] ? Math.trunc(numberOf(args[2])) : 1;
    if (isError(row) || isError(col)) return ERROR.value;
    const line = grid[row - 1];
    if (!line) return ERROR.ref;
    const found = line[col - 1];
    return found === undefined ? ERROR.ref : found;
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

/** The shape shared by COUNTIF, SUMIF and AVERAGEIF. */
function conditional(args, finish) {
  const error = firstError([args[0]].filter(Boolean));
  if (error) return error;

  const values = args[0]?.values ?? [args[0]?.value ?? null];
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

function criterion(raw) {
  if (isError(raw)) return raw;

  if (typeof raw === 'string') {
    const match = /^(<=|>=|<>|=|<|>)\s*(.*)$/.exec(raw.trim());
    if (match) {
      const [, operator, text] = match;
      const wanted = text === '' ? null : (Number.isFinite(Number(text)) ? Number(text) : text);
      return (value) => {
        const result = compare(value, wanted);
        if (isError(result)) return false;
        switch (operator) {
          case '<': return result < 0;
          case '<=': return result <= 0;
          case '>': return result > 0;
          case '>=': return result >= 0;
          case '<>': return result !== 0;
          default: return result === 0;
        }
      };
    }
  }

  return (value) => compare(value, raw) === 0;
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
