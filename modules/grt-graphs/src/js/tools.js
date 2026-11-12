/** Graphs' tools beyond drawing: nodes that show a value from Grid or Tables, a diagram from a table, the plan of a project, and the nodes' data as a table. */

import { pickValue, cellValue, shownValue, AGGREGATES, SOURCE_FILTERS, readSource } from './core/sources.js';
import { criticalPath, ganttSvg, deadlinesIcs } from './planning.js';

export { SOURCE_FILTERS, readSource };

/** The value a live node shows, read again from its source. */
export function liveValue(source, live) {
  if (live.cell) return cellValue(source.tables, live.cell);
  const table = source.tables.find((t) => t.name === live.table) ?? source.tables[0];
  return table ? pickValue(table, live) : null;
}

/** A node's text with its value put where the template says. */
export const liveText = (live, value) => String(live.template || '{value}').split('{value}').join(shownValue(value));

const option = (value, label, chosen) => `<option value="${escape(value)}"${String(value) === String(chosen ?? '') ? ' selected' : ''}>${escape(label)}</option>`;
const escape = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The panel that sets what a node shows: a cell, or one value out of a table.
 * @returns {string} the panel's HTML
 */
export function liveForm(source, live = {}) {
  const tables = source.tables;
  const first = tables.find((t) => t.name === live.table) ?? tables[0];
  const columns = first?.columns ?? [];
  return `
    <p class="fp-note" style="margin-top:0">The node shows this value, and reads it again only when you ask, with Refresh values.</p>
    ${source.kind === 'sheet' ? `<label>Cell<input data-field="cell" value="${escape(live.cell ?? '')}" placeholder="B3 or Sheet1.B3, or leave empty to pick from a column"></label>` : ''}
    <label>${source.kind === 'sheet' ? 'Sheet' : 'Table'}<select data-field="table">${tables.map((t) => option(t.name, t.name, live.table ?? first?.name)).join('')}</select></label>
    <label>Column<select data-field="column">${columns.map((c) => option(c, c, live.column)).join('')}</select></label>
    <label>Value<select data-field="aggregate">${Object.entries(AGGREGATES).map(([k, l]) => option(k, l, live.aggregate ?? 'value')).join('')}</select></label>
    <label>Only rows where<select data-field="where">${option('', '(every row)', live.where)}${columns.map((c) => option(c, c, live.where)).join('')}</select></label>
    <label>is<input data-field="equals" value="${escape(live.equals ?? '')}"></label>
    <label>Text<input data-field="template" value="${escape(live.template ?? '{value}')}" placeholder="Sales: {value}"></label>`;
}

/**
 * A diagram from a table whose rows name themselves and their parent, such as an organisation chart.
 * @returns {{nodes: {key: string, text: string, data: object}[], links: [string, string][]}}
 */
export function treeFromTable(table, { id, parent, label }) {
  const at = (name) => table.columns.indexOf(name);
  const [i, p, l] = [at(id), at(parent), at(label || id)];
  if (i === -1 || p === -1) return { nodes: [], links: [] };
  const rows = table.rows.slice(0, 2000).filter((row) => row[i] !== null && row[i] !== '');
  const keys = new Set(rows.map((row) => String(row[i])));
  const nodes = rows.map((row) => ({
    key: String(row[i]),
    text: String(row[l === -1 ? i : l] ?? row[i]),
    data: Object.fromEntries(table.columns.map((c, k) => [c, row[k] === null || row[k] === undefined ? '' : String(row[k])])),
  }));
  const links = rows.filter((row) => row[p] !== null && keys.has(String(row[p])) && String(row[p]) !== String(row[i])).map((row) => [String(row[p]), String(row[i])]);
  return { nodes, links };
}

/** The plan of a project as a panel: the Gantt chart and each task's dates and slack. */
export function planPanel(model) {
  const start = model.meta.start ?? null;
  const plan = criticalPath(model, { start });
  if (plan.cycle) return { plan, html: `<p>These tasks wait for each other in a circle, so no plan exists: ${escape(plan.cycle.join(', '))}.</p>` };
  if (!plan.tasks.length) return { plan, html: '<p>No node has a duration yet. Give nodes a <b>duration</b> in days in the data table, and join them with arrows from what comes first.</p>' };
  const rows = plan.tasks.map((t) => `<tr${t.critical ? ' class="critical"' : ''}><td>${escape(t.name)}</td><td>${t.duration}</td><td>${t.startDate ?? `day ${t.es}`}</td><td>${t.endDate ?? `day ${t.ef}`}</td><td>${t.slack}</td></tr>`).join('');
  return {
    plan,
    html: `
      <label>Project starts<input type="date" data-field="start" value="${escape(start ?? '')}"></label>
      <p class="fp-note">${plan.finish} day(s) in all. The critical path, in red, is the chain that cannot slip without the end slipping too.</p>
      <div class="gantt">${ganttSvg(plan, { start, width: 520 })}</div>
      <table class="data-table"><tr><th>Task</th><th>Days</th><th>Starts</th><th>Ends</th><th>Slack</th></tr>${rows}</table>`,
  };
}

export { deadlinesIcs, criticalPath };

/** The nodes' data as an editable grid: a row a node, a column a field, and an empty column for a new field. */
export function dataTableHtml(model) {
  const keys = [...new Set(model.nodes.flatMap((n) => Object.keys(n.data ?? {})))].slice(0, 40);
  const head = `<tr><th>Node</th>${keys.map((k, c) => `<th><input data-field="key_${c}" value="${escape(k)}"></th>`).join('')}<th><input data-field="key_new" placeholder="New field"></th></tr>`;
  const body = model.nodes.slice(0, 500).map((n, r) => `<tr><td>${escape(n.text || n.id)}</td>${keys.map((k, c) => `<td><input data-field="cell_${r}_${c}" value="${escape(n.data?.[k] ?? '')}"></td>`).join('')}<td><input data-field="cell_${r}_new"></td></tr>`).join('');
  return { keys, html: `<div class="data-grid"><table class="data-table">${head}${body}</table></div>` };
}

/** The nodes' data as the grid left it: fields renamed, emptied fields removed, a new field added. */
export function dataFromTable(model, keys, fields) {
  const names = keys.map((k, c) => String(fields[`key_${c}`] ?? k).trim());
  const added = String(fields.key_new ?? '').trim();
  return model.nodes.slice(0, 500).map((n, r) => {
    const data = {};
    keys.forEach((_, c) => {
      const value = String(fields[`cell_${r}_${c}`] ?? '');
      if (names[c] && value !== '') data[names[c]] = value;
    });
    const fresh = String(fields[`cell_${r}_new`] ?? '');
    if (added && fresh !== '') data[added] = fresh;
    return [n.id, data];
  });
}
