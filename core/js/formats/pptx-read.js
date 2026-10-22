/** PowerPoint presentations into Slides' document. */

import { NS, kids, kid, is } from '../xml.js';
import { Losses } from '../losses.js';
import { relationships, mainPart, readPart, relIs } from './ooxml.js';
import { fontKind } from './odf.js';
import { presetOutline, mirrorOutline } from '../paths.js';
import {
  readDrawingTheme, readColorMap, colorOf, isTransparent, readXfrm, groupTransform, unwrap, toPx, customGeometry,
} from './drawingml.js';

const P = NS.p;
const A = NS.a;
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table';
const PT_TO_PX = 96 / 72;

/** PowerPoint's shapes, as the ones Slides draws. */
const SHAPES = {
  rect: 'rect', roundRect: 'rounded', snipRoundRect: 'rounded', round1Rect: 'rounded', round2SameRect: 'rounded',
  ellipse: 'ellipse', diamond: 'diamond', hexagon: 'hexagon', octagon: 'hexagon', triangle: 'triangle',
  parallelogram: 'parallelogram', flowChartProcess: 'rect', flowChartDecision: 'diamond',
  flowChartTerminator: 'rounded', flowChartAlternateProcess: 'rounded', flowChartPredefinedProcess: 'rect',
  flowChartConnector: 'ellipse', flowChartInputOutput: 'parallelogram', flowChartPreparation: 'hexagon',
};
const LINES = new Set(['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3']);

/**
 * @param {import('../package.js').Package} pkg
 * @returns {{document: object, images: Map<string, Uint8Array>, losses: Losses}}
 */
export function readPptx(pkg) {
  const main = mainPart(pkg);
  const presentation = main ? readPart(pkg, main, 'the presentation') : null;
  if (!presentation || !is(presentation.documentElement, P, 'presentation')) {
    throw new Error('This is not a PowerPoint presentation');
  }
  return new PptxReader(pkg, main, presentation).read();
}

class PptxReader {
  constructor(pkg, main, presentation) {
    this.pkg = pkg;
    this.main = main;
    this.root = presentation.documentElement;
    this.rels = relationships(pkg, main);
    this.losses = new Losses();
    if (pkg.damage) this.losses.add('The file was damaged, and only what could still be read was opened');
    this.images = new Map();
    this.imageNames = new Map();
    this.layouts = new Map();
    this.masters = new Map();
    this.modelMasters = [];
    this.ids = 0;
  }

  id(prefix) {
    this.ids += 1;
    return `${prefix}${this.ids}`;
  }

