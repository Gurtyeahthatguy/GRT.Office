/** Forecasts by exponential smoothing, as LibreOffice's FORECAST.ETS functions work them out: level, trend and season, each smoothed. */

import { ERROR, isError, isBlank, toNumber, Matrix } from '../engine/values.js';
import { normalInverse } from './distributions.js';
import { least, greatest } from '../core/extent.js';

const RESOLUTION = 0.001;
const cells = (arg) => (arg?.matrix ? arg.matrix.flat : arg?.values ?? [arg?.value]);

/**
 * The series a forecast is made from: sorted by the timeline, duplicates aggregated, gaps filled, at an even step.
 * @returns {{x: number[], y: number[], step: number}|string} or an error
 */
function series(valuesArg, timelineArg, completion, aggregation) {
  const ys = cells(valuesArg);
  const xs = cells(timelineArg);
  if (ys.length !== xs.length) return ERROR.na;
  const points = [];
  for (let i = 0; i < ys.length; i += 1) {
    if (isError(xs[i])) return xs[i];
    if (isError(ys[i])) return ys[i];
    if (isBlank(xs[i]) || typeof xs[i] !== 'number') return ERROR.value;
    points.push({ x: xs[i], y: typeof ys[i] === 'number' ? ys[i] : null });
  }
  points.sort((a, b) => a.x - b.x);
  // Points on the same time are aggregated, AVERAGE unless told otherwise.
  const merged = [];
  for (const p of points) {
    const last = merged[merged.length - 1];
    if (last && last.x === p.x) { if (p.y !== null) last.group.push(p.y); } else merged.push({ x: p.x, group: p.y === null ? [] : [p.y] });
  }
  const aggregate = (list) => {
    if (!list.length) return null;
    switch (aggregation) {
      case 2: return list.length;
      case 3: return list.length;
      case 4: return greatest(list);
      case 5: { const s = [...list].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
      case 6: return least(list);
      case 7: return list.reduce((a, b) => a + b, 0);
      default: return list.reduce((a, b) => a + b, 0) / list.length;
    }
  };
  const rows = merged.map((m) => ({ x: m.x, y: aggregate(m.group) }));
  if (rows.length < 2) return ERROR.value;
  let step = Infinity;
  for (let i = 1; i < rows.length; i += 1) step = Math.min(step, rows[i].x - rows[i - 1].x);
  if (!(step > 0)) return ERROR.value;
  // Every point on the step's grid; one missing is filled in, by its neighbours or with nought.
  const x = [];
  const y = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) {
      const gaps = Math.round((rows[i].x - rows[i - 1].x) / step);
      if (Math.abs(gaps * step - (rows[i].x - rows[i - 1].x)) > 1e-9 * Math.max(1, Math.abs(step))) return ERROR.value;
      for (let k = 1; k < gaps; k += 1) { x.push(rows[i - 1].x + k * step); y.push(null); }
    }
    x.push(rows[i].x);
    y.push(rows[i].y);
  }
  for (let i = 0; i < y.length; i += 1) {
    if (y[i] !== null) continue;
    if (completion === 0) { y[i] = 0; continue; }
    let a = i - 1;
    let b = i + 1;
    while (b < y.length && y[b] === null) b += 1;
    if (a < 0 || b >= y.length) { y[i] = a < 0 ? y[b] ?? 0 : y[a]; continue; }
    y[i] = y[a] + ((y[b] - y[a]) * (i - a)) / (b - a);
  }
  return { x, y, step };
}

/** Exponential smoothing fitted to a series, LibreOffice's way. */
class Smoothing {
  constructor(data, period, additive) {
    this.x = data.x;
    this.y = data.y;
    this.step = data.step;
    this.n = data.y.length;
    this.additive = additive;
    this.period = period;
    this.alpha = 0;
    this.beta = 0;
    this.gamma = 0;
  }

