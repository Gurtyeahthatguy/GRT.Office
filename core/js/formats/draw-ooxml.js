/** Drawing objects in DrawingML, as PowerPoint, Word and Excel keep them: shapes, connectors, pictures and groups. */

import { kid, kids, tag } from '../xml.js';
import { PRESETS } from '../draw/presets.js';
import { presetDefinition, shapeGeometry, ooxmlPreset, ownForOoxml } from '../draw/geometry.js';
import { cleanLine, cleanFill, cleanSubpaths, gluePoints } from '../draw/objects.js';
import { sceneAsGroup } from '../draw/three.js';
import { readXfrm, isTransparent, customGeometry } from './drawingml.js';
import { subpathsFromSvg } from './draw-odf.js';

export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** OOXML's line ends and ours, both ways. */
const END_FROM = { triangle: 'arrow', arrow: 'arrow-short', stealth: 'concave', oval: 'circle', diamond: 'diamond' };
const END_TO = { arrow: 'triangle', 'arrow-short': 'arrow', triangle: 'triangle', concave: 'stealth', circle: 'oval', square: 'diamond', diamond: 'diamond', dimension: 'arrow', line: 'arrow' };
const DASH_FROM = { dash: 'dash', sysDash: 'dash', lgDash: 'long-dash', dashDot: 'dash-dot', lgDashDot: 'dash-dot', sysDashDot: 'dash-dot', dot: 'dot', sysDot: 'dot' };
const DASH_TO = { dash: 'dash', dot: 'sysDot', 'dash-dot': 'dashDot', 'long-dash': 'lgDash' };

const child = (node, name) => kid(node, A, name);

const angle = (v) => Number(v ?? 0) / 60000;

// Reading

/** A shape's line from its a:ln and its style reference. */
export function lineFrom(spPr, style, ctx) {
  const ln = child(spPr, 'ln');
  if (child(ln, 'noFill')) return cleanLine({ style: 'none' });
  const solid = child(ln, 'solidFill');
  const ref = kid(style, A, 'lnRef');
  const color = solid ? ctx.color(solid) : ref && Number(ref.getAttribute('idx')) > 0 ? ctx.color(ref) : null;
  if (!color && !ln) return cleanLine({ style: 'none' });
  const end = (name) => END_FROM[child(ln, name)?.getAttribute('type')] ?? 'none';
  return cleanLine({
    style: DASH_FROM[child(ln, 'prstDash')?.getAttribute('val')] ?? 'solid',
    color: color ?? '#000000',
    width: ctx.fromEmu(Number(ln?.getAttribute('w') ?? 9525)),
    start: end('headEnd'),
    end: end('tailEnd'),
  });
}

/** A shape's fill from spPr and its style reference. */
export function fillFrom(spPr, style, ctx) {
  if (child(spPr, 'noFill')) return cleanFill({ type: 'none' });
  const solid = child(spPr, 'solidFill');
  if (solid) {
    const alpha = solid.getElementsByTagNameNS(A, 'alpha')[0];
    return isTransparent(solid) ? cleanFill({ type: 'none' }) : cleanFill({ type: 'solid', color: ctx.color(solid) ?? '#729fcf', ...(alpha ? { transparency: 100 - Number(alpha.getAttribute('val')) / 1000 } : {}) });
  }
  const gradient = child(spPr, 'gradFill');
  if (gradient) {
    const stops = [...gradient.getElementsByTagNameNS(A, 'gs')];
    return cleanFill({
      type: 'gradient', color: ctx.color(stops[0]) ?? '#ffffff', color2: ctx.color(stops[stops.length - 1]) ?? '#000000',
      angle: 90 - angle(child(gradient, 'lin')?.getAttribute('ang')), shape: child(gradient, 'path') ? 'radial' : 'linear',
    });
  }
  const pattern = child(spPr, 'pattFill');
  if (pattern) return cleanFill({ type: 'hatch', color: ctx.color(child(pattern, 'fgClr')) ?? '#000000', angle: /dn|down/i.test(pattern.getAttribute('prst') ?? '') ? -45 : 45 });
  if (child(spPr, 'blipFill')) { ctx.losses?.add?.('Picture fills, shown as one colour'); return cleanFill({ type: 'solid', color: '#cccccc' }); }
  const ref = kid(style, A, 'fillRef');
  if (ref && Number(ref.getAttribute('idx')) > 0) return cleanFill({ type: 'solid', color: ctx.color(ref) ?? '#729fcf' });
  return cleanFill({ type: 'none' });
}

