/** Pivot tables in OpenDocument spreadsheets, as LibreOffice keeps them: the fields, the source and the target range. */

import { NS, kids, kid, attr, tag } from '../xml.js';
import { fromOpenFormula, toOpenFormula } from './formulas.js';
import { odfArea, parseSheetRange, splitOutsideQuotes } from './sheet-print.js';

const FUNCTIONS_FROM = { sum: 'sum', count: 'count', average: 'average', max: 'max', min: 'min', product: 'product', countnums: 'countNums', stdev: 'stdev', stdevp: 'stdevp', var: 'var', varp: 'varp' };
const FUNCTIONS_TO = Object.fromEntries(Object.entries(FUNCTIONS_FROM).map(([a, b]) => [b, a]));
const GROUPS_FROM = { years: 'year', quarters: 'quarter', months: 'month', days: 'day' };
const GROUPS_TO = { year: 'years', quarter: 'quarters', month: 'months', yearMonth: 'months', day: 'days' };
const MAX_PIVOTS = 100;

/** A range address as Grid writes a reference: `Data!$A$1:$E$6`. */
function rangeFrom(address) {
  const first = String(address ?? '').trim().split(/\s+/)[0];
  const { formula } = fromOpenFormula(`of:=[${first}]`);
  if (!formula || formula.includes('#REF!')) return null;
  return formula.slice(1).replace(/(^|!|:)\$?([A-Z]{1,3})\$?(\d+)/g, '$1$$$2$$$3');
}

/** The sheet and the block a target address names: `'Pivot Table_Data_1'.A1:'Pivot Table_Data_1'.B4`. */
function targetFrom(address) {
  const ends = splitOutsideQuotes(String(address ?? '').trim(), ':');
  const cell = (part) => {
    const at = part?.lastIndexOf('.') ?? -1;
    if (at === -1) return null;
    return { sheet: part.slice(0, at).replace(/^\$/, '').replace(/^'([\s\S]*)'$/, '$1').replace(/''/g, "'"), ref: part.slice(at + 1).replace(/\$/g, '') };
  };
  const a = cell(ends[0]);
  const b = cell(ends[1] ?? ends[0]) ?? a;
  if (!a) return null;
  const area = parseSheetRange(`${a.ref}:${b.ref}`);
  return area?.kind === 'cells' ? { sheet: a.sheet, area: { top: area.top, left: area.left, bottom: area.bottom, right: area.right } } : null;
}

/** The pivot tables of a spreadsheet, each put on the sheet its results are on. */
export function readOdsPivots(body, sheets, losses) {
  const holder = kid(body, NS.table, 'data-pilot-tables');
  if (!holder) return;
  for (const table of kids(holder, NS.table, 'data-pilot-table').slice(0, MAX_PIVOTS)) {
    const target = targetFrom(attr(table, NS.table, 'target-range-address'));
    const sourceRange = kid(table, NS.table, 'source-cell-range');
    const source = sourceRange ? rangeFrom(attr(sourceRange, NS.table, 'cell-range-address')) : null;
    const sheet = target ? sheets.find((s) => s.name === target.sheet) : null;
    if (!source || !sheet) {
      losses.add('Pivot tables, kept as their last results');
      continue;
    }
    const pivot = { id: `pivot-${(sheet.pivots?.length ?? 0) + 1}-${sheets.indexOf(sheet)}`, source, rows: [], cols: [], values: [], filters: [], groups: {}, area: target.area };
    const grand = attr(table, NS.table, 'grand-total') ?? 'both';
    pivot.totals = { rows: grand === 'both' || grand === 'column', cols: grand === 'both' || grand === 'row' };
    let subtotals = false;
    for (const field of kids(table, NS.table, 'data-pilot-field')) {
      if (attr(field, NS.table, 'is-data-layout-field') === 'true') continue;
      const name = attr(field, NS.table, 'source-field-name');
      const orientation = attr(field, NS.table, 'orientation');
      if (!name) continue;
      if (orientation === 'row') pivot.rows.push(name);
      else if (orientation === 'column') pivot.cols.push(name);
      else if (orientation === 'data') pivot.values.push({ field: name, fn: FUNCTIONS_FROM[attr(field, NS.table, 'function')] ?? 'sum' });
      else if (orientation === 'page') {
        const selected = attr(field, NS.table, 'selected-page');
        pivot.filters.push({ field: name, ...(selected ? { values: [selected] } : {}) });
      }
      if (kid(kid(field, NS.table, 'data-pilot-level'), NS.table, 'data-pilot-subtotals')) subtotals = true;
      const groups = kid(field, NS.table, 'data-pilot-groups');
      if (groups) {
        const by = GROUPS_FROM[attr(groups, NS.table, 'grouped-by')];
        const step = Number(attr(groups, NS.table, 'step'));
        if (by) pivot.groups[name] = { by };
        else if (step > 0) pivot.groups[name] = { by: 'range', step, start: Number(attr(groups, NS.table, 'start')) || 0 };
        else losses.add('Pivot tables grouped by hand, kept as their last results');
      }
    }
    pivot.subtotals = subtotals;
    sheet.pivots = [...(sheet.pivots ?? []), pivot];
  }
}

