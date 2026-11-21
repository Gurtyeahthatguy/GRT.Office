/** Drawing objects as the PDF engine draws them: outlines, pictures and the lines of their text, placed and scaled on a page. */

import { pagePaths } from './render.js';
import { svgToPrimitives } from '../svg-primitives.js';
import { fromBase64 } from '../formats/odf.js';

/**
 * The primitives of one drawing object.
 * @param {Object} o in the page's own units before scaling
 * @param {{objects?: Object[], defaults?: Object, x?: number, y?: number, scale?: number, image?: (o) => ?string}} options
 *   x and y are where the units' origin falls on the page, scale how many points a unit is
 */
export function drawingPrimitives(o, options = {}) {
  const { objects = [], defaults = {}, x = 0, y = 0, scale = 1 } = options;
  const out = [];
  const at = (px, py) => [x + px * scale, y + py * scale];
  if (o.kind === 'group') {
    for (const c of o.children ?? []) out.push(...drawingPrimitives(c, { ...options, objects: o.children }));
    return out;
  }
  if (o.kind === 'image') {
    const href = options.image?.(o) ?? o.resource;
    const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(String(href ?? ''));
    if (!m) return out;
    const [ix, iy] = at(o.x, o.y);
    if (m[1] === 'image/svg+xml') {
      const text = new TextDecoder().decode(fromBase64(m[2]));
      const width = Number(/width="([\d.]+)/.exec(text)?.[1]) || o.w;
      out.push(...svgToPrimitives(text, { x: ix, y: iy, scale: scale * (o.w / width) }));
    } else {
      out.push({ type: 'image', bytes: fromBase64(m[2]), x: ix, y: iy, w: o.w * scale, h: o.h * scale, stretch: true, ...(o.crop ? { crop: o.crop } : {}) });
    }
    return out;
  }
  for (const p of pagePaths(o, objects, defaults)) {
    // The outline's points are in the units; the path is moved and scaled onto the page.
    const d = p.d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, a, b) => at(Number(a), Number(b)).map((v) => Math.round(v * 100) / 100).join(' '));
    out.push({ type: 'path', d, fill: p.fill, ...(p.stroke ? { stroke: p.stroke, strokeWidth: p.strokeWidth * scale } : {}) });
  }
  if (o.text) {
    // The text in lines down the middle of the box, as the screen shows a shape's words.
    const size = (o.textLook?.size ? o.textLook.size * (96 / 72) : 13) * scale;
    const lines = String(o.text).split('\n').slice(0, 200);
    const lineHeight = size * 1.3;
    const top = o.y * scale + y + (o.frame ? 4 * scale : (o.h * scale - lines.length * lineHeight) / 2);
    const align = o.textLook?.align ?? (o.frame ? 'left' : 'center');
    const tx = align === 'left' ? x + (o.x + 6) * scale : align === 'right' ? x + (o.x + o.w - 6) * scale : x + (o.x + o.w / 2) * scale;
    lines.forEach((line, i) => {
      if (line) out.push({ type: 'text', x: tx, y: top + i * lineHeight, text: line, size, align, fill: o.textLook?.color ?? '#000000', maxWidth: Math.max(0, (o.w - 12) * scale) });
    });
  }
  return out;
}
