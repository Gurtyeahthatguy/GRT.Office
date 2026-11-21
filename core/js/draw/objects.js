/** Drawing objects shared by Paper, Grid, Slides and Graphs: what they hold, and what Format and Shape do to them. */

import { presetDefinition, shapeGeometry } from './geometry.js';
import { least, greatest } from '../extent.js';

/** The kinds the drawing layer knows itself; a program may add its own, which it draws. */
export const DRAW_KINDS = ['shape', 'path', 'line', 'connector', 'image', 'group', 'scene3d'];

/** LibreOffice's line ends. */
export const ARROWS = ['none', 'arrow', 'arrow-short', 'triangle', 'concave', 'circle', 'square', 'diamond', 'dimension', 'line'];

/** Line styles. */
export const DASHES = ['solid', 'dash', 'dot', 'dash-dot', 'long-dash', 'none'];

/** Fills. */
export const FILLS = ['none', 'solid', 'gradient', 'hatch'];

const finite = (v, d) => (Number.isFinite(v) ? v : d);
const colour = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const clampTo = (v, lo, hi, d) => Math.min(hi, Math.max(lo, finite(v, d)));

/** The look of a line, cleaned. */
export function cleanLine(line = {}) {
  return {
    style: DASHES.includes(line.style) ? line.style : 'solid',
    color: colour(line.color, '#3465a4'),
    width: clampTo(line.width, 0, 200, 2),
    start: ARROWS.includes(line.start) ? line.start : 'none',
    end: ARROWS.includes(line.end) ? line.end : 'none',
    ...(Number.isFinite(line.transparency) ? { transparency: clampTo(line.transparency, 0, 100, 0) } : {}),
  };
}

/** The look of a fill, cleaned. */
export function cleanFill(fill = {}) {
  const type = FILLS.includes(fill.type) ? fill.type : 'solid';
  return {
    type,
    color: colour(fill.color, '#729fcf'),
    ...(type === 'gradient' ? { color2: colour(fill.color2, '#ffffff'), angle: clampTo(fill.angle, -360, 360, 0), shape: ['linear', 'radial'].includes(fill.shape) ? fill.shape : 'linear' } : {}),
    ...(type === 'hatch' ? { angle: clampTo(fill.angle, -360, 360, 45), spacing: clampTo(fill.spacing, 2, 200, 8) } : {}),
    ...(Number.isFinite(fill.transparency) ? { transparency: clampTo(fill.transparency, 0, 100, 0) } : {}),
  };
}

/** A path's subpaths, cleaned: nodes with optional control points, in the object's own box. */
export function cleanSubpaths(subpaths) {
  if (!Array.isArray(subpaths)) return [];
  const point = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null);
  return subpaths.slice(0, 1000).map((s) => ({
    closed: Boolean(s?.closed),
    nodes: (Array.isArray(s?.nodes) ? s.nodes : []).slice(0, 100000).map((n) => {
      const at = point(n);
      if (!at) return null;
      const before = point(n.in);
      const after = point(n.out);
      return { ...at, ...(before ? { in: before } : {}), ...(after ? { out: after } : {}) };
    }).filter(Boolean),
  })).filter((s) => s.nodes.length > 0);
}

