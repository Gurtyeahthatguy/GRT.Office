/** OpenDocument presentations to and from Slides' document. */

import { NS, kids, kid, attr, is, tag, xmlDocument } from '../xml.js';
import { parseLength, formatLength } from '../units.js';
import { Losses } from '../losses.js';
import { naturalSize } from '../images.js';
import { parsePath, formatPath, mapPath, normalisePath } from '../paths.js';
import {
  odfDocuments, OdfStyles, MIMETYPES, ODF_VERSION, ROOT_NAMESPACES, odfPackage, odfText, internalHref,
  MEDIA_TYPES, extensionOf, fontKind, unquote,
} from './odf.js';

const PX_PER_MM = 96 / 25.4;
const ANIM = 'urn:oasis:names:tc:opendocument:xmlns:animation:1.0';
const SMIL = 'urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0';

const px = (text) => {
  const mm = parseLength(text);
  return mm === null ? null : mm * PX_PER_MM;
};
const cm = (pixels) => formatLength(pixels / PX_PER_MM, 'cm');

const CUSTOM_SHAPES = {
  rectangle: 'rect', 'ooxml-rect': 'rect', 'round-rectangle': 'rounded', 'ooxml-roundRect': 'rounded',
  ellipse: 'ellipse', 'ooxml-ellipse': 'ellipse', circle: 'ellipse', diamond: 'diamond', 'ooxml-diamond': 'diamond',
  parallelogram: 'parallelogram', 'ooxml-parallelogram': 'parallelogram', hexagon: 'hexagon', 'ooxml-hexagon': 'hexagon',
  octagon: 'hexagon', 'isosceles-triangle': 'triangle', 'ooxml-triangle': 'triangle', 'flowchart-process': 'rect',
  'flowchart-decision': 'diamond', 'flowchart-terminator': 'rounded', 'flowchart-alternate-process': 'rounded',
  'flowchart-connector': 'ellipse', 'flowchart-data': 'parallelogram', 'flowchart-preparation': 'hexagon',
  'ooxml-flowChartProcess': 'rect', 'ooxml-flowChartDecision': 'diamond', 'ooxml-flowChartTerminator': 'rounded',
};
// Slides' shapes as LibreOffice's presets, adjusted to the proportions Slides draws them with.
const CUSTOM_TYPES = {
  rect: ['rectangle', null],
  rounded: ['round-rectangle', '2160'],
  ellipse: ['ellipse', null],
  diamond: ['diamond', null],
  parallelogram: ['parallelogram', '4320'],
  hexagon: ['hexagon', '3888'],
  triangle: ['isosceles-triangle', '10800'],
};
// Faces with the metrics of what Slides draws, present wherever LibreOffice is.
const FAMILIES = { sans: 'Liberation Sans', serif: 'Liberation Serif', mono: 'Liberation Mono' };

// Reading

/**
 * @param {import('../package.js').Package|string} source
 * @returns {{document: object, images: Map<string, Uint8Array>, losses: Losses}}
 */
export function readOdp(source) {
  const docs = odfDocuments(source);
  if (docs.mimetype && !docs.mimetype.startsWith(MIMETYPES.presentation)) {
    throw new Error('This OpenDocument file is not a presentation');
  }
  const body = kid(kid(docs.content.documentElement, NS.office, 'body'), NS.office, 'presentation');
  if (!body) throw new Error('This document has no presentation in it');
  return new OdpReader(source, docs, body).read();
}

class OdpReader {
  constructor(source, docs, body) {
    this.pkg = typeof source === 'string' ? null : source;
    this.body = body;
    const named = [docs.styles, docs.content].filter(Boolean);
    this.content = new OdfStyles(named, docs.content);
    this.masterScope = new OdfStyles(named, docs.styles ?? docs.content);
    this.losses = new Losses();
    if (this.pkg?.damage) this.losses.add('The file was damaged, and only what could still be read was opened');
    this.images = new Map();
    this.imageNames = new Map();
    this.ids = 0;
  }

  id(prefix) {
    this.ids += 1;
    return `${prefix}${this.ids}`;
  }

  read() {
    const pages = kids(this.body, NS.draw, 'page');
    if (pages.length === 0) throw new Error('This presentation has no slides');
    const masters = new Map(this.masterScope.masters.map((m) => [attr(m, NS.style, 'name'), m]));
    const firstMaster = masters.get(attr(pages[0], NS.draw, 'master-page-name')) ?? this.masterScope.masters[0] ?? null;

    const layout = firstMaster ? this.masterScope.layouts.get(attr(firstMaster, NS.style, 'page-layout-name')) : null;
    const props = {};
    for (const attribute of kid(layout, NS.style, 'page-layout-properties')?.attributes ?? []) props[attribute.localName] = attribute.value;
    const canvas = {
      w: Math.round(px(props['page-width']) ?? 1067),
      h: Math.round(px(props['page-height']) ?? 600),
    };

    const modelMasters = [];
    const masterInfo = new Map();
    for (const [name, master] of masters) {
      const background = this.pageFill(this.masterScope, attr(master, NS.draw, 'style-name'));
      const elements = this.elements(master, this.masterScope, true);
      elements.forEach((element, i) => { element.z = i - elements.length - 1000; });
      let id = null;
      if (elements.length > 0) {
        id = this.id('m');
        modelMasters.push({ id, name: attr(master, NS.style, 'display-name') ?? name, elements });
      }
      masterInfo.set(name, { id, background });
    }
    const themeBackground = masterInfo.get(attr(firstMaster, NS.style, 'name'))?.background ?? '#ffffff';

    const slides = pages.map((page) => {
      const info = masterInfo.get(attr(page, NS.draw, 'master-page-name')) ?? { id: null, background: null };
      const styleName = attr(page, NS.draw, 'style-name');
      const pageProps = this.content.resolve('drawing-page', styleName, 'page');
      if (pageProps.visibility === 'hidden') this.losses.add('Hidden slides, shown');
      const own = this.pageFill(this.content, styleName);
      const background = own ?? (info.background && info.background !== themeBackground ? info.background : null);
      const elements = this.elements(page, this.content, false);
      elements.forEach((element, i) => { element.z = i + 1; });
      const showsMaster = pageProps['background-objects-visible'] !== 'false';
      return {
        id: this.id('s'),
        master: showsMaster ? info.id : null,
        background,
        section: null,
        notes: this.notes(page),
        transition: this.transition(page, pageProps),
        elements,
      };
    });

    return {
      document: { version: 1, type: 'slides', canvas, theme: { background: themeBackground }, masters: modelMasters, slides },
      images: this.images,
      losses: this.losses,
    };
  }

