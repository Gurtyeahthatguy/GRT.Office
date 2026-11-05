/** A chart that carries its own data, as text documents and presentations hold one: in ODF an object with a local table, in OOXML a chart part with its values cached. */

import { NS, kids, kid, attr, tag, xmlDocument } from '../xml.js';
import { parseLength } from '../units.js';
import { ROOT_NAMESPACES, ODF_VERSION } from './odf.js';
import { KINDS, MAX_SERIES } from './chart-place.js';
import { SERIES_COLORS } from '../charts.js';

export const CHART_NS = 'urn:oasis:names:tc:opendocument:xmlns:chart:1.0';
export const CHART_MIMETYPE = 'application/vnd.oasis.opendocument.chart';
export const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const OOXML_CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
export const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const MAX_POINTS = 4000;

const LEGEND_FROM = { start: 'left', end: 'right', top: 'top', bottom: 'bottom' };
const LEGEND_TO = { left: 'start', right: 'end', top: 'top', bottom: 'bottom' };

/** A chart's own data made safe: names as text, values as numbers or empty, within limits. */
export function normaliseChartData(data) {
  const series = (Array.isArray(data?.series) ? data.series : []).slice(0, MAX_SERIES).map((s, i) => ({
    name: typeof s?.name === 'string' ? s.name.slice(0, 200) : `Series ${i + 1}`,
    values: (Array.isArray(s?.values) ? s.values : []).slice(0, MAX_POINTS).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)),
    ...(typeof s?.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? { color: s.color } : {}),
    ...(['column', 'line', 'area'].includes(s?.type) ? { type: s.type } : {}),
  }));
  const count = Math.max(0, ...series.map((s) => s.values.length));
  const categories = Array.from({ length: count }, (_, i) => String(data?.categories?.[i] ?? i + 1).slice(0, 200));
  return { categories, series };
}

/** What the chart engine draws for a chart with its own data. */
export function ownChartSpec(chart) {
  const data = normaliseChartData(chart.data);
  return {
    type: KINDS.includes(chart.type) ? chart.type : 'column', stacked: chart.stacked ?? false,
    title: chart.title ?? '', xTitle: chart.xTitle ?? '', yTitle: chart.yTitle ?? '', legend: chart.legend ?? 'right',
    categories: data.categories, series: data.series,
  };
}

/** Data typed as lines of values: the first line names the series, the first column the categories. */
export function dataFromText(text) {
  const rows = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, MAX_POINTS + 1)
    .map((line) => line.split(/\t|;|,(?=\s*[^\s\d])|,(?=\s*-?\d)/).map((cell) => cell.trim()));
  if (rows.length < 2) return normaliseChartData({});
  const [head, ...body] = rows;
  const number = (cell) => (cell === '' ? null : Number(cell.replace(/\s/g, '')));
  return normaliseChartData({
    categories: body.map((row) => row[0]),
    series: head.slice(1).map((name, i) => ({ name, values: body.map((row) => number(row[i + 1] ?? '')) })),
  });
}

export function dataToText(data) {
  const { categories, series } = normaliseChartData(data);
  return [['', ...series.map((s) => s.name)].join('\t'), ...categories.map((c, i) => [c, ...series.map((s) => s.values[i] ?? '')].join('\t'))].join('\n');
}

// OpenDocument

const columnName = (index) => {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};

