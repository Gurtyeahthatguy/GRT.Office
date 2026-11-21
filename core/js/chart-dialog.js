/** The chart dialog every program shares: kind, titles, data typed as lines, the chart drawn as it changes. */

import { chartSvg } from './charts.js';
import { ownChartSpec, dataFromText, dataToText, normaliseChartData } from './formats/chart-object.js';
import { showPanel, readFields, escapeHtml } from './panel.js';

const option = (value, label, chosen) => `<option value="${escapeHtml(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`;
const KINDS = [['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Points (XY)'], ['combo', 'Columns and lines']];

/** A chart, new or to change; null when cancelled. */
export async function chartDialog(existing = null) {
  const chart = existing ?? { type: 'column', legend: 'right', data: normaliseChartData({ categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Sales', values: [12, 18, 15, 22] }] }) };
  const answer = showPanel(existing ? 'Chart' : 'Insert chart', `
    <div class="chart-preview" id="chart-preview"></div>
    <label>Kind<select data-field="type">${KINDS.map(([v, l]) => option(v, l, chart.type)).join('')}</select></label>
    <label>Title<input data-field="title" value="${escapeHtml(chart.title ?? '')}"></label>
    <label>Legend<select data-field="legend">${[['right', 'Right'], ['bottom', 'Below'], ['top', 'Above'], ['none', 'None']].map(([v, l]) => option(v, l, chart.legend ?? 'right')).join('')}</select></label>
    <label>Data: series names on the first line, a line per category<textarea data-field="data" rows="6" spellcheck="false">${escapeHtml(dataToText(chart.data))}</textarea></label>`, existing ? 'Apply' : 'Insert');
  const body = document.getElementById('panel-body');
  const read = () => {
    const f = readFields();
    return { type: f.type, title: f.title, legend: f.legend, data: dataFromText(f.data) };
  };
  const preview = () => {
    const node = document.getElementById('chart-preview');
    if (node) node.innerHTML = chartSvg(ownChartSpec(read()), { width: 440, height: 220, background: '#ffffff', text: '#222222' });
  };
  body.addEventListener('input', preview);
  preview();
  const confirmed = await answer;
  body.removeEventListener('input', preview);
  return confirmed ? read() : null;
}

