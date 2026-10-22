/** OpenDocument drawings to and from Graphs' document. */

import { NS, kids, kid, attr, is, tag, xmlDocument } from '../xml.js';
import { parseLength, formatLength } from '../units.js';
import { Losses } from '../losses.js';
import {
  odfDocuments, OdfStyles, MIMETYPES, ODF_VERSION, ROOT_NAMESPACES, odfPackage, odfText,
} from './odf.js';

const PX_PER_MM = 96 / 25.4;
const MARGIN = 20;

const px = (text) => {
  const mm = parseLength(text);
  return mm === null ? null : mm * PX_PER_MM;
};
const cm = (pixels) => formatLength(pixels / PX_PER_MM, 'cm');

const PRESETS = {
  rectangle: 'rect', 'ooxml-rect': 'rect', 'round-rectangle': 'rounded', 'ooxml-roundRect': 'rounded',
  ellipse: 'ellipse', 'ooxml-ellipse': 'ellipse', circle: 'ellipse', diamond: 'diamond', 'ooxml-diamond': 'diamond',
  parallelogram: 'parallelogram', 'ooxml-parallelogram': 'parallelogram', hexagon: 'hexagon', 'ooxml-hexagon': 'hexagon',
  octagon: 'hexagon', 'isosceles-triangle': 'triangle', 'ooxml-triangle': 'triangle',
  'flowchart-process': 'rect', 'flowchart-decision': 'diamond', 'flowchart-terminator': 'rounded',
  'flowchart-alternate-process': 'rounded', 'flowchart-connector': 'ellipse', 'flowchart-data': 'parallelogram',
  'flowchart-preparation': 'hexagon', 'ooxml-flowChartProcess': 'rect', 'ooxml-flowChartDecision': 'diamond',
};
const TYPES = {
  rect: 'rectangle', rounded: 'round-rectangle', ellipse: 'ellipse', diamond: 'diamond',
  parallelogram: 'parallelogram', hexagon: 'hexagon', triangle: 'isosceles-triangle',
};
// A preset shape's first four glue points sit on the middle of each side.
const GLUE = ['top', 'right', 'bottom', 'left'];
const ROUTING = { standard: 'orthogonal', line: 'straight', lines: 'straight', curve: 'curved' };
const CONNECTOR = { orthogonal: 'standard', straight: 'line', curved: 'curve' };

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

  const pages = kids(body, NS.draw, 'page');
  if (pages.length > 1) losses.add('Pages after the first');
  const reader = { styles, losses, nodes: [], edges: [], byName: new Map(), looks: new Map(), ids: 0 };
  const connectors = [];
  if (pages[0]) collect(pages[0], reader, connectors);
  for (const connector of connectors) readConnector(connector, reader);

  const graphStyles = {};
  for (const [name, look] of reader.looks) graphStyles[name] = look;
  return {
    document: {
      version: 1, type: 'graphs', nodes: reader.nodes, edges: reader.edges,
      styles: { ...DEFAULT_STYLES, ...graphStyles }, meta: { gridSize: 10, snapToGrid: true },
    },
    losses,
  };
}

const DEFAULT_STYLES = {
  default: { fill: '#ffffff', stroke: '#333333', strokeWidth: 2 },
  accent: { fill: '#e8f0fe', stroke: '#1f6feb', strokeWidth: 2 },
  warn: { fill: '#fff4e5', stroke: '#b26a00', strokeWidth: 2 },
};

function collect(container, reader, connectors) {
  for (const node of kids(container)) {
    if (node.namespaceURI !== NS.draw) continue;
    if (node.localName === 'g') {
      reader.losses.add('Groups, kept as their shapes');
      collect(node, reader, connectors);
    } else if (node.localName === 'connector') {
      connectors.push(node);
    } else if (node.localName === 'line') {
      reader.losses.add('Lines not joined to shapes');
    } else {
      readShape(node, reader);
    }
  }
}

