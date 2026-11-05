/** The dialogs of the Data, Format and Sheet commands: each asks, then hands the answer to the controller. */

import { showPanel, showChoice, readFields, escapeHtml } from './core/panel.js';
import { columnName, a1 } from './references.js';
import { shownText } from './data.js';
import { formatValue } from './format.js';
import { applyLook } from './grid.js';
import { chartSvg } from './core/charts.js';
import { chartSpec, chartFromArea, rangeText } from './charts.js';
import { FUNCTIONS, readSource, computePivot, groupItem } from './pivot.js';

const option = (value, label, chosen) => `<option value="${escapeHtml(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`;

/** The columns of a block, named by their header when it has one. */
function columnChoices(sheet, area, header, chosen) {
  const out = [];
  for (let c = area.left; c <= area.right; c += 1) {
    const name = header ? String(sheet.sheet.valueAt(area.top, c) ?? '') : '';
    out.push(option(String(c), name ? `${name} (${columnName(c)})` : `Column ${columnName(c)}`, String(chosen)));
  }
  return out.join('');
}

const areaLabel = (area) => (area.top === area.bottom && area.left === area.right ? a1(area.top, area.left) : `${a1(area.top, area.left)}:${a1(area.bottom, area.right)}`);

// Sorting and filtering

export async function sortDialog(sheet) {
  const area = sheet.dataArea();
  const header = sheet.hasHeader(area);
  const key = (n, chosen) => `
    <div class="row">
      <label>${n === 1 ? 'Sort by' : 'Then by'}<select data-field="key${n}">
        ${n > 1 ? option('', '(none)', '') : ''}${columnChoices(sheet, area, header, chosen)}
      </select></label>
      <label>Order<select data-field="order${n}">${option('1', 'Ascending')}${option('-1', 'Descending')}</select></label>
    </div>`;
  const confirmed = await showPanel(`Sort ${areaLabel(area)}`, `
    ${key(1, sheet.active.col)}${key(2, '')}${key(3, '')}
    <label class="inline"><input type="checkbox" data-field="header"${header ? ' checked' : ''}> The first row holds column names</label>
    <label class="inline"><input type="checkbox" data-field="caseSensitive"> Upper and lower case apart</label>`, 'Sort');
  if (!confirmed) return;
  const fields = readFields();
  const keys = [1, 2, 3].filter((n) => fields[`key${n}`] !== '' && fields[`key${n}`] !== undefined)
    .map((n) => ({ index: Number(fields[`key${n}`]) - area.left, order: Number(fields[`order${n}`]) }));
  sheet.sort({ area, keys, header: fields.header, caseSensitive: fields.caseSensitive });
}

const OPERATORS = [
  ['=', 'equals'], ['<>', 'is not'], ['>', 'greater than'], ['>=', 'at least'], ['<', 'less than'], ['<=', 'at most'],
  ['contains', 'contains'], ['not-contains', 'does not contain'], ['begins', 'begins with'], ['ends', 'ends with'],
  ['empty', 'is empty'], ['not-empty', 'is not empty'],
];

/** Turns the autofilter on over the data around the cell, or off. */
export function toggleAutoFilter(sheet) {
  if (sheet.sheet.filter) sheet.setFilter(null);
  else sheet.setFilter(sheet.dataArea());
}

export async function standardFilterDialog(sheet) {
  if (!sheet.sheet.filter) sheet.setFilter(sheet.dataArea());
  const { area } = sheet.sheet.filter;
  const row = (n) => `
    <div class="row">
      <label>Column<select data-field="col${n}">${n > 1 ? option('', '(none)', '') : ''}${columnChoices(sheet, area, true, n === 1 ? sheet.active.col : '')}</select></label>
      <label>Condition<select data-field="op${n}">${OPERATORS.map(([v, l]) => option(v, l)).join('')}</select></label>
      <label>Value<input data-field="value${n}"></label>
    </div>`;
  const confirmed = await showPanel('Standard filter', `
    ${row(1)}${row(2)}${row(3)}
    <label>Join the conditions with<select data-field="join">${option('and', 'and')}${option('or', 'or')}</select></label>`, 'Filter');
  if (!confirmed) return;
  const fields = readFields();
  const byColumn = new Map();
  for (const n of [1, 2, 3]) {
    if (fields[`col${n}`] === '' || fields[`col${n}`] === undefined) continue;
    const col = Number(fields[`col${n}`]);
    byColumn.set(col, [...(byColumn.get(col) ?? []), { op: fields[`op${n}`], value: fields[`value${n}`] }]);
  }
  for (const [col, conditions] of byColumn) sheet.setFilterColumn(col, { conditions, ...(fields.join === 'or' ? { join: 'or' } : {}) });
}

