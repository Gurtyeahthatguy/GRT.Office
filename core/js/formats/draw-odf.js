/** Drawing objects in OpenDocument: custom shapes, paths, lines, connectors, pictures and groups, with their graphic styles. */

import { NS, kids, kid, attr, tag } from '../xml.js';
import { parsePath } from '../paths.js';
import { presetDefinition, odfType, shapeGeometry, pathData, ownForOoxml } from '../draw/geometry.js';
import { cleanLine, cleanFill, cleanSubpaths, gluePoints } from '../draw/objects.js';
import { sceneAsGroup } from '../draw/three.js';
import { hexColour } from './colour.js';

const DRAWOOO = 'http://openoffice.org/2010/draw';

/** LibreOffice's line ends by the names its marker styles carry, and back. */
const MARKER_NAMES = {
  arrow: 'Arrow', 'arrow-short': 'Arrow short', triangle: 'Triangle', concave: 'Arrow concave', circle: 'Circle',
  square: 'Square', diamond: 'Square 45', dimension: 'Dimension lines', line: 'Line short',
};
const MARKER_PATHS = {
  Arrow: ['0 0 20 30', 'M10 0l-10 30h20z'], 'Arrow short': ['0 0 20 20', 'M10 0l-10 20h20z'], Triangle: ['0 0 1013 1130', 'M1013 1130l-506-1130-507 1130z'],
  'Arrow concave': ['0 0 1131 1580', 'M1013 1491l118 89-567-1580-564 1580 114-85 136-68 148-46 161-17 161 13 153 46z'],
  Circle: ['0 0 1131 1131', 'M462 1118l-102-29-102-51-93-72-72-93-51-102-29-102-13-105 13-102 29-106 51-102 72-89 93-72 102-50 102-34 106-9 101 9 106 34 98 50 93 72 72 89 51 102 29 106 13 102-13 105-29 102-51 102-72 93-93 72-98 51-106 29-101 13z'],
  Square: ['0 0 10 10', 'M0 0h10v10h-10z'], 'Square 45': ['0 0 1131 1131', 'M0 564l564 567 567-567-567-564z'],
  'Dimension lines': ['0 0 836 110', 'M0 0h278 278 280v36 36 38h-278-278-280v-36z'], 'Line short': ['0 0 1131 1918', 'M1131 1918l-566-1183-562 1183-3-35 565-1883 566 1883z'],
};

function markerKind(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n) return 'none';
  if (n.includes('circle')) return 'circle';
  if (n.includes('45') || n.includes('diamond')) return 'diamond';
  if (n.includes('square')) return 'square';
  if (n.includes('dimension')) return 'dimension';
  if (n.includes('concave')) return 'concave';
  if (n.includes('triangle')) return 'triangle';
  if (n.includes('short')) return 'arrow-short';
  if (n.includes('line')) return 'line';
  return 'arrow';
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const percent = (v) => (v === undefined || v === null ? null : num(String(v).replace('%', ''), 0));

// Reading

/** A drawing object's look from its resolved graphic properties. */
export function lookFromProperties(props, toPx) {
  const out = {};
  const stroke = props.stroke ?? 'solid';
  if (stroke === 'none') out.line = cleanLine({ style: 'none' });
  else {
    const dash = props['stroke-dash'] ?? '';
    out.line = cleanLine({
      style: stroke === 'dash' ? (/dot/i.test(dash) && !/dash/i.test(dash) ? 'dot' : /long/i.test(dash) ? 'long-dash' : /dot/i.test(dash) ? 'dash-dot' : 'dash') : 'solid',
      color: (props['stroke-color'] ?? '#3465a4').toLowerCase(),
      width: Math.max(0, toPx(props['stroke-width']) ?? 1),
      start: markerKind(props['marker-start']),
      end: markerKind(props['marker-end']),
      ...(props['stroke-opacity'] ? { transparency: 100 - percent(props['stroke-opacity']) } : {}),
    });
  }
  const fill = props.fill ?? 'solid';
  out.fillLook = cleanFill({
    type: { none: 'none', solid: 'solid', gradient: 'gradient', hatch: 'hatch', bitmap: 'solid' }[fill] ?? 'solid',
    color: (props['fill-color'] ?? '#729fcf').toLowerCase(),
    ...(props.gradient ? props.gradient : {}),
    ...(props.hatch ? props.hatch : {}),
    ...(props.opacity ? { transparency: 100 - percent(props.opacity) } : {}),
  });
  if (props.shadow === 'visible') out.shadow = true;
  return out;
}

