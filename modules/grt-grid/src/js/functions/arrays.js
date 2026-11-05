/** Functions on blocks of numbers: products, inverses, regressions, sequences. */

import { ERROR, isError, isBlank, toNumber, toBoolean, Matrix, collectNumbers } from '../engine/values.js';

const blockOf = (arg) => (arg?.matrix ?? new Matrix([[arg?.value ?? null]]));

/** A block as numbers only, or the first error, or #VALUE! for text. */
function numeric(m) {
  const out = [];
  for (const row of m.data) {
    const line = [];
    for (let c = 0; c < m.cols; c += 1) {
      const v = row[c] ?? null;
      if (isError(v)) return v;
      if (typeof v === 'number') line.push(v);
      else if (typeof v === 'boolean') line.push(v ? 1 : 0);
      else if (isBlank(v)) line.push(0);
      else return ERROR.value;
    }
    out.push(line);
  }
  return out;
}

function multiply(a, b) {
  const rows = a.length;
  const inner = b.length;
  const cols = b[0].length;
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    let sum = 0;
    for (let k = 0; k < inner; k += 1) sum += a[r][k] * b[k][c];
    return sum;
  }));
}

const transposed = (a) => a[0].map((_, c) => a.map((row) => row[c]));

/** The inverse by Gauss-Jordan with partial pivoting; null when it is singular. */
function invert(a) {
  const n = a.length;
  const m = a.map((row, r) => [...row, ...Array.from({ length: n }, (_, c) => (c === r ? 1 : 0))]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-300) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    for (let c = 0; c < 2 * n; c += 1) m[col][c] /= p;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c += 1) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row.slice(n));
}

function determinant(a) {
  const n = a.length;
  const m = a.map((row) => [...row]);
  let det = 1;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (m[pivot][col] === 0) return 0;
    if (pivot !== col) { [m[col], m[pivot]] = [m[pivot], m[col]]; det = -det; }
    det *= m[col][col];
    for (let r = col + 1; r < n; r += 1) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c < n; c += 1) m[r][c] -= f * m[col][c];
    }
  }
  return det;
}

/**
 * Least squares of y on the columns of x, as LINEST works it out.
 * @returns {{coefficients: number[], intercept: number, stats: ?number[][]}|string}
 */
function leastSquares(yArg, xArg, constant, wantStats) {
  const yBlock = numeric(blockOf(yArg));
  if (isError(yBlock)) return yBlock;
  const y = yBlock.flat();
  const n = y.length;
  let columns;
  if (!xArg || xArg.missing) {
    columns = [Array.from({ length: n }, (_, i) => i + 1)];
  } else {
    const xBlock = numeric(blockOf(xArg));
    if (isError(xBlock)) return xBlock;
    const yIsColumn = yBlock[0].length === 1;
    if (yIsColumn) {
      if (xBlock.length !== n) return ERROR.ref;
      columns = xBlock[0].map((_, c) => xBlock.map((row) => row[c]));
    } else {
      if (xBlock[0].length !== n) return ERROR.ref;
      columns = xBlock;
    }
  }
  const k = columns.length;
  const design = Array.from({ length: n }, (_, i) => [...columns.map((col) => col[i]), ...(constant ? [1] : [])]);
  const p = design[0].length;
  if (n < p) return ERROR.num;
  const xt = transposed(design);
  const inverse = invert(multiply(xt, design));
  if (!inverse) return ERROR.num;
  const beta = multiply(inverse, multiply(xt, y.map((v) => [v]))).map((row) => row[0]);
  const coefficients = beta.slice(0, k);
  const intercept = constant ? beta[k] : 0;
  if (!wantStats) return { coefficients, intercept, stats: null };

  const fitted = design.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  const ssResid = y.reduce((s, v, i) => s + (v - fitted[i]) ** 2, 0);
  const ssTotal = constant ? y.reduce((s, v) => s + (v - meanY) ** 2, 0) : y.reduce((s, v) => s + v * v, 0);
  const ssReg = ssTotal - ssResid;
  const df = n - p;
  const r2 = ssTotal === 0 ? 1 : ssReg / ssTotal;
  const sey = df > 0 ? Math.sqrt(ssResid / df) : ERROR.na;
  const se = inverse.map((row, j) => (df > 0 ? Math.sqrt(row[j] * ssResid / df) : ERROR.na));
  const F = df > 0 && ssResid > 0 ? (ssReg / (p - (constant ? 1 : 0))) / (ssResid / df) : ERROR.num;
  const width = k + 1;
  const row = (values) => [...values, ...Array(width - values.length).fill(ERROR.na)];
  const stats = [
    row([...coefficients].reverse().concat([intercept])),
    row([...se.slice(0, k)].reverse().concat([constant ? se[k] : ERROR.na])),
    row([r2, sey]),
    row([F, df]),
    row([ssReg, ssResid]),
  ];
  return { coefficients, intercept, stats };
}