/** The name, title and description of a shape, from its cNvPr. */
function namesFrom(node) {
  const props = node.getElementsByTagNameNS('*', 'cNvPr')[0];
  const out = {};
  if (!props) return out;
  const name = props.getAttribute('name');
  if (name) out.name = name.slice(0, 200);
  if (props.getAttribute('title')) out.title = props.getAttribute('title').slice(0, 200);
  if (props.getAttribute('descr')) out.description = props.getAttribute('descr').slice(0, 5000);
  if (props.getAttribute('id')) out.ooxmlId = props.getAttribute('id');
  return out;
}

/**
 * One DrawingML shape, connector, picture or group as a drawing object.
 * @param {Element} node p:sp, wps:wsp, xdr:sp, p:cxnSp, p:pic, p:grpSp and their kin
 * @param {{place: (raw) => Object, color: (holder) => ?string, fromEmu: (n) => number, picture: (relId) => ?string, id: () => string, losses?: Object, text?: (node, box) => ?Object}} ctx
 */
export function readDrawingMl(node, ctx) {
  const local = node.localName;
  const spPr = [...node.children].find((c) => c.localName === 'spPr' || c.localName === 'grpSpPr');
  const style = [...node.children].find((c) => c.localName === 'style');
  const raw = readXfrm(child(spPr, 'xfrm'));
  if (local === 'grpSp' || local === 'wgp') {
    const transform = ctx.group ? ctx.group(child(spPr, 'xfrm')) : null;
    const inner = { ...ctx, place: transform ?? ctx.place };
    const children = [...node.children].filter((c) => ['sp', 'cxnSp', 'pic', 'grpSp', 'wsp', 'wgp'].includes(c.localName)).map((c) => readDrawingMl(c, inner)).filter(Boolean);
    if (!children.length) return null;
    // A group of one is that one.
    if (children.length === 1) return children[0];
    const x = Math.min(...children.map((c) => c.x)); const y = Math.min(...children.map((c) => c.y));
    return { id: ctx.id(), kind: 'group', x, y, w: Math.max(...children.map((c) => c.x + c.w)) - x, h: Math.max(...children.map((c) => c.y + c.h)) - y, rotation: 0, children, ...namesFrom(node) };
  }
  if (!raw) return null;
  const box = ctx.place(raw);
  const flips = { ...(raw.flipH ? { flipH: true } : {}), ...(raw.flipV ? { flipV: true } : {}) };
  if (local === 'pic') {
    const fill = [...node.children].find((c) => c.localName === 'blipFill');
    const blip = child(fill, 'blip');
    const resource = ctx.picture(blip?.getAttributeNS(R, 'embed'));
    if (!resource) { ctx.losses?.add?.('Pictures that could not be read, left out'); return null; }
    const o = { id: ctx.id(), kind: 'image', x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation ?? 0, resource, ...flips, ...namesFrom(node) };
    const src = child(fill, 'srcRect');
    if (src) {
      const c = (k) => Math.min(0.95, Math.max(0, Number(src.getAttribute(k) ?? 0) / 100000));
      if (['l', 't', 'r', 'b'].some((k) => c(k) > 0)) o.crop = { l: c('l'), t: c('t'), r: c('r'), b: c('b') };
    }
    const lum = child(blip, 'lum');
    const alpha = child(blip, 'alphaModFix');
    if (lum || alpha || child(blip, 'grayscl') || child(blip, 'biLevel')) {
      o.adjust = {
        brightness: Number(lum?.getAttribute('bright') ?? 0) / 1000, contrast: Number(lum?.getAttribute('contrast') ?? 0) / 1000,
        red: 0, green: 0, blue: 0, gamma: 1, transparency: alpha ? 100 - Number(alpha.getAttribute('amt') ?? 100000) / 1000 : 0,
        mode: child(blip, 'biLevel') ? 'mono' : child(blip, 'grayscl') ? 'grey' : 'standard',
      };
    }
    const ln = child(spPr, 'ln');
    if (ln && !child(ln, 'noFill')) o.line = lineFrom(spPr, style, ctx);
    return o;
  }
  const geometry = child(spPr, 'prstGeom')?.getAttribute('prst');
  const custom = child(spPr, 'custGeom');
  const look = { line: lineFrom(spPr, style, ctx), fillLook: fillFrom(spPr, style, ctx) };
  if (spPr && child(spPr, 'effectLst') && child(child(spPr, 'effectLst'), 'outerShdw')) look.shadow = true;
  const base = { x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation ?? 0, ...look, ...namesFrom(node) };
  if (local === 'cxnSp' || ['line', 'straightConnector1'].includes(geometry) || /^(bent|curved)Connector/.test(geometry ?? '')) {
    const nv = [...node.children].find((c) => c.localName === 'nvCxnSpPr');
    const props = nv && [...nv.children].find((c) => c.localName === 'cNvCxnSpPr');
    const end = (name) => {
      const e = props && kid(props, A, name);
      return e ? { ooxmlId: e.getAttribute('id'), glue: Number(e.getAttribute('idx') ?? 0) } : null;
    };
    const from = end('stCxn'); const to = end('endCxn');
    if (from || to) {
      return { id: ctx.id(), kind: 'connector', ...base, routing: /^bent/.test(geometry ?? '') ? 'standard' : /^curved/.test(geometry ?? '') ? 'curve' : 'line', fromOoxml: from, toOoxml: to };
    }
    const x1 = raw.flipH ? box.w : 0; const y1 = raw.flipV ? box.h : 0;
    return { id: ctx.id(), kind: 'path', ...base, subpaths: [{ closed: false, nodes: [{ x: x1, y: y1 }, { x: box.w - x1, y: box.h - y1 }] }] };
  }
  const text = ctx.text?.(node, box) ?? {};
  if (custom) {
    const read = customGeometry(custom, Number(child(child(spPr, 'xfrm'), 'ext')?.getAttribute('cx') ?? 0), Number(child(child(spPr, 'xfrm'), 'ext')?.getAttribute('cy') ?? 0));
    if (!read) { ctx.losses?.add?.('Freeform shapes that could not be read, drawn as rectangles'); return { id: ctx.id(), kind: 'shape', shape: 'rectangle', ...base, ...flips, ...text }; }
    const subpaths = subpathsFromSvg(read.path, [0, 0, 100, 100], box.w, box.h);
    if (!read.filled) base.fillLook = cleanFill({ type: 'none' });
    const turn = (p) => (p ? { x: raw.flipH ? box.w - p.x : p.x, y: raw.flipV ? box.h - p.y : p.y } : undefined);
    const turned = raw.flipH || raw.flipV ? subpaths.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ ...turn(n), ...(n.in ? { in: turn(n.in) } : {}), ...(n.out ? { out: turn(n.out) } : {}) })) })) : subpaths;
    return { id: ctx.id(), kind: 'path', ...base, subpaths: cleanSubpaths(turned), ...text };
  }
  if (!geometry) return Object.keys(text).length ? { id: ctx.id(), kind: 'text-only', ...base, ...text } : null;
  // Written adjustments that only repeat the defaults leave the shape as it is.
  const defaults = PRESETS.ooxml[geometry]?.mod ?? [];
  const adjNames = PRESETS.ooxml[geometry]?.adj ?? [];
  const adjusted = kids(child(child(spPr, 'prstGeom'), 'avLst'), A, 'gd').some((gd) => {
    const at = adjNames.indexOf(gd.getAttribute('name'));
    const value = /^val\s+(-?\d+(\.\d+)?)$/.exec(gd.getAttribute('fmla') ?? '');
    return at < 0 || !value || Number(value[1]) !== defaults[at];
  });
  const type = (!adjusted && ownForOoxml(geometry)) || `ooxml-${geometry}`;
  if (!presetDefinition(type)) {
    ctx.losses?.add?.('Shapes GRT does not have, drawn as rectangles');
    return { id: ctx.id(), kind: 'shape', shape: 'rectangle', ...base, ...flips, ...text };
  }
  const o = { id: ctx.id(), kind: 'shape', shape: type, ...base, ...flips, ...text };
  const names = PRESETS.ooxml[geometry]?.adj ?? [];
  const guides = kids(child(child(spPr, 'prstGeom'), 'avLst'), A, 'gd');
  if (guides.length && names.length) {
    const defaults = PRESETS.ooxml[geometry]?.mod ?? [];
    const mods = [...defaults];
    for (const gd of guides) {
      const at = names.indexOf(gd.getAttribute('name'));
      const value = /^val\s+(-?\d+(\.\d+)?)$/.exec(gd.getAttribute('fmla') ?? '');
      if (at >= 0 && value) mods[at] = Number(value[1]);
    }
    o.mods = mods;
  }
  return o;
}

