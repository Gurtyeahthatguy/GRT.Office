/** Goal Seek and Solver: the searches themselves, apart from the sheet, so they can be tested alone. */

const EPS = 1e-9;

const numberOrNull = (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null);

/**
 * Finds x with f(x) = target: secant steps, then wider steps for a change of sign, then false position inside it.
 * @param {(x: number) => ?number} f the sheet's answer for a value, null when it gives no number
 * @returns {{found: boolean, x: number, value: ?number}}
 */
export function seekGoal(f, start, target, { limit = 2000 } = {}) {
  const origin = Number.isFinite(start) ? start : 0;
  const tolerance = 1e-10 * Math.max(1, Math.abs(target));
  let calls = 0;
  let best = null;
  let pos = null;
  let neg = null;
  const g = (x) => {
    calls += 1;
    const raw = numberOrNull(f(x));
    if (raw === null) return null;
    const y = raw - target;
    if (!best || Math.abs(y) < Math.abs(best.y)) best = { x, y };
    if (y > 0) pos = { x, y };
    else if (y < 0) neg = { x, y };
    return y;
  };
  const done = () => best && Math.abs(best.y) <= tolerance;
  const result = () => ({ found: !!done(), x: best?.x ?? origin, value: best ? best.y + target : null });

  let x0 = origin;
  let y0 = g(x0);
  const step = Math.max(Math.abs(origin) * 0.01, 0.01);
  let x1 = origin + step;
  let y1 = g(x1);
  for (let i = 0; i < 100 && !done() && !(pos && neg); i += 1) {
    let x2 = y0 !== null && y1 !== null && y1 !== y0 ? x1 - (y1 * (x1 - x0)) / (y1 - y0) : x1 + 2 * (x1 - x0);
    if (!Number.isFinite(x2) || x2 === x1) break;
    let y2 = g(x2);
    // A step into values the sheet cannot take is pulled back toward the last good one.
    for (let back = 0; y2 === null && y1 !== null && back < 60; back += 1) {
      x2 = (x1 + x2) / 2;
      y2 = g(x2);
    }
    [x0, y0, x1, y1] = [x1, y1, x2, y2];
  }
  for (let k = 0; k < 120 && !done() && !(pos && neg) && calls < limit; k += 1) {
    const d = step * 2 ** k;
    if (!Number.isFinite(origin + d)) break;
    g(origin + d);
    if (!(pos && neg)) g(origin - d);
  }
  if (!done() && pos && neg) {
    // Illinois false position: the end that stays put has its value halved, so the interval keeps shrinking.
    let a = { ...neg };
    let b = { ...pos };
    let kept = 0;
    while (calls < limit && !done()) {
      let x = (a.x * b.y - b.x * a.y) / (b.y - a.y);
      if (!(x > Math.min(a.x, b.x) && x < Math.max(a.x, b.x))) x = (a.x + b.x) / 2;
      let y = g(x);
      if (y === null) {
        x = (a.x + b.x) / 2;
        y = g(x);
        if (y === null) break;
      }
      if (y < 0) {
        a = { x, y };
        if (kept === -1) b.y /= 2;
        kept = -1;
      } else if (y > 0) {
        b = { x, y };
        if (kept === 1) a.y /= 2;
        kept = 1;
      } else break;
      if (Math.abs(b.x - a.x) <= 4 * Number.EPSILON * Math.max(1, Math.abs(x))) break;
    }
  }
  if (!done() && !(pos && neg) && best) {
    // No value reaches the target: the closest one, by steps that halve when none helps.
    let h = Math.max(Math.abs(best.x) * 0.01, 0.01);
    while (calls < limit && h > 1e-12 * Math.max(1, Math.abs(best.x))) {
      const was = best.x;
      g(was + h);
      if (best.x === was) g(was - h);
      if (best.x === was) h /= 2;
    }
  }
  return result();
}

/**
 * Maximises c·x for x ≥ 0 under rows of {a, op, b}, op one of <=, >=, =; two phases, Bland's rule.
 * @returns {{status: 'optimal'|'infeasible'|'unbounded'|'limit', x?: number[], value?: number}}
 */
