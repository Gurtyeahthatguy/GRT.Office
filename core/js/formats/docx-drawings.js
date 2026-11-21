/** Drawings of a text document in Word's files: floating or in line, their wrap and place, read and written as DrawingML. */

import { NS, kids, kid, tag } from '../xml.js';
import { readDrawingMl, fillXml, lineXml, geometryXml, xfrmXml, flippedPath, blipEffects, srcRectXml } from './draw-ooxml.js';
import { colorOf, groupTransform, toPx } from './drawingml.js';
import { TEXT_DRAWING_DEFAULTS } from '../editor/drawings.js';

const WP = NS.wp;
const EMU_PER_PX = 9525;
const emu = (px) => Math.round(px * EMU_PER_PX);

const WRAP_FROM_SQUARE = { bothSides: 'parallel', left: 'before', right: 'after', largest: 'optimal' };
const WRAP_TO_SQUARE = { parallel: 'bothSides', before: 'left', after: 'right', optimal: 'largest' };

/** The first element of a local name anywhere under a node. */
const find = (node, name) => [...(node?.getElementsByTagName('*') ?? [])].find((n) => n.localName === name) ?? null;

/** Whether a w:drawing holds a shape, a group or a picture this reader takes as a drawing of the text. */
export function drawingKind(element) {
  const holder = kid(element, WP, 'anchor') ?? kid(element, WP, 'inline');
  if (!holder) return null;
  const graphic = find(holder, 'graphicData');
  const body = graphic ? kids(graphic)[0] : null;
  if (!body) return null;
  if (['wsp', 'wgp', 'grpSp'].includes(body.localName)) return 'shape';
  if (body.localName === 'pic') return 'picture';
  return null;
}

/** Whether a floating drawing is one the text runs round, rather than one that only stands between paragraphs. */
export function wrapsText(element) {
  const anchor = kid(element, WP, 'anchor');
  return Boolean(anchor) && !kid(anchor, WP, 'wrapTopAndBottom');
}

/** The plain text of a text box, one line a paragraph. */
function boxText(node) {
  const content = find(node, 'txbxContent');
  if (!content) return {};
  const text = [...content.getElementsByTagNameNS(NS.w, 'p')].map((p) => [...p.getElementsByTagNameNS(NS.w, 't')].map((t) => t.textContent).join('')).join('\n');
  return text.trim() ? { text: text.slice(0, 20000) } : {};
}

/**
 * One w:drawing as a drawing of the text, with its anchor, wrap and place from the text column's top left.
 * @param {Element} element w:drawing
 * @param {{picture: (relId) => ?string, id: () => string, losses: Object, theme?: Object, page: {left: number, top: number, column: number}, pageNumber: number}} ctx
 */