/** Hangs read connectors on the shapes they named by cNvPr id. */
export function linkOoxmlConnectors(objects) {
  const byId = new Map(objects.filter((o) => o.ooxmlId).map((o) => [o.ooxmlId, o]));
  for (const o of objects) {
    if (o.kind !== 'connector') continue;
    const end = (e) => {
      const target = e && byId.get(e.ooxmlId);
      if (!target) return null;
      const count = gluePoints(target).length;
      return { id: target.id, glue: Math.min(Math.max(e.glue, 0), Math.max(count - 1, 0)) };
    };
    o.from = end(o.fromOoxml);
    o.to = end(o.toOoxml);
    delete o.fromOoxml;
    delete o.toOoxml;
  }
  for (const o of objects) delete o.ooxmlId;
  return objects;
}

// Writing

const hex = (c) => String(c ?? '#000000').replace('#', '').toUpperCase();

/** a:solidFill for a colour, with its transparency. */
export function solidXml(color, transparency = 0) {
  return tag('a:solidFill', {}, tag('a:srgbClr', { val: hex(color) }, transparency ? tag('a:alpha', { val: String(Math.round((100 - transparency) * 1000)) }) : null));
}

/** The fill of a shape as DrawingML. */
export function fillXml(fill) {
  const f = cleanFill(fill);
  if (f.type === 'none') return tag('a:noFill');
  if (f.type === 'gradient') {
    return tag('a:gradFill', { rotWithShape: '1' },
      tag('a:gsLst', {}, tag('a:gs', { pos: '0' }, tag('a:srgbClr', { val: hex(f.color) })), tag('a:gs', { pos: '100000' }, tag('a:srgbClr', { val: hex(f.color2) }))),
      f.shape === 'radial' ? tag('a:path', { path: 'circle' }, tag('a:fillToRect', { l: '50000', t: '50000', r: '50000', b: '50000' })) : tag('a:lin', { ang: String(Math.round(((90 - f.angle) % 360 + 360) % 360 * 60000)), scaled: '0' }));
  }
  if (f.type === 'hatch') {
    return tag('a:pattFill', { prst: f.angle < 0 ? 'wdDnDiag' : 'wdUpDiag' }, tag('a:fgClr', {}, tag('a:srgbClr', { val: hex(f.color) })), tag('a:bgClr', {}, tag('a:srgbClr', { val: 'FFFFFF' })));
  }
  return solidXml(f.color, f.transparency);
}

