/** Drawings on the sheets of a spreadsheet: anchored to a cell, resized with it or not, or to the page; read and written in .ods and .xlsx. */

import { NS, kids, kid, attr, tag } from '../xml.js';
import { parseLength, formatLength } from '../units.js';
import { cleanDrawingObject, TEXT_DRAWING_DEFAULTS } from '../editor/drawings.js';
import { readOdfDrawing, writeOdfDrawing, graphicProperties, lookFromProperties, odfBox } from './draw-odf.js';
import { readDrawingMl, writePptxDrawing } from './draw-ooxml.js';
import { colorOf, groupTransform } from './drawingml.js';
import { pointOf, anchorOf } from './chart-place.js';
import { toBase64, fromBase64, MEDIA_TYPES, extensionOf, DRAWABLE } from './odf.js';

const PX_PER_MM = 96 / 25.4;
const EMU_PER_PX = 9525;
const px = (text) => { const mm = parseLength(text); return mm === null ? null : mm * PX_PER_MM; };
const mm = (pixels) => formatLength(pixels / PX_PER_MM, 'mm');
export const SHEET_DRAWING_LIMIT = 2000;

/**
 * The drawings of a workbook as stored: each on a sheet, anchored to a cell (from whose top left it is placed) or to the page (from the sheet's).
 * @param {Object[]} list
 * @param {{id: string}[]} sheets a drawing read from a file names its sheet by position
 */
export function cleanSheetDrawings(list, sheets) {
  const ids = new Set(sheets.map((s) => s.id));
  const seen = new Set();
  const out = [];
  for (const given of (Array.isArray(list) ? list : []).slice(0, SHEET_DRAWING_LIMIT)) {
    const o = cleanDrawingObject(given);
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    const sheet = typeof given.sheet === 'number' ? sheets[given.sheet]?.id : given.sheet;
    o.sheet = ids.has(sheet) ? sheet : sheets[0]?.id ?? null;
    const anchor = given.anchor ?? {};
    const whole = (v, hi) => Math.max(0, Math.min(hi, Math.floor(Number(v) || 0)));
    const end = anchor.resize && anchor.end ? { row: whole(anchor.end.row, 1048575), col: whole(anchor.end.col, 16383), dx: Math.max(0, Number(anchor.end.dx) || 0), dy: Math.max(0, Number(anchor.end.dy) || 0) } : null;
    o.anchor = anchor.type === 'page' ? { type: 'page' }
      : { type: 'cell', row: whole(anchor.row, 1048575), col: whole(anchor.col, 16383), ...(anchor.resize ? { resize: true } : {}), ...(end ? { end } : {}) };
    if (given.background) o.background = true;
    o.z = Math.max(0, Math.round(Number(given.z) || 0));
    out.push(o);
  }
  return out;
}

/** A drawing's box on its sheet, in the sheet's pixels. */
export function sheetDrawingBox(o, sheet) {
  const origin = o.anchor?.type === 'cell' ? pointOf(sheet, { row: o.anchor.row, col: o.anchor.col }) : { x: 0, y: 0 };
  return { x: origin.x + o.x, y: origin.y + o.y, w: o.w, h: o.h };
}

const dataUrl = (bytes, ext) => `data:${MEDIA_TYPES[ext] ?? 'image/png'};base64,${toBase64(bytes)}`;
export function fromDataUrl(url) {
  const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(String(url ?? ''));
  return m ? { bytes: fromBase64(m[2]), type: m[1] } : null;
}
const extensionFor = (type) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' }[type] ?? 'png');

// OpenDocument

/** Whether a draw element of a sheet is a drawing GRT reads, rather than a chart or another embedded object. */
const isDrawing = (node) => node?.namespaceURI === NS.draw && !(node.localName === 'frame' && (kid(node, NS.draw, 'object') || kid(node, NS.draw, 'object-ole')));

/**
 * The drawings of one table of an .ods: those on the page, in table:shapes, and those in cells.
 * @param {Element} table
 * @param {number} sheetIndex
 * @param {{styles: Object, fills: Object, picture: (href) => ?string, id: () => string, losses: Object}} ctx
 */