function rangeTo(ref) {
  const match = /^of:=\[(.+)\]$/.exec(toOpenFormula(`=${ref}`));
  return match ? match[1].replace(/^\$/, '') : null;
}

/** The data-pilot tables element for every pivot of the document, or null. */
export function writeOdsPivots(sheets, losses) {
  const tables = [];
  let n = 0;
  for (const sheet of sheets ?? []) {
    for (const pivot of sheet.pivots ?? []) {
      if (!pivot.area || tables.length >= MAX_PIVOTS) continue;
      n += 1;
      const area = odfArea(sheet.name ?? 'Sheet1', pivot.area);
      const subtotal = () => tag('table:data-pilot-level', { 'table:show-empty': 'false' },
        pivot.subtotals === false ? null : tag('table:data-pilot-subtotals', {}, tag('table:data-pilot-subtotal', { 'table:function': 'auto' })));
      const groups = (field) => {
        const rule = pivot.groups?.[field];
        if (!rule) return null;
        if (rule.by === 'range') return tag('table:data-pilot-groups', { 'table:source-field-name': field, 'table:start': String(rule.start ?? 0), 'table:end': 'auto', 'table:step': String(rule.step ?? 10) });
        return tag('table:data-pilot-groups', { 'table:source-field-name': field, 'table:date-start': 'auto', 'table:date-end': 'auto', 'table:grouped-by': GROUPS_TO[rule.by] ?? 'years' });
      };
      const fields = [
        ...(pivot.rows ?? []).map((name) => tag('table:data-pilot-field', { 'table:source-field-name': name, 'table:orientation': 'row' }, subtotal(), groups(name))),
        ...(pivot.cols ?? []).map((name) => tag('table:data-pilot-field', { 'table:source-field-name': name, 'table:orientation': 'column' }, subtotal(), groups(name))),
        ...(pivot.filters ?? []).map((f) => tag('table:data-pilot-field', {
          'table:source-field-name': f.field, 'table:orientation': 'page', 'table:selected-page': f.values?.length === 1 ? f.values[0] : null,
        }, subtotal(), groups(f.field))),
        ...(pivot.values ?? []).filter((v) => !v.formula).map((v) => tag('table:data-pilot-field', {
          'table:source-field-name': v.field, 'table:orientation': 'data', 'table:function': FUNCTIONS_TO[v.fn] ?? 'sum',
        })),
        tag('table:data-pilot-field', { 'table:source-field-name': '', 'table:is-data-layout-field': 'true', 'table:orientation': 'column' }),
      ];
      if ((pivot.values ?? []).some((v) => v.formula)) losses.add('Calculated fields of pivot tables, kept as their results');
      const totals = pivot.totals ?? {};
      const grand = totals.rows !== false && totals.cols !== false ? 'both' : totals.rows !== false ? 'column' : totals.cols !== false ? 'row' : 'none';
      tables.push(tag('table:data-pilot-table', {
        'table:name': `DataPilot${n}`, 'table:application-data': '', 'table:grand-total': grand,
        'table:target-range-address': area, 'table:buttons': '', 'table:show-filter-button': 'true', 'table:drill-down-on-double-click': 'true',
      }, tag('table:source-cell-range', { 'table:cell-range-address': rangeTo(pivot.source) }), fields));
    }
  }
  return tables.length ? tag('table:data-pilot-tables', {}, tables) : null;
}