export function readDocxDrawing(element, ctx) {
  const anchor = kid(element, WP, 'anchor');
  const holder = anchor ?? kid(element, WP, 'inline');
  const graphic = find(holder, 'graphicData');
  const body = graphic ? kids(graphic)[0] : null;
  if (!body) return null;
  const extent = kid(holder, WP, 'extent');
  const w = Number(extent?.getAttribute('cx') ?? 0) / EMU_PER_PX;
  const h = Number(extent?.getAttribute('cy') ?? 0) / EMU_PER_PX;
  // The drawing's own transform says how big it is and how it is turned; where it is comes from the anchor.
  const place = (raw) => ({ x: raw.x ?? 0, y: raw.y ?? 0, w: raw.w || w, h: raw.h || h, rotation: raw.rotation ?? 0 });
  const reading = {
    place,
    color: (node) => colorOf(node, ctx.theme ?? null, null),
    fromEmu: (n) => toPx(n),
    picture: ctx.picture,
    id: ctx.id,
    losses: ctx.losses,
    text: (node) => boxText(node),
    group: (xfrm) => groupTransform(xfrm, (box) => box),
  };
  const o = readDrawingMl(body, reading);
  if (!o || o.kind === 'text-only') {
    if (o?.kind === 'text-only') return { ...o, kind: 'shape', shape: 'rectangle', x: 0, y: 0, fillLook: { type: 'none' }, line: { style: 'none' } };
    return null;
  }
  if (o.kind === 'group') {
    // The group's members sit from its own top left, as the anchor places the group.
    const shift = (c) => { c.x -= o.x; c.y -= o.y; for (const k of c.children ?? []) shift(k); };
    for (const c of o.children) shift(c);
    o.x = 0; o.y = 0;
    o.w = w || o.w; o.h = h || o.h;
  }
  const docPr = kid(holder, WP, 'docPr');
  const name = docPr?.getAttribute('name');
  const title = docPr?.getAttribute('title');
  const descr = docPr?.getAttribute('descr');
  if (name && !/^(Picture|Shape|Text Box|Group|Image) \d+$/.test(name)) o.name = name.slice(0, 200);
  if (title) o.title = title.slice(0, 200);
  if (descr) o.description = descr.slice(0, 5000);
  if (find(body, 'txbxContent') && [...find(body, 'txbxContent').getElementsByTagNameNS(NS.w, 'rPr')].length) ctx.losses?.add?.('Formatting of the text in text boxes, kept as plain text');
  if (!anchor) {
    o.anchor = { type: 'as-char' };
    o.wrap = 'through';
    o.x = 0; o.y = 0;
    return o;
  }
  // The wrap, its spacing, and whether the drawing is behind the text.
  const wrapNode = kids(anchor, WP).find((k) => k.localName.startsWith('wrap'));
  let wrap = 'through';
  if (wrapNode?.localName === 'wrapSquare') wrap = WRAP_FROM_SQUARE[wrapNode.getAttribute('wrapText')] ?? 'parallel';
  else if (wrapNode?.localName === 'wrapTight' || wrapNode?.localName === 'wrapThrough') wrap = 'contour';
  else if (wrapNode?.localName === 'wrapTopAndBottom') wrap = 'none';
  else if (anchor.getAttribute('behindDoc') === '1') wrap = 'background';
  o.wrap = wrap;
  const gap = Math.max(0, ...['distL', 'distR', 'distT', 'distB'].map((d) => Number(anchor.getAttribute(d) ?? 0) / EMU_PER_PX));
  if (gap) o.gap = Math.round(gap * 100) / 100;
  // Where it stands: from the column or the page across, from the paragraph or the page down.
  const positionH = kid(anchor, WP, 'positionH');
  const positionV = kid(anchor, WP, 'positionV');
  const across = positionH?.getAttribute('relativeFrom') ?? 'column';
  const down = positionV?.getAttribute('relativeFrom') ?? 'paragraph';
  const offset = (pos) => Number(kid(pos, WP, 'posOffset')?.textContent ?? 0) / EMU_PER_PX;
  const aligned = (pos) => kid(pos, WP, 'align')?.textContent?.trim() ?? null;
  const fromPage = ['page', 'leftMargin', 'rightMargin', 'insideMargin', 'outsideMargin'].includes(across);
  const width = fromPage ? ctx.page.column + ctx.page.left * 2 : ctx.page.column;
  const left = fromPage ? -ctx.page.left : 0;
  const hAlign = aligned(positionH);
  let x = fromPage ? offset(positionH) - ctx.page.left : offset(positionH);
  if (hAlign === 'left' || hAlign === 'inside') x = left;
  else if (hAlign === 'center') x = left + (width - w) / 2;
  else if (hAlign === 'right' || hAlign === 'outside') x = left + width - w;
  let y = offset(positionV);
  const vAlign = aligned(positionV);
  if (['page', 'margin', 'topMargin', 'bottomMargin'].includes(down)) {
    o.anchor = { type: 'page', page: ctx.pageNumber ?? 1 };
    if (down === 'page') y -= ctx.page.top;
    if (vAlign === 'top') y = down === 'page' ? -ctx.page.top : 0;
  } else {
    o.anchor = { type: 'char' };
  }
  o.x = x;
  o.y = y;
  const z = Number(anchor.getAttribute('relativeHeight'));
  if (Number.isFinite(z)) o.relativeHeight = z;
  return o;
}

