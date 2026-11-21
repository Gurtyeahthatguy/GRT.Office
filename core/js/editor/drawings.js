/** Drawing objects in a text document: where each is anchored, how the text runs round it, and the floats that make it do so. */

import { cleanDrawing, corners, outerBox, DRAW_KINDS } from '../draw/objects.js';
import { drawingSvg } from '../draw/render.js';

/** Writer's anchors: to the page, to a paragraph, to a character, and as a character in the line. */
export const ANCHORS = ['page', 'paragraph', 'char', 'as-char'];

/** Writer's wraps, by the names its Wrap menu gives them. */
export const WRAPS = ['none', 'parallel', 'optimal', 'before', 'after', 'through', 'background', 'contour'];
export const WRAP_LABELS = {
  none: 'Wrap Off', parallel: 'Page Wrap', optimal: 'Optimal Page Wrap', before: 'Wrap Left', after: 'Wrap Right',
  through: 'Wrap Through', background: 'In Background', contour: 'Contour',
};

/** The most drawings a document keeps, and the most text a shape holds. */
export const DRAWING_LIMIT = 2000;
const TEXT_LIMIT = 20000;

/** Writer's look for a new shape: its blue fill and darker outline. */
export const TEXT_DRAWING_DEFAULTS = { line: { color: '#3465a4', width: 1.33 }, fill: { type: 'solid', color: '#729fcf' } };

const finite = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, finite(v, d)));
const word = (v, n = 60) => (typeof v === 'string' && /^[\w.:-]{1,60}$/.test(v) ? v.slice(0, n) : null);

/** One object of a drawing as stored, members of groups cleaned the same way. */
export function cleanDrawingObject(o, depth = 0) {
  return cleanObject(o, depth);
}