  /** The period that repeats best, by the differences of the series. */
  periodLength() {
    const y = this.y;
    let best = this.n;
    let bestError = Number.MAX_VALUE;
    for (let len = Math.floor(this.n / 2); len >= 1; len -= 1) {
      let error = 0;
      const periods = Math.floor(this.n / len);
      const start = this.n - periods * len + 1;
      for (let i = start; i < this.n - len; i += 1) error += Math.abs((y[i] - y[i - 1]) - (y[len + i] - y[len + i - 1]));
      error /= (periods - 1) * len - 1;
      if (error <= bestError || error === 0) { best = len; bestError = error; }
    }
    return best;
  }

  init() {
    if (this.period === 0) this.period = this.periodLength();
    this.eds = this.period === 1;
    const n = this.n;
    this.base = new Array(n).fill(0);
    this.trend = new Array(n).fill(0);
    this.season = new Array(Math.max(n, this.period + 1)).fill(0);
    this.forecast = new Array(n).fill(0);
    const y = this.y;
    if (this.eds) this.trend[0] = (y[n - 1] - y[0]) / (n - 1);
    else {
      if (n < 2 * this.period) return ERROR.value;
      let sum = 0;
      for (let i = 0; i < this.period; i += 1) sum += y[i + this.period] - y[i];
      this.trend[0] = sum / (this.period * this.period);
      const periods = Math.floor(n / this.period);
      const averages = [];
      for (let i = 0; i < periods; i += 1) {
        let total = 0;
        for (let j = 0; j < this.period; j += 1) total += y[i * this.period + j];
        averages.push(total / this.period);
        if (averages[i] === 0) return ERROR.div0;
      }
      for (let j = 0; j < this.period; j += 1) {
        let index = 0;
        for (let i = 0; i < periods; i += 1) {
          const expected = averages[i] + (j - 0.5 * (this.period - 1)) * this.trend[0];
          index += this.additive ? y[i * this.period + j] - expected : y[i * this.period + j] / expected;
        }
        this.season[j] = index / periods;
      }
      if (this.period < n) this.season[this.period] = 0;
    }
    this.base[0] = this.eds ? y[0] : this.additive ? y[0] - this.season[0] : y[0] / this.season[0];
    return null;
  }

  refill() {
    const { y } = this;
    for (let i = 1; i < this.n; i += 1) {
      if (this.eds) {
        this.base[i] = this.alpha * y[i] + (1 - this.alpha) * (this.base[i - 1] + this.trend[i - 1]);
        this.trend[i] = this.gamma * (this.base[i] - this.base[i - 1]) + (1 - this.gamma) * this.trend[i - 1];
        this.forecast[i] = this.base[i - 1] + this.trend[i - 1];
      } else {
        let k;
        if (this.additive) {
          k = i > this.period ? i - this.period : i;
          this.base[i] = this.alpha * (y[i] - this.season[k]) + (1 - this.alpha) * (this.base[i - 1] + this.trend[i - 1]);
          this.season[i] = this.beta * (y[i] - this.base[i]) + (1 - this.beta) * this.season[k];
        } else {
          k = i >= this.period ? i - this.period : i;
          this.base[i] = this.alpha * (y[i] / this.season[k]) + (1 - this.alpha) * (this.base[i - 1] + this.trend[i - 1]);
          this.season[i] = this.beta * (y[i] / this.base[i]) + (1 - this.beta) * this.season[k];
        }
        this.trend[i] = this.gamma * (this.base[i] - this.base[i - 1]) + (1 - this.gamma) * this.trend[i - 1];
        this.forecast[i] = this.additive ? this.base[i - 1] + this.trend[i - 1] + this.season[k] : (this.base[i - 1] + this.trend[i - 1]) * this.season[k];
      }
    }
    this.accuracy();
  }

