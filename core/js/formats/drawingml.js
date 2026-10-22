/** DrawingML, the drawing language of Office files: colours, themes and transforms. */

import { NS, kids, kid, attr } from '../xml.js';
import { ellipseCurves, normalisePath } from '../paths.js';

const A = NS.a;

const SCHEME_NAMES = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

// A few named system and preset colours files use.
const PRESET = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00',
  gray: '808080', grey: '808080', darkGray: 'a9a9a9', lightGray: 'd3d3d3', orange: 'ffa500', purple: '800080',
  windowText: '000000', window: 'ffffff', btnFace: 'f0f0f0', highlight: '0078d7', menuText: '000000',
};

/** A theme's colours by scheme name, and its two fonts. */
export function readDrawingTheme(doc) {
  const colors = {};
  const root = doc?.documentElement;
  const elements = root ? [...root.getElementsByTagNameNS(A, 'clrScheme')] : [];
  for (const name of SCHEME_NAMES) {
    const holder = elements[0] ? kid(elements[0], A, name) : null;
    const value = holder ? kid(holder, A, 'srgbClr') ?? kid(holder, A, 'sysClr') : null;
    if (!value) continue;
    colors[name] = (value.localName === 'sysClr' ? value.getAttribute('lastClr') ?? PRESET[value.getAttribute('val')] : value.getAttribute('val'))?.toLowerCase();
  }
  const font = (which) => {
    const element = root ? root.getElementsByTagNameNS(A, which)[0] : null;
    return kid(element, A, 'latin')?.getAttribute('typeface') ?? null;
  };
  return { colors, major: font('majorFont'), minor: font('minorFont') };
}

/** How a master maps bg1, tx1 and the rest onto scheme names. */
export function readColorMap(element) {
  const map = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
  for (const attribute of element?.attributes ?? []) map[attribute.localName] = attribute.value;
  return map;
}