export function simplex(c, rows, { limit = 50_000 } = {}) {
  const n = c.length;
  const m = rows.length;
  const flip = { '<=': '>=', '>=': '<=', '=': '=' };
  const norm = rows.map((r) => (r.b < 0 ? { a: r.a.map((v) => -v), op: flip[r.op], b: -r.b } : r));
  const slacks = norm.filter((r) => r.op !== '=').length;
  const arts = norm.filter((r) => r.op !== '<=').length;
  const width = n + slacks + arts;
  const T = norm.map(() => new Float64Array(width + 1));
  const basis = new Array(m);
  const artificial = new Set();
  let s = n;
  let art = n + slacks;
  norm.forEach((r, i) => {
    for (let j = 0; j < n; j += 1) T[i][j] = r.a[j] ?? 0;
    T[i][width] = r.b;
    if (r.op === '<=') {
      T[i][s] = 1;
      basis[i] = s;
      s += 1;
      return;
    }
    if (r.op === '>=') {
      T[i][s] = -1;
      s += 1;
    }
    T[i][art] = 1;
    basis[i] = art;
    artificial.add(art);
    art += 1;
  });
  const first = new Float64Array(width + 1);
  for (const j of artificial) first[j] = 1;
  for (let i = 0; i < m; i += 1) if (artificial.has(basis[i])) for (let k = 0; k <= width; k += 1) first[k] -= T[i][k];
  const second = new Float64Array(width + 1);
  for (let j = 0; j < n; j += 1) second[j] = -c[j];
  const objectives = [first, second];

  const pivot = (row, col) => {
    const p = T[row][col];
    const pr = T[row];
    for (let k = 0; k <= width; k += 1) pr[k] /= p;
    for (let i = 0; i < m; i += 1) {
      const f = T[i][col];
      if (i === row || f === 0) continue;
      const ti = T[i];
      for (let k = 0; k <= width; k += 1) ti[k] -= f * pr[k];
    }
    for (const o of objectives) {
      const f = o[col];
      if (f !== 0) for (let k = 0; k <= width; k += 1) o[k] -= f * pr[k];
    }
    basis[row] = col;
  };
  let steps = 0;
  const run = (obj, allowed) => {
    for (; steps < limit; steps += 1) {
      let col = -1;
      for (let j = 0; j < width; j += 1) if (allowed(j) && obj[j] < -EPS) { col = j; break; }
      if (col < 0) return 'optimal';
      let row = -1;
      let best = Infinity;
      for (let i = 0; i < m; i += 1) {
        if (T[i][col] <= EPS) continue;
        const ratio = T[i][width] / T[i][col];
        if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && basis[i] < basis[row])) {
          best = ratio;
          row = i;
        }
      }
      if (row < 0) return 'unbounded';
      pivot(row, col);
    }
    return 'limit';
  };

  if (artificial.size) {
    const phase = run(first, () => true);
    if (phase === 'limit') return { status: 'limit' };
    const scale = Math.max(1, ...norm.map((r) => Math.abs(r.b)));
    if (first[width] < -1e-7 * scale) return { status: 'infeasible' };
    // Artificials left in the basis at zero are swapped for a real column where the row has one.
    for (let i = 0; i < m; i += 1) {
      if (!artificial.has(basis[i])) continue;
      for (let j = 0; j < n + slacks; j += 1) if (Math.abs(T[i][j]) > EPS) { pivot(i, j); break; }
    }
  }
  const phase = run(second, (j) => !artificial.has(j));
  if (phase !== 'optimal') return { status: phase };
  const x = new Array(n).fill(0);
  for (let i = 0; i < m; i += 1) if (basis[i] < n) x[basis[i]] = Math.abs(T[i][width]) < EPS ? 0 : T[i][width];
  return { status: 'optimal', x, value: c.reduce((sum, cj, j) => sum + cj * x[j], 0) };
}

/**
 * A linear model over variables that may be free, integer or binary: free ones are split in two, integers branched on.
 * @param {{c: number[], rows: {a: number[], op: string, b: number}[], nonNegative: boolean, integers: Set<number>, binaries: Set<number>}} model
 */
export function solveLinear({ c, rows, nonNegative = false, integers = new Set(), binaries = new Set() }, { nodes = 5000, deadline = Infinity } = {}) {
  const n = c.length;
  const free = nonNegative ? [] : [...Array(n).keys()].filter((j) => !binaries.has(j));
  const widen = (a) => [...a, ...free.map((j) => -(a[j] ?? 0))];
  const unit = (j) => { const a = new Array(n).fill(0); a[j] = 1; return a; };
  const base = rows.map((r) => ({ a: widen(r.a), op: r.op, b: r.b }));
  for (const j of binaries) base.push({ a: widen(unit(j)), op: '<=', b: 1 });
  const wideC = widen(c);
  const back = (x) => x.slice(0, n).map((v, j) => {
    const k = free.indexOf(j);
    return k < 0 ? v : v - x[n + k];
  });
  const whole = new Set([...integers, ...binaries]);

  let best = null;
  let worst = null;
  let explored = 0;
  const stack = [[]];
  while (stack.length) {
    if (explored >= nodes || Date.now() > deadline) return best ? { status: 'limit', ...best } : { status: 'limit' };
    explored += 1;
    const extra = stack.pop();
    const lp = simplex(wideC, [...base, ...extra]);
    if (lp.status === 'unbounded') return { status: 'unbounded' };
    if (lp.status !== 'optimal') { worst ??= lp.status; continue; }
    if (best && lp.value <= best.value + EPS * Math.max(1, Math.abs(best.value))) continue;
    const x = back(lp.x);
    const j = [...whole].find((k) => Math.abs(x[k] - Math.round(x[k])) > 1e-6);
    if (j === undefined) {
      for (const k of whole) x[k] = Math.round(x[k]);
      best = { x, value: lp.value };
      continue;
    }
    const a = widen(unit(j));
    stack.push([...extra, { a, op: '<=', b: Math.floor(x[j]) }], [...extra, { a, op: '>=', b: Math.ceil(x[j]) }]);
  }
  return best ? { status: 'optimal', ...best } : { status: worst === 'limit' ? 'limit' : 'infeasible' };
}

