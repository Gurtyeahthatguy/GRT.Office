/** A drawing object as SVG, drawn in its own box; the program places the box and turns it. */

import { presetDefinition, shapeGeometry, pathData } from './geometry.js';
import { subpathsData, gluePoints, toLocal, toPage as toPageImported, cleanLine, cleanFill } from './objects.js';
import { sceneSvg, projectedFaces } from './three.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (v) => Math.round(v * 100) / 100;
const safeId = (id) => String(id ?? 'x').replace(/[^\w-]/g, '_');

/** A colour mixed toward black or white, for the darker and lighter parts some shapes have. */
function shade(colour, how) {
  if (!how || !/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  const amount = { darken: -0.4, darkenless: -0.2, lighten: 0.4, lightenless: 0.2 }[how] ?? 0;
  const c = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
  const out = c.map((v) => Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function dashArray(line) {
  const w = Math.max(line.width, 1);
  return {
    dash: `${f(w * 4)} ${f(w * 3)}`,
    dot: `${f(w)} ${f(w * 2)}`,
    'dash-dot': `${f(w * 4)} ${f(w * 2)} ${f(w)} ${f(w * 2)}`,
    'long-dash': `${f(w * 8)} ${f(w * 4)}`,
  }[line.style] ?? null;
}

/** Arrow heads as SVG markers, sized by the line width as LibreOffice's are. */
function marker(id, kind, colour) {
  const shapes = {
    arrow: '<path d="M0 0L10 5L0 10z"/>',
    'arrow-short': '<path d="M0 1L8 5L0 9z"/>',
    triangle: '<path d="M0 0L10 5L0 10z"/>',
    concave: '<path d="M0 0L10 5L0 10L3 5z"/>',
    circle: '<circle cx="5" cy="5" r="5"/>',
    square: '<rect width="10" height="10"/>',
    diamond: '<path d="M5 0L10 5L5 10L0 5z"/>',
    dimension: '<path d="M4.5 0h1v10h-1z"/>',
    line: '<path d="M4.5 0h1v10h-1z"/>',
  };
  if (!shapes[kind]) return '';
  return `<marker id="${id}" viewBox="0 0 10 10" refX="${kind === 'circle' || kind === 'square' || kind === 'diamond' || kind === 'line' || kind === 'dimension' ? 5 : 9}" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse" fill="${esc(colour)}">${shapes[kind]}</marker>`;
}

/**
 * The paint and stroke attributes for an object, with any definitions they need.
 * @returns {{defs: string, fill: (shadeName?: string) => string, stroke: string, markers: string}}
 */
function paint(o, key, defaults = {}) {
  const line = cleanLine({ ...defaults.line, ...o.line });
  const fill = cleanFill({ ...defaults.fill, ...o.fillLook });
  let defs = '';
  let fillRef = (how) => (fill.type === 'none' ? 'none' : esc(shade(fill.color, how)));
  const opacity = fill.transparency ? ` fill-opacity="${f(1 - fill.transparency / 100)}"` : '';
  if (fill.type === 'gradient') {
    const id = `g-${key}`;
    defs += fill.shape === 'radial'
      ? `<radialGradient id="${id}"><stop offset="0" stop-color="${esc(fill.color)}"/><stop offset="1" stop-color="${esc(fill.color2)}"/></radialGradient>`
      : `<linearGradient id="${id}" gradientTransform="rotate(${f(-fill.angle + 90)} .5 .5)"><stop offset="0" stop-color="${esc(fill.color)}"/><stop offset="1" stop-color="${esc(fill.color2)}"/></linearGradient>`;
    fillRef = () => `url(#${id})`;
  } else if (fill.type === 'hatch') {
    const id = `h-${key}`;
    defs += `<pattern id="${id}" width="${f(fill.spacing)}" height="${f(fill.spacing)}" patternUnits="userSpaceOnUse" patternTransform="rotate(${f(fill.angle)})"><line x1="0" y1="0" x2="0" y2="${f(fill.spacing)}" stroke="${esc(fill.color)}" stroke-width="1"/></pattern>`;
    fillRef = () => `url(#${id})`;
  }
  let markers = '';
  if (line.start !== 'none') { defs += marker(`ms-${key}`, line.start, line.color); markers += ` marker-start="url(#ms-${key})"`; }
  if (line.end !== 'none') { defs += marker(`me-${key}`, line.end, line.color); markers += ` marker-end="url(#me-${key})"`; }
  const dash = dashArray(line);
  const stroke = line.style === 'none' || line.width === 0
    ? 'stroke="none"'
    : `stroke="${esc(line.color)}" stroke-width="${f(line.width)}"${dash ? ` stroke-dasharray="${dash}"` : ''}${line.transparency ? ` stroke-opacity="${f(1 - line.transparency / 100)}"` : ''} stroke-linejoin="round"`;
  return { defs, fill: (how) => `fill="${fillRef(how)}"${opacity}`, stroke, markers };
}

/** An SVG filter for an image's colour settings. */
function imageFilter(id, adjust) {
  if (!adjust) return '';
  const parts = [];
  const b = adjust.brightness / 100;
  const c = 1 + adjust.contrast / 100;
  const channel = (extra) => {
    const slope = c;
    const intercept = (1 - c) / 2 + b + extra / 100;
    return `type="linear" slope="${f(slope)}" intercept="${f(intercept)}"`;
  };
  if (adjust.mode === 'grey' || adjust.mode === 'mono') parts.push('<feColorMatrix type="saturate" values="0"/>');
  parts.push(`<feComponentTransfer><feFuncR ${channel(adjust.red)}/><feFuncG ${channel(adjust.green)}/><feFuncB ${channel(adjust.blue)}/>${adjust.transparency ? `<feFuncA type="linear" slope="${f(1 - adjust.transparency / 100)}"/>` : ''}</feComponentTransfer>`);
  if (adjust.gamma !== 1) parts.push(`<feComponentTransfer><feFuncR type="gamma" exponent="${f(1 / adjust.gamma)}"/><feFuncG type="gamma" exponent="${f(1 / adjust.gamma)}"/><feFuncB type="gamma" exponent="${f(1 / adjust.gamma)}"/></feComponentTransfer>`);
  if (adjust.mode === 'mono') parts.push('<feComponentTransfer><feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/></feComponentTransfer>');
  if (adjust.mode === 'watermark') parts.push('<feComponentTransfer><feFuncR type="linear" slope=".3" intercept=".7"/><feFuncG type="linear" slope=".3" intercept=".7"/><feFuncB type="linear" slope=".3" intercept=".7"/></feComponentTransfer>');
  return `<filter id="${id}" color-interpolation-filters="sRGB">${parts.join('')}</filter>`;
}

/** The points a connector runs through, in page coordinates, from the glue points it hangs on. */
export function connectorPoints(o, objects) {
  const end = (e, fallback) => {
    const other = e && objects.find((x) => x.id === e.id);
    if (!other) return fallback;
    const glue = gluePoints(other);
    return glue[e.glue] ?? glue[0] ?? fallback;
  };
  const a = end(o.from, { x: o.x, y: o.y });
  const b = end(o.to, { x: o.x + o.w, y: o.y + o.h });
  if (o.routing === 'line' || o.routing === 'curve') return [a, b];
  // Standard: out horizontally, across, in horizontally, as LibreOffice's standard connector does by default.
  const mid = (a.x + b.x) / 2;
  if (o.routing === 'lines') return [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
  return [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
}

/** Moves a connector's box to its points, so it is selected and saved where it is drawn. */
export function fitConnector(o, objects) {
  const points = connectorPoints(o, objects);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  o.x = Math.min(...xs);
  o.y = Math.min(...ys);
  o.w = Math.max(Math.max(...xs) - o.x, 1);
  o.h = Math.max(Math.max(...ys) - o.y, 1);
  o.rotation = 0;
}

/**
 * The SVG for one object, drawn in a w by h box from (0, 0).
 * @param {Object} o
 * @param {{objects?: Object[], image?: (o) => ?string, text?: string, idPrefix?: string, defaults?: Object}} options
 * @returns {string}
 */
export function drawingSvg(o, options = {}) {
  const key = `${options.idPrefix ?? 'd'}-${safeId(o.id)}`;
  const body = drawingBody(o, key, options);
  const flipped = o.flipH || o.flipV
    ? `<g transform="translate(${o.flipH ? f(o.w) : 0} ${o.flipV ? f(o.h) : 0}) scale(${o.flipH ? -1 : 1} ${o.flipV ? -1 : 1})">${body.content}</g>`
    : body.content;
  const shadow = o.shadow ? `<filter id="sh-${key}"><feDropShadow dx="3" dy="3" stdDeviation="1" flood-opacity=".35"/></filter>` : '';
  const label = o.description || o.name ? `<title>${esc(o.name || '')}${o.name && o.description ? ': ' : ''}${esc(o.description || '')}</title>` : '';
  return `<svg${options.standalone ? ' xmlns="http://www.w3.org/2000/svg"' : ''} width="${f(Math.max(o.w, 0.01))}" height="${f(Math.max(o.h, 0.01))}" viewBox="0 0 ${f(Math.max(o.w, 0.01))} ${f(Math.max(o.h, 0.01))}" overflow="visible" style="overflow:visible;display:block">${label}<defs>${body.defs}${shadow}</defs>`
    + `${shadow ? `<g filter="url(#sh-${key})">${flipped}</g>` : flipped}</svg>`;
}

function drawingBody(o, key, options) {
  const defaults = options.defaults ?? {};
  if (o.kind === 'shape') {
    const definition = o.shape === 'custom' ? o.geometry : presetDefinition(o.shape);
    if (!definition) return { defs: '', content: '' };
    const p = paint(o, key, defaults);
    const g = shapeGeometry(definition, o.w, o.h, o.mods);
    let content = g.paths.map((path) => `<path d="${pathData(path.segments)}" fill-rule="evenodd" ${path.fill ? p.fill(path.shade) : 'fill="none"'} ${path.stroke ? p.stroke : 'stroke="none"'}/>`).join('');
    if (o.textPath && options.text) {
      const first = g.paths[0];
      if (first) {
        const pid = `tp-${key}`;
        p.defs += `<path id="${pid}" d="${pathData(first.segments)}"/>`;
        content = `<text font-size="${f(Math.max(8, o.h / 6))}" fill="${esc(cleanLine({ ...defaults.line, ...o.line }).color)}"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(options.text)}</textPath></text>`;
      }
    }
    return { defs: p.defs, content };
  }
  if (o.kind === 'path') {
    const p = paint(o, key, defaults);
    const closed = (o.subpaths ?? []).some((s) => s.closed);
    return { defs: p.defs, content: `<path d="${subpathsData(o.subpaths ?? [])}" fill-rule="evenodd" ${closed ? p.fill() : 'fill="none"'} ${p.stroke}${closed ? '' : p.markers}/>` };
  }
  if (o.kind === 'line') {
    const p = paint(o, key, { ...defaults, line: { ...defaults.line, color: o.fill ?? defaults.line?.color, width: o.thickness ?? defaults.line?.width, end: o.arrow ? 'arrow' : defaults.line?.end } });
    const [x1, y1, x2, y2] = o.direction === 'up' ? [0, o.h, o.w, 0] : [0, 0, o.w, o.h];
    return { defs: p.defs, content: `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${p.stroke}${p.markers}/>` };
  }
  if (o.kind === 'connector') {
    const p = paint(o, key, defaults);
    const points = connectorPoints(o, options.objects ?? []).map((q) => ({ x: q.x - o.x, y: q.y - o.y }));
    let d;
    if (o.routing === 'curve' && points.length === 2) {
      const [a, b] = points;
      const grip = Math.max(Math.abs(b.x - a.x) / 2, 20);
      d = `M${f(a.x)} ${f(a.y)}C${f(a.x + grip)} ${f(a.y)} ${f(b.x - grip)} ${f(b.y)} ${f(b.x)} ${f(b.y)}`;
    } else d = points.map((q, i) => `${i ? 'L' : 'M'}${f(q.x)} ${f(q.y)}`).join('');
    return { defs: p.defs, content: `<path d="${d}" fill="none" ${p.stroke}${p.markers}/>` };
  }
  if (o.kind === 'image') {
    const href = options.image?.(o);
    if (!href) return { defs: '', content: `<rect width="${f(o.w)}" height="${f(o.h)}" fill="#eeeeee" stroke="#999999" stroke-dasharray="4 3"/>` };
    const crop = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
    const sw = Math.max(1 - crop.l - crop.r, 0.05);
    const sh = Math.max(1 - crop.t - crop.b, 0.05);
    const fullW = o.w / sw;
    const fullH = o.h / sh;
    const filter = imageFilter(`f-${key}`, o.adjust);
    const p = o.line ? paint(o, key, { fill: { type: 'none' } }) : null;
    return {
      defs: `${filter}<clipPath id="c-${key}"><rect width="${f(o.w)}" height="${f(o.h)}"/></clipPath>${p?.defs ?? ''}`,
      content: `<g clip-path="url(#c-${key})"><image href="${esc(href)}" x="${f(-crop.l * fullW)}" y="${f(-crop.t * fullH)}" width="${f(fullW)}" height="${f(fullH)}" preserveAspectRatio="none"${filter ? ` filter="url(#f-${key})"` : ''}/></g>`
        + (p ? `<rect width="${f(o.w)}" height="${f(o.h)}" fill="none" ${p.stroke}/>` : ''),
    };
  }
  if (o.kind === 'group') {
    const parts = [...(o.children ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((c) => {
      const inner = drawingBody(c, `${key}-${safeId(c.id)}`, { ...options, objects: o.children });
      const cx = c.x - o.x + c.w / 2;
      const cy = c.y - o.y + c.h / 2;
      const turn = c.rotation ? ` rotate(${f(c.rotation)} ${f(c.w / 2)} ${f(c.h / 2)})` : '';
      const mirror = c.flipH || c.flipV ? ` translate(${c.flipH ? f(c.w) : 0} ${c.flipV ? f(c.h) : 0}) scale(${c.flipH ? -1 : 1} ${c.flipV ? -1 : 1})` : '';
      return { defs: inner.defs, content: `<g transform="translate(${f(cx - c.w / 2)} ${f(cy - c.h / 2)})${turn}${mirror}">${inner.content}</g>` };
    });
    return { defs: parts.map((p) => p.defs).join(''), content: parts.map((p) => p.content).join('') };
  }
  if (o.kind === 'scene3d') return { defs: '', content: sceneSvg(o) };
  // Kinds the program draws itself, such as charts, formulas and text boxes.
  return options.custom?.(o) ?? { defs: '', content: '' };
}

/** Whether a page point falls on an object, its stroke counted with some room. */
export function hitObject(o, point, room = 6) {
  const local = toLocal(o, point);
  return local.x >= -room && local.y >= -room && local.x <= o.w + room && local.y <= o.h + room;
}

/**
 * An object's outlines on the page, rotation and flips applied, for PDF and print: one entry per path drawn.
 * @returns {{d: string, fill: ?string, stroke: ?string, strokeWidth: number, dash: ?string}[]}
 */
export function pagePaths(o, objects = [], defaults = {}) {
  const out = [];
  const line = cleanLine({ ...defaults.line, ...o.line });
  const fill = cleanFill({ ...defaults.fill, ...o.fillLook });
  const strokeOf = () => (line.style === 'none' || line.width === 0 ? null : line.color);
  const fillOf = (how) => (fill.type === 'none' ? null : shade(fill.color, how));
  const f2 = (v) => Math.round(v * 100) / 100;
  const at = (p) => { const q = toPageFn(o, p); return `${f2(q.x)} ${f2(q.y)}`; };
  const fromSegments = (segments) => segments.map((s) => (s.type === 'M' || s.type === 'L' ? `${s.type}${at(s.to)}` : s.type === 'C' ? `C${at(s.c1)} ${at(s.c2)} ${at(s.to)}` : 'Z')).join('');
  if (o.kind === 'group') {
    for (const c of o.children ?? []) out.push(...pagePaths(c, o.children, defaults));
    return out;
  }
  if (o.kind === 'shape') {
    const definition = o.shape === 'custom' ? o.geometry : presetDefinition(o.shape);
    if (!definition) return out;
    for (const path of shapeGeometry(definition, o.w, o.h, o.mods).paths) {
      out.push({ d: fromSegments(path.segments), fill: path.fill ? fillOf(path.shade) : null, stroke: path.stroke ? strokeOf() : null, strokeWidth: line.width, dash: dashArray(line) });
    }
    return out;
  }
  if (o.kind === 'path') {
    const closed = (o.subpaths ?? []).some((s) => s.closed);
    const segments = [];
    for (const s of o.subpaths ?? []) {
      segments.push({ type: 'M', to: s.nodes[0] });
      const pieces = s.closed ? s.nodes.length : s.nodes.length - 1;
      for (let i = 0; i < pieces; i += 1) {
        const a = s.nodes[i]; const b = s.nodes[(i + 1) % s.nodes.length];
        segments.push(a.out || b.in ? { type: 'C', c1: a.out ?? a, c2: b.in ?? b, to: b } : { type: 'L', to: b });
      }
      if (s.closed) segments.push({ type: 'Z' });
    }
    out.push({ d: fromSegments(segments), fill: closed ? fillOf() : null, stroke: strokeOf(), strokeWidth: line.width, dash: dashArray(line) });
    return out;
  }
  if (o.kind === 'scene3d') {
    for (const face of projectedFaces(o)) out.push({ d: `M${face.points.map((p) => at({ x: p[0], y: p[1] })).join('L')}Z`, fill: face.fill, stroke: null, strokeWidth: 0, dash: null });
    return out;
  }
  if (o.kind === 'connector') {
    const points = connectorPoints(o, objects);
    out.push({ d: points.map((p, i) => `${i ? 'L' : 'M'}${f2(p.x)} ${f2(p.y)}`).join(''), fill: null, stroke: strokeOf(), strokeWidth: line.width, dash: dashArray(line) });
  }
  return out;
}

const toPageFn = (o, p) => toPageImported(o, p);