/** A gradient or hatch style from office:styles, as the fill fields it gives. */
export function namedFills(stylesRoot) {
  const gradients = {};
  const hatches = {};
  for (const g of stylesRoot?.getElementsByTagNameNS?.(NS.draw, 'gradient') ?? []) {
    gradients[attr(g, NS.draw, 'name')] = {
      color: hexColour(attr(g, NS.draw, 'start-color')) ?? '#ffffff', color2: hexColour(attr(g, NS.draw, 'end-color')) ?? '#000000',
      angle: num(String(attr(g, NS.draw, 'angle') ?? '0').replace('deg', '')) / (/deg/.test(attr(g, NS.draw, 'angle') ?? '') ? 1 : 10),
      shape: attr(g, NS.draw, 'style') === 'radial' ? 'radial' : 'linear',
    };
  }
  for (const h of stylesRoot?.getElementsByTagNameNS?.(NS.draw, 'hatch') ?? []) {
    hatches[attr(h, NS.draw, 'name')] = { color: hexColour(attr(h, NS.draw, 'color')) ?? '#000000', angle: num(String(attr(h, NS.draw, 'rotation') ?? '0').replace('deg', '')) / (/deg/.test(attr(h, NS.draw, 'rotation') ?? '') ? 1 : 10) };
  }
  return { gradients, hatches };
}

/** A custom shape's geometry as a definition the interpreter draws, read from the file. */
export function geometryFromFile(geometry) {
  const value = (name, ns = NS.draw) => attr(geometry, ns, name);
  const box = String(value('viewBox', NS.svg) ?? '0 0 21600 21600').trim().split(/[\s,]+/).map(Number);
  const out = {
    path: (value('enhanced-path', DRAWOOO) ?? value('enhanced-path') ?? '').slice(0, 200000),
    eq: kids(geometry, NS.draw, 'equation').slice(0, 2000).map((e) => String(attr(e, NS.draw, 'formula') ?? '0').replace(/\s+/g, '')),
  };
  if (box.length === 4 && box.every(Number.isFinite) && !(box[2] === 0 && box[3] === 0)) out.box = box;
  const sub = value('sub-view-size', DRAWOOO);
  if (sub) out.sub = sub.trim().split(/\s+/).map(Number).slice(0, 400);
  const modifiers = value('modifiers');
  if (modifiers) out.mod = modifiers.trim().split(/\s+/).map(Number).slice(0, 20);
  for (const [key, name] of [['text', 'text-areas'], ['glue', 'glue-points']]) { const v = value(name); if (v) out[key] = v.slice(0, 20000); }
  const sx = value('path-stretchpoint-x');
  const sy = value('path-stretchpoint-y');
  if (sx !== null || sy !== null) out.stretch = [sx === null ? null : Number(sx), sy === null ? null : Number(sy)];
  if (value('mirror-horizontal') === 'true' || value('mirror-vertical') === 'true') out.mirror = [value('mirror-horizontal') === 'true', value('mirror-vertical') === 'true'];
  const handles = kids(geometry, NS.draw, 'handle').slice(0, 20).map((h) => {
    const handle = {};
    for (const a of h.attributes) if (a.namespaceURI === NS.draw && a.localName.startsWith('handle-') && a.localName !== 'handle-position-x' && a.localName !== 'handle-position-y') handle[a.localName.slice(7)] = a.value;
    return handle;
  });
  if (handles.length) out.handles = handles;
  return out;
}