/** A small seeded generator, so the same model gives the same answer each time. */
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Differential evolution with feasibility first, then a pattern search around the best: for models that are not linear.
 * @param {{start: number[], measure: (x: number[]) => ?{score: number, violation: number}, round: (x: number[]) => number[]}} problem
 *   score is to be made as small as it goes; violation is how far the constraints are broken, 0 when kept
 */
export function evolve({ start, measure, round = (x) => x }, { evaluations = 20000, deadline = Infinity, seed = 1 } = {}) {
  const n = start.length;
  const random = seeded(seed);
  let used = 0;
  const judge = (x) => {
    used += 1;
    const fixed = round(x);
    const m = measure(fixed);
    return m && Number.isFinite(m.score) ? { x: fixed, score: m.score, violation: m.violation } : { x: fixed, score: Infinity, violation: Infinity };
  };
  // Feasible beats unfeasible; then the smaller break, then the smaller score.
  const better = (p, q) => {
    if (p.violation <= EPS && q.violation <= EPS) return p.score < q.score;
    if (p.violation <= EPS || q.violation <= EPS) return p.violation <= EPS;
    return p.violation < q.violation;
  };
  const out = () => Date.now() > deadline || used >= evaluations;

  const size = Math.min(60, Math.max(20, 10 * n));
  const spread = start.map((v) => Math.max(10, 10 * Math.abs(v)));
  let population = [judge(start)];
  while (population.length < size) population.push(judge(start.map((v, j) => v + (random() * 2 - 1) * spread[j])));
  let best = population.reduce((p, q) => (better(q, p) ? q : p));
  let quiet = 0;
  while (!out() && quiet < 200) {
    let improved = false;
    population = population.map((member, i) => {
      if (out()) return member;
      let a; let b; let c;
      do a = Math.floor(random() * size); while (a === i);
      do b = Math.floor(random() * size); while (b === i || b === a);
      do c = Math.floor(random() * size); while (c === i || c === a || c === b);
      const F = 0.5 + random() * 0.4;
      const forced = Math.floor(random() * n);
      const trial = member.x.map((v, j) => (j === forced || random() < 0.9 ? population[a].x[j] + F * (population[b].x[j] - population[c].x[j]) : v));
      const judged = judge(trial);
      if (!better(judged, member)) return member;
      if (better(judged, best)) {
        if (Math.abs(judged.score - best.score) > 1e-12 * Math.max(1, Math.abs(best.score)) || judged.violation < best.violation) improved = true;
        best = judged;
      }
      return judged;
    });
    quiet = improved ? 0 : quiet + 1;
  }
  // Pattern search: steps along each variable, halved when none helps.
  let step = Math.max(1e-3, ...best.x.map((v) => Math.abs(v) * 0.01));
  while (!out() && step > 1e-12 * Math.max(1, ...best.x.map(Math.abs))) {
    let moved = false;
    for (let j = 0; j < n && !out(); j += 1) {
      for (const sign of [1, -1]) {
        const trial = best.x.slice();
        trial[j] += sign * step;
        const judged = judge(trial);
        if (better(judged, best)) { best = judged; moved = true; break; }
      }
    }
    if (!moved) step /= 2;
  }
  return { ...best, feasible: best.violation <= EPS, evaluations: used };
}

/** How far a value breaks a constraint, relative to its size; 0 when kept. */
export function breach(value, op, rhs) {
  if (value === null) return Infinity;
  const slack = 1e-9 * Math.max(1, Math.abs(rhs));
  if (op === '<=') return Math.max(0, value - rhs - slack);
  if (op === '>=') return Math.max(0, rhs - value - slack);
  if (op === '=') return Math.max(0, Math.abs(value - rhs) - slack);
  return 0;
}