function cleanObject(o, depth = 0) {
  if (!o || typeof o !== 'object' || !DRAW_KINDS.includes(o.kind) || depth > 20) return null;
  const out = {
    id: word(o.id) ?? `d${Math.random().toString(36).slice(2, 10)}`,
    kind: o.kind,
    ...cleanDrawing(o),
    x: clamp(o.x, -20000, 20000, 0), y: clamp(o.y, -20000, 200000, 0),
    w: clamp(o.w, 0.01, 20000, 100), h: clamp(o.h, 0.01, 20000, 100),
    rotation: clamp(o.rotation, -360, 360, 0),
  };
  if (o.kind === 'image' && typeof o.resource === 'string') out.resource = o.resource.slice(0, 2000);
  if (o.kind === 'group') out.children = (o.children ?? []).slice(0, 500).map((c) => cleanObject(c, depth + 1)).filter(Boolean);
  if (typeof o.text === 'string' && o.text !== '') out.text = o.text.slice(0, TEXT_LIMIT);
  if (o.textLook && typeof o.textLook === 'object') {
    const look = {};
    if (['left', 'center', 'right'].includes(o.textLook.align)) look.align = o.textLook.align;
    if (['top', 'middle', 'bottom'].includes(o.textLook.valign)) look.valign = o.textLook.valign;
    if (Number.isFinite(Number(o.textLook.size))) look.size = clamp(o.textLook.size, 4, 400, 11);
    if (/^#[0-9a-f]{6}$/i.test(o.textLook.color ?? '')) look.color = o.textLook.color.toLowerCase();
    if (Object.keys(look).length) out.textLook = look;
  }
  if (o.frame) out.frame = true;
  // A formula drawn as a picture keeps what it was typed as, to be changed again.
  if (o.kind === 'image' && typeof o.tex === 'string' && o.tex.trim()) out.tex = o.tex.slice(0, 5000);
  return out;
}

/**
 * A drawing of a text document as stored: the object, where it is anchored and how the text runs round it.
 * Positions are from the anchor: the paragraph's area or the page's text area, in CSS pixels.
 * @param {Object} o
 * @param {Set<string>} blockIds the paragraphs it may be anchored to
 */
export function cleanTextDrawing(o, blockIds = null) {
  const out = cleanObject(o);
  if (!out) return null;
  const given = o.anchor ?? {};
  const type = ANCHORS.includes(given.type) ? given.type : 'paragraph';
  const anchor = { type };
  if (type === 'page') anchor.page = Math.max(1, Math.min(100000, Math.round(finite(given.page, 1))));
  else {
    const block = word(given.block);
    anchor.block = block && (!blockIds || blockIds.has(block)) ? block : null;
  }
  out.anchor = anchor;
  out.wrap = WRAPS.includes(o.wrap) ? o.wrap : 'through';
  if (o.wrapFirst) out.wrapFirst = true;
  out.gap = clamp(o.gap, 0, 200, 0);
  out.z = Math.round(clamp(o.z, 0, 100000, 0));
  return out;
}

/** The drawings of a document as stored: anchors that name no paragraph go to the first, as-character ones keep to their text. */
export function cleanTextDrawings(list, blocks) {
  const ids = new Set(blocks.map((b) => b.id));
  const first = blocks[0]?.id ?? null;
  const seen = new Set();
  const out = [];
  for (const given of (Array.isArray(list) ? list : []).slice(0, DRAWING_LIMIT)) {
    const o = cleanTextDrawing(given, ids);
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    if (o.anchor.type !== 'page' && !o.anchor.block) o.anchor.block = first;
    out.push(o);
  }
  return out;
}

/** Every image resource the drawings use, groups opened. */
export function drawingResources(list) {
  const out = [];
  const visit = (o) => { if (o.kind === 'image' && o.resource) out.push(o.resource); for (const c of o.children ?? []) visit(c); };
  for (const o of list ?? []) visit(o);
  return out;
}

/** The text of a shape or a text box, as lines over its box. */
function textMarkup(o) {
  if (!o.text || o.textPath) return '';
  const look = o.textLook ?? {};
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const justify = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[look.valign ?? (o.frame ? 'top' : 'middle')];
  const lines = o.text.split('\n').map((line) => `<div>${esc(line) || '<br>'}</div>`).join('');
  return `<div class="drawing-text" style="justify-content:${justify};text-align:${look.align ?? (o.frame ? 'left' : 'center')};${look.size ? `font-size:${look.size * (96 / 72)}px;` : ''}${look.color ? `color:${look.color};` : ''}">${lines}</div>`;
}

/**
 * The element that shows one drawing: its picture and its text, the size of its box, turned as it is turned.
 * @param {Object} o
 * @param {{objects?: Object[], image?: (o) => ?string}} options
 */
export function drawingHolder(o, options = {}, doc = document) {
  const holder = doc.createElement('span');
  holder.className = `text-drawing wrap-${o.wrap ?? 'through'}`;
  holder.contentEditable = 'false';
  holder.dataset.id = o.id;
  holder.dataset.drawing = o.id;
  fillHolder(holder, o, options);
  return holder;
}

/** Puts an object's picture and text in its holder, sized and turned. */
export function fillHolder(holder, o, options = {}) {
  Object.assign(holder.style, {
    width: `${o.w}px`, height: `${o.h}px`,
    transform: o.rotation ? `rotate(${o.rotation}deg)` : '',
  });
  const label = [o.name, o.description].filter(Boolean).join(': ');
  if (label) { holder.setAttribute('role', 'img'); holder.setAttribute('aria-label', label); }
  holder.innerHTML = drawingSvg(o, { objects: options.objects ?? [], image: options.image ?? (() => null), defaults: TEXT_DRAWING_DEFAULTS, idPrefix: 'td', text: o.textPath ? (o.text ?? '').replace(/\n/g, ' ') : undefined }) + textMarkup(o);
}

/**
 * What goes before a paragraph for the drawings anchored to it: a mark where the paragraph's area starts, holding the drawings,
 * and a float for each one the text runs round. placeDrawings sets their sizes once the page is laid out.
 */
export function anchorElements(list, options = {}, doc = document) {
  if (!list.length) return [];
  const mark = doc.createElement('div');
  mark.className = 'draw-anchor';
  mark.contentEditable = 'false';
  mark.setAttribute('aria-hidden', 'false');
  const out = [mark];
  for (const o of list) {
    const holder = drawingHolder(o, options, doc);
    Object.assign(holder.style, { left: `${o.x}px`, top: `${o.y}px` });
    mark.append(holder);
    if (!['through', 'background'].includes(o.wrap)) {
      const wrap = doc.createElement('div');
      wrap.className = 'draw-wrap';
      wrap.contentEditable = 'false';
      wrap.dataset.wrapFor = o.id;
      out.push(wrap);
    }
  }
  return out;
}

/** The side a wrap that may use either takes: the wider one, or none when Optimal finds both too narrow. */
export function wrapSide(o, column) {
  const box = outerBox(o);
  const left = box.x;
  const right = column - (box.x + box.w);
  if (o.wrap === 'before') return 'left';
  if (o.wrap === 'after') return 'right';
  if (o.wrap === 'none') return 'none';
  // Optimal Page Wrap leaves a side narrower than 2 cm empty, as Writer does.
  if (o.wrap === 'optimal' && Math.max(left, right) < 2 * 96 / 2.54) return 'none';
  return right >= left ? 'right' : 'left';
}

/**
 * Lays the drawings of a rendered document where their anchors are: each drawing from the top of its paragraph's area,
 * and each float sized so the text runs round the drawing as its wrap says.
 * @param {HTMLElement} container the rendered text column
 * @param {Object} model the document, with its drawings
 */
export function placeDrawings(container, model) {
  const drawings = new Map((model.drawings ?? []).map((o) => [o.id, o]));
  if (!drawings.size) return;
  const rect = container.getBoundingClientRect();
  const zoom = container.offsetWidth ? rect.width / container.offsetWidth : 1;
  const column = container.clientWidth || rect.width / zoom;
  for (const mark of container.querySelectorAll('.draw-anchor')) {
    // The paragraph the mark stands before: its area starts at its top margin.
    let block = mark.nextElementSibling;
    while (block && block.matches('.draw-wrap, .draw-anchor, .page-break')) block = block.nextElementSibling;
    const markTop = mark.getBoundingClientRect().top;
    const blockRect = block?.getBoundingClientRect();
    const margin = block ? parseFloat(getComputedStyle(block).marginTop) || 0 : 0;
    const shift = blockRect ? (blockRect.top - markTop) / zoom - margin : 0;
    const bottom = blockRect ? (blockRect.bottom - markTop) / zoom : Infinity;
    for (const holder of mark.querySelectorAll(':scope > .text-drawing')) {
      const o = drawings.get(holder.dataset.id);
      if (!o) continue;
      const top = o.y + shift;
      holder.style.top = `${top}px`;
      holder.style.left = `${o.x}px`;
      const wrap = mark.parentElement?.querySelector(`.draw-wrap[data-wrap-for="${CSS.escape(o.id)}"]`);
      if (!wrap) continue;
      const placed = { ...o, y: top };
      const box = outerBox(placed);
      const gap = o.gap ?? 0;
      const side = wrapSide(placed, column);
      let height = Math.max(0, box.y + box.h + gap);
      if (o.wrapFirst) height = Math.min(height, bottom);
      const start = Math.max(0, box.y - gap);
      const style = { float: side === 'left' ? 'right' : 'left', height: `${height}px`, shapeOutside: `inset(${start}px 0 0 0)`, shapeMargin: '' };
      if (side === 'none') style.width = `${column}px`;
      else if (side === 'right') style.width = `${Math.max(0, box.x + box.w + gap)}px`;
      else style.width = `${Math.max(0, column - box.x + gap)}px`;
      if (o.wrap === 'contour' && side !== 'none') {
        // The text follows the drawing's own outline, turned as it is, rather than its box.
        const offset = side === 'right' ? 0 : column - parseFloat(style.width);
        const points = corners(placed).map((p) => `${(p.x - offset).toFixed(1)}px ${p.y.toFixed(1)}px`);
        style.shapeOutside = `polygon(${points.join(', ')})`;
        style.shapeMargin = `${gap}px`;
      }
      Object.assign(wrap.style, style);
    }
  }
}
