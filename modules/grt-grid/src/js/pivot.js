/** Pivot tables: records of a range summed up by the fields chosen for rows, columns, values and filters. */

import { parse, transform, NODE } from './parser/parser.js';
import { evaluate } from './engine/evaluate.js';
import { isMatrix, isBlank, isError, ERROR } from './engine/values.js';
import { formatValue } from './format.js';

/** The summaries a value field can use, with LibreOffice's names for their captions. */
export const FUNCTIONS = {
  sum: { label: 'Sum', run: (l) => l.reduce((a, b) => a + b, 0) },
  count: { label: 'Count', all: true, run: (l) => l.length },
  countNums: { label: 'Count - numbers only', run: (l) => l.length },
  average: { label: 'Average', run: (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : ERROR.div0) },
  max: { label: 'Max', run: (l) => (l.length ? Math.max(...l) : 0) },
  min: { label: 'Min', run: (l) => (l.length ? Math.min(...l) : 0) },
  product: { label: 'Product', run: (l) => l.reduce((a, b) => a * b, 1) },
  stdev: { label: 'StDev - Sample', run: (l) => spread(l, true, true) },
  stdevp: { label: 'StDev - Population', run: (l) => spread(l, false, true) },
  var: { label: 'Var - Sample', run: (l) => spread(l, true, false) },
  varp: { label: 'Var - Population', run: (l) => spread(l, false, false) },
};

function spread(list, sample, root) {
  if (list.length < (sample ? 2 : 1)) return ERROR.div0;
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const v = list.reduce((a, b) => a + (b - mean) ** 2, 0) / (list.length - (sample ? 1 : 0));
  return root ? Math.sqrt(v) : v;
}