/** The drawing fields of an object, cleaned; a program keeps its own fields beside them. */
export function cleanDrawing(object) {
  const out = {};
  // A place and size from a file are numbers, so nothing else reaches a drawing's markup through them.
  for (const key of ['x', 'y', 'w', 'h', 'rotation', 'z']) if (key in object) out[key] = finite(object[key] === null || object[key] === '' ? NaN : Number(object[key]), key === 'w' || key === 'h' ? 100 : 0);
  if (object.flipH) out.flipH = true;
  if (object.flipV) out.flipV = true;
  if (typeof object.name === 'string' && object.name.trim()) out.name = object.name.slice(0, 200);
  if (typeof object.description === 'string' && object.description.trim()) out.description = object.description.slice(0, 5000);
  if (typeof object.title === 'string' && object.title.trim()) out.title = object.title.slice(0, 200);
  if (object.line) out.line = cleanLine(object.line);
  if (object.fillLook) out.fillLook = cleanFill(object.fillLook);
  if (object.shadow) out.shadow = true;
  if (object.textPath) out.textPath = true;
  if (object.protect) out.protect = { position: Boolean(object.protect.position), size: Boolean(object.protect.size) };
  if (object.kind === 'shape') {
    out.shape = presetDefinition(object.shape) || object.shape === 'custom' ? object.shape : 'rectangle';
    if (Array.isArray(object.mods)) out.mods = object.mods.slice(0, 20).map((v) => finite(v, 0));
    if (object.shape === 'custom' && object.geometry) out.geometry = object.geometry;
  }
  if (object.kind === 'path') out.subpaths = cleanSubpaths(object.subpaths);
  if (object.kind === 'connector') {
    const end = (e) => (e && typeof e.id === 'string' ? { id: e.id, glue: Math.max(0, Math.floor(finite(e.glue, 0))) } : null);
    out.from = end(object.from);
    out.to = end(object.to);
    out.routing = ['standard', 'line', 'curve', 'lines'].includes(object.routing) ? object.routing : 'standard';
  }
  if (object.kind === 'image') {
    if (object.crop) {
      const c = object.crop;
      out.crop = { l: clampTo(c.l, 0, 0.95, 0), t: clampTo(c.t, 0, 0.95, 0), r: clampTo(c.r, 0, 0.95, 0), b: clampTo(c.b, 0, 0.95, 0) };
    }
    if (object.adjust) {
      const a = object.adjust;
      out.adjust = {
        brightness: clampTo(a.brightness, -100, 100, 0), contrast: clampTo(a.contrast, -100, 100, 0),
        red: clampTo(a.red, -100, 100, 0), green: clampTo(a.green, -100, 100, 0), blue: clampTo(a.blue, -100, 100, 0),
        gamma: clampTo(a.gamma, 0.1, 10, 1), transparency: clampTo(a.transparency, 0, 100, 0),
        mode: ['standard', 'grey', 'mono', 'watermark'].includes(a.mode) ? a.mode : 'standard',
      };
    }
  }
  if (object.kind === 'group') out.children = Array.isArray(object.children) ? object.children : [];
  if (object.kind === 'scene3d') {
    out.solid = ['cube', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'shell', 'half-sphere', 'extrude', 'lathe'].includes(object.solid) ? object.solid : 'cube';
    for (const key of ['rotX', 'rotY', 'rotZ']) out[key] = clampTo(object[key], -360, 360, key === 'rotX' ? 20 : key === 'rotY' ? -30 : 0);
    out.depth = clampTo(object.depth, 0.01, 5, 0.3);
    out.color = colour(object.color, '#729fcf');
    if (Array.isArray(object.profile)) out.profile = object.profile.slice(0, 50).map((poly) => (Array.isArray(poly) ? poly.slice(0, 2000).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]) : [])).filter((poly) => poly.length);
  }
  if (Array.isArray(object.glue)) out.glue = object.glue.slice(0, 64).filter((g) => Number.isFinite(g?.x) && Number.isFinite(g?.y)).map((g) => ({ x: clampTo(g.x, 0, 1, 0), y: clampTo(g.y, 0, 1, 0) }));
  return out;
}

// Boxes

/** The four corners of an object's box, rotated about its centre. */
export function corners(o) {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const a = ((o.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]].map(([x, y]) => ({
    x: cx + (x - cx) * cos - (y - cy) * sin,
    y: cy + (x - cx) * sin + (y - cy) * cos,
  }));
}

