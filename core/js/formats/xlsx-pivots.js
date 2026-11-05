/** Pivot tables in Excel workbooks: a cache that names the source and its items, and a table that lays the fields out. */

import { NS, kids, kid, tag, xmlDocument } from '../xml.js';
import { relationships, readPart } from './ooxml.js';

export const REL_PIVOT_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable';
export const REL_PIVOT_CACHE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition';
export const PIVOT_TABLE_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml';
export const PIVOT_CACHE_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml';
const S = NS.s;
const MAX_ITEMS = 5000;

const FUNCTIONS_FROM = { sum: 'sum', count: 'count', average: 'average', max: 'max', min: 'min', product: 'product', countNums: 'countNums', stdDev: 'stdev', stdDevp: 'stdevp', var: 'var', varp: 'varp' };
const FUNCTIONS_TO = Object.fromEntries(Object.entries(FUNCTIONS_FROM).map(([a, b]) => [b, a]));

const column = (letters) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const letters = (index) => {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};

/** A block `A1:E6` as numbers. */
function areaOf(ref) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i.exec(String(ref ?? '').trim());
  if (!m) return null;
  const a = { col: column(m[1]), row: Number(m[2]) - 1 };
  const b = m[3] ? { col: column(m[3]), row: Number(m[4]) - 1 } : a;
  return { top: Math.min(a.row, b.row), left: Math.min(a.col, b.col), bottom: Math.max(a.row, b.row), right: Math.max(a.col, b.col) };
}

const sheetRef = (name, area) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`}!$${letters(area.left)}$${area.top + 1}:$${letters(area.right)}$${area.bottom + 1}`;

/** The pivot tables a sheet's relationships point at, each put on the sheet as Grid keeps them. */
export function readXlsxPivots(pkg, sheetPart, sheet, losses, workbookCaches) {
  for (const rel of relationships(pkg, sheetPart).values()) {
    if (!rel.type.endsWith('/pivotTable') || rel.external) continue;
    const doc = readPart(pkg, rel.target, 'a pivot table');
    const root = doc?.documentElement;
    if (!root) continue;
    const cacheRel = [...relationships(pkg, rel.target).values()].find((r) => r.type.endsWith('/pivotCacheDefinition'));
    const cacheDoc = cacheRel ? readPart(pkg, cacheRel.target, 'a pivot cache') : workbookCaches.get(root.getAttribute('cacheId'));
    const cache = cacheDoc?.documentElement;
    const worksheet = kid(kid(cache, S, 'cacheSource'), S, 'worksheetSource');
    const area = areaOf(worksheet?.getAttribute('ref'));
    const location = areaOf(kid(root, S, 'location')?.getAttribute('ref'));
    const fieldNames = kids(kid(cache, S, 'cacheFields'), S, 'cacheField').map((f) => f.getAttribute('name') ?? '');
    if (!area || !location || !worksheet.getAttribute('sheet') || fieldNames.length === 0) {
      losses.add('Pivot tables, kept as their last results');
      continue;
    }
    if (kid(cache, S, 'cacheFields')?.getElementsByTagNameNS(S, 'fieldGroup').length) losses.add('Pivot tables grouped by hand, kept as their last results');
    const name = (x) => fieldNames[Number(x)] ?? null;
    const pivot = {
      id: `pivot-x${(sheet.pivots?.length ?? 0) + 1}`,
      source: sheetRef(worksheet.getAttribute('sheet'), area),
      rows: kids(kid(root, S, 'rowFields'), S, 'field').map((f) => f.getAttribute('x')).filter((x) => x !== '-2').map(name).filter(Boolean),
      cols: kids(kid(root, S, 'colFields'), S, 'field').map((f) => f.getAttribute('x')).filter((x) => x !== '-2').map(name).filter(Boolean),
      values: kids(kid(root, S, 'dataFields'), S, 'dataField').map((d) => ({ field: name(d.getAttribute('fld')), fn: FUNCTIONS_FROM[d.getAttribute('subtotal') ?? 'sum'] ?? 'sum' })).filter((d) => d.field),
      filters: kids(kid(root, S, 'pageFields'), S, 'pageField').map((p) => ({ field: name(p.getAttribute('fld')) })).filter((f) => f.field),
      groups: {},
      totals: { rows: root.getAttribute('rowGrandTotals') !== '0', cols: root.getAttribute('colGrandTotals') !== '0' },
      subtotals: !kids(kid(root, S, 'pivotFields'), S, 'pivotField').some((f) => f.getAttribute('axis') && f.getAttribute('defaultSubtotal') === '0'),
      // Excel's location leaves out the rows of the page fields above it, which Grid counts in.
      area: kid(root, S, 'pageFields') ? { ...location, top: Math.max(0, location.top - kids(kid(root, S, 'pageFields'), S, 'pageField').length - 1) } : location,
    };
    // A page field that shows one item names it by its index among the cache's items.
    kids(kid(root, S, 'pageFields'), S, 'pageField').forEach((p, i) => {
      const item = p.getAttribute('item');
      const field = kids(kid(cache, S, 'cacheFields'), S, 'cacheField')[Number(p.getAttribute('fld'))];
      const shared = kids(kid(field, S, 'sharedItems'))[Number(item)];
      if (item !== null && shared && pivot.filters[i]) pivot.filters[i].values = [shared.getAttribute('v') ?? ''];
    });
    sheet.pivots = [...(sheet.pivots ?? []), pivot];
  }
}

