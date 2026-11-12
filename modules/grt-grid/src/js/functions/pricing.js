/** Options under Black and Scholes: barriers, touches, and the chance of hitting a level or ending past one. */

import { ERROR, isError, toNumber, toText } from '../engine/values.js';
import { normal } from './special.js';

/** A market: spot, volatility, domestic and foreign rates, time to maturity in years. */
class Market {
  constructor(spot, vol, rd, rf, tau) {
    Object.assign(this, { spot, vol, rd, rf, tau });
  }

  with(change) {
    return new Market(change.spot ?? this.spot, change.vol ?? this.vol, change.rd ?? this.rd, change.rf ?? this.rf, change.tau ?? this.tau);
  }

  d1(spot, strike) {
    return (Math.log(spot / strike) + (this.rd - this.rf + 0.5 * this.vol * this.vol) * this.tau) / (this.vol * Math.sqrt(this.tau));
  }

  /** Pays 1 at maturity when the price ends above a level (up = 1) or below it (up = -1). */
  cash(spot, level, up) {
    if (level <= 0) return up > 0 ? Math.exp(-this.rd * this.tau) : 0;
    if (!Number.isFinite(level)) return up > 0 ? 0 : Math.exp(-this.rd * this.tau);
    if (this.tau === 0) return (up > 0 ? spot > level : spot < level) ? 1 : 0;
    const d2 = this.d1(spot, level) - this.vol * Math.sqrt(this.tau);
    return Math.exp(-this.rd * this.tau) * normal(up * d2);
  }

  /** Pays the price itself at maturity on the same condition. */
  asset(spot, level, up) {
    if (level <= 0) return up > 0 ? spot * Math.exp(-this.rf * this.tau) : 0;
    if (!Number.isFinite(level)) return up > 0 ? 0 : spot * Math.exp(-this.rf * this.tau);
    if (this.tau === 0) return (up > 0 ? spot > level : spot < level) ? spot : 0;
    return Math.exp(-this.rf * this.tau) * spot * normal(up * this.d1(spot, level));
  }

  /** A call or put whose payoff counts only between two levels at maturity. */
  truncated(spot, strike, low, high, pm) {
    if (high <= low) return 0;
    if (pm > 0) {
      const from = Math.max(low, strike);
      if (from >= high) return 0;
      return this.asset(spot, from, 1) - this.asset(spot, high, 1) - strike * (this.cash(spot, from, 1) - this.cash(spot, high, 1));
    }
    const to = Math.min(high, strike);
    if (to <= low) return 0;
    return strike * (this.cash(spot, to, -1) - this.cash(spot, low, -1)) - (this.asset(spot, to, -1) - this.asset(spot, low, -1));
  }

  /** A binary paying cash (or the asset, when `foreign`) if the price ends between two levels. */
  between(spot, low, high, foreign) {
    if (high <= low) return 0;
    const leg = foreign ? (level) => this.asset(spot, level, 1) : (level) => this.cash(spot, level, 1);
    return leg(low) - leg(high);
  }

  /** A payoff that dies when the price touches a barrier at any time: the method of images. */
  knockedOut(spot, low, high, payoff) {
    const a = (2 * (this.rd - this.rf)) / (this.vol * this.vol) - 1;
    if (low > 0 && Number.isFinite(high)) {
      if (spot <= low || spot >= high) return 0;
      const q = high / low;
      let total = payoff(spot) - (low / spot) ** a * payoff((low * low) / spot);
      for (let i = 1; i <= 9; i += 1) {
        let pair = 0;
        for (const n of [i, -i]) {
          const scale = q ** (2 * n);
          pair += q ** (n * a) * (payoff(scale * spot) - (low / spot) ** a * payoff((scale * low * low) / spot));
        }
        total += pair;
        if (Math.abs(pair) <= 1e-12 * Math.abs(total)) break;
      }
      return total;
    }
    const barrier = low > 0 ? low : high;
    if (!Number.isFinite(barrier)) return payoff(spot);
    if (low > 0 ? spot <= barrier : spot >= barrier) return 0;
    return payoff(spot) - (barrier / spot) ** a * payoff((barrier * barrier) / spot);
  }
}

/** The value of a payoff that knocks out or in, watched at the end or all the time. */
function barrierValue(market, low, high, knockIn, continuous, plain, inside) {
  const out = continuous ? market.knockedOut(market.spot, low, high, inside) : inside(market.spot);
  return knockIn ? plain(market.spot) - out : out;
}

function optionValue(market, strike, low, high, rebate, pm, knockIn, continuous) {
  const plain = (spot) => market.truncated(spot, strike, 0, Infinity, pm);
  const inside = (spot) => market.truncated(spot, strike, low, high, pm);
  const value = barrierValue(market, low, high, knockIn, continuous, plain, inside);
  if (!rebate) return value;
  // The rebate is paid when the option does not pay: on a touch for a knock-out, without one for a knock-in.
  return value + rebate * touchValue(market, low, high, false, !knockIn, continuous);
}

function touchValue(market, low, high, foreign, knockIn, continuous) {
  const plain = (spot) => market.between(spot, 0, Infinity, foreign);
  const inside = (spot) => market.between(spot, low, high, foreign);
  return barrierValue(market, low, high, knockIn, continuous, plain, inside);
}

