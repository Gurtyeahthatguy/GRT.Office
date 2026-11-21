/** ODF enhanced geometry: the formulas, paths, handles, text areas and glue points of a custom shape, worked out for a size. */

import { PRESETS } from './presets.js';

// Formulas

const FUNCTIONS = {
  abs: (a) => Math.abs(a),
  sqrt: (a) => Math.sqrt(Math.max(0, a)),
  sin: (a) => Math.sin(a),
  cos: (a) => Math.cos(a),
  tan: (a) => Math.tan(a),
  atan: (a) => Math.atan(a),
  atan2: (a, b) => Math.atan2(a, b),
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  if: (a, b, c) => (a > 0 ? b : c),
};

/** Splits a formula into numbers, references, names and signs. */
function tokens(text) {
  const out = [];
  const re = /\s*(\?f\d+|\$\d+|\d*\.\d+(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?|[a-z]\w*|[-+*/(),])/gy;
  let m;
  let at = 0;
  while (at < text.length && (m = re.exec(text))) {
    out.push(m[1]);
    at = re.lastIndex;
  }
  if (text.slice(at).trim() !== '') throw new Error(`Not a formula: ${text}`);
  return out;
}

/** A formula that cannot be read counts as 0, as LibreOffice takes it, so one bad formula in a file does not lose the shape. */
function compileOrZero(text) {
  try {
    return compileFormula(text);
  } catch {
    return () => 0;
  }
}

/** A formula as a function of a context, parsed without eval; anything it does not know is refused. */
export function compileFormula(text) {
  const list = tokens(String(text));
  let i = 0;
  const peek = () => list[i];
  const take = (want) => {
    if (want !== undefined && list[i] !== want) throw new Error(`Expected ${want} in ${text}`);
    return list[i++];
  };
  function primary() {
    const t = take();
    if (t === undefined) throw new Error(`Formula ends early: ${text}`);
    if (t === '(') { const e = sum(); take(')'); return e; }
    if (t === '-') { const e = primary(); return (c) => -e(c); }
    if (t === '+') return primary();
    if (t[0] === '?') { const n = Number(t.slice(2)); return (c) => c.f(n); }
    if (t[0] === '$') { const n = Number(t.slice(1)); return (c) => c.m(n); }
    if (/^[\d.]/.test(t)) { const v = Number(t); return () => v; }
    if (peek() === '(' && FUNCTIONS[t]) {
      take('(');
      const args = [sum()];
      while (peek() === ',') { take(','); args.push(sum()); }
      take(')');
      const fn = FUNCTIONS[t];
      return (c) => fn(...args.map((a) => a(c)));
    }
    if (t === 'pi') return () => Math.PI;
    return (c) => c.k(t);
  }
  function product() {
    let left = primary();
    while (peek() === '*' || peek() === '/') {
      const op = take();
      const l = left;
      const r = primary();
      left = op === '*' ? (c) => l(c) * r(c) : (c) => { const d = r(c); return d === 0 ? 0 : l(c) / d; };
    }
    return left;
  }
  function sum() {
    let left = product();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      const l = left;
      const r = product();
      left = op === '+' ? (c) => l(c) + r(c) : (c) => l(c) - r(c);
    }
    return left;
  }
  const result = sum();
  if (i < list.length) throw new Error(`Formula has more after its end: ${text}`);
  return result;
}

// Paths

const PARAMETERS = { M: 2, L: 2, C: 6, Q: 4, A: 8, B: 8, W: 8, V: 8, T: 6, U: 6, X: 2, Y: 2, G: 4 };

/** The commands of an enhanced path, each with its parameters compiled. */
function compilePath(text) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  const out = [];
  let command = null;
  let values = [];
  const flush = () => { if (command) out.push({ command, values }); };
  for (const part of parts) {
    if (/^[A-Z]$/.test(part)) {
      flush();
      command = part;
      values = [];
    } else if (command) {
      values.push(compileOrZero(part));
    }
  }
  flush();
  return out;
}

const compiled = new Map();