/** The list a filter button opens: every value of the column, ticked when it shows. */
export async function filterValuesDialog(sheet, col) {
  const filter = sheet.sheet.filter;
  if (!filter) return;
  const values = new Set();
  for (let r = filter.area.top + 1; r <= filter.area.bottom && values.size < 1000; r += 1) values.add(shownText(sheet.sheet, r, col, sheet.model.styles));
  const sorted = [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const current = filter.columns[String(col - filter.area.left)];
  const allowed = new Set(current?.values ?? sorted);
  const header = String(sheet.sheet.valueAt(filter.area.top, col) ?? columnName(col));
  const choice = await showChoice(`Filter ${header}`, `
    <div class="filter-values">
      ${sorted.map((v, i) => `<label class="inline"><input type="checkbox" data-field="v${i}"${allowed.has(v) ? ' checked' : ''}> ${escapeHtml(v || '(empty)')}</label>`).join('')}
    </div>`, [
    { id: 'sort-up', label: 'A to Z' }, { id: 'sort-down', label: 'Z to A' }, { id: 'top', label: 'Top 10' },
    { id: 'clear', label: 'Show all' }, { id: 'cancel', label: 'Cancel' }, { id: 'apply', label: 'Filter', primary: true },
  ]);
  const fields = readFields();
  const area = filter.area;
  if (choice === 'sort-up' || choice === 'sort-down') sheet.sort({ area, keys: [{ index: col - area.left, order: choice === 'sort-up' ? 1 : -1 }], header: true });
  else if (choice === 'top') sheet.setFilterColumn(col, { top: { count: 10 } });
  else if (choice === 'clear') sheet.setFilterColumn(col, null);
  else if (choice === 'apply') {
    const kept = sorted.filter((_, i) => fields[`v${i}`]);
    sheet.setFilterColumn(col, kept.length === sorted.length ? null : { values: kept });
  }
}

// Conditional formatting and validity

const LOOKS = {
  red: { label: 'Light red fill, dark red text', style: { bg: '#ffc7ce', color: '#9c0006' } },
  yellow: { label: 'Yellow fill, dark yellow text', style: { bg: '#ffeb9c', color: '#9c5700' } },
  green: { label: 'Green fill, dark green text', style: { bg: '#c6efce', color: '#006100' } },
  bold: { label: 'Bold', style: { bold: true } },
  red_text: { label: 'Red text', style: { color: '#c00000' } },
};

const RULE_KINDS = [
  ['cell', 'Cell value is'], ['formula', 'Formula is true'], ['text', 'Text contains'], ['duplicate', 'Duplicate values'],
  ['unique', 'Unique values'], ['top', 'Top values'], ['bottom', 'Bottom values'], ['above', 'Above the average'],
  ['below', 'Below the average'], ['error', 'Errors'], ['blank', 'Empty cells'], ['scale2', 'Colour scale, two colours'],
  ['scale3', 'Colour scale, three colours'], ['bar', 'Data bar'],
];

export async function conditionalDialog(sheet) {
  const area = sheet.selection;
  const existing = sheet.sheet.conditions.filter((rule) => !(rule.area.bottom < area.top || rule.area.top > area.bottom || rule.area.right < area.left || rule.area.left > area.right));
  const choice = await showChoice(`Conditional formatting for ${areaLabel(area)}`, `
    <label>Format cells when<select data-field="kind">${RULE_KINDS.map(([v, l]) => option(v, l)).join('')}</select></label>
    <div class="row">
      <label>Comparison<select data-field="op">${[['>', 'greater than'], ['>=', 'at least'], ['<', 'less than'], ['<=', 'at most'], ['=', 'equal to'], ['<>', 'not equal to'], ['between', 'between'], ['not-between', 'not between']].map(([v, l]) => option(v, l)).join('')}</select></label>
      <label>Value, formula or text<input data-field="value1" placeholder="10, =$B$1 or =A1>B1"></label>
      <label>And<input data-field="value2" placeholder="for between"></label>
    </div>
    <label>Look<select data-field="look">${Object.entries(LOOKS).map(([k, v]) => option(k, v.label)).join('')}${option('custom', 'Choose the colours')}</select></label>
    <div class="row">
      <label>Fill<input type="color" data-field="bg" value="#ffc7ce"></label>
      <label>Text<input type="color" data-field="color" value="#9c0006"></label>
      <label>Bar or low colour<input type="color" data-field="low" value="#f8696b"></label>
      <label>Middle<input type="color" data-field="middle" value="#ffeb84"></label>
      <label>High colour<input type="color" data-field="high" value="#63be7b"></label>
    </div>
    ${existing.length ? `<p class="hint">${existing.length} rule(s) already touch these cells; they are tried first.</p>` : ''}`, [
    ...(existing.length ? [{ id: 'clear', label: 'Remove their rules' }] : []),
    { id: 'cancel', label: 'Cancel' }, { id: 'add', label: 'Add rule', primary: true },
  ]);
  if (choice === 'clear') { sheet.clearConditions(area); return; }
  if (choice !== 'add') return;
  const f = readFields();
  const style = f.look === 'custom' ? { bg: f.bg, color: f.color } : LOOKS[f.look].style;
  const box = { top: area.top, left: area.left, bottom: area.bottom, right: area.right };
  const number = (text, fallback) => (Number.isFinite(Number(text)) && String(text).trim() !== '' ? Number(text) : fallback);
  const asFormula = (text) => (String(text).startsWith('=') ? text : Number.isFinite(Number(text)) && text !== '' ? `=${text}` : `="${String(text).replace(/"/g, '""')}"`);
  const rule = {
    cell: { type: 'cell', op: f.op, values: [f.value1, f.value2].filter((v, i) => i === 0 || f.op.includes('between')).map(asFormula), style },
    formula: { type: 'formula', formula: f.value1.startsWith('=') ? f.value1 : `=${f.value1}`, style },
    text: { type: 'text', op: 'contains', value: f.value1, style },
    duplicate: { type: 'duplicate', style },
    unique: { type: 'unique', style },
    top: { type: 'top', count: number(f.value1, 10), style },
    bottom: { type: 'top', count: number(f.value1, 10), bottom: true, style },
    above: { type: 'average', style },
    below: { type: 'average', below: true, style },
    error: { type: 'error', style },
    blank: { type: 'blank', style },
    scale2: { type: 'scale', points: [{ type: 'min' }, { type: 'max' }], colors: [f.low, f.high] },
    scale3: { type: 'scale', points: [{ type: 'min' }, { type: 'percentile', value: '50' }, { type: 'max' }], colors: [f.low, f.middle, f.high] },
    bar: { type: 'bar', color: f.low },
  }[f.kind];
  sheet.addCondition({ ...rule, area: box });
}

const ALLOW = [['any', 'Any value'], ['whole', 'Whole numbers'], ['decimal', 'Numbers'], ['list', 'A list of choices'], ['date', 'Dates'], ['time', 'Times'], ['length', 'Text of a length'], ['custom', 'A formula that is true']];

export async function validityDialog(sheet) {
  const area = sheet.selection;
  const current = sheet.validationAt(area.top, area.left) ?? {};
  const choice = await showChoice(`What ${areaLabel(area)} accepts`, `
    <label>Allow<select data-field="type">${ALLOW.map(([v, l]) => option(v, l, current.type ?? 'any')).join('')}</select></label>
    <div class="row">
      <label>Data<select data-field="op">${[['between', 'between'], ['not-between', 'not between'], ['=', 'equal to'], ['<>', 'not equal to'], ['>', 'greater than'], ['>=', 'at least'], ['<', 'less than'], ['<=', 'at most']].map(([v, l]) => option(v, l, current.op ?? 'between')).join('')}</select></label>
      <label>Minimum, value or formula<input data-field="v1" value="${escapeHtml(String(current.values?.[0] ?? current.formula ?? '').replace(/^=/, ''))}"></label>
      <label>Maximum<input data-field="v2" value="${escapeHtml(String(current.values?.[1] ?? '').replace(/^=/, ''))}"></label>
    </div>
    <label>Choices, one per line, or a range such as $D$1:$D$9<textarea data-field="list" rows="3">${escapeHtml(current.list ? current.list.join('\n') : (current.source ?? '').replace(/^=/, ''))}</textarea></label>
    <label class="inline"><input type="checkbox" data-field="allowBlank"${current.allowBlank === false ? '' : ' checked'}> Empty cells are fine</label>
    <label class="inline"><input type="checkbox" data-field="dropdown"${current.dropdown === false ? '' : ' checked'}> Offer the choices in a list</label>
    <label>Help shown on the cell<input data-field="input" value="${escapeHtml(current.input?.message ?? '')}"></label>
    <div class="row">
      <label>When refused<select data-field="errorStyle">${[['stop', 'Refuse'], ['warning', 'Warn and ask'], ['info', 'Only say so']].map(([v, l]) => option(v, l, current.error?.style ?? 'stop')).join('')}</select></label>
      <label>Message<input data-field="errorMessage" value="${escapeHtml(current.error?.message ?? '')}"></label>
    </div>`, [
    ...(current.type ? [{ id: 'clear', label: 'Remove the rule' }] : []),
    { id: 'cancel', label: 'Cancel' }, { id: 'apply', label: 'Apply', primary: true },
  ]);
  if (choice === 'clear') { sheet.setValidation(null, area); return; }
  if (choice !== 'apply') return;
  const f = readFields();
  if (f.type === 'any') { sheet.setValidation(null, area); return; }
  const formula = (text) => (String(text).startsWith('=') ? text : `=${text}`);
  const rule = { type: f.type, allowBlank: f.allowBlank, error: { style: f.errorStyle, title: '', message: f.errorMessage } };
  if (f.input) rule.input = { title: '', message: f.input };
  if (f.type === 'list') {
    const text = f.list.trim();
    if (/^\$?[A-Za-z]+\$?\d+(:\$?[A-Za-z]+\$?\d+)?$/.test(text) || /!/.test(text)) rule.source = formula(text);
    else rule.list = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!f.dropdown) rule.dropdown = false;
  } else if (f.type === 'custom') rule.formula = formula(f.v1);
  else {
    rule.op = f.op;
    rule.values = (f.op.includes('between') ? [f.v1, f.v2] : [f.v1]).map(formula);
  }
  sheet.setValidation(rule, area);
}

