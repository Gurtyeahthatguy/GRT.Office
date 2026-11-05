/** Forms: one record at a time, each field as its type asks, a list for every foreign key; and reports: groups, totals and a chart, on paper. */

import { quoteIdent } from './schema.js';
import { escapeHtml } from './core/panel.js';
import { chartSvg } from './core/charts.js';

/** The tables Tables keeps for itself in a database, out of the person's way. */
export const isOwnTable = (name) => /^_grt_/.test(String(name));

/** The input a column gets in a form, by its declared type. */
export function inputFor(column, value, { choices = null } = {}) {
  const type = String(column.type ?? '').toUpperCase();
  const name = escapeHtml(column.name);
  const text = value === null || value === undefined ? '' : String(value);
  if (choices) {
    return `<select data-field="${name}">${['', ...choices.keys()].map((key) => `<option value="${escapeHtml(key)}"${String(key) === text ? ' selected' : ''}>${escapeHtml(key === '' ? '(none)' : `${choices.get(key)}`)}</option>`).join('')}</select>`;
  }
  if (/BOOL/.test(type)) return `<input type="checkbox" data-field="${name}"${value && value !== '0' ? ' checked' : ''}>`;
  if (/INT/.test(type)) return `<input type="number" step="1" data-field="${name}" value="${escapeHtml(text)}">`;
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(type)) return `<input type="number" step="any" data-field="${name}" value="${escapeHtml(text)}">`;
  if (/DATE/.test(type)) return `<input type="date" data-field="${name}" value="${escapeHtml(text.slice(0, 10))}">`;
  if (/TIME/.test(type)) return `<input type="time" data-field="${name}" value="${escapeHtml(text.slice(0, 5))}">`;
  if (/BLOB/.test(type)) return `<span class="dim">${text ? 'A file' : 'No file'}</span>`;
  return text.length > 60 || text.includes('\n')
    ? `<textarea data-field="${name}" rows="3">${escapeHtml(text)}</textarea>`
    : `<input data-field="${name}" value="${escapeHtml(text)}">`;
}

/** What a form's fields hold, as values for the database: numbers as numbers, an empty field as nothing. */
export function valuesFrom(columns, fields) {
  const out = {};
  for (const column of columns) {
    if (!(column.name in fields)) continue;
    const type = String(column.type ?? '').toUpperCase();
    const raw = fields[column.name];
    if (/BOOL/.test(type)) out[column.name] = raw ? 1 : 0;
    else if (raw === '' || raw === undefined) out[column.name] = null;
    else if (/INT/.test(type) && /^-?\d+$/.test(String(raw))) out[column.name] = Number(raw);
    else if (/REAL|FLOA|DOUB|NUM|DEC/.test(type) && Number.isFinite(Number(raw))) out[column.name] = Number(raw);
    else out[column.name] = raw;
  }
  return out;
}

/** The SQL for one record of a table, by its place, with its rowid first. */
export const recordSql = (table, filter = null) => `SELECT rowid AS "__rowid", * FROM ${quoteIdent(table)}${filter ? ` WHERE ${filter}` : ''} ORDER BY rowid LIMIT 1 OFFSET ?`;
export const countSql = (table, filter = null) => `SELECT COUNT(*) FROM ${quoteIdent(table)}${filter ? ` WHERE ${filter}` : ''}`;