/** Older names GRT's programs used for shapes, as LibreOffice's. */
const ALIASES = { rect: 'rectangle', rounded: 'round-rectangle', triangle: 'isosceles-triangle' };

/** A preset by its ODF type: LibreOffice's own, or an OOXML preset as ooxml-NAME. */
export function presetDefinition(name) {
  if (typeof name !== 'string') return null;
  const type = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
  if (Object.hasOwn(PRESETS.own, type)) {
    const own = PRESETS.own[type];
    return own.as ? PRESETS.own[own.as] : own;
  }
  const ooxml = type.startsWith('ooxml-') ? type.slice(6) : null;
  return ooxml && Object.hasOwn(PRESETS.ooxml, ooxml) ? PRESETS.ooxml[ooxml] : null;
}

/** Compiles a geometry definition once: {box, path, eq, mod, handles, text, glue, stretch, sub}. */
export function compileGeometry(definition) {
  if (compiled.has(definition)) return compiled.get(definition);
  const pairs = (text) => {
    if (!text) return [];
    const list = String(text).trim().split(/\s+/).map(compileOrZero);
    const out = [];
    for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]);
    return out;
  };
  const geometry = {
    box: definition.box ?? null,
    sub: definition.sub ?? null,
    stretch: definition.stretch ?? null,
    mirror: definition.mirror ?? null,
    path: compilePath(definition.path ?? ''),
    eq: (definition.eq ?? []).map(compileOrZero),
    mod: definition.mod ?? [],
    text: pairs(definition.text),
    glue: pairs(definition.glue),
    handles: (definition.handles ?? []).map((h) => ({
      position: pairs(h.position)[0] ?? null,
      polar: h.polar ? pairs(h.polar)[0] : null,
      switched: h.switched === 'true',
      range: {
        xmin: h['range-x-minimum'] !== undefined ? compileOrZero(h['range-x-minimum']) : null,
        xmax: h['range-x-maximum'] !== undefined ? compileOrZero(h['range-x-maximum']) : null,
        ymin: h['range-y-minimum'] !== undefined ? compileOrZero(h['range-y-minimum']) : null,
        ymax: h['range-y-maximum'] !== undefined ? compileOrZero(h['range-y-maximum']) : null,
        rmin: h['radius-range-minimum'] !== undefined ? compileOrZero(h['radius-range-minimum']) : null,
        rmax: h['radius-range-maximum'] !== undefined ? compileOrZero(h['radius-range-maximum']) : null,
      },
      raw: h,
    })),
  };
  compiled.set(definition, geometry);
  return geometry;
}

/** The values the formulas see, for a shape of this size with these modifiers. */
function context(geometry, w, h, modifiers) {
  const box = geometry.box ?? [0, 0, w, h];
  const values = new Array(geometry.eq.length);
  const busy = new Uint8Array(geometry.eq.length);
  const mods = geometry.mod.map((d, i) => (Number.isFinite(modifiers?.[i]) ? modifiers[i] : d));
  const constants = {
    left: box[0], top: box[1], right: box[0] + box[2], bottom: box[1] + box[3],
    width: box[2], height: box[3], logwidth: w, logheight: h,
    xstretch: geometry.stretch?.[0] ?? 0, ystretch: geometry.stretch?.[1] ?? 0,
    hasstroke: 1, hasfill: 1,
  };
  const c = {
    m: (n) => mods[n] ?? 0,
    k: (name) => constants[name] ?? 0,
    f: (n) => {
      if (n < 0 || n >= values.length) return 0;
      if (values[n] !== undefined) return values[n];
      // A formula that refers back to itself gives nothing rather than looping.
      if (busy[n]) return 0;
      busy[n] = 1;
      const v = geometry.eq[n](c);
      values[n] = Number.isFinite(v) ? v : 0;
      return values[n];
    },
  };
  return { c, mods, box };
}