// Names, series, text, subtotals, cells

export async function namesDialog(sheet) {
  const names = Object.entries(sheet.model.names).sort();
  const { top, left, bottom, right } = sheet.selection;
  const sheetName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet.sheet.name) ? sheet.sheet.name : `'${sheet.sheet.name.replace(/'/g, "''")}'`;
  const here = `=${sheetName}!$${columnName(left)}$${top + 1}${bottom > top || right > left ? `:$${columnName(right)}$${bottom + 1}` : ''}`;
  const choice = await showChoice('Names', `
    ${names.length ? `<table class="design-table"><tr><th></th><th>Name</th><th>Stands for</th></tr>
      ${names.map(([name, text], i) => `<tr><td><input type="checkbox" data-field="n${i}"></td><td>${escapeHtml(name)}</td><td><code>${escapeHtml(text)}</code></td></tr>`).join('')}
    </table>` : '<p class="hint">No names yet.</p>'}
    <div class="row">
      <label>New name<input data-field="name" placeholder="Prices"></label>
      <label>Stands for<input data-field="text" value="${escapeHtml(here)}"></label>
    </div>`, [
    ...(names.length ? [{ id: 'delete', label: 'Delete the ticked' }] : []),
    { id: 'labels', label: 'From the labels…' }, { id: 'cancel', label: 'Close' }, { id: 'add', label: 'Define', primary: true },
  ]);
  const f = readFields();
  if (choice === 'delete') sheet.record(() => names.forEach(([name], i) => { if (f[`n${i}`]) sheet.engine.setName(name, ''); }));
  if (choice === 'add' && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(f.name ?? '')) sheet.record(() => sheet.engine.setName(f.name, f.text));
  if (choice === 'labels') await namesFromLabelsDialog(sheet);
}