/** The outline of a shape as a:ln. */
export function lineXml(line, emu) {
  const l = cleanLine(line);
  if (l.style === 'none' || l.width === 0) return tag('a:ln', {}, tag('a:noFill'));
  return tag('a:ln', { w: String(emu(l.width)) }, solidXml(l.color, l.transparency),
    DASH_TO[l.style] ? tag('a:prstDash', { val: DASH_TO[l.style] }) : null,
    l.start !== 'none' ? tag('a:headEnd', { type: END_TO[l.start] }) : null,
    l.end !== 'none' ? tag('a:tailEnd', { type: END_TO[l.end] }) : null);
}

/** The geometry of a shape: a preset where PowerPoint has one, else its outline worked out at its size. */
export function geometryXml(o, emu) {
  if (o.kind === 'shape') {
    const prst = o.shape === 'custom' ? null : ooxmlPreset(o.shape);
    const fromOoxml = o.shape?.startsWith('ooxml-');
    const definition = o.shape === 'custom' ? o.geometry : presetDefinition(o.shape);
    const changed = Array.isArray(o.mods) && definition?.mod && o.mods.some((v, i) => v !== definition.mod[i]);
    if (prst && (!changed || fromOoxml)) {
      const names = PRESETS.ooxml[prst]?.adj ?? [];
      const guides = fromOoxml && changed ? o.mods.map((v, i) => (names[i] ? tag('a:gd', { name: names[i], fmla: `val ${Math.round(v)}` }) : null)) : [];
      return tag('a:prstGeom', { prst }, tag('a:avLst', {}, guides));
    }
    if (!definition) return tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst'));
    const { paths } = shapeGeometry(definition, o.w, o.h, o.mods);
    return custXml(paths.map((p) => ({ fill: p.fill, stroke: p.stroke, steps: p.segments })), o, emu);
  }
  if (o.kind === 'path') {
    const steps = (o.subpaths ?? []).flatMap((s) => {
      const out = [{ type: 'M', to: s.nodes[0] }];
      const pieces = s.closed ? s.nodes.length : s.nodes.length - 1;
      for (let i = 0; i < pieces; i += 1) {
        const a = s.nodes[i]; const b = s.nodes[(i + 1) % s.nodes.length];
        out.push(a.out || b.in ? { type: 'C', c1: a.out ?? a, c2: b.in ?? b, to: b } : { type: 'L', to: b });
      }
      if (s.closed) out.push({ type: 'Z' });
      return out;
    });
    const filled = (o.subpaths ?? []).some((s) => s.closed);
    return custXml([{ fill: filled, stroke: true, steps }], o, emu);
  }
  return tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst'));
}