export function readOdsDrawings(table, sheetIndex, ctx) {
  const look = (n) => {
    const props = { ...ctx.styles.resolve('graphic', attr(n, NS.draw, 'style-name'), 'graphic') };
    if (props['fill-gradient-name']) props.gradient = ctx.fills?.gradients?.[props['fill-gradient-name']];
    if (props['fill-hatch-name']) props.hatch = ctx.fills?.hatches?.[props['fill-hatch-name']];
    return lookFromProperties(props, px);
  };
  const text = (n) => {
    const lines = kids(n, NS.text, 'p').map((p) => p.textContent);
    return lines.join('').trim() ? { text: lines.join('\n').slice(0, 20000) } : {};
  };
  const reading = { box: (n) => odfBox(n, px), toPx: px, id: ctx.id, losses: ctx.losses, picture: ctx.picture, look, text };
  const out = [];
  const take = (node, anchor) => {
    if (!isDrawing(node) || out.length >= SHEET_DRAWING_LIMIT) return;
    const o = readOdfDrawing(node, reading);
    if (!o) { ctx.losses?.add?.('Drawings that could not be read, left out'); return; }
    if (attr(node, NS.table, 'table-background') === 'true') o.background = true;
    const z = Number(attr(node, NS.draw, 'z-index'));
    if (Number.isFinite(z)) o.z = z;
    out.push({ ...o, sheet: sheetIndex, anchor: { ...anchor, ...(attr(node, NS.table, 'end-cell-address') ? { resize: true } : {}) } });
  };
  for (const node of kids(kid(table, NS.table, 'shapes'))) take(node, { type: 'page' });
  let row = 0;
  const rows = (parent) => {
    for (const child of kids(parent)) {
      if (child.namespaceURI !== NS.table) continue;
      if (['table-header-rows', 'table-rows', 'table-row-group'].includes(child.localName)) { rows(child); continue; }
      if (child.localName !== 'table-row') continue;
      const repeat = Math.max(1, Math.min(1048576, Number(attr(child, NS.table, 'number-rows-repeated') ?? 1)));
      let col = 0;
      for (const cell of kids(child)) {
        if (cell.namespaceURI !== NS.table) continue;
        const span = Math.max(1, Math.min(16384, Number(attr(cell, NS.table, 'number-columns-repeated') ?? 1)));
        // Shapes in a cell sit from that cell's top left; a cell repeated holds them once, in its first copy.
        for (const node of kids(cell)) if (node.namespaceURI === NS.draw) take(node, { type: 'cell', row, col });
        col += span;
      }
      row += repeat;
      if (row > 1048575) return;
    }
  };
  rows(table);
  return out;
}

/**
 * A sheet's drawings as OpenDocument: those on the page for table:shapes, and those in cells by the cell they go in.
 * @param {Object[]} drawings the sheet's own
 * @param {{style: (props) => string, named: (kind, name, xml) => void, picture: (resource) => ?string, odfId: (id) => string, sheetName: string}} ctx
 * @returns {{page: Object[], cells: Map<string, Object[]>}}
 */