  accuracy() {
    const { y } = this;
    let absolute = 0;
    let squares = 0;
    let percent = 0;
    let divisor = 0;
    for (let i = 1; i < this.n; i += 1) {
      const error = this.forecast[i] - y[i];
      absolute += Math.abs(error);
      squares += error * error;
      percent += Math.abs(error) / (Math.abs(this.forecast[i]) + Math.abs(y[i]));
    }
    for (let i = 2; i < this.n; i += 1) divisor += Math.abs(y[i] - y[i - 1]);
    const count = this.n - 1;
    this.mae = absolute / count;
    this.mase = absolute / ((count * divisor) / (count - 1));
    this.mse = squares / count;
    this.rmse = Math.sqrt(this.mse);
    this.smape = (percent * 2) / count;
  }

  /** The halving search LibreOffice runs over one constant, the ones after it searched at each try. */
  search(set, inner) {
    const tryAt = (v) => { set(v); inner(); return this.mse; };
    let f0 = 0;
    let fE0 = tryAt(f0);
    let f2 = 1;
    let fE2 = tryAt(f2);
    let f1 = 0.5;
    let fE1 = tryAt(f1);
    if (fE0 === fE1 && fE1 === fE2) { tryAt(0); return; }
    while (f2 - f1 > RESOLUTION) {
      if (fE2 > fE0) { f2 = f1; fE2 = fE1; f1 = (f0 + f1) / 2; } else { f0 = f1; fE0 = fE1; f1 = (f1 + f2) / 2; }
      fE1 = tryAt(f1);
    }
    if (fE2 > fE0) { if (fE0 < fE1) tryAt(f0); } else if (fE2 < fE1) tryAt(f2);
  }

  fit() {
    const error = this.init();
    if (error) return error;
    const gammaSearch = () => this.search((v) => { this.gamma = v; }, () => this.refill());
    const betaGamma = () => this.search((v) => { this.beta = v; }, gammaSearch);
    if (this.eds) { this.beta = 0; this.search((v) => { this.alpha = v; }, gammaSearch); } else this.search((v) => { this.alpha = v; }, betaGamma);
    this.accuracy();
    return null;
  }

  /** The value at a time: on the series by its forecasts, after it by level, trend and season. */
  at(target) {
    const { x, y, n, step } = this;
    const last = n - 1;
    if (target <= x[last]) {
      const k = Math.floor((target - x[0]) / step);
      const rest = (target - x[0]) % step;
      let value = y[k];
      if (rest >= RESOLUTION) value += (rest / step) * (this.forecast[k + 1] - value);
      return value;
    }
    const k = Math.floor((target - x[last]) / step);
    const rest = (target - x[last]) % step;
    const ahead = (m) => {
      if (this.eds) return this.base[last] + m * this.trend[last];
      const season = this.season[last - this.period + (m % this.period)];
      return this.additive ? this.base[last] + m * this.trend[last] + season : (this.base[last] + m * this.trend[last]) * season;
    };
    let value = ahead(k);
    if (rest >= RESOLUTION) value += (rest / step) * (ahead(k + 1) - value);
    return value;
  }
}

const num = (arg, fallback = null) => (arg === undefined || arg.missing ? fallback : toNumber(arg.value));

/** The smoothing of the arguments a forecast function takes after its own: period, completion, aggregation. */
function fitted(valuesArg, timelineArg, periodArg, completionArg, aggregationArg, additive) {
  const period = num(periodArg, 1);
  const completion = num(completionArg, 1);
  const aggregation = num(aggregationArg, 1);
  const error = [period, completion, aggregation].find(isError);
  if (error) return error;
  if (period < 0 || period > 8760 || ![0, 1].includes(Math.trunc(completion)) || aggregation < 1 || aggregation > 7) return ERROR.num;
  const data = series(valuesArg, timelineArg, Math.trunc(completion), Math.trunc(aggregation));
  if (isError(data)) return data;
  // A period of 1 asks for it to be found; 0 for none.
  const length = Math.trunc(period) === 1 ? 0 : Math.trunc(period) === 0 ? 1 : Math.trunc(period);
  const model = new Smoothing(data, length, additive);
  const failed = model.fit();
  return failed ?? model;
}

