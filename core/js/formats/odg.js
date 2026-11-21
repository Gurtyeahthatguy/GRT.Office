/** OpenDocument drawings to and from Graphs' document: pages of nodes, connectors and drawing objects. */

import { NS, kids, kid, attr, is, tag, xmlDocument } from '../xml.js';
import { parseLength, formatLength } from '../units.js';
import { Losses } from '../losses.js';
import {
  odfDocuments, OdfStyles, MIMETYPES, ODF_VERSION, ROOT_NAMESPACES, odfPackage, odfText, internalHref, extensionOf, MEDIA_TYPES, toBase64, fromBase64,
} from './odf.js';
import { declareExternal } from './external.js';
import { presetDefinition } from '../draw/geometry.js';
import {
  readOdfDrawing, writeOdfDrawing, graphicProperties, odfBox, lookFromProperties, namedFills, linkConnectors, geometryFromFile,
} from './draw-odf.js';
import { connectorPoints } from '../draw/render.js';
import { naturalSize } from '../images.js';

const PX_PER_MM = 96 / 25.4;
const MARGIN = 20;

const px = (text) => {
  const mm = parseLength(text);
  return mm === null ? null : mm * PX_PER_MM;
};
const cm = (pixels) => formatLength(pixels / PX_PER_MM, 'cm');

// A preset shape's first four glue points sit on the middle of each side.
const GLUE = ['top', 'right', 'bottom', 'left'];
const ROUTING = { standard: 'orthogonal', line: 'straight', lines: 'straight', curve: 'curved' };
const CONNECTOR = { orthogonal: 'standard', straight: 'line', curved: 'curve' };
const OFFICEOOO = 'http://openoffice.org/2009/office';

const DEFAULT_STYLES = {
  default: { fill: '#ffffff', stroke: '#333333', strokeWidth: 2 },
  accent: { fill: '#e8f0fe', stroke: '#1f6feb', strokeWidth: 2 },
  warn: { fill: '#fff4e5', stroke: '#b26a00', strokeWidth: 2 },
  text: { fill: 'none', stroke: 'none', strokeWidth: 0 },
};

// Reading

/**
 * @param {import('../package.js').Package|string} source
 * @returns {{document: object, losses: Losses}}
 */
export function readOdg(source) {
  const docs = odfDocuments(source);
  if (docs.mimetype && !docs.mimetype.startsWith(MIMETYPES.graphics)) {
    throw new Error('This OpenDocument file is not a drawing');
  }
  const body = kid(kid(docs.content.documentElement, NS.office, 'body'), NS.office, 'drawing');
  if (!body) throw new Error('This document has no drawing in it');
  const styles = new OdfStyles([docs.styles, docs.content].filter(Boolean), docs.content);
  const losses = new Losses();
  if (typeof source !== 'string' && source.damage) losses.add('The file was damaged, and only what could still be read was opened');
  declareExternal(source, losses);
  const fills = namedFills(docs.styles?.documentElement ?? docs.content.documentElement);
  const pkg = typeof source === 'string' ? null : source;

  const looks = new Map();
  let ids = 0;
  const pages = kids(body, NS.draw, 'page').slice(0, 1000).map((page, n) => {
    const reader = { styles, losses, fills, pkg, looks, nodes: [], edges: [], objects: [], comments: [], byName: new Map(), id: () => `x${(ids += 1)}` };
    const connectors = [];
    collect(page, reader, connectors);
    for (const connector of connectors) readConnector(connector, reader);
    linkConnectors(reader.objects);
    return { name: attr(page, NS.draw, 'name') ?? `Page ${n + 1}`, nodes: reader.nodes, edges: reader.edges, objects: reader.objects, comments: reader.comments };
  });
  if (!pages.length) pages.push({ name: 'Page 1', nodes: [], edges: [], objects: [], comments: [] });

  const graphStyles = {};
  for (const [name, look] of looks) graphStyles[name] = look;
  return {
    document: {
      version: 1, type: 'graphs', nodes: pages[0].nodes, edges: pages[0].edges, pages,
      styles: { ...DEFAULT_STYLES, ...graphStyles }, meta: { gridSize: 10, snapToGrid: true },
    },
    losses,
  };
}