/** A search across a table's text columns, as a WHERE clause with its parameters. */
export function searchFilter(columns, text) {
  const words = String(text ?? '').trim();
  if (!words) return { where: null, params: [] };
  const usable = columns.filter((c) => !/BLOB/i.test(c.type ?? ''));
  return { where: `(${usable.map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')})`, params: usable.map(() => `%${words.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) };
}

// Reports

export const TOTALS = { sum: 'Sum', avg: 'Average', count: 'Count', min: 'Minimum', max: 'Maximum' };

function total(fn, values) {
  const numbers = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  switch (fn) {
    case 'count': return values.filter((v) => v !== null && v !== undefined && v !== '').length;
    case 'sum': return numbers.reduce((a, b) => a + b, 0);
    case 'avg': return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    case 'min': return numbers.length ? Math.min(...numbers) : null;
    case 'max': return numbers.length ? Math.max(...numbers) : null;
    default: return null;
  }
}

/**
 * A report worked out: rows grouped by a column, each group with its totals, and the grand totals.
 * @param {{title?: string, columns?: string[], groupBy?: string, sortBy?: string, descending?: boolean, totals?: Object<string, string>, chart?: boolean}} definition
 */
export function buildReport(definition, columns, rows, { labels = new Map() } = {}) {
  // A foreign key shows the row it points at by name, as the form does.
  const named = (column, value) => (value === null || value === undefined ? value : labels.get(column)?.get(String(value)) ?? value);
  if (labels.size) rows = rows.map((row) => row.map((value, i) => named(columns[i], value)));
  const index = new Map(columns.map((c, i) => [c, i]));
  const shown = (definition.columns?.length ? definition.columns : columns).filter((c) => index.has(c) && c !== definition.groupBy);
  const sortIndex = index.get(definition.sortBy);
  const sorted = sortIndex === undefined ? rows : [...rows].sort((a, b) => {
    const x = a[sortIndex];
    const y = b[sortIndex];
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
    return definition.descending ? -order : order;
  });
  const totalsOf = (list) => Object.fromEntries(Object.entries(definition.totals ?? {}).filter(([c]) => index.has(c))
    .map(([c, fn]) => [c, total(fn, list.map((row) => row[index.get(c)]))]));
  const groupIndex = index.get(definition.groupBy);
  const groups = [];
  if (groupIndex === undefined) groups.push({ key: null, rows: sorted, totals: totalsOf(sorted) });
  else {
    const map = new Map();
    for (const row of sorted) {
      const key = row[groupIndex] ?? '';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    const keys = [...map.keys()].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true })));
    for (const key of keys) groups.push({ key, rows: map.get(key), totals: totalsOf(map.get(key)) });
  }
  return {
    title: definition.title || 'Report', groupBy: groupIndex === undefined ? null : definition.groupBy,
    columns: shown, at: shown.map((c) => index.get(c)), groups, totals: totalsOf(sorted), count: sorted.length,
  };
}

const cell = (value) => (value === null || value === undefined ? '' : typeof value === 'number' && !Number.isInteger(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(value));

/** A report as HTML for the screen and for paper, with a chart of the first total by group when asked. */
export function reportHtml(report, definition) {
  const totalColumns = Object.keys(definition.totals ?? {}).filter((c) => report.columns.includes(c));
  const totalsRow = (totals, label) => `<tr class="report-total"><td>${escapeHtml(label)}</td>${report.columns.slice(1).map((c) => `<td>${totals[c] !== undefined ? `<span class="dim">${TOTALS[definition.totals[c]]}</span> ${escapeHtml(cell(totals[c]))}` : ''}</td>`).join('')}</tr>`;
  const head = `<tr>${report.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const groups = report.groups.map((group) => `
    ${group.key !== null ? `<h3 class="report-group">${escapeHtml(report.groupBy)}: ${escapeHtml(cell(group.key))}</h3>` : ''}
    <table class="report-table"><thead>${head}</thead><tbody>
      ${group.rows.map((row) => `<tr>${report.at.map((i) => `<td>${escapeHtml(cell(row[i]))}</td>`).join('')}</tr>`).join('')}
      ${totalColumns.length && report.groupBy ? totalsRow(group.totals, `${group.rows.length} row(s)`) : ''}
    </tbody></table>`).join('');
  let chart = '';
  if (definition.chart && report.groupBy && totalColumns.length) {
    const column = totalColumns[0];
    chart = `<div class="report-chart">${chartSvg({
      type: 'column', title: `${TOTALS[definition.totals[column]]} of ${column} by ${report.groupBy}`, legend: 'none',
      categories: report.groups.map((g) => cell(g.key)), series: [{ name: column, values: report.groups.map((g) => g.totals[column]) }],
    }, { width: 640, height: 280, background: '#ffffff', text: '#222222' })}</div>`;
  }
  const grand = totalColumns.length ? `<table class="report-table report-grand"><tbody>${totalsRow(report.totals, `All ${report.count} row(s)`)}</tbody></table>` : '';
  return `<div class="report"><h2>${escapeHtml(report.title)}</h2>${chart}${groups}${grand}</div>`;
}