/** The chart document of an embedded chart, its data in a local table as LibreOffice writes it. */
export function odfChartDocument(chart, { inline = false, width = 400, height = 260 } = {}) {
  const data = normaliseChartData(chart.data);
  const rows = data.categories.length;
  const kind = { column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'circle', doughnut: 'ring', scatter: 'scatter', combo: 'bar' }[chart.type] ?? 'bar';
  const plotProps = {};
  if (chart.type === 'bar') plotProps['chart:vertical'] = 'true';
  if (chart.stacked === 'stacked') plotProps['chart:stacked'] = 'true';
  if (chart.stacked === 'percent') Object.assign(plotProps, { 'chart:stacked': 'true', 'chart:percentage': 'true' });
  const styles = [tag('style:style', { 'style:name': 'plot', 'style:family': 'chart' }, tag('style:chart-properties', plotProps))];
  const range = (col, from, to) => `local-table.$${columnName(col)}$${from}:.$${columnName(col)}$${to}`;
  const series = data.series.map((s, i) => {
    if (s.color) styles.push(tag('style:style', { 'style:name': `series${i + 1}`, 'style:family': 'chart' }, tag('style:graphic-properties', { 'draw:fill-color': s.color, 'svg:stroke-color': s.color })));
    const own = chart.type === 'combo' ? ({ column: 'bar', line: 'line', area: 'area' }[s.type ?? (i === 0 ? 'column' : 'line')] ?? 'bar') : null;
    return tag('chart:series', {
      'chart:style-name': s.color ? `series${i + 1}` : null,
      'chart:values-cell-range-address': range(i + 1, 2, rows + 1),
      'chart:label-cell-address': `local-table.$${columnName(i + 1)}$1`,
      'chart:class': own ? `chart:${own}` : null,
    }, chart.type === 'scatter' ? tag('chart:domain', { 'table:cell-range-address': range(0, 2, rows + 1) }) : null);
  });
  const title = (text) => (text ? tag('chart:title', {}, tag('text:p', {}, text)) : null);
  const round = chart.type === 'pie' || chart.type === 'doughnut';
  const cell = (value) => (typeof value === 'number'
    ? tag('table:table-cell', { 'office:value-type': 'float', 'office:value': String(value) }, tag('text:p', {}, String(value)))
    : tag('table:table-cell', { 'office:value-type': 'string' }, tag('text:p', {}, value ?? '')));
  const table = tag('table:table', { 'table:name': 'local-table' },
    tag('table:table-header-columns', {}, tag('table:table-column', {})),
    tag('table:table-columns', {}, tag('table:table-column', { 'table:number-columns-repeated': String(Math.max(1, data.series.length)) })),
    tag('table:table-header-rows', {}, tag('table:table-row', {}, cell(''), data.series.map((s) => cell(s.name)))),
    tag('table:table-rows', {}, data.categories.map((category, r) => tag('table:table-row', {}, cell(category), data.series.map((s) => (s.values[r] === null ? tag('table:table-cell', {}) : cell(s.values[r])))))));
  const axes = [
    tag('chart:axis', { 'chart:dimension': 'x', 'chart:name': 'primary-x' }, round ? null : title(chart.xTitle),
      chart.type !== 'scatter' ? tag('chart:categories', { 'table:cell-range-address': range(0, 2, rows + 1) }) : null),
    ...(round ? [] : [tag('chart:axis', { 'chart:dimension': 'y', 'chart:name': 'primary-y' }, title(chart.yTitle), tag('chart:grid', { 'chart:class': 'major' }))]),
  ];
  const mm = (px) => `${((px * 25.4) / 96).toFixed(2)}mm`;
  return tag(inline ? 'office:document' : 'office:document-content', {
    ...(inline ? { 'office:mimetype': CHART_MIMETYPE } : ROOT_NAMESPACES), 'xmlns:chart': CHART_NS, 'office:version': ODF_VERSION,
  },
  tag('office:automatic-styles', {}, styles),
  tag('office:body', {}, tag('office:chart', {}, tag('chart:chart', { 'chart:class': `chart:${kind}`, 'svg:width': mm(width), 'svg:height': mm(height) },
    title(chart.title),
    (chart.legend ?? 'right') !== 'none' ? tag('chart:legend', { 'chart:legend-position': LEGEND_TO[chart.legend ?? 'right'] ?? 'end' }) : null,
    tag('chart:plot-area', { 'chart:style-name': 'plot', 'chart:data-source-has-labels': 'both' }, axes, series),
    table))));
}