function readShape(element, reader) {
  const { losses } = reader;
  let shape = null;
  if (element.localName === 'custom-shape') {
    const type = attr(kid(element, NS.draw, 'enhanced-geometry'), NS.draw, 'type') ?? '';
    shape = PRESETS[type] ?? null;
    if (!shape) {
      losses.add('Shapes Graphs does not have, drawn as rectangles');
      shape = 'rect';
    }
  } else if (element.localName === 'rect') {
    shape = parseLength(attr(element, NS.draw, 'corner-radius')) > 0 ? 'rounded' : 'rect';
  } else if (element.localName === 'ellipse' || element.localName === 'circle') {
    shape = 'ellipse';
  } else if (['polygon', 'polyline', 'path'].includes(element.localName)) {
    losses.add('Freeform shapes, drawn as rectangles');
    shape = 'rect';
  } else if (element.localName === 'frame') {
    if (kid(element, NS.draw, 'text-box')) shape = 'rect';
    else {
      losses.add(kid(element, NS.draw, 'image') ? 'Pictures' : 'Charts and embedded objects');
      return;
    }
  } else {
    if (['control', 'measure', 'caption'].includes(element.localName)) losses.add('Callouts, dimension lines and form controls');
    return;
  }
  const x = px(attr(element, NS.svg, 'x'));
  const y = px(attr(element, NS.svg, 'y'));
  const w = px(attr(element, NS.svg, 'width'));
  const h = px(attr(element, NS.svg, 'height'));
  if ([x, y, w, h].some((v) => v === null)) {
    if (attr(element, NS.draw, 'transform')) losses.add('Turned shapes, shown upright');
    if (w === null || h === null) return;
  }
  const holder = element.localName === 'frame' ? kid(element, NS.draw, 'text-box') : element;
  const text = plain(holder, reader);
  const id = `n${(reader.ids += 1)}`;
  const name = attr(element, NS.draw, 'id') ?? attr(element, 'http://www.w3.org/XML/1998/namespace', 'id');
  if (name) reader.byName.set(name, id);
  reader.nodes.push({
    id, shape, x: Math.round(x ?? 0), y: Math.round(y ?? 0), w: Math.max(20, Math.round(w)), h: Math.max(20, Math.round(h)),
    text, style: lookFor(element, reader), data: {},
  });
}

/** The node style a shape's fill and outline match, made when none does. */
function lookFor(element, reader) {
  const props = reader.styles.resolve('graphic', attr(element, NS.draw, 'style-name'), 'graphic');
  const look = {
    fill: props.fill === 'none' ? 'none' : (props['fill-color'] ?? '#729fcf').toLowerCase(),
    stroke: props.stroke === 'none' ? 'none' : (props['stroke-color'] ?? '#3465a4').toLowerCase(),
    strokeWidth: Math.max(1, Math.round(px(props['stroke-width']) ?? 1)),
  };
  if (props.fill && !['none', 'solid'].includes(props.fill)) reader.losses.add('Gradient and picture fills, shown as one colour');
  const same = (a) => a.fill === look.fill && a.stroke === look.stroke && a.strokeWidth === look.strokeWidth;
  for (const [name, existing] of [...Object.entries(DEFAULT_STYLES), ...reader.looks]) if (same(existing)) return name;
  const name = `imported-${reader.looks.size + 1}`;
  reader.looks.set(name, look);
  return name;
}

function plain(holder, reader) {
  const lines = [];
  const visit = (parent) => {
    for (const child of kids(parent)) {
      if (is(child, NS.text, 'p') || is(child, NS.text, 'h')) lines.push(paragraphText(child, reader));
      else if (is(child, NS.text, 'list') || is(child, NS.text, 'list-item')) visit(child);
    }
  };
  visit(holder);
  return lines.join('\n').trim();
}