function custXml(paths, o, emu) {
  const w = Math.max(1, emu(o.w));
  const h = Math.max(1, emu(o.h));
  const pt = (p) => tag('a:pt', { x: String(Math.round(emu(p.x))), y: String(Math.round(emu(p.y))) });
  return tag('a:custGeom', {}, tag('a:avLst'), tag('a:gdLst'), tag('a:ahLst'), tag('a:cxnLst'), tag('a:rect', { l: 'l', t: 't', r: 'r', b: 'b' }),
    tag('a:pathLst', {}, paths.map((p) => tag('a:path', { w: String(w), h: String(h), fill: p.fill ? null : 'none', stroke: p.stroke ? null : '0' },
      p.steps.map((s) => (s.type === 'M' ? tag('a:moveTo', {}, pt(s.to)) : s.type === 'L' ? tag('a:lnTo', {}, pt(s.to)) : s.type === 'C' ? tag('a:cubicBezTo', {}, pt(s.c1), pt(s.c2), pt(s.to)) : tag('a:close')))))));
}

/** a:xfrm for an object; a path's flips are drawn into its outline, so they are not written twice. */
export function xfrmXml(o, emu, name = 'a:xfrm') {
  const flips = o.kind === 'shape' || o.kind === 'image';
  return tag(name, {
    rot: o.rotation ? String(Math.round(o.rotation * 60000)) : null,
    flipH: flips && o.flipH ? '1' : null,
    flipV: flips && o.flipV ? '1' : null,
  }, tag('a:off', { x: String(Math.round(emu(o.x))), y: String(Math.round(emu(o.y))) }), tag('a:ext', { cx: String(Math.round(emu(Math.max(0, o.w)))), cy: String(Math.round(emu(Math.max(0, o.h)))) }));
}

/** A path's nodes turned by its flips, for writers that draw them into the outline. */
export function flippedPath(o) {
  if (o.kind !== 'path' || (!o.flipH && !o.flipV)) return o;
  const turn = (p) => (p ? { x: o.flipH ? o.w - p.x : p.x, y: o.flipV ? o.h - p.y : p.y } : undefined);
  return { ...o, subpaths: o.subpaths.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ ...turn(n), ...(n.in ? { in: turn(n.in) } : {}), ...(n.out ? { out: turn(n.out) } : {}) })) })) };
}

/** The picture effects of an image: brightness and contrast, grey, black and white, transparency. */
export function blipEffects(o) {
  const a = o.adjust;
  if (!a) return [];
  return [
    a.brightness || a.contrast ? tag('a:lum', { bright: a.brightness ? String(Math.round(a.brightness * 1000)) : null, contrast: a.contrast ? String(Math.round(a.contrast * 1000)) : null }) : null,
    a.mode === 'grey' ? tag('a:grayscl') : null,
    a.mode === 'mono' ? tag('a:biLevel', { thresh: '50000' }) : null,
    a.transparency ? tag('a:alphaModFix', { amt: String(Math.round((100 - a.transparency) * 1000)) }) : null,
  ];
}

/** a:srcRect for a cropped picture. */
export function srcRectXml(o) {
  if (!o.crop) return null;
  const c = (v) => String(Math.round(v * 100000));
  return tag('a:srcRect', { l: c(o.crop.l), t: c(o.crop.t), r: c(o.crop.r), b: c(o.crop.b) });
}