/** The upright box that holds an object, rotation included. */
export function outerBox(o) {
  const points = corners(o);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** The box around several objects. */
export function unionBox(objects) {
  const boxes = objects.map(outerBox);
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

// Arrange: z is the stacking order, highest on top.

const byZ = (list) => [...list].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

/** Renumbers z in the order given, keeping the order and making room. */
function restack(ordered) {
  ordered.forEach((o, i) => { o.z = i + 1; });
}

/**
 * Bring to Front, Forward One, Backward One, Send to Back, Reverse, and In Front of or Behind another object.
 * @param {Object[]} all every object on the page
 * @param {Set<string>|string[]} ids the chosen
 * @param {'front'|'forward'|'backward'|'back'|'reverse'|'in-front-of'|'behind'} how
 * @param {string} [other] the object for in-front-of and behind
 */
export function arrange(all, ids, how, other = null) {
  const chosen = new Set(ids);
  let order = byZ(all);
  const picked = order.filter((o) => chosen.has(o.id));
  if (picked.length === 0) return false;
  const rest = order.filter((o) => !chosen.has(o.id));
  if (how === 'front') order = [...rest, ...picked];
  else if (how === 'back') order = [...picked, ...rest];
  else if (how === 'forward' || how === 'backward') {
    // Each chosen object passes the one next to it that it overlaps, as LibreOffice does, or simply the next one.
    const step = how === 'forward' ? 1 : -1;
    const list = [...order];
    const indices = list.map((o, i) => (chosen.has(o.id) ? i : -1)).filter((i) => i >= 0);
    for (const i of step > 0 ? indices.reverse() : indices) {
      const j = i + step;
      if (j < 0 || j >= list.length || chosen.has(list[j].id)) continue;
      [list[i], list[j]] = [list[j], list[i]];
    }
    order = list;
  } else if (how === 'reverse') {
    const positions = order.map((o, i) => (chosen.has(o.id) ? i : -1)).filter((i) => i >= 0);
    const reversed = positions.map((i) => order[i]).reverse();
    order = [...order];
    positions.forEach((at, k) => { order[at] = reversed[k]; });
  } else if (how === 'in-front-of' || how === 'behind') {
    const anchor = rest.findIndex((o) => o.id === other);
    if (anchor < 0) return false;
    const at = how === 'in-front-of' ? anchor + 1 : anchor;
    order = [...rest.slice(0, at), ...picked, ...rest.slice(at)];
  } else return false;
  restack(order);
  return true;
}

// Align and distribute

/** Aligns the chosen to each other, or to the page when only one is chosen. */
export function align(objects, how, page = null) {
  if (objects.length === 0) return false;
  const target = objects.length === 1 && page ? { x: 0, y: 0, w: page.w, h: page.h } : unionBox(objects);
  for (const o of objects) {
    const box = outerBox(o);
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = target.x - box.x;
    if (how === 'center') dx = target.x + target.w / 2 - (box.x + box.w / 2);
    if (how === 'right') dx = target.x + target.w - (box.x + box.w);
    if (how === 'top') dy = target.y - box.y;
    if (how === 'middle') dy = target.y + target.h / 2 - (box.y + box.h / 2);
    if (how === 'bottom') dy = target.y + target.h - (box.y + box.h);
    o.x += dx;
    o.y += dy;
  }
  return true;
}

/**
 * Distribute Selection: spaces three or more objects evenly between the outer two.
 * @param {'left'|'center'|'spacing-h'|'right'|'top'|'middle'|'spacing-v'|'bottom'} how
 */
export function distribute(objects, how) {
  if (objects.length < 3) return false;
  const horizontal = ['left', 'center', 'spacing-h', 'right'].includes(how);
  const key = (b) => {
    if (how === 'left' || how === 'spacing-h') return b.x;
    if (how === 'center') return b.x + b.w / 2;
    if (how === 'right') return b.x + b.w;
    if (how === 'top' || how === 'spacing-v') return b.y;
    if (how === 'middle') return b.y + b.h / 2;
    return b.y + b.h;
  };
  const items = objects.map((o) => ({ o, b: outerBox(o) })).sort((a, b) => key(a.b) - key(b.b));
  const first = items[0];
  const last = items[items.length - 1];
  if (how === 'spacing-h' || how === 'spacing-v') {
    const size = (b) => (horizontal ? b.w : b.h);
    const start = horizontal ? first.b.x + first.b.w : first.b.y + first.b.h;
    const end = horizontal ? last.b.x : last.b.y;
    const inner = items.slice(1, -1);
    const gap = (end - start - inner.reduce((s, i) => s + size(i.b), 0)) / (items.length - 1);
    let at = start + gap;
    for (const item of inner) {
      const d = at - (horizontal ? item.b.x : item.b.y);
      if (horizontal) item.o.x += d; else item.o.y += d;
      at += size(item.b) + gap;
    }
    return true;
  }
  const from = key(first.b);
  const step = (key(last.b) - from) / (items.length - 1);
  items.forEach((item, i) => {
    const d = from + step * i - key(item.b);
    if (horizontal) item.o.x += d; else item.o.y += d;
  });
  return true;
}

/** Equalize Width or Height: every chosen object takes the size of the first chosen. */
export function equalize(objects, what) {
  if (objects.length < 2) return false;
  const [model, ...rest] = objects;
  for (const o of rest) {
    if (what === 'width') { const cx = o.x + o.w / 2; o.w = model.w; o.x = cx - o.w / 2; }
    else { const cy = o.y + o.h / 2; o.h = model.h; o.y = cy - o.h / 2; }
  }
  return true;
}

// Rotate and flip

/** Rotates objects by a number of degrees about their own centres. */
export function rotateBy(objects, degrees) {
  for (const o of objects) o.rotation = ((((o.rotation ?? 0) + degrees) % 360) + 360) % 360;
  return objects.length > 0;
}

/** Flips objects; a group flips its members about its own centre. */
export function flip(objects, vertical) {
  for (const o of objects) {
    if (vertical) o.flipV = !o.flipV; else o.flipH = !o.flipH;
    if (!o.flipH) delete o.flipH;
    if (!o.flipV) delete o.flipV;
    // A rotated object flipped turns the other way.
    if (o.rotation) o.rotation = (360 - o.rotation) % 360;
  }
  return objects.length > 0;
}

// Groups

/**
 * Groups objects into one, kept as a group object holding the members with their page positions.
 * @returns {Object} the group, which the caller puts in place of its members
 */
export function makeGroup(objects, id) {
  const box = unionBox(objects);
  return { id, kind: 'group', x: box.x, y: box.y, w: Math.max(box.w, 1), h: Math.max(box.h, 1), rotation: 0, z: Math.max(...objects.map((o) => o.z ?? 0)), children: byZ(objects) };
}

/** The members of a group, moved and scaled to where the group now is. */
export function ungroup(group) {
  const children = group.children ?? [];
  const before = unionBox(children) ?? group;
  const sx = before.w ? group.w / before.w : 1;
  const sy = before.h ? group.h / before.h : 1;
  return children.map((c) => ({
    ...c,
    x: group.x + (c.x - before.x) * sx,
    y: group.y + (c.y - before.y) * sy,
    w: c.w * sx,
    h: c.h * sy,
  }));
}

/** Moves or scales a group's members with it, after its box changed. */
export function fitGroup(group) {
  group.children = ungroup(group);
}

// Duplicate

/**
 * Format, Duplicate: copies, each moved, turned, grown and coloured a step further.
 * @param {Object} source
 * @param {{copies: number, dx: number, dy: number, angle: number, dw: number, dh: number, startColor?: string, endColor?: string}} how
 * @param {() => string} makeId
 */
export function duplicate(source, how, makeId) {
  const copies = Math.max(1, Math.min(100, Math.floor(how.copies ?? 1)));
  const out = [];
  const mix = (a, b, t) => {
    const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const [x, y] = [p(a), p(b)];
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  };
  for (let i = 1; i <= copies; i += 1) {
    const copy = structuredClone(source);
    copy.id = makeId();
    copy.x = source.x + (how.dx ?? 0) * i;
    copy.y = source.y + (how.dy ?? 0) * i;
    copy.w = Math.max(1, source.w + (how.dw ?? 0) * i);
    copy.h = Math.max(1, source.h + (how.dh ?? 0) * i);
    copy.rotation = ((((source.rotation ?? 0) + (how.angle ?? 0) * i) % 360) + 360) % 360;
    copy.z = (source.z ?? 0) + i;
    if (how.startColor && how.endColor && /^#[0-9a-f]{6}$/i.test(how.startColor) && /^#[0-9a-f]{6}$/i.test(how.endColor)) {
      copy.fillLook = { ...(copy.fillLook ?? {}), type: 'solid', color: mix(how.startColor, how.endColor, i / copies) };
    }
    out.push(copy);
  }
  return out;
}

// Convert

/** A shape's outline as subpaths of nodes, in its own box: what To Curve gives. */
export function shapeToSubpaths(o) {
  const definition = o.shape === 'custom' ? o.geometry : presetDefinition(o.shape);
  if (!definition) return [];
  const { paths } = shapeGeometry(definition, o.w, o.h, o.mods);
  const out = [];
  for (const path of paths) {
    let current = null;
    for (const s of path.segments) {
      if (s.type === 'M') { current = { closed: false, nodes: [{ x: s.to.x, y: s.to.y }] }; out.push(current); }
      else if (s.type === 'L') current.nodes.push({ x: s.to.x, y: s.to.y });
      else if (s.type === 'C') {
        current.nodes[current.nodes.length - 1].out = { ...s.c1 };
        current.nodes.push({ x: s.to.x, y: s.to.y, in: { ...s.c2 } });
      } else if (s.type === 'Z' && current) {
        current.closed = true;
        // The closing node drawn again on the first is the first.
        const first = current.nodes[0];
        const last = current.nodes[current.nodes.length - 1];
        if (current.nodes.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) {
          if (last.in) first.in = last.in;
          current.nodes.pop();
        }
      }
    }
  }
  return out;
}

/** Curves flattened to straight pieces, as To Polygon does. */
export function flattenSubpaths(subpaths, steps = 12) {
  return subpaths.map((s) => {
    const nodes = [];
    const count = s.nodes.length;
    const pieces = s.closed ? count : count - 1;
    for (let i = 0; i < count; i += 1) nodes.push({ x: s.nodes[i].x, y: s.nodes[i].y });
    const out = [{ x: s.nodes[0].x, y: s.nodes[0].y }];
    for (let i = 0; i < pieces; i += 1) {
      const a = s.nodes[i];
      const b = s.nodes[(i + 1) % count];
      if (a.out || b.in) {
        const c1 = a.out ?? a;
        const c2 = b.in ?? b;
        for (let k = 1; k <= steps; k += 1) {
          const t = k / steps;
          const u = 1 - t;
          out.push({
            x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
            y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
          });
        }
      } else out.push({ x: b.x, y: b.y });
    }
    if (s.closed) out.pop();
    return { closed: s.closed, nodes: out };
  });
}

/** SVG path data for subpaths. */
export function subpathsData(subpaths) {
  const f = (v) => Math.round(v * 100) / 100;
  return subpaths.map((s) => {
    if (s.nodes.length === 0) return '';
    let d = `M${f(s.nodes[0].x)} ${f(s.nodes[0].y)}`;
    const count = s.nodes.length;
    const pieces = s.closed ? count : count - 1;
    for (let i = 0; i < pieces; i += 1) {
      const a = s.nodes[i];
      const b = s.nodes[(i + 1) % count];
      if (a.out || b.in) {
        const c1 = a.out ?? a;
        const c2 = b.in ?? b;
        d += `C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`;
      } else d += `L${f(b.x)} ${f(b.y)}`;
    }
    return s.closed ? `${d}Z` : d;
  }).join('');
}

/** Scales a path's nodes when its box changes size. */
export function scaleSubpaths(subpaths, sx, sy) {
  const s = (p) => (p ? { x: p.x * sx, y: p.y * sy } : undefined);
  return subpaths.map((sp) => ({ closed: sp.closed, nodes: sp.nodes.map((n) => ({ ...s(n), ...(n.in ? { in: s(n.in) } : {}), ...(n.out ? { out: s(n.out) } : {}) })) }));
}

/** Fits a path's box to its nodes, moving the object so nothing moves on the page. */
export function fitPathBox(o) {
  const points = o.subpaths.flatMap((s) => s.nodes.flatMap((n) => [n, n.in, n.out].filter(Boolean)));
  if (points.length === 0) return;
  const minX = least(points.map((p) => p.x));
  const minY = least(points.map((p) => p.y));
  const maxX = greatest(points.map((p) => p.x));
  const maxY = greatest(points.map((p) => p.y));
  const move = (p) => (p ? { x: p.x - minX, y: p.y - minY } : undefined);
  o.subpaths = o.subpaths.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ ...move(n), ...(n.in ? { in: move(n.in) } : {}), ...(n.out ? { out: move(n.out) } : {}) })) }));
  o.x += minX;
  o.y += minY;
  o.w = Math.max(maxX - minX, 1);
  o.h = Math.max(maxY - minY, 1);
}

