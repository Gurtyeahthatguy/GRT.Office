/** Calc's statistical functions: distributions and their inverses, the tests, and the measures of a sample, as LibreOffice works them out. */

import { ERROR, isError, isBlank, toNumber, toBoolean, collectNumbers, typedNumber, Matrix } from '../engine/values.js';
import { erf, erfc, normal, density } from './special.js';

// Special functions, to full double precision

const EPS = 1e-15;
// Lanczos' approximation with g = 7 and nine terms, good to about one part in 10^15.
const LANCZOS_G = 7;
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const HALF_LOG_TWO_PI = 0.91893853320467274178;

/** Lanczos' series at z, for z ≥ 0.5. */
function lanczosSeries(z) {
  const x = z - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i += 1) a += LANCZOS[i] / (x + i);
  return a;
}

/** ln Γ(x) for x > 0, reflected below one half. */
export function lnGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const t = x - 1 + LANCZOS_G + 0.5;
  return HALF_LOG_TWO_PI + (x - 0.5) * Math.log(t) - t + Math.log(lanczosSeries(x));
}

/** Γ(x), exact on whole numbers, negative non-integers by reflection. */
export function gamma(x) {
  if (Number.isInteger(x) && x > 0 && x <= 171) {
    let out = 1;
    for (let i = 2; i < x; i += 1) out *= i;
    return out;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  if (x > 171.7) return Infinity;
  const t = x - 1 + LANCZOS_G + 0.5;
  // Split in two so a large argument does not overflow before the division by e^t.
  const half = t ** ((x - 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * half * (half * Math.exp(-t)) * lanczosSeries(x);
}

/** The regularised lower incomplete gamma P(a, x). */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 10000; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - lnGamma(a)));
  }
  return 1 - gammaQ(a, x);
}

/** The regularised upper incomplete gamma Q(a, x). */
export function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaP(a, x);
  // Lentz's continued fraction.
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

const lnBeta = (a, b) => lnGamma(a) + lnGamma(b) - lnGamma(a + b);

/** The continued fraction of the incomplete beta. */
function betaFraction(a, b, x) {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10000; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** The regularised incomplete beta I_x(a, b). */
export function betaI(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - lnBeta(a, b));
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(a, b, x)) / a;
  return 1 - (front * betaFraction(b, a, 1 - x)) / b;
}

/** The point where an increasing function reaches a value, found inside a bracket by bisection and secant steps. */
function inverse(f, target, low, high) {
  let a = low;
  let b = high;
  let fa = f(a) - target;
  let fb = f(b) - target;
  // Widen the bracket upward until it holds the root.
  for (let i = 0; i < 2000 && fa * fb > 0; i += 1) {
    a = b;
    fa = fb;
    b *= 2;
    fb = f(b) - target;
    if (!Number.isFinite(b)) return ERROR.num;
  }
  if (fa * fb > 0) return ERROR.num;
  // The Pegasus method: regula falsi with the stale end's value scaled.
  for (let i = 0; i < 2000; i += 1) {
    const x = b - (fb * (b - a)) / (fb - fa);
    const fx = f(x) - target;
    if (fx === 0 || Math.abs(b - a) <= Number.EPSILON * Math.abs(x)) return x;
    if (fx * fb < 0) { a = b; fa = fb; } else fa *= fb / (fb + fx);
    b = x;
    fb = fx;
    if (Math.abs(fb) < 1e-300) return b;
  }
  return b;
}