  pageFill(styles, name) {
    const props = styles.resolve('drawing-page', name, 'page');
    if (props.fill === 'solid' && props['fill-color']) return props['fill-color'].toLowerCase();
    if (['gradient', 'bitmap', 'hatch'].includes(props.fill)) {
      this.losses.add('Picture and gradient backgrounds, shown as one colour');
      return props['fill-color']?.toLowerCase() ?? null;
    }
    return null;
  }

  notes(page) {
    const notes = kid(page, NS.presentation, 'notes');
    for (const frame of kids(notes, NS.draw, 'frame')) {
      if (attr(frame, NS.presentation, 'class') !== 'notes') continue;
      return paragraphsOf(kid(frame, NS.draw, 'text-box')).map(({ p }) => plainText(p)).join('\n').trim();
    }
    return '';
  }

  transition(page, pageProps) {
    const filter = page.getElementsByTagNameNS(ANIM, 'transitionFilter')[0];
    const type = filter ? filter.getAttributeNS(SMIL, 'type') : pageProps.type ?? pageProps['transition-type'];
    const sequence = [...page.getElementsByTagNameNS(ANIM, 'seq')].find((seq) => attr(seq, NS.presentation, 'node-type') === 'main-sequence');
    if (sequence && kids(sequence).length > 0) this.losses.add('Animations');
    if (!type || type === 'none' || type === 'manual' || type === 'automatic') return 'none';
    if (type === 'fade') return 'fade';
    if (/push|slide|wipe|barWipe|cover|uncover/i.test(type)) return 'slide';
    this.losses.add('Slide transitions other than fade and slide, shown as a slide');
    return 'slide';
  }

  // Shapes

  elements(container, styles, onMaster) {
    const out = [];
    for (const node of kids(container)) this.shape(node, styles, onMaster, out);
    return out;
  }

  shape(node, styles, onMaster, out) {
    if (node.namespaceURI !== NS.draw) return;
    const kind = node.localName;
    const placeholder = attr(node, NS.presentation, 'placeholder') === 'true';
    const presentationClass = attr(node, NS.presentation, 'class');
    if (placeholder) return;
    if (onMaster && presentationClass) return;
    if (kind === 'g') {
      for (const child of kids(node)) this.shape(child, styles, onMaster, out);
      return;
    }
    const look = this.graphic(node, styles);
    if (kind === 'line' || kind === 'connector') {
      this.line(node, look, out);
      return;
    }
    const box = boxOf(node);
    if (!box) return;

    if (kind === 'frame') {
      this.frame(node, box, look, styles, out);
      return;
    }
    let shape = null;
    let path = null;
    if (kind === 'rect') shape = parseLength(attr(node, NS.draw, 'corner-radius')) > 0 ? 'rounded' : 'rect';
    else if (kind === 'ellipse' || kind === 'circle') shape = 'ellipse';
    else if (kind === 'polygon' || kind === 'polyline' || kind === 'path') {
      path = outlineOf(node);
      shape = path ? 'path' : 'rect';
      if (!path) this.losses.add('Freeform shapes, drawn as rectangles');
      if (kind === 'polyline') look.fill = 'none';
    } else if (kind === 'custom-shape') {
      const geometry = kid(node, NS.draw, 'enhanced-geometry');
      const type = attr(geometry, NS.draw, 'type') ?? '';
      shape = CUSTOM_SHAPES[type] ?? null;
      if (!shape) {
        path = enhancedOutline(geometry);
        if (path) shape = 'path';
        else {
          this.losses.add(/^non-primitive$|^mso-spt/.test(type) || type === '' ? 'Freeform shapes, drawn as rectangles' : 'Shapes Slides does not have, drawn as rectangles');
          shape = 'rect';
        }
      }
    } else if (kind === 'caption' || kind === 'measure' || kind === 'control') {
      this.losses.add('Callouts, dimension lines and form controls');
      return;
    } else {
      return;
    }
    if (look.fill !== 'none' || look.stroke) {
      out.push({
        id: this.id('e'), kind: 'shape', ...box, shape, ...(path ? { path } : {}), fill: look.fill,
        ...(look.stroke ? { stroke: look.stroke.color, strokeWidth: look.stroke.width } : {}), data: {},
      });
    }
    const text = this.text(node, styles, look);
    if (text) out.push({ id: this.id('e'), kind: 'text', ...box, ...text, data: {} });
  }