/** Maps a point of the shape's own coordinates to the size it is drawn at, keeping stretch points as LibreOffice does. */
function mapper(geometry, w, h, box, subSize = null) {
  if (!geometry.box) {
    const sx = subSize?.[0] ? w / subSize[0] : 1;
    const sy = subSize?.[1] ? h / subSize[1] : 1;
    return (x, y) => ({ x: x * sx, y: y * sy });
  }
  let sx = box[2] ? w / box[2] : 0;
  let sy = box[3] ? h / box[3] : 0;
  const [stretchX, stretchY] = geometry.stretch ?? [null, null];
  let extraX = 0;
  let extraY = 0;
  if (stretchX !== null && sx > sy) { extraX = w - box[2] * sy; sx = sy; }
  if (stretchY !== null && sy > sx) { extraY = h - box[3] * sx; sy = sx; }
  return (x, y) => ({
    x: (x - box[0]) * sx + (stretchX !== null && x > stretchX ? extraX : 0),
    y: (y - box[1]) * sy + (stretchY !== null && y > stretchY ? extraY : 0),
  });
}

// Arcs as cubic curves, each no more than a quarter turn, so every output speaks only M, L, C and Z.

function arcCurves(cx, cy, rx, ry, from, to) {
  const out = [];
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2) - 1e-9));
  const step = (to - from) / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < steps; i += 1) {
    const a = from + step * i;
    const b = a + step;
    const p0 = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
    const p3 = { x: cx + rx * Math.cos(b), y: cy + ry * Math.sin(b) };
    out.push({
      c1: { x: p0.x - k * rx * Math.sin(a), y: p0.y + k * ry * Math.cos(a) },
      c2: { x: p3.x + k * rx * Math.sin(b), y: p3.y - k * ry * Math.cos(b) },
      to: p3,
      from: p0,
    });
  }
  return out;
}

/**
 * Works out a custom shape at a size.
 * @param {Object} definition a geometry definition, as presets.js holds or as read from a file
 * @param {number} w @param {number} h
 * @param {number[]} [modifiers] the shape's own values for $0, $1...
 * @returns {{paths: {segments: Object[], fill: boolean, stroke: boolean, shade: ?string}[], text: Object, glue: Object[], handles: Object[]}}
 */