function linest(args, logarithmic) {
  const constant = args[2] && !args[2].missing ? toBoolean(args[2].value) : true;
  const stats = args[3] && !args[3].missing ? toBoolean(args[3].value) : false;
  if (isError(constant) || isError(stats)) return ERROR.value;
  let yArg = args[0];
  if (logarithmic) {
    const y = numeric(blockOf(args[0]));
    if (isError(y)) return y;
    if (y.flat().some((v) => v <= 0)) return ERROR.num;
    yArg = { matrix: new Matrix(y.map((row) => row.map(Math.log))) };
  }
  const fit = leastSquares(yArg, args[1], constant, stats);
  if (isError(fit)) return fit;
  const finish = (v) => (logarithmic && typeof v === 'number' ? Math.exp(v) : v);
  if (fit.stats) {
    const rows = fit.stats.map((row, i) => (i === 0 ? row.map(finish) : row));
    return new Matrix(rows);
  }
  return new Matrix([[...fit.coefficients].reverse().concat([fit.intercept]).map(finish)]);
}

/** Values predicted by the fit, for TREND and GROWTH. */
function predict(args, logarithmic) {
  const constant = args[3] && !args[3].missing ? toBoolean(args[3].value) : true;
  if (isError(constant)) return ERROR.value;
  let yArg = args[0];
  if (logarithmic) {
    const y = numeric(blockOf(args[0]));
    if (isError(y)) return y;
    if (y.flat().some((v) => v <= 0)) return ERROR.num;
    yArg = { matrix: new Matrix(y.map((row) => row.map(Math.log))) };
  }
  const fit = leastSquares(yArg, args[1], constant, false);
  if (isError(fit)) return fit;
  const source = args[2] && !args[2].missing ? args[2] : (args[1] && !args[1].missing ? args[1] : null);
  let points;
  let shape;
  if (source) {
    const block = numeric(blockOf(source));
    if (isError(block)) return block;
    const k = fit.coefficients.length;
    if (k === 1) {
      points = block.flat().map((v) => [v]);
      shape = [block.length, block[0].length];
    } else {
      const byRows = block[0].length === k;
      points = byRows ? block : transposed(block);
      shape = byRows ? [block.length, 1] : [1, block[0].length];
    }
  } else {
    const n = blockOf(args[0]).flat.length;
    points = Array.from({ length: n }, (_, i) => [i + 1]);
    const yShape = blockOf(args[0]);
    shape = [yShape.rows, yShape.cols];
  }
  const values = points.map((x) => {
    const v = x.reduce((s, xi, j) => s + xi * fit.coefficients[j], fit.intercept);
    return logarithmic ? Math.exp(v) : v;
  });
  return Matrix.of(shape[0], shape[1], (r, c) => values[r * shape[1] + c]);
}

/** The discrete Fourier transform of a list, as FOURIER returns it: real and imaginary parts. */
function fourier(real, imaginary, inverse) {
  const n = real.length;
  const sign = inverse ? 1 : -1;
  const out = [];
  for (let k = 0; k < n; k += 1) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t += 1) {
      const angle = (sign * 2 * Math.PI * k * t) / n;
      re += real[t] * Math.cos(angle) - imaginary[t] * Math.sin(angle);
      im += real[t] * Math.sin(angle) + imaginary[t] * Math.cos(angle);
    }
    out.push(inverse ? [re / n, im / n] : [re, im]);
  }
  return out;
}

/** Pairs of numbers from two blocks of the same size, as SUMXMY2 and its family read them. */
function pairs(args) {
  const a = blockOf(args[0]);
  const b = blockOf(args[1]);
  if (a.rows * a.cols !== b.rows * b.cols) return ERROR.na;
  const out = [];
  const fa = a.flat;
  const fb = b.flat;
  for (let i = 0; i < fa.length; i += 1) {
    if (isError(fa[i])) return fa[i];
    if (isError(fb[i])) return fb[i];
    if (typeof fa[i] === 'number' && typeof fb[i] === 'number') out.push([fa[i], fb[i]]);
  }
  return out;
}

const sumPairs = (args, apply) => {
  const list = pairs(args);
  return isError(list) ? list : list.reduce((s, [x, y]) => s + apply(x, y), 0);
};