export const odfChartXml = (chart, size) => xmlDocument(odfChartDocument(chart, size));

/** The values of a chart's local table, row by row. */
function localTable(chartElement) {
  const table = [...chartElement.getElementsByTagNameNS(NS.table, 'table')][0];
  if (!table) return [];
  const rows = [];
  for (const row of table.getElementsByTagNameNS(NS.table, 'table-row')) {
    if (rows.length > MAX_POINTS + 1) break;
    const cells = [];
    for (const cell of kids(row)) {
      if (cell.localName !== 'table-cell' && cell.localName !== 'covered-table-cell') continue;
      const repeat = Math.min(MAX_SERIES + 1, Number(attr(cell, NS.table, 'number-columns-repeated') ?? 1));
      const type = attr(cell, NS.office, 'value-type');
      const value = type === 'float' || type === 'percentage' || type === 'currency' ? Number(attr(cell, NS.office, 'value')) : (cell.textContent || null);
      for (let i = 0; i < repeat && cells.length <= MAX_SERIES; i += 1) cells.push(value);
    }
    rows.push(cells);
  }
  return rows;
}

/** An embedded chart document read back: its kind, titles and the data of its local table. */
export function readOdfChartDocument(root) {
  const chart = kid(kid(kid(root, NS.office, 'body'), NS.office, 'chart'), CHART_NS, 'chart');
  if (!chart) return null;
  const plot = kid(chart, CHART_NS, 'plot-area');
  const styleOf = (name) => {
    const style = kids(kid(root, NS.office, 'automatic-styles'), NS.style, 'style').find((s) => attr(s, NS.style, 'name') === name);
    const props = {};
    for (const a of kid(style, NS.style, 'chart-properties')?.attributes ?? []) props[a.localName] = a.value;
    return props;
  };
  const plotProps = styleOf(attr(plot, CHART_NS, 'style-name'));
  const kind = (attr(chart, CHART_NS, 'class') ?? '').replace(/^chart:/, '');
  let type = { bar: plotProps.vertical === 'true' ? 'bar' : 'column', line: 'line', area: 'area', circle: 'pie', ring: 'doughnut', scatter: 'scatter' }[kind] ?? 'column';
  const rows = localTable(chart);
  const seriesTypes = kids(plot, CHART_NS, 'series').map((s) => (attr(s, CHART_NS, 'class') ?? '').replace(/^chart:/, ''));
  const [head = [], ...body] = rows;
  const series = head.slice(1).map((name, i) => ({ name: name === null ? `Series ${i + 1}` : String(name), values: body.map((row) => (typeof row[i + 1] === 'number' ? row[i + 1] : null)) }));
  if (seriesTypes.some((t) => t && t !== kind)) {
    type = 'combo';
    series.forEach((s, i) => { s.type = { bar: 'column', line: 'line', area: 'area' }[seriesTypes[i] || kind] ?? 'column'; });
  }
  const text = (element) => kids(element, NS.text, 'p').map((p) => p.textContent).join(' ');
  const axes = kids(plot, CHART_NS, 'axis');
  const legend = kid(chart, CHART_NS, 'legend');
  const out = {
    type, data: normaliseChartData({ categories: body.map((row) => (row[0] === null ? '' : String(row[0]))), series }),
    legend: legend ? LEGEND_FROM[attr(legend, CHART_NS, 'legend-position')] ?? 'right' : 'none',
  };
  if (plotProps.percentage === 'true') out.stacked = 'percent';
  else if (plotProps.stacked === 'true') out.stacked = 'stacked';
  const title = text(kid(chart, CHART_NS, 'title'));
  if (title) out.title = title;
  const xTitle = text(kid(axes.find((a) => attr(a, CHART_NS, 'dimension') === 'x'), CHART_NS, 'title'));
  if (xTitle) out.xTitle = xTitle;
  const yTitle = text(kid(axes.find((a) => attr(a, CHART_NS, 'dimension') === 'y'), CHART_NS, 'title'));
  if (yTitle) out.yTitle = yTitle;
  return out;
}