/** The inverse of the standard normal, by Wichura's AS 241. */
export function normalInverse(p) {
  if (p <= 0 || p >= 1) return ERROR.num;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return q * (((((((r * 2509.0809287301226727 + 33430.575583588128105) * r + 67265.770927008700853) * r + 45921.953931549871457) * r
      + 13731.693765509461125) * r + 1971.5909503065514427) * r + 133.14166789178437745) * r + 3.387132872796366608)
      / (((((((r * 5226.495278852545925 + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r
        + 5394.1960214247511077) * r + 687.1870074920579083) * r + 42.313330701600911252) * r + 1);
  }
  let r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let value;
  if (r <= 5) {
    r -= 1.6;
    value = (((((((r * 7.7454501427834140764e-4 + 0.0227238449892691845833) * r + 0.24178072517745061177) * r + 1.27045825245236838258) * r
      + 3.64784832476320460504) * r + 5.7694972214606914055) * r + 4.6303378461565452959) * r + 1.42343711074968357734)
      / (((((((r * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r + 0.14810397642748007459) * r
        + 0.68976733498510000455) * r + 1.6763848301838038494) * r + 2.05319162663775882187) * r + 1);
  } else {
    r -= 5;
    value = (((((((r * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r + 0.026532189526576123093) * r
      + 0.29656057182850489123) * r + 1.7848265399172913358) * r + 5.4637849111641143699) * r + 6.6579046435011037772)
      / (((((((r * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r + 7.868691311456132591e-4) * r
        + 0.0148753612908506148525) * r + 0.13692988092273580531) * r + 0.59983220655588793769) * r + 1);
  }
  return q < 0 ? -value : value;
}

// Distributions

const tCdf = (t, df) => {
  const x = df / (df + t * t);
  const tail = 0.5 * betaI(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
};
const tDensity = (t, df) => Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log1p((t * t) / df));
const fCdf = (x, d1, d2) => (x <= 0 ? 0 : betaI((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2));
const fDensity = (x, d1, d2) => (x <= 0 ? 0 : Math.exp((d1 / 2) * Math.log(d1 / d2) + (d1 / 2 - 1) * Math.log(x) - ((d1 + d2) / 2) * Math.log1p((d1 * x) / d2) - lnBeta(d1 / 2, d2 / 2)));
const chiCdf = (x, df) => gammaP(df / 2, x / 2);
const gammaCdf = (x, alpha, beta) => gammaP(alpha, x / beta);
const gammaDensity = (x, alpha, beta) => {
  if (x < 0) return 0;
  if (x === 0) return alpha === 1 ? 1 / beta : alpha < 1 ? Infinity : 0;
  return Math.exp((alpha - 1) * Math.log(x) - x / beta - lnGamma(alpha) - alpha * Math.log(beta));
};
const lnChoose = (n, k) => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);

/** The binomial probability of exactly k in n, with the ends exact. */
function binomPmf(k, n, p) {
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(lnChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}
const binomCdf = (k, n, p) => (k < 0 ? 0 : k >= n ? 1 : betaI(1 - p, n - k, k + 1));

// Arguments

const num = (arg) => (arg === undefined || arg.missing ? null : toNumber(arg.value));
const bool = (arg, fallback) => (arg === undefined || arg.missing ? fallback : toBoolean(arg.value));
const firstError = (...values) => values.find((v) => isError(v)) ?? null;

/** Numbers of a range or of typed values, as the statistical functions take them. */
function numbers(args) {
  const out = [];
  for (const arg of args) {
    if (!arg || arg.missing) continue;
    if (arg.matrix || arg.reference) {
      const found = collectNumbers(arg.matrix ? arg.matrix.flat : arg.values);
      if (isError(found)) return found;
      for (const n of found) out.push(n);
    } else {
      const n = typedNumber(arg.value);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Numbers as the A functions take them: text in a range counts 0, TRUE 1. */
function numbersA(args) {
  const out = [];
  for (const arg of args) {
    if (!arg || arg.missing) continue;
    for (const v of arg.matrix ? arg.matrix.flat : (arg.values ?? [arg.value])) {
      if (isError(v)) return v;
      if (isBlank(v)) continue;
      if (typeof v === 'number') out.push(v);
      else if (typeof v === 'boolean') out.push(v ? 1 : 0);
      else if (arg.matrix || arg.reference) out.push(0);
      else {
        const n = toNumber(v);
        if (isError(n)) return n;
        out.push(n);
      }
    }
  }
  return out;
}

const cells = (arg) => (arg?.matrix ? arg.matrix.flat : arg?.values ?? [arg?.value]);

/** Two ranges taken pair by pair, where both hold numbers. */
function pairs(a, b) {
  const xs = cells(a);
  const ys = cells(b);
  if (xs.length !== ys.length) return ERROR.na;
  const x = [];
  const y = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (isError(xs[i])) return xs[i];
    if (isError(ys[i])) return ys[i];
    if (typeof xs[i] === 'number' && typeof ys[i] === 'number') { x.push(xs[i]); y.push(ys[i]); }
  }
  return { x, y };
}

const sum = (list) => list.reduce((a, b) => a + b, 0);
const mean = (list) => sum(list) / list.length;
function variance(list, sample) {
  if (isError(list)) return list;
  if (list.length < (sample ? 2 : 1)) return ERROR.div0;
  const m = mean(list);
  return sum(list.map((v) => (v - m) ** 2)) / (list.length - (sample ? 1 : 0));
}

/** Sums of squares and products of paired values about their means. */
function moments(x, y) {
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i += 1) {
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  return { mx, my, sxx, syy, sxy, n: x.length };
}

/** A function of numbers taken from its arguments, an error among them given back first. */
const numeric = (count, use) => (args) => {
  const values = [];
  for (let i = 0; i < count; i += 1) values.push(num(args[i]));
  const error = firstError(...values);
  return error ?? use(...values, args);
};

const finite = (value) => (Number.isFinite(value) ? value : ERROR.num);

// Distributions with Calc's arguments

function normDist(x, m, s, cumulative) {
  if (s <= 0) return ERROR.num;
  return cumulative ? normal((x - m) / s) : density((x - m) / s) / s;
}

function lognormDist(x, m, s, cumulative) {
  if (s <= 0) return ERROR.num;
  if (x <= 0) return cumulative ? 0 : ERROR.num;
  const z = (Math.log(x) - m) / s;
  return cumulative ? normal(z) : density(z) / (s * x);
}

function betaDist(x, alpha, beta, cumulative, low = 0, high = 1) {
  if (alpha <= 0 || beta <= 0 || low >= high) return ERROR.num;
  if (x < low || x > high) return cumulative ? (x < low ? 0 : 1) : 0;
  const scale = high - low;
  const t = (x - low) / scale;
  if (cumulative) return betaI(t, alpha, beta);
  if (t === 0) return alpha < 1 ? ERROR.num : alpha === 1 ? beta / scale : 0;
  if (t === 1) return beta < 1 ? ERROR.num : beta === 1 ? alpha / scale : 0;
  return Math.exp((alpha - 1) * Math.log(t) + (beta - 1) * Math.log1p(-t) - lnBeta(alpha, beta)) / scale;
}

function weibull(x, alpha, beta, cumulative) {
  if (x < 0 || alpha <= 0 || beta <= 0) return ERROR.num;
  const z = (x / beta) ** alpha;
  return cumulative ? -Math.expm1(-z) : (alpha / beta ** alpha) * x ** (alpha - 1) * Math.exp(-z);
}

function hypgeom(x, n, m, total, cumulative) {
  if ([x, n, m, total].some((v) => v < 0) || n > total || m > total) return ERROR.num;
  const k = Math.trunc(x);
  const draws = Math.trunc(n);
  const good = Math.trunc(m);
  const all = Math.trunc(total);
  if (k < Math.max(0, draws - (all - good)) || k > Math.min(draws, good)) return cumulative ? (k < Math.max(0, draws - (all - good)) ? 0 : 1) : 0;
  const pmf = (i) => Math.exp(lnChoose(good, i) + lnChoose(all - good, draws - i) - lnChoose(all, draws));
  if (!cumulative) return pmf(k);
  let total2 = 0;
  for (let i = Math.max(0, draws - (all - good)); i <= k; i += 1) total2 += pmf(i);
  return Math.min(1, total2);
}

function negbinom(x, r, p, cumulative) {
  const k = Math.trunc(x);
  const s = Math.trunc(r);
  if (k < 0 || s < 1 || p < 0 || p > 1) return ERROR.num;
  if (cumulative) return betaI(p, s, k + 1);
  if (p === 0) return 0;
  if (p === 1) return k === 0 ? 1 : 0;
  return Math.exp(lnChoose(k + s - 1, k) + s * Math.log(p) + k * Math.log1p(-p));
}

function poisson(x, lambda, cumulative) {
  const k = Math.trunc(x);
  if (k < 0 || lambda < 0) return ERROR.num;
  if (lambda === 0) return 1 * (cumulative || k === 0);
  if (cumulative) return gammaQ(k + 1, lambda);
  return Math.exp(k * Math.log(lambda) - lambda - lnGamma(k + 1));
}

function binomDist(x, n, p, cumulative) {
  const k = Math.trunc(x);
  const trials = Math.trunc(n);
  if (trials < 0 || k < 0 || k > trials || p < 0 || p > 1) return ERROR.num;
  return cumulative ? binomCdf(k, trials, p) : binomPmf(k, trials, p);
}

/** The smallest number of successes whose cumulative binomial probability reaches alpha. */
function binomInverse(n, p, alpha) {
  const trials = Math.trunc(n);
  if (trials < 0 || p < 0 || p > 1 || alpha < 0 || alpha > 1) return ERROR.num;
  let total = 0;
  for (let k = 0; k <= trials; k += 1) {
    total += binomPmf(k, trials, p);
    if (total >= alpha * (1 - 1e-12)) return k;
  }
  return trials;
}

const tInverse = (p, df) => {
  if (p <= 0 || p >= 1 || df < 1) return ERROR.num;
  if (p === 0.5) return 0;
  // By symmetry, the upper half is found and turned for the lower one.
  const upper = p > 0.5;
  const root = inverse((t) => tCdf(t, df), upper ? p : 1 - p, 0, 1);
  return isError(root) ? root : (upper ? root : -root);
};

const chiInverse = (p, df) => {
  if (p < 0 || p >= 1 || df < 1) return ERROR.num;
  if (p === 0) return 0;
  return inverse((x) => chiCdf(x, df), p, 0, Math.max(1, df));
};

const chiInverseRt = (p, df) => {
  if (p <= 0 || p > 1 || df < 1) return ERROR.num;
  if (p === 1) return 0;
  return inverse((x) => -gammaQ(df / 2, x / 2), -p, 0, Math.max(1, df));
};

const fInverse = (p, d1, d2) => {
  if (p < 0 || p >= 1 || d1 < 1 || d2 < 1) return ERROR.num;
  if (p === 0) return 0;
  return inverse((x) => fCdf(x, d1, d2), p, 0, 1);
};

const fInverseRt = (p, d1, d2) => {
  if (p <= 0 || p > 1 || d1 < 1 || d2 < 1) return ERROR.num;
  if (p === 1) return 0;
  return inverse((x) => -betaI(d2 / (d2 + d1 * x), d2 / 2, d1 / 2), -p, 0, 1);
};

const gammaInverse = (p, alpha, beta) => {
  if (p < 0 || p >= 1 || alpha <= 0 || beta <= 0) return ERROR.num;
  if (p === 0) return 0;
  return inverse((x) => gammaCdf(x, alpha, beta), p, 0, Math.max(1, alpha * beta));
};

const betaInverse = (p, alpha, beta, low = 0, high = 1) => {
  if (p < 0 || p > 1 || alpha <= 0 || beta <= 0 || low >= high) return ERROR.num;
  if (p === 0) return low;
  if (p === 1) return high;
  // Bisection in [0, 1], where the bracket cannot grow.
  let a = 0;
  let b = 1;
  for (let i = 0; i < 200; i += 1) {
    const m = (a + b) / 2;
    if (betaI(m, alpha, beta) < p) a = m; else b = m;
    if (b - a <= Number.EPSILON * Math.max(m, 1e-300)) break;
  }
  return low + ((a + b) / 2) * (high - low);
};

// Tests

/** The p-value of Pearson's chi-square test of observed counts against expected ones. */
function chiTest(observed, expected) {
  const o = observed?.matrix ?? new Matrix([[observed?.value]]);
  const e = expected?.matrix ?? new Matrix([[expected?.value]]);
  if (o.rows !== e.rows || o.cols !== e.cols) return ERROR.na;
  let chi = 0;
  for (let r = 0; r < o.rows; r += 1) {
    for (let c = 0; c < o.cols; c += 1) {
      const a = o.at(r, c);
      const b = e.at(r, c);
      if (isError(a)) return a;
      if (isError(b)) return b;
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      if (b === 0) return ERROR.div0;
      chi += ((a - b) ** 2) / b;
    }
  }
  const df = o.rows > 1 && o.cols > 1 ? (o.rows - 1) * (o.cols - 1) : Math.max(o.rows, o.cols) - 1;
  if (df < 1) return ERROR.na;
  return gammaQ(df / 2, chi / 2);
}

function fTest(a, b) {
  const x = numbers([a]);
  const y = numbers([b]);
  const error = firstError(x, y);
  if (error) return error;
  if (x.length < 2 || y.length < 2) return ERROR.div0;
  const vx = variance(x, true);
  const vy = variance(y, true);
  if (vx === 0 || vy === 0) return ERROR.div0;
  const f = vx / vy;
  const d1 = x.length - 1;
  const d2 = y.length - 1;
  const tail = 1 - fCdf(f, d1, d2);
  return 2 * Math.min(tail, 1 - tail);
}

function tTest(a, b, tails, type) {
  const t2 = Math.trunc(tails);
  const kind = Math.trunc(type);
  if (![1, 2].includes(t2) || ![1, 2, 3].includes(kind)) return ERROR.num;
  let t;
  let df;
  if (kind === 1) {
    const p = pairs(a, b);
    if (isError(p)) return p;
    if (p.x.length < 2) return ERROR.div0;
    const d = p.x.map((v, i) => v - p.y[i]);
    const s = variance(d, true);
    if (s === 0) return ERROR.div0;
    t = mean(d) / Math.sqrt(s / d.length);
    df = d.length - 1;
  } else {
    const x = numbers([a]);
    const y = numbers([b]);
    const error = firstError(x, y);
    if (error) return error;
    if (x.length < 2 || y.length < 2) return ERROR.div0;
    const vx = variance(x, true);
    const vy = variance(y, true);
    if (kind === 2) {
      const pooled = ((x.length - 1) * vx + (y.length - 1) * vy) / (x.length + y.length - 2);
      t = (mean(x) - mean(y)) / Math.sqrt(pooled * (1 / x.length + 1 / y.length));
      df = x.length + y.length - 2;
    } else {
      const sx = vx / x.length;
      const sy = vy / y.length;
      t = (mean(x) - mean(y)) / Math.sqrt(sx + sy);
      df = (sx + sy) ** 2 / (sx ** 2 / (x.length - 1) + sy ** 2 / (y.length - 1));
    }
  }
  if (!Number.isFinite(t)) return ERROR.div0;
  const one = 1 - tCdf(Math.abs(t), df);
  return t2 * one;
}

/** The one-tailed probability that a sample's mean is above mu: its own deviation when sigma is not given. */
function zTest(data, mu, sigma) {
  const x = numbers([data]);
  if (isError(x)) return x;
  if (x.length < (sigma === null ? 2 : 1)) return ERROR.div0;
  const s = sigma ?? Math.sqrt(variance(x, true));
  if (s <= 0) return ERROR.div0;
  return 1 - normal((mean(x) - mu) / (s / Math.sqrt(x.length)));
}

// Measures of a sample

const geomean = (args) => {
  const x = numbers(args);
  if (isError(x)) return x;
  if (x.length === 0 || x.some((v) => v <= 0)) return ERROR.num;
  return Math.exp(mean(x.map(Math.log)));
};

const harmean = (args) => {
  const x = numbers(args);
  if (isError(x)) return x;
  if (x.length === 0 || x.some((v) => v <= 0)) return ERROR.num;
  return x.length / sum(x.map((v) => 1 / v));
};

function skew(x, sample) {
  if (isError(x)) return x;
  const n = x.length;
  if (n < (sample ? 3 : 1)) return ERROR.div0;
  const m = mean(x);
  const s = Math.sqrt(variance(x, sample));
  if (!(s > 0)) return ERROR.div0;
  const third = sum(x.map((v) => ((v - m) / s) ** 3));
  return sample ? (third * n) / ((n - 1) * (n - 2)) : third / n;
}

function kurt(x) {
  if (isError(x)) return x;
  const n = x.length;
  if (n < 4) return ERROR.div0;
  const m = mean(x);
  const s = Math.sqrt(variance(x, true));
  if (!(s > 0)) return ERROR.div0;
  const fourth = sum(x.map((v) => ((v - m) / s) ** 4));
  return (fourth * n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

function trimmean(data, fraction) {
  const x = numbers([data]);
  if (isError(x)) return x;
  if (isError(fraction)) return fraction;
  if (fraction < 0 || fraction >= 1) return ERROR.num;
  if (x.length === 0) return ERROR.num;
  const cut = Math.floor((x.length * fraction) / 2);
  const kept = [...x].sort((a, b) => a - b).slice(cut, x.length - cut);
  return mean(kept);
}

/** Where x falls among the data as a fraction, interpolated between neighbours, cut to `digits` figures as Calc does. */
function percentRank(data, x, digits, exclusive) {
  const list = numbers([data]);
  if (isError(list)) return list;
  if (isError(x) || isError(digits)) return firstError(x, digits);
  const places = digits === null ? 3 : Math.trunc(digits);
  if (places < 1 || list.length === 0) return ERROR.num;
  const sorted = [...list].sort((a, b) => a - b);
  const n = sorted.length;
  if (x < sorted[0] || x > sorted[n - 1]) return ERROR.value;
  const rankOf = (i) => (exclusive ? (i + 1) / (n + 1) : n === 1 ? 1 : i / (n - 1));
  let value;
  const exact = sorted.indexOf(x);
  if (exact !== -1) value = rankOf(exact);
  else {
    let i = 0;
    while (sorted[i + 1] < x) i += 1;
    value = rankOf(i) + ((rankOf(i + 1) - rankOf(i)) * (x - sorted[i])) / (sorted[i + 1] - sorted[i]);
  }
  // Calc rounds to that many significant figures.
  return value === 0 ? 0 : Number(value.toPrecision(Math.min(places, 15)));
}

function rankAvg(x, ref, order) {
  const list = numbers([ref]);
  if (isError(list)) return list;
  if (!list.includes(x)) return ERROR.na;
  const ascending = order !== null && order !== 0;
  const before = list.filter((v) => (ascending ? v < x : v > x)).length;
  const same = list.filter((v) => v === x).length;
  return before + (same + 1) / 2;
}

function modeMulti(args) {
  const x = numbers(args);
  if (isError(x)) return x;
  const counts = new Map();
  for (const v of x) counts.set(v, (counts.get(v) ?? 0) + 1);
  const top = Math.max(0, ...counts.values());
  if (top < 2) return ERROR.na;
  return Matrix.column([...counts].filter(([, c]) => c === top).map(([v]) => v));
}

function prob(xs, ps, low, high) {
  const p = pairs(xs, ps);
  if (isError(p)) return p;
  const total = sum(p.y);
  if (p.y.some((v) => v < 0 || v > 1) || Math.abs(total - 1) > 1e-7) return ERROR.num;
  const top = high ?? low;
  return sum(p.x.map((v, i) => (v >= low && v <= top ? p.y[i] : 0)));
}

/** The linear regression of y on x, for SLOPE and its kin. */
function regression(ys, xs) {
  const p = pairs(xs, ys);
  if (isError(p)) return p;
  if (p.x.length < 1) return ERROR.div0;
  const m = moments(p.x, p.y);
  if (m.sxx === 0) return ERROR.div0;
  return { ...m, slope: m.sxy / m.sxx };
}

function pearson(a, b) {
  const p = pairs(a, b);
  if (isError(p)) return p;
  if (p.x.length < 1) return ERROR.div0;
  const m = moments(p.x, p.y);
  if (m.sxx === 0 || m.syy === 0) return ERROR.div0;
  return m.sxy / Math.sqrt(m.sxx * m.syy);
}

function covariance(a, b, sample) {
  const p = pairs(a, b);
  if (isError(p)) return p;
  if (p.x.length < (sample ? 2 : 1)) return ERROR.div0;
  return moments(p.x, p.y).sxy / (p.x.length - (sample ? 1 : 0));
}

function permut(n, k) {
  const total = Math.trunc(n);
  const take = Math.trunc(k);
  if (total < 0 || take < 0 || take > total) return ERROR.num;
  let out = 1;
  for (let i = 0; i < take; i += 1) out *= total - i;
  return finite(out);
}

export const DISTRIBUTIONS = {
  // Measures
  AVEDEV: (args) => { const x = numbers(args); if (isError(x)) return x; if (!x.length) return ERROR.div0; const m = mean(x); return mean(x.map((v) => Math.abs(v - m))); },
  DEVSQ: (args) => { const x = numbers(args); if (isError(x)) return x; if (!x.length) return 0; const m = mean(x); return sum(x.map((v) => (v - m) ** 2)); },
  GEOMEAN: geomean,
  HARMEAN: harmean,
  KURT: (args) => kurt(numbers(args)),
  SKEW: (args) => skew(numbers(args), true),
  SKEWP: (args) => skew(numbers(args), false),
  TRIMMEAN: (args) => trimmean(args[0], num(args[1])),
  STDEVA: (args) => { const v = variance(numbersA(args), true); return isError(v) ? v : Math.sqrt(v); },
  STDEVPA: (args) => { const v = variance(numbersA(args), false); return isError(v) ? v : Math.sqrt(v); },
  VARA: (args) => variance(numbersA(args), true),
  VARPA: (args) => variance(numbersA(args), false),
  STANDARDIZE: numeric(3, (x, m, s) => (s <= 0 ? ERROR.num : (x - m) / s)),
  PERCENTRANK: (args) => percentRank(args[0], num(args[1]), num(args[2]), false),
  'PERCENTRANK.INC': (args) => percentRank(args[0], num(args[1]), num(args[2]), false),
  'PERCENTRANK.EXC': (args) => percentRank(args[0], num(args[1]), num(args[2]), true),
  'RANK.AVG': (args) => { const x = num(args[0]); const o = num(args[2]); return firstError(x, o) ?? rankAvg(x, args[1], o); },
  'MODE.MULT': modeMulti,
  COVAR: (args) => covariance(args[0], args[1], false),
  'COVARIANCE.P': (args) => covariance(args[0], args[1], false),
  'COVARIANCE.S': (args) => covariance(args[0], args[1], true),
  PEARSON: (args) => pearson(args[0], args[1]),
  RSQ: (args) => { const r = pearson(args[1], args[0]); return isError(r) ? r : r * r; },
  SLOPE: (args) => { const r = regression(args[0], args[1]); return isError(r) ? r : r.slope; },
  INTERCEPT: (args) => { const r = regression(args[0], args[1]); return isError(r) ? r : r.my - r.slope * r.mx; },
  STEYX: (args) => {
    const r = regression(args[0], args[1]);
    if (isError(r)) return r;
    if (r.n < 3) return ERROR.div0;
    return Math.sqrt((r.syy - (r.sxy * r.sxy) / r.sxx) / (r.n - 2));
  },
  FORECAST: (args) => { const x = num(args[0]); if (isError(x)) return x; const r = regression(args[1], args[2]); return isError(r) ? r : r.my + r.slope * (x - r.mx); },
  'FORECAST.LINEAR': (args) => { const x = num(args[0]); if (isError(x)) return x; const r = regression(args[1], args[2]); return isError(r) ? r : r.my + r.slope * (x - r.mx); },
  PROB: (args) => { const low = num(args[2]); const high = num(args[3]); return firstError(low, high) ?? prob(args[0], args[1], low, high); },
  // Special functions
  GAMMA: numeric(1, (x) => (x <= 0 && Number.isInteger(x) ? ERROR.num : finite(gamma(x)))),
  GAMMALN: numeric(1, (x) => (x <= 0 ? ERROR.num : lnGamma(x))),
  'GAMMALN.PRECISE': numeric(1, (x) => (x <= 0 ? ERROR.num : lnGamma(x))),
  'ERF.PRECISE': numeric(1, (x) => erf(x)),
  'ERFC.PRECISE': numeric(1, (x) => erfc(x)),
  FISHER: numeric(1, (x) => (Math.abs(x) >= 1 ? ERROR.num : Math.atanh(x))),
  GAUSS: numeric(1, (x) => normal(x) - 0.5),
  PHI: numeric(1, (x) => density(x)),
  PERMUT: numeric(2, permut),
  PERMUTATIONA: numeric(2, (n, k) => (n < 0 || k < 0 ? ERROR.num : finite(Math.trunc(n) ** Math.trunc(k)))),
  // Normal and its kin
  'NORM.DIST': (args) => { const v = [0, 1, 2].map((i) => num(args[i])); const c = bool(args[3], null); if (c === null) return ERROR.value; return firstError(...v, c) ?? normDist(...v, c); },
  'NORM.INV': numeric(3, (p, m, s) => { if (s <= 0 || p <= 0 || p >= 1) return ERROR.num; const z = normalInverse(p); return isError(z) ? z : m + s * z; }),
  'NORM.S.DIST': (args) => { const z = num(args[0]); const c = bool(args[1], null); if (c === null) return ERROR.value; return firstError(z, c) ?? (c ? normal(z) : density(z)); },
  'NORM.S.INV': numeric(1, (p) => normalInverse(p)),
  'LOGNORM.DIST': (args) => { const v = [0, 1, 2].map((i) => num(args[i])); const c = bool(args[3], null); if (c === null) return ERROR.value; return firstError(...v, c) ?? lognormDist(...v, c); },
  'LOGNORM.INV': numeric(3, (p, m, s) => { if (s <= 0 || p <= 0 || p >= 1) return ERROR.num; return Math.exp(m + s * normalInverse(p)); }),
  CONFIDENCE: numeric(3, (alpha, s, n) => (alpha <= 0 || alpha >= 1 || s <= 0 || n < 1 ? ERROR.num : (normalInverse(1 - alpha / 2) * s) / Math.sqrt(Math.trunc(n)))),
  'CONFIDENCE.NORM': numeric(3, (alpha, s, n) => (alpha <= 0 || alpha >= 1 || s <= 0 || n < 1 ? ERROR.num : (normalInverse(1 - alpha / 2) * s) / Math.sqrt(Math.trunc(n)))),
  'CONFIDENCE.T': numeric(3, (alpha, s, n) => {
    const size = Math.trunc(n);
    if (alpha <= 0 || alpha >= 1 || s <= 0 || size < 2) return size === 1 ? ERROR.div0 : ERROR.num;
    const t = tInverse(1 - alpha / 2, size - 1);
    return isError(t) ? t : (t * s) / Math.sqrt(size);
  }),
  'Z.TEST': (args) => { const mu = num(args[1]); const sigma = num(args[2]); return firstError(mu, sigma) ?? zTest(args[0], mu, sigma); },
  // t, F and chi-square
  'T.DIST': (args) => { const t = num(args[0]); const df = num(args[1]); const c = bool(args[2], null); if (c === null) return ERROR.value; const e = firstError(t, df, c); if (e) return e; const d = Math.trunc(df); if (d < 1) return ERROR.num; return c ? tCdf(t, d) : tDensity(t, d); },
  'T.DIST.2T': numeric(2, (t, df) => (t < 0 || Math.trunc(df) < 1 ? ERROR.num : 2 * (1 - tCdf(t, Math.trunc(df))))),
  'T.DIST.RT': numeric(2, (t, df) => (Math.trunc(df) < 1 ? ERROR.num : 1 - tCdf(t, Math.trunc(df)))),
  'T.INV': numeric(2, (p, df) => tInverse(p, Math.trunc(df))),
  'T.INV.2T': numeric(2, (p, df) => (p <= 0 || p > 1 ? ERROR.num : p === 1 ? 0 : tInverse(1 - p / 2, Math.trunc(df)))),
  'T.TEST': (args) => { const tails = num(args[2]); const type = num(args[3]); return firstError(tails, type) ?? tTest(args[0], args[1], tails, type); },
  'F.DIST': (args) => {
    const [x, d1, d2] = [0, 1, 2].map((i) => num(args[i]));
    const c = bool(args[3], null);
    if (c === null) return ERROR.value;
    const e = firstError(x, d1, d2, c);
    if (e) return e;
    const a = Math.trunc(d1);
    const b = Math.trunc(d2);
    if (x < 0 || a < 1 || b < 1) return ERROR.num;
    return c ? fCdf(x, a, b) : fDensity(x, a, b);
  },
  'F.DIST.RT': numeric(3, (x, d1, d2) => (x < 0 || Math.trunc(d1) < 1 || Math.trunc(d2) < 1 ? ERROR.num : x === 0 ? 1 : betaI(Math.trunc(d2) / (Math.trunc(d2) + Math.trunc(d1) * x), Math.trunc(d2) / 2, Math.trunc(d1) / 2))),
  'F.INV': numeric(3, (p, d1, d2) => fInverse(p, Math.trunc(d1), Math.trunc(d2))),
  'F.INV.RT': numeric(3, (p, d1, d2) => fInverseRt(p, Math.trunc(d1), Math.trunc(d2))),
  'F.TEST': (args) => fTest(args[0], args[1]),
  'CHISQ.DIST': (args) => {
    const x = num(args[0]);
    const df = num(args[1]);
    const c = bool(args[2], null);
    if (c === null) return ERROR.value;
    const e = firstError(x, df, c);
    if (e) return e;
    const d = Math.trunc(df);
    if (d < 1) return ERROR.num;
    if (x < 0) return 0;
    return c ? chiCdf(x, d) : gammaDensity(x, d / 2, 2);
  },
  'CHISQ.DIST.RT': numeric(2, (x, df) => (Math.trunc(df) < 1 ? ERROR.num : x < 0 ? 1 : gammaQ(Math.trunc(df) / 2, x / 2))),
  'CHISQ.INV': numeric(2, (p, df) => chiInverse(p, Math.trunc(df))),
  'CHISQ.INV.RT': numeric(2, (p, df) => chiInverseRt(p, Math.trunc(df))),
  'CHISQ.TEST': (args) => chiTest(args[0], args[1]),
  // Gamma, beta, exponential, Weibull
  'GAMMA.DIST': (args) => {
    const [x, a, b] = [0, 1, 2].map((i) => num(args[i]));
    const c = bool(args[3], null);
    if (c === null) return ERROR.value;
    const e = firstError(x, a, b, c);
    if (e) return e;
    if (x < 0 || a <= 0 || b <= 0) return ERROR.num;
    return c ? gammaCdf(x, a, b) : finite(gammaDensity(x, a, b));
  },
  'GAMMA.INV': numeric(3, gammaInverse),
  'BETA.DIST': (args) => {
    const [x, a, b] = [0, 1, 2].map((i) => num(args[i]));
    const c = bool(args[3], null);
    const low = num(args[4]) ?? 0;
    const high = num(args[5]) ?? 1;
    if (c === null) return ERROR.value;
    return firstError(x, a, b, c, low, high) ?? betaDist(x, a, b, c, low, high);
  },
  'BETA.INV': (args) => {
    const [p, a, b] = [0, 1, 2].map((i) => num(args[i]));
    const low = num(args[3]) ?? 0;
    const high = num(args[4]) ?? 1;
    return firstError(p, a, b, low, high) ?? betaInverse(p, a, b, low, high);
  },
  'EXPON.DIST': (args) => {
    const x = num(args[0]);
    const l = num(args[1]);
    const c = bool(args[2], null);
    if (c === null) return ERROR.value;
    const e = firstError(x, l, c);
    if (e) return e;
    if (l <= 0) return ERROR.num;
    if (x < 0) return 0;
    return c ? -Math.expm1(-l * x) : l * Math.exp(-l * x);
  },
  WEIBULL: (args) => { const v = [0, 1, 2].map((i) => num(args[i])); const c = bool(args[3], null); if (c === null) return ERROR.value; return firstError(...v, c) ?? weibull(...v, c); },
  'WEIBULL.DIST': (args) => { const v = [0, 1, 2].map((i) => num(args[i])); const c = bool(args[3], null); if (c === null) return ERROR.value; return firstError(...v, c) ?? weibull(...v, c); },
  // Counting
  'BINOM.DIST': (args) => { const v = [0, 1, 2].map((i) => num(args[i])); const c = bool(args[3], null); if (c === null) return ERROR.value; return firstError(...v, c) ?? binomDist(...v, c); },
  'BINOM.INV': numeric(3, binomInverse),
  CRITBINOM: numeric(3, binomInverse),
  B: (args) => {
    const [n, p, t1] = [0, 1, 2].map((i) => num(args[i]));
    const t2 = num(args[3]);
    const e = firstError(n, p, t1, t2);
    if (e) return e;
    const trials = Math.trunc(n);
    const low = Math.trunc(t1);
    const high = t2 === null ? low : Math.trunc(t2);
    if (trials < 0 || p < 0 || p > 1 || low < 0 || high > trials || low > high) return ERROR.num;
    if (t2 === null) return binomPmf(low, trials, p);
    return binomCdf(high, trials, p) - binomCdf(low - 1, trials, p);
  },
  'HYPGEOM.DIST': (args) => { const v = [0, 1, 2, 3].map((i) => num(args[i])); const c = bool(args[4], null); if (c === null) return ERROR.value; return firstError(...v, c) ?? hypgeom(...v, c); },
  'NEGBINOM.DIST': (args) => { const v = [0, 1, 2].map((i) => num(args[i])); const c = bool(args[3], null); if (c === null) return ERROR.value; return firstError(...v, c) ?? negbinom(...v, c); },
  POISSON: (args) => { const v = [0, 1].map((i) => num(args[i])); const c = bool(args[2], true); return firstError(...v, c) ?? poisson(...v, c); },
  'POISSON.DIST': (args) => { const v = [0, 1].map((i) => num(args[i])); const c = bool(args[2], true); return firstError(...v, c) ?? poisson(...v, c); },
};