export function writeOdsDrawings(sheet, drawings, ctx) {
  const page = [];
  const cells = new Map();
  for (const o of [...drawings].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) {
    const placement = (x) => {
      const w = Math.max(0, x.w);
      const h = Math.max(0, x.h);
      if (!x.rotation) return { 'svg:x': mm(x.x), 'svg:y': mm(x.y), 'svg:width': mm(w), 'svg:height': mm(h) };
      const angle = (x.rotation * Math.PI) / 180;
      const cx = x.x + w / 2;
      const cy = x.y + h / 2;
      const tx = cx - (Math.cos(angle) * (w / 2) - Math.sin(angle) * (h / 2));
      const ty = cy - (Math.sin(angle) * (w / 2) + Math.cos(angle) * (h / 2));
      return { 'svg:width': mm(w), 'svg:height': mm(h), 'draw:transform': `rotate (${Number((-angle).toFixed(12))}) translate (${mm(tx)} ${mm(ty)})` };
    };
    const element = writeOdfDrawing({ ...o, textLook: o.text ? { anchor: o.textLook?.valign ?? 'middle' } : undefined }, {
      style: (x) => ctx.style(graphicProperties(x, { len: mm, named: ctx.named }, TEXT_DRAWING_DEFAULTS)),
      placement,
      len: mm,
      picture: ctx.picture,
      text: (x) => (x.text ? String(x.text).split('\n').map((line) => tag('text:p', {}, line)) : null),
      odfId: ctx.odfId,
    });
    if (!element) { ctx.losses?.add?.('Drawings that could not be written, left out'); continue; }
    element.attrs['draw:z-index'] = String(o.z ?? 0);
    if (o.background) element.attrs['table:table-background'] = 'true';
    if (o.anchor?.type === 'cell') {
      if (o.anchor.resize) {
        // Resized with its cells: the corner where it ends, as the cell it falls in and how far into it.
        const start = pointOf(sheet, { row: o.anchor.row, col: o.anchor.col });
        const end = anchorOf(sheet, start.x + o.x + o.w, start.y + o.y + o.h);
        element.attrs['table:end-cell-address'] = `${quoted(ctx.sheetName)}.${columnName(end.col)}${end.row + 1}`;
        element.attrs['table:end-x'] = mm(end.dx);
        element.attrs['table:end-y'] = mm(end.dy);
      }
      const key = `${o.anchor.row},${o.anchor.col}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(element);
    } else page.push(element);
  }
  return { page, cells };
}

const quoted = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);
function columnName(col) {
  let n = col + 1;
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

/** A picture of an .ods or .xlsx package as a data address, kept in Grid's document. */
export function packagePicture(pkg, path) {
  if (!path || !pkg?.has?.(path)) return null;
  const ext = extensionOf(path);
  if (!DRAWABLE.has(ext)) return null;
  const bytes = pkg.bytes(path);
  if (!bytes || bytes.length > 20 * 1024 * 1024) return null;
  return dataUrl(bytes, ext);
}

// Office Open XML

const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

function cornerOf(element) {
  const number = (name) => Number(kid(element, XDR, name)?.textContent ?? 0) || 0;
  return { col: number('col'), row: number('row'), dx: number('colOff') / EMU_PER_PX, dy: number('rowOff') / EMU_PER_PX };
}

/**
 * The shapes, pictures and groups a sheet's drawing part anchors, charts left to their own reader.
 * @param {Document} doc the drawing part
 * @param {Object} sheet Grid's sheet as read, for its sizes
 * @param {{picture: (relId) => ?string, id: () => string, losses: Object, theme?: Object}} ctx
 */
export function readXlsxDrawings(doc, sheet, sheetIndex, ctx) {
  const out = [];
  for (const anchor of kids(doc?.documentElement)) {
    if (anchor.namespaceURI !== XDR || !/Anchor$/.test(anchor.localName) || out.length >= SHEET_DRAWING_LIMIT) continue;
    const body = kids(anchor).find((k) => k.namespaceURI === XDR && ['sp', 'pic', 'grpSp', 'cxnSp'].includes(k.localName));
    if (!body) continue;
    // The box the anchor gives: between two corners, from one corner with a size, or at a place on the sheet.
    let from;
    let box;
    if (anchor.localName === 'absoluteAnchor') {
      const pos = kid(anchor, XDR, 'pos');
      const ext = kid(anchor, XDR, 'ext');
      box = { x: Number(pos?.getAttribute('x') ?? 0) / EMU_PER_PX, y: Number(pos?.getAttribute('y') ?? 0) / EMU_PER_PX, w: Number(ext?.getAttribute('cx') ?? 0) / EMU_PER_PX, h: Number(ext?.getAttribute('cy') ?? 0) / EMU_PER_PX };
    } else {
      from = cornerOf(kid(anchor, XDR, 'from'));
      const start = pointOf(sheet, from);
      if (anchor.localName === 'twoCellAnchor') {
        const end = pointOf(sheet, cornerOf(kid(anchor, XDR, 'to')));
        box = { x: start.x, y: start.y, w: end.x - start.x, h: end.y - start.y };
      } else {
        const ext = kid(anchor, XDR, 'ext');
        box = { x: start.x, y: start.y, w: Number(ext?.getAttribute('cx') ?? 0) / EMU_PER_PX, h: Number(ext?.getAttribute('cy') ?? 0) / EMU_PER_PX };
      }
    }
    const top = body.localName === 'grpSp';
    const reading = {
      // A shape alone takes the anchor's box; members of a group are placed by the group's own frame.
      place: (raw) => ({ x: box.x, y: box.y, w: box.w || raw.w, h: box.h || raw.h, rotation: raw.rotation ?? 0 }),
      color: (node) => colorOf(node, ctx.theme ?? null, null),
      fromEmu: (n) => n / EMU_PER_PX,
      picture: ctx.picture,
      id: ctx.id,
      losses: ctx.losses,
      text: (node) => {
        const body2 = [...node.children].find((c) => c.localName === 'txBody');
        const lines = body2 ? [...body2.children].filter((p) => p.localName === 'p').map((p) => [...p.getElementsByTagNameNS(NS.a, 't')].map((t) => t.textContent).join('')) : [];
        return lines.join('').trim() ? { text: lines.join('\n').slice(0, 20000) } : {};
      },
      group: (xfrm) => groupTransform(xfrm, (b) => b),
    };
    const o = readDrawingMl(body, reading);
    if (!o) continue;
    if (o.kind === 'text-only') Object.assign(o, { kind: 'shape', shape: 'rectangle', fillLook: { type: 'none' }, line: { style: 'none' } });
    if (top && o.kind === 'group') {
      // A group read from its own frame fills the anchor's box.
      const sx = box.w && o.w ? box.w / o.w : 1;
      const sy = box.h && o.h ? box.h / o.h : 1;
      const move = (c) => { c.x = box.x + (c.x - o.x) * sx; c.y = box.y + (c.y - o.y) * sy; c.w *= sx; c.h *= sy; for (const k of c.children ?? []) move(k); };
      for (const c of o.children) move(c);
      Object.assign(o, { x: box.x, y: box.y, w: box.w || o.w, h: box.h || o.h });
    }
    const editAs = anchor.getAttribute('editAs') ?? (anchor.localName === 'twoCellAnchor' ? 'twoCell' : 'oneCell');
    if (anchor.localName === 'absoluteAnchor' || editAs === 'absolute') {
      o.anchor = { type: 'page' };
    } else {
      // Kept from the cell it starts in, so it moves with its row and column.
      const origin = pointOf(sheet, { row: from.row, col: from.col });
      const shift = (c) => { c.x -= origin.x; c.y -= origin.y; for (const k of c.children ?? []) shift(k); };
      shift(o);
      o.anchor = { type: 'cell', row: from.row, col: from.col, ...(editAs === 'twoCell' ? { resize: true } : {}) };
    }
    o.sheet = sheetIndex;
    o.z = out.length;
    out.push(o);
  }
  return out;
}

/**
 * A sheet's drawings as anchors of its drawing part, with the pictures they need.
 * @param {{emu: (px) => number, nextId: () => number, picture: (o) => ?string}} ctx picture adds the picture and gives its relationship
 */
export function xlsxDrawingAnchors(sheet, drawings, ctx) {
  const corner = (at) => [
    tag('xdr:col', {}, String(at.col)), tag('xdr:colOff', {}, String(Math.round((at.dx ?? 0) * EMU_PER_PX))),
    tag('xdr:row', {}, String(at.row)), tag('xdr:rowOff', {}, String(Math.round((at.dy ?? 0) * EMU_PER_PX))),
  ];
  const out = [];
  for (const o of [...drawings].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) {
    const box = sheetDrawingBox(o, sheet);
    // Placed on the sheet: members of a group move with it.
    const placed = structuredClone(o);
    const dx = box.x - o.x;
    const dy = box.y - o.y;
    // Writer's own look for a shape with none set, as Grid draws it.
    const shift = (c) => {
      c.x += dx; c.y += dy;
      if (c.kind === 'shape' || c.kind === 'path') { c.fillLook ??= TEXT_DRAWING_DEFAULTS.fill; c.line ??= TEXT_DRAWING_DEFAULTS.line; }
      for (const k of c.children ?? []) shift(k);
    };
    shift(placed);
    const shape = writePptxDrawing(placed, {
      emu: (v) => Math.round(v * EMU_PER_PX), nextId: ctx.nextId, picture: ctx.picture, ids: ctx.ids ?? new Map(), objects: drawings,
      text: (x) => (x.text ? tag('p:txBody', {}, tag('a:bodyPr', { anchor: { top: 't', middle: 'ctr', bottom: 'b' }[x.textLook?.valign ?? 'middle'] }), tag('a:lstStyle'),
        String(x.text).split('\n').map((line) => tag('a:p', {}, tag('a:pPr', { algn: 'ctr' }), line ? tag('a:r', {}, tag('a:rPr', { lang: 'en-US' }), tag('a:t', {}, line)) : null))) : null),
    });
    if (!shape) { ctx.losses?.add?.(o.kind === 'scene3d' ? '3D objects, written as the drawing of their faces' : 'Drawings that could not be written, left out'); continue; }
    const body = toXdr(shape);
    if (o.anchor?.type === 'cell') {
      const from = anchorOf(sheet, box.x, box.y);
      const to = anchorOf(sheet, box.x + box.w, box.y + box.h);
      out.push(tag('xdr:twoCellAnchor', { editAs: o.anchor.resize ? 'twoCell' : 'oneCell' }, tag('xdr:from', {}, corner(from)), tag('xdr:to', {}, corner(to)), body, tag('xdr:clientData')));
    } else {
      out.push(tag('xdr:absoluteAnchor', {}, tag('xdr:pos', { x: String(Math.round(box.x * EMU_PER_PX)), y: String(Math.round(box.y * EMU_PER_PX)) }),
        tag('xdr:ext', { cx: String(Math.round(box.w * EMU_PER_PX)), cy: String(Math.round(box.h * EMU_PER_PX)) }), body, tag('xdr:clientData')));
    }
  }
  return out;
}

/** A shape written for a slide, renamed into the spreadsheet drawing's own elements. */
function toXdr(node) {
  if (!node || typeof node !== 'object') return node;
  const name = typeof node.name === 'string' && node.name.startsWith('p:') ? `xdr:${node.name.slice(2)}` : node.name;
  // A spreadsheet drawing has no application properties after a shape's names.
  return { ...node, name, children: (node.children ?? []).filter((c) => c?.name !== 'p:nvPr').map(toXdr) };
}

/** The bytes and file name of a drawing's picture kept as a data address. */
export function pictureFile(resource, number) {
  const data = fromDataUrl(resource);
  return data ? { bytes: data.bytes, name: `image${number}.${extensionFor(data.type)}`, type: data.type } : null;
}

export { dataUrl as pictureDataUrl };