/** Forecasts for every target the first argument holds, in its shape. */
function forecastEach(targetArg, compute) {
  if (targetArg?.matrix) {
    const m = targetArg.matrix;
    return Matrix.of(m.rows, m.cols, (r, c) => { const t = toNumber(m.at(r, c)); return isError(t) ? t : compute(t); });
  }
  const t = num(targetArg);
  return isError(t) ? t : compute(t);
}

/**
 * The half width of the prediction interval at a target. Without a season it is LibreOffice's own formula, step by step;
 * with one, where LibreOffice draws random paths and gives a different width each time, the error grows with the smoothing carried over.
 */
function interval(model, target, level) {
  const z = normalInverse(0.5 + level / 2);
  if (isError(z)) return z;
  const last = model.x[model.n - 1];
  if (target < last) return ERROR.num;
  const steps = Math.floor((target - last) / model.step);
  const rest = (target - last) % model.step;
  if (model.eds) {
    const o = 1 - level;
    const c = (i) => Math.sqrt(1 + (level / (1 + o) ** 3) * ((1 + 4 * o + 5 * o * o) + 2 * i * level * (1 + 3 * o) + 2 * i * i * level * level));
    if (steps < 1) return ERROR.num;
    let factor = c(steps - 1);
    if (rest >= RESOLUTION) factor += (rest / model.step) * (c(steps) - factor);
    return (z * model.rmse * factor) / c(0);
  }
  const ahead = Math.max(1, steps + (rest >= RESOLUTION ? 1 : 0));
  let factor = 0;
  for (let j = 0; j < ahead; j += 1) {
    const c = j === 0 ? 1 : model.alpha * (1 + j * model.gamma);
    factor += c * c;
  }
  return z * model.rmse * Math.sqrt(factor);
}

const STATS = (model, type) => ({
  1: model.alpha, 2: model.gamma, 3: model.beta, 4: model.mase, 5: model.smape, 6: model.mae, 7: model.rmse, 8: model.step, 9: model.period,
}[type] ?? ERROR.num);

export const ETS = {
  'FORECAST.ETS.ADD': (args) => {
    const model = fitted(args[1], args[2], args[3], args[4], args[5], true);
    return isError(model) ? model : forecastEach(args[0], (t) => model.at(t));
  },
  'FORECAST.ETS.MULT': (args) => {
    const model = fitted(args[1], args[2], args[3], args[4], args[5], false);
    return isError(model) ? model : forecastEach(args[0], (t) => model.at(t));
  },
  'FORECAST.ETS.PI.ADD': (args) => {
    const level = num(args[3], 0.95);
    if (isError(level)) return level;
    if (level <= 0 || level >= 1) return ERROR.num;
    const model = fitted(args[1], args[2], args[4], args[5], args[6], true);
    return isError(model) ? model : forecastEach(args[0], (t) => interval(model, t, level));
  },
  'FORECAST.ETS.PI.MULT': (args) => {
    const level = num(args[3], 0.95);
    if (isError(level)) return level;
    if (level <= 0 || level >= 1) return ERROR.num;
    const model = fitted(args[1], args[2], args[4], args[5], args[6], false);
    return isError(model) ? model : forecastEach(args[0], (t) => interval(model, t, level));
  },
  'FORECAST.ETS.SEASONALITY': (args) => {
    const model = fitted(args[0], args[1], undefined, args[2], args[3], true);
    return isError(model) ? model : model.period;
  },
  'FORECAST.ETS.STAT.ADD': (args) => {
    const model = fitted(args[0], args[1], args[3], args[4], args[5], true);
    return isError(model) ? model : forecastEach(args[2], (t) => STATS(model, Math.trunc(t)));
  },
  'FORECAST.ETS.STAT.MULT': (args) => {
    const model = fitted(args[0], args[1], args[3], args[4], args[5], false);
    return isError(model) ? model : forecastEach(args[2], (t) => STATS(model, Math.trunc(t)));
  },
};