/** Nodes of an SVG path, as subpaths in a box of a size from a viewBox. */
export function subpathsFromSvg(d, box, w, h) {
  let segments;
  try { segments = parsePath(d); } catch { return []; }
  const sx = box ? w / (box[2] || 1) : 1;
  const sy = box ? h / (box[3] || 1) : 1;
  const ox = box ? box[0] : 0;
  const oy = box ? box[1] : 0;
  const p = (x, y) => ({ x: (x - ox) * sx, y: (y - oy) * sy });
  const out = [];
  let current = null;
  for (const s of segments.slice(0, 200000)) {
    if (s[0] === 'M') { current = { closed: false, nodes: [p(s[1], s[2])] }; out.push(current); }
    else if (s[0] === 'L' && current) current.nodes.push(p(s[1], s[2]));
    else if (s[0] === 'C' && current) {
      current.nodes[current.nodes.length - 1].out = p(s[1], s[2]);
      current.nodes.push({ ...p(s[5], s[6]), in: p(s[3], s[4]) });
    } else if (s[0] === 'Z' && current) current.closed = true;
  }
  return cleanSubpaths(out);
}

/** A shape's box, with its turn read from draw:transform. */
export function odfBox(node, px) {
  const w = px(attr(node, NS.svg, 'width'));
  const h = px(attr(node, NS.svg, 'height'));
  if (w === null || h === null) return null;
  const transform = attr(node, NS.draw, 'transform');
  if (!transform) return { x: px(attr(node, NS.svg, 'x')) ?? 0, y: px(attr(node, NS.svg, 'y')) ?? 0, w, h, rotation: 0 };
  const rotate = /rotate\s*\(\s*([-\d.e]+)\s*\)/.exec(transform);
  const translate = /translate\s*\(\s*([-\d.e]+[a-z]*)[\s,]+([-\d.e]+[a-z]*)\s*\)/.exec(transform);
  if (/skew|scale|matrix/.test(transform)) return null;
  const length = (text) => (/[a-z]$/.test(text) ? px(text) : px(`${Number(text) / 100}mm`)) ?? 0;
  const angle = rotate ? -Number(rotate[1]) : 0;
  const tx = translate ? length(translate[1]) : 0;
  const ty = translate ? length(translate[2]) : 0;
  const cx = tx + Math.cos(angle) * (w / 2) - Math.sin(angle) * (h / 2);
  const cy = ty + Math.sin(angle) * (w / 2) + Math.cos(angle) * (h / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: (((angle * 180) / Math.PI) % 360 + 360) % 360 };
}

/**
 * Reads one drawing element into a drawing object, or null when it is not one this reader draws.
 * @param {Element} node
 * @param {{box: (n) => ?Object, look: (n) => Object, toPx: (s) => ?number, picture: (href) => ?string, id: () => string, losses: Object, text?: (n) => ?Object, child?: (n) => ?Object}} ctx
 */