function paragraphText(p, reader) {
  let out = '';
  for (const child of p.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue.replace(/[\t\n\r ]+/g, ' ');
    else if (is(child, NS.text, 's')) out += ' '.repeat(Number(attr(child, NS.text, 'c') ?? 1));
    else if (is(child, NS.text, 'line-break')) out += '\n';
    else if (is(child, NS.text, 'tab')) out += '\t';
    else if (child.nodeType === 1) {
      if (is(child, NS.text, 'span')) {
        const props = reader.styles.resolve('text', attr(child, NS.text, 'style-name'), 'text');
        if (props['font-weight'] === 'bold' || props['font-style'] === 'italic' || props.color) {
          reader.losses.add('Text formatting, shown plain');
        }
      }
      out += paragraphText(child, reader);
    }
  }
  return out;
}

function readConnector(element, reader) {
  const from = reader.byName.get(attr(element, NS.draw, 'start-shape'));
  const to = reader.byName.get(attr(element, NS.draw, 'end-shape'));
  if (!from || !to) {
    reader.losses.add('Lines not joined to shapes');
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
    id: `e${(reader.ids += 1)}`,
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

/**
 * @param {object} document Graphs' toJSON()
 * @param {{flat?: boolean}} options
 * @returns {{entries?: object[], text?: string, losses: Losses}}
 */
export function writeOdg(document, { flat = false } = {}) {
  const losses = new Losses();
  const nodes = document.nodes ?? [];
  const edges = document.edges ?? [];
  const styles = { ...DEFAULT_STYLES, ...(document.styles ?? {}) };

  const minX = Math.min(0, ...nodes.map((n) => n.x - MARGIN));
  const minY = Math.min(0, ...nodes.map((n) => n.y - MARGIN));
  const dx = -minX;
  const dy = -minY;
  const width = Math.max(200, ...nodes.map((n) => n.x + n.w + dx + MARGIN));
  const height = Math.max(200, ...nodes.map((n) => n.y + n.h + dy + MARGIN));

  const automatic = new Map();
  const style = (family, prefix, properties) => {
    const key = JSON.stringify([family, properties]);
    if (!automatic.has(key)) {
      const count = [...automatic.values()].filter((s) => s.attrs['style:name'].startsWith(prefix)).length + 1;
      automatic.set(key, tag('style:style', { 'style:name': `${prefix}${count}`, 'style:family': family }, properties));
    }
    return automatic.get(key).attrs['style:name'];
  };
  const paragraph = style('paragraph', 'P', [tag('style:paragraph-properties', { 'fo:text-align': 'center' }),
    tag('style:text-properties', { 'fo:font-size': '10pt', 'fo:color': '#222222', 'fo:font-family': 'Liberation Sans' })]);
  const textOf = (text) => String(text ?? '').split('\n').map((line) => tag('text:p', { 'text:style-name': paragraph }, odfText(line)));

  const shapes = nodes.map((node, i) => {
    const look = styles[node.style] ?? styles.default;
    const graphic = style('graphic', 'gr', [tag('style:graphic-properties', {
      'draw:fill': look.fill === 'none' ? 'none' : 'solid', 'draw:fill-color': look.fill === 'none' ? null : look.fill,
      'draw:stroke': look.stroke === 'none' ? 'none' : 'solid', 'svg:stroke-color': look.stroke === 'none' ? null : look.stroke,
      'svg:stroke-width': cm(look.strokeWidth ?? 2), 'draw:textarea-horizontal-align': 'center',
      'draw:textarea-vertical-align': 'middle', 'draw:auto-grow-height': 'false', 'draw:shadow': 'hidden',
      'fo:padding-top': '0.1cm', 'fo:padding-bottom': '0.1cm', 'fo:padding-left': '0.1cm', 'fo:padding-right': '0.1cm',
    })]);
    return tag('draw:custom-shape', {
      'draw:style-name': graphic, 'draw:text-style-name': paragraph, 'xml:id': `shape${i + 1}`, 'draw:id': `shape${i + 1}`,
      'svg:x': cm(node.x + dx), 'svg:y': cm(node.y + dy), 'svg:width': cm(node.w), 'svg:height': cm(node.h),
    }, textOf(node.text), tag('draw:enhanced-geometry', { 'svg:viewBox': '0 0 21600 21600', 'draw:type': TYPES[node.shape] ?? 'rectangle' }));
  });
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const connectorStyle = style('graphic', 'gr', [tag('style:graphic-properties', {
    'draw:stroke': 'solid', 'svg:stroke-color': '#333333', 'svg:stroke-width': cm(2),
    'draw:marker-end': 'Arrow', 'draw:marker-end-width': cm(10), 'draw:fill': 'none', 'draw:shadow': 'hidden',
  })]);
  const connectors = edges.map((edge) => {
    const from = nodes[index.get(edge.from)];
    const to = nodes[index.get(edge.to)];
    if (!from || !to) {
      losses.add('Lines whose ends are missing, left out');
      return null;
    }
    if ((edge.waypoints ?? []).length > 0) losses.add('Bends placed by hand, routed again');
    const glue = (port) => (GLUE.includes(port) ? String(GLUE.indexOf(port)) : null);
    return tag('draw:connector', {
      'draw:style-name': connectorStyle, 'draw:text-style-name': paragraph, 'draw:type': CONNECTOR[edge.routing] ?? 'standard',
      'svg:x1': cm(from.x + from.w / 2 + dx), 'svg:y1': cm(from.y + from.h / 2 + dy),
      'svg:x2': cm(to.x + to.w / 2 + dx), 'svg:y2': cm(to.y + to.h / 2 + dy),
      'draw:start-shape': `shape${index.get(edge.from) + 1}`, 'draw:start-glue-point': glue(edge.fromPort),
      'draw:end-shape': `shape${index.get(edge.to) + 1}`, 'draw:end-glue-point': glue(edge.toPort),
    }, edge.label ? textOf(edge.label) : null);
  });

  const namespaces = { ...ROOT_NAMESPACES, 'office:version': ODF_VERSION };
  const markers = tag('office:styles', {},
    tag('draw:marker', { 'draw:name': 'Arrow', 'svg:viewBox': '0 0 20 30', 'svg:d': 'M10 0l-10 30h20z' }));
  const layout = tag('style:page-layout', { 'style:name': 'PM1' }, tag('style:page-layout-properties', {
    'fo:margin-top': '0cm', 'fo:margin-bottom': '0cm', 'fo:margin-left': '0cm', 'fo:margin-right': '0cm',
    'fo:page-width': cm(width), 'fo:page-height': cm(height), 'style:print-orientation': width >= height ? 'landscape' : 'portrait',
  }));
  const masters = tag('office:master-styles', {}, tag('style:master-page', { 'style:name': 'Default', 'style:page-layout-name': 'PM1' }));
  const page = tag('office:body', {}, tag('office:drawing', {},
    tag('draw:page', { 'draw:name': 'page1', 'draw:master-page-name': 'Default' }, shapes, connectors)));

  if (flat) {
    const root = tag('office:document', { ...namespaces, 'office:mimetype': MIMETYPES.graphics },
      markers, tag('office:automatic-styles', {}, layout, [...automatic.values()]), masters, page);
    return { text: xmlDocument(root), losses };
  }
  const styleDoc = tag('office:document-styles', namespaces, markers, tag('office:automatic-styles', {}, layout), masters);
  const content = tag('office:document-content', namespaces, tag('office:automatic-styles', {}, [...automatic.values()]), page);
  return {
    entries: odfPackage(MIMETYPES.graphics, [
      { name: 'content.xml', data: xmlDocument(content), mediaType: 'text/xml' },
      { name: 'styles.xml', data: xmlDocument(styleDoc), mediaType: 'text/xml' },
    ]),
    losses,
  };
}