/** Orders read drawings by Word's stacking heights, as small numbers. */
export function stackDrawings(list) {
  [...list].sort((a, b) => (a.relativeHeight ?? 0) - (b.relativeHeight ?? 0)).forEach((o, i) => { o.z = i; delete o.relativeHeight; });
  return list;
}

/** A shape as wps:wsp, its text in a text box. */
function shapeXml(o, ctx) {
  const look = flippedPath(o);
  const text = o.text ? tag('wps:txbx', {}, tag('w:txbxContent', {}, String(o.text).split('\n').map((line) => tag('w:p', {},
    tag('w:pPr', {}, tag('w:jc', { 'w:val': { left: 'left', center: 'center', right: 'right' }[o.textLook?.align ?? (o.frame ? 'left' : 'center')] })),
    line ? tag('w:r', {}, tag('w:t', { 'xml:space': 'preserve' }, line)) : null)))) : null;
  return tag('wps:wsp', {},
    tag('wps:cNvSpPr', o.text ? { txBox: o.frame || (o.fillLook?.type === 'none' && o.line?.style === 'none') ? '1' : null } : {}),
    tag('wps:spPr', {}, xfrmXml({ ...look, x: 0, y: 0 }, emu), geometryXml(look, emu), fillXml({ ...TEXT_DRAWING_DEFAULTS.fill, ...o.fillLook }), lineXml({ ...TEXT_DRAWING_DEFAULTS.line, ...o.line }, emu)),
    text,
    tag('wps:bodyPr', { anchor: { top: 't', middle: 'ctr', bottom: 'b' }[o.textLook?.valign ?? (o.frame ? 'top' : 'middle')], lIns: String(emu(6)), tIns: String(emu(4)), rIns: String(emu(6)), bIns: String(emu(4)) }));
}

