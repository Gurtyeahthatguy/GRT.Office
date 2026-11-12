/** Money: loans and annuities, depreciation, cash flows, and bonds with their coupon dates and day counts. */

import { ERROR, isError, toNumber, toBoolean, collectNumbers, typedNumber } from '../engine/values.js';
import { dayOf, serialOf, isLeap, daysInMonth, yearFrac } from './datetime.js';

/** One number from an argument; a missing one takes the fallback, or is an error without one. */
function numberArg(arg, fallback = null) {
  if (arg === undefined || arg.missing) return fallback === null ? ERROR.value : fallback;
  if (arg.matrix && arg.matrix.rows * arg.matrix.cols === 1) return toNumber(arg.matrix.first);
  return toNumber(arg.value);
}

/** The arguments as numbers, with defaults for the optional ones, or the first error. */
function numbersIn(args, fallbacks) {
  if (args.length > fallbacks.length) return ERROR.value;
  const out = [];
  for (let i = 0; i < fallbacks.length; i += 1) {
    const n = numberArg(args[i], fallbacks[i]);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

const finite = (value) => (isError(value) ? value : Number.isFinite(value) ? value : ERROR.num);

/** A function of numbers: `fallbacks` gives each argument's default, null for a required one. */
const fn = (fallbacks, apply) => (args) => {
  const values = numbersIn(args, fallbacks);
  if (isError(values)) return values;
  return finite(apply(...values));
};

/** Every number in the arguments, ranges by the range rule. */
function flowsOf(args) {
  const out = [];
  for (const arg of args) {
    if (!arg || arg.missing) continue;
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

/** Newton's method from a guess; null when it does not settle. */
function solve(f, guess, { steps = 150, tolerance = 1e-10 } = {}) {
  let x = guess;
  for (let i = 0; i < steps; i += 1) {
    const y = f(x);
    if (!Number.isFinite(y)) return null;
    const h = Math.max(1e-7, Math.abs(x) * 1e-7);
    const slope = (f(x + h) - f(x - h)) / (2 * h);
    if (!Number.isFinite(slope) || slope === 0) return null;
    const next = x - y / slope;
    if (!Number.isFinite(next)) return null;
    if (Math.abs(next - x) <= tolerance * Math.max(1, Math.abs(next))) return next;
    x = next;
  }
  return null;
}

/** Half away from zero, as both programs round money. */
const roundHalf = (n, digits = 0) => {
  const factor = 10 ** digits;
  return (Math.sign(n) * Math.round(Number((Math.abs(n) * factor).toPrecision(15)))) / factor;
};

// Loans and annuities

function fv(rate, nper, pmt, pv, type) {
  if (rate === 0) return -(pv + pmt * nper);
  const growth = (1 + rate) ** nper;
  return -(pv * growth + (pmt * (1 + rate * type) * (growth - 1)) / rate);
}

function pmt(rate, nper, pv, future, type) {
  if (rate === 0) return -(pv + future) / nper;
  const growth = (1 + rate) ** nper;
  return (-(future + pv * growth) * rate) / ((1 + rate * type) * (growth - 1));
}

function pv(rate, nper, payment, future, type) {
  if (rate === 0) return -(future + payment * nper);
  const growth = (1 + rate) ** nper;
  return -(future + (payment * (1 + rate * type) * (growth - 1)) / rate) / growth;
}

/** The interest part of one payment. */
function ipmt(rate, per, nper, present, future, type) {
  const payment = pmt(rate, nper, present, future, type);
  let interest;
  if (per === 1) interest = type > 0 ? 0 : -present;
  else interest = type > 0 ? fv(rate, per - 2, payment, present, 1) - payment : fv(rate, per - 1, payment, present, 0);
  return interest * rate;
}

const flag = (type) => (type !== 0 ? 1 : 0);

function cumulative(args, principal) {
  const values = numbersIn(args, [null, null, null, null, null, null]);
  if (isError(values)) return values;
  const [rate, nper, present, start, end, type] = values;
  const first = Math.trunc(start);
  const last = Math.trunc(end);
  if (first < 1 || last < first || rate <= 0 || last > nper || nper <= 0 || present <= 0 || (type !== 0 && type !== 1)) return ERROR.num;
  const payment = pmt(rate, nper, present, 0, type);
  let sum = 0;
  for (let i = first; i <= last; i += 1) {
    const interest = i === 1 ? (type > 0 ? 0 : -present * rate) : (type > 0 ? fv(rate, i - 2, payment, present, 1) - payment : fv(rate, i - 1, payment, present, 0)) * rate;
    sum += principal ? payment - interest : interest;
  }
  return finite(sum);
}

function rate(nper, payment, present, future, type, guess) {
  if (nper <= 0) return ERROR.num;
  // Written with expm1 and log1p, so a rate close to zero keeps its digits.
  const f = (r) => {
    if (Math.abs(r) < 1e-15) return present + payment * nper + future;
    const growth = Math.expm1(nper * Math.log1p(r));
    return present * (growth + 1) + (payment * (1 + r * type) * growth) / r + future;
  };
  for (const start of [guess, 0.01, 0.1, 0.5, -0.5, 1]) {
    const rough = solve(f, start);
    const found = rough === null ? null : solve(f, rough, { steps: 20, tolerance: 1e-15 }) ?? rough;
    if (found !== null && found > -1 && Math.abs(f(found)) < 1e-6 * Math.max(1, Math.abs(present), Math.abs(future))) return found;
  }
  return ERROR.num;
}

// Depreciation

function ddb(cost, salvage, life, period, factor) {
  let rate = factor / life;
  let before;
  if (rate >= 1) {
    rate = 1;
    before = period === 1 ? cost : 0;
  } else before = cost * (1 - rate) ** (period - 1);
  const after = cost * (1 - rate) ** period;
  const value = after < salvage ? before - salvage : before - after;
  return value < 0 ? 0 : value;
}

/** Declining balance that switches to straight line when that gives more, over a whole number of periods. */
function interVdb(cost, salvage, life, life1, period, factor) {
  let total = 0;
  const end = Math.ceil(period);
  let rest = cost - salvage;
  let straight = 0;
  let switched = false;
  for (let i = 1; i <= end; i += 1) {
    let term;
    if (!switched) {
      const declining = ddb(cost, salvage, life, i, factor);
      straight = rest / (life1 - (i - 1));
      if (straight > declining) {
        term = straight;
        switched = true;
      } else {
        term = declining;
        rest -= declining;
      }
    } else term = straight;
    if (i === end) term *= period + 1 - end;
    total += term;
  }
  return total;
}

const near = (a, b) => Math.abs(a - b) < 1e-12 * Math.max(1, Math.abs(a));

function vdb(args) {
  const values = numbersIn(args.slice(0, 6), [null, null, null, null, null, 2]);
  if (isError(values)) return values;
  let [cost, salvage, life, start, end, factor] = values;
  const noSwitch = args[6] && !args[6].missing ? toBoolean(args[6].value) === true : false;
  if (start < 0 || end < start || end > life || cost < 0 || salvage > cost || factor <= 0) return ERROR.num;
  const intStart = Math.floor(start);
  const intEnd = Math.ceil(end);
  if (noSwitch) {
    let total = 0;
    for (let i = intStart + 1; i <= intEnd; i += 1) {
      let term = ddb(cost, salvage, life, i, factor);
      if (i === intStart + 1) term *= Math.min(end, intStart + 1) - start;
      else if (i === intEnd) term *= end + 1 - intEnd;
      total += term;
    }
    return finite(total);
  }
  let part = 0;
  if (!near(start, intStart)) {
    const value = cost - interVdb(cost, salvage, life, life, intStart, factor);
    part += (start - intStart) * interVdb(value, salvage, life, life - intStart, 1, factor);
  }
  if (!near(end, intEnd)) {
    const value = cost - interVdb(cost, salvage, life, life, intEnd - 1, factor);
    part += (intEnd - end) * interVdb(value, salvage, life, life - (intEnd - 1), 1, factor);
  }
  cost -= interVdb(cost, salvage, life, life, intStart, factor);
  return finite(interVdb(cost, salvage, life, life - intStart, intEnd - intStart, factor) - part);
}

function db(args) {
  const values = numbersIn(args, [null, null, null, null, 12]);
  if (isError(values)) return values;
  const [cost, salvage, life, period, months] = values;
  if (months < 1 || months > 12 || life > 1200 || salvage < 0 || period > life + 1 || salvage > cost || cost <= 0 || life <= 0 || period <= 0) return ERROR.num;
  const rate = Math.floor((1 - (salvage / cost) ** (1 / life)) * 1000 + 0.5) / 1000;
  const first = (cost * rate * months) / 12;
  if (Math.floor(period) === 1) return first;
  let sum = first;
  let value = 0;
  for (let i = 2; i <= Math.min(life, period); i += 1) {
    value = (cost - sum) * rate;
    sum += value;
  }
  if (period > life) value = ((cost - sum) * rate * (12 - months)) / 12;
  return finite(value);
}

// Day counts, as the analysis functions use them

/** Days between two dates by the 30/360 rule ODF gives, the US way or the European one. */
function diff360(from, to, us) {
  const a = dayOf(from);
  const b = dayOf(to);
  let d1 = a.day;
  let d2 = b.day;
  let m2 = b.month;
  let y2 = b.year;
  if (d1 === 31) d1 -= 1;
  else if (us && a.month === 2 && (d1 === 29 || (d1 === 28 && !isLeap(a.year)))) d1 = 30;
  if (d2 === 31) {
    if (us && d1 !== 30) {
      d2 = 1;
      m2 += 1;
      if (m2 > 12) { m2 = 1; y2 += 1; }
    } else d2 = 30;
  }
  return d2 + m2 * 30 + y2 * 360 - d1 - a.month * 30 - a.year * 360;
}

/** Days between two dates and the days in the first year, by basis. */
function diffDate(from, to, basis) {
  switch (basis) {
    case 0: return { days: diff360(from, to, true), year: 360 };
    case 4: return { days: diff360(from, to, false), year: 360 };
    case 1: return { days: to - from, year: isLeap(dayOf(from).year) ? 366 : 365 };
    case 2: return { days: to - from, year: 360 };
    default: return { days: to - from, year: 365 };
  }
}

const yearDiff = (from, to, basis) => {
  const { days, year } = diffDate(from, to, basis);
  return days / year;
};

/** A coupon date: a month of a year, on the maturity's day or the last of the month when the maturity was. */
class CouponDate {
  constructor(serial) {
    const d = dayOf(serial);
    this.year = d.year;
    this.month = d.month;
    this.day = d.day;
    this.last = d.day >= daysInMonth(d.year, d.month);
  }

  get serial() {
    const dim = daysInMonth(this.year, this.month);
    return serialOf(this.year, this.month, this.last ? dim : Math.min(this.day, dim));
  }

  addMonths(n) {
    const total = this.year * 12 + (this.month - 1) + n;
    this.year = Math.floor(total / 12);
    this.month = total - this.year * 12 + 1;
    return this;
  }
}

function previousCoupon(settle, maturity, frequency) {
  const date = new CouponDate(maturity);
  date.year = dayOf(settle).year;
  if (date.serial < settle) date.addMonths(12);
  while (date.serial > settle) date.addMonths(-12 / frequency);
  return date;
}

function nextCoupon(settle, maturity, frequency) {
  const date = new CouponDate(maturity);
  date.year = dayOf(settle).year;
  if (date.serial > settle) date.addMonths(-12);
  while (date.serial <= settle) date.addMonths(12 / frequency);
  return date;
}

function couponDays(settle, maturity, frequency, basis) {
  if (basis === 1) {
    const before = previousCoupon(settle, maturity, frequency);
    const start = before.serial;
    return before.addMonths(12 / frequency).serial - start;
  }
  return (basis === 3 ? 365 : 360) / frequency;
}

/** A date's day in a 30-day month: the last day of a month, and anything past the 30th, is the 30th. */
function day30(date) {
  const dim = daysInMonth(date.year, date.month);
  const day = Math.min(date.day, 30);
  return date.last || day >= dim ? 30 : day;
}

/** Days from the previous coupon to the settlement, counted as the coupon functions of both programs count them. */
function couponDaysBefore(settle, maturity, frequency, basis) {
  const before = previousCoupon(settle, maturity, frequency);
  if (basis !== 0 && basis !== 4) return settle - before.serial;
  const after = new CouponDate(settle);
  let from = day30(before);
  let to = day30(after);
  if (basis === 0) {
    if ((before.month === 2 || from < 30) && after.day === 31) to = 31;
  } else {
    if (before.month === 2 && from === 30) from = daysInMonth(before.year, 2);
    if (after.month === 2 && to === 30) to = daysInMonth(after.year, 2);
  }
  return (after.year * 12 + after.month) * 30 + to - ((before.year * 12 + before.month) * 30 + from);
}

function couponDaysAfter(settle, maturity, frequency, basis) {
  if (basis !== 0 && basis !== 4) return nextCoupon(settle, maturity, frequency).serial - settle;
  return couponDays(settle, maturity, frequency, basis) - couponDaysBefore(settle, maturity, frequency, basis);
}

function couponCount(settle, maturity, frequency) {
  const before = previousCoupon(settle, maturity, frequency);
  const end = dayOf(maturity);
  return (((end.year - before.year) * 12 + end.month - before.month) * frequency) / 12;
}

function bondPrice(settle, maturity, rate, yld, redemption, frequency, basis) {
  const e = couponDays(settle, maturity, frequency, basis);
  const dsc = couponDaysAfter(settle, maturity, frequency, basis) / e;
  const n = couponCount(settle, maturity, frequency);
  const a = couponDaysBefore(settle, maturity, frequency, basis);
  let price = redemption / (1 + yld / frequency) ** (n - 1 + dsc);
  price -= ((100 * rate) / frequency) * (a / e);
  const coupon = (100 * rate) / frequency;
  for (let k = 0; k < n; k += 1) price += coupon / (1 + yld / frequency) ** (k + dsc);
  return price;
}

function bondYield(settle, maturity, rate, price, redemption, frequency, basis) {
  let low = 0;
  let high = 1;
  let priceLow = bondPrice(settle, maturity, rate, low, redemption, frequency, basis);
  let priceHigh = bondPrice(settle, maturity, rate, high, redemption, frequency, basis);
  let guess = (high - low) * 0.5;
  let priceGuess = 0;
  for (let i = 0; i < 100 && priceGuess !== price; i += 1) {
    priceGuess = bondPrice(settle, maturity, rate, guess, redemption, frequency, basis);
    if (price === priceLow) return low;
    if (price === priceHigh) return high;
    if (price === priceGuess) return guess;
    if (price < priceHigh) {
      high *= 2;
      priceHigh = bondPrice(settle, maturity, rate, high, redemption, frequency, basis);
      guess = (high - low) * 0.5;
    } else {
      if (price < priceGuess) { low = guess; priceLow = priceGuess; } else { high = guess; priceHigh = priceGuess; }
      guess = high - (high - low) * ((price - priceHigh) / (priceLow - priceHigh));
    }
  }
  return Math.abs(price - priceGuess) > price / 100 ? ERROR.num : guess;
}

function macaulay(settle, maturity, coupon, yld, frequency, basis) {
  const years = yearFrac(settle, maturity, basis);
  const n = couponCount(settle, maturity, frequency);
  const payment = (coupon * 100) / frequency;
  const growth = yld / frequency + 1;
  const shift = years * frequency - n;
  let weighted = 0;
  let price = 0;
  for (let t = 1; t < n; t += 1) {
    weighted += ((t + shift) * payment) / growth ** (t + shift);
    price += payment / growth ** (t + shift);
  }
  weighted += ((n + shift) * (payment + 100)) / growth ** (n + shift);
  price += (payment + 100) / growth ** (n + shift);
  return weighted / price / frequency;
}

/** The arguments of a bond function: dates first, then numbers; frequency and basis checked. */
function bondArgs(args, fallbacks, { dates = 2, frequencyAt = -1, basisAt = -1 } = {}) {
  const values = numbersIn(args, fallbacks);
  if (isError(values)) return values;
  for (let i = 0; i < dates; i += 1) values[i] = Math.floor(values[i]);
  if (basisAt >= 0) {
    values[basisAt] = Math.trunc(values[basisAt]);
    if (values[basisAt] < 0 || values[basisAt] > 4) return ERROR.num;
  }
  if (frequencyAt >= 0) {
    values[frequencyAt] = Math.trunc(values[frequencyAt]);
    if (![1, 2, 4].includes(values[frequencyAt])) return ERROR.num;
  }
  return values;
}

const bond = (fallbacks, layout, apply) => (args) => {
  const values = bondArgs(args, fallbacks, layout);
  if (isError(values)) return values;
  return finite(apply(...values));
};

/** Excel's price of a bond whose first period is odd, by its quasi-coupon periods. */
function oddFirstPrice(settle, maturity, issue, first, rate, yld, redemption, frequency, basis) {
  const months = 12 / frequency;
  const days = (from, to) => diffDate(from, to, basis).days;
  const period = (serial) => (basis === 1 ? couponDays(serial, first, frequency, 1) : (basis === 3 ? 365 : 360) / frequency);
  const n = couponCount(first, maturity, frequency) + 1;
  const e = period(settle);
  const dsc = days(settle, first);
  const coupon = (100 * rate) / frequency;
  const growth = 1 + yld / frequency;
  // Quasi-coupon periods from the issue to the first coupon: one for a short period, several for a long one.
  const quasi = [];
  let end = new CouponDate(first);
  let start = new CouponDate(first).addMonths(-months);
  quasi.push({ start: start.serial, end: end.serial });
  while (quasi[quasi.length - 1].start > issue) {
    end = new CouponDate(quasi[quasi.length - 1].start);
    start = new CouponDate(quasi[quasi.length - 1].start).addMonths(-months);
    quasi.push({ start: start.serial, end: end.serial });
    if (quasi.length > 1000) return ERROR.num;
  }
  if (quasi.length === 1) {
    const dfc = days(issue, first);
    const a = days(issue, settle);
    let price = redemption / growth ** (n - 1 + dsc / e);
    price += (coupon * (dfc / e)) / growth ** (dsc / e);
    for (let k = 2; k <= n; k += 1) price += coupon / growth ** (k - 1 + dsc / e);
    return price - coupon * (a / e);
  }
  let accrued = 0;
  let paid = 0;
  for (const q of quasi) {
    const length = basis === 1 ? q.end - q.start : (basis === 3 ? 365 : 360) / frequency;
    const from = Math.max(issue, q.start);
    paid += days(from, q.end) / length;
    if (settle > q.start) accrued += days(from, Math.min(settle, q.end)) / length;
  }
  const settlePeriod = quasi.find((q) => settle >= q.start && settle < q.end) ?? quasi[0];
  const length = basis === 1 ? settlePeriod.end - settlePeriod.start : (basis === 3 ? 365 : 360) / frequency;
  const dsq = days(settle, settlePeriod.end) / length;
  const before = quasi.findIndex((q) => q === settlePeriod);
  let price = redemption / growth ** (n - 1 + before + dsq);
  price += (coupon * paid) / growth ** (before + dsq);
  for (let k = 2; k <= n; k += 1) price += coupon / growth ** (k - 1 + before + dsq);
  return price - coupon * accrued;
}

// The library

export const FINANCIAL = {
  FV: fn([null, null, null, 0, 0], (r, n, payment, present, type) => fv(r, n, payment, present, flag(type))),
  PV: fn([null, null, null, 0, 0], (r, n, payment, future, type) => pv(r, n, payment, future, flag(type))),
  PMT: fn([null, null, null, 0, 0], (r, n, present, future, type) => (n === 0 ? ERROR.div0 : pmt(r, n, present, future, flag(type)))),
  NPER: fn([null, null, null, 0, 0], (r, payment, present, future, type) => {
    if (r === 0) return payment === 0 ? ERROR.div0 : -(present + future) / payment;
    const t = flag(type);
    return Math.log(-(r * future - payment * (1 + r * t)) / (r * present + payment * (1 + r * t))) / Math.log1p(r);
  }),
  IPMT: fn([null, null, null, null, 0, 0], (r, per, n, present, future, type) => (per < 1 || per >= n + 1 ? ERROR.num : ipmt(r, per, n, present, future, flag(type)))),
  PPMT: fn([null, null, null, null, 0, 0], (r, per, n, present, future, type) => (per < 1 || per >= n + 1 ? ERROR.num
    : pmt(r, n, present, future, flag(type)) - ipmt(r, per, n, present, future, flag(type)))),
  ISPMT: fn([null, null, null, null], (r, per, n, present) => (n === 0 ? ERROR.div0 : present * r * (per / n - 1))),
  CUMIPMT: (args) => cumulative(args, false),
  CUMPRINC: (args) => cumulative(args, true),
  RATE: fn([null, null, null, 0, 0, 0.1], (n, payment, present, future, type, guess) => rate(n, payment, present, future, flag(type), guess)),
  NPV: (args) => {
    const r = numberArg(args[0]);
    if (isError(r)) return r;
    const flows = flowsOf(args.slice(1));
    if (isError(flows)) return flows;
    return finite(flows.reduce((sum, v, i) => sum + v / (1 + r) ** (i + 1), 0));
  },
  IRR: (args) => {
    const flows = flowsOf(args.slice(0, 1));
    if (isError(flows)) return flows;
    const guess = numberArg(args[1], 0.1);
    if (isError(guess)) return guess;
    const f = (r) => flows.reduce((sum, v, i) => sum + v / (1 + r) ** i, 0);
    const found = solve(f, guess);
    return found === null ? ERROR.num : found;
  },
  MIRR: (args) => {
    const flows = flowsOf(args.slice(0, 1));
    if (isError(flows)) return flows;
    const values = numbersIn(args.slice(1), [null, null]);
    if (isError(values)) return values;
    const [finance, reinvest] = values;
    const n = flows.length;
    let positive = 0;
    let negative = 0;
    flows.forEach((v, i) => {
      if (v > 0) positive += v * (1 + reinvest) ** (n - 1 - i);
      else if (v < 0) negative += v / (1 + finance) ** i;
    });
    if (positive === 0 || negative === 0 || n < 2) return ERROR.num;
    return finite((-positive / negative) ** (1 / (n - 1)) - 1);
  },
  XNPV: (args) => {
    const r = numberArg(args[0]);
    if (isError(r)) return r;
    const flows = flowsOf(args.slice(1, 2));
    const dates = flowsOf(args.slice(2, 3));
    if (isError(flows)) return flows;
    if (isError(dates)) return dates;
    if (flows.length !== dates.length || flows.length === 0) return ERROR.num;
    return finite(flows.reduce((sum, v, i) => sum + v / (1 + r) ** ((Math.floor(dates[i]) - Math.floor(dates[0])) / 365), 0));
  },
  XIRR: (args) => {
    const flows = flowsOf(args.slice(0, 1));
    const dates = flowsOf(args.slice(1, 2));
    if (isError(flows)) return flows;
    if (isError(dates)) return dates;
    const guess = numberArg(args[2], 0.1);
    if (isError(guess)) return guess;
    if (flows.length !== dates.length || flows.length < 2) return ERROR.num;
    const f = (r) => flows.reduce((sum, v, i) => sum + v / (1 + r) ** ((Math.floor(dates[i]) - Math.floor(dates[0])) / 365), 0);
    const found = solve(f, guess);
    return found === null || found <= -1 ? ERROR.num : found;
  },
  FVSCHEDULE: (args) => {
    const principal = numberArg(args[0]);
    if (isError(principal)) return principal;
    const rates = flowsOf(args.slice(1));
    return isError(rates) ? rates : finite(rates.reduce((value, r) => value * (1 + r), principal));
  },
  EFFECT: fn([null, null], (nominal, periods) => {
    const n = Math.trunc(periods);
    return nominal < 0 || n < 1 ? ERROR.num : (1 + nominal / n) ** n - 1;
  }),
  EFFECT_ADD: fn([null, null], (nominal, periods) => {
    const n = Math.trunc(periods);
    return nominal <= 0 || n < 1 ? ERROR.num : (1 + nominal / n) ** n - 1;
  }),
  NOMINAL: fn([null, null], (effect, periods) => {
    const n = Math.trunc(periods);
    return effect <= 0 || n < 1 ? ERROR.num : ((effect + 1) ** (1 / n) - 1) * n;
  }),
  RRI: fn([null, null, null], (n, present, future) => (n <= 0 ? ERROR.num : (future / present) ** (1 / n) - 1)),
  PDURATION: fn([null, null, null], (r, present, future) => (r <= 0 || present <= 0 || future <= 0 ? ERROR.num : Math.log(future / present) / Math.log1p(r))),

  SLN: fn([null, null, null], (cost, salvage, life) => (life === 0 ? ERROR.div0 : (cost - salvage) / life)),
  SYD: fn([null, null, null, null], (cost, salvage, life, per) => (life <= 0 || per <= 0 || per > life ? ERROR.num
    : ((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1)))),
  DDB: fn([null, null, null, null, 2], (cost, salvage, life, period, factor) => (cost < 0 || salvage < 0 || factor <= 0 || salvage > cost || period < 1 || period > life
    ? ERROR.num : ddb(cost, salvage, life, period, factor))),
  DB: db,
  VDB: vdb,
  AMORLINC: (args) => {
    const values = bondArgs(args, [null, null, null, null, null, null, 0], { dates: 0, basisAt: 6 });
    if (isError(values)) return values;
    const [cost, bought, firstPeriod, salvage, period, r, basis] = values;
    if (r <= 0 || cost < 0 || salvage < 0 || period < 0) return ERROR.num;
    const yearly = cost * r;
    const delta = cost - salvage;
    const first = yearFrac(Math.floor(bought), Math.floor(firstPeriod), basis) * r * cost;
    const full = Math.trunc((delta - first) / yearly);
    const per = Math.trunc(period);
    if (per === 0) return finite(first);
    if (per <= full) return finite(yearly);
    if (per === full + 1) return finite(delta - yearly * full - first);
    return 0;
  },
  AMORDEGRC: (args) => {
    const values = bondArgs(args, [null, null, null, null, null, null, 0], { dates: 0, basisAt: 6 });
    if (isError(values)) return values;
    let [cost, bought, firstPeriod, salvage, period, r, basis] = values;
    if (r <= 0 || cost < 0 || salvage < 0 || period < 0) return ERROR.num;
    const per = Math.trunc(period);
    const life = 1 / r;
    r *= life < 3 ? 1 : life < 5 ? 1.5 : life <= 6 ? 2 : 2.5;
    let amount = roundHalf(yearFrac(Math.floor(bought), Math.floor(firstPeriod), basis) * r * cost);
    cost -= amount;
    let rest = cost - salvage;
    for (let n = 0; n < per; n += 1) {
      amount = roundHalf(r * cost);
      rest -= amount;
      if (rest < 0) return per - n <= 1 ? roundHalf(cost * 0.5) : 0;
      cost -= amount;
    }
    return finite(amount);
  },

  COUPPCD: bond([null, null, null, 0], { frequencyAt: 2, basisAt: 3 }, (s, m, f) => (s >= m ? ERROR.num : previousCoupon(s, m, f).serial)),
  COUPNCD: bond([null, null, null, 0], { frequencyAt: 2, basisAt: 3 }, (s, m, f) => (s >= m ? ERROR.num : nextCoupon(s, m, f).serial)),
  COUPNUM: bond([null, null, null, 0], { frequencyAt: 2, basisAt: 3 }, (s, m, f) => (s >= m ? ERROR.num : couponCount(s, m, f))),
  COUPDAYS: bond([null, null, null, 0], { frequencyAt: 2, basisAt: 3 }, (s, m, f, b) => (s >= m ? ERROR.num : couponDays(s, m, f, b))),
  COUPDAYBS: bond([null, null, null, 0], { frequencyAt: 2, basisAt: 3 }, (s, m, f, b) => (s >= m ? ERROR.num : couponDaysBefore(s, m, f, b))),
  COUPDAYSNC: bond([null, null, null, 0], { frequencyAt: 2, basisAt: 3 }, (s, m, f, b) => (s >= m ? ERROR.num : couponDaysAfter(s, m, f, b))),
  PRICE: bond([null, null, null, null, null, null, 0], { frequencyAt: 5, basisAt: 6 }, (s, m, r, y, red, f, b) => (
    s >= m || r < 0 || y < 0 || red <= 0 ? ERROR.num : bondPrice(s, m, r, y, red, f, b))),
  YIELD: bond([null, null, null, null, null, null, 0], { frequencyAt: 5, basisAt: 6 }, (s, m, r, p, red, f, b) => (
    s >= m || r < 0 || p <= 0 || red <= 0 ? ERROR.num : bondYield(s, m, r, p, red, f, b))),
  DURATION: bond([null, null, null, null, null, 0], { frequencyAt: 4, basisAt: 5 }, (s, m, c, y, f, b) => (
    s >= m || c < 0 || y < 0 ? ERROR.num : macaulay(s, m, c, y, f, b))),
  MDURATION: bond([null, null, null, null, null, 0], { frequencyAt: 4, basisAt: 5 }, (s, m, c, y, f, b) => (
    s >= m || c < 0 || y < 0 ? ERROR.num : macaulay(s, m, c, y, f, b) / (1 + y / f))),
  PRICEDISC: bond([null, null, null, null, 0], { basisAt: 4 }, (s, m, d, red, b) => (
    s >= m || d <= 0 || red <= 0 ? ERROR.num : red * (1 - d * yearDiff(s, m, b)))),
  PRICEMAT: bond([null, null, null, null, null, 0], { dates: 3, basisAt: 5 }, (s, m, issue, r, y, b) => {
    if (s >= m || r < 0 || y < 0) return ERROR.num;
    const issueToMat = yearFrac(issue, m, b);
    const issueToSettle = yearFrac(issue, s, b);
    const settleToMat = yearFrac(s, m, b);
    return ((1 + issueToMat * r) / (1 + settleToMat * y) - issueToSettle * r) * 100;
  }),
  YIELDDISC: bond([null, null, null, null, 0], { basisAt: 4 }, (s, m, p, red, b) => (
    s >= m || p <= 0 || red <= 0 ? ERROR.num : (red / p - 1) / yearFrac(s, m, b))),
  YIELDMAT: bond([null, null, null, null, null, 0], { dates: 3, basisAt: 5 }, (s, m, issue, r, p, b) => {
    if (s >= m || r < 0 || p <= 0) return ERROR.num;
    const issueToMat = yearFrac(issue, m, b);
    const issueToSettle = yearFrac(issue, s, b);
    const settleToMat = yearFrac(s, m, b);
    return ((1 + issueToMat * r) / (p / 100 + issueToSettle * r) - 1) / settleToMat;
  }),
  DISC: bond([null, null, null, null, 0], { basisAt: 4 }, (s, m, p, red, b) => (
    s >= m || p <= 0 || red <= 0 ? ERROR.num : (1 - p / red) / yearFrac(s, m, b))),
  INTRATE: bond([null, null, null, null, 0], { basisAt: 4 }, (s, m, invest, red, b) => (
    s >= m || invest <= 0 || red <= 0 ? ERROR.num : (red / invest - 1) / yearDiff(s, m, b))),
  RECEIVED: bond([null, null, null, null, 0], { basisAt: 4 }, (s, m, invest, d, b) => (
    s >= m || invest <= 0 || d <= 0 ? ERROR.num : invest / (1 - d * yearDiff(s, m, b)))),
  ACCRINT: (args) => {
    const values = bondArgs(args.slice(0, 7), [null, null, null, null, 1000, null, 0], { dates: 3, frequencyAt: 5, basisAt: 6 });
    if (isError(values)) return values;
    const [issue, , settle, r, par, , b] = values;
    return r <= 0 || par <= 0 || issue >= settle ? ERROR.num : finite(par * r * yearDiff(issue, settle, b));
  },
  ACCRINTM: bond([null, null, null, 1000, 0], { basisAt: 4 }, (issue, settle, r, par, b) => (
    r <= 0 || par <= 0 || issue >= settle ? ERROR.num : par * r * yearDiff(issue, settle, b))),
  TBILLEQ: bond([null, null, null], {}, (s, m, d) => {
    const days = diff360(s, m + 1, true);
    return d <= 0 || s >= m || days > 360 ? ERROR.num : (365 * d) / (360 - d * days);
  }),
  TBILLPRICE: bond([null, null, null], {}, (s, m, d) => {
    const fraction = yearFrac(s, m + 1, 0);
    return d <= 0 || s > m || fraction > 1 ? ERROR.num : 100 * (1 - d * fraction);
  }),
  TBILLYIELD: bond([null, null, null], {}, (s, m, p) => {
    const days = diff360(s, m, true) + 1;
    return p <= 0 || s >= m || days > 360 ? ERROR.num : ((100 / p - 1) / days) * 360;
  }),
  ODDLPRICE: bond([null, null, null, null, null, null, null, 0], { dates: 3, frequencyAt: 6, basisAt: 7 }, (s, m, last, r, y, red, f, b) => {
    if (r < 0 || y < 0 || !(m > s && s > last)) return ERROR.num;
    const dci = yearFrac(last, m, b) * f;
    const dsci = yearFrac(s, m, b) * f;
    const ai = yearFrac(last, s, b) * f;
    return (red + (dci * 100 * r) / f) / ((dsci * y) / f + 1) - (ai * 100 * r) / f;
  }),
  ODDLYIELD: bond([null, null, null, null, null, null, null, 0], { dates: 3, frequencyAt: 6, basisAt: 7 }, (s, m, last, r, p, red, f, b) => {
    if (r < 0 || p <= 0 || !(m > s && s > last)) return ERROR.num;
    const dci = yearFrac(last, m, b) * f;
    const dsci = yearFrac(s, m, b) * f;
    const ai = yearFrac(last, s, b) * f;
    return ((red + (dci * 100 * r) / f) / (p + (ai * 100 * r) / f) - 1) * (f / dsci);
  }),
  ODDFPRICE: bond([null, null, null, null, null, null, null, null, 0], { dates: 4, frequencyAt: 7, basisAt: 8 }, (s, m, issue, first, r, y, red, f, b) => (
    r < 0 || y < 0 || red <= 0 || !(m > first && first > s && s > issue) ? ERROR.num : oddFirstPrice(s, m, issue, first, r, y, red, f, b))),
  ODDFYIELD: bond([null, null, null, null, null, null, null, null, 0], { dates: 4, frequencyAt: 7, basisAt: 8 }, (s, m, issue, first, r, p, red, f, b) => {
    if (r < 0 || p <= 0 || red <= 0 || !(m > first && first > s && s > issue)) return ERROR.num;
    const found = solve((y) => oddFirstPrice(s, m, issue, first, r, y, red, f, b) - p, r || 0.05);
    return found === null ? ERROR.num : found;
  }),

  DOLLARDE: fn([null, null], (value, fraction) => {
    const f = Math.trunc(fraction);
    if (f <= 0) return ERROR.num;
    const whole = Math.trunc(value);
    return whole + ((value - whole) * 10 ** Math.ceil(Math.log10(f))) / f;
  }),
  DOLLARFR: fn([null, null], (value, fraction) => {
    const f = Math.trunc(fraction);
    if (f <= 0) return ERROR.num;
    const whole = Math.trunc(value);
    return whole + ((value - whole) * f) / 10 ** Math.ceil(Math.log10(f));
  }),
};

// The analysis add-in's versions give the same sums.
FINANCIAL.CUMIPMT_ADD = FINANCIAL.CUMIPMT;
FINANCIAL.CUMPRINC_ADD = FINANCIAL.CUMPRINC;
FINANCIAL.NOMINAL_ADD = FINANCIAL.NOMINAL;