export async function namesFromLabelsDialog(sheet) {
  const from = await showChoice('Names from labels', '<p>Take the names from the selection\'s</p>', [
    { id: 'cancel', label: 'Cancel' }, { id: 'left', label: 'Left column' }, { id: 'top', label: 'Top row', primary: true },
  ]);
  if (from === 'top' || from === 'left') sheet.namesFromLabels({ top: from === 'top' });
}

export async function seriesDialog(sheet) {
  const confirmed = await showPanel('Fill series', `
    <div class="row">
      <label>Direction<select data-field="direction">${option('down', 'Down')}${option('right', 'Right')}</select></label>
      <label>Type<select data-field="type">${option('linear', 'Linear')}${option('growth', 'Growth')}${option('date', 'Date')}</select></label>
      <label>Date unit<select data-field="unit">${option('day', 'Day')}${option('weekday', 'Weekday')}${option('month', 'Month')}${option('year', 'Year')}</select></label>
    </div>
    <div class="row">
      <label>Start<input data-field="start" placeholder="from the first cell"></label>
      <label>Increment<input data-field="step" value="1"></label>
      <label>End<input data-field="stop" placeholder="none"></label>
    </div>`, 'Fill');
  if (!confirmed) return;
  const f = readFields();
  const num = (text) => (String(text).trim() === '' ? null : Number(text));
  sheet.fillSeries({ direction: f.direction, type: f.type, unit: f.unit, step: num(f.step) ?? 1, stop: num(f.stop), start: num(f.start) });
}

export async function randomDialog(sheet) {
  const confirmed = await showPanel('Fill random numbers', `
    <label>Distribution<select data-field="kind">${option('uniform', 'Uniform')}${option('integer', 'Uniform integer')}${option('normal', 'Normal')}</select></label>
    <div class="row">
      <label>Minimum, or mean<input type="number" data-field="a" value="0" step="any"></label>
      <label>Maximum, or standard deviation<input type="number" data-field="b" value="1" step="any"></label>
    </div>
    <label>Decimal places, blank for all<input type="number" data-field="decimals" min="0" max="15" placeholder="all"></label>`, 'Fill');
  if (!confirmed) return;
  const f = readFields();
  sheet.fillRandom({ kind: f.kind, a: f.a, b: f.b, decimals: document.querySelector('[data-field="decimals"]')?.value === '' ? null : f.decimals });
}

export async function textToColumnsDialog(sheet) {
  const confirmed = await showPanel('Text to columns', `
    <p class="hint">Splits the selected column's text into the columns to its right.</p>
    <div class="row">
      <label class="inline"><input type="checkbox" data-field="tab"> Tab</label>
      <label class="inline"><input type="checkbox" data-field="comma" checked> Comma</label>
      <label class="inline"><input type="checkbox" data-field="semicolon"> Semicolon</label>
      <label class="inline"><input type="checkbox" data-field="space"> Space</label>
      <label>Other<input data-field="other" size="3"></label>
    </div>
    <label class="inline"><input type="checkbox" data-field="merge"> Several separators in a row count as one</label>`, 'Split');
  if (!confirmed) return;
  const f = readFields();
  const separators = [f.tab && '\t', f.comma && ',', f.semicolon && ';', f.space && ' ', ...(f.other ? [...f.other] : [])].filter(Boolean);
  sheet.textToColumns({ separators, merge: f.merge });
}

export async function subtotalsDialog(sheet) {
  const area = sheet.dataArea();
  const header = true;
  const columns = [];
  for (let c = area.left; c <= area.right; c += 1) columns.push(c);
  const confirmed = await showPanel(`Subtotals for ${areaLabel(area)}`, `
    <p class="hint">The data should be sorted by the column it is grouped by.</p>
    <label>Group by<select data-field="group">${columnChoices(sheet, area, header, area.left)}</select></label>
    <label>Use<select data-field="fn">${[['9', 'Sum'], ['2', 'Count'], ['1', 'Average'], ['4', 'Maximum'], ['5', 'Minimum'], ['6', 'Product']].map(([v, l]) => option(v, l)).join('')}</select></label>
    <p>Total</p>
    ${columns.map((c) => `<label class="inline"><input type="checkbox" data-field="c${c}"${typeof sheet.sheet.valueAt(area.top + 1, c) === 'number' ? ' checked' : ''}> ${escapeHtml(String(sheet.sheet.valueAt(area.top, c) ?? columnName(c)))}</label>`).join('')}`, 'Add');
  if (!confirmed) return;
  const f = readFields();
  const chosen = columns.filter((c) => f[`c${c}`]);
  if (chosen.length) sheet.subtotals({ area, groupCol: Number(f.group), columns: chosen, fn: Number(f.fn) });
}

export async function insertCellsDialog(sheet) {
  const choice = await showChoice('Insert cells', '<p>Make room by moving</p>', [
    { id: 'cancel', label: 'Cancel' }, { id: 'rows', label: 'Whole rows' }, { id: 'cols', label: 'Whole columns' },
    { id: 'right', label: 'Cells right' }, { id: 'down', label: 'Cells down', primary: true },
  ]);
  const { top, bottom, left, right } = sheet.selection;
  if (choice === 'down' || choice === 'right') sheet.insertCells(choice);
  if (choice === 'rows') sheet.insertRows(top, bottom - top + 1);
  if (choice === 'cols') sheet.insertColumns(left, right - left + 1);
}