/** The size of a frame in pixels. */
export function frameSize(frame) {
  const px = (name) => Math.round(((parseLength(attr(frame, NS.svg, name) ?? '0') ?? 0) * 96) / 25.4);
  return { width: Math.max(80, Math.min(2000, px('width') || 400)), height: Math.max(60, Math.min(2000, px('height') || 260)) };
}

// Office Open XML

const point = (v, i) => tag('c:pt', { idx: String(i) }, tag('c:v', {}, String(v)));
const rich = (text) => tag('c:tx', {}, tag('c:rich', {}, tag('a:bodyPr', {}), tag('a:p', {}, tag('a:r', {}, tag('a:t', {}, text)))));
const titleXml = (text) => (text ? tag('c:title', {}, rich(text), tag('c:overlay', { val: '0' })) : null);

/** A chart part whose values are cached in it, pointing at the sheet of a workbook the program keeps beside the chart. */
export function ooxmlChartPart(chart) {
  const data = normaliseChartData(chart.data);
  const type = KINDS.includes(chart.type) ? chart.type : 'column';
  const n = data.categories.length;
  const col = (i) => columnName(i + 1);
  const grouping = chart.stacked === 'percent' ? 'percentStacked' : chart.stacked === 'stacked' ? 'stacked' : null;
  const strCache = (f, values) => tag('c:strRef', {}, tag('c:f', {}, f), tag('c:strCache', {}, tag('c:ptCount', { val: String(values.length) }), values.map((v, i) => point(v, i))));
  const numCache = (f, values) => tag('c:numRef', {}, tag('c:f', {}, f), tag('c:numCache', {}, tag('c:formatCode', {}, 'General'), tag('c:ptCount', { val: String(values.length) }),
    values.map((v, i) => (v === null ? null : point(v, i)))));
  const kindOf = (s, i) => (type === 'combo' ? s.type ?? (i === 0 ? 'column' : 'line') : type);
  const ser = (s, i, kind) => {
    const color = (s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]).slice(1).toUpperCase();
    const head = [tag('c:idx', { val: String(i) }), tag('c:order', { val: String(i) }), tag('c:tx', {}, strCache(`Sheet1!$${col(i)}$1`, [s.name]))];
    const fill = tag('c:spPr', {}, kind === 'line' ? tag('a:ln', { w: '28575' }, tag('a:solidFill', {}, tag('a:srgbClr', { val: color }))) : tag('a:solidFill', {}, tag('a:srgbClr', { val: color })));
    const categories = tag(kind === 'scatter' ? 'c:xVal' : 'c:cat', {}, kind === 'scatter'
      ? numCache(`Sheet1!$A$2:$A$${n + 1}`, data.categories.map(Number))
      : strCache(`Sheet1!$A$2:$A$${n + 1}`, data.categories));
    const values = tag(kind === 'scatter' ? 'c:yVal' : 'c:val', {}, numCache(`Sheet1!$${col(i)}$2:$${col(i)}$${n + 1}`, s.values));
    if (kind === 'pie' || kind === 'doughnut') {
      const points = data.categories.map((_, k) => tag('c:dPt', {}, tag('c:idx', { val: String(k) }), tag('c:bubble3D', { val: '0' }),
        tag('c:spPr', {}, tag('a:solidFill', {}, tag('a:srgbClr', { val: SERIES_COLORS[k % SERIES_COLORS.length].slice(1).toUpperCase() })))));
      return tag('c:ser', {}, head, points, categories, values);
    }
    if (kind === 'scatter') return tag('c:ser', {}, head, tag('c:spPr', {}, tag('a:ln', { w: '19050' }, tag('a:noFill', {}))), categories, values, tag('c:smooth', { val: '0' }));
    if (kind === 'line') return tag('c:ser', {}, head, fill, tag('c:marker', {}, tag('c:symbol', { val: 'circle' })), categories, values, tag('c:smooth', { val: '0' }));
    return tag('c:ser', {}, head, fill, kind === 'column' || kind === 'bar' ? tag('c:invertIfNegative', { val: '0' }) : null, categories, values);
  };
  const axes = [tag('c:axId', { val: '2001' }), tag('c:axId', { val: '2002' })];
  const groups = [...new Set(data.series.map(kindOf))].map((kind) => {
    const own = data.series.map((s, i) => [s, i]).filter(([s, i]) => kindOf(s, i) === kind).map(([s, i]) => ser(s, i, kind));
    if (kind === 'column' || kind === 'bar') return tag('c:barChart', {}, tag('c:barDir', { val: kind === 'bar' ? 'bar' : 'col' }), tag('c:grouping', { val: grouping ?? 'clustered' }), tag('c:varyColors', { val: '0' }), own, tag('c:gapWidth', { val: '100' }), grouping ? tag('c:overlap', { val: '100' }) : null, axes);
    if (kind === 'line') return tag('c:lineChart', {}, tag('c:grouping', { val: grouping ?? 'standard' }), tag('c:varyColors', { val: '0' }), own, tag('c:marker', { val: '1' }), axes);
    if (kind === 'area') return tag('c:areaChart', {}, tag('c:grouping', { val: grouping ?? 'standard' }), tag('c:varyColors', { val: '0' }), own, axes);
    if (kind === 'pie') return tag('c:pieChart', {}, tag('c:varyColors', { val: '1' }), own, tag('c:firstSliceAng', { val: '0' }));
    if (kind === 'doughnut') return tag('c:doughnutChart', {}, tag('c:varyColors', { val: '1' }), own, tag('c:firstSliceAng', { val: '0' }), tag('c:holeSize', { val: '50' }));
    return tag('c:scatterChart', {}, tag('c:scatterStyle', { val: 'lineMarker' }), tag('c:varyColors', { val: '0' }), own, axes);
  });
  const round = type === 'pie' || type === 'doughnut';
  const axis = (name, id, cross, position, title, grid = false) => tag(name, {}, tag('c:axId', { val: id }), tag('c:scaling', {}, tag('c:orientation', { val: 'minMax' })),
    tag('c:delete', { val: '0' }), tag('c:axPos', { val: position }), grid ? tag('c:majorGridlines', {}) : null, titleXml(title),
    tag('c:numFmt', { formatCode: 'General', sourceLinked: '1' }), tag('c:tickLblPos', { val: 'nextTo' }), tag('c:crossAx', { val: cross }), tag('c:crosses', { val: 'autoZero' }));
  const axisXml = round ? [] : type === 'scatter'
    ? [axis('c:valAx', '2001', '2002', 'b', chart.xTitle), axis('c:valAx', '2002', '2001', 'l', chart.yTitle, true)]
    : [axis('c:catAx', '2001', '2002', type === 'bar' ? 'l' : 'b', chart.xTitle), axis('c:valAx', '2002', '2001', type === 'bar' ? 'b' : 'l', chart.yTitle, true)];
  return xmlDocument(tag('c:chartSpace', { 'xmlns:c': C, 'xmlns:a': NS.a, 'xmlns:r': NS.r },
    tag('c:roundedCorners', { val: '0' }),
    tag('c:chart', {}, titleXml(chart.title), tag('c:autoTitleDeleted', { val: chart.title ? '0' : '1' }),
      tag('c:plotArea', {}, tag('c:layout', {}), groups, axisXml),
      (chart.legend ?? 'right') !== 'none' ? tag('c:legend', {}, tag('c:legendPos', { val: { right: 'r', left: 'l', top: 't', bottom: 'b' }[chart.legend ?? 'right'] ?? 'r' }), tag('c:overlay', { val: '0' })) : null,
      tag('c:plotVisOnly', { val: '1' }), tag('c:dispBlanksAs', { val: 'gap' }))));
}