export function shapeGeometry(definition, w, h, modifiers = null) {
  const geometry = compileGeometry(definition);
  const { c, mods, box } = context(geometry, Math.max(w, 1e-6), Math.max(h, 1e-6), modifiers);
  const paths = [];
  let current = null;
  let subIndex = 0;
  let map = mapper(geometry, w, h, box, geometry.sub ? [geometry.sub[0], geometry.sub[1]] : null);
  let pen = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  const begin = () => {
    if (!current) {
      current = { segments: [], fill: true, stroke: true, shade: null };
      paths.push(current);
    }
    return current;
  };
  const point = (x, y) => map(x(c), y(c));
  const move = (p) => { begin().segments.push({ type: 'M', to: p }); pen = p; start = p; };
  const line = (p) => {
    const path = begin();
    if (path.segments.length === 0) { move(p); return; }
    path.segments.push({ type: 'L', to: p });
    pen = p;
  };
  const curves = (list, implicitMove) => {
    if (list.length === 0) return;
    if (implicitMove) move(list[0].from); else line(list[0].from);
    for (const piece of list) begin().segments.push({ type: 'C', c1: piece.c1, c2: piece.c2, to: piece.to });
    pen = list[list.length - 1].to;
  };
  /** An arc on the ellipse in a rectangle, between the rays to two points, turning as asked. */
  const arcBetween = (p1, p2, p3, p4, clockwise, implicitMove) => {
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    const rx = Math.abs(p2.x - p1.x) / 2;
    const ry = Math.abs(p2.y - p1.y) / 2;
    if (rx < 1e-9 || ry < 1e-9) { if (implicitMove) move(p4); else line(p4); return; }
    const angle = (p) => Math.atan2((p.y - cy) / ry, (p.x - cx) / rx);
    let a = angle(p3);
    let b = angle(p4);
    if (clockwise) { while (b <= a) b += Math.PI * 2; } else { while (b >= a) b -= Math.PI * 2; }
    curves(arcCurves(cx, cy, rx, ry, a, b), implicitMove);
  };

  for (const { command, values } of geometry.path) {
    const n = PARAMETERS[command] ?? 0;
    const groups = [];
    if (n) for (let i = 0; i + n <= values.length; i += n) groups.push(values.slice(i, i + n));
    switch (command) {
      case 'M':
        groups.forEach((g, i) => (i === 0 ? move(point(g[0], g[1])) : line(point(g[0], g[1]))));
        break;
      case 'L':
        for (const g of groups) line(point(g[0], g[1]));
        break;
      case 'C':
        for (const g of groups) {
          if (begin().segments.length === 0) move(pen);
          const to = point(g[4], g[5]);
          current.segments.push({ type: 'C', c1: point(g[0], g[1]), c2: point(g[2], g[3]), to });
          pen = to;
        }
        break;
      case 'Q':
        for (const g of groups) {
          if (begin().segments.length === 0) move(pen);
          const q = point(g[0], g[1]);
          const to = point(g[2], g[3]);
          current.segments.push({
            type: 'C',
            c1: { x: pen.x + (2 / 3) * (q.x - pen.x), y: pen.y + (2 / 3) * (q.y - pen.y) },
            c2: { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
            to,
          });
          pen = to;
        }
        break;
      case 'A': case 'B': case 'W': case 'V':
        for (const g of groups) {
          arcBetween(point(g[0], g[1]), point(g[2], g[3]), point(g[4], g[5]), point(g[6], g[7]),
            command === 'W' || command === 'V', command === 'B' || command === 'V');
        }
        break;
      case 'T': case 'U':
        for (const g of groups) {
          const centre = point(g[0], g[1]);
          const corner = map(g[0](c) + g[2](c), g[1](c) + g[3](c));
          const rx = Math.abs(corner.x - centre.x);
          const ry = Math.abs(corner.y - centre.y);
          // Angles in degrees, counter-clockwise as on paper, which with y pointing down is the negative turn.
          const t0 = g[4](c);
          let t1 = g[5](c);
          if (t1 <= t0) t1 += 360;
          const from = -t0 * Math.PI / 180;
          const to = -t1 * Math.PI / 180;
          curves(arcCurves(centre.x, centre.y, rx, ry, from, to), command === 'U');
        }
        break;
      case 'X': case 'Y':
        groups.forEach((g, i) => {
          const end = point(g[0], g[1]);
          if (begin().segments.length === 0) move(pen);
          // The first quadrant starts along its letter's axis; the next ones alternate.
          const horizontal = (command === 'X') === (i % 2 === 0);
          const centre = horizontal ? { x: pen.x, y: end.y } : { x: end.x, y: pen.y };
          const rx = Math.abs(end.x - pen.x);
          const ry = Math.abs(end.y - pen.y);
          if (rx < 1e-9 || ry < 1e-9) { line(end); return; }
          const a = Math.atan2((pen.y - centre.y) / ry, (pen.x - centre.x) / rx);
          let b = Math.atan2((end.y - centre.y) / ry, (end.x - centre.x) / rx);
          while (b - a > Math.PI) b -= Math.PI * 2;
          while (a - b > Math.PI) b += Math.PI * 2;
          for (const piece of arcCurves(centre.x, centre.y, rx, ry, a, b)) current.segments.push({ type: 'C', c1: piece.c1, c2: piece.c2, to: piece.to });
          pen = end;
        });
        break;
      case 'G':
        for (const g of groups) {
          if (begin().segments.length === 0) move(pen);
          const base = map(0, 0);
          const radius = map(g[0](c), g[1](c));
          const rx = Math.abs(radius.x - base.x);
          const ry = Math.abs(radius.y - base.y);
          const visual = (deg) => {
            const t = deg * Math.PI / 180;
            return Math.atan2(rx * Math.sin(t), ry * Math.cos(t));
          };
          const st = g[2](c);
          const sw = g[3](c);
          const a = visual(st);
          let b = visual(st + sw);
          // The parameter turns the same way as the visual angle, by as many whole turns.
          const turns = Math.floor(Math.abs(sw) / 360);
          if (sw >= 0) { while (b < a) b += Math.PI * 2; b += turns * Math.PI * 2; } else { while (b > a) b -= Math.PI * 2; b -= turns * Math.PI * 2; }
          if (rx < 1e-9 || ry < 1e-9 || Math.abs(sw) < 1e-9) continue;
          const cx = pen.x - rx * Math.cos(a);
          const cy = pen.y - ry * Math.sin(a);
          for (const piece of arcCurves(cx, cy, rx, ry, a, b)) current.segments.push({ type: 'C', c1: piece.c1, c2: piece.c2, to: piece.to });
          pen = current.segments[current.segments.length - 1].to;
        }
        break;
      case 'Z':
        if (current?.segments.length) { current.segments.push({ type: 'Z' }); pen = start; }
        break;
      case 'N':
        current = null;
        subIndex += 1;
        if (geometry.sub) map = mapper(geometry, w, h, box, [geometry.sub[subIndex * 2] ?? 0, geometry.sub[subIndex * 2 + 1] ?? 0]);
        break;
      case 'F': begin().fill = false; break;
      case 'S': begin().stroke = false; break;
      case 'H': begin().shade = 'darken'; break;
      case 'I': begin().shade = 'darkenless'; break;
      case 'J': begin().shade = 'lighten'; break;
      case 'K': begin().shade = 'lightenless'; break;
      default: break;
    }
  }

  const whole = mapper(geometry, w, h, box, null);
  const area = geometry.text[0] && geometry.text[1]
    ? (() => {
      const a = whole(geometry.text[0][0](c), geometry.text[0][1](c));
      const b = whole(geometry.text[1][0](c), geometry.text[1][1](c));
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    })()
    : { x: 0, y: 0, w, h };
  const glue = geometry.glue.map(([x, y]) => whole(x(c), y(c)));
  const handles = geometry.handles.map((handle, index) => {
    if (!handle.position) return null;
    let x = handle.position[0](c);
    let y = handle.position[1](c);
    if (handle.polar) {
      // A polar handle gives an angle in degrees and a radius around its pole.
      const pole = { x: handle.polar[0](c), y: handle.polar[1](c) };
      const angle = x * Math.PI / 180;
      x = pole.x + y * Math.cos(angle);
      y = pole.y + y * Math.sin(angle);
    }
    if (handle.switched && h > w) [x, y] = [y, x];
    return { index, ...whole(x, y) };
  }).filter(Boolean);
  const kept = paths.filter((p) => p.segments.length > 0);
  if (geometry.mirror?.[0] || geometry.mirror?.[1]) {
    // A shape mirrored in its definition, as some of LibreOffice's menu shapes are, is turned over in its box.
    const [mx, my] = geometry.mirror;
    const turn = (p) => (p ? { ...p, x: mx ? w - p.x : p.x, y: my ? h - p.y : p.y } : p);
    for (const path of kept) for (const seg of path.segments) for (const k of ['to', 'c1', 'c2']) if (seg[k]) seg[k] = turn(seg[k]);
    const a = turn({ x: area.x, y: area.y });
    const b = turn({ x: area.x + area.w, y: area.y + area.h });
    return {
      paths: kept, text: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: area.w, h: area.h },
      glue: glue.map(turn), handles: handles.map(turn), modifiers: mods,
    };
  }
  return { paths: kept, text: area, glue, handles, modifiers: mods };
}