/** Shadow as an effect list. */
export const effectsXml = (o) => (o.shadow ? tag('a:effectLst', {}, tag('a:outerShdw', { blurRad: '38100', dist: '38100', dir: '2700000', algn: 'tl', rotWithShape: '0' }, tag('a:srgbClr', { val: '000000' }, tag('a:alpha', { val: '35000' })))) : null);

/**
 * One drawing object as a PowerPoint shape, connector, picture or group.
 * @param {Object} o
 * @param {{emu: (px) => number, nextId: () => number, picture: (o) => ?string, text?: (o) => any, ids: Map<string, number>, objects: Object[]}} ctx
 */
export function writePptxDrawing(o, ctx) {
  if (o.kind === 'scene3d') return writePptxDrawing(sceneAsGroup(o), ctx);
  const id = ctx.nextId();
  ctx.ids.set(o.id, id);
  const cNvPr = (fallback) => tag('p:cNvPr', { id: String(id), name: o.name ?? `${fallback} ${id}`, descr: o.description ?? null, title: o.title ?? null });
  if (o.kind === 'group') {
    const kids = (o.children ?? []).map((c) => writePptxDrawing(c, ctx)).filter(Boolean);
    return tag('p:grpSp', {}, tag('p:nvGrpSpPr', {}, cNvPr('Group'), tag('p:cNvGrpSpPr'), tag('p:nvPr')),
      tag('p:grpSpPr', {}, tag('a:xfrm', {}, tag('a:off', { x: String(Math.round(ctx.emu(o.x))), y: String(Math.round(ctx.emu(o.y))) }), tag('a:ext', { cx: String(Math.round(ctx.emu(o.w))), cy: String(Math.round(ctx.emu(o.h))) }),
        tag('a:chOff', { x: String(Math.round(ctx.emu(o.x))), y: String(Math.round(ctx.emu(o.y))) }), tag('a:chExt', { cx: String(Math.round(ctx.emu(o.w))), cy: String(Math.round(ctx.emu(o.h))) }))), kids);
  }
  if (o.kind === 'image') {
    const rel = ctx.picture(o);
    if (!rel) return null;
    return tag('p:pic', {}, tag('p:nvPicPr', {}, cNvPr('Picture'), tag('p:cNvPicPr', {}, tag('a:picLocks', { noChangeAspect: '1' })), tag('p:nvPr')),
      tag('p:blipFill', {}, tag('a:blip', { 'r:embed': rel }, blipEffects(o)), srcRectXml(o), tag('a:stretch', {}, tag('a:fillRect'))),
      tag('p:spPr', {}, xfrmXml(o, ctx.emu), tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')), o.line ? lineXml(o.line, ctx.emu) : null));
  }
  if (o.kind === 'connector') {
    const points = ctx.connectorPoints?.(o) ?? [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }];
    const a = points[0]; const b = points[points.length - 1];
    const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), flipH: b.x < a.x, flipV: b.y < a.y, kind: 'shape' };
    const end = (e, name) => (e && ctx.ids.has(e.id) ? tag(`a:${name}`, { id: String(ctx.ids.get(e.id)), idx: String(e.glue) }) : null);
    const prst = o.routing === 'line' ? 'straightConnector1' : o.routing === 'curve' ? 'curvedConnector3' : 'bentConnector3';
    return tag('p:cxnSp', {}, tag('p:nvCxnSpPr', {}, cNvPr('Connector'), tag('p:cNvCxnSpPr', {}, end(o.from, 'stCxn'), end(o.to, 'endCxn')), tag('p:nvPr')),
      tag('p:spPr', {}, xfrmXml(box, ctx.emu), tag('a:prstGeom', { prst }, tag('a:avLst')), lineXml(o.line, ctx.emu)));
  }
  if (o.kind === 'shape' || o.kind === 'path') {
    const drawn = flippedPath(o);
    return tag('p:sp', {}, tag('p:nvSpPr', {}, cNvPr(o.kind === 'path' ? 'Freeform' : 'Shape'), tag('p:cNvSpPr'), tag('p:nvPr')),
      tag('p:spPr', {}, xfrmXml(drawn, ctx.emu), geometryXml(drawn, ctx.emu), fillXml(drawn.fillLook), lineXml(drawn.line, ctx.emu), effectsXml(drawn)),
      ctx.text?.(o));
  }
  return null;
}