export async function deleteCellsDialog(sheet) {
  const choice = await showChoice('Delete cells', '<p>Close the gap by moving</p>', [
    { id: 'cancel', label: 'Cancel' }, { id: 'rows', label: 'Whole rows' }, { id: 'cols', label: 'Whole columns' },
    { id: 'left', label: 'Cells left' }, { id: 'up', label: 'Cells up', primary: true },
  ]);
  const { top, bottom, left, right } = sheet.selection;
  if (choice === 'up' || choice === 'left') sheet.deleteCells(choice);
  if (choice === 'rows') sheet.deleteRows(top, bottom - top + 1);
  if (choice === 'cols') sheet.deleteColumns(left, right - left + 1);
}

export async function mergeCells(sheet) {
  if (sheet.mergeLoses()) {
    const choice = await showChoice('Merge cells', '<p>Only the first cell\'s content is kept; the others are emptied.</p>', [
      { id: 'cancel', label: 'Cancel' }, { id: 'merge', label: 'Merge', primary: true },
    ]);
    if (choice !== 'merge') return;
  }
  sheet.merge();
}

/** Find and replace, its buttons acting while the panel stays. */
export async function findReplaceDialog(sheet, toast) {
  let found = null;
  for (;;) {
    const choice = await showChoice('Find and replace', `
      <label>Find<input data-field="find" value="${escapeHtml(found?.find ?? '')}"></label>
      <label>Replace with<input data-field="replace" value="${escapeHtml(found?.replace ?? '')}"></label>
      <div class="row">
        <label class="inline"><input type="checkbox" data-field="matchCase"${found?.matchCase ? ' checked' : ''}> Match case</label>
        <label class="inline"><input type="checkbox" data-field="wholeCell"${found?.wholeCell ? ' checked' : ''}> Whole cell</label>
        <label class="inline"><input type="checkbox" data-field="inFormulas"${found?.inFormulas ? ' checked' : ''}> In formulas</label>
        <label class="inline"><input type="checkbox" data-field="regex"${found?.regex ? ' checked' : ''}> Regular expression</label>
      </div>`, [
      { id: 'cancel', label: 'Close' }, { id: 'all', label: 'Replace all' }, { id: 'previous', label: 'Previous' }, { id: 'next', label: 'Find next', primary: true },
    ]);
    if (choice !== 'next' && choice !== 'previous' && choice !== 'all') return;
    found = readFields();
    if (choice === 'all') {
      const count = sheet.replaceAll(found.find, found.replace, found);
      toast(`${count} cell(s) changed`);
      return;
    }
    const at = sheet.findNext(found.find, { ...found, backwards: choice === 'previous' });
    if (!at) {
      toast('Not found');
      return;
    }
  }
}

/** The list a cell with choices drops down, under the cell; resolves to the choice or null. */
export function chooseFromList(anchor, choices) {
  const doc = anchor.ownerDocument;
  const list = doc.createElement('ul');
  list.className = 'choice-list';
  list.setAttribute('role', 'listbox');
  const items = choices.map((choice) => {
    const item = doc.createElement('li');
    item.setAttribute('role', 'option');
    item.textContent = String(choice);
    list.append(item);
    return item;
  });
  const box = anchor.getBoundingClientRect();
  list.style.left = `${Math.round(box.left)}px`;
  list.style.top = `${Math.round(box.bottom)}px`;
  doc.body.append(list);
  let at = 0;
  const mark = (i) => {
    at = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((item, n) => item.setAttribute('aria-selected', String(n === at)));
    items[at]?.scrollIntoView?.({ block: 'nearest' });
  };
  mark(0);
  return new Promise((resolve) => {
    const done = (value) => {
      list.remove();
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('mousedown', onDown, true);
      resolve(value);
    };
    function onKey(event) {
      const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };
      if (moves[event.key]) mark(at + moves[event.key]);
      else if (event.key === 'Enter') done(choices[at] ?? null);
      else if (event.key === 'Escape' || event.key === 'Tab') done(null);
      else return;
      event.preventDefault();
      event.stopPropagation();
    }
    function onDown(event) {
      const index = items.indexOf(event.target.closest?.('li'));
      event.preventDefault();
      done(index === -1 ? null : choices[index]);
    }
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('mousedown', onDown, true);
  });
}