/** Moves a handle to a point of the shape, giving the modifiers that put it there, within its ranges. */
export function dragHandle(definition, w, h, modifiers, index, at) {
  const geometry = compileGeometry(definition);
  const handle = geometry.handles[index];
  const { c, mods, box } = context(geometry, w, h, modifiers);
  if (!handle?.position) return mods;
  // From the drawn size back to the shape's own coordinates, stretch points aside.
  const sx = geometry.box ? (box[2] ? box[2] / w : 1) : 1;
  const sy = geometry.box ? (box[3] ? box[3] / h : 1) : 1;
  const mx = geometry.mirror?.[0] ? w - at.x : at.x;
  const my = geometry.mirror?.[1] ? h - at.y : at.y;
  let x = (geometry.box ? box[0] : 0) + mx * sx;
  let y = (geometry.box ? box[1] : 0) + my * sy;
  if (handle.switched && h > w) [x, y] = [y, x];
  const out = [...mods];
  const clamp = (v, lo, hi) => Math.min(hi === null ? Infinity : hi(c), Math.max(lo === null ? -Infinity : lo(c), v));
  const raw = handle.raw.position.trim().split(/\s+/);
  const setFrom = (expr, value) => {
    const m = /^\$(\d+)$/.exec(expr);
    if (m) out[Number(m[1])] = value;
  };
  if (handle.polar) {
    const pole = { x: handle.polar[0](c), y: handle.polar[1](c) };
    const angle = Math.atan2(y - pole.y, x - pole.x) * 180 / Math.PI;
    const radius = clamp(Math.hypot(x - pole.x, y - pole.y), handle.range.rmin, handle.range.rmax);
    setFrom(raw[0], angle);
    setFrom(raw[1], radius);
  } else {
    setFrom(raw[0], clamp(x, handle.range.xmin, handle.range.xmax));
    setFrom(raw[1], clamp(y, handle.range.ymin, handle.range.ymax));
  }
  return out;
}