/** Shape, Convert, To 3D and To 3D Rotation Object: the outline pushed back, or turned about the vertical axis. */
export function convertTo3d(o, how) {
  let subpaths = null;
  if (o.kind === 'shape') subpaths = shapeToSubpaths(o);
  else if (o.kind === 'path') subpaths = o.subpaths;
  if (!subpaths?.length) return false;
  const flat = flattenSubpaths(subpaths);
  const profile = flat.map((s) => s.nodes.map((n) => [n.x / Math.max(o.w, 1e-6) - (how === 'lathe' ? 0 : 0.5), 0.5 - n.y / Math.max(o.h, 1e-6)]));
  const colour = o.fillLook?.color ?? '#729fcf';
  for (const key of ['shape', 'mods', 'geometry', 'subpaths', 'line', 'fillLook', 'direction', 'thickness', 'arrow']) delete o[key];
  Object.assign(o, { kind: 'scene3d', solid: how, profile, depth: 0.3, rotX: 20, rotY: -30, rotZ: 0, color: colour });
  return true;
}

/**
 * Shape, Convert: To Curve, To Polygon or To Contour; the object becomes a path with the same look.
 * @returns {boolean} whether it changed
 */
export function convert(o, to) {
  let subpaths = null;
  if (o.kind === 'shape') subpaths = shapeToSubpaths(o);
  else if (o.kind === 'path') subpaths = o.subpaths;
  else if (o.kind === 'line') {
    const [x1, y1, x2, y2] = o.direction === 'up' ? [0, o.h, o.w, 0] : [0, 0, o.w, o.h];
    subpaths = [{ closed: false, nodes: [{ x: x1, y: y1 }, { x: x2, y: y2 }] }];
  }
  if (!subpaths) return false;
  if (to === 'polygon') subpaths = flattenSubpaths(subpaths);
  if (to === 'contour') {
    // The contour of a line is the outline its stroke covers, drawn as the outline it fills.
    subpaths = flattenSubpaths(subpaths);
  }
  const look = { line: o.line, fillLook: o.fillLook };
  for (const key of ['shape', 'mods', 'geometry', 'direction', 'thickness', 'arrow']) delete o[key];
  o.kind = 'path';
  o.subpaths = cleanSubpaths(subpaths);
  if (look.line) o.line = look.line;
  if (look.fillLook) o.fillLook = look.fillLook;
  return true;
}

