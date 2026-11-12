/** Mathematics: angles, rounding as Calc and Excel each do it, whole numbers, bits, and the old euro currencies. */

import { ERROR, isError, isBlank, toNumber, toText, toBoolean, collectNumbers, typedNumber, Matrix } from '../engine/values.js';
import { FUNCTIONS } from './index.js';

/** One number from an argument; a missing one takes the fallback. */
function numberArg(arg, fallback = null) {
  if (arg === undefined || arg.missing) return fallback === null ? ERROR.value : fallback;
  if (arg.matrix && arg.matrix.rows * arg.matrix.cols === 1) return toNumber(arg.matrix.first);
  return toNumber(arg.value);
}

/** The arguments as numbers, or the first error. */
function numbersIn(args, fallbacks = []) {
  const out = [];
  for (let i = 0; i < Math.max(args.length, fallbacks.length); i += 1) {
    const n = numberArg(args[i], fallbacks[i] ?? null);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

const finite = (value) => (Number.isFinite(value) ? value : ERROR.num);

/** A function of one number. */
const one = (apply) => (args) => {
  const n = numberArg(args[0]);
  if (isError(n)) return n;
  const result = apply(n);
  return isError(result) ? result : finite(result);
};

/** A function of fixed arguments, some with defaults. */
const fixed = (count, fallbacks, apply) => (args) => {
  if (args.length > count) return ERROR.value;
  const values = numbersIn(args.slice(0, count), fallbacks);
  if (isError(values)) return values;
  const result = apply(...values);
  return isError(result) ? result : finite(result);
};

/** Every number the arguments carry, ranges by the range rule, typed values directly. */
function allNumbers(args) {
  const out = [];
  for (const arg of args) {
    if (arg.missing) continue;
    if (arg.matrix || arg.reference) {
      const found = collectNumbers(arg.matrix ? arg.matrix.flat : arg.values);
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

/** A multiple of a step: the quotient rounded by `how`, the step's sign kept. */
const multiple = (n, step, how) => {
  const quotient = n / step;
  // A quotient a hair from a whole number is that number, as spreadsheets round to 15 digits.
  const near = Math.round(quotient);
  const q = Math.abs(quotient - near) < 1e-12 * Math.max(1, Math.abs(quotient)) ? near : how(quotient);
  return q * step;
};

const factorial = (n) => {
  let out = 1;
  for (let i = 2; i <= n; i += 1) out *= i;
  return out;
};

const gcd = (a, b) => {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return x;
};

/** The largest whole number the bit functions take, as in both programs: 2^48. */
const BITS = 2 ** 48;
const bitArgs = (args, apply) => {
  const values = numbersIn(args.slice(0, 2));
  if (isError(values)) return values;
  const whole = values.map(Math.trunc);
  if (args.length !== 2 || whole.some((v) => v < 0 || v >= BITS)) return ERROR.num;
  return apply(...whole.map(BigInt));
};

/** Rounded to significant digits, without the binary noise a plain toPrecision leaves. */
const significant = (n, digits) => (n === 0 ? 0 : Number(n.toPrecision(Math.min(100, digits))));

/** The rates fixed when each currency joined the euro, and the decimals it is shown with. */
const EURO = {
  EUR: [1, 2], ATS: [13.7603, 2], BEF: [40.3399, 0], DEM: [1.95583, 2], ESP: [166.386, 0], FIM: [5.94573, 2],
  FRF: [6.55957, 2], IEP: [0.787564, 2], ITL: [1936.27, 0], LUF: [40.3399, 0], NLG: [2.20371, 2], PTE: [200.482, 2],
  GRD: [340.75, 2], SIT: [239.64, 2], MTL: [0.4293, 2], CYP: [0.585274, 2], SKK: [30.126, 2], EEK: [15.6466, 2],
  LVL: [0.702804, 2], LTL: [3.4528, 2], HRK: [7.5345, 2],
};

const roundTo = (n, digits) => {
  const factor = 10 ** digits;
  return Math.round(Number((Math.abs(n) * factor).toPrecision(15))) / factor * Math.sign(n);
};

/** What AGGREGATE's first argument names, applied to the values it kept. */
const AGGREGATES = {
  1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV.S', 8: 'STDEV.P', 9: 'SUM',
  10: 'VAR.S', 11: 'VAR.P', 12: 'MEDIAN', 13: 'MODE.SNGL', 14: 'LARGE', 15: 'SMALL', 16: 'PERCENTILE.INC',
  17: 'QUARTILE.INC', 18: 'PERCENTILE.EXC', 19: 'QUARTILE.EXC',
};

const asArgument = (values) => {
  const matrix = Matrix.column(values.length ? values : [null]);
  return { value: matrix.first, values: matrix.flat, grid: matrix.data, matrix };
};

function aggregate(args, context) {
  const code = Math.trunc(toNumber(args[0]?.value));
  const options = args[1] === undefined || args[1].missing ? 0 : Math.trunc(toNumber(args[1].value));
  const name = AGGREGATES[code];
  if (!name || !FUNCTIONS[name] || !Number.isInteger(options) || options < 0 || options > 7) return ERROR.num;
  // Options 0 to 3 skip other SUBTOTAL and AGGREGATE results; 1, 3, 5 and 7 hidden rows; 2, 3, 6 and 7 errors.
  const skipNested = options <= 3;
  const skipHidden = [1, 3, 5, 7].includes(options);
  const skipErrors = [2, 3, 6, 7].includes(options);
  const ranked = code >= 14;
  const sources = ranked ? args.slice(2, 3) : args.slice(2);
  if (sources.length === 0 || (ranked && args.length < 4)) return ERROR.value;
  const kept = [];
  for (const arg of sources) {
    const origin = arg.matrix?.origin;
    if (!origin) {
      for (const v of arg.matrix ? arg.matrix.flat : [arg.value]) {
        if (isError(v) && skipErrors) continue;
        kept.push(v);
      }
      continue;
    }
    for (let r = origin.top; r <= origin.bottom; r += 1) {
      if (context?.isFiltered?.(origin.sheetId, r)) continue;
      if (skipHidden && context?.isHidden?.(origin.sheetId, r)) continue;
      for (let c = origin.left; c <= origin.right; c += 1) {
        if (skipNested && /\b(SUBTOTAL|AGGREGATE)\s*\(/i.test(context?.formulaAt?.(origin.sheetId, r, c) ?? '')) continue;
        const v = arg.matrix.data[r - origin.top][c - origin.left];
        if (isError(v) && skipErrors) continue;
        kept.push(v);
      }
    }
  }
  if (!skipErrors) {
    const error = kept.find(isError);
    if (error) return error;
  }
  const values = code === 3 ? kept.filter((v) => !isBlank(v)) : kept.filter((v) => typeof v === 'number');
  const rest = ranked ? [args[3]] : [];
  return FUNCTIONS[name]([asArgument(values), ...rest], context);
}

export const MATHS = {
  PI: () => Math.PI,
  SIN: one(Math.sin),
  COS: one(Math.cos),
  TAN: one(Math.tan),
  COT: one((n) => (n === 0 ? ERROR.num : 1 / Math.tan(n))),
  SEC: one((n) => 1 / Math.cos(n)),
  CSC: one((n) => (n === 0 ? ERROR.num : 1 / Math.sin(n))),
  ASIN: one((n) => (Math.abs(n) > 1 ? ERROR.num : Math.asin(n))),
  ACOS: one((n) => (Math.abs(n) > 1 ? ERROR.num : Math.acos(n))),
  ATAN: one(Math.atan),
  ACOT: one((n) => Math.PI / 2 - Math.atan(n)),
  ATAN2: fixed(2, [], (x, y) => Math.atan2(y, x)),
  SINH: one(Math.sinh),
  COSH: one(Math.cosh),
  TANH: one(Math.tanh),
  COTH: one((n) => (n === 0 ? ERROR.num : 1 / Math.tanh(n))),
  SECH: one((n) => 1 / Math.cosh(n)),
  CSCH: one((n) => (n === 0 ? ERROR.num : 1 / Math.sinh(n))),
  ASINH: one(Math.asinh),
  ACOSH: one((n) => (n < 1 ? ERROR.num : Math.acosh(n))),
  ATANH: one((n) => (Math.abs(n) >= 1 ? ERROR.num : Math.atanh(n))),
  ACOTH: one((n) => (Math.abs(n) <= 1 ? ERROR.num : 0.5 * Math.log((n + 1) / (n - 1)))),
  DEGREES: one((n) => (n * 180) / Math.PI),
  RADIANS: one((n) => (n * Math.PI) / 180),

  SQRTPI: one((n) => (n < 0 ? ERROR.num : Math.sqrt(n * Math.PI))),
  LOG: fixed(2, [null, 10], (n, base) => {
    if (n <= 0 || base <= 0) return ERROR.num;
    if (base === 1) return ERROR.num;
    return Math.log(n) / Math.log(base);
  }),
  FACT: one((n) => (n < 0 ? ERROR.num : n > 170 ? ERROR.value : factorial(Math.trunc(n)))),
  COMBIN: fixed(2, [], (n, k) => {
    const a = Math.trunc(n);
    const b = Math.trunc(k);
    if (a < 0 || b < 0 || b > a) return ERROR.num;
    let out = 1;
    for (let i = 1; i <= Math.min(b, a - b); i += 1) out = (out * (a - i + 1)) / i;
    return Math.round(out);
  }),
  COMBINA: fixed(2, [], (n, k) => {
    const a = Math.trunc(n);
    const b = Math.trunc(k);
    if (a < 0 || b < 0) return ERROR.num;
    if (a === 0) return 0;
    return MATHS.COMBIN([{ value: a + b - 1 }, { value: b }]);
  }),
  MULTINOMIAL: (args) => {
    const values = allNumbers(args);
    if (isError(values)) return values;
    let total = 0;
    let out = 1;
    for (const v of values.map(Math.trunc)) {
      if (v < 0) return ERROR.num;
      for (let i = 1; i <= v; i += 1) out = (out * (total + i)) / i;
      total += v;
    }
    return finite(Math.round(out));
  },
  GCD: (args) => {
    const values = allNumbers(args);
    if (isError(values)) return values;
    if (values.some((v) => v < 0)) return ERROR.num;
    return values.map(Math.trunc).reduce(gcd, 0);
  },
  LCM: (args) => {
    const values = allNumbers(args);
    if (isError(values)) return values;
    if (values.some((v) => v < 0)) return ERROR.num;
    return finite(values.map(Math.trunc).reduce((a, b) => (a === 0 || b === 0 ? 0 : (a * b) / gcd(a, b)), 1));
  },
  QUOTIENT: fixed(2, [], (n, d) => (d === 0 ? ERROR.num : Math.trunc(n / d))),
  RAWSUBTRACT: (args) => {
    const values = numbersIn(args);
    if (isError(values)) return values;
    if (values.length === 0) return ERROR.value;
    return finite(values.slice(1).reduce((a, b) => a - b, values[0]));
  },
  SUMSQ: (args) => {
    const values = allNumbers(args);
    return isError(values) ? values : finite(values.reduce((a, b) => a + b * b, 0));
  },
  SERIESSUM: (args) => {
    const values = numbersIn(args.slice(0, 3));
    if (isError(values)) return values;
    const [x, n, m] = values;
    const coefficients = allNumbers(args.slice(3, 4));
    if (isError(coefficients)) return coefficients;
    if (args.length !== 4) return ERROR.value;
    return finite(coefficients.reduce((sum, a, i) => sum + a * x ** (n + i * m), 0));
  },

  TRUNC: fixed(2, [null, 0], (n, digits) => {
    const factor = 10 ** Math.trunc(digits);
    return Math.trunc(Number((n * factor).toPrecision(15))) / factor;
  }),
  ROUNDSIG: fixed(2, [], (n, digits) => (digits < 1 || digits > 15 ? ERROR.num : significant(n, Math.trunc(digits)))),
  EVEN: one((n) => {
    const up = Math.ceil(Math.abs(n));
    return Math.sign(n) * (up % 2 === 0 ? up : up + 1);
  }),
  ODD: one((n) => {
    const up = Math.ceil(Math.abs(n));
    return (n < 0 ? -1 : 1) * (up % 2 === 1 ? up : up + 1);
  }),
  MROUND: fixed(2, [], (n, m) => {
    if (m === 0) return 0;
    return multiple(n, m, (q) => Math.round(q));
  }),
  'CEILING.PRECISE': fixed(2, [null, 1], (n, step) => (step === 0 ? 0 : multiple(n, Math.abs(step), Math.ceil))),
  'ISO.CEILING': fixed(2, [null, 1], (n, step) => (step === 0 ? 0 : multiple(n, Math.abs(step), Math.ceil))),
  'FLOOR.PRECISE': fixed(2, [null, 1], (n, step) => (step === 0 ? 0 : multiple(n, Math.abs(step), Math.floor))),
  'CEILING.MATH': fixed(3, [null, 1, 0], (n, step, mode) => {
    if (step === 0) return 0;
    const s = Math.abs(step);
    return n < 0 && mode !== 0 ? multiple(n, s, Math.floor) : multiple(n, s, Math.ceil);
  }),
  'FLOOR.MATH': fixed(3, [null, 1, 0], (n, step, mode) => {
    if (step === 0) return 0;
    const s = Math.abs(step);
    return n < 0 && mode !== 0 ? multiple(n, s, Math.ceil) : multiple(n, s, Math.floor);
  }),
  'CEILING.XCL': fixed(2, [], (n, step) => {
    if (n === 0 || step === 0) return 0;
    if (n > 0 && step < 0) return ERROR.num;
    // A negative step takes a negative number away from zero.
    return step < 0 ? multiple(n, step, Math.ceil) : multiple(n, step, Math.ceil);
  }),
  'FLOOR.XCL': fixed(2, [], (n, step) => {
    if (n === 0) return 0;
    if (step === 0) return ERROR.num;
    if (n > 0 && step < 0) return ERROR.num;
    return multiple(n, step, Math.floor);
  }),

  BITAND: (args) => bitArgs(args, (a, b) => Number(a & b)),
  BITOR: (args) => bitArgs(args, (a, b) => Number(a | b)),
  BITXOR: (args) => bitArgs(args, (a, b) => Number(a ^ b)),
  BITLSHIFT: (args) => shift(args, 1),
  BITRSHIFT: (args) => shift(args, -1),

  'RAND.NV': () => Math.random(),
  'RANDBETWEEN.NV': fixed(2, [], (a, b) => {
    const low = Math.ceil(a);
    const high = Math.floor(b);
    return high < low ? ERROR.num : low + Math.floor(Math.random() * (high - low + 1));
  }),
  RANDARRAY: (args) => {
    const values = numbersIn(args.slice(0, 4), [1, 1, 0, 1]);
    if (isError(values)) return values;
    const [rows, cols, low, high] = values.map((v, i) => (i < 2 ? Math.trunc(v) : v));
    const whole = args[4] && !args[4].missing ? toBoolean(args[4].value) : false;
    if (isError(whole)) return whole;
    if (rows < 1 || cols < 1 || high < low || rows * cols > 1_000_000) return ERROR.value;
    if (whole && (!Number.isInteger(low) || !Number.isInteger(high))) return ERROR.value;
    return Matrix.of(rows, cols, () => (whole ? low + Math.floor(Math.random() * (high - low + 1)) : low + Math.random() * (high - low)));
  },

  COLOR: fixed(4, [null, null, null, 0], (r, g, b, a) => {
    const parts = [r, g, b, a].map(Math.trunc);
    if (parts.some((p) => p < 0 || p > 255)) return ERROR.num;
    return parts[3] * 2 ** 24 + parts[0] * 65536 + parts[1] * 256 + parts[2];
  }),
  EUROCONVERT: (args) => {
    const value = numberArg(args[0]);
    if (isError(value)) return value;
    const from = EURO[String(toText(args[1]?.value)).toUpperCase()];
    const to = EURO[String(toText(args[2]?.value)).toUpperCase()];
    if (!from || !to) return ERROR.num;
    const full = args[3] && !args[3].missing ? toBoolean(args[3].value) === true : false;
    const triangulation = args[4] && !args[4].missing ? Math.trunc(toNumber(args[4].value)) : null;
    if (triangulation !== null && (isError(triangulation) || triangulation < 3)) return ERROR.value;
    let euros = value / from[0];
    if (triangulation !== null && from[0] !== 1 && to[0] !== 1) euros = roundTo(euros, triangulation);
    const result = euros * to[0];
    return full ? result : roundTo(result, to[1]);
  },
  CONVERT_OOO: (args) => {
    const value = numberArg(args[0]);
    if (isError(value)) return value;
    const from = EURO[String(toText(args[1]?.value)).toUpperCase()];
    const to = EURO[String(toText(args[2]?.value)).toUpperCase()];
    if (!from || !to) return ERROR.value;
    return finite((value / from[0]) * to[0]);
  },

  AGGREGATE: aggregate,
};

function shift(args, direction) {
  const values = numbersIn(args.slice(0, 2));
  if (isError(values)) return values;
  const [n, by] = values;
  if (args.length !== 2 || n < 0 || n >= BITS || Math.abs(by) > 53) return ERROR.num;
  const amount = Math.trunc(by) * direction;
  const value = BigInt(Math.trunc(n));
  const result = amount >= 0 ? value << BigInt(amount) : value >> BigInt(-amount);
  return result > BigInt(Number.MAX_SAFE_INTEGER) ? ERROR.num : Number(result);
}

// Excel 2003's versions are the same sums.
MATHS.GCD_EXCEL2003 = MATHS.GCD;
MATHS.LCM_EXCEL2003 = MATHS.LCM;
