/** The statistics people use every day: spreads, ranks, percentiles, and conditions on several ranges. */

import { ERROR, isError, isBlank, toNumber, collectNumbers, Matrix } from '../engine/values.js';
import { criterion } from './criteria.js';

const blockOf = (arg) => (arg?.matrix ?? new Matrix([[arg?.value ?? null]]));

/** Numbers from every argument, the range rule applied to ranges and the direct one to typed values. */
function numbers(args) {
  const out = [];
  for (const arg of args) {
    if (arg.missing) continue;
    if (arg.matrix) {
      const found = collectNumbers(arg.matrix.flat);
      if (isError(found)) return found;
      out.push(...found);
    } else {
      const n = toNumber(arg.value);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Numbers as the A functions take them: text in a range counts as 0, TRUE as 1. */
function numbersA(args) {
  const out = [];
  for (const arg of args) {
    if (arg.missing) continue;
    for (const v of arg.matrix ? arg.matrix.flat : [arg.value]) {
      if (isError(v)) return v;
      if (isBlank(v)) continue;
      if (typeof v === 'number') out.push(v);
      else if (typeof v === 'boolean') out.push(v ? 1 : 0);
      else if (arg.matrix) out.push(0);
      else {
        const n = toNumber(v);
        if (isError(n)) return n;
        out.push(n);
      }
    }
  }
  return out;
}

const sum = (list) => list.reduce((a, b) => a + b, 0);
const mean = (list) => sum(list) / list.length;

function variance(list, sample) {
  if (isError(list)) return list;
  if (list.length < (sample ? 2 : 1)) return ERROR.div0;
  const m = mean(list);
  return sum(list.map((v) => (v - m) ** 2)) / (list.length - (sample ? 1 : 0));
}

const deviation = (list, sample) => {
  const v = variance(list, sample);
  return isError(v) ? v : Math.sqrt(v);
};

/** The value at fraction p of the sorted list, interpolated as PERCENTILE.INC does. */
function percentile(list, p) {
  if (isError(list)) return list;
  if (list.length === 0 || p < 0 || p > 1) return ERROR.num;
  const sorted = [...list].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

function kth(args, largest) {
  const list = numbers([args[0]]);
  if (isError(list)) return list;
  const ks = args[1]?.matrix ? args[1].matrix : null;
  const sorted = [...list].sort((a, b) => (largest ? b - a : a - b));
  const pick = (kRaw) => {
    const k = Math.ceil(toNumber(kRaw));
    if (!Number.isFinite(k) || k < 1 || k > sorted.length) return ERROR.value;
    return sorted[k - 1];
  };
  if (ks && ks.rows * ks.cols > 1) return Matrix.of(ks.rows, ks.cols, (r, c) => pick(ks.data[r][c]));
  return pick(args[1]?.value);
}

/** The cells that meet every condition, as indices into the first range. */
function matchingIndices(pairsArgs, size) {
  const tests = [];
  for (let i = 0; i < pairsArgs.length; i += 2) {
    const range = blockOf(pairsArgs[i]).flat;
    if (range.length !== size) return ERROR.value;
    const test = criterion(pairsArgs[i + 1]?.value ?? null);
    if (isError(test)) return test;
    tests.push([range, test]);
  }
  const out = [];
  for (let i = 0; i < size; i += 1) if (tests.every(([range, test]) => test(range[i] ?? null))) out.push(i);
  return out;
}

function conditional(target, pairsArgs, finish) {
  if (pairsArgs.length === 0 || pairsArgs.length % 2 !== 0) return ERROR.value;
  const values = blockOf(target).flat;
  const hits = matchingIndices(pairsArgs, values.length);
  if (isError(hits)) return hits;
  const found = [];
  for (const i of hits) {
    const v = values[i];
    if (isError(v)) return v;
    if (typeof v === 'number') found.push(v);
  }
  return finish(found);
}

/** The most frequent value; among equals, the one met first. */
function mode(list) {
  if (isError(list)) return list;
  const counts = new Map();
  let best = null;
  let bestCount = 1;
  for (const v of list) {
    const count = (counts.get(v) ?? 0) + 1;
    counts.set(v, count);
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best === null ? ERROR.value : best;
}

function rank(args) {
  const value = toNumber(args[0]?.value);
  if (isError(value)) return value;
  const list = numbers([args[1]]);
  if (isError(list)) return list;
  const ascending = args[2] && !args[2].missing ? toNumber(args[2].value) !== 0 : false;
  if (!list.includes(value)) return ERROR.na;
  return list.filter((v) => (ascending ? v < value : v > value)).length + 1;
}

/** The function SUBTOTAL applies, by its number; 101 and up also skip rows hidden by hand. */
const SUBTOTAL_FUNCTIONS = {
  1: (l) => (l.length ? mean(l) : ERROR.div0),
  2: (l) => l.length,
  3: (l, all) => all,
  4: (l) => (l.length ? Math.max(...l) : 0),
  5: (l) => (l.length ? Math.min(...l) : 0),
  6: (l) => l.reduce((a, b) => a * b, 1),
  7: (l) => deviation(l, true),
  8: (l) => deviation(l, false),
  9: (l) => sum(l),
  10: (l) => variance(l, true),
  11: (l) => variance(l, false),
};

function subtotal(args, context) {
  const code = Math.trunc(toNumber(args[0]?.value));
  const apply = SUBTOTAL_FUNCTIONS[code > 100 ? code - 100 : code];
  if (!apply) return ERROR.value;
  const values = [];
  let filled = 0;
  for (const arg of args.slice(1)) {
    const origin = arg.matrix?.origin;
    if (!origin) {
      const n = toNumber(arg.value);
      if (isError(n)) return n;
      values.push(n);
      filled += 1;
      continue;
    }
    for (let r = origin.top; r <= origin.bottom; r += 1) {
      // Filtered rows never count; rows hidden by hand do not count for 101 and up.
      if (context?.isFiltered?.(origin.sheetId, r)) continue;
      if (code > 100 && context?.isHidden?.(origin.sheetId, r)) continue;
      for (let c = origin.left; c <= origin.right; c += 1) {
        // Other subtotals are left out, so a grand total does not count them twice.
        if (/\bSUBTOTAL\s*\(/i.test(context?.formulaAt?.(origin.sheetId, r, c) ?? '')) continue;
        const v = arg.matrix.data[r - origin.top][c - origin.left];
        if (isError(v)) return v;
        if (!isBlank(v)) filled += 1;
        if (typeof v === 'number') values.push(v);
      }
    }
  }
  return apply(values, filled);
}

export const STATISTICS = {
  SUBTOTAL: subtotal,
  AVERAGEA: (args) => { const l = numbersA(args); return isError(l) ? l : l.length === 0 ? ERROR.div0 : mean(l); },
  MAXA: (args) => { const l = numbersA(args); return isError(l) ? l : l.length === 0 ? 0 : Math.max(...l); },
  MINA: (args) => { const l = numbersA(args); return isError(l) ? l : l.length === 0 ? 0 : Math.min(...l); },
  VAR: (args) => variance(numbers(args), true),
  'VAR.S': (args) => variance(numbers(args), true),
  VARP: (args) => variance(numbers(args), false),
  'VAR.P': (args) => variance(numbers(args), false),
  'STDEV.S': (args) => deviation(numbers(args), true),
  STDEVP: (args) => deviation(numbers(args), false),
  'STDEV.P': (args) => deviation(numbers(args), false),
  LARGE: (args) => kth(args, true),
  SMALL: (args) => kth(args, false),
  MODE: (args) => mode(numbers(args)),
  'MODE.SNGL': (args) => mode(numbers(args)),
  PERCENTILE: (args) => percentile(numbers([args[0]]), toNumber(args[1]?.value)),
  'PERCENTILE.INC': (args) => percentile(numbers([args[0]]), toNumber(args[1]?.value)),
  QUARTILE: (args) => {
    const q = Math.trunc(toNumber(args[1]?.value));
    return q < 0 || q > 4 ? ERROR.num : percentile(numbers([args[0]]), q / 4);
  },
  'QUARTILE.INC': (args) => {
    const q = Math.trunc(toNumber(args[1]?.value));
    return q < 0 || q > 4 ? ERROR.num : percentile(numbers([args[0]]), q / 4);
  },
  RANK: rank,
  'RANK.EQ': rank,
  CORREL: (args) => {
    const a = blockOf(args[0]).flat;
    const b = blockOf(args[1]).flat;
    if (a.length !== b.length) return ERROR.na;
    const x = [];
    const y = [];
    for (let i = 0; i < a.length; i += 1) {
      if (isError(a[i])) return a[i];
      if (isError(b[i])) return b[i];
      if (typeof a[i] === 'number' && typeof b[i] === 'number') { x.push(a[i]); y.push(b[i]); }
    }
    if (x.length < 2) return ERROR.div0;
    const mx = mean(x);
    const my = mean(y);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < x.length; i += 1) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    return sxx === 0 || syy === 0 ? ERROR.div0 : sxy / Math.sqrt(sxx * syy);
  },
  COUNTIFS: (args) => {
    if (args.length === 0 || args.length % 2 !== 0) return ERROR.value;
    const hits = matchingIndices(args, blockOf(args[0]).flat.length);
    return isError(hits) ? hits : hits.length;
  },
  AVERAGEIFS: (args) => conditional(args[0], args.slice(1), (found) => (found.length === 0 ? ERROR.div0 : mean(found))),
  MAXIFS: (args) => conditional(args[0], args.slice(1), (found) => (found.length === 0 ? 0 : Math.max(...found))),
  MINIFS: (args) => conditional(args[0], args.slice(1), (found) => (found.length === 0 ? 0 : Math.min(...found))),
  SUMIFS: (args) => conditional(args[0], args.slice(1), (found) => sum(found)),
};
