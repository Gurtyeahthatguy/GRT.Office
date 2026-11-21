/** Drawings of a text document in OpenDocument: read with their anchor, wrap and place, and written back the same way. */

import { NS, kids, kid, attr, tag } from '../xml.js';
import { parseLength, formatLength } from '../units.js';
import { readOdfDrawing, writeOdfDrawing, graphicProperties, lookFromProperties, odfBox } from './draw-odf.js';
import { TEXT_DRAWING_DEFAULTS } from '../editor/drawings.js';
import { toBase64 } from './odf.js';

const PX_PER_MM = 96 / 25.4;
const px = (text) => { const mm = parseLength(text); return mm === null ? null : mm * PX_PER_MM; };
const cm = (pixels) => formatLength(pixels / PX_PER_MM, 'cm');

/** The draw elements that are drawings of the text, besides frames. */
const SHAPES = new Set(['custom-shape', 'rect', 'ellipse', 'circle', 'line', 'path', 'polygon', 'polyline', 'g', 'connector']);

const WRAP_FROM = { none: 'none', left: 'before', right: 'after', parallel: 'parallel', dynamic: 'optimal', biggest: 'optimal', 'run-through': 'through' };
const WRAP_TO = { none: 'none', parallel: 'parallel', optimal: 'dynamic', before: 'left', after: 'right', through: 'run-through', background: 'run-through', contour: 'dynamic' };

/** Whether a draw element is one the text reader takes as a drawing: a shape, or a frame of a picture or of text. */
export function isTextDrawing(node) {
  if (node?.namespaceURI !== NS.draw) return false;
  if (SHAPES.has(node.localName)) return true;
  return node.localName === 'frame' && Boolean(kid(node, NS.draw, 'image') || kid(node, NS.draw, 'text-box'));
}

/** How a drawing is anchored, as the file says. */
export const anchorTypeOf = (node) => {
  const type = attr(node, NS.text, 'anchor-type') ?? 'paragraph';
  return ['page', 'paragraph', 'char', 'as-char'].includes(type) ? type : type === 'frame' ? 'paragraph' : 'paragraph';
};

/** The plain text of a shape or a frame's text box, one line a paragraph. */
function plainText(node) {
  const holder = kid(node, NS.draw, 'text-box') ?? node;
  const lines = [];
  const visit = (el) => {
    for (const child of kids(el)) {
      if (child.namespaceURI === NS.text && (child.localName === 'p' || child.localName === 'h')) lines.push(child.textContent);
      else if (child.namespaceURI === NS.text && (child.localName === 'list' || child.localName === 'list-item' || child.localName === 'section')) visit(child);
    }
  };
  visit(holder);
  const text = lines.join('\n');
  return text.trim() ? { text: text.slice(0, 20000) } : {};
}

/**
 * One drawing of a text: the object, its anchor and wrap, and how its place is given, for the reader to settle once the page is known.
 * @param {Element} node
 * @param {{styles: Object, fills: Object, picture: (href) => ?string, id: () => string, losses: Object}} ctx
 */