/** A picture as pic:pic. */
function pictureXml(o, ctx, rel, n) {
  return tag('pic:pic', {},
    tag('pic:nvPicPr', {}, tag('pic:cNvPr', { id: String(n), name: o.name ?? `Image ${n}`, descr: o.description ?? null }), tag('pic:cNvPicPr')),
    tag('pic:blipFill', {}, tag('a:blip', { 'r:embed': rel }, blipEffects(o)), srcRectXml(o), tag('a:stretch', {}, tag('a:fillRect'))),
    tag('pic:spPr', {}, xfrmXml({ ...o, x: 0, y: 0 }, emu), tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')), o.line ? lineXml(o.line, emu) : null));
}

/** The members of a group, each placed from the group's top left. */
function groupXml(o, ctx) {
  const member = (c) => {
    if (c.kind === 'group') {
      return tag('wpg:grpSp', {}, tag('wpg:cNvGrpSpPr'), tag('wpg:grpSpPr', {}, groupFrame(c)), (c.children ?? []).map(member).filter(Boolean));
    }
    if (c.kind === 'image') {
      const rel = ctx.picture(c.resource);
      return rel ? pictureXml(c, ctx, rel, ctx.nextId()) : null;
    }
    const sp = shapeXml(c, ctx);
    sp.children.find((k) => k?.name === 'wps:spPr').children[0] = xfrmXml(flippedPath(c), emu);
    return sp;
  };
  return tag('wpg:wgp', {}, tag('wpg:cNvGrpSpPr'), tag('wpg:grpSpPr', {}, groupFrame(o)), (o.children ?? []).map(member).filter(Boolean));
}

function groupFrame(o) {
  const off = tag('a:off', { x: String(emu(o.x)), y: String(emu(o.y)) });
  const ext = tag('a:ext', { cx: String(emu(o.w)), cy: String(emu(o.h)) });
  return tag('a:xfrm', {}, off, ext, tag('a:chOff', { x: String(emu(o.x)), y: String(emu(o.y)) }), tag('a:chExt', { cx: String(emu(o.w)), cy: String(emu(o.h)) }));
}

/**
 * One drawing of the text as a w:drawing: floating where it is anchored, or in line.
 * @param {Object} o
 * @param {{picture: (resource) => ?string, nextId: () => number, page: {left: number, top: number}}} ctx
 */
export function writeDocxDrawing(o, ctx) {
  const n = ctx.nextId();
  const type = o.anchor?.type ?? 'char';
  let body;
  let uri;
  if (o.kind === 'scene3d') return null;
  if (o.kind === 'image') {
    const rel = ctx.picture(o.resource);
    if (!rel) return null;
    body = pictureXml(o, ctx, rel, n);
    uri = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  } else if (o.kind === 'group') {
    // Members are placed from the group's own top left.
    const local = structuredClone(o);
    const shift = (c) => { c.x -= o.x; c.y -= o.y; for (const k of c.children ?? []) shift(k); };
    for (const c of local.children ?? []) shift(c);
    local.x = 0; local.y = 0;
    body = groupXml(local, ctx);
    uri = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
  } else if (o.kind === 'shape' || o.kind === 'path') {
    body = shapeXml(o, ctx);
    uri = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
  } else return null;
  const graphic = tag('a:graphic', { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main' }, tag('a:graphicData', { uri }, body));
  const docPr = tag('wp:docPr', { id: String(n), name: o.name ?? `${o.kind === 'image' ? 'Image' : 'Shape'} ${n}`, descr: o.description ?? null, title: o.title ?? null });
  const extent = tag('wp:extent', { cx: String(emu(Math.max(o.w, 0.01))), cy: String(emu(Math.max(o.h, 0.01))) });
  if (type === 'as-char') {
    return tag('w:drawing', {}, tag('wp:inline', { distT: '0', distB: '0', distL: '0', distR: '0' }, extent, tag('wp:effectExtent', { l: '0', t: '0', r: '0', b: '0' }), docPr, tag('wp:cNvGraphicFramePr'), graphic));
  }
  const page = type === 'page';
  const gap = String(emu(o.gap ?? 0));
  const wrap = o.wrap === 'none' ? tag('wp:wrapTopAndBottom')
    : o.wrap === 'contour' ? tag('wp:wrapTight', { wrapText: 'bothSides' }, tag('wp:wrapPolygon', { edited: '0' }, tag('wp:start', { x: '0', y: '0' }), tag('wp:lineTo', { x: '0', y: '21600' }), tag('wp:lineTo', { x: '21600', y: '21600' }), tag('wp:lineTo', { x: '21600', y: '0' }), tag('wp:lineTo', { x: '0', y: '0' })))
      : WRAP_TO_SQUARE[o.wrap] ? tag('wp:wrapSquare', { wrapText: WRAP_TO_SQUARE[o.wrap] })
        : tag('wp:wrapNone');
  return tag('w:drawing', {}, tag('wp:anchor', {
    distT: gap, distB: gap, distL: gap, distR: gap, simplePos: '0', relativeHeight: String(251658240 + Math.round(o.z ?? 0) * 1024), behindDoc: o.wrap === 'background' ? '1' : '0',
    locked: '0', layoutInCell: '1', allowOverlap: '1',
  },
  tag('wp:simplePos', { x: '0', y: '0' }),
  tag('wp:positionH', { relativeFrom: page ? 'page' : 'column' }, tag('wp:posOffset', {}, String(emu(o.x + (page ? ctx.page.left : 0))))),
  tag('wp:positionV', { relativeFrom: page ? 'page' : 'paragraph' }, tag('wp:posOffset', {}, String(emu(o.y + (page ? ctx.page.top : 0))))),
  extent, tag('wp:effectExtent', { l: '0', t: '0', r: '0', b: '0' }), wrap, docPr, tag('wp:cNvGraphicFramePr'), graphic));
}