  /** Fill, outline and text anchoring, from the shape's graphic or presentation style. */
  graphic(node, styles) {
    const [family, name] = attr(node, NS.presentation, 'style-name')
      ? ['presentation', attr(node, NS.presentation, 'style-name')]
      : ['graphic', attr(node, NS.draw, 'style-name')];
    const props = styles.resolve(family, name, 'graphic');
    const fill = props.fill === 'none' || !props.fill ? 'none'
      : props.fill === 'solid' ? (props['fill-color'] ?? '#729fcf').toLowerCase()
        : (this.losses.add('Gradient and picture fills, shown as one colour'), (props['fill-color'] ?? '#729fcf').toLowerCase());
    const stroke = props.stroke && props.stroke !== 'none'
      ? { color: (props['stroke-color'] ?? '#3465a4').toLowerCase(), width: Math.max(1, Math.round(px(props['stroke-width']) ?? 1)) }
      : null;
    if (props.stroke === 'dash') this.losses.add('Dashed lines, shown solid');
    return {
      family, name, fill, stroke,
      valign: { middle: 'middle', bottom: 'bottom' }[props['textarea-vertical-align']] ?? 'top',
      markerStart: !!props['marker-start'], markerEnd: !!props['marker-end'],
      text: styles.resolve(family, name, 'text'),
      paragraph: styles.resolve(family, name, 'paragraph'),
    };
  }

  line(node, look, out) {
    const x1 = px(attr(node, NS.svg, 'x1')) ?? 0;
    const y1 = px(attr(node, NS.svg, 'y1')) ?? 0;
    const x2 = px(attr(node, NS.svg, 'x2')) ?? 0;
    const y2 = px(attr(node, NS.svg, 'y2')) ?? 0;
    if (attr(node, NS.draw, 'type') && attr(node, NS.draw, 'type') !== 'line') this.losses.add('Bent and curved connectors, shown straight');
    let [sx, sy, ex, ey] = [x1, y1, x2, y2];
    if (look.markerStart && !look.markerEnd) [sx, sy, ex, ey] = [x2, y2, x1, y1];
    if (look.markerStart && look.markerEnd) this.losses.add('Arrows at both ends of a line, shown at one end');
    out.push({
      id: this.id('e'), kind: 'line',
      x: Math.round(Math.min(sx, ex)), y: Math.round(Math.min(sy, ey)),
      w: Math.max(1, Math.round(Math.abs(ex - sx))), h: Math.max(1, Math.round(Math.abs(ey - sy))), rotation: 0,
      thickness: look.stroke?.width ?? 1, arrow: look.markerStart || look.markerEnd, fill: look.stroke?.color ?? '#000000',
      ...(ex < sx ? { flipH: true } : {}), ...(ey < sy ? { flipV: true } : {}), data: {},
    });
  }

  frame(node, box, look, styles, out) {
    const textBox = kid(node, NS.draw, 'text-box');
    if (textBox) {
      const text = this.text(textBox, styles, look);
      if (text) out.push({ id: this.id('e'), kind: 'text', ...box, ...text, data: {} });
      return;
    }
    const table = kid(node, NS.table, 'table');
    if (table) {
      this.table(table, box, styles, out);
      return;
    }
    const images = kids(node, NS.draw, 'image');
    if (images.length > 0) {
      const resource = images.map((image) => this.image(attr(image, NS.xlink, 'href'))).find(Boolean) ?? null;
      if (!resource) this.losses.add('Pictures in formats Slides cannot show, left as empty frames');
      const clip = styles.resolve(look.family, look.name, 'graphic').clip ?? '';
      // LibreOffice writes a clip of nothing on every picture.
      if ((clip.match(/-?[\d.]+/g) ?? []).some((n) => Number(n) !== 0)) this.losses.add('Cropped pictures, shown whole');
      out.push({ id: this.id('e'), kind: 'image', ...box, resource, fit: 'cover', data: {} });
      return;
    }
    if (kid(node, NS.draw, 'object') || kid(node, NS.draw, 'object-ole')) this.losses.add('Charts and embedded objects');
    else if (kid(node, NS.draw, 'plugin')) this.losses.add('Video and sound');
  }