/** Glue points of an object in page coordinates: the shape's own, then the ones added by hand, as fractions of the box. */
export function gluePoints(o) {
  const local = [];
  if (o.kind === 'shape') {
    const definition = o.shape === 'custom' ? o.geometry : presetDefinition(o.shape);
    if (definition) local.push(...shapeGeometry(definition, o.w, o.h, o.mods).glue);
  }
  if (local.length === 0 && o.kind !== 'connector' && o.kind !== 'line') {
    local.push({ x: o.w / 2, y: 0 }, { x: o.w, y: o.h / 2 }, { x: o.w / 2, y: o.h }, { x: 0, y: o.h / 2 });
  }
  for (const g of o.glue ?? []) local.push({ x: g.x * o.w, y: g.y * o.h });
  return local.map((p) => toPage(o, p));
}

/** A point of an object's own box on the page, its rotation and flips applied. */
export function toPage(o, p) {
  let x = p.x;
  let y = p.y;
  if (o.flipH) x = o.w - x;
  if (o.flipV) y = o.h - y;
  const cx = o.w / 2;
  const cy = o.h / 2;
  const a = ((o.rotation ?? 0) * Math.PI) / 180;
  return { x: o.x + cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), y: o.y + cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a) };
}

/** A page point in an object's own box: the inverse of toPage. */
export function toLocal(o, p) {
  const cx = o.w / 2;
  const cy = o.h / 2;
  const a = (-(o.rotation ?? 0) * Math.PI) / 180;
  const dx = p.x - o.x - cx;
  const dy = p.y - o.y - cy;
  let x = cx + dx * Math.cos(a) - dy * Math.sin(a);
  let y = cy + dx * Math.sin(a) + dy * Math.cos(a);
  if (o.flipH) x = o.w - x;
  if (o.flipV) y = o.h - y;
  return { x, y };
}