const NUMBER_FORMATS = [
  ['', 'General'], ['0', '1234'], ['0.00', '1234.50'], ['#,##0', '1,234'], ['#,##0.00', '1,234.50'], ['0%', '12%'], ['0.00%', '12.34%'],
  ['0.00E+00', '1.23E+03'], ['#,##0.00 [$€-410]', '1.234,50 €'], ['yyyy-mm-dd', '2026-11-02'], ['dd/mm/yyyy', '02/11/2026'],
  ['d mmmm yyyy', '2 November 2026'], ['hh:mm', '14:30'], ['hh:mm:ss', '14:30:05'], ['yyyy-mm-dd hh:mm', '2026-11-02 14:30'], ['@', 'Text'],
];
const FONTS = ['', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Noto Sans', 'Noto Serif'];

/** Format cells: numbers, font, alignment, borders and fill in one panel, with the active cell shown as it will look. */
export async function formatCellsDialog(sheet) {
  const { row, col } = sheet.active;
  const look = sheet.styleAt(row, col);
  const value = sheet.sheet.valueAt(row, col) ?? 1234.5;
  const known = NUMBER_FORMATS.some(([code]) => code === (look.format ?? ''));
  const check = (field, label) => `<label class="inline"><input type="checkbox" data-field="${field}"${look[field] ? ' checked' : ''}> ${label}</label>`;
  const answer = showPanel(`Format ${areaLabel(sheet.selection)}`, `
    <div class="format-preview"><span id="format-sample"></span></div>
    <div class="row">
      <label>Number<select data-field="formatChoice">${NUMBER_FORMATS.map(([code, label]) => option(code, label, look.format ?? '')).join('')}${option('custom', 'Custom', known ? '' : 'custom')}</select></label>
      <label>Format code<input data-field="formatCode" value="${escapeHtml(look.format ?? '')}" placeholder="#,##0.00"></label>
    </div>
    <div class="row">
      <label>Font<select data-field="font">${FONTS.map((f) => option(f, f || 'Default', look.font ?? '')).join('')}${look.font && !FONTS.includes(look.font) ? option(look.font, look.font, look.font) : ''}</select></label>
      <label>Size<input type="number" min="4" max="96" step="0.5" data-field="size" value="${look.size ?? ''}" placeholder="10"></label>
      <label>Text colour<input type="color" data-field="color" value="${look.color ?? '#000000'}"></label>
    </div>
    <div class="row">${check('bold', 'Bold')}${check('italic', 'Italic')}${check('underline', 'Underline')}${check('strike', 'Strikethrough')}</div>
    <div class="row">
      <label>Across<select data-field="align">${[['', 'By the value'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['justify', 'Justified']].map(([v, l]) => option(v, l, look.align ?? '')).join('')}</select></label>
      <label>Up and down<select data-field="valign">${[['', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']].map(([v, l]) => option(v, l, look.valign ?? '')).join('')}</select></label>
      <label>Indent<input type="number" min="0" max="15" data-field="indent" value="${look.indent ?? 0}"></label>
      <label>Turn<input type="number" min="-90" max="90" data-field="rotate" value="${look.rotate ?? 0}"></label>
    </div>
    ${check('wrap', 'Wrap the text onto more lines')}
    <div class="row">
      <label>Borders<select data-field="borders">${[['keep', 'As they are'], ['none', 'None'], ['outline', 'Around'], ['all', 'Around and inside'], ['inner', 'Inside'], ['bottom', 'Bottom'], ['top', 'Top']].map(([v, l]) => option(v, l, 'keep')).join('')}</select></label>
      <label>Line<select data-field="borderStyle">${[['1', 'Thin'], ['2', 'Medium'], ['3', 'Thick'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['double', 'Double']].map(([v, l]) => option(v, l, '1')).join('')}</select></label>
      <label>Line colour<input type="color" data-field="borderColor" value="#000000"></label>
    </div>
    <div class="row">
      <label class="inline"><input type="checkbox" data-field="fill"${look.bg ? ' checked' : ''}> Fill</label>
      <label>Fill colour<input type="color" data-field="bg" value="${look.bg ?? '#ffff00'}"></label>
    </div>`, 'Apply');
  const body = document.getElementById('panel-body');
  const sample = () => document.getElementById('format-sample');
  const read = () => {
    const f = readFields();
    const format = f.formatChoice === 'custom' ? f.formatCode : f.formatChoice;
    return {
      ...look, format: format || null, font: f.font || null, size: f.size || null, color: f.color === '#000000' ? null : f.color,
      bold: f.bold, italic: f.italic, underline: f.underline, strike: f.strike, align: f.align || null, valign: f.valign || null,
      indent: f.indent || 0, rotate: f.rotate || 0, wrap: f.wrap, bg: f.fill ? f.bg : null,
    };
  };
  // Live preview while the panel is open; the change itself waits for Apply.
  const preview = () => {
    if (!sample()) return;
    const next = read();
    sample().textContent = formatValue(value, next.format);
    applyLook(sample(), next, value);
    const f = readFields();
    if (f.formatChoice !== 'custom') body.querySelector('[data-field="formatCode"]').value = f.formatChoice;
  };
  body.addEventListener('input', preview);
  body.addEventListener('change', preview);
  preview();
  const confirmed = await answer;
  body.removeEventListener('input', preview);
  body.removeEventListener('change', preview);
  if (!confirmed) return;
  const next = read();
  const f = readFields();
  const changed = Object.fromEntries(Object.entries(next).filter(([field, v]) => field !== 'borders' && JSON.stringify(v ?? null) !== JSON.stringify(look[field] ?? null)));
  if (Object.keys(changed).length) sheet.formatCells(changed);
  if (f.borders !== 'keep') {
    const line = /^\d$/.test(f.borderStyle) ? { style: 'solid', width: Number(f.borderStyle) } : { style: f.borderStyle, width: f.borderStyle === 'double' ? 3 : 1 };
    sheet.setBorders(f.borders, { ...line, color: f.borderColor });
  }
}

/** Named styles: apply one, make one from the active cell, or give one its look. */
export async function stylesDialog(sheet) {
  const styles = sheet.namedStyles;
  const choice = await showChoice('Styles', `
    <label>Style<select data-field="style">${styles.map(({ id, name }) => option(id, name)).join('')}</select></label>
    <label>Name for a new style<input data-field="name" placeholder="Total"></label>
    <p class="hint">A new style takes the active cell's look. Updating a style gives it that look, and every cell with the style changes.</p>`, [
    { id: 'cancel', label: 'Close' }, { id: 'update', label: 'Update to this cell' }, { id: 'new', label: 'New style' },
    { id: 'apply', label: 'Apply', primary: true },
  ]);
  const f = readFields();
  if (choice === 'apply') sheet.applyStyle(f.style);
  if (choice === 'update') sheet.updateStyle(f.style);
  if (choice === 'new' && f.name.trim()) sheet.newStyle(f.name.trim());
}

const CHART_KINDS = [['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Points (XY)'], ['combo', 'Columns and lines']];

/** A new chart over the data around the cell, or an existing one changed; the preview follows every field. */
export async function chartDialog(sheet, existing = null) {
  const area = sheet.dataArea();
  const chart = existing ? structuredClone(existing) : chartFromArea(sheet.sheet, area);
  const f0 = { type: chart.type, by: 'columns', title: chart.title ?? '', xTitle: chart.xTitle ?? '', yTitle: chart.yTitle ?? '', legend: chart.legend ?? 'right', stacked: chart.stacked || '' };
  const answer = showPanel(existing ? 'Chart' : `Chart of ${areaLabel(area)}`, `
    <div class="chart-preview" id="chart-preview"></div>
    <div class="row">
      <label>Kind<select data-field="type">${CHART_KINDS.map(([v, l]) => option(v, l, f0.type)).join('')}</select></label>
      <label>Stacking<select data-field="stacked">${[['', 'Side by side'], ['stacked', 'Stacked'], ['percent', 'Stacked to 100%']].map(([v, l]) => option(v, l, f0.stacked)).join('')}</select></label>
      ${existing ? '' : `<label>Each series is a<select data-field="by">${option('columns', 'Column')}${option('rows', 'Row')}</select></label>`}
    </div>
    <label>Title<input data-field="title" value="${escapeHtml(f0.title)}"></label>
    <div class="row">
      <label>Across axis title<input data-field="xTitle" value="${escapeHtml(f0.xTitle)}"></label>
      <label>Up axis title<input data-field="yTitle" value="${escapeHtml(f0.yTitle)}"></label>
      <label>Legend<select data-field="legend">${[['right', 'Right'], ['bottom', 'Below'], ['top', 'Above'], ['left', 'Left'], ['none', 'None']].map(([v, l]) => option(v, l, f0.legend)).join('')}</select></label>
    </div>`, existing ? 'Apply' : 'Insert');
  const body = document.getElementById('panel-body');
  const build = () => {
    const f = readFields();
    const series = existing ? chart.series : chartFromArea(sheet.sheet, area, { type: f.type, by: f.by }).series;
    return { ...chart, series, type: f.type, stacked: f.stacked || false, title: f.title, xTitle: f.xTitle, yTitle: f.yTitle, legend: f.legend };
  };
  const preview = () => {
    const node = document.getElementById('chart-preview');
    if (node) node.innerHTML = chartSvg(chartSpec(build(), sheet.engine, sheet.model), { width: 440, height: 220, background: '#ffffff' });
  };
  body.addEventListener('input', preview);
  body.addEventListener('change', preview);
  preview();
  const confirmed = await answer;
  body.removeEventListener('input', preview);
  body.removeEventListener('change', preview);
  if (!confirmed) return null;
  const { id, sheet: _, ...made } = build();
  if (existing) {
    sheet.updateChart(existing.id, made);
    return existing.id;
  }
  return sheet.insertChart(made);
}

const ROLES = [['', 'Not used'], ['row', 'Row'], ['col', 'Column'], ['value', 'Value'], ['filter', 'Filter']];
const GROUPS = [['', 'No grouping'], ['year', 'Years'], ['quarter', 'Quarters'], ['month', 'Months'], ['yearMonth', 'Years and months'], ['day', 'Days'], ['range', 'Ranges of numbers']];

/** The pivot table as a small table, for the preview. */
function previewTable(result) {
  if (result.error) return `<p class="hint">${escapeHtml(result.error)}</p>`;
  const rows = result.cells.slice(0, 14);
  const shown = (v) => (v === null ? '' : typeof v === 'number' ? formatValue(v) : String(v));
  return `<table class="pivot-preview">${rows.map((line, r) => `<tr class="pivot-${r >= result.bodyTop ? result.kinds[r - result.bodyTop] : 'head'}">${line.slice(0, 8).map((v) => `<td>${escapeHtml(shown(v))}</td>`).join('')}</tr>`).join('')}</table>${result.cells.length > 14 ? '<p class="hint">…</p>' : ''}`;
}

/** A new pivot table over the data around the cell, or an existing one changed; the preview follows every choice. */
export async function pivotDialog(sheet, existing = null) {
  const area = sheet.dataArea();
  const sourceRef = existing?.source ?? rangeText(sheet.sheet.name, area);
  const source = readSource(sourceRef, sheet.engine, sheet.sheetId);
  if (source.error) {
    await showPanel('Pivot table', `<p>${escapeHtml(source.error)}.</p>`);
    return null;
  }
  const roleOf = (field) => (existing?.rows?.includes(field) ? 'row' : existing?.cols?.includes(field) ? 'col'
    : existing?.values?.some((v) => v.field === field && !v.formula) ? 'value' : existing?.filters?.some((f) => f.field === field) ? 'filter' : '');
  const firstText = source.fields.findIndex((_, i) => source.records.some((r) => typeof r[i] === 'string'));
  const firstNumber = source.fields.findIndex((_, i) => source.records.every((r) => typeof r[i] === 'number' || r[i] === null));
  const suggested = (field, i) => (existing ? roleOf(field) : i === firstText ? 'row' : i === firstNumber ? 'value' : '');
  const itemsOf = (i, rule) => [...new Set(source.records.map((r) => (groupItem(r[i], rule)?.label ?? (r[i] === null ? '(empty)' : typeof r[i] === 'number' ? formatValue(r[i]) : String(r[i])))))].slice(0, 200).sort();
  const fieldRow = (field, i) => {
    const value = existing?.values?.find((v) => v.field === field && !v.formula);
    const filter = existing?.filters?.find((f) => f.field === field);
    const group = existing?.groups?.[field];
    return `<tr>
      <td>${escapeHtml(field)}</td>
      <td><select data-field="role${i}">${ROLES.map(([v, l]) => option(v, l, suggested(field, i))).join('')}</select></td>
      <td><select data-field="fn${i}">${Object.entries(FUNCTIONS).map(([v, f]) => option(v, f.label, value?.fn ?? (source.records.every((r) => typeof r[i] === 'number' || r[i] === null) ? 'sum' : 'count'))).join('')}</select></td>
      <td><select data-field="group${i}">${GROUPS.map(([v, l]) => option(v, l, group?.by ?? '')).join('')}</select></td>
      <td><input data-field="step${i}" size="4" placeholder="step" value="${escapeHtml(group?.step ?? '')}"></td>
      <td><select data-field="only${i}">${option('', '- all -', filter?.values?.[0] ?? '')}${itemsOf(i, null).map((item) => option(item, item, filter?.values?.[0] ?? '')).join('')}</select></td>
    </tr>`;
  };
  const calculatedField = existing?.values?.find((v) => v.formula);
  const answer = showPanel(existing ? 'Pivot table' : `Pivot table of ${sourceRef}`, `
    <table class="design-table pivot-fields">
      <tr><th>Field</th><th>Use as</th><th>Summary</th><th>Group</th><th></th><th>Filter shows</th></tr>
      ${source.fields.map(fieldRow).join('')}
    </table>
    <div class="row">
      <label>Calculated field<input data-field="calcName" value="${escapeHtml(calculatedField?.field ?? '')}" placeholder="Price"></label>
      <label>Formula, with field names<input data-field="calcFormula" value="${escapeHtml(calculatedField?.formula ?? '')}" placeholder="=Sales/Qty"></label>
    </div>
    <div class="row">
      <label class="inline"><input type="checkbox" data-field="totalRows"${existing?.totals?.rows === false ? '' : ' checked'}> Total of the rows</label>
      <label class="inline"><input type="checkbox" data-field="totalCols"${existing?.totals?.cols === false ? '' : ' checked'}> Total of the columns</label>
      <label class="inline"><input type="checkbox" data-field="subtotals"${existing?.subtotals === false ? '' : ' checked'}> Subtotals</label>
    </div>
    ${existing ? '' : `<label>Put it<select data-field="where">${option('new', 'On a new sheet')}${option('here', `At ${a1(area.top, area.right + 2)} of this sheet`)}</select></label>`}
    <div id="pivot-preview" class="pivot-preview-box"></div>`, existing ? 'Apply' : 'Create');
  const body = document.getElementById('panel-body');
  const build = () => {
    const f = readFields();
    const pivot = { source: sourceRef, rows: [], cols: [], values: [], filters: [], groups: {}, totals: { rows: f.totalRows, cols: f.totalCols }, subtotals: f.subtotals };
    source.fields.forEach((field, i) => {
      const role = f[`role${i}`];
      if (role === 'row') pivot.rows.push(field);
      if (role === 'col') pivot.cols.push(field);
      if (role === 'value') pivot.values.push({ field, fn: f[`fn${i}`] });
      if (role === 'filter') pivot.filters.push({ field, ...(f[`only${i}`] ? { values: [f[`only${i}`]] } : {}) });
      if (f[`group${i}`]) pivot.groups[field] = { by: f[`group${i}`], ...(f[`group${i}`] === 'range' ? { step: Number(f[`step${i}`]) || 10, start: 0 } : {}) };
    });
    if (f.calcName && f.calcFormula) pivot.values.push({ field: f.calcName, formula: f.calcFormula, name: f.calcName });
    return pivot;
  };
  const preview = () => {
    const node = document.getElementById('pivot-preview');
    if (node) node.innerHTML = previewTable(computePivot(build(), source));
  };
  body.addEventListener('input', preview);
  body.addEventListener('change', preview);
  preview();
  const confirmed = await answer;
  body.removeEventListener('input', preview);
  body.removeEventListener('change', preview);
  if (!confirmed) return null;
  const pivot = build();
  const where = readFields().where;
  if (existing) return sheet.updatePivot(existing.id, pivot);
  if (where === 'here') {
    const corner = { row: area.top, col: area.right + 2 };
    if (sheet.pivotCovers(computePivot(pivot, source), corner)) {
      const choice = await showChoice('Pivot table', '<p>The cells where it goes are not empty. Write over them?</p>', [
        { id: 'cancel', label: 'Cancel' }, { id: 'over', label: 'Write over them', primary: true },
      ]);
      if (choice !== 'over') return null;
    }
    return sheet.createPivot(pivot, { sheetId: sheet.sheetId, ...corner });
  }
  return sheet.createPivot(pivot);
}