/** A derivative by central differences with a wide step, extrapolated twice, so rounding stays far below the result. */
function derivative(f, x, order, share = 0.02) {
  const h0 = Math.max(1e-3, Math.abs(x)) * share;
  const raw = (h) => (order === 1 ? (f(x + h) - f(x - h)) / (2 * h) : (f(x + h) - 2 * f(x) + f(x - h)) / (h * h));
  const r1 = (h) => (4 * raw(h / 2) - raw(h)) / 3;
  const r2 = (h) => (16 * r1(h / 2) - r1(h)) / 15;
  return (64 * r2(h0 / 2) - r2(h0)) / 63;
}

/** A sensitivity of a value to the market, by its name. */
function sensitivity(value, market, greek) {
  const along = (field, order, share) => derivative((x) => value(market.with({ [field]: x })), market[field], order, share);
  switch (greek) {
    case 'value': return value(market);
    case 'delta': return along('spot', 1);
    case 'gamma': return along('spot', 2);
    case 'theta': return -along('tau', 1);
    case 'vega': return along('vol', 1);
    // The steps for the volatility were chosen where the extrapolation settles, checked against LibreOffice.
    case 'volga': return along('vol', 2, 0.1);
    case 'vanna': return derivative((vol) => sensitivity(value, market.with({ vol }), 'delta'), market.vol, 1, 0.05);
    case 'rho': return along('rd', 1);
    case 'rhof': return along('rf', 1);
    default: return ERROR.value;
  }
}

const GREEKS = {
  value: 'value', v: 'value', delta: 'delta', d: 'delta', gamma: 'gamma', g: 'gamma', theta: 'theta', t: 'theta', vega: 'vega', e: 'vega',
  volga: 'volga', o: 'volga', vanna: 'vanna', a: 'vanna', rho: 'rho', r: 'rho', rhof: 'rhof', f: 'rhof',
};

const word = (arg, choices, fallback) => {
  if (!arg || arg.missing) return fallback;
  const text = String(toText(arg.value)).trim().toLowerCase();
  return choices[text] ?? ERROR.value;
};

function numbers(args, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = toNumber(args[i]?.value);
    if (args[i] === undefined || args[i].missing || isError(n)) return isError(n) ? n : ERROR.value;
    out.push(n);
  }
  return out;
}

const level = (n, upper) => (n > 0 ? n : upper ? Infinity : 0);
const answer = (n) => (isError(n) ? n : Number.isFinite(n) ? n : ERROR.num);

export const PRICING = {
  OPT_BARRIER: (args) => {
    const values = numbers(args, 9);
    if (isError(values)) return values;
    const [spot, vol, rd, rf, tau, strike, low, high, rebate] = values;
    const pm = word(args[9], { c: 1, call: 1, p: -1, put: -1 });
    const knockIn = word(args[10], { i: true, in: true, o: false, out: false });
    const continuous = word(args[11], { c: true, continuous: true, e: false, end: false });
    const greek = word(args[12], GREEKS, 'value');
    for (const v of [pm, knockIn, continuous, greek]) if (isError(v)) return v;
    if (spot <= 0 || vol <= 0 || tau < 0 || strike < 0) return ERROR.num;
    const market = new Market(spot, vol, rd, rf, tau);
    const value = (m) => optionValue(m, strike, level(low, false), level(high, true), rebate, pm, knockIn, continuous);
    return answer(sensitivity(value, market, greek));
  },
  OPT_TOUCH: (args) => {
    const values = numbers(args, 7);
    if (isError(values)) return values;
    const [spot, vol, rd, rf, tau, low, high] = values;
    const foreign = word(args[7], { f: true, foreign: true, d: false, domestic: false });
    const knockIn = word(args[8], { i: true, in: true, o: false, out: false });
    const continuous = word(args[9], { c: true, continuous: true, e: false, end: false });
    const greek = word(args[10], GREEKS, 'value');
    for (const v of [foreign, knockIn, continuous, greek]) if (isError(v)) return v;
    if (spot <= 0 || vol <= 0 || tau < 0) return ERROR.num;
    const market = new Market(spot, vol, rd, rf, tau);
    const value = (m) => touchValue(m, level(low, false), level(high, true), foreign, knockIn, continuous);
    return answer(sensitivity(value, market, greek));
  },
  OPT_PROB_HIT: (args) => {
    const values = numbers(args, 6);
    if (isError(values)) return values;
    const [spot, vol, mu, tau, low, high] = values;
    if (spot <= 0 || vol <= 0 || tau < 0) return ERROR.num;
    const market = new Market(spot, vol, 0, -mu, tau);
    return answer(1 - touchValue(market, level(low, false), level(high, true), false, false, true));
  },
  OPT_PROB_INMONEY: (args) => {
    const values = numbers(args, 6);
    if (isError(values)) return values;
    const [spot, vol, mu, tau, lowArg, highArg] = values;
    if (spot <= 0 || vol <= 0 || tau < 0) return ERROR.num;
    // The strike comes before put or call, as LibreOffice takes them.
    const pm = word(args[7], { c: 1, call: 1, p: -1, put: -1 }, 0);
    if (isError(pm)) return pm;
    const strike = args[6] && !args[6].missing ? toNumber(args[6].value) : -1;
    if (isError(strike)) return strike;
    const market = new Market(spot, vol, 0, -mu, tau);
    let low = level(lowArg, false);
    let high = level(highArg, true);
    if (lowArg > 0 && highArg > 0 && low >= high) return 0;
    if (pm !== 0 && strike >= 0) {
      if (pm > 0) {
        if (Number.isFinite(high) && strike >= high) return 0;
        low = Math.max(low, strike);
      } else {
        if (strike <= low) return 0;
        high = Math.min(high, strike);
      }
    }
    return answer(market.between(spot, low, high, false));
  },
};