  image(href) {
    const path = internalHref(href);
    if (!path || !this.pkg) return null;
    if (this.imageNames.has(path)) return this.imageNames.get(path);
    const bytes = this.pkg.bytes(path);
    if (!bytes || !['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(extensionOf(path))) return null;
    const base = path.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
    let name = `resources/${base}`;
    for (let n = 2; this.images.has(name); n += 1) name = `resources/${base.replace(/(\.[^.]*)?$/, `-${n}$1`)}`;
    this.images.set(name, bytes);
    this.imageNames.set(path, name);
    return name;
  }

  table(table, box, styles, out) {
    const rows = [...table.getElementsByTagNameNS(NS.table, 'table-row')];
    let cols = 0;
    let merged = false;
    let size = null;
    const cells = rows.map((row) => kids(row).filter((c) => is(c, NS.table, 'table-cell') || is(c, NS.table, 'covered-table-cell')).map((cell) => {
      if (cell.localName === 'covered-table-cell' || attr(cell, NS.table, 'number-columns-spanned') || attr(cell, NS.table, 'number-rows-spanned')) merged = true;
      const paragraphs = paragraphsOf(cell);
      if (size === null) {
        const span = paragraphs[0]?.p.getElementsByTagNameNS(NS.text, 'span')[0];
        const props = span ? styles.resolve('text', attr(span, NS.text, 'style-name'), 'text') : {};
        size = fontSize(props['font-size']);
      }
      return paragraphs.map(({ p }) => plainText(p)).join('\n');
    }));
    for (const row of cells) cols = Math.max(cols, row.length);
    if (merged) this.losses.add('Merged table cells, shown separate');
    if (rows.length > 30 || cols > 12) this.losses.add('Tables larger than 30 rows or 12 columns, cut to that size');
    out.push({
      id: this.id('e'), kind: 'table', ...box, style: 'body',
      rows: Math.min(Math.max(rows.length, 1), 30), cols: Math.min(Math.max(cols, 1), 12),
      header: attr(table, NS.table, 'use-first-row-styles') === 'true',
      cells: cells.slice(0, 30).map((row) => Array.from({ length: Math.min(Math.max(cols, 1), 12) }, (_, c) => row[c] ?? '')),
      size: Math.round(size ?? 24), data: {},
    });
  }

  /** The text in a shape or text box as a Slides text element's fields; null when there is none. */
  text(holder, styles, look) {
    const paragraphs = paragraphsOf(holder);
    if (!paragraphs.some(({ p }) => plainText(p).trim() !== '')) return null;
    const runs = [];
    const sizes = [];
    let elementColor = null;
    let align = null;
    let family = null;
    let bulleted = false;
    paragraphs.forEach(({ p, bullet, level }, index) => {
      if (index > 0) runs.push({ text: '\n' });
      let started = false;
      const pStyle = attr(p, NS.text, 'style-name');
      const paragraphProps = { ...look.paragraph, ...styles.resolve('paragraph', pStyle, 'paragraph') };
      align ??= paragraphProps['text-align'] ?? 'start';
      const pText = { ...look.text, ...styles.resolve('paragraph', pStyle, 'text') };
      if (bullet) {
        bulleted = true;
        runs.push({ text: `${'    '.repeat(level)}• ` });
      }
      const visit = (node, inherited) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            // Whitespace in ODF text collapses to one space, and none at a paragraph's start.
            const collapsed = child.nodeValue.replace(/[\t\n\r ]+/g, ' ');
            push(started ? collapsed : collapsed.replace(/^ /, ''), inherited);
          } else if (child.nodeType === 1 && child.namespaceURI === NS.text) {
            if (child.localName === 'span' || child.localName === 'a') {
              visit(child, { ...inherited, ...styles.resolve('text', attr(child, NS.text, 'style-name'), 'text') });
            } else if (child.localName === 's') push(' '.repeat(Number(attr(child, NS.text, 'c') ?? 1)), inherited);
            else if (child.localName === 'tab') push('\t', inherited);
            else if (child.localName === 'line-break') push('\n', inherited);
            else if (!['note', 'bookmark', 'bookmark-start', 'bookmark-end', 'soft-page-break'].includes(child.localName)) {
              push(child.textContent, inherited);
            }
          }
        }
      };
      const push = (value, props) => {
        if (value === '') return;
        started = true;
        const color = props['use-window-font-color'] === 'true' ? '#000000' : props.color?.toLowerCase() ?? null;
        elementColor ??= color ?? '#000000';
        const size = fontSize(props['font-size']);
        if (size) sizes.push(size);
        family ??= unquote(props['font-family'] ?? props['font-name'] ?? '') || null;
        runs.push({
          text: value,
          ...(props['font-weight'] === 'bold' || Number(props['font-weight']) >= 600 ? { bold: true } : {}),
          ...(props['font-style'] === 'italic' || props['font-style'] === 'oblique' ? { italic: true } : {}),
          ...(props['text-underline-style'] && props['text-underline-style'] !== 'none' ? { underline: true } : {}),
          ...(color && color !== elementColor ? { color } : {}),
        });
      };
      visit(p, pText);
    });
    if (bulleted) this.losses.add('Bulleted lists, kept as text with bullet characters');
    const distinct = [...new Set(sizes.map((s) => Math.round(s)))];
    if (distinct.length > 1) this.losses.add('Text of different sizes in one box, shown at one size');
    const face = family ? (styles.font(family)?.family ?? family) : null;
    return {
      style: 'body',
      content: mergeRuns(runs),
      size: distinct[0] ?? 24,
      align: { center: 'center', end: 'right', right: 'right' }[align] ?? 'left',
      ...(look.valign !== 'top' ? { valign: look.valign } : {}),
      ...(elementColor ? { color: elementColor } : {}),
      ...(face ? { font: fontKind(face) } : {}),
    };
  }
}

/** A text size in pixels from an ODF length; percentages are left to the style above. */
function fontSize(text) {
  if (!text || String(text).endsWith('%')) return null;
  const value = px(text);
  return value ? Math.round(value * 100) / 100 : null;
}

/** The paragraphs of a text holder, list items flattened and marked as bulleted. */
function paragraphsOf(holder, level = -1) {
  const out = [];
  for (const child of kids(holder)) {
    if (is(child, NS.text, 'p') || is(child, NS.text, 'h')) out.push({ p: child, bullet: level >= 0, level: Math.max(level, 0) });
    else if (is(child, NS.text, 'list')) {
      for (const item of kids(child, NS.text, 'list-item')) out.push(...paragraphsOf(item, level + 1));
    }
  }
  return out;
}