/** The values of a block of a sheet in Grid's JSON, row by row. */
function block(sheet, area) {
  const out = [];
  for (let r = area.top; r <= area.bottom && out.length < 200000; r += 1) {
    const row = [];
    for (let c = area.left; c <= area.right; c += 1) row.push(sheet.cells?.[`${r},${c}`]?.v ?? null);
    out.push(row);
  }
  return out;
}

function parseSource(ref) {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(ref ?? '');
  return m ? { sheet: (m[1] ?? m[2]).replace(/''/g, "'"), area: areaOf(m[3]) } : null;
}

const sharedItem = (v) => (typeof v === 'number' ? tag('n', { v: String(v) }) : typeof v === 'boolean' ? tag('b', { v: v ? '1' : '0' }) : v === null ? tag('m', {}) : tag('s', { v: String(v) }));

/**
 * The parts of every pivot table of the workbook.
 * @returns {{parts: object[], caches: {id: number, rel: string}[], sheetRels: Map<number, object[]>}}
 */
export function writeXlsxPivots(document, losses) {
  const parts = [];
  const caches = [];
  const sheetRels = new Map();
  let n = 0;
  (document.sheets ?? []).forEach((sheet, sheetIndex) => {
    for (const pivot of sheet.pivots ?? []) {
      const source = parseSource(pivot.source);
      const from = source && (document.sheets ?? []).find((s) => s.name === source.sheet);
      if (!from || !source.area || !pivot.area) continue;
      n += 1;
      const rows = block(from, source.area);
      const fields = rows[0].map((v, i) => (v === null ? `Column ${i + 1}` : String(v)));
      const records = rows.slice(1);
      const index = (name) => fields.findIndex((f) => f.toLowerCase() === String(name).toLowerCase());
      const axisOf = (i) => (pivot.rows?.some((f) => index(f) === i) ? 'axisRow' : pivot.cols?.some((f) => index(f) === i) ? 'axisCol'
        : pivot.filters?.some((f) => index(f.field) === i) ? 'axisPage' : null);
      // Items of the fields on an axis are listed, so Excel and LibreOffice can lay them out.
      const items = fields.map((_, i) => (axisOf(i) ? [...new Map(records.map((r) => [JSON.stringify(r[i]), r[i]])).values()].slice(0, MAX_ITEMS) : null));
      const cacheFields = fields.map((name, i) => {
        const values = records.map((r) => r[i]);
        const numbers = values.filter((v) => typeof v === 'number');
        const attrs = items[i] ? { count: String(items[i].length) } : {
          containsSemiMixedTypes: values.some((v) => typeof v === 'string') ? null : '0', containsString: values.some((v) => typeof v === 'string') ? null : '0',
          containsNumber: numbers.length ? '1' : null, minValue: numbers.length ? String(Math.min(...numbers)) : null, maxValue: numbers.length ? String(Math.max(...numbers)) : null,
        };
        return tag('cacheField', { name, numFmtId: '0' }, tag('sharedItems', attrs, items[i] ? items[i].map(sharedItem) : null));
      });
      const cacheName = `xl/pivotCache/pivotCacheDefinition${n}.xml`;
      parts.push({
        name: cacheName, type: PIVOT_CACHE_TYPE,
        data: xmlDocument(tag('pivotCacheDefinition', { xmlns: S, 'xmlns:r': NS.r, refreshOnLoad: '1', recordCount: String(records.length) },
          tag('cacheSource', { type: 'worksheet' }, tag('worksheetSource', { ref: `${letters(source.area.left)}${source.area.top + 1}:${letters(source.area.right)}${source.area.bottom + 1}`, sheet: source.sheet })),
          tag('cacheFields', { count: String(fields.length) }, cacheFields))),
      });
      caches.push({ id: n, target: `pivotCache/pivotCacheDefinition${n}.xml` });

      const values = (pivot.values ?? []).filter((v) => !v.formula && index(v.field) !== -1);
      if ((pivot.values ?? []).some((v) => v.formula)) losses.add('Calculated fields of pivot tables, kept as their results');
      if (Object.keys(pivot.groups ?? {}).length) losses.add('Grouped items of pivot tables, kept as their results');
      const pivotFields = fields.map((_, i) => {
        const axis = axisOf(i);
        const isData = values.some((v) => index(v.field) === i);
        return tag('pivotField', {
          axis, dataField: isData ? '1' : null, showAll: '0', defaultSubtotal: axis && pivot.subtotals === false ? '0' : null,
        }, axis ? tag('items', { count: String(items[i].length + (pivot.subtotals === false ? 0 : 1)) },
          items[i].map((_, k) => tag('item', { x: String(k) })), pivot.subtotals === false ? null : tag('item', { t: 'default' })) : null);
      });
      const fieldList = (names) => names.map(index).filter((i) => i !== -1);
      const rowFields = fieldList(pivot.rows ?? []);
      const colFields = [...fieldList(pivot.cols ?? []), ...(values.length > 1 ? [-2] : [])];
      const pageFields = (pivot.filters ?? []).map((f) => ({ fld: index(f.field), item: f.values?.length === 1 ? items[index(f.field)]?.findIndex((v) => String(v) === f.values[0]) : -1 })).filter((p) => p.fld !== -1);
      const area = pivot.area;
      const pageRows = pageFields.length ? pageFields.length + 1 : 0;
      const location = { ...area, top: area.top + pageRows };
      const tableName = `xl/pivotTables/pivotTable${n}.xml`;
      parts.push({
        name: tableName, type: PIVOT_TABLE_TYPE,
        data: xmlDocument(tag('pivotTableDefinition', {
          xmlns: S, name: `PivotTable${n}`, cacheId: String(n), dataCaption: 'Values', applyNumberFormats: '0', applyBorderFormats: '0',
          applyFontFormats: '0', applyPatternFormats: '0', applyAlignmentFormats: '0', applyWidthHeightFormats: '1', updatedVersion: '6', minRefreshableVersion: '3',
          rowGrandTotals: pivot.totals?.rows === false ? '0' : null, colGrandTotals: pivot.totals?.cols === false ? '0' : null, outline: '1', outlineData: '1', compact: '0', compactData: '0',
        },
        tag('location', {
          ref: `${letters(location.left)}${location.top + 1}:${letters(location.right)}${location.bottom + 1}`,
          firstHeaderRow: '1', firstDataRow: String(1 + Math.max(1, colFields.length)), firstDataCol: String(Math.max(1, rowFields.length)),
          rowPageCount: pageFields.length ? String(pageFields.length) : null, colPageCount: pageFields.length ? '1' : null,
        }),
        tag('pivotFields', { count: String(fields.length) }, pivotFields),
        rowFields.length ? tag('rowFields', { count: String(rowFields.length) }, rowFields.map((x) => tag('field', { x: String(x) }))) : null,
        colFields.length ? tag('colFields', { count: String(colFields.length) }, colFields.map((x) => tag('field', { x: String(x) }))) : null,
        pageFields.length ? tag('pageFields', { count: String(pageFields.length) }, pageFields.map((p) => tag('pageField', { fld: String(p.fld), item: p.item >= 0 ? String(p.item) : null, hier: '-1' }))) : null,
        values.length ? tag('dataFields', { count: String(values.length) }, values.map((v) => tag('dataField', {
          name: v.name ?? `${({ sum: 'Sum', count: 'Count', average: 'Average', max: 'Max', min: 'Min', product: 'Product' })[v.fn ?? 'sum'] ?? 'Sum'} - ${v.field}`,
          fld: String(index(v.field)), subtotal: FUNCTIONS_TO[v.fn ?? 'sum'] === 'sum' ? null : FUNCTIONS_TO[v.fn ?? 'sum'], baseField: '0', baseItem: '0',
        }))) : null)),
        rels: [{ id: 'rId1', type: REL_PIVOT_CACHE, target: `../pivotCache/pivotCacheDefinition${n}.xml` }],
      });
      if (!sheetRels.has(sheetIndex)) sheetRels.set(sheetIndex, []);
      sheetRels.get(sheetIndex).push({ type: REL_PIVOT_TABLE, target: `../pivotTables/pivotTable${n}.xml` });
    }
  });
  return { parts, caches, sheetRels };
}
