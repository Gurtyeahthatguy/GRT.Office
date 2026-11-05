/** Charts in Excel workbooks: a drawing per sheet, anchoring chart parts that draw from ranges. */

import { NS, kids, kid, tag, xmlDocument } from '../xml.js';
import { relationships, readPart } from './ooxml.js';
import { pointOf, anchorOf, KINDS, MAX_CHARTS, MAX_SERIES } from './chart-place.js';
import { SERIES_COLORS } from '../charts.js';

export const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
export const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
export const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
export const DRAWING_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml';
export const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const EMU_PER_PX = 9525;

const LEGEND_FROM = { r: 'right', l: 'left', t: 'top', b: 'bottom', tr: 'right' };
const LEGEND_TO = { right: 'r', left: 'l', top: 't', bottom: 'b' };

const val = (element, name) => kid(element, C, name)?.getAttribute('val') ?? null;

/** A formula of a series as Grid keeps a range: the first one when Excel lists several. */
function rangeFrom(element) {
  const f = element?.getElementsByTagNameNS(C, 'f')[0]?.textContent?.trim();
  if (!f) return null;
  const first = f.replace(/^\(|\)$/g, '').split(/,(?=(?:[^']*'[^']*')*[^']*$)/)[0].trim();
  return /!\$?[A-Z]{1,3}\$?\d+/i.test(first) ? first : null;
}

function richText(element) {
  return [...(element?.getElementsByTagNameNS(NS.a, 't') ?? [])].map((t) => t.textContent).join('');
}

const PLOTS = {
  barChart: 'column', bar3DChart: 'column', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter',
};

/** One chart part as one of Grid's charts. */
function readChart(doc, losses) {
  const chart = kid(doc.documentElement, C, 'chart');
  const plot = kid(chart, C, 'plotArea');
  if (!plot) return null;
  const groups = kids(plot).filter((element) => element.namespaceURI === C && /Chart$/.test(element.localName));
  const series = [];
  const kinds = new Set();
  let stacked = false;
  let horizontal = false;
  for (const group of groups) {
    let kind = PLOTS[group.localName];
    if (!kind) {
      losses.add('Charts of kinds Grid does not draw, shown as columns');
      kind = 'column';
    }
    if (val(group, 'barDir') === 'bar') { kind = 'bar'; horizontal = true; }
    const grouping = val(group, 'grouping');
    if (grouping === 'stacked') stacked = 'stacked';
    if (grouping === 'percentStacked') stacked = 'percent';
    kinds.add(kind);
    for (const ser of kids(group, C, 'ser')) {
      if (series.length >= MAX_SERIES) break;
      const values = rangeFrom(kid(ser, C, kind === 'scatter' ? 'yVal' : 'val'));
      if (!values) continue;
      const entry = { values, kind };
      const tx = kid(ser, C, 'tx');
      const nameRef = rangeFrom(tx);
      if (nameRef) entry.nameRef = nameRef;
      else if (kid(tx, C, 'v')) entry.name = kid(tx, C, 'v').textContent;
      const categories = rangeFrom(kid(ser, C, 'cat'));
      if (categories) entry.categories = categories;
      const x = rangeFrom(kid(ser, C, 'xVal'));
      if (x) entry.x = x;
      const fill = kid(kid(kid(ser, C, 'spPr'), NS.a, 'solidFill'), NS.a, 'srgbClr')?.getAttribute('val');
      if (fill && /^[0-9a-f]{6}$/i.test(fill)) entry.color = `#${fill.toLowerCase()}`;
      series.push(entry);
    }
  }
  if (series.length === 0) return null;
  let type = [...kinds][0];
  if (kinds.size > 1) type = 'combo';
  for (const s of series) {
    if (type === 'combo') s.type = s.kind === 'bar' ? 'column' : s.kind;
    delete s.kind;
  }
  const out = { type: horizontal && type === 'column' ? 'bar' : type, series };
  if (stacked) out.stacked = stacked;
  const legend = kid(chart, C, 'legend');
  out.legend = legend ? LEGEND_FROM[val(legend, 'legendPos') ?? 'r'] ?? 'right' : 'none';
  const title = richText(kid(chart, C, 'title'));
  if (title) out.title = title;
  const categoryAxis = kid(plot, C, 'catAx') ?? kid(plot, C, 'dateAx') ?? kids(plot, C, 'valAx')[type === 'scatter' ? 0 : -1];
  const valueAxis = type === 'scatter' ? kids(plot, C, 'valAx')[1] : kid(plot, C, 'valAx');
  const xTitle = richText(kid(categoryAxis, C, 'title'));
  if (xTitle) out.xTitle = xTitle;
  const yTitle = richText(kid(valueAxis, C, 'title'));
  if (yTitle) out.yTitle = yTitle;
  if (!KINDS.includes(out.type)) out.type = 'column';
  return out;
}

/** A cell corner of an anchor, in Grid's pixels. */
function cornerOf(element) {
  const number = (name) => Number(kid(element, XDR, name)?.textContent ?? 0) || 0;
  return { col: number('col'), row: number('row'), dx: Math.round(number('colOff') / EMU_PER_PX), dy: Math.round(number('rowOff') / EMU_PER_PX) };
}

/**
 * The charts a sheet's drawing anchors.
 * @param {object} sheet Grid's sheet as read, for its sizes
 */
export function readXlsxCharts(pkg, sheetPart, sheetRoot, sheet, sheetIndex, losses) {
  const drawing = kid(sheetRoot, NS.s, 'drawing');
  if (!drawing) return [];
  const rel = relationships(pkg, sheetPart).get(drawing.getAttributeNS(NS.r, 'id'));
  const doc = rel && !rel.external ? readPart(pkg, rel.target, 'a drawing') : null;
  if (!doc) {
    losses.add('Pictures and drawings in sheets');
    return [];
  }
  const chartRels = relationships(pkg, rel.target);
  const charts = [];
  let other = false;
  for (const anchor of kids(doc.documentElement)) {
    if (anchor.namespaceURI !== XDR || !/Anchor$/.test(anchor.localName)) continue;
    const frame = kid(anchor, XDR, 'graphicFrame');
    const ref = frame?.getElementsByTagNameNS(C, 'chart')[0];
    const target = ref ? chartRels.get(ref.getAttributeNS(NS.r, 'id')) : null;
    if (!target || target.external || !/\/chart$/.test(target.type)) {
      other = true;
      continue;
    }
    if (charts.length >= MAX_CHARTS) break;
    const part = readPart(pkg, target.target, 'a chart');
    const chart = part ? readChart(part, losses) : null;
    if (!chart) continue;
    let anchorAt;
    let size;
    if (anchor.localName === 'absoluteAnchor') {
      const pos = kid(anchor, XDR, 'pos');
      const at = { x: Number(pos?.getAttribute('x') ?? 0) / EMU_PER_PX, y: Number(pos?.getAttribute('y') ?? 0) / EMU_PER_PX };
      anchorAt = anchorOf(sheet, at.x, at.y);
    } else anchorAt = cornerOf(kid(anchor, XDR, 'from'));
    const ext = kid(anchor, XDR, 'ext');
    if (anchor.localName === 'twoCellAnchor') {
      const from = pointOf(sheet, anchorAt);
      const to = pointOf(sheet, cornerOf(kid(anchor, XDR, 'to')));
      size = { width: to.x - from.x, height: to.y - from.y };
    } else size = { width: Number(ext?.getAttribute('cx') ?? 0) / EMU_PER_PX, height: Number(ext?.getAttribute('cy') ?? 0) / EMU_PER_PX };
    charts.push({
      ...chart, sheet: sheetIndex, anchor: anchorAt,
      width: Math.max(80, Math.min(4000, Math.round(size.width) || 480)), height: Math.max(60, Math.min(4000, Math.round(size.height) || 300)),
    });
  }
  if (other) losses.add('Pictures and drawings in sheets');
  return charts;
}

// Writing

/** The values a range holds in the document, for the caches Excel shows before it calculates. */
function cached(document, ref) {
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i.exec(ref ?? '');
  if (!match) return [];
  const name = (match[1] ?? match[2]).replace(/''/g, "'");
  const sheet = (document.sheets ?? []).find((s) => s.name === name);
  if (!sheet) return [];
  const column = (letters) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const [c1, r1] = [column(match[3]), Number(match[4]) - 1];
  const [c2, r2] = match[5] ? [column(match[5]), Number(match[6]) - 1] : [c1, r1];
  const out = [];
  for (let r = r1; r <= r2 && out.length < 4000; r += 1) {
    for (let c = c1; c <= c2 && out.length < 4000; c += 1) out.push(sheet.cells?.[`${r},${c}`]?.v ?? null);
  }
  return out;
}

const point = (v, i) => tag('c:pt', { idx: String(i) }, tag('c:v', {}, String(v)));

function numRef(document, ref) {
  const values = cached(document, ref);
  return tag('c:numRef', {}, tag('c:f', {}, ref), tag('c:numCache', {},
    tag('c:formatCode', {}, 'General'), tag('c:ptCount', { val: String(values.length) }),
    values.map((v, i) => (typeof v === 'number' ? point(v, i) : null))));
}

function strRef(document, ref) {
  const values = cached(document, ref);
  return tag('c:strRef', {}, tag('c:f', {}, ref), tag('c:strCache', {},
    tag('c:ptCount', { val: String(values.length) }), values.map((v, i) => (v === null ? null : point(v, i)))));
}

const rich = (text) => tag('c:tx', {}, tag('c:rich', {}, tag('a:bodyPr', {}), tag('a:p', {}, tag('a:r', {}, tag('a:t', {}, text)))));
const titleXml = (text) => (text ? tag('c:title', {}, rich(text), tag('c:overlay', { val: '0' })) : null);

function seriesXml(document, s, i, kind) {
  const color = /^#[0-9a-f]{6}$/i.test(s.color ?? '') ? s.color : SERIES_COLORS[i % SERIES_COLORS.length];
  const fill = tag('a:solidFill', {}, tag('a:srgbClr', { val: color.slice(1).toUpperCase() }));
  const line = tag('a:ln', { w: '28575' }, tag('a:solidFill', {}, tag('a:srgbClr', { val: color.slice(1).toUpperCase() })));
  const name = s.nameRef ? tag('c:tx', {}, strRef(document, s.nameRef)) : s.name ? tag('c:tx', {}, tag('c:v', {}, s.name)) : null;
  const head = [tag('c:idx', { val: String(i) }), tag('c:order', { val: String(i) }), name];
  const categories = s.categories ? tag('c:cat', {}, (cached(document, s.categories).some((v) => typeof v === 'string') ? strRef : numRef)(document, s.categories)) : null;
  if (kind === 'scatter') {
    return tag('c:ser', {}, head, tag('c:spPr', {}, tag('a:ln', { w: '19050' }, tag('a:noFill', {}))),
      tag('c:marker', {}, tag('c:symbol', { val: 'circle' }), tag('c:size', { val: '5' }), tag('c:spPr', {}, fill)),
      s.x ? tag('c:xVal', {}, numRef(document, s.x)) : null, tag('c:yVal', {}, numRef(document, s.values)), tag('c:smooth', { val: '0' }));
  }
  if (kind === 'line') {
    return tag('c:ser', {}, head, tag('c:spPr', {}, line), tag('c:marker', {}, tag('c:symbol', { val: 'circle' }), tag('c:size', { val: '4' })),
      categories, tag('c:val', {}, numRef(document, s.values)), tag('c:smooth', { val: '0' }));
  }
  if (kind === 'pie' || kind === 'doughnut') {
    const points = cached(document, s.values).map((_, k) => tag('c:dPt', {}, tag('c:idx', { val: String(k) }), tag('c:bubble3D', { val: '0' }),
      tag('c:spPr', {}, tag('a:solidFill', {}, tag('a:srgbClr', { val: SERIES_COLORS[k % SERIES_COLORS.length].slice(1).toUpperCase() })))));
    return tag('c:ser', {}, head, points, categories, tag('c:val', {}, numRef(document, s.values)));
  }
  return tag('c:ser', {}, head, tag('c:spPr', {}, fill), kind === 'column' || kind === 'bar' ? tag('c:invertIfNegative', { val: '0' }) : null,
    categories, tag('c:val', {}, numRef(document, s.values)));
}

/** The chart part of one of Grid's charts. */
function chartXml(document, chart) {
  const type = KINDS.includes(chart.type) ? chart.type : 'column';
  const grouping = chart.stacked === 'percent' ? 'percentStacked' : chart.stacked === 'stacked' ? 'stacked' : null;
  const series = (chart.series ?? []).slice(0, MAX_SERIES);
  const kindOf = (s, i) => (type === 'combo' ? s.type ?? (i === 0 ? 'column' : 'line') : type);
  const axes = [tag('c:axId', { val: '1001' }), tag('c:axId', { val: '1002' })];
  const groups = [];
  const kindsUsed = [...new Set(series.map(kindOf))];
  for (const kind of kindsUsed) {
    const own = series.map((s, i) => [s, i]).filter(([s, i]) => kindOf(s, i) === kind).map(([s, i]) => seriesXml(document, s, i, kind));
    if (kind === 'column' || kind === 'bar') {
      groups.push(tag('c:barChart', {}, tag('c:barDir', { val: kind === 'bar' ? 'bar' : 'col' }), tag('c:grouping', { val: grouping ?? 'clustered' }),
        tag('c:varyColors', { val: '0' }), own, tag('c:gapWidth', { val: '100' }), grouping ? tag('c:overlap', { val: '100' }) : null, axes));
    } else if (kind === 'line') {
      groups.push(tag('c:lineChart', {}, tag('c:grouping', { val: grouping ?? 'standard' }), tag('c:varyColors', { val: '0' }), own, tag('c:marker', { val: '1' }), axes));
    } else if (kind === 'area') {
      groups.push(tag('c:areaChart', {}, tag('c:grouping', { val: grouping ?? 'standard' }), tag('c:varyColors', { val: '0' }), own, axes));
    } else if (kind === 'pie') {
      groups.push(tag('c:pieChart', {}, tag('c:varyColors', { val: '1' }), own, tag('c:firstSliceAng', { val: '0' })));
    } else if (kind === 'doughnut') {
      groups.push(tag('c:doughnutChart', {}, tag('c:varyColors', { val: '1' }), own, tag('c:firstSliceAng', { val: '0' }), tag('c:holeSize', { val: '50' })));
    } else if (kind === 'scatter') {
      groups.push(tag('c:scatterChart', {}, tag('c:scatterStyle', { val: 'lineMarker' }), tag('c:varyColors', { val: '0' }), own, axes));
    }
  }
  const round = type === 'pie' || type === 'doughnut';
  const horizontal = type === 'bar';
  const axis = (name, id, cross, position, title, extra = []) => tag(name, {},
    tag('c:axId', { val: id }), tag('c:scaling', {}, tag('c:orientation', { val: 'minMax' })), tag('c:delete', { val: '0' }),
    tag('c:axPos', { val: position }), ...extra.slice(0, 1), titleXml(title), tag('c:numFmt', { formatCode: grouping === 'percentStacked' && name === 'c:valAx' ? '0%' : 'General', sourceLinked: '1' }),
    tag('c:majorTickMark', { val: 'out' }), tag('c:minorTickMark', { val: 'none' }), tag('c:tickLblPos', { val: 'nextTo' }),
    tag('c:crossAx', { val: cross }), tag('c:crosses', { val: 'autoZero' }), ...extra.slice(1));
  const gridlines = [tag('c:majorGridlines', {})];
  const axisXml = round ? [] : type === 'scatter'
    ? [axis('c:valAx', '1001', '1002', 'b', chart.xTitle), axis('c:valAx', '1002', '1001', 'l', chart.yTitle, gridlines)]
    : [axis('c:catAx', '1001', '1002', horizontal ? 'l' : 'b', chart.xTitle, [null, tag('c:auto', { val: '1' }), tag('c:lblAlgn', { val: 'ctr' }), tag('c:lblOffset', { val: '100' })]),
      axis('c:valAx', '1002', '1001', horizontal ? 'b' : 'l', chart.yTitle, gridlines)];
  return xmlDocument(tag('c:chartSpace', { 'xmlns:c': C, 'xmlns:a': NS.a, 'xmlns:r': NS.r },
    tag('c:roundedCorners', { val: '0' }),
    tag('c:chart', {},
      titleXml(chart.title), tag('c:autoTitleDeleted', { val: chart.title ? '0' : '1' }),
      tag('c:plotArea', {}, tag('c:layout', {}), groups, axisXml),
      chart.legend && chart.legend !== 'none' ? tag('c:legend', {}, tag('c:legendPos', { val: LEGEND_TO[chart.legend] ?? 'r' }), tag('c:overlay', { val: '0' })) : null,
      tag('c:plotVisOnly', { val: '1' }), tag('c:dispBlanksAs', { val: 'gap' }))));
}

const corner = (at) => [
  tag('xdr:col', {}, String(at.col)), tag('xdr:colOff', {}, String(Math.round((at.dx ?? 0) * EMU_PER_PX))),
  tag('xdr:row', {}, String(at.row)), tag('xdr:rowOff', {}, String(Math.round((at.dy ?? 0) * EMU_PER_PX))),
];

/**
 * A sheet's drawing with its charts, and the parts it needs.
 * @param {number} drawingNumber the drawing's number among the workbook's
 * @param {number} firstChart the number of the sheet's first chart part
 */
export function writeXlsxCharts(document, sheet, charts, drawingNumber, firstChart) {
  const anchors = [];
  const rels = [];
  const parts = [];
  charts.slice(0, MAX_CHARTS).forEach((chart, i) => {
    const number = firstChart + i;
    const from = chart.anchor ?? { row: 0, col: 0, dx: 0, dy: 0 };
    const start = pointOf(sheet, from);
    const to = anchorOf(sheet, start.x + (chart.width ?? 480), start.y + (chart.height ?? 300));
    rels.push({ id: `rId${i + 1}`, type: REL_CHART, target: `../charts/chart${number}.xml` });
    parts.push({ name: `xl/charts/chart${number}.xml`, data: chartXml(document, chart), type: CHART_TYPE });
    anchors.push(tag('xdr:twoCellAnchor', { editAs: 'oneCell' },
      tag('xdr:from', {}, corner(from)), tag('xdr:to', {}, corner(to)),
      tag('xdr:graphicFrame', { macro: '' },
        tag('xdr:nvGraphicFramePr', {}, tag('xdr:cNvPr', { id: String(i + 2), name: chart.title || `Chart ${number}` }), tag('xdr:cNvGraphicFramePr', {})),
        tag('xdr:xfrm', {}, tag('a:off', { x: '0', y: '0' }), tag('a:ext', { cx: '0', cy: '0' })),
        tag('a:graphic', {}, tag('a:graphicData', { uri: C }, tag('c:chart', { 'xmlns:c': C, 'r:id': `rId${i + 1}` })))),
      tag('xdr:clientData', {})));
  });
  const drawing = `xl/drawings/drawing${drawingNumber}.xml`;
  parts.push({
    name: drawing, type: DRAWING_TYPE,
    data: xmlDocument(tag('xdr:wsDr', { 'xmlns:xdr': XDR, 'xmlns:a': NS.a, 'xmlns:r': NS.r }, anchors)),
  });
  parts.push({ name: `xl/drawings/_rels/drawing${drawingNumber}.xml.rels`, data: rels, rels: true });
  return { parts, drawingTarget: `../drawings/drawing${drawingNumber}.xml` };
}