function plainText(p) {
  let out = '';
  for (const child of p.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue.replace(/[\t\n\r ]+/g, ' ');
    else if (is(child, NS.text, 's')) out += ' '.repeat(Number(attr(child, NS.text, 'c') ?? 1));
    else if (is(child, NS.text, 'line-break')) out += '\n';
    else if (is(child, NS.text, 'tab')) out += '\t';
    else if (child.nodeType === 1 && !is(child, NS.text, 'note')) out += plainText(child);
  }
  return out;
}

function mergeRuns(runs) {
  const key = (r) => JSON.stringify([!!r.bold, !!r.italic, !!r.underline, r.color ?? null]);
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && key(last) === key(run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out.length > 0 ? out : [{ text: '' }];
}

/** A shape's box, with its rotation undone from draw:transform when it has one. */
function boxOf(node) {
  const w = px(attr(node, NS.svg, 'width'));
  const h = px(attr(node, NS.svg, 'height'));
  if (w === null || h === null) return null;
  const transform = attr(node, NS.draw, 'transform');
  if (!transform) {
    return rounded({ x: px(attr(node, NS.svg, 'x')) ?? 0, y: px(attr(node, NS.svg, 'y')) ?? 0, w, h, rotation: 0 });
  }
  const rotate = /rotate\s*\(\s*([-\d.e]+)\s*\)/.exec(transform);
  const translate = /translate\s*\(\s*([-\d.e]+[a-z]*)[\s,]+([-\d.e]+[a-z]*)\s*\)/.exec(transform);
  if (/skew|scale|matrix/.test(transform)) return null;
  // Lengths without a unit are LibreOffice's hundredths of a millimetre.
  const length = (text) => (/[a-z]$/.test(text) ? px(text) : px(`${Number(text) / 100}mm`)) ?? 0;
  const angle = rotate ? -Number(rotate[1]) : 0;
  const tx = translate ? length(translate[1]) : 0;
  const ty = translate ? length(translate[2]) : 0;
  // The centre lands where the turned box's centre does.
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = tx + cos * (w / 2) - sin * (h / 2);
  const cy = ty + sin * (w / 2) + cos * (h / 2);
  const degrees = ((angle * 180) / Math.PI + 360) % 360;
  return rounded({ x: cx - w / 2, y: cy - h / 2, w, h, rotation: degrees });
}

/** The viewBox a drawing's coordinates are in. */
function viewBox(node) {
  const values = String(attr(node, NS.svg, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0 ? values : null;
}

/** A polygon's, polyline's or path's outline in a 0 to 100 box, or null when it cannot be read. */
function outlineOf(node) {
  if (node.localName === 'path') return pathOutline(attr(node, NS.svg, 'd'), viewBox(node));
  const box = viewBox(node);
  const points = String(attr(node, NS.draw, 'points') ?? '').trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
  if (!box || points.length < 2 || points.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)))) return null;
  const segments = points.map(([x, y], i) => [i === 0 ? 'M' : 'L', x, y]);
  if (node.localName === 'polygon') segments.push(['Z']);
  return normalisePath(mapPath(segments, (x, y) => [x - box[0], y - box[1]]), box[2], box[3]);
}

function pathOutline(d, box) {
  if (!d || !box) return null;
  try {
    return normalisePath(mapPath(parsePath(d), (x, y) => [x - box[0], y - box[1]]), box[2], box[3]);
  } catch {
    return null;
  }
}

/** A custom shape's enhanced path, when it is made of plain numbers rather than formulas. */
function enhancedOutline(geometry) {
  const d = attr(geometry, NS.draw, 'enhanced-path');
  if (!d || /[?$]/.test(d) || /[^MLCQZNFS\d\s.,eE+-]/.test(d)) return null;
  return pathOutline(d.replace(/[NFS]/g, ' '), viewBox(geometry));
}

const rounded = (box) => ({
  x: Math.round(box.x), y: Math.round(box.y),
  w: Math.max(1, Math.round(box.w)), h: Math.max(1, Math.round(box.h)),
  rotation: Math.round((box.rotation ?? 0) * 100) / 100 % 360,
});

// Writing

/**
 * @param {object} document Slides' toJSON()
 * @param {Map<string, Uint8Array>} images resource path to bytes
 * @param {{flat?: boolean}} options
 * @returns {{entries?: object[], text?: string, losses: Losses}}
 */
export function writeOdp(document, images = new Map(), { flat = false } = {}) {
  return new OdpWriter(document, images).write(flat);
}

/** Automatic styles for one part of the file, with names of its own. */
class StyleSink {
  constructor(prefix) {
    this.prefix = prefix;
    this.styles = new Map();
    this.counts = {};
  }

  add(family, short, properties) {
    const key = JSON.stringify([family, properties]);
    if (!this.styles.has(key)) {
      this.counts[short] = (this.counts[short] ?? 0) + 1;
      const name = `${this.prefix}${short}${this.counts[short]}`;
      this.styles.set(key, tag('style:style', { 'style:name': name, 'style:family': family }, properties));
    }
    return this.styles.get(key).attrs['style:name'];
  }

  get elements() {
    return [...this.styles.values()];
  }
}

class OdpWriter {
  constructor(document, images) {
    this.doc = document;
    this.images = images;
    this.losses = new Losses();
    this.pictures = new Map();
    this.canvas = document.canvas ?? { w: 1920, h: 1080 };
    this.theme = { background: '#ffffff', accent: '#1f6feb', text: '#222222', ...(document.theme ?? {}) };
    this.styles = document.styles ?? {};
    this.fonts = new Map((document.fonts ?? []).map((font) => [font.id, font]));
  }