function hexToRgb(hex) {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function rgbToHex(rgb) {
  return rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
  h /= 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/** A colour with its modifiers applied: lumMod, lumOff, tint, shade, satMod. */
function modified(hex, element) {
  let rgb = hexToRgb(hex);
  for (const change of kids(element, A)) {
    const value = Number(change.getAttribute('val')) / 100000;
    if (!Number.isFinite(value)) continue;
    if (change.localName === 'tint') rgb = rgb.map((c) => c * value + (1 - value));
    else if (change.localName === 'shade') rgb = rgb.map((c) => c * value);
    else if (['lumMod', 'lumOff', 'satMod'].includes(change.localName)) {
      const hsl = rgbToHsl(rgb);
      if (change.localName === 'lumMod') hsl[2] *= value;
      else if (change.localName === 'lumOff') hsl[2] += value;
      else hsl[1] *= value;
      hsl[1] = Math.min(1, Math.max(0, hsl[1]));
      hsl[2] = Math.min(1, Math.max(0, hsl[2]));
      rgb = hslToRgb(hsl);
    }
  }
  return rgbToHex(rgb);
}

/**
 * The colour an element holding one of DrawingML's colour choices names, as #rrggbb.
 * @param {Element} holder a:solidFill, a:fgClr, a:fontRef or anything holding a colour
 * @param {{colors: object}} theme
 * @param {object} colorMap from readColorMap
 * @param {?string} placeholder the colour phClr stands for
 */
export function colorOf(holder, theme, colorMap, placeholder = null) {
  if (!holder) return null;
  for (const child of kids(holder, A)) {
    let hex = null;
    if (child.localName === 'srgbClr') hex = child.getAttribute('val');
    else if (child.localName === 'sysClr') hex = child.getAttribute('lastClr') ?? PRESET[child.getAttribute('val')];
    else if (child.localName === 'prstClr') hex = PRESET[child.getAttribute('val')];
    else if (child.localName === 'schemeClr') {
      const name = child.getAttribute('val');
      if (name === 'phClr') hex = placeholder?.replace('#', '') ?? null;
      else hex = theme.colors[colorMap[name] ?? name] ?? null;
    } else if (child.localName === 'scrgbClr') {
      hex = rgbToHex(['r', 'g', 'b'].map((c) => Number(child.getAttribute(c)) / 100000));
    } else if (child.localName === 'hslClr') {
      hex = rgbToHex(hslToRgb([Number(child.getAttribute('hue')) / 21600000, Number(child.getAttribute('sat')) / 100000, Number(child.getAttribute('lum')) / 100000]));
    } else {
      continue;
    }
    if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return `#${modified(hex.toLowerCase(), child)}`;
  }
  return null;
}

/** Whether a colour holder says the colour is fully transparent. */
export function isTransparent(holder) {
  const alpha = holder?.getElementsByTagNameNS(A, 'alpha')[0];
  return alpha ? Number(alpha.getAttribute('val')) === 0 : false;
}

/** EMU, DrawingML's unit: 914400 to the inch, so 9525 to a CSS pixel. */
export const EMU_PER_PX = 9525;
export const toPx = (emu) => Number(emu ?? 0) / EMU_PER_PX;

/** A shape's box from its a:xfrm, in its parent's coordinates. */
export function readXfrm(xfrm) {
  if (!xfrm) return null;
  const off = kid(xfrm, A, 'off');
  const ext = kid(xfrm, A, 'ext');
  if (!off || !ext) return null;
  return {
    x: toPx(off.getAttribute('x')),
    y: toPx(off.getAttribute('y')),
    w: toPx(ext.getAttribute('cx')),
    h: toPx(ext.getAttribute('cy')),
    rotation: Number(xfrm.getAttribute('rot') ?? 0) / 60000,
    flipH: ['1', 'true'].includes(xfrm.getAttribute('flipH')),
    flipV: ['1', 'true'].includes(xfrm.getAttribute('flipV')),
  };
}

/** How a group places its children: a function from child coordinates to the group's parent's. */
export function groupTransform(xfrm, outer = (box) => box) {
  const off = kid(xfrm, A, 'off');
  const ext = kid(xfrm, A, 'ext');
  const chOff = kid(xfrm, A, 'chOff');
  const chExt = kid(xfrm, A, 'chExt');
  if (!off || !ext || !chOff || !chExt) return outer;
  const ox = toPx(off.getAttribute('x'));
  const oy = toPx(off.getAttribute('y'));
  const cx = toPx(chOff.getAttribute('x'));
  const cy = toPx(chOff.getAttribute('y'));
  const sx = Number(chExt.getAttribute('cx')) > 0 ? Number(ext.getAttribute('cx')) / Number(chExt.getAttribute('cx')) : 1;
  const sy = Number(chExt.getAttribute('cy')) > 0 ? Number(ext.getAttribute('cy')) / Number(chExt.getAttribute('cy')) : 1;
  return (box) => outer({ ...box, x: ox + (box.x - cx) * sx, y: oy + (box.y - cy) * sy, w: box.w * sx, h: box.h * sy });
}

/** The first child that is not markup-compatibility wrapping: mc:AlternateContent gives its fallback. */
export function unwrap(element) {
  if (element?.namespaceURI !== NS.mc || element.localName !== 'AlternateContent') return [element];
  const fallback = kid(element, NS.mc, 'Fallback') ?? kid(element, NS.mc, 'Choice');
  return fallback ? kids(fallback) : [];
}

export { attr };

// Freeform geometry

const ANGLE = 60000;

/** The guides every shape's formulas may use, for a shape of a size. */
function builtInGuides(w, h) {
  const ss = Math.min(w, h);
  const guides = {
    w, h, l: 0, t: 0, r: w, b: h, hc: w / 2, vc: h / 2, ss, ls: Math.max(w, h),
    cd2: 10800000, cd4: 5400000, cd8: 2700000, '3cd4': 16200000, '3cd8': 8100000, '5cd8': 13500000, '7cd8': 18900000,
  };
  for (const n of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
    guides[`wd${n}`] = w / n;
    guides[`hd${n}`] = h / n;
    guides[`ssd${n}`] = ss / n;
  }
  return guides;
}

/** Evaluates one DrawingML guide formula. */
function evaluate(formula, guides) {
  const [op, ...args] = String(formula).trim().split(/\s+/);
  const v = args.map((a) => (Number.isFinite(Number(a)) ? Number(a) : guides[a]));
  if (v.some((x) => x === undefined || Number.isNaN(x))) return null;
  const rad = (a) => (a / ANGLE) * (Math.PI / 180);
  switch (op) {
    case 'val': return v[0];
    case '*/': return v[2] === 0 ? 0 : (v[0] * v[1]) / v[2];
    case '+-': return v[0] + v[1] - v[2];
    case '+/': return v[2] === 0 ? 0 : (v[0] + v[1]) / v[2];
    case '?:': return v[0] > 0 ? v[1] : v[2];
    case 'abs': return Math.abs(v[0]);
    case 'sqrt': return Math.sqrt(Math.max(0, v[0]));
    case 'max': return Math.max(v[0], v[1]);
    case 'min': return Math.min(v[0], v[1]);
    case 'pin': return Math.min(Math.max(v[1], v[0]), v[2]);
    case 'mod': return Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    case 'sin': return v[0] * Math.sin(rad(v[1]));
    case 'cos': return v[0] * Math.cos(rad(v[1]));
    case 'tan': return v[0] * Math.tan(rad(v[1]));
    case 'at2': return (Math.atan2(v[1], v[0]) * 180 / Math.PI) * ANGLE;
    case 'cat2': return v[0] * Math.cos(Math.atan2(v[2], v[1]));
    case 'sat2': return v[0] * Math.sin(Math.atan2(v[2], v[1]));
    default: return null;
  }
}

/**
 * A freeform shape's outline as path data in a 0 to 100 box, and whether it is filled.
 * @param {Element} custGeom a:custGeom
 * @param {number} width the shape's width in EMU
 * @param {number} height its height in EMU
 * @returns {?{path: string, filled: boolean}} null when it uses what cannot be read
 */
export function customGeometry(custGeom, width, height) {
  const guides = builtInGuides(width, height);
  for (const list of [kid(custGeom, A, 'avLst'), kid(custGeom, A, 'gdLst')]) {
    for (const gd of kids(list, A, 'gd')) {
      const value = evaluate(gd.getAttribute('fmla'), guides);
      if (value === null) return null;
      guides[gd.getAttribute('name')] = value;
    }
  }
  const value = (text) => (Number.isFinite(Number(text)) ? Number(text) : guides[text] ?? null);
  const out = [];
  let filled = false;
  for (const path of kids(kid(custGeom, A, 'pathLst'), A, 'path')) {
    const pw = Number(path.getAttribute('w') ?? 0) || width;
    const ph = Number(path.getAttribute('h') ?? 0) || height;
    if (path.getAttribute('fill') !== 'none') filled = true;
    const segments = [];
    let at = [0, 0];
    const point = (pt) => {
      const x = value(pt?.getAttribute('x'));
      const y = value(pt?.getAttribute('y'));
      if (x === null || y === null) throw new Error('unreadable point');
      return [x, y];
    };
    try {
      for (const step of kids(path, A)) {
        const pts = kids(step, A, 'pt').map(point);
        if (step.localName === 'moveTo') {
          segments.push(['M', ...pts[0]]);
          [at] = pts;
        } else if (step.localName === 'lnTo') {
          segments.push(['L', ...pts[0]]);
          [at] = pts;
        } else if (step.localName === 'cubicBezTo') {
          segments.push(['C', ...pts[0], ...pts[1], ...pts[2]]);
          [, , at] = pts;
        } else if (step.localName === 'quadBezTo') {
          segments.push(['Q', ...pts[0], ...pts[1]]);
          [, at] = pts;
        } else if (step.localName === 'arcTo') {
          const wR = value(step.getAttribute('wR'));
          const hR = value(step.getAttribute('hR'));
          const start = (value(step.getAttribute('stAng')) / ANGLE) * (Math.PI / 180);
          const sweep = (value(step.getAttribute('swAng')) / ANGLE) * (Math.PI / 180);
          if ([wR, hR, start, sweep].some((v) => v === null || Number.isNaN(v))) return null;
          // The arc starts where the pen is, at the start angle of its ellipse.
          const cx = at[0] - wR * Math.cos(start);
          const cy = at[1] - hR * Math.sin(start);
          const curves = ellipseCurves(cx, cy, wR, hR, 0, start, sweep);
          segments.push(...curves);
          const last = curves[curves.length - 1];
          if (last) at = [last[5], last[6]];
        } else if (step.localName === 'close') {
          segments.push(['Z']);
        }
      }
    } catch {
      return null;
    }
    if (segments.length > 0) out.push(normalisePath(segments, pw, ph));
  }
  return out.length > 0 ? { path: out.join(' '), filled } : null;
}