/** What the drawing reader needs from this file: boxes, looks with their named fills, pictures as data. */
function drawingContext(reader) {
  return {
    box: boxOf,
    toPx: px,
    id: reader.id,
    losses: reader.losses,
    picture: (href) => pictureData(href, reader),
    look: (n) => {
      const props = { ...reader.styles.resolve('graphic', attr(n, NS.draw, 'style-name'), 'graphic') };
      if (props['fill-gradient-name']) props.gradient = reader.fills.gradients[props['fill-gradient-name']];
      if (props['fill-hatch-name']) props.hatch = reader.fills.hatches[props['fill-hatch-name']];
      return lookFromProperties(props, px);
    },
  };
}

/** A picture of the package as a data address, which Graphs keeps inside its own document. */
function pictureData(href, reader) {
  const path = internalHref(href);
  if (!path || !reader.pkg) return null;
  const bytes = reader.pkg.bytes(path);
  const extension = extensionOf(path);
  if (!bytes || !['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension) || bytes.length > 20 * 1024 * 1024) return null;
  return `data:${MEDIA_TYPES[extension] ?? 'application/octet-stream'};base64,${toBase64(bytes)}`;
}

/** A shape's box, with its turn read from draw:transform. */
const boxOf = (node) => odfBox(node, px);

function collect(container, reader, connectors, link = null) {
  for (const node of kids(container)) {
    // A comment on the page: its place and its text; who wrote it and when are not kept.
    if (node.namespaceURI === OFFICEOOO && node.localName === 'annotation') {
      readAnnotation(node, reader);
      continue;
    }
    if (node.namespaceURI !== NS.draw) continue;
    const kind = node.localName;
    if (kind === 'a') {
      const href = node.getAttributeNS(NS.xlink, 'href');
      collect(node, reader, connectors, href ? href.slice(0, 2048) : null);
    } else if (kind === 'g') {
      // A group of plain drawings stays one; a group holding text is opened up into nodes.
      const texty = [...node.getElementsByTagNameNS(NS.text, 'p')].some((p) => p.textContent.trim());
      const group = texty ? null : readOdfDrawing(node, drawingContext(reader));
      if (group) reader.objects.push(group); else collect(node, reader, connectors, link);
    } else if (kind === 'connector') {
      connectors.push(node);
    } else if (kind === 'line' || kind === 'path' || kind === 'polygon' || kind === 'polyline') {
      const drawn = readOdfDrawing(node, drawingContext(reader));
      if (drawn) reader.objects.push(drawn);
    } else if (kind === 'frame' && !kid(node, NS.draw, 'text-box')) {
      const drawn = kid(node, NS.draw, 'image') ? readOdfDrawing(node, drawingContext(reader)) : null;
      if (drawn) reader.objects.push(drawn);
      else reader.losses.add(kid(node, NS.draw, 'image') ? 'Pictures that could not be read' : 'Charts and embedded objects');
    } else {
      const before = reader.nodes.length;
      readShape(node, reader);
      if (link && reader.nodes.length > before) reader.nodes[reader.nodes.length - 1].link = link;
    }
  }
}

function readAnnotation(node, reader) {
  if (reader.comments.length >= 500) return;
  if (kids(node).some((k) => k.localName === 'creator' || k.localName === 'date')) reader.losses.add('Names and dates on comments, left out');
  const text = kids(node, NS.text, 'p').map((p) => p.textContent).join('\n').slice(0, 100_000);
  if (text.trim() === '') return;
  reader.comments.push({ id: `c${reader.comments.length + 1}`, x: Math.round(px(attr(node, NS.svg, 'x')) ?? 0), y: Math.round(px(attr(node, NS.svg, 'y')) ?? 0), text });
}

/** A shape as a node: its shape, place, turn, look and text, the text's look over the whole of it. */
function readShape(element, reader) {
  const { losses } = reader;
  const kind = element.localName;
  let shape = null;
  let geometry = null;
  let mods = null;
  const flips = {};
  if (kind === 'custom-shape') {
    const node = kid(element, NS.draw, 'enhanced-geometry');
    const type = attr(node, NS.draw, 'type') ?? '';
    if (presetDefinition(type) && type !== 'non-primitive' && !/^mso-spt/.test(type)) {
      shape = type;
      const m = String(attr(node, NS.draw, 'modifiers') ?? '').trim();
      if (m) mods = m.split(/\s+/).map(Number).filter(Number.isFinite).slice(0, 20);
    } else {
      shape = 'custom';
      geometry = geometryFromFile(node);
      if (!geometry.path) { losses.add('Shapes whose outline could not be read, drawn as rectangles'); shape = 'rectangle'; geometry = null; }
    }
    if (attr(node, NS.draw, 'mirror-horizontal') === 'true') flips.flipH = true;
    if (attr(node, NS.draw, 'mirror-vertical') === 'true') flips.flipV = true;
  } else if (kind === 'rect') {
    shape = parseLength(attr(element, NS.draw, 'corner-radius')) > 0 ? 'round-rectangle' : 'rectangle';
  } else if (kind === 'ellipse' || kind === 'circle') {
    shape = 'ellipse';
  } else if (kind === 'frame') {
    shape = 'rectangle';
  } else {
    if (['control', 'measure', 'caption'].includes(kind)) losses.add('Callouts, dimension lines and form controls');
    return;
  }
  const box = boxOf(element);
  if (!box) return;
  const holder = kind === 'frame' ? kid(element, NS.draw, 'text-box') : element;
  const text = plain(holder, reader);
  const id = reader.id();
  const name = attr(element, NS.draw, 'id') ?? attr(element, 'http://www.w3.org/XML/1998/namespace', 'id');
  if (name) reader.byName.set(name, id);
  const look = kind === 'frame' ? { fill: 'none', stroke: 'none', strokeWidth: 0 } : null;
  const props = reader.styles.resolve('graphic', attr(element, NS.draw, 'style-name'), 'graphic');
  const node = {
    id, shape, x: Math.round(box.x), y: Math.round(box.y), w: Math.max(20, Math.round(box.w)), h: Math.max(20, Math.round(box.h)),
    ...(box.rotation ? { rotation: Math.round(box.rotation * 100) / 100 } : {}), ...flips,
    ...(geometry ? { geometry } : {}), ...(mods ? { mods } : {}),
    text, style: look ? styleFor(look, reader) : lookFor(element, reader), data: {},
  };
  // What a style of fill and outline cannot say, the node keeps itself.
  if (!look && (['gradient', 'hatch'].includes(props.fill) || props.stroke === 'dash' || props['marker-start'] || props['marker-end'] || props.shadow === 'visible')) {
    Object.assign(node, drawingContext(reader).look(element));
  }
  const textLook = readTextLook(holder, props, reader);
  if (textLook) node.textLook = textLook;
  const title = kid(element, NS.svg, 'title')?.textContent;
  const desc = kid(element, NS.svg, 'desc')?.textContent;
  const objectName = attr(element, NS.draw, 'name');
  if (objectName) node.name = objectName.slice(0, 200);
  if (title) node.title = title.slice(0, 200);
  if (desc) node.description = desc.slice(0, 5000);
  reader.nodes.push(node);
}

/** The node style a shape's fill and outline match, made when none does. */
function lookFor(element, reader) {
  const props = reader.styles.resolve('graphic', attr(element, NS.draw, 'style-name'), 'graphic');
  return styleFor({
    fill: props.fill === 'none' ? 'none' : (props['fill-color'] ?? '#729fcf').toLowerCase(),
    stroke: props.stroke === 'none' ? 'none' : (props['stroke-color'] ?? '#3465a4').toLowerCase(),
    strokeWidth: Math.max(1, Math.round(px(props['stroke-width']) ?? 1)),
  }, reader);
}

function styleFor(look, reader) {
  const same = (a) => a.fill === look.fill && a.stroke === look.stroke && (a.strokeWidth === look.strokeWidth || look.stroke === 'none');
  for (const [name, existing] of [...Object.entries(DEFAULT_STYLES), ...reader.looks]) if (same(existing)) return name;
  const name = `imported-${reader.looks.size + 1}`;
  reader.looks.set(name, look);
  return name;
}

/** A node's text look from the first paragraph and span of its text, and its anchor; mixed looks keep the first. */
function readTextLook(holder, graphicProps, reader) {
  const p = holder && [...holder.getElementsByTagNameNS(NS.text, 'p')][0];
  const span = p && [...p.getElementsByTagNameNS(NS.text, 'span')][0];
  const para = p ? reader.styles.resolve('paragraph', attr(p, NS.text, 'style-name'), 'paragraph') : {};
  const text = {
    ...(p ? reader.styles.resolve('paragraph', attr(p, NS.text, 'style-name'), 'text') : {}),
    ...(span ? reader.styles.resolve('text', attr(span, NS.text, 'style-name'), 'text') : {}),
  };
  const look = {};
  if (text['font-weight'] === 'bold' || Number(text['font-weight']) >= 600) look.bold = true;
  if (text['font-style'] === 'italic') look.italic = true;
  if (text['text-underline-style'] && text['text-underline-style'] !== 'none') look[text['text-underline-type'] === 'double' ? 'double' : 'underline'] = true;
  if (text['text-line-through-style'] && text['text-line-through-style'] !== 'none') look.strike = true;
  if (text['text-overline-style'] && text['text-overline-style'] !== 'none') look.overline = true;
  if (/^super|^\d/.test(text['text-position'] ?? '') && !/^-/.test(text['text-position'])) look.sup = true;
  if (/^sub|^-/.test(text['text-position'] ?? '')) look.sub = true;
  if (text['text-shadow'] && text['text-shadow'] !== 'none') look.shadow = true;
  if (text['text-outline'] === 'true') look.outline = true;
  if (text['font-variant'] === 'small-caps') look.smallcaps = true;
  const size = parseLength(text['font-size']);
  if (size) look.size = Math.round((size / 25.4) * 72 * (96 / 72) * 100) / 100;
  if (text.color) look.color = text.color.toLowerCase();
  const font = text['font-family'] ?? text['font-name'];
  if (font) look.font = font.replace(/^'|'$/g, '');
  const align = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right', justify: 'justify' }[para['text-align']];
  if (align && align !== 'center') look.align = align;
  const valign = { top: 'top', middle: 'middle', bottom: 'bottom' }[graphicProps['textarea-vertical-align']];
  if (valign && valign !== 'middle') look.valign = valign;
  if (/%$/.test(para['line-height'] ?? '')) look.lineSpacing = Number(para['line-height'].replace('%', '')) / 100;
  const below = px(para['margin-bottom']);
  if (below) look.paraSpacing = Math.round(below);
  const indent = px(para['margin-left']);
  if (indent) look.indent = Math.round(indent);
  const list = holder && [...holder.getElementsByTagNameNS(NS.text, 'list')][0];
  if (list) look.list = list.getElementsByTagNameNS(NS.text, 'list-level-style-number').length || /^\d/.test(list.textContent) ? 'number' : 'bullet';
  // Two spans that differ, as a word in bold among plain ones, are kept as the first; it is said.
  const spans = holder ? [...holder.getElementsByTagNameNS(NS.text, 'span')] : [];
  if (new Set(spans.map((s) => attr(s, NS.text, 'style-name'))).size > 1) reader.losses.add('Text formatting that changes within a shape, kept as its start');
  return Object.keys(look).length ? look : null;
}

function plain(holder, reader) {
  const lines = [];
  const visit = (parent) => {
    for (const child of kids(parent)) {
      if (is(child, NS.text, 'p') || is(child, NS.text, 'h')) lines.push(paragraphText(child));
      else if (is(child, NS.text, 'list') || is(child, NS.text, 'list-item')) visit(child);
    }
  };
  if (holder) visit(holder);
  return lines.join('\n').trim();
}

function paragraphText(p) {
  let out = '';
  for (const child of p.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue.replace(/[\t\n\r ]+/g, ' ');
    else if (is(child, NS.text, 's')) out += ' '.repeat(Math.min(Number(attr(child, NS.text, 'c') ?? 1), 1000));
    else if (is(child, NS.text, 'line-break')) out += '\n';
    else if (is(child, NS.text, 'tab')) out += '\t';
    else if (child.nodeType === 1) out += paragraphText(child);
  }
  return out;
}

function readConnector(element, reader) {
  const from = reader.byName.get(attr(element, NS.draw, 'start-shape'));
  const to = reader.byName.get(attr(element, NS.draw, 'end-shape'));
  if (!from || !to) {
    // A line not joined to two nodes is a drawing of its own.
    const drawn = readOdfDrawing(element, drawingContext(reader));
    if (drawn) reader.objects.push(drawn);
    return;
  }
  const port = (name) => {
    const value = attr(element, NS.draw, name);
    return value === null ? 'auto' : GLUE[Number(value)] ?? 'auto';
  };
  const props = reader.styles.resolve('graphic', attr(element, NS.draw, 'style-name'), 'graphic');
  const reversed = !!props['marker-start'] && !props['marker-end'];
  if (!props['marker-start'] && !props['marker-end']) reader.losses.add('Lines without arrowheads, drawn with one');
  reader.edges.push({
    id: reader.id(),
    from: reversed ? to : from,
    to: reversed ? from : to,
    fromPort: port(reversed ? 'end-glue-point' : 'start-glue-point'),
    toPort: port(reversed ? 'start-glue-point' : 'end-glue-point'),
    routing: ROUTING[attr(element, NS.draw, 'type') ?? 'standard'] ?? 'orthogonal',
    label: plain(element, reader),
    style: 'arrow',
    waypoints: [],
    data: {},
  });
}

// Writing

/** Placement attributes: coordinates, or a transform when turned. */
function placementAt(o, dx, dy) {
  const w = Math.max(0, o.w);
  const h = Math.max(0, o.h);
  if (!o.rotation) return { 'svg:x': cm(o.x + dx), 'svg:y': cm(o.y + dy), 'svg:width': cm(w), 'svg:height': cm(h) };
  const angle = (o.rotation * Math.PI) / 180;
  const cx = o.x + dx + w / 2;
  const cy = o.y + dy + h / 2;
  const tx = cx - (Math.cos(angle) * (w / 2) - Math.sin(angle) * (h / 2));
  const ty = cy - (Math.sin(angle) * (w / 2) + Math.cos(angle) * (h / 2));
  return { 'svg:width': cm(w), 'svg:height': cm(h), 'draw:transform': `rotate (${Number((-angle).toFixed(12))}) translate (${cm(tx)} ${cm(ty)})` };
}

/** The text and paragraph properties of a node's text look. */
function lookProperties(given) {
  const look = given ?? {};
  const pt = (look.size ?? 13) * 0.75;
  return {
    paragraph: {
      'fo:text-align': { left: 'start', right: 'end', justify: 'justify' }[look.align] ?? 'center',
      ...(look.lineSpacing ? { 'fo:line-height': `${Math.round(look.lineSpacing * 100)}%` } : {}),
      ...(look.paraSpacing ? { 'fo:margin-bottom': cm(look.paraSpacing) } : {}),
      ...(look.indent ? { 'fo:margin-left': cm(look.indent) } : {}),
    },
    text: {
      'fo:font-size': `${Math.round(pt * 10) / 10}pt`, 'fo:color': look.color ?? '#222222', 'fo:font-family': look.font ?? 'Liberation Sans',
      ...(look.bold ? { 'fo:font-weight': 'bold' } : {}), ...(look.italic ? { 'fo:font-style': 'italic' } : {}),
      ...(look.underline || look.double ? { 'style:text-underline-style': 'solid', 'style:text-underline-type': look.double ? 'double' : 'single', 'style:text-underline-color': 'font-color' } : {}),
      ...(look.strike ? { 'style:text-line-through-style': 'solid' } : {}),
      ...(look.overline ? { 'style:text-overline-style': 'solid', 'style:text-overline-color': 'font-color' } : {}),
      ...(look.sup ? { 'style:text-position': 'super 58%' } : look.sub ? { 'style:text-position': 'sub 58%' } : {}),
      ...(look.shadow ? { 'fo:text-shadow': '1pt 1pt' } : {}), ...(look.outline ? { 'style:text-outline': 'true' } : {}),
      ...(look.smallcaps ? { 'fo:font-variant': 'small-caps' } : {}),
    },
  };
}

/**
 * @param {object} document Graphs' toJSON()
 * @param {{flat?: boolean}} options
 * @returns {{entries?: object[], text?: string, losses: Losses}}
 */
export function writeOdg(document, { flat = false } = {}) {
  const losses = new Losses();
  const pages = Array.isArray(document.pages) && document.pages.length ? document.pages : [{ name: 'page1', nodes: document.nodes ?? [], edges: document.edges ?? [], objects: [], comments: document.meta?.comments ?? [] }];
  const styles = { ...DEFAULT_STYLES, ...(document.styles ?? {}) };
  const all = pages.flatMap((p) => [...(p.nodes ?? []), ...(p.objects ?? [])]);

  // One page size for every page, holding the largest drawing.
  const minX = Math.min(0, ...all.map((n) => n.x - MARGIN));
  const minY = Math.min(0, ...all.map((n) => n.y - MARGIN));
  const dx = -minX;
  const dy = -minY;
  const width = Math.max(200, ...all.map((n) => n.x + n.w + dx + MARGIN));
  const height = Math.max(200, ...all.map((n) => n.y + n.h + dy + MARGIN));

  const automatic = new Map();
  const style = (family, prefix, properties) => {
    const key = JSON.stringify([family, properties]);
    if (!automatic.has(key)) {
      const count = [...automatic.values()].filter((s) => s.attrs['style:name'].startsWith(prefix)).length + 1;
      automatic.set(key, tag('style:style', { 'style:name': `${prefix}${count}`, 'style:family': family }, properties));
    }
    return automatic.get(key).attrs['style:name'];
  };
  const named = new Map();
  const pictures = new Map();
  const pictureHref = (resource) => {
    const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(String(resource ?? ''));
    if (!m) return null;
    if (!pictures.has(resource)) {
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' }[m[1]] ?? 'png';
      pictures.set(resource, { name: `Pictures/image${pictures.size + 1}.${extension}`, data: fromBase64(m[2]), mediaType: m[1] });
    }
    return pictures.get(resource).name;
  };
  const paragraphFor = (look) => {
    const p = lookProperties(look);
    return style('paragraph', 'P', [tag('style:paragraph-properties', p.paragraph), tag('style:text-properties', p.text)]);
  };
  const textOf = (text, look) => {
    const paragraph = paragraphFor(look);
    const lines = String(text ?? '').split('\n').map((line) => tag('text:p', { 'text:style-name': paragraph }, odfText(line)));
    if (!look?.list || !text) return lines;
    return tag('text:list', {}, lines.map((p) => tag('text:list-item', {}, p)));
  };
  // Connector ids name shapes across one page; numbered in writing order, so the same drawing gives the same bytes.
  const odfIds = new Map();
  const odfId = (id) => { if (!odfIds.has(id)) odfIds.set(id, `shape${odfIds.size + 1}`); return odfIds.get(id); };

  const drawPages = pages.map((page, pageIndex) => {
    const nodes = page.nodes ?? [];
    const edges = page.edges ?? [];
    const objects = page.objects ?? [];
    const shapes = nodes.map((node) => {
      const look = styles[node.style] ?? styles.default;
      const o = {
        id: node.id, kind: 'shape', shape: node.shape === 'custom' && node.geometry ? 'custom' : node.shape, geometry: node.geometry, mods: node.mods,
        x: node.x, y: node.y, w: node.w, h: node.h, rotation: node.rotation ?? 0, flipH: node.flipH, flipV: node.flipV,
        name: node.name, title: node.title, description: node.description,
        fillLook: node.fillLook ?? (look.fill === 'none' ? { type: 'none' } : { type: 'solid', color: look.fill }),
        line: node.line ?? (look.stroke === 'none' ? { style: 'none' } : { color: look.stroke, width: look.strokeWidth ?? 2 }),
        shadow: node.shadow, textLook: { anchor: node.textLook?.valign ?? 'middle', padding: 4 },
      };
      const shape = writeOdfDrawing(o, {
        style: (x) => style('graphic', 'gr', [tag('style:graphic-properties', { ...graphicProperties(x, { len: cm, named: (k, n, xml) => named.set(`${k}:${n}`, xml) }), 'draw:auto-grow-height': 'false' })]),
        placement: (x) => placementAt(x, dx, dy), len: cm, picture: pictureHref, odfId,
        text: () => textOf(node.text, node.textLook),
      });
      if (!shape) { losses.add('Shapes that could not be written, left out'); return null; }
      shape.attrs['draw:text-style-name'] = paragraphFor(node.textLook);
      // A node's link wraps it, as ODF links a shape.
      return typeof node.link === 'string' && node.link !== '' ? tag('draw:a', { 'xlink:type': 'simple', 'xlink:href': node.link }, shape) : shape;
    });
    const drawn = [...objects].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((object) => {
      const o = { ...object, ...(object.kind === 'image' && pictureBytes(object.resource) ? { natural: naturalSize(pictureBytes(object.resource)) } : {}) };
      return writeOdfDrawing(o, {
        style: (x) => style('graphic', 'gr', [tag('style:graphic-properties', graphicProperties(x, { len: cm, named: (k, n, xml) => named.set(`${k}:${n}`, xml) }, { line: { color: '#333333', width: 2 }, fill: { type: 'solid', color: '#729fcf' } }))]),
        placement: (x) => placementAt(x, dx, dy), len: cm, picture: pictureHref, odfId,
        connectorPoints: (c) => connectorPoints(c, objects).map((q) => ({ x: q.x + dx, y: q.y + dy })),
      });
    });
    const comments = (page.comments ?? []).filter((c) => typeof c?.text === 'string' && c.text !== '').map((c) => tag('officeooo:annotation', {
      'svg:x': cm((c.x ?? 0) + dx), 'svg:y': cm((c.y ?? 0) + dy), 'svg:width': cm(160), 'svg:height': cm(80),
    }, String(c.text).split('\n').map((line) => tag('text:p', {}, odfText(line)))));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const connectorStyle = style('graphic', 'gr', [tag('style:graphic-properties', {
      'draw:stroke': 'solid', 'svg:stroke-color': '#333333', 'svg:stroke-width': cm(2),
      'draw:marker-end': 'Arrow', 'draw:marker-end-width': cm(10), 'draw:fill': 'none', 'draw:shadow': 'hidden',
    })]);
    const connectors = edges.map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) {
        losses.add('Lines whose ends are missing, left out');
        return null;
      }
      if ((edge.waypoints ?? []).length > 0) losses.add('Bends placed by hand, routed again');
      const glue = (port) => (GLUE.includes(port) ? String(GLUE.indexOf(port)) : null);
      return tag('draw:connector', {
        'draw:style-name': connectorStyle, 'draw:text-style-name': paragraphFor(null), 'draw:type': CONNECTOR[edge.routing] ?? 'standard',
        'svg:x1': cm(from.x + from.w / 2 + dx), 'svg:y1': cm(from.y + from.h / 2 + dy),
        'svg:x2': cm(to.x + to.w / 2 + dx), 'svg:y2': cm(to.y + to.h / 2 + dy),
        'draw:start-shape': odfId(edge.from), 'draw:start-glue-point': glue(edge.fromPort),
        'draw:end-shape': odfId(edge.to), 'draw:end-glue-point': glue(edge.toPort),
      }, edge.label ? textOf(edge.label, null) : null);
    });
    return tag('draw:page', { 'draw:name': page.name ?? `page${pageIndex + 1}`, 'draw:master-page-name': 'Default' }, drawn, shapes, connectors, comments);
  });

  const namespaces = { ...ROOT_NAMESPACES, 'xmlns:officeooo': OFFICEOOO, 'office:version': ODF_VERSION };
  const markers = tag('office:styles', {},
    named.has('marker:Arrow') ? null : tag('draw:marker', { 'draw:name': 'Arrow', 'svg:viewBox': '0 0 20 30', 'svg:d': 'M10 0l-10 30h20z' }),
    [...named.values()]);
  const layout = tag('style:page-layout', { 'style:name': 'PM1' }, tag('style:page-layout-properties', {
    'fo:margin-top': '0cm', 'fo:margin-bottom': '0cm', 'fo:margin-left': '0cm', 'fo:margin-right': '0cm',
    'fo:page-width': cm(width), 'fo:page-height': cm(height), 'style:print-orientation': width >= height ? 'landscape' : 'portrait',
  }));
  const masters = tag('office:master-styles', {}, tag('style:master-page', { 'style:name': 'Default', 'style:page-layout-name': 'PM1' }));
  const body = tag('office:body', {}, tag('office:drawing', {}, drawPages));

  if (flat) {
    if (pictures.size) losses.add('Pictures, which a flat file does not carry');
    const root = tag('office:document', { ...namespaces, 'office:mimetype': MIMETYPES.graphics },
      markers, tag('office:automatic-styles', {}, layout, [...automatic.values()]), masters, body);
    return { text: xmlDocument(root), losses };
  }
  const styleDoc = tag('office:document-styles', namespaces, markers, tag('office:automatic-styles', {}, layout), masters);
  const content = tag('office:document-content', namespaces, tag('office:automatic-styles', {}, [...automatic.values()]), body);
  return {
    entries: odfPackage(MIMETYPES.graphics, [
      { name: 'content.xml', data: xmlDocument(content), mediaType: 'text/xml' },
      { name: 'styles.xml', data: xmlDocument(styleDoc), mediaType: 'text/xml' },
      ...[...pictures.values()].map((p) => ({ name: p.name, data: p.data, mediaType: p.mediaType })),
    ]),
    losses,
  };
}

/** The bytes of a picture kept as a data address. */
function pictureBytes(resource) {
  const m = /^data:[\w/+.-]+;base64,(.*)$/.exec(String(resource ?? ''));
  return m ? fromBase64(m[1]) : null;
}

export { DEFAULT_STYLES as ODG_STYLES };