  write(flat) {
    const content = new StyleSink('');
    const masterSink = new StyleSink('M');
    const slides = this.doc.slides ?? [];
    if (slides.some((slide) => slide.section)) this.losses.add('Sections, which OpenDocument presentations do not have');

    const backgroundStyle = (sink, color) => sink.add('drawing-page', 'dp', [tag('style:drawing-page-properties', {
      'draw:background-size': 'full', 'draw:fill': 'solid', 'draw:fill-color': color,
      'presentation:background-visible': 'true', 'presentation:background-objects-visible': 'true',
    })]);
    const masterPage = (name, display, elements) => tag('style:master-page', {
      'style:name': name, 'style:display-name': display, 'style:page-layout-name': 'PM1',
      'draw:style-name': backgroundStyle(masterSink, this.theme.background),
    }, elements.map((element) => this.element(element, masterSink)));
    const masters = [
      masterPage('Default', 'Default', []),
      ...(this.doc.masters ?? []).map((master, i) => masterPage(`GRT_Master_${i + 1}`, master.name ?? `Master ${i + 1}`, sortByZ(master.elements ?? []))),
    ];
    const masterName = new Map((this.doc.masters ?? []).map((master, i) => [master.id, `GRT_Master_${i + 1}`]));

    const pages = slides.map((slide, i) => {
      const id = `page${i + 1}`;
      const pageStyle = content.add('drawing-page', 'dp', [tag('style:drawing-page-properties', {
        'presentation:background-visible': 'true', 'presentation:background-objects-visible': 'true',
        ...(slide.background ? { 'draw:background-size': 'full', 'draw:fill': 'solid', 'draw:fill-color': slide.background } : {}),
      })]);
      return tag('draw:page', {
        'draw:name': id, 'draw:style-name': pageStyle, 'draw:master-page-name': masterName.get(slide.master) ?? 'Default',
        'xml:id': id, 'draw:id': id,
      },
      sortByZ(slide.elements ?? []).map((element) => this.element(element, content)),
      transitionXml(slide.transition, id),
      (slide.notes ?? '').trim() !== '' ? this.notesXml(slide.notes, content, i + 1) : null);
    });

    const pageLayout = tag('style:page-layout', { 'style:name': 'PM1' }, tag('style:page-layout-properties', {
      'fo:margin-top': '0cm', 'fo:margin-bottom': '0cm', 'fo:margin-left': '0cm', 'fo:margin-right': '0cm',
      'fo:page-width': cm(this.canvas.w), 'fo:page-height': cm(this.canvas.h),
      'style:print-orientation': this.canvas.w >= this.canvas.h ? 'landscape' : 'portrait',
    }));
    const namespaces = {
      ...ROOT_NAMESPACES, 'xmlns:anim': ANIM, 'xmlns:smil': SMIL, 'office:version': ODF_VERSION,
    };
    const markers = tag('office:styles', {},
      tag('draw:marker', { 'draw:name': 'Arrow', 'svg:viewBox': '0 0 20 30', 'svg:d': 'M10 0l-10 30h20z' }));
    const body = tag('office:body', {}, tag('office:presentation', {}, pages));
    const pictures = [...this.pictures.values()].map((p) => ({ name: p.name, data: p.bytes, mediaType: MEDIA_TYPES[p.extension] ?? 'application/octet-stream' }));

    if (flat) {
      for (const picture of this.pictures.values()) this.losses.add('Pictures, which a flat file does not carry');
      const root = tag('office:document', { ...namespaces, 'office:mimetype': MIMETYPES.presentation },
        markers,
        tag('office:automatic-styles', {}, pageLayout, masterSink.elements, content.elements),
        tag('office:master-styles', {}, masters),
        body);
      return { text: xmlDocument(root), losses: this.losses };
    }

    const styles = tag('office:document-styles', namespaces,
      markers,
      tag('office:automatic-styles', {}, pageLayout, masterSink.elements),
      tag('office:master-styles', {}, masters));
    const contentXml = tag('office:document-content', namespaces,
      tag('office:automatic-styles', {}, content.elements),
      body);
    return {
      entries: odfPackage(MIMETYPES.presentation, [
        { name: 'content.xml', data: xmlDocument(contentXml), mediaType: 'text/xml' },
        { name: 'styles.xml', data: xmlDocument(styles), mediaType: 'text/xml' },
        ...pictures,
      ]),
      losses: this.losses,
    };
  }

  element(element, sink) {
    if (element.kind === 'text') return this.textFrame(element, sink);
    if (element.kind === 'shape') return this.shape(element, sink);
    if (element.kind === 'line') return this.line(element, sink);
    if (element.kind === 'image') return this.picture(element, sink);
    if (element.kind === 'table') return this.table(element, sink);
    return null;
  }

  /** What an element's text looks like, its own settings over its named style. */
  look(element) {
    const style = this.styles[element.style] ?? this.styles.body ?? {};
    const font = element.font ?? style.font ?? 'sans';
    const custom = this.fonts.get(font);
    if (custom) this.losses.add('Fonts the presentation carries, named but not embedded');
    return {
      size: element.size ?? style.size ?? 32,
      align: element.align ?? style.align ?? 'left',
      color: element.color ?? style.color ?? '#333333',
      bold: !!style.bold,
      italic: !!style.italic,
      family: custom?.name ?? FAMILIES[font] ?? FAMILIES.sans,
    };
  }

