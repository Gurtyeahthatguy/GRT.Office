/** Charts in OpenDocument spreadsheets: objects of their own, drawing from ranges of the sheets. */

import { NS, kids, kid, attr, tag, xmlDocument, parseXml } from '../xml.js';
import { parseLength } from '../units.js';
import { ROOT_NAMESPACES, ODF_VERSION } from './odf.js';
import { fromOpenFormula, toOpenFormula } from './formulas.js';
import { pointOf, anchorOf, KINDS, MAX_CHARTS, MAX_SERIES } from './chart-place.js';

export const CHART_NS = 'urn:oasis:names:tc:opendocument:xmlns:chart:1.0';
export const CHART_MIMETYPE = 'application/vnd.oasis.opendocument.chart';
const PX_PER_MM = 96 / 25.4;

const LEGEND_FROM = { start: 'left', end: 'right', top: 'top', bottom: 'bottom', 'top-start': 'left', 'bottom-start': 'left', 'top-end': 'right', 'bottom-end': 'right' };
const LEGEND_TO = { left: 'start', right: 'end', top: 'top', bottom: 'bottom' };

/** A range of a chart, as Grid keeps it: `Sheet!$A$1:$A$9`; the first when the file lists several. */
function rangeFrom(address) {
  const first = String(address ?? '').trim().split(/\s+/)[0];
  if (!first) return null;
  const { formula } = fromOpenFormula(`of:=[${first}]`);
  return formula && !formula.includes('#REF!') ? formula.slice(1) : null;
}

function rangeTo(ref) {
  const formula = toOpenFormula(`=${ref}`);
  const match = /^of:=\[(.+)\]$/.exec(formula);
  return match ? match[1] : null;
}

const textOf = (element) => kids(element, NS.text, 'p').map((p) => p.textContent).join('\n');