export function readTextDrawing(node, ctx) {
  const styleOf = (n) => ctx.styles.resolve('graphic', attr(n, NS.draw, 'style-name'), 'graphic');
  const look = (n) => {
    const props = { ...styleOf(n) };
    if (props['fill-gradient-name']) props.gradient = ctx.fills?.gradients?.[props['fill-gradient-name']];
    if (props['fill-hatch-name']) props.hatch = ctx.fills?.hatches?.[props['fill-hatch-name']];
    return lookFromProperties(props, px);
  };
  const reading = { box: (n) => odfBox(n, px), toPx: px, id: ctx.id, losses: ctx.losses, picture: ctx.picture, look, text: plainText };
  let o;
  if (node.localName === 'frame' && kid(node, NS.draw, 'text-box') && !kid(node, NS.draw, 'image')) {
    // A frame of text: a box with its words, drawn as Writer draws a frame.
    const box = odfBox(node, px);
    const props = styleOf(node);
    const width = box?.w ?? px(attr(kid(node, NS.draw, 'text-box'), NS.fo, 'min-width')) ?? 200;
    const height = box?.h ?? px(attr(kid(node, NS.draw, 'text-box'), NS.fo, 'min-height')) ?? 60;
    const lined = props.border && props.border !== 'none';
    o = {
      id: ctx.id(), kind: 'shape', shape: 'rectangle', x: box?.x ?? 0, y: box?.y ?? 0, w: width, h: height, rotation: box?.rotation ?? 0, frame: true,
      fillLook: props['background-color'] && props['background-color'] !== 'transparent' ? { type: 'solid', color: props['background-color'] } : { type: 'none' },
      line: lined ? { color: /#[0-9a-f]{6}/i.exec(props.border)?.[0] ?? '#000000', width: 1 } : { style: 'none' },
      ...plainText(node),
    };
    const name = attr(node, NS.draw, 'name');
    if (name) o.name = name.slice(0, 200);
    if (kids(kid(node, NS.draw, 'text-box')).some((k) => k.namespaceURI === NS.text && k.localName === 'p' && kids(k).length)) ctx.losses?.add?.('Formatting of the text in frames, kept as plain text');
  } else {
    o = readOdfDrawing(node, reading);
  }
  if (!o) return null;
  const props = styleOf(node);
  const type = anchorTypeOf(node);
  let wrap = WRAP_FROM[props.wrap] ?? (node.localName === 'frame' ? 'none' : 'through');
  if (wrap === 'through' && props['run-through'] === 'background') wrap = 'background';
  if (props['wrap-contour'] === 'true' && !['none', 'through', 'background'].includes(wrap)) wrap = 'contour';
  const gap = Math.max(0, ...['margin-left', 'margin-right', 'margin-top', 'margin-bottom'].map((m) => px(props[m]) ?? 0));
  o.anchor = type === 'page' ? { type, page: Math.max(1, Number(attr(node, NS.text, 'anchor-page-number')) || 1) } : { type };
  o.wrap = wrap;
  if (props['number-wrapped-paragraphs'] === '1') o.wrapFirst = true;
  if (gap) o.gap = gap;
  const z = Number(attr(node, NS.draw, 'z-index'));
  if (Number.isFinite(z)) o.z = z;
  // Where the drawing stands is settled with the page: centred, to the right, or from the page's edge rather than its text.
  o.place = { hpos: props['horizontal-pos'] ?? 'from-left', hrel: props['horizontal-rel'] ?? (type === 'page' ? 'page' : 'paragraph'), vpos: props['vertical-pos'] ?? 'from-top', vrel: props['vertical-rel'] ?? (type === 'page' ? 'page' : 'paragraph') };
  return o;
}

/**
 * Settles a read drawing's place against the page: positions from the text area, as Paper keeps them.
 * @param {Object} o a drawing read by readTextDrawing
 * @param {{column: number, left: number, top: number, right: number}} page in CSS pixels: the text column's width and the margins
 */
export function settleTextDrawing(o, page) {
  const place = o.place;
  delete o.place;
  if (!place) return o;
  const shift = (dx, dy) => { o.x += dx; o.y += dy; for (const c of o.children ?? []) { c.x += dx; c.y += dy; } };
  const fromPage = place.hrel === 'page' || place.hrel === 'page-start-margin' || place.hrel === 'page-end-margin';
  const area = fromPage ? page.column + page.left + page.right : page.column;
  const start = fromPage ? -page.left : 0;
  let x = o.x;
  if (place.hpos === 'left') x = start;
  else if (place.hpos === 'center') x = start + (area - o.w) / 2;
  else if (place.hpos === 'right') x = start + area - o.w;
  else if (fromPage) x = o.x - page.left;
  let y = o.y;
  if (o.anchor.type === 'page' && (place.vrel === 'page' || place.vrel === 'page-content') && place.vpos === 'from-top' && place.vrel === 'page') y = o.y - page.top;
  if (o.anchor.type === 'page' && place.vpos === 'top' && place.vrel === 'page') y = -page.top;
  shift(x - o.x, y - o.y);
  return o;
}

/**
 * One drawing of a text as OpenDocument, anchored and wrapped.
 * @param {Object} o
 * @param {{style: (props: Object) => string, picture: (resource) => ?{href: string, bytes: Uint8Array}, named: (kind, name, xml) => void,
 *   odfId: (id) => string, page: {left: number, top: number}, flat: boolean}} ctx
 */
export function writeTextDrawing(o, ctx) {
  const type = o.anchor?.type ?? 'paragraph';
  const page = type === 'page';
  const dx = page ? ctx.page.left : 0;
  const dy = page ? ctx.page.top : 0;
  const wrapProps = type === 'as-char'
    ? { 'style:vertical-pos': 'top', 'style:vertical-rel': 'baseline', 'style:horizontal-pos': 'center', 'style:horizontal-rel': 'paragraph' }
    : {
      'style:wrap': WRAP_TO[o.wrap] ?? 'run-through',
      'style:run-through': o.wrap === 'background' ? 'background' : 'foreground',
      'style:number-wrapped-paragraphs': o.wrapFirst ? '1' : 'no-limit',
      'style:wrap-contour': o.wrap === 'contour' ? 'true' : 'false',
      ...(o.wrap === 'contour' ? { 'style:wrap-contour-mode': 'outside' } : {}),
      'style:vertical-pos': 'from-top', 'style:vertical-rel': page ? 'page' : 'paragraph',
      'style:horizontal-pos': 'from-left', 'style:horizontal-rel': page ? 'page' : 'paragraph',
    };
  if (o.gap) for (const side of ['left', 'right', 'top', 'bottom']) wrapProps[`fo:margin-${side}`] = cm(o.gap);
  const look = { ...o, textLook: o.text ? { anchor: o.textLook?.valign ?? (o.frame ? 'top' : 'middle') } : undefined };
  const placement = (x) => {
    const w = Math.max(0, x.w);
    const h = Math.max(0, x.h);
    if (type === 'as-char') return { 'svg:width': cm(w), 'svg:height': cm(h) };
    if (!x.rotation) return { 'svg:x': cm(x.x + dx), 'svg:y': cm(x.y + dy), 'svg:width': cm(w), 'svg:height': cm(h) };
    const angle = (x.rotation * Math.PI) / 180;
    const cx = x.x + dx + w / 2;
    const cy = x.y + dy + h / 2;
    const tx = cx - (Math.cos(angle) * (w / 2) - Math.sin(angle) * (h / 2));
    const ty = cy - (Math.sin(angle) * (w / 2) + Math.cos(angle) * (h / 2));
    return { 'svg:width': cm(w), 'svg:height': cm(h), 'draw:transform': `rotate (${Number((-angle).toFixed(12))}) translate (${cm(tx)} ${cm(ty)})` };
  };
  const paragraphs = (text) => String(text ?? '').split('\n').map((line) => tag('text:p', { 'text:style-name': o.frame ? 'Frame_20_contents' : 'Standard' }, line));
  let element;
  if (o.frame) {
    const style = ctx.style({
      ...wrapProps,
      'fo:background-color': o.fillLook?.type === 'solid' ? o.fillLook.color : 'transparent',
      'style:background-transparency': o.fillLook?.type === 'solid' ? '0%' : '100%',
      'fo:border': o.line?.style === 'none' ? 'none' : `${cm(o.line?.width ?? 1)} solid ${o.line?.color ?? '#000000'}`,
      'fo:padding': cm(4),
    }, 'Frame');
    element = tag('draw:frame', { 'draw:style-name': style, 'draw:name': o.name ?? null, ...placement(o) },
      tag('draw:text-box', {}, paragraphs(o.text)),
      o.title ? tag('svg:title', {}, o.title) : null, o.description ? tag('svg:desc', {}, o.description) : null);
  } else {
    element = writeOdfDrawing(look, {
      style: (x) => ctx.style({ ...graphicProperties(x, { len: cm, named: ctx.named }, TEXT_DRAWING_DEFAULTS), ...(x === look ? wrapProps : {}) }, o.kind === 'image' ? 'Graphics' : null),
      placement,
      len: cm,
      picture: (resource) => ctx.picture(resource)?.href ?? null,
      text: (x) => (x.text ? paragraphs(x.text) : null),
      odfId: ctx.odfId,
    });
    if (!element) return null;
    if (ctx.flat) inlinePictures(element, ctx);
  }
  element.attrs['text:anchor-type'] = type;
  if (page) element.attrs['text:anchor-page-number'] = String(o.anchor.page ?? 1);
  element.attrs['draw:z-index'] = String(Math.max(0, Math.round(o.z ?? 0)));
  return element;
}

/** A flat file has no package for pictures: they go inside their elements. */
function inlinePictures(element, ctx) {
  for (const child of element.children ?? []) {
    if (child?.name === 'draw:image') {
      const href = child.attrs['xlink:href'];
      const found = ctx.pictureByHref?.(href);
      if (found) { child.attrs = {}; child.children = [tag('office:binary-data', {}, toBase64(found))]; }
    } else if (child?.children) inlinePictures(child, ctx);
  }
}