  read() {
    const size = kid(this.root, P, 'sldSz');
    this.canvas = {
      w: Math.round(toPx(size?.getAttribute('cx') ?? 12192000)),
      h: Math.round(toPx(size?.getAttribute('cy') ?? 6858000)),
    };
    this.defaultText = kid(this.root, P, 'defaultTextStyle');

    const slideRefs = kids(kid(this.root, P, 'sldIdLst'), P, 'sldId');
    const sections = this.readSections();
    const slides = [];
    for (const ref of slideRefs) {
      const rel = this.rels.get(ref.getAttributeNS(NS.r, 'id'));
      if (!rel || !relIs(rel.type, 'slide')) continue;
      const slide = this.readSlide(rel.target);
      if (!slide) continue;
      slide.section = sections.get(ref.getAttribute('id')) ?? null;
      slides.push(slide);
    }
    if (slides.length === 0) throw new Error('This presentation has no slides GRT can read');

    if (this.pkg.names.some((n) => /^ppt\/comments\//i.test(n) || /^ppt\/comments\/modernComment/i.test(n))) {
      this.losses.add('Comments');
    }
    if (this.pkg.names.some((n) => /^ppt\/media\/.*\.(mp4|m4v|mov|wmv|avi|mp3|wav|m4a|wma)$/i.test(n))) {
      this.losses.add('Video and sound');
    }

    const firstMaster = this.masters.values().next().value;
    const theme = {
      background: firstMaster?.background ?? '#ffffff',
      accent: firstMaster ? colorOf(this.schemeHolder('accent1'), firstMaster.theme, firstMaster.colorMap) ?? '#1f6feb' : '#1f6feb',
      text: firstMaster ? colorOf(this.schemeHolder('tx1'), firstMaster.theme, firstMaster.colorMap) ?? '#222222' : '#222222',
    };

    return {
      document: { version: 1, type: 'slides', canvas: this.canvas, theme, masters: this.modelMasters, slides },
      images: this.images,
      losses: this.losses,
    };
  }

  /** A holder for a scheme colour. */
  schemeHolder(name) {
    const doc = this.root.ownerDocument;
    const holder = doc.createElementNS(A, 'a:solidFill');
    const scheme = doc.createElementNS(A, 'a:schemeClr');
    scheme.setAttribute('val', name);
    holder.append(scheme);
    return holder;
  }

  /** Section names by the id of the slide each begins with. */
  readSections() {
    const out = new Map();
    const lists = this.root.getElementsByTagNameNS(P14, 'sectionLst');
    for (const section of lists[0] ? kids(lists[0], P14, 'section') : []) {
      const first = kid(kid(section, P14, 'sldIdLst'), P14, 'sldId');
      if (first) out.set(first.getAttribute('id'), section.getAttribute('name') ?? null);
    }
    return out;
  }

  // Masters and layouts

  master(part) {
    if (this.masters.has(part)) return this.masters.get(part);
    const doc = readPart(this.pkg, part, 'a slide master');
    const rels = relationships(this.pkg, part);
    const themePart = [...rels.values()].find((rel) => relIs(rel.type, 'theme'))?.target;
    const theme = readDrawingTheme(themePart ? readPart(this.pkg, themePart, 'the theme') : null);
    const root = doc?.documentElement;
    const master = {
      part, rels, root, theme,
      colorMap: readColorMap(kid(root, P, 'clrMap')),
      placeholders: placeholders(root),
      txStyles: kid(root, P, 'txStyles'),
    };
    master.background = this.background(root, master) ?? '#ffffff';
    this.masters.set(part, master);
    return master;
  }

  layout(part) {
    if (this.layouts.has(part)) return this.layouts.get(part);
    const doc = readPart(this.pkg, part, 'a slide layout');
    const rels = relationships(this.pkg, part);
    const masterPart = [...rels.values()].find((rel) => relIs(rel.type, 'slideMaster'))?.target;
    const master = masterPart ? this.master(masterPart) : null;
    const root = doc?.documentElement;
    const layout = { part, rels, root, master, placeholders: placeholders(root) };
    layout.colorMap = readOverride(root) ?? master?.colorMap ?? readColorMap(null);
    layout.background = this.background(root, { ...master, colorMap: layout.colorMap }) ?? master?.background ?? null;
    // What the layout and its master draw on every slide becomes a master of the deck.
    layout.modelMaster = this.layoutMaster(layout);
    this.layouts.set(part, layout);
    return layout;
  }

  layoutMaster(layout) {
    const elements = [];
    const context = { slide: layout, layout, master: layout.master, rels: layout.master?.rels, colorMap: layout.colorMap, theme: layout.master?.theme };
    const showsMaster = kid(layout.root, P, 'cSld') && layout.root.getAttribute('showMasterSp') !== '0';
    if (layout.master && showsMaster) {
      this.shapes(spTree(layout.master.root), { ...context, slide: layout.master, rels: layout.master.rels, decoration: true }, elements);
    }
    this.shapes(spTree(layout.root), { ...context, rels: layout.rels, decoration: true }, elements);
    if (elements.length === 0) return null;
    elements.forEach((element, i) => { element.z = i - elements.length - 1000; });
    const name = kid(layout.root, P, 'cSld')?.getAttribute('name') || `Master ${this.modelMasters.length + 1}`;
    const master = { id: this.id('m'), name, elements };
    this.modelMasters.push(master);
    return master;
  }

  /** A solid background colour, or null when the part leaves it to the one above. */
  background(root, context) {
    const bg = kid(kid(root, P, 'cSld'), P, 'bg');
    if (!bg) return null;
    const props = kid(bg, P, 'bgPr');
    if (props) {
      const solid = kid(props, A, 'solidFill');
      if (solid) return colorOf(solid, context.theme, context.colorMap);
      const gradient = kid(props, A, 'gradFill');
      if (gradient) {
        this.losses.add('Picture and gradient backgrounds, shown as one colour');
        const stop = gradient.getElementsByTagNameNS(A, 'gs')[0];
        return colorOf(stop, context.theme, context.colorMap);
      }
      if (kid(props, A, 'blipFill') || kid(props, A, 'pattFill')) {
        this.losses.add('Picture and gradient backgrounds, shown as one colour');
      }
      return null;
    }
    const ref = kid(bg, P, 'bgRef');
    return ref ? colorOf(ref, context.theme, context.colorMap) : null;
  }

  // Slides

  readSlide(part) {
    const doc = readPart(this.pkg, part, 'a slide');
    const root = doc?.documentElement;
    if (!root) {
      this.losses.add('Slides that could not be read, left empty');
      return { id: this.id('s'), elements: [], notes: '', transition: 'none', background: null, master: null };
    }
    const rels = relationships(this.pkg, part);
    const layoutPart = [...rels.values()].find((rel) => relIs(rel.type, 'slideLayout'))?.target;
    const layout = layoutPart ? this.layout(layoutPart) : null;
    const master = layout?.master ?? null;
    const colorMap = readOverride(root) ?? layout?.colorMap ?? master?.colorMap ?? readColorMap(null);
    const theme = master?.theme ?? { colors: {}, major: null, minor: null };
    const context = { slide: { root, rels }, layout, master, rels, colorMap, theme };

    if (root.getAttribute('show') === '0') this.losses.add('Hidden slides, shown');
    const timing = kid(root, P, 'timing');
    if (timing && timing.getElementsByTagNameNS(P, 'spTgt').length > 0) this.losses.add('Animations');

    const elements = [];
    this.shapes(spTree(root), context, elements);
    elements.forEach((element, i) => { element.z = i + 1; });

    const showsLayout = root.getAttribute('showMasterSp') !== '0';
    return {
      id: this.id('s'),
      master: showsLayout ? layout?.modelMaster?.id ?? null : null,
      background: this.background(root, context) ?? (layout?.background !== master?.background ? layout?.background ?? null : null),
      section: null,
      notes: this.notes(rels),
      transition: this.transition(root),
      elements,
    };
  }

  notes(rels) {
    const part = [...rels.values()].find((rel) => relIs(rel.type, 'notesSlide'))?.target;
    if (!part) return '';
    const doc = readPart(this.pkg, part, 'speaker notes');
    const texts = [];
    for (const sp of doc ? doc.getElementsByTagNameNS(P, 'sp') : []) {
      const type = sp.getElementsByTagNameNS(P, 'ph')[0]?.getAttribute('type') ?? null;
      if (['sldImg', 'sldNum', 'hdr', 'ftr', 'dt'].includes(type)) continue;
      const text = kids(kid(sp, P, 'txBody'), A, 'p').map((p) => paragraphText(p)).join('\n').trim();
      if (text === '') continue;
      if (type === 'body') return text;
      texts.push(text);
    }
    return texts.join('\n');
  }

  transition(root) {
    let element = kid(root, P, 'transition');
    if (!element) {
      for (const wrapper of kids(root, NS.mc, 'AlternateContent')) {
        element = unwrap(wrapper).find((child) => is(child, P, 'transition')) ?? element;
      }
    }
    const effect = element ? kids(element).find((child) => child.namespaceURI !== NS.mc) : null;
    if (!effect) return 'none';
    if (effect.localName === 'fade') return 'fade';
    if (['push', 'cover', 'pull', 'wipe', 'split'].includes(effect.localName)) return 'slide';
    this.losses.add('Slide transitions other than fade and slide, shown as a slide');
    return 'slide';
  }

  // Shapes

  /** Every shape under a tree, flattened into Slides' elements. */
  shapes(tree, context, out, place = (box) => box) {
    for (const child of kids(tree)) {
      for (const node of unwrap(child)) this.shape(node, context, out, place);
    }
  }

  shape(node, context, out, place) {
    if (node.namespaceURI !== P) return;
    const nv = kids(node).find((k) => k.localName.startsWith('nv'));
    const props = kid(nv, P, 'cNvPr');
    if (props?.getAttribute('hidden') === '1') return;
    const ph = nv ? kid(kid(nv, P, 'nvPr'), P, 'ph') : null;
    // On a master or a layout, placeholders are where slides put their own content.
    if (context.decoration && ph) return;

    if (node.localName === 'grpSp') {
      const xfrm = kid(kid(node, P, 'grpSpPr'), A, 'xfrm');
      if (Number(xfrm?.getAttribute('rot') ?? 0) !== 0) this.losses.add('Rotated groups, shown unrotated');
      this.shapes(node, context, out, groupTransform(xfrm, place));
      return;
    }
    if (node.localName === 'pic') {
      this.picture(node, context, out, place);
      return;
    }
    if (node.localName === 'graphicFrame') {
      this.frame(node, context, out, place);
      return;
    }
    if (node.localName === 'cxnSp') {
      this.line(node, context, out, place);
      return;
    }
    if (node.localName !== 'sp') return;

    const spPr = kid(node, P, 'spPr');
    const inherited = ph ? this.placeholderChain(ph, context) : [];
    const xfrm = kid(spPr, A, 'xfrm') ?? inherited.map((sp) => kid(kid(sp, P, 'spPr'), A, 'xfrm')).find(Boolean);
    const raw = readXfrm(xfrm);
    if (!raw) return;
    const box = place(raw);

    const geometry = kid(spPr, A, 'prstGeom')?.getAttribute('prst') ?? (kid(spPr, A, 'custGeom') ? 'custom' : null);
    if (geometry && LINES.has(geometry)) {
      this.line(node, context, out, place);
      return;
    }
    const style = kid(node, P, 'style');
    const fill = this.fill(spPr, style, context);
    const stroke = this.stroke(spPr, style, context);
    const text = this.text(node, ph, inherited, context, box);

    const custom = geometry === 'custom'
      ? customGeometry(kid(spPr, A, 'custGeom'), Number(kid(xfrm, A, 'ext')?.getAttribute('cx') ?? 0), Number(kid(xfrm, A, 'ext')?.getAttribute('cy') ?? 0))
      : null;
    const shapeFill = custom && !custom.filled ? 'none' : fill;
    const drawn = geometry && (shapeFill !== 'none' || stroke);
    if (drawn) {
      if (geometry === 'custom' && !custom) this.losses.add('Freeform shapes, drawn as rectangles');
      else if (geometry !== 'custom' && !SHAPES[geometry]) this.losses.add('Shapes Slides does not have, drawn as rectangles');
      let outline = custom ? { shape: 'path', path: custom.path } : { shape: SHAPES[geometry] ?? 'rect' };
      const asymmetric = (raw.flipH && ['path', 'parallelogram'].includes(outline.shape)) || (raw.flipV && ['path', 'triangle'].includes(outline.shape));
      if (asymmetric) outline = { shape: 'path', path: mirrorOutline(presetOutline(outline.shape, outline.path), raw.flipH, raw.flipV) };
      out.push({
        id: this.id('e'), kind: 'shape', ...rounded(box), ...outline,
        fill: shapeFill, ...(stroke ? { stroke: stroke.color, strokeWidth: stroke.width } : {}), data: {},
      });
    }
    if (text) out.push({ id: this.id('e'), kind: 'text', ...rounded(box), ...text, data: {} });
  }

  /** Where a slide's placeholder inherits from: its layout's, then its master's. */
  placeholderChain(ph, context) {
    const out = [];
    const layoutMatch = findPlaceholder(context.layout?.placeholders ?? [], ph);
    if (layoutMatch) out.push(layoutMatch);
    const masterMatch = findPlaceholder(context.master?.placeholders ?? [], layoutMatch ? placeholderOf(layoutMatch) : ph);
    if (masterMatch) out.push(masterMatch);
    return out;
  }

  fill(spPr, style, context) {
    if (kid(spPr, A, 'noFill')) return 'none';
    const solid = kid(spPr, A, 'solidFill');
    if (solid) return isTransparent(solid) ? 'none' : colorOf(solid, context.theme, context.colorMap) ?? 'none';
    const gradient = kid(spPr, A, 'gradFill');
    if (gradient) {
      this.losses.add('Gradient and picture fills, shown as one colour');
      return colorOf(gradient.getElementsByTagNameNS(A, 'gs')[0], context.theme, context.colorMap) ?? 'none';
    }
    if (kid(spPr, A, 'blipFill') || kid(spPr, A, 'pattFill')) {
      this.losses.add('Gradient and picture fills, shown as one colour');
      return 'none';
    }
    const ref = kid(style, A, 'fillRef');
    if (ref && Number(ref.getAttribute('idx')) > 0) return colorOf(ref, context.theme, context.colorMap) ?? 'none';
    return 'none';
  }

  stroke(spPr, style, context) {
    const ln = kid(spPr, A, 'ln');
    if (kid(ln, A, 'noFill')) return null;
    const width = Math.max(1, Math.round(toPx(ln?.getAttribute('w') ?? 9525)));
    const solid = kid(ln, A, 'solidFill');
    if (solid) return { color: colorOf(solid, context.theme, context.colorMap) ?? '#000000', width };
    const ref = kid(style, A, 'lnRef');
    if (ref && Number(ref.getAttribute('idx')) > 0) {
      return { color: colorOf(ref, context.theme, context.colorMap) ?? '#000000', width };
    }
    return null;
  }

  line(node, context, out, place) {
    const spPr = kid(node, P, 'spPr');
    const raw = readXfrm(kid(spPr, A, 'xfrm'));
    if (!raw) return;
    const box = place(raw);
    const stroke = this.stroke(spPr, kid(node, P, 'style'), context) ?? { color: '#000000', width: 1 };
    const ln = kid(spPr, A, 'ln');
    const ARROWS = ['triangle', 'arrow', 'stealth'];
    const kind = (name) => kid(ln, A, name)?.getAttribute('type') ?? 'none';
    const end = (name) => ARROWS.includes(kind(name));
    if (['oval', 'diamond'].includes(kind('headEnd')) || ['oval', 'diamond'].includes(kind('tailEnd'))) {
      this.losses.add('Dots and diamonds at the ends of lines, left off');
    }
    let { flipH, flipV } = raw;
    if (end('headEnd') && !end('tailEnd')) {
      flipH = !flipH;
      flipV = !flipV;
    }
    if (end('headEnd') && end('tailEnd')) this.losses.add('Arrows at both ends of a line, shown at one end');
    if (kid(ln, A, 'prstDash') && kid(ln, A, 'prstDash').getAttribute('val') !== 'solid') this.losses.add('Dashed lines, shown solid');
    const geometry = kid(spPr, A, 'prstGeom')?.getAttribute('prst');
    if (geometry && geometry !== 'line' && geometry !== 'straightConnector1') this.losses.add('Bent and curved connectors, shown straight');
    out.push({
      id: this.id('e'), kind: 'line', ...rounded({ ...box, rotation: box.rotation }),
      thickness: stroke.width, arrow: end('tailEnd') || end('headEnd'), fill: stroke.color,
      ...(flipH ? { flipH: true } : {}), ...(flipV ? { flipV: true } : {}), data: {},
    });
  }

  picture(node, context, out, place) {
    const raw = readXfrm(kid(kid(node, P, 'spPr'), A, 'xfrm'));
    if (!raw) return;
    const box = place(raw);
    const fill = kid(node, P, 'blipFill');
    const blip = kid(fill, A, 'blip');
    if (kid(fill, A, 'srcRect') && [...kid(fill, A, 'srcRect').attributes].some((a) => Number(a.value) !== 0)) {
      this.losses.add('Cropped pictures, shown whole');
    }
    if (node.getElementsByTagNameNS(P, 'videoFile').length > 0 || kid(kid(kid(node, P, 'nvPicPr'), P, 'nvPr'), A, 'videoFile')) {
      this.losses.add('Video and sound');
    }
    const rel = context.rels?.get(blip?.getAttributeNS(NS.r, 'embed'));
    const resource = rel && !rel.external ? this.image(rel.target) : null;
    if (!resource) this.losses.add('Pictures that could not be read, left as empty frames');
    out.push({ id: this.id('e'), kind: 'image', ...rounded(box), resource, fit: 'cover', data: {} });
  }

  /** A picture's bytes, stored once under a resource name of its own. */
  image(part) {
    if (this.imageNames.has(part)) return this.imageNames.get(part);
    const bytes = this.pkg.bytes(part);
    if (!bytes) return null;
    const base = part.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
    let name = `resources/${base}`;
    for (let n = 2; this.images.has(name); n += 1) name = `resources/${base.replace(/(\.[^.]*)?$/, `-${n}$1`)}`;
    this.images.set(name, bytes);
    this.imageNames.set(part, name);
    return name;
  }

  frame(node, context, out, place) {
    const raw = readXfrm(kid(node, P, 'xfrm'));
    const data = kid(kid(node, A, 'graphic'), A, 'graphicData');
    const uri = data?.getAttribute('uri') ?? '';
    if (!raw) return;
    const box = place(raw);
    if (uri !== TABLE_URI) {
      if (/chart/.test(uri)) this.losses.add('Charts');
      else if (/diagram/.test(uri)) this.losses.add('SmartArt diagrams');
      else this.losses.add('Embedded objects');
      return;
    }
    const table = kid(data, A, 'tbl');
    const rows = kids(table, A, 'tr');
    const cols = kids(kid(table, A, 'tblGrid'), A, 'gridCol').length || Math.max(...rows.map((tr) => kids(tr, A, 'tc').length), 1);
    let merged = false;
    let size = null;
    const cells = rows.map((tr) => kids(tr, A, 'tc').slice(0, cols).map((tc) => {
      if (tc.hasAttribute('gridSpan') || tc.hasAttribute('rowSpan') || tc.hasAttribute('hMerge') || tc.hasAttribute('vMerge')) merged = true;
      const body = kid(tc, A, 'txBody');
      const sz = body?.getElementsByTagNameNS(A, 'rPr')[0]?.getAttribute('sz');
      if (size === null && sz) size = Number(sz) / 100;
      return kids(body, A, 'p').map((p) => paragraphText(p)).join('\n');
    }));
    if (merged) this.losses.add('Merged table cells, shown separate');
    if (rows.length > 30 || cols > 12) this.losses.add('Tables larger than 30 rows or 12 columns, cut to that size');
    const header = kid(table, A, 'tblPr')?.getAttribute('firstRow') === '1';
    out.push({
      id: this.id('e'), kind: 'table', ...rounded(box), style: 'body',
      rows: Math.min(Math.max(rows.length, 1), 30), cols: Math.min(cols, 12), header,
      cells: cells.slice(0, 30).map((row) => row.slice(0, 12)),
      size: Math.round((size ?? 18) * PT_TO_PX), data: {},
    });
  }

  // Text

  /** The text of a shape as a Slides text element's fields, or null when it has none. */
  text(node, ph, inherited, context, box) {
    const body = kid(node, P, 'txBody');
    const paragraphs = kids(body, A, 'p');
    if (!paragraphs.some((p) => paragraphText(p).trim() !== '')) return null;

    const kind = ph ? placeholderKind(placeholderOf(ph) ?? {}) : 'other';
    const listChain = [
      kind === 'title' ? kid(context.master?.txStyles, P, 'titleStyle')
        : kind === 'body' ? kid(context.master?.txStyles, P, 'bodyStyle')
          : ph ? kid(context.master?.txStyles, P, 'otherStyle') : this.defaultText,
      ...inherited.slice().reverse().map((sp) => kid(kid(sp, P, 'txBody'), A, 'lstStyle')),
      kid(body, A, 'lstStyle'),
    ].filter(Boolean);
    const bodyPr = [...inherited.slice().reverse().map((sp) => kid(kid(sp, P, 'txBody'), A, 'bodyPr')), kid(body, A, 'bodyPr')].filter(Boolean);
    const anchor = bodyPr.map((b) => b.getAttribute('anchor')).filter(Boolean).pop() ?? 't';
    const centredBlock = bodyPr.map((b) => b.getAttribute('anchorCtr')).filter(Boolean).pop() === '1';
    const scale = Number(kid(kid(body, A, 'bodyPr'), A, 'normAutofit')?.getAttribute('fontScale') ?? 100000) / 100000;
    const fontRefColor = colorOf(kid(kid(node, P, 'style'), A, 'fontRef'), context.theme, context.colorMap);

    const runs = [];
    const sizes = [];
    let elementColor = null;
    let align = null;
    let font = null;
    let bulleted = false;
    paragraphs.forEach((p, index) => {
      const pPr = kid(p, A, 'pPr');
      const level = Number(pPr?.getAttribute('lvl') ?? 0);
      const levelProps = mergeLevels(listChain, level, pPr);
      align ??= levelProps.algn ?? 'l';
      if (index > 0) runs.push({ text: '\n' });
      const text = paragraphText(p);
      if (text !== '' && levelProps.bullet && kind === 'body') {
        bulleted = true;
        runs.push({ text: `${'    '.repeat(level)}${levelProps.bullet} ` });
      }
      for (const run of kids(p)) {
        if (!['r', 'fld', 'br'].includes(run.localName) || run.namespaceURI !== A) continue;
        if (run.localName === 'br') {
          runs.push({ text: '\n' });
          continue;
        }
        const value = kid(run, A, 't')?.textContent ?? '';
        if (value === '') continue;
        const rPr = { ...levelProps.defRPr, ...readRPr(kid(run, A, 'rPr')) };
        const color = colorOf(rPr.fill, context.theme, context.colorMap) ?? fontRefColor;
        elementColor ??= color;
        if (rPr.sz) sizes.push(rPr.sz);
        font ??= rPr.latin;
        runs.push({
          text: value,
          ...(rPr.b ? { bold: true } : {}),
          ...(rPr.i ? { italic: true } : {}),
          ...(rPr.u ? { underline: true } : {}),
          ...(color && color !== elementColor ? { color } : {}),
        });
      }
    });
    if (bulleted) this.losses.add('Bulleted lists, kept as text with bullet characters');
    const distinct = [...new Set(sizes)];
    if (distinct.length > 1) this.losses.add('Text of different sizes in one box, shown at one size');
    const points = (distinct[0] ?? 18) * scale;
    const typeface = font === '+mj-lt' ? context.theme.major : font === '+mn-lt' ? context.theme.minor : font;

    return {
      style: 'body',
      content: mergeRuns(runs),
      size: Math.round(points * PT_TO_PX),
      align: { ctr: 'center', r: 'right' }[align] ?? (centredBlock ? 'center' : 'left'),
      ...(anchor === 'ctr' ? { valign: 'middle' } : anchor === 'b' ? { valign: 'bottom' } : {}),
      ...(elementColor ? { color: elementColor } : {}),
      ...(typeface ? { font: fontKind(typeface) } : {}),
      rotation: box.rotation ?? 0,
    };
  }
}

// Helpers

function spTree(root) {
  return kid(kid(root, P, 'cSld'), P, 'spTree');
}

function readOverride(root) {
  const override = kid(kid(root, P, 'clrMapOvr'), A, 'overrideClrMapping');
  return override ? readColorMap(override) : null;
}

/** The placeholders a master or layout defines: their sp elements. */
function placeholders(root) {
  const out = [];
  for (const sp of spTree(root) ? kids(spTree(root), P, 'sp') : []) {
    if (sp.getElementsByTagNameNS(P, 'ph')[0]) out.push(sp);
  }
  return out;
}

function placeholderOf(spOrPh) {
  const ph = spOrPh.localName === 'ph' ? spOrPh : spOrPh.getElementsByTagNameNS(P, 'ph')[0];
  if (!ph) return null;
  return { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') };
}

function placeholderKind({ type }) {
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (['body', 'subTitle', 'obj'].includes(type)) return 'body';
  return 'other';
}

function findPlaceholder(list, ph) {
  const wanted = ph.localName === 'ph' ? placeholderOf(ph) : ph;
  if (!wanted) return null;
  if (wanted.idx !== null && wanted.idx !== undefined) {
    const byIdx = list.find((sp) => placeholderOf(sp)?.idx === wanted.idx);
    if (byIdx) return byIdx;
  }
  return list.find((sp) => placeholderOf(sp)?.type === wanted.type)
    ?? list.find((sp) => placeholderKind(placeholderOf(sp)) === placeholderKind(wanted) && placeholderKind(wanted) !== 'other')
    ?? null;
}

function readRPr(rPr) {
  if (!rPr) return {};
  const out = {};
  if (rPr.hasAttribute('sz')) out.sz = Number(rPr.getAttribute('sz')) / 100;
  if (rPr.hasAttribute('b')) out.b = ['1', 'true'].includes(rPr.getAttribute('b'));
  if (rPr.hasAttribute('i')) out.i = ['1', 'true'].includes(rPr.getAttribute('i'));
  if (rPr.hasAttribute('u')) out.u = rPr.getAttribute('u') !== 'none';
  const fill = kid(rPr, A, 'solidFill');
  if (fill) out.fill = fill;
  const latin = kid(rPr, A, 'latin')?.getAttribute('typeface');
  if (latin) out.latin = latin;
  return out;
}

/** A paragraph level's properties through the chain of list styles, then the paragraph's own. */
function mergeLevels(chain, level, pPr) {
  const merged = { defRPr: {} };
  const apply = (props) => {
    if (!props) return;
    if (props.hasAttribute('algn')) merged.algn = props.getAttribute('algn');
    if (kid(props, A, 'buNone')) merged.bullet = null;
    else if (kid(props, A, 'buChar')) merged.bullet = kid(props, A, 'buChar').getAttribute('char') || '•';
    else if (kid(props, A, 'buAutoNum')) merged.bullet = '•';
    Object.assign(merged.defRPr, readRPr(kid(props, A, 'defRPr')));
  };
  for (const list of chain) apply(kid(list, A, `lvl${Math.min(level, 8) + 1}pPr`));
  apply(pPr);
  return merged;
}

function paragraphText(p) {
  return kids(p).map((child) => {
    if (child.namespaceURI !== A) return '';
    if (child.localName === 'br') return '\n';
    if (child.localName === 'r' || child.localName === 'fld') return kid(child, A, 't')?.textContent ?? '';
    return '';
  }).join('');
}

/** Neighbouring runs that look the same, joined. */
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

const rounded = (box) => ({
  x: Math.round(box.x), y: Math.round(box.y),
  w: Math.max(1, Math.round(box.w)), h: Math.max(1, Math.round(box.h)),
  rotation: Math.round((box.rotation ?? 0) * 100) / 100,
});