/** The chart document an object frame points at, inline in a flat file or a part of the package. */
function chartDocument(object, source) {
  const inline = kid(object, NS.office, 'document');
  if (inline) return inline;
  const href = attr(object, NS.xlink, 'href');
  if (!href || typeof source?.text !== 'function') return null;
  const folder = href.replace(/^\.\//, '').replace(/\/$/, '');
  if (folder.includes('..') || folder.startsWith('/')) return null;
  const text = source.text(`${folder}/content.xml`);
  if (!text) return null;
  try {
    return parseXml(text, `${folder}/content.xml`).documentElement;
  } catch {
    return null;
  }
}

/** The chart properties of a style of the chart document, by name. */
function chartProperties(root, name) {
  if (!name) return {};
  const styles = kid(root, NS.office, 'automatic-styles');
  const style = kids(styles, NS.style, 'style').find((s) => attr(s, NS.style, 'name') === name);
  const props = kid(style, NS.style, 'chart-properties');
  const out = {};
  for (const a of props?.attributes ?? []) out[a.localName] = a.value;
  return out;
}

/** One chart object as one of Grid's charts, or null when it is not a chart Grid can draw. */
function readChart(root, frame, sheet, sheetId, losses) {
  const chart = kid(kid(kid(root, NS.office, 'body'), NS.office, 'chart'), CHART_NS, 'chart');
  if (!chart) return null;
  const plot = kid(chart, CHART_NS, 'plot-area');
  const plotProps = chartProperties(root, attr(plot, CHART_NS, 'style-name'));
  const kind = (attr(chart, CHART_NS, 'class') ?? '').replace(/^chart:/, '');
  let type = { bar: plotProps.vertical === 'true' ? 'bar' : 'column', line: 'line', area: 'area', circle: 'pie', ring: 'doughnut', scatter: 'scatter' }[kind];
  if (!type) {
    losses.add('Charts of kinds Grid does not draw, shown as columns');
    type = 'column';
  }
  const axes = kids(plot, CHART_NS, 'axis');
  const xAxis = axes.find((a) => attr(a, CHART_NS, 'dimension') === 'x');
  const yAxis = axes.find((a) => attr(a, CHART_NS, 'dimension') === 'y');
  const categories = rangeFrom(attr(kid(xAxis, CHART_NS, 'categories'), NS.table, 'cell-range-address'));
  const series = [];
  for (const s of kids(plot, CHART_NS, 'series').slice(0, MAX_SERIES)) {
    const values = rangeFrom(attr(s, CHART_NS, 'values-cell-range-address'));
    if (!values) continue;
    const own = (attr(s, CHART_NS, 'class') ?? '').replace(/^chart:/, '');
    const entry = { values };
    const label = rangeFrom(attr(s, CHART_NS, 'label-cell-address'));
    if (label) entry.nameRef = label;
    if (categories && type !== 'scatter') entry.categories = categories;
    const domain = rangeFrom(attr(kid(s, CHART_NS, 'domain'), NS.table, 'cell-range-address'));
    if (domain && type === 'scatter') entry.x = domain;
    const seriesProps = chartProperties(root, attr(s, CHART_NS, 'style-name'));
    if (own && own !== kind && ['line', 'bar', 'area'].includes(own)) entry.type = own === 'bar' ? 'column' : own;
    if (seriesProps['fill-color']) entry.color = seriesProps['fill-color'];
    series.push(entry);
  }
  // A scatter chart whose first series has no domain takes the categories as its x values.
  if (type === 'scatter' && categories) for (const s of series) s.x ??= categories;
  if (series.some((s) => s.type && s.type !== type)) {
    for (const s of series) s.type ??= type;
    type = 'combo';
  }
  const legend = kid(chart, CHART_NS, 'legend');
  const out = {
    type,
    series,
    legend: legend ? LEGEND_FROM[attr(legend, CHART_NS, 'legend-position')] ?? 'right' : 'none',
  };
  if (plotProps.percentage === 'true') out.stacked = 'percent';
  else if (plotProps.stacked === 'true') out.stacked = 'stacked';
  const title = textOf(kid(chart, CHART_NS, 'title'));
  if (title) out.title = title;
  const xTitle = textOf(kid(xAxis, CHART_NS, 'title'));
  if (xTitle) out.xTitle = xTitle;
  const yTitle = textOf(kid(yAxis, CHART_NS, 'title'));
  if (yTitle) out.yTitle = yTitle;

  const px = (name) => Math.round((parseLength(attr(frame, NS.svg, name) ?? '0') ?? 0) * PX_PER_MM);
  out.width = Math.max(80, Math.min(4000, px('width') || 480));
  out.height = Math.max(60, Math.min(4000, px('height') || 300));
  out.anchor = anchorOf(sheet, px('x'), px('y'));
  out.sheet = sheetId;
  if (!KINDS.includes(out.type)) out.type = 'column';
  return out;
}

/**
 * The charts on the sheets of a spreadsheet.
 * @param {Element[]} tables the table:table elements, in the order of `sheets`
 * @param {{id: string}[]} sheets Grid's sheets as read, for their sizes and ids
 */
export function readOdsCharts(tables, sheets, source, losses) {
  const charts = [];
  tables.forEach((table, i) => {
    for (const frame of table.getElementsByTagNameNS(NS.draw, 'frame')) {
      if (charts.length >= MAX_CHARTS) return;
      const object = kid(frame, NS.draw, 'object');
      if (!object) continue;
      const root = chartDocument(object, source);
      const chart = root ? readChart(root, frame, sheets[i], i, losses) : null;
      if (chart) charts.push({ id: `chart-${charts.length + 1}`, ...chart });
    }
  });
  return charts;
}

/** Whether a sheet holds a frame other than a chart, which Grid does not keep. */
export function hasOtherFrames(table) {
  for (const frame of table.getElementsByTagNameNS(NS.draw, 'frame')) {
    const object = kid(frame, NS.draw, 'object');
    if (!object || attr(object, NS.xlink, 'href') === null && !kid(object, NS.office, 'document')) return true;
  }
  return false;
}

// Writing

const mm = (px) => `${(Math.round((px / PX_PER_MM) * 100) / 100).toFixed(2)}mm`;

/** The chart object's content: the plot, its series and their ranges; inside the frame in a flat file. */
function chartContent(chart, inline = false) {
  const round = chart.type === 'pie' || chart.type === 'doughnut';
  const kind = { column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'circle', doughnut: 'ring', scatter: 'scatter', combo: 'bar' }[chart.type] ?? 'bar';
  const styles = [];
  const plotProps = {};
  if (chart.type === 'bar') plotProps['chart:vertical'] = 'true';
  if (chart.stacked === 'stacked') plotProps['chart:stacked'] = 'true';
  if (chart.stacked === 'percent') Object.assign(plotProps, { 'chart:stacked': 'true', 'chart:percentage': 'true' });
  styles.push(tag('style:style', { 'style:name': 'plot', 'style:family': 'chart' }, tag('style:chart-properties', plotProps)));
  const series = (chart.series ?? []).slice(0, MAX_SERIES).map((s, i) => {
    const styleName = `series${i + 1}`;
    if (s.color) styles.push(tag('style:style', { 'style:name': styleName, 'style:family': 'chart' }, tag('style:graphic-properties', { 'draw:fill-color': s.color, 'svg:stroke-color': s.color })));
    const own = chart.type === 'combo' ? ({ column: 'bar', line: 'line', area: 'area' }[s.type ?? (i === 0 ? 'column' : 'line')] ?? 'bar') : null;
    return tag('chart:series', {
      'chart:style-name': s.color ? styleName : null,
      'chart:values-cell-range-address': rangeTo(s.values),
      'chart:label-cell-address': s.nameRef ? rangeTo(s.nameRef) : null,
      'chart:class': own ? `chart:${own}` : null,
    }, chart.type === 'scatter' && s.x ? tag('chart:domain', { 'table:cell-range-address': rangeTo(s.x) }) : null);
  });
  const categories = chart.series?.find((s) => s.categories)?.categories;
  const title = (text, extra = {}) => (text ? tag('chart:title', extra, tag('text:p', {}, text)) : null);
  // A pie keeps its labels on an x axis it does not draw, as LibreOffice writes it.
  const axes = round ? [tag('chart:axis', { 'chart:dimension': 'x', 'chart:name': 'primary-x' },
    categories ? tag('chart:categories', { 'table:cell-range-address': rangeTo(categories) }) : null)] : [
    tag('chart:axis', { 'chart:dimension': 'x', 'chart:name': 'primary-x' },
      title(chart.xTitle), categories && chart.type !== 'scatter' ? tag('chart:categories', { 'table:cell-range-address': rangeTo(categories) }) : null),
    tag('chart:axis', { 'chart:dimension': 'y', 'chart:name': 'primary-y' }, title(chart.yTitle), tag('chart:grid', { 'chart:class': 'major' })),
  ];
  return tag(inline ? 'office:document' : 'office:document-content', {
    ...(inline ? { 'office:mimetype': CHART_MIMETYPE } : ROOT_NAMESPACES), 'xmlns:chart': CHART_NS, 'office:version': ODF_VERSION,
  },
  tag('office:automatic-styles', {}, styles),
    tag('office:body', {}, tag('office:chart', {}, tag('chart:chart', {
      'chart:class': `chart:${kind}`, 'svg:width': mm(chart.width ?? 480), 'svg:height': mm(chart.height ?? 300),
    },
    title(chart.title),
    chart.legend && chart.legend !== 'none' ? tag('chart:legend', { 'chart:legend-position': LEGEND_TO[chart.legend] ?? 'end', 'svg:x': null }) : null,
    tag('chart:plot-area', { 'chart:style-name': 'plot', 'chart:data-source-has-labels': 'both' }, axes, series)))));
}

/**
 * The frames that place a sheet's charts, and the object parts they point at.
 * @returns {{shapes: object|null, files: {name: string, data: string, mediaType: string}[]}}
 */
export function writeOdsCharts(sheet, charts, firstNumber, { flat = false } = {}) {
  const files = [];
  const frames = [];
  charts.slice(0, MAX_CHARTS).forEach((chart, i) => {
    const folder = `Object ${firstNumber + i}`;
    const at = pointOf(sheet, chart.anchor);
    const ranges = (chart.series ?? []).flatMap((s) => [s.values, s.categories, s.x].filter(Boolean)).map(rangeTo).filter(Boolean);
    frames.push(tag('draw:frame', {
      'draw:z-index': String(i), 'draw:name': chart.title || `Chart ${firstNumber + i}`,
      'svg:x': mm(at.x), 'svg:y': mm(at.y), 'svg:width': mm(chart.width ?? 480), 'svg:height': mm(chart.height ?? 300),
    }, tag('draw:object', {
      'draw:notify-on-update-of-ranges': [...new Set(ranges)].join(' ') || null,
      ...(flat ? {} : { 'xlink:href': `./${folder}`, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad' }),
    }, flat ? chartContent(chart, true) : null)));
    if (flat) return;
    files.push({ name: `${folder}/`, mediaType: CHART_MIMETYPE, manifestOnly: true });
    files.push({ name: `${folder}/content.xml`, data: xmlDocument(chartContent(chart)), mediaType: 'text/xml' });
  });
  return { shapes: frames.length ? tag('table:shapes', {}, frames) : null, files };
}