  textFrame(element, sink) {
    const look = this.look(element);
    const graphic = sink.add('graphic', 'gr', [tag('style:graphic-properties', {
      'draw:stroke': 'none', 'draw:fill': 'none', 'draw:auto-grow-height': 'false', 'draw:auto-grow-width': 'false',
      'draw:textarea-vertical-align': element.valign ?? 'top', 'draw:textarea-horizontal-align': 'justify',
      'fo:padding-top': '0cm', 'fo:padding-bottom': '0cm', 'fo:padding-left': '0cm', 'fo:padding-right': '0cm',
      'fo:min-height': '0cm', 'fo:wrap-option': 'wrap', 'draw:shadow': 'hidden',
    })]);
    return tag('draw:frame', { 'draw:style-name': graphic, ...placement(element) },
      tag('draw:text-box', {}, this.paragraphs(element.content ?? [], look, sink)));
  }

  paragraphs(runs, look, sink) {
    const lines = [[]];
    for (const run of runs) {
      String(run.text ?? '').split('\n').forEach((piece, i) => {
        if (i > 0) lines.push([]);
        if (piece !== '') lines[lines.length - 1].push({ ...run, text: piece });
      });
    }
    const paragraph = sink.add('paragraph', 'P', [
      tag('style:paragraph-properties', { 'fo:text-align': { center: 'center', right: 'end' }[look.align] ?? 'start', 'fo:line-height': '108%' }),
      tag('style:text-properties', textProperties({}, look)),
    ]);
    return lines.map((line) => tag('text:p', { 'text:style-name': paragraph },
      line.map((run) => tag('text:span', { 'text:style-name': sink.add('text', 'T', [tag('style:text-properties', textProperties(run, look))]) },
        odfText(run.text)))));
  }

  shape(element, sink) {
    const fill = element.fill ?? this.theme.accent;
    const graphic = sink.add('graphic', 'gr', [tag('style:graphic-properties', {
      'draw:fill': fill === 'none' ? 'none' : 'solid', 'draw:fill-color': fill === 'none' ? null : fill,
      'draw:stroke': element.stroke ? 'solid' : 'none',
      'svg:stroke-color': element.stroke ?? null,
      'svg:stroke-width': element.stroke ? cm(element.strokeWidth ?? 2) : null,
      'draw:shadow': 'hidden',
    })]);
    if (element.shape === 'path' && element.path) {
      const d = formatPath(mapPath(parsePath(element.path), (x, y) => [x * 100, y * 100]), 0);
      return tag('draw:path', { 'draw:style-name': graphic, ...placement(element), 'svg:viewBox': '0 0 10000 10000', 'svg:d': d });
    }
    const [type, modifiers] = CUSTOM_TYPES[element.shape] ?? CUSTOM_TYPES.rect;
    return tag('draw:custom-shape', { 'draw:style-name': graphic, ...placement(element) },
      tag('draw:enhanced-geometry', { 'svg:viewBox': '0 0 21600 21600', 'draw:type': type, 'draw:modifiers': modifiers }));
  }