/** A chart part read back from its cached values. */
export function readOoxmlChartPart(doc) {
  const chart = kid(doc?.documentElement, C, 'chart');
  const plot = kid(chart, C, 'plotArea');
  if (!plot) return null;
  const val = (element, name) => kid(element, C, name)?.getAttribute('val') ?? null;
  const cache = (element) => {
    const holder = element?.getElementsByTagNameNS(C, 'strCache')[0] ?? element?.getElementsByTagNameNS(C, 'numCache')[0]
      ?? element?.getElementsByTagNameNS(C, 'strLit')[0] ?? element?.getElementsByTagNameNS(C, 'numLit')[0];
    if (!holder) return [];
    const count = Math.min(MAX_POINTS, Number(val(holder, 'ptCount') ?? 0));
    const out = Array(count).fill(null);
    for (const pt of kids(holder, C, 'pt')) {
      const i = Number(pt.getAttribute('idx'));
      if (i >= 0 && i < count) out[i] = kid(pt, C, 'v')?.textContent ?? null;
    }
    return out;
  };
  const PLOTS = { barChart: 'column', bar3DChart: 'column', lineChart: 'line', line3DChart: 'line', areaChart: 'area', pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter' };
  const series = [];
  let categories = null;
  const kinds = new Set();
  let stacked = false;
  for (const group of kids(plot).filter((e) => e.namespaceURI === C && /Chart$/.test(e.localName))) {
    let kind = PLOTS[group.localName] ?? 'column';
    if (val(group, 'barDir') === 'bar') kind = 'bar';
    const grouping = val(group, 'grouping');
    if (grouping === 'stacked') stacked = 'stacked';
    if (grouping === 'percentStacked') stacked = 'percent';
    kinds.add(kind);
    for (const s of kids(group, C, 'ser').slice(0, MAX_SERIES)) {
      categories ??= cache(kid(s, C, kind === 'scatter' ? 'xVal' : 'cat'));
      const values = cache(kid(s, C, kind === 'scatter' ? 'yVal' : 'val')).map((v) => (v === null || v === '' ? null : Number(v)));
      const fill = kid(kid(kid(s, C, 'spPr'), NS.a, 'solidFill'), NS.a, 'srgbClr')?.getAttribute('val');
      series.push({ name: cache(kid(s, C, 'tx'))[0] ?? kid(kid(s, C, 'tx'), C, 'v')?.textContent ?? `Series ${series.length + 1}`, values, kind, ...(fill && /^[0-9a-f]{6}$/i.test(fill) ? { color: `#${fill.toLowerCase()}` } : {}) });
    }
  }
  if (series.length === 0) return null;
  const type = kinds.size > 1 ? 'combo' : [...kinds][0];
  for (const s of series) {
    if (type === 'combo') s.type = s.kind === 'bar' ? 'column' : s.kind;
    delete s.kind;
  }
  const text = (element) => [...(element?.getElementsByTagNameNS(NS.a, 't') ?? [])].map((t) => t.textContent).join('');
  const legend = kid(chart, C, 'legend');
  const out = { type, data: normaliseChartData({ categories: categories ?? [], series }), legend: legend ? { r: 'right', l: 'left', t: 'top', b: 'bottom', tr: 'right' }[val(legend, 'legendPos') ?? 'r'] ?? 'right' : 'none' };
  if (stacked) out.stacked = stacked;
  const title = text(kid(chart, C, 'title'));
  if (title) out.title = title;
  const catAx = kid(plot, C, 'catAx') ?? kids(plot, C, 'valAx')[type === 'scatter' ? 0 : -1];
  const valAx = type === 'scatter' ? kids(plot, C, 'valAx')[1] : kid(plot, C, 'valAx');
  const xTitle = text(kid(catAx, C, 'title'));
  if (xTitle) out.xTitle = xTitle;
  const yTitle = text(kid(valAx, C, 'title'));
  if (yTitle) out.yTitle = yTitle;
  return out;
}