const fmt = (v) => String(Math.round(v * 100) / 100);

/** SVG path data for a list of segments. */
export function pathData(segments) {
  return segments.map((s) => {
    if (s.type === 'M' || s.type === 'L') return `${s.type}${fmt(s.to.x)} ${fmt(s.to.y)}`;
    if (s.type === 'C') return `C${fmt(s.c1.x)} ${fmt(s.c1.y)} ${fmt(s.c2.x)} ${fmt(s.c2.y)} ${fmt(s.to.x)} ${fmt(s.to.y)}`;
    return 'Z';
  }).join('');
}

/** The menus of Insert, Shape: group name to the shapes in LibreOffice's order. */
export const SHAPE_MENUS = PRESETS.menus;

/** The name LibreOffice shows for one of its shapes. */
export const shapeLabel = (type) => PRESETS.labels[type] ?? type;

/** The OOXML preset LibreOffice writes for one of its shapes, if there is one. */
export const ooxmlPreset = (name) => {
  const type = Object.hasOwn(ALIASES, name ?? '') ? ALIASES[name] : name;
  return type?.startsWith('ooxml-') ? type.slice(6) : PRESETS.toOoxml[type] ?? null;
};

/** PowerPoint presets with a shape of LibreOffice's own. */
const OWN_FOR = Object.entries(PRESETS.toOoxml).reduce((out, [own, prst]) => { if (!out[prst] && !PRESETS.own[own]?.as) out[prst] = own; return out; }, {});

/** LibreOffice's own shape for a PowerPoint preset left at its defaults, so it reads as Diamond and not ooxml-diamond. */
export function ownForOoxml(prst, mods = null) {
  const own = OWN_FOR[prst];
  if (!own) return null;
  const defaults = PRESETS.ooxml[prst]?.mod ?? [];
  return !mods || mods.every((v, i) => v === defaults[i]) ? own : null;
}

/** Whether a shape of LibreOffice's menus is inserted square, as Square and Circle are. */
export const insertedSquare = (type) => Boolean(PRESETS.own[type]?.square);

/** The draw:type a shape is written with in ODF: its alias, or the internal type LibreOffice gives it. */
export const odfType = (name) => {
  const type = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
  return PRESETS.own[type]?.as ?? PRESETS.own[type]?.odf ?? type;
};

/** Every shape type GRT can draw. */
export const SHAPE_TYPES = [...Object.keys(PRESETS.own), ...Object.keys(PRESETS.ooxml).map((k) => `ooxml-${k}`)];