  line(element, sink) {
    const graphic = sink.add('graphic', 'gr', [tag('style:graphic-properties', {
      'draw:stroke': 'solid', 'svg:stroke-color': element.fill ?? this.theme.accent, 'svg:stroke-width': cm(element.thickness ?? 4),
      'draw:marker-end': element.arrow ? 'Arrow' : null,
      'draw:marker-end-width': element.arrow ? cm(Math.max(8, (element.thickness ?? 4) * 3)) : null,
      'draw:fill': 'none', 'draw:shadow': 'hidden',
    })]);
    let [x1, y1, x2, y2] = [
      element.flipH ? element.x + element.w : element.x, element.flipV ? element.y + element.h : element.y,
      element.flipH ? element.x : element.x + element.w, element.flipV ? element.y : element.y + element.h,
    ];
    if (element.rotation) {
      // A rotated line is the same line with its ends turned about its middle.
      const cx = element.x + element.w / 2;
      const cy = element.y + element.h / 2;
      const turn = (x, y) => {
        const a = (element.rotation * Math.PI) / 180;
        return [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
      };
      [x1, y1] = turn(x1, y1);
      [x2, y2] = turn(x2, y2);
    }
    return tag('draw:line', { 'draw:style-name': graphic, 'svg:x1': cm(x1), 'svg:y1': cm(y1), 'svg:x2': cm(x2), 'svg:y2': cm(y2) });
  }

  picture(element, sink) {
    const bytes = this.images.get(element.resource);
    if (!bytes) {
      this.losses.add('Pictures whose file is missing, left out');
      return null;
    }
    const extension = pictureExtension(bytes, element.resource);
    if (!this.pictures.has(element.resource)) {
      this.pictures.set(element.resource, { name: `Pictures/image${this.pictures.size + 1}.${extension}`, bytes, extension });
    }
    let box = element;
    const size = naturalSize(bytes);
    if (size && size.w > 0 && size.h > 0) {
      const ratio = (size.w / size.h) / (element.w / element.h);
      if (Math.abs(ratio - 1) > 0.01) {
        if (element.fit === 'cover') this.losses.add('Cropped pictures, shown whole');
        const scale = Math.min(element.w / size.w, element.h / size.h);
        box = { ...element, x: element.x + (element.w - size.w * scale) / 2, y: element.y + (element.h - size.h * scale) / 2, w: size.w * scale, h: size.h * scale };
      }
    }
    const graphic = sink.add('graphic', 'gr', [tag('style:graphic-properties', { 'draw:stroke': 'none', 'draw:fill': 'none', 'draw:shadow': 'hidden' })]);
    return tag('draw:frame', { 'draw:style-name': graphic, ...placement(box) },
      tag('draw:image', {
        'xlink:href': this.pictures.get(element.resource).name, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad',
      }));
  }

  table(element, sink) {
    const look = { ...this.look(element), align: 'left' };
    const rows = element.cells ?? [];
    const cols = Math.max(1, element.cols ?? rows[0]?.length ?? 1);
    const column = sink.add('table-column', 'co', [tag('style:table-column-properties', { 'style:column-width': cm(element.w / cols) })]);
    const row = sink.add('table-row', 'ro', [tag('style:table-row-properties', { 'style:row-height': cm(element.h / Math.max(1, rows.length)) })]);
    const cell = sink.add('table-cell', 'ce', [tag('style:graphic-properties', { 'draw:fill': 'none' }),
      tag('style:table-cell-properties', { 'fo:border': `0.03cm solid ${this.theme.text}`, 'fo:padding': '0.1cm' })]);
    const graphic = sink.add('graphic', 'gr', [tag('style:graphic-properties', { 'draw:stroke': 'none', 'draw:fill': 'none', 'draw:shadow': 'hidden' })]);
    return tag('draw:frame', { 'draw:style-name': graphic, ...placement(element) },
      tag('table:table', { 'table:use-first-row-styles': element.header ? 'true' : null },
        Array.from({ length: cols }, () => tag('table:table-column', { 'table:style-name': column })),
        rows.map((cells, r) => tag('table:table-row', { 'table:style-name': row, 'table:default-cell-style-name': cell },
          Array.from({ length: cols }, (_, c) => tag('table:table-cell', {},
            this.paragraphs([{ text: cells[c] ?? '', ...(element.header && r === 0 ? { bold: true } : {}) }], look, sink)))))));
  }

  notesXml(text, sink, number) {
    const look = { size: 16, align: 'left', color: '#000000', bold: false, italic: false, family: FAMILIES.sans };
    const graphic = sink.add('graphic', 'gr', [tag('style:graphic-properties', { 'draw:stroke': 'none', 'draw:fill': 'none', 'draw:shadow': 'hidden' })]);
    return tag('presentation:notes', {},
      tag('draw:page-thumbnail', {
        'draw:style-name': graphic, 'draw:page-number': String(number), 'presentation:class': 'page',
        'svg:x': '1.905cm', 'svg:y': '3.175cm', 'svg:width': '15.239cm', 'svg:height': cm((this.canvas.h / this.canvas.w) * (15.239 / 2.54) * 96),
      }),
      tag('draw:frame', {
        'presentation:style-name': sink.add('presentation', 'pr', [tag('style:graphic-properties', { 'draw:fill': 'none', 'draw:stroke': 'none' })]),
        'presentation:class': 'notes',
        'svg:x': '1.905cm', 'svg:y': '12.224cm', 'svg:width': '15.239cm', 'svg:height': '10cm',
      }, tag('draw:text-box', {}, this.paragraphs([{ text: String(text) }], look, sink))));
  }
}

function textProperties(run, look) {
  return {
    'fo:font-size': `${Math.round(look.size * 0.75 * 100) / 100}pt`,
    'fo:color': run.color ?? look.color,
    'fo:font-family': look.family,
    'fo:font-weight': run.bold || look.bold ? 'bold' : 'normal',
    'fo:font-style': run.italic || look.italic ? 'italic' : 'normal',
    'style:text-underline-style': run.underline ? 'solid' : 'none',
    'style:text-underline-width': run.underline ? 'auto' : null,
    'style:text-underline-color': run.underline ? 'font-color' : null,
  };
}

/** Where a shape sits: plain coordinates, or a transform when it is turned. */
function placement(element) {
  const w = Math.max(0, element.w);
  const h = Math.max(0, element.h);
  if (!element.rotation) {
    return { 'svg:x': cm(element.x), 'svg:y': cm(element.y), 'svg:width': cm(w), 'svg:height': cm(h) };
  }
  const angle = (element.rotation * Math.PI) / 180;
  const cx = element.x + w / 2;
  const cy = element.y + h / 2;
  // The corner the box starts from, once it is turned about its centre.
  const tx = cx - (Math.cos(angle) * (w / 2) - Math.sin(angle) * (h / 2));
  const ty = cy - (Math.sin(angle) * (w / 2) + Math.cos(angle) * (h / 2));
  return {
    'svg:width': cm(w), 'svg:height': cm(h),
    'draw:transform': `rotate (${Number((-angle).toFixed(12))}) translate (${cm(tx)} ${cm(ty)})`,
  };
}

function transitionXml(kind, id) {
  if (kind !== 'fade' && kind !== 'slide') return null;
  const filter = kind === 'fade'
    ? { 'smil:type': 'fade', 'smil:subtype': 'crossfade' }
    : { 'smil:type': 'pushWipe', 'smil:subtype': 'fromRight' };
  return tag('anim:par', { 'presentation:node-type': 'timing-root' },
    tag('anim:par', { 'smil:begin': `${id}.begin` }, tag('anim:transitionFilter', { 'smil:dur': '0.75s', ...filter })),
    tag('anim:seq', { 'smil:dur': '0s', 'presentation:node-type': 'main-sequence' }));
}

function sortByZ(elements) {
  return [...elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
}

function pictureExtension(bytes, resource) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'bmp';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'webp';
  return extensionOf(resource) || 'png';
}