/** The most records and distinct items a pivot table works through, so a careless range cannot hang it. */
const MAX_RECORDS = 200000;
const MAX_ITEMS = 5000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A serial date's year, month and day. */
function dateParts(serial) {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

/**
 * The item a value falls in once grouped, as a key that sorts and a label that shows.
 * @param {{by: 'year'|'quarter'|'month'|'yearMonth'|'day'|'range', start?: number, step?: number}} rule
 */
export function groupItem(value, rule) {
  if (!rule || typeof value !== 'number') return null;
  if (rule.by === 'range') {
    const step = rule.step > 0 ? rule.step : 1;
    const start = Number.isFinite(rule.start) ? rule.start : 0;
    const low = start + Math.floor((value - start) / step) * step;
    return { key: low, label: `${low}-${Number((low + step - (Number.isInteger(step) ? 1 : 0)).toPrecision(12))}` };
  }
  const { year, month, day } = dateParts(value);
  switch (rule.by) {
    case 'year': return { key: year, label: String(year) };
    case 'quarter': return { key: Math.floor(month / 3), label: `Q${Math.floor(month / 3) + 1}` };
    case 'month': return { key: month, label: MONTHS[month] };
    case 'yearMonth': return { key: year * 12 + month, label: `${year}-${String(month + 1).padStart(2, '0')}` };
    case 'day': return { key: Math.floor(value), label: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    default: return null;
  }
}

/** The records of the source range: the first row names the fields, every other row is one record. */
export function readSource(sourceRef, engine, sheetId) {
  const { ast, error } = parse(`=${sourceRef}`);
  if (error || !ast || ast.type !== NODE.range && ast.type !== NODE.ref) return { fields: [], records: [], error: 'The source is not a range' };
  const block = evaluate(ast, engine.contextFor(sheetId, 0, 0));
  if (!isMatrix(block) || block.rows < 2) return { fields: [], records: [], error: 'The source needs a row of names and at least one row of data' };
  const fields = block.data[0].map((name, i) => (isBlank(name) ? `Column ${i + 1}` : String(name)));
  const records = [];
  for (let r = 1; r < block.rows && records.length < MAX_RECORDS; r += 1) {
    const row = block.data[r];
    if (row.every((v) => isBlank(v))) continue;
    records.push(row);
  }
  return { fields, records };
}

/** How an item shows: grouped, a formatted number, or the text itself. */
function itemOf(value, rule) {
  const grouped = groupItem(value, rule);
  if (grouped) return grouped;
  if (isBlank(value)) return { key: '', label: '(empty)' };
  if (isError(value)) return { key: value, label: value };
  return { key: typeof value === 'string' ? value.toLowerCase() : value, label: typeof value === 'number' ? formatValue(value) : String(value) };
}

const keyOf = (items) => JSON.stringify(items.map((i) => i.key));

function sortItems(a, b) {
  const x = a.key;
  const y = b.key;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'number') return -1;
  if (typeof y === 'number') return 1;
  if (x === '') return 1;
  if (y === '') return -1;
  return String(x).localeCompare(String(y), undefined, { numeric: true });
}

/** A calculated field's formula with the fields' sums put in, as Excel works them out. */
function calculated(formula, fieldIndex, records) {
  const { ast, error } = parse(String(formula).startsWith('=') ? formula : `=${formula}`);
  if (error || !ast) return ERROR.name;
  const sums = new Map();
  const tree = transform(ast, (node) => {
    if (node.type !== NODE.name) return node;
    const index = fieldIndex(node.name);
    if (index === -1) return { type: NODE.error, value: ERROR.name };
    if (!sums.has(index)) sums.set(index, records.reduce((sum, r) => sum + (typeof r[index] === 'number' ? r[index] : 0), 0));
    return { type: NODE.number, value: sums.get(index) };
  });
  const result = evaluate(tree, { sheetId: null, row: 0, col: 0, valueAt: () => null, nameAst: () => null });
  return isMatrix(result) ? result.first : result;
}

/** The value of one data field over a set of records. */
function summarise(dataField, records, fieldIndex) {
  if (dataField.formula) return calculated(dataField.formula, fieldIndex, records);
  const index = fieldIndex(dataField.field);
  if (index === -1) return ERROR.ref;
  const fn = FUNCTIONS[dataField.fn] ?? FUNCTIONS.sum;
  const values = [];
  for (const record of records) {
    const v = record[index];
    if (isError(v)) return v;
    if (fn.all ? !isBlank(v) : typeof v === 'number') values.push(fn.all ? v : v);
  }
  return fn.run(values);
}

/** The caption a data field shows, as LibreOffice writes it: `Sum - Sales`. */
export function caption(dataField) {
  if (dataField.name) return dataField.name;
  if (dataField.formula) return dataField.field ?? 'Calculated';
  return `${(FUNCTIONS[dataField.fn] ?? FUNCTIONS.sum).label} - ${dataField.field}`;
}

/** The records a pivot table counts: those its filters let through. */
function filtered(pivot, source, fieldIndex) {
  const tests = (pivot.filters ?? []).filter((f) => f.values?.length).map((f) => {
    const index = fieldIndex(f.field);
    const allowed = new Set(f.values.map(String));
    const rule = pivot.groups?.[f.field];
    return (record) => index !== -1 && allowed.has(itemOf(record[index], rule).label);
  });
  return source.records.filter((record) => tests.every((test) => test(record)));
}

/**
 * The pivot table worked out: the cells it shows, from its top-left corner, and where its parts are.
 * @param {{rows: string[], cols: string[], values: {field: string, fn?: string, formula?: string, name?: string}[],
 *   filters?: {field: string, values?: string[]}[], groups?: Object, totals?: {rows?: boolean, cols?: boolean}, subtotals?: boolean}} pivot
 */
export function computePivot(pivot, source) {
  const lower = source.fields.map((f) => f.toLowerCase());
  const fieldIndex = (name) => lower.indexOf(String(name ?? '').toLowerCase());
  const rowFields = (pivot.rows ?? []).filter((f) => fieldIndex(f) !== -1);
  const colFields = (pivot.cols ?? []).filter((f) => fieldIndex(f) !== -1);
  const dataFields = (pivot.values ?? []).filter((d) => d.formula || fieldIndex(d.field) !== -1);
  if (dataFields.length === 0) dataFields.push({ field: rowFields[0] ?? source.fields[0], fn: 'count' });
  const records = filtered(pivot, source, fieldIndex);
  const grandRows = pivot.totals?.rows !== false;
  const grandCols = pivot.totals?.cols !== false;
  const subtotals = pivot.subtotals !== false;

  const itemsFor = (record, fields) => fields.map((f) => itemOf(record[fieldIndex(f)], pivot.groups?.[f]));
  // Every record goes into the cell of its row items and column items.
  const rowKeys = new Map();
  const colKeys = new Map();
  for (const record of records) {
    const r = itemsFor(record, rowFields);
    const c = itemsFor(record, colFields);
    if (!rowKeys.has(keyOf(r)) && rowKeys.size < MAX_ITEMS) rowKeys.set(keyOf(r), r);
    if (!colKeys.has(keyOf(c)) && colKeys.size < MAX_ITEMS) colKeys.set(keyOf(c), c);
  }
  const byItems = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      const order = sortItems(a[i], b[i]);
      if (order !== 0) return order;
    }
    return 0;
  };
  const rows = [...rowKeys.values()].sort(byItems);
  const cols = [...colKeys.values()].sort(byItems);
  // Each record goes once into every bucket it counts in: each depth of its row items by each depth of its column items.
  const buckets = new Map();
  const prefix = (items, depth) => `${depth}:${keyOf(items.slice(0, depth))}`;
  for (const record of records) {
    const r = itemsFor(record, rowFields);
    const c = itemsFor(record, colFields);
    for (let rd = 0; rd <= rowFields.length; rd += 1) {
      for (const cd of new Set([0, colFields.length])) {
        const key = `${prefix(r, rd)}|${prefix(c, cd)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(record);
      }
    }
  }
  // A combination no record has stays empty, as LibreOffice shows it.
  const value = (rowItems, rowDepth, colItems, colDepth, dataField) => {
    const own = buckets.get(`${prefix(rowItems ?? [], rowItems ? rowDepth : 0)}|${prefix(colItems ?? [], colItems ? colDepth : 0)}`);
    return own?.length ? summarise(dataField, own, fieldIndex) : null;
  };

  // The columns of values: each column item, for each data field, then the totals.
  const valueColumns = [];
  for (const c of colFields.length ? cols : [null]) for (const d of dataFields) valueColumns.push({ items: c, depth: colFields.length, data: d });
  if (colFields.length && grandCols) for (const d of dataFields) valueColumns.push({ items: null, depth: 0, data: d, total: true });

  const grid = [];
  const left = Math.max(1, rowFields.length);
  // Filters first, one row each, then a blank row.
  for (const f of pivot.filters ?? []) grid.push([f.field, f.values?.length === 1 ? f.values[0] : f.values?.length ? '(several)' : '- all -']);
  if ((pivot.filters ?? []).length) grid.push([]);
  const headerTop = grid.length;

  // Column headers: the data caption and the column fields' names, a row per column field, captions when there are several.
  const single = dataFields.length === 1;
  if (colFields.length === 0) {
    const line = Array(left).fill(null);
    rowFields.forEach((f, i) => { line[i] = f; });
    valueColumns.forEach((vc, i) => { line[left + i] = caption(vc.data); });
    grid.push(line);
  } else {
    const title = Array(left).fill(null);
    title[0] = single ? caption(dataFields[0]) : null;
    title[left] = colFields.join(' - ');
    grid.push(title);
    const levels = colFields.length + (single ? 0 : 1);
    for (let level = 0; level < levels; level += 1) {
      const line = Array(left).fill(null);
      if (level === levels - 1) rowFields.forEach((f, i) => { line[i] = f; });
      let previous = null;
      valueColumns.forEach((vc, i) => {
        let text = null;
        if (level < colFields.length) {
          if (vc.total) text = level === 0 && vc.data === dataFields[0] ? 'Total Result' : null;
          else {
            const label = vc.items.slice(0, level + 1).map((it) => it.label).join('\u0000');
            if (label !== previous) text = vc.items[level].label;
            previous = label;
          }
        } else text = caption(vc.data);
        line[left + i] = text;
      });
      grid.push(line);
    }
  }
  const bodyTop = grid.length;

  const valuesFor = (rowItems, depth) => valueColumns.map((vc) => value(rowItems, depth, vc.items, vc.depth, vc.data));
  const lines = [];
  if (rowFields.length === 0) {
    lines.push({ labels: [null], values: valuesFor(null, 0), kind: 'row' });
  } else {
    let previous = null;
    rows.forEach((items, index) => {
      const labels = items.map((it, i) => (previous && previous.slice(0, i + 1).every((p, k) => p.key === items[k].key) ? null : it.label));
      lines.push({ labels, values: valuesFor(items, rowFields.length), kind: 'row', items });
      previous = items;
      // A subtotal closes each group of the outer fields when the next row leaves it.
      if (subtotals && rowFields.length > 1) {
        const next = rows[index + 1];
        for (let depth = rowFields.length - 1; depth >= 1; depth -= 1) {
          if (next && next.slice(0, depth).every((p, k) => p.key === items[k].key)) continue;
          const subLabels = Array(rowFields.length).fill(null);
          subLabels[depth - 1] = `${items[depth - 1].label} Result`;
          lines.push({ labels: subLabels, values: valuesFor(items, depth), kind: 'subtotal', depth });
        }
      }
    });
    if (grandRows) lines.push({ labels: ['Total Result'], values: valuesFor(null, 0), kind: 'total' });
  }
  for (const line of lines) {
    const row = Array(left).fill(null);
    line.labels.forEach((l, i) => { row[i] = l; });
    line.values.forEach((v, i) => { row[left + i] = v; });
    grid.push(row);
  }
  const width = Math.max(...grid.map((r) => r.length));
  return {
    cells: grid.map((r) => Array.from({ length: width }, (_, i) => (r[i] === undefined ? null : r[i]))),
    headerTop, bodyTop, left, kinds: lines.map((l) => l.kind), dataFields, rowFields, colFields,
  };
}

/** GETPIVOTDATA: one data field summed over the records that have the items named. */
export function pivotData(pivot, source, dataName, pairs) {
  const lower = source.fields.map((f) => f.toLowerCase());
  const fieldIndex = (name) => lower.indexOf(String(name ?? '').toLowerCase());
  const wanted = String(dataName ?? '').toLowerCase();
  const dataField = (pivot.values ?? []).find((d) => caption(d).toLowerCase() === wanted || String(d.field).toLowerCase() === wanted);
  if (!dataField) return ERROR.ref;
  const used = new Set([...(pivot.rows ?? []), ...(pivot.cols ?? []), ...(pivot.filters ?? []).map((f) => f.field)].map((f) => f.toLowerCase()));
  const tests = [];
  for (const [field, item] of pairs) {
    const index = fieldIndex(field);
    if (index === -1 || !used.has(String(field).toLowerCase())) return ERROR.ref;
    const rule = pivot.groups?.[source.fields[index]];
    const want = itemOf(item, null);
    tests.push((record) => {
      const got = itemOf(record[index], rule);
      return got.key === want.key || got.label.toLowerCase() === String(item).toLowerCase();
    });
  }
  const records = filtered(pivot, source, fieldIndex).filter((r) => tests.every((t) => t(r)));
  if (records.length === 0) return ERROR.ref;
  return summarise(dataField, records, fieldIndex);
}