export const ARRAYS = {
  MMULT: (args) => {
    const a = numeric(blockOf(args[0]));
    const b = numeric(blockOf(args[1]));
    if (isError(a)) return a;
    if (isError(b)) return b;
    if (a[0].length !== b.length) return ERROR.value;
    return new Matrix(multiply(a, b));
  },
  MINVERSE: (args) => {
    const a = numeric(blockOf(args[0]));
    if (isError(a)) return a;
    if (a.length !== a[0].length) return ERROR.value;
    const inverse = invert(a);
    return inverse ? new Matrix(inverse) : ERROR.num;
  },
  MDETERM: (args) => {
    const a = numeric(blockOf(args[0]));
    if (isError(a)) return a;
    if (a.length !== a[0].length) return ERROR.value;
    return determinant(a);
  },
  MUNIT: (args) => {
    const n = Math.trunc(toNumber(args[0]?.value));
    if (!Number.isFinite(n) || n < 1 || n > 10000) return ERROR.value;
    return Matrix.of(n, n, (r, c) => (r === c ? 1 : 0));
  },
  TRANSPOSE: (args) => {
    const m = blockOf(args[0]);
    return Matrix.of(m.cols, m.rows, (r, c) => m.data[c][r] ?? null);
  },
  SEQUENCE: (args) => {
    const number = (i, fallback) => (args[i] && !args[i].missing ? toNumber(args[i].value) : fallback);
    const rows = number(0, 1);
    const cols = number(1, 1);
    const start = number(2, 1);
    const step = number(3, 1);
    for (const v of [rows, cols, start, step]) if (isError(v)) return v;
    const r = Math.trunc(rows);
    const c = Math.trunc(cols);
    if (r < 1 || c < 1) return ERROR.calc;
    if (r * c > 1_000_000) return ERROR.num;
    return Matrix.of(r, c, (i, j) => start + (i * c + j) * step);
  },
  SUMPRODUCT: (args) => {
    const blocks = args.map(blockOf);
    const size = blocks[0].rows * blocks[0].cols;
    if (blocks.some((b) => b.rows !== blocks[0].rows || b.cols !== blocks[0].cols)) return ERROR.value;
    const flats = blocks.map((b) => b.flat);
    let sum = 0;
    for (let i = 0; i < size; i += 1) {
      let product = 1;
      for (const flat of flats) {
        const v = flat[i];
        if (isError(v)) return v;
        product *= typeof v === 'number' ? v : typeof v === 'boolean' && blocks.length === 1 ? Number(v) : 0;
      }
      sum += product;
    }
    return sum;
  },
  SUMX2MY2: (args) => sumPairs(args, (x, y) => x * x - y * y),
  SUMX2PY2: (args) => sumPairs(args, (x, y) => x * x + y * y),
  SUMXMY2: (args) => sumPairs(args, (x, y) => (x - y) ** 2),
  FREQUENCY: (args) => {
    const data = collectNumbers(blockOf(args[0]).flat);
    const bins = collectNumbers(blockOf(args[1]).flat);
    if (isError(data)) return data;
    if (isError(bins)) return bins;
    const order = bins.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const counts = Array(bins.length + 1).fill(0);
    for (const v of data) {
      const slot = order.find(([limit]) => v <= limit);
      counts[slot ? slot[1] : bins.length] += 1;
    }
    return Matrix.column(counts);
  },
  LINEST: (args) => linest(args, false),
  LOGEST: (args) => linest(args, true),
  TREND: (args) => predict(args, false),
  GROWTH: (args) => predict(args, true),
  FOURIER: (args) => {
    const block = numeric(blockOf(args[0]));
    if (isError(block)) return block;
    const grouped = toBoolean(args[1]?.value);
    const inverse = args[2] && !args[2].missing ? toBoolean(args[2].value) : false;
    const polar = args[3] && !args[3].missing ? toBoolean(args[3].value) : false;
    const minimum = args[4] && !args[4].missing ? toNumber(args[4].value) : 0;
    for (const v of [grouped, inverse, polar, minimum]) if (isError(v)) return v;
    const twoLines = grouped ? block[0].length === 2 : block.length === 2;
    const lines = grouped ? transposed(block) : block;
    const real = twoLines ? lines[0] : (grouped ? lines[0] : block.flat());
    const imaginary = twoLines ? lines[1] : real.map(() => 0);
    if (real.length > 8192) return ERROR.num;
    const result = fourier(real, imaginary, inverse).map(([re, im]) => {
      if (!polar) return [re, im];
      const magnitude = Math.hypot(re, im);
      if (magnitude < minimum) return [0, 0];
      return [magnitude, Math.atan2(im, re)];
    });
    return new Matrix(result);
  },
};