/**
 * Solves a model the sheet answers: the linear method when the model proves linear and the engine allows, else evolution.
 * @param {{start: number[], evaluate: (x: number[]) => ?{objective: ?number, lhs: (?number)[]},
 *   constraints: {index: number, op: string, rhs: number}[], goal: 'max'|'min'|'value', target?: number,
 *   integers: Set<number>, binaries: Set<number>, nonNegative: boolean, engine: 'auto'|'linear'|'nonlinear', seconds: number}} model
 * @returns {{status: string, x?: number[], objective?: number, method: string}}
 */
export function solveModel(model) {
  const { start, evaluate, constraints, goal, target = 0, integers, binaries, nonNegative, engine = 'auto', seconds = 10 } = model;
  const deadline = Date.now() + Math.max(1, Math.min(3600, seconds)) * 1000;
  const n = start.length;
  const linear = engine === 'nonlinear' ? null : linearise(evaluate, start, constraints.length);
  if (engine === 'linear' && !linear) return { status: 'not-linear', method: 'linear' };
  if (linear) {
    const rows = constraints.filter((k) => ['<=', '>=', '='].includes(k.op))
      .map((k) => ({ a: linear.rows[k.index].a, op: k.op, b: k.rhs - linear.rows[k.index].b }));
    let c = linear.objective.a;
    if (goal === 'min') c = c.map((v) => -v);
    if (goal === 'value') {
      rows.push({ a: linear.objective.a, op: '=', b: target - linear.objective.b });
      c = new Array(n).fill(0);
    }
    const lp = solveLinear({ c, rows, nonNegative, integers, binaries }, { deadline });
    if (!lp.x) return { status: lp.status, method: 'linear' };
    const at = evaluate(lp.x);
    return { status: lp.status, x: lp.x, objective: at?.objective ?? null, method: 'linear' };
  }
  const score = (objective) => (goal === 'max' ? -objective : goal === 'min' ? objective : Math.abs(objective - target));
  const result = evolve({
    start: start.map((v, j) => (binaries.has(j) ? Math.round(Math.min(1, Math.max(0, v))) : v)),
    round: (x) => x.map((v, j) => {
      let next = nonNegative ? Math.max(0, v) : v;
      if (binaries.has(j)) next = Math.min(1, Math.max(0, Math.round(next)));
      else if (integers.has(j)) next = Math.round(next);
      return next;
    }),
    measure: (x) => {
      const at = evaluate(x);
      if (!at || at.objective === null) return null;
      const violation = constraints.reduce((sum, k) => sum + breach(at.lhs[k.index], k.op, k.rhs), 0);
      return { score: score(at.objective), violation };
    },
  }, { deadline });
  if (!result.feasible) return { status: 'infeasible', method: 'nonlinear' };
  if (goal === 'value' && Math.abs(score(evaluate(result.x)?.objective ?? Infinity)) > 1e-7 * Math.max(1, Math.abs(target))) {
    return { status: 'not-reached', x: result.x, objective: evaluate(result.x)?.objective ?? null, method: 'nonlinear' };
  }
  const at = evaluate(result.x);
  return { status: 'optimal', x: result.x, objective: at?.objective ?? null, method: 'nonlinear' };
}

/**
 * The model's coefficients when it is linear: one step along each variable from where it stands,
 * then two other points that must agree with them. Null when it is not linear.
 */
export function linearise(evaluate, start, count) {
  const n = start.length;
  const at = evaluate(start);
  if (!at || at.objective === null || at.lhs.some((v) => v === null)) return null;
  const values = (point) => [point.objective, ...point.lhs];
  const zero = values(at);
  const columns = [];
  for (let j = 0; j < n; j += 1) {
    const x = start.slice();
    x[j] += 1;
    const step = evaluate(x);
    if (!step || step.objective === null || step.lhs.some((v) => v === null)) return null;
    columns.push(values(step).map((v, k) => v - zero[k]));
  }
  const predict = (x) => zero.map((z, k) => z + columns.reduce((sum, col, j) => sum + col[k] * (x[j] - start[j]), 0));
  const random = seeded(7);
  for (let probe = 0; probe < 2; probe += 1) {
    const x = start.map((v) => v + (random() * 2 - 1) * Math.max(10, Math.abs(v)));
    const point = evaluate(x);
    if (!point || point.objective === null || point.lhs.some((v) => v === null)) return null;
    const expected = predict(x);
    const actual = values(point);
    if (actual.some((v, k) => Math.abs(v - expected[k]) > 1e-7 * Math.max(1, Math.abs(v), Math.abs(expected[k])))) return null;
  }
  // Each row as a·x + b, with b what the row gives at x = 0.
  const row = (k) => {
    const a = columns.map((col) => col[k]);
    return { a, b: zero[k] - a.reduce((sum, v, j) => sum + v * start[j], 0) };
  };
  return { objective: row(0), rows: Array.from({ length: count }, (_, k) => row(k + 1)) };
}