export function readOdfDrawing(node, ctx) {
  if (node.namespaceURI !== NS.draw) return null;
  const kind = node.localName;
  const common = (o) => {
    const name = attr(node, NS.draw, 'name');
    if (name) o.name = name.slice(0, 200);
    const title = kid(node, NS.svg, 'title')?.textContent;
    const desc = kid(node, NS.svg, 'desc')?.textContent;
    if (title) o.title = title.slice(0, 200);
    if (desc) o.description = desc.slice(0, 5000);
    const drawId = attr(node, NS.draw, 'id') ?? attr(node, 'http://www.w3.org/XML/1998/namespace', 'id');
    if (drawId) o.odfId = drawId;
    return o;
  };
  if (kind === 'g') {
    const children = kids(node).map((c) => (ctx.child ? ctx.child(c) : readOdfDrawing(c, ctx))).filter(Boolean);
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    const xs = children.map((c) => c.x); const ys = children.map((c) => c.y);
    const x = Math.min(...xs); const y = Math.min(...ys);
    return common({ id: ctx.id(), kind: 'group', x, y, w: Math.max(...children.map((c) => c.x + c.w)) - x, h: Math.max(...children.map((c) => c.y + c.h)) - y, rotation: 0, children });
  }
  if (kind === 'line') {
    const p = (a) => ctx.toPx(attr(node, NS.svg, a)) ?? 0;
    const [x1, y1, x2, y2] = [p('x1'), p('y1'), p('x2'), p('y2')];
    const x = Math.min(x1, x2); const y = Math.min(y1, y2);
    return common({ id: ctx.id(), kind: 'path', x, y, w: Math.max(Math.abs(x2 - x1), 1), h: Math.max(Math.abs(y2 - y1), 1), rotation: 0, ...ctx.look(node), subpaths: [{ closed: false, nodes: [{ x: x1 - x, y: y1 - y }, { x: x2 - x, y: y2 - y }] }] });
  }
  if (kind === 'connector') {
    const p = (a) => ctx.toPx(attr(node, NS.svg, a)) ?? 0;
    const [x1, y1, x2, y2] = [p('x1'), p('y1'), p('x2'), p('y2')];
    const routing = { standard: 'standard', lines: 'lines', line: 'line', curve: 'curve' }[attr(node, NS.draw, 'type') ?? 'standard'] ?? 'standard';
    const end = (shape, glue) => (shape ? { odfId: shape, glue: num(glue, 0) } : null);
    return common({
      id: ctx.id(), kind: 'connector', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(Math.abs(x2 - x1), 1), h: Math.max(Math.abs(y2 - y1), 1), rotation: 0,
      routing, ...ctx.look(node), fromOdf: end(attr(node, NS.draw, 'start-shape'), attr(node, NS.draw, 'start-glue-point')), toOdf: end(attr(node, NS.draw, 'end-shape'), attr(node, NS.draw, 'end-glue-point')),
      ends: { x1, y1, x2, y2 },
    });
  }
  const box = ctx.box(node);
  if (!box) return null;
  if (kind === 'frame') {
    const image = kid(node, NS.draw, 'image');
    if (!image) return null;
    const resource = ctx.picture(attr(image, NS.xlink, 'href'));
    if (!resource) return null;
    return common({ id: ctx.id(), kind: 'image', ...box, resource, ...ctx.imageLook?.(node) });
  }
  if (kind === 'path' || kind === 'polygon' || kind === 'polyline' || kind === 'rect' || kind === 'ellipse' || kind === 'circle') {
    let subpaths;
    if (kind === 'rect' || kind === 'ellipse' || kind === 'circle') {
      return common({ id: ctx.id(), kind: 'shape', ...box, shape: kind === 'rect' ? (ctx.toPx(attr(node, NS.draw, 'corner-radius')) > 0 ? 'round-rectangle' : 'rectangle') : 'ellipse', ...ctx.look(node), ...(ctx.text?.(node) ?? {}) });
    }
    const vb = String(attr(node, NS.svg, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const viewBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0 ? vb : null;
    if (kind === 'path') subpaths = subpathsFromSvg(attr(node, NS.svg, 'd') ?? '', viewBox, box.w, box.h);
    else {
      const points = String(attr(node, NS.draw, 'points') ?? '').trim().split(/\s+/).slice(0, 100000).map((pair) => pair.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
      const sx = viewBox ? box.w / viewBox[2] : 1; const sy = viewBox ? box.h / viewBox[3] : 1;
      subpaths = cleanSubpaths([{ closed: kind === 'polygon', nodes: points.map(([x, y]) => ({ x: (x - (viewBox?.[0] ?? 0)) * sx, y: (y - (viewBox?.[1] ?? 0)) * sy })) }]);
    }
    if (!subpaths.length) return null;
    const look = ctx.look(node);
    if (kind === 'polyline') look.fillLook = cleanFill({ type: 'none' });
    return common({ id: ctx.id(), kind: 'path', ...box, ...look, subpaths });
  }
  if (kind === 'custom-shape') {
    const geometry = kid(node, NS.draw, 'enhanced-geometry');
    const type = attr(geometry, NS.draw, 'type') ?? '';
    const look = ctx.look(node);
    const mods = String(attr(geometry, NS.draw, 'modifiers') ?? '').trim();
    const o = { id: ctx.id(), kind: 'shape', ...box, ...look, ...(ctx.text?.(node) ?? {}) };
    const known = presetDefinition(type) && !['non-primitive', ''].includes(type) && !/^mso-spt/.test(type) ? type : null;
    if (known) {
      o.shape = known;
      if (mods) o.mods = mods.split(/\s+/).map(Number).filter(Number.isFinite).slice(0, 20);
      const own = known.startsWith('ooxml-') ? ownForOoxml(known.slice(6), o.mods) : null;
      if (own) { o.shape = own; delete o.mods; }
    } else {
      // Any other shape is drawn from the geometry the file carries, formulas and all.
      o.shape = 'custom';
      o.geometry = geometryFromFile(geometry);
      if (!o.geometry.path) return null;
      o.odfType = type.slice(0, 100);
    }
    if (attr(geometry, NS.draw, 'mirror-horizontal') === 'true' && known) o.flipH = true;
    if (attr(geometry, NS.draw, 'mirror-vertical') === 'true' && known) o.flipV = true;
    if (attr(geometry, NS.draw, 'text-path') === 'true') { o.textPath = true; }
    return common(o);
  }
  if (kind === 'caption' || kind === 'measure' || kind === 'control') ctx.losses?.add?.('Callouts, dimension lines and form controls');
  return null;
}

/** Hangs read connectors on the objects they named by draw:id, once every object of the page is read. */
export function linkConnectors(objects) {
  const byOdf = new Map(objects.filter((o) => o.odfId).map((o) => [o.odfId, o]));
  for (const o of objects) {
    if (o.kind !== 'connector') continue;
    const end = (e) => {
      const target = e && byOdf.get(e.odfId);
      if (!target) return null;
      // ODF numbers the four default points first; a shape's own points follow from four.
      const glue = gluePoints(target);
      const index = e.glue >= 4 ? e.glue - 4 : e.glue;
      return { id: target.id, glue: Math.min(Math.max(index, 0), Math.max(glue.length - 1, 0)) };
    };
    o.from = end(o.fromOdf);
    o.to = end(o.toOdf);
    delete o.fromOdf;
    delete o.toOdf;
    delete o.ends;
  }
  for (const o of objects) delete o.odfId;
  return objects;
}

// Writing

/**
 * The graphic properties of a drawing object, with the named styles they need put in office:styles.
 * @param {Object} o
 * @param {{len: (px) => string, named: (kind, name, xml) => void}} ctx
 */
export function graphicProperties(o, ctx, defaults = {}) {
  const line = cleanLine({ ...defaults.line, ...o.line });
  const fill = cleanFill({ ...defaults.fill, ...o.fillLook });
  const props = {};
  if (line.style === 'none' || line.width === 0) props['draw:stroke'] = 'none';
  else {
    props['draw:stroke'] = line.style === 'solid' ? 'solid' : 'dash';
    props['svg:stroke-color'] = line.color;
    props['svg:stroke-width'] = ctx.len(line.width);
    if (line.transparency) props['svg:stroke-opacity'] = `${100 - line.transparency}%`;
    if (line.style !== 'solid') {
      const name = { dash: 'Dash', dot: 'Dot', 'dash-dot': 'Dash Dot', 'long-dash': 'Long Dash' }[line.style];
      const [dots1, dots2] = { dash: [[1, '300%'], [0, null]], dot: [[1, '100%'], [0, null]], 'dash-dot': [[1, '300%'], [1, '100%']], 'long-dash': [[1, '600%'], [0, null]] }[line.style];
      ctx.named('stroke-dash', name, tag('draw:stroke-dash', { 'draw:name': name.replace(/ /g, '_20_'), 'draw:display-name': name, 'draw:style': 'rect', 'draw:dots1': String(dots1[0]), 'draw:dots1-length': dots1[1], 'draw:dots2': dots2[0] ? String(dots2[0]) : null, 'draw:dots2-length': dots2[1], 'draw:distance': '200%' }));
      props['draw:stroke-dash'] = name.replace(/ /g, '_20_');
    }
    for (const side of ['start', 'end']) {
      if (line[side] === 'none') continue;
      const name = MARKER_NAMES[line[side]];
      const [box, d] = MARKER_PATHS[name];
      ctx.named('marker', name, tag('draw:marker', { 'draw:name': name.replace(/ /g, '_20_'), 'draw:display-name': name, 'svg:viewBox': box, 'svg:d': d }));
      props[`draw:marker-${side}`] = name.replace(/ /g, '_20_');
      props[`draw:marker-${side}-width`] = ctx.len(Math.max(line.width * 3.5, 8));
    }
  }
  props['draw:fill'] = fill.type;
  if (fill.type !== 'none') props['draw:fill-color'] = fill.color;
  if (fill.type === 'gradient') {
    const name = `Gradient_${fill.color.slice(1)}_${fill.color2.slice(1)}_${Math.round(fill.angle)}_${fill.shape}`;
    ctx.named('gradient', name, tag('draw:gradient', { 'draw:name': name, 'draw:style': fill.shape === 'radial' ? 'radial' : 'linear', 'draw:start-color': fill.color, 'draw:end-color': fill.color2, 'draw:start-intensity': '100%', 'draw:end-intensity': '100%', 'draw:angle': `${Math.round(fill.angle)}deg`, 'draw:border': '0%' }));
    props['draw:fill-gradient-name'] = name;
  }
  if (fill.type === 'hatch') {
    const name = `Hatch_${fill.color.slice(1)}_${Math.round(fill.angle)}`;
    ctx.named('hatch', name, tag('draw:hatch', { 'draw:name': name, 'draw:style': 'single', 'draw:color': fill.color, 'draw:distance': ctx.len(fill.spacing), 'draw:rotation': `${Math.round(fill.angle)}deg` }));
    props['draw:fill-hatch-name'] = name;
  }
  if (fill.transparency) props['draw:opacity'] = `${100 - fill.transparency}%`;
  props['draw:shadow'] = o.shadow ? 'visible' : 'hidden';
  if (o.shadow) Object.assign(props, { 'draw:shadow-offset-x': ctx.len(3), 'draw:shadow-offset-y': ctx.len(3), 'draw:shadow-color': '#000000', 'draw:shadow-opacity': '35%' });
  if (o.kind === 'image' && o.adjust) {
    const a = o.adjust;
    Object.assign(props, {
      'draw:luminance': `${a.brightness}%`, 'draw:contrast': `${a.contrast}%`, 'draw:red': `${a.red}%`, 'draw:green': `${a.green}%`, 'draw:blue': `${a.blue}%`,
      'draw:gamma': `${Math.round(a.gamma * 100)}%`, 'draw:image-opacity': `${100 - a.transparency}%`,
      'draw:color-mode': { standard: 'standard', grey: 'greyscale', mono: 'mono', watermark: 'watermark' }[a.mode],
    });
  }
  if (o.kind === 'image' && o.crop && o.natural) {
    // fo:clip in lengths of the picture at its own size: top, right, bottom, left.
    const c = o.crop;
    props['fo:clip'] = `rect(${ctx.len(c.t * o.natural.h)}, ${ctx.len(c.r * o.natural.w)}, ${ctx.len(c.b * o.natural.h)}, ${ctx.len(c.l * o.natural.w)})`;
  }
  if (o.textLook) {
    props['draw:textarea-vertical-align'] = o.textLook.anchor ?? 'middle';
    if (o.textLook.grow) props['draw:auto-grow-height'] = 'true';
    if (o.textLook.wrap === false) props['fo:wrap-option'] = 'no-wrap';
    if (Number.isFinite(o.textLook.padding)) for (const side of ['left', 'right', 'top', 'bottom']) props[`fo:padding-${side}`] = ctx.len(o.textLook.padding);
  }
  return props;
}

/** Image look from a frame's graphic properties. */
export function imageLookFromProperties(props, natural) {
  const out = {};
  const p = (k, d = 0) => num(String(props[k] ?? d).replace('%', ''), d);
  if (['luminance', 'contrast', 'red', 'green', 'blue', 'gamma', 'image-opacity', 'color-mode'].some((k) => props[k] !== undefined)) {
    out.adjust = {
      brightness: p('luminance'), contrast: p('contrast'), red: p('red'), green: p('green'), blue: p('blue'),
      gamma: p('gamma', 100) / 100, transparency: 100 - p('image-opacity', 100),
      mode: { greyscale: 'grey', mono: 'mono', watermark: 'watermark' }[props['color-mode']] ?? 'standard',
    };
  }
  return out;
}

/**
 * One drawing object as ODF.
 * @param {Object} o
 * @param {{style: (props) => string, placement: (o) => Object, len: (px) => string, picture: (resource) => ?string, text?: (o) => any, odfId: (id) => string, objects?: Object[]}} ctx
 */
export function writeOdfDrawing(o, ctx) {
  const named = (attrs) => ({
    'draw:name': o.name ?? null, ...attrs,
  });
  const titled = () => [o.title ? tag('svg:title', {}, o.title) : null, o.description ? tag('svg:desc', {}, o.description) : null];
  // A 3D object goes as the drawing of its faces; ODF's own 3D scenes come with the rest of Draw's 3D.
  if (o.kind === 'scene3d') return writeOdfDrawing(sceneAsGroup(o), ctx);
  const id = ctx.odfId(o.id);
  if (o.kind === 'group') {
    return tag('draw:g', named({ 'draw:id': id, 'xml:id': id }), titled(), (o.children ?? []).map((c) => writeOdfDrawing(c, ctx)));
  }
  if (o.kind === 'connector') {
    const pts = ctx.connectorPoints?.(o) ?? [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }];
    const a = pts[0]; const b = pts[pts.length - 1];
    const end = (e) => (e ? { shape: ctx.odfId(e.id), glue: String(e.glue + 4) } : null);
    const from = end(o.from); const to = end(o.to);
    return tag('draw:connector', named({
      'draw:style-name': ctx.style(o), 'draw:type': o.routing === 'line' ? 'line' : o.routing === 'curve' ? 'curve' : o.routing === 'lines' ? 'lines' : 'standard',
      'svg:x1': ctx.len(a.x), 'svg:y1': ctx.len(a.y), 'svg:x2': ctx.len(b.x), 'svg:y2': ctx.len(b.y),
      'draw:start-shape': from?.shape ?? null, 'draw:start-glue-point': from?.glue ?? null, 'draw:end-shape': to?.shape ?? null, 'draw:end-glue-point': to?.glue ?? null,
    }), titled());
  }
  if (o.kind === 'image') {
    const href = ctx.picture(o.resource);
    if (!href) return null;
    return tag('draw:frame', named({ 'draw:style-name': ctx.style(o), ...ctx.placement(o), 'draw:id': id, 'xml:id': id }),
      tag('draw:image', { 'xlink:href': href, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad' }), titled());
  }
  if (o.kind === 'path') {
    // Flips are drawn into the nodes, which every reader then sees the same way.
    const w = Math.max(o.w, 0.01); const h = Math.max(o.h, 0.01);
    const turn = (p) => (p ? { x: o.flipH ? w - p.x : p.x, y: o.flipV ? h - p.y : p.y } : undefined);
    const scale = 100;
    const d = (o.subpaths ?? []).map((s) => {
      const pt = (p) => `${Math.round(turn(p).x * scale)} ${Math.round(turn(p).y * scale)}`;
      let out = `M${pt(s.nodes[0])}`;
      const pieces = s.closed ? s.nodes.length : s.nodes.length - 1;
      for (let i = 0; i < pieces; i += 1) {
        const a = s.nodes[i]; const b = s.nodes[(i + 1) % s.nodes.length];
        out += a.out || b.in ? `C${pt(a.out ?? a)} ${pt(b.in ?? b)} ${pt(b)}` : `L${pt(b)}`;
      }
      return s.closed ? `${out}Z` : out;
    }).join('');
    return tag('draw:path', named({ 'draw:style-name': ctx.style(o), ...ctx.placement(o), 'svg:viewBox': `0 0 ${Math.round(w * scale)} ${Math.round(h * scale)}`, 'svg:d': d, 'draw:id': id, 'xml:id': id }), titled(), ctx.text?.(o));
  }
  if (o.kind === 'shape') {
    const definition = o.shape === 'custom' ? o.geometry : presetDefinition(o.shape);
    if (!definition) return null;
    const type = o.shape === 'custom' ? (o.odfType || 'non-primitive') : odfType(o.shape);
    const ooxml = type.startsWith('ooxml-');
    const geometryAttrs = {
      'svg:viewBox': definition.box ? definition.box.join(' ') : '0 0 0 0',
      'draw:type': type,
      'draw:modifiers': (o.mods ?? definition.mod ?? []).length ? (o.mods ?? definition.mod).join(' ') : null,
      'draw:mirror-horizontal': o.flipH ? 'true' : null,
      'draw:mirror-vertical': o.flipV ? 'true' : null,
      'draw:text-areas': definition.text ?? null,
      'draw:glue-points': definition.glue ?? null,
      'draw:path-stretchpoint-x': definition.stretch?.[0] ?? null,
      'draw:path-stretchpoint-y': definition.stretch?.[1] ?? null,
      'draw:text-path': o.textPath ? 'true' : null,
      'draw:text-path-mode': o.textPath ? 'shape' : null,
    };
    if (ooxml) {
      // OOXML presets speak arcs ODF 1.3 has no word for: LibreOffice's extension carries them, and a plain outline goes beside it.
      const g = shapeGeometry(definition, o.w, o.h, o.mods);
      geometryAttrs['drawooo:enhanced-path'] = definition.path;
      if (definition.sub) geometryAttrs['drawooo:sub-view-size'] = definition.sub.join(' ');
      geometryAttrs['draw:enhanced-path'] = staticPath(g.paths);
      geometryAttrs['svg:viewBox'] = `0 0 ${Math.round(o.w * 100)} ${Math.round(o.h * 100)}`;
    } else {
      geometryAttrs['draw:enhanced-path'] = definition.path;
    }
    const handles = (definition.handles ?? []).map((h) => tag('draw:handle', Object.fromEntries(Object.entries(h).map(([k, v]) => [`draw:handle-${k}`, v]))));
    const equations = (definition.eq ?? []).map((formula, i) => tag('draw:equation', { 'draw:name': `f${i}`, 'draw:formula': formula }));
    return tag('draw:custom-shape', named({ 'draw:style-name': ctx.style(o), ...ctx.placement(o), 'draw:id': id, 'xml:id': id }), titled(), ctx.text?.(o),
      tag('draw:enhanced-geometry', geometryAttrs, ooxml ? [] : [...equations, ...handles]));
  }
  return null;
}

/** An outline in plain numbers, scaled by a hundred, for readers that do not know LibreOffice's extension. */
function staticPath(paths) {
  return paths.map((p) => {
    const d = pathData(p.segments).replace(/([MLC])/g, ' $1 ').replace(/Z/g, ' Z ').replace(/(-?\d+(\.\d+)?)/g, (n) => String(Math.round(Number(n) * 100)));
    return `${d}${p.fill ? '' : ' F'}${p.stroke ? '' : ' S'} N`;
  }).join(' ').replace(/\s+/g, ' ').trim();
}

export { markerKind, MARKER_NAMES, DRAWOOO };
