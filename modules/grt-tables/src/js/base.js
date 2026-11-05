/** What Base keeps beside its tables: saved queries, forms and reports, and the way they go into and out of a .odb. */

import { escapeAttr } from './core/xml.js';
import { normaliseTable } from './core/editor/model.js';
import { ODF_VERSION } from './core/formats/odf.js';
import { TOTALS } from './forms.js';

export const KINDS = { query: 'Queries', form: 'Forms', report: 'Reports' };

const fromHex = (hex) => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * A table as `writeOdb` takes it, from what the backend says about it and its rows.
 * @param {{name: string, sql?: string, columns: object[], foreignKeys: object[], indexes: object[]}} schema
 * @param {{rows: any[][]}} data rows with files as {hex}
 */
export function tableModel(schema, data) {
  const primaryKey = schema.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const single = primaryKey.length === 1 ? schema.columns.find((c) => c.name === primaryKey[0]) : null;
  return {
    name: schema.name,
    columns: schema.columns.map((c) => ({
      name: c.name, declared: c.type || 'TEXT', notNull: Boolean(c.notNull),
      autoIncrement: c === single && /^INTEGER$/i.test(c.type ?? ''),
    })),
    primaryKey,
    foreignKeys: (schema.foreignKeys ?? []).map((k) => ({ columns: [k.column], table: k.table, toColumns: k.toColumn ? [k.toColumn] : [], onDelete: k.onDelete })),
    indexes: (schema.indexes ?? []).filter((i) => i.origin !== 'pk' && i.columns?.every(Boolean)).map((i) => ({ name: i.origin === 'c' ? i.name : null, columns: i.columns, unique: i.unique })),
    rows: (data.rows ?? []).map((row) => row.map((v) => (v && typeof v === 'object' && typeof v.hex === 'string' ? fromHex(v.hex) : v))),
  };
}

/** The tables of a database in the order their foreign keys need, those pointed at first. */
export function inKeyOrder(tables) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const out = [];
  const seen = new Set();
  const visit = (table, depth = 0) => {
    if (seen.has(table.name) || depth > tables.length) return;
    seen.add(table.name);
    for (const key of table.foreignKeys) if (byName.has(key.table) && key.table !== table.name) visit(byName.get(key.table), depth + 1);
    out.push(table);
  };
  tables.forEach((t) => visit(t));
  return out;
}

// Forms, as the Writer documents with form controls that Base opens.

const FORM_MIMETYPE = 'application/vnd.oasis.opendocument.text';
const ROOT = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:form="urn:oasis:names:tc:opendocument:xmlns:form:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:ooo="http://openoffice.org/2004/office" office:version="${ODF_VERSION}"`;

/** The control a column gets in a LibreOffice form, by its type. */
function controlFor(column, id) {
  const type = String(column.declared ?? column.type ?? '').toUpperCase();
  const field = `form:id="${id}" xml:id="${id}" form:name="${escapeAttr(column.name)}" form:data-field="${escapeAttr(column.name)}"`;
  if (/BOOL/.test(type)) return `<form:checkbox ${field} form:control-implementation="ooo:com.sun.star.form.component.CheckBox"/>`;
  if (/^DATE/.test(type)) return `<form:date ${field} form:control-implementation="ooo:com.sun.star.form.component.DateField" form:dropdown="true"/>`;
  if (/^TIME/.test(type) && !/STAMP/.test(type)) return `<form:time ${field} form:control-implementation="ooo:com.sun.star.form.component.TimeField"/>`;
  if (/INT|NUM|DEC|REAL|DOUB|FLOA/.test(type)) return `<form:formatted-text ${field} form:control-implementation="ooo:com.sun.star.form.component.FormattedField"/>`;
  return `<form:text ${field} form:control-implementation="ooo:com.sun.star.form.component.TextField"/>`;
}

/**
 * A saved form as the sub-document Base keeps for it: labels and fields one under the other.
 * @param {{name: string, table: string, fields?: string[]}} form
 * @param {object[]} columns the table's columns
 */
export function odbForm(form, columns, index) {
  const shown = (form.fields?.length ? form.fields : columns.map((c) => c.name)).map((name) => columns.find((c) => c.name === name)).filter(Boolean);
  const controls = shown.map((c, i) => `<form:fixed-text form:id="label${i}" xml:id="label${i}" form:name="Label ${escapeAttr(c.name)}" form:label="${escapeAttr(c.name)}" form:control-implementation="ooo:com.sun.star.form.component.FixedText"/>${controlFor(c, `control${i}`)}`).join('');
  const shapes = shown.map((c, i) => {
    const y = 1 + i * 1.1;
    return `<draw:control text:anchor-type="paragraph" draw:z-index="${i * 2}" svg:x="1cm" svg:y="${y.toFixed(2)}cm" svg:width="4cm" svg:height="0.8cm" draw:control="label${i}"/>`
      + `<draw:control text:anchor-type="paragraph" draw:z-index="${i * 2 + 1}" svg:x="5.5cm" svg:y="${y.toFixed(2)}cm" svg:width="9cm" svg:height="0.8cm" draw:control="control${i}"/>`;
  }).join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ROOT}><office:scripts/><office:automatic-styles/><office:body><office:text><office:forms form:automatic-focus="false" form:apply-design-mode="false"><form:form form:name="MainForm" form:command="${escapeAttr(form.table)}" form:command-type="table" form:apply-filter="true" form:control-implementation="ooo:com.sun.star.form.component.Form">${controls}</form:form></office:forms><text:p>${shapes}</text:p></office:text></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ROOT}><office:styles/></office:document-styles>`;
  return {
    name: form.name, href: `forms/Obj${11 + index}`, mimetype: FORM_MIMETYPE,
    files: [['content.xml', content], ['styles.xml', styles]],
  };
}

// Reports, as the definitions LibreOffice's report builder runs: a title, a group with its header, the detail rows.

const REPORT_MIMETYPE = 'application/vnd.sun.xml.report';
const REPORT_ROOT = `${ROOT.replace(/ office:version="[^"]*"/, '')} xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:rpt="http://openoffice.org/2005/report" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" office:version="${ODF_VERSION}"`;
const PAGE_WIDTH = 17;

/** A cell showing one formula of the report builder: a field, or a quoted text. */
const reportCell = (formula, style = 'ce1') => `<table:table-cell table:style-name="${style}"><text:p><rpt:formatted-text rpt:formula="${escapeAttr(formula)}"><rpt:report-element><rpt:report-component draw:name="Formatted field"/></rpt:report-element></rpt:formatted-text></text:p></table:table-cell>`;
const quoted = (text) => `rpt:"${String(text).replace(/"/g, '""')}"`;

/**
 * A saved report as the sub-document Base keeps for it. Its totals and chart stay in GRT: the report builder works them out its own way.
 * @param {{name: string, table: string, title?: string, groupBy?: string, sortBy?: string, descending?: boolean, columns?: string[]}} report
 * @param {object[]} columns the table's columns
 */
export function odbReport(report, columns, index) {
  const names = columns.map((c) => c.name);
  const group = names.includes(report.groupBy) ? report.groupBy : null;
  const shown = (report.columns?.length ? report.columns : names).filter((c) => names.includes(c) && c !== group);
  const width = Math.max(1, shown.length);
  const columnsXml = `<table:table-columns>${shown.map(() => '<table:table-column table:style-name="co2"/>').join('') || '<table:table-column table:style-name="co1"/>'}</table:table-columns>`;
  const row = (cells, style = 'ro1') => `<table:table-row table:style-name="${style}">${cells.join('')}</table:table-row>`;
  const section = (tag, name, rows, cols = columnsXml) => `<rpt:${tag}><table:table table:name="${name}" table:style-name="ta1">${cols}${rows}</table:table></rpt:${tag}>`;
  const single = '<table:table-columns><table:table-column table:style-name="co1"/></table:table-columns>';
  const header = section('page-header', 'Page Header', row([reportCell(quoted(report.title || report.name), 'ce2')], 'ro2'), single)
    + (group ? '' : section('report-header', 'Report Header', row(shown.map((c) => reportCell(quoted(c), 'ce3')))));
  const labels = row(shown.map((c) => reportCell(quoted(c), 'ce3')));
  const detail = section('detail', 'Detail', row(shown.map((c) => reportCell(`field:[${c}]`))));
  const sort = names.includes(report.sortBy) ? report.sortBy : null;
  const body = group
    ? `<rpt:group rpt:sort-ascending="${report.descending ? 'false' : 'true'}" rpt:sort-expression="${escapeAttr(group)}" rpt:group-expression="${escapeAttr(`rpt:HASCHANGED("${group}")`)}">${section('group-header', 'Group Header', row([reportCell(`field:[${group}]`, 'ce2')], 'ro2') + labels)}${detail}</rpt:group>`
    : detail;
  const width1 = `${PAGE_WIDTH}cm`;
  const each = `${(PAGE_WIDTH / width).toFixed(3)}cm`;
  const text = (bold, size) => `<style:text-properties fo:font-size="${size}pt" style:font-name="Liberation Sans" fo:font-weight="${bold ? 'bold' : 'normal'}" fo:color="#000000"/>`;
  const styles = `<office:automatic-styles><style:style style:name="ta1" style:family="table"><style:table-properties fo:background-color="transparent"/></style:style><style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="${width1}"/></style:style><style:style style:name="co2" style:family="table-column"><style:table-column-properties style:column-width="${each}"/></style:style><style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.6cm"/></style:style><style:style style:name="ro2" style:family="table-row"><style:table-row-properties style:row-height="0.9cm"/></style:style><style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="transparent" style:vertical-align="top"/>${text(false, 10)}</style:style><style:style style:name="ce2" style:family="table-cell"><style:table-cell-properties fo:background-color="transparent" style:vertical-align="top"/>${text(true, 14)}</style:style><style:style style:name="ce3" style:family="table-cell"><style:table-cell-properties fo:background-color="transparent" style:vertical-align="top"/>${text(true, 10)}</style:style></office:automatic-styles>`;
  const sorting = !group && sort ? `<rpt:group rpt:sort-ascending="${report.descending ? 'false' : 'true'}" rpt:sort-expression="${escapeAttr(sort)}" rpt:group-expression="${escapeAttr(`rpt:HASCHANGED("${sort}")`)}">${detail}</rpt:group>` : null;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${REPORT_ROOT}>${styles}<office:body><office:report rpt:command="${escapeAttr(report.table)}" rpt:command-type="table" office:mimetype="application/vnd.oasis.opendocument.text" draw:name="${escapeAttr(report.name)}">${header}${sorting ?? body}</office:report></office:body></office:document-content>`;
  const pageStyles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${REPORT_ROOT}><office:styles/><office:automatic-styles><style:page-layout style:name="Mpm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="Mpm1"/></office:master-styles></office:document-styles>`;
  return {
    name: report.name, href: `reports/Obj${11 + index}`, mimetype: REPORT_MIMETYPE, unversioned: true,
    files: [['content.xml', content], ['styles.xml', pageStyles]],
  };
}

// Reports, as a text document of their own.

const run = (text) => ({ runs: [{ text: String(text ?? '') }] });
const cellText = (value) => (value === null || value === undefined ? '' : typeof value === 'number' && !Number.isInteger(value) ? String(Math.round(value * 100) / 100) : String(value));

/**
 * A report worked out as a document Paper writes: its title, its chart, a table for each group, the grand totals.
 * @param {object} report from buildReport
 * @param {object} definition the report's settings
 */
export function reportDocument(report, definition) {
  const totals = Object.keys(definition.totals ?? {}).filter((c) => report.columns.includes(c));
  const totalRow = (values, label) => ({ cells: [run(label), ...report.columns.slice(1).map((c) => run(values[c] !== undefined ? `${TOTALS[definition.totals[c]]} ${cellText(values[c])}` : ''))] });
  const blocks = [{ kind: 'heading', level: 1, runs: [{ text: report.title }] }];
  if (definition.chart && report.groupBy && totals.length) {
    const column = totals[0];
    blocks.push({
      kind: 'chart', type: 'column', title: `${TOTALS[definition.totals[column]]} of ${column} by ${report.groupBy}`, legend: 'none',
      data: { categories: report.groups.map((g) => cellText(g.key)), series: [{ name: column, values: report.groups.map((g) => (typeof g.totals[column] === 'number' ? g.totals[column] : null)) }] },
    });
  }
  for (const group of report.groups) {
    if (group.key !== null) blocks.push({ kind: 'heading', level: 2, runs: [{ text: `${report.groupBy}: ${cellText(group.key)}` }] });
    const rows = [
      { header: true, cells: report.columns.map((c) => run(c)) },
      ...group.rows.slice(0, 1990).map((row) => ({ cells: report.at.map((i) => run(cellText(row[i]))) })),
    ];
    if (totals.length && report.groupBy) rows.push(totalRow(group.totals, `${group.rows.length} row(s)`));
    blocks.push(normaliseTable({ kind: 'table', rows }));
  }
  if (totals.length) blocks.push(normaliseTable({ kind: 'table', rows: [totalRow(report.totals, `All ${report.count} row(s)`)] }));
  return { blocks };
}

/** What a form or report read from a .odb becomes in GRT: the table it shows and how. */
export function objectsFromOdb(database) {
  const tables = new Set(database.tables.map((t) => t.name));
  const out = [];
  for (const q of [...database.queries, ...database.views]) out.push({ kind: 'query', name: q.name, body: { sql: q.sql } });
  for (const f of database.forms) {
    if (f.table && (f.commandType ?? 'table') === 'table' && tables.has(f.table)) out.push({ kind: 'form', name: f.name, body: { table: f.table, fields: f.fields } });
  }
  for (const r of database.reports) {
    if (r.table && tables.has(r.table)) out.push({ kind: 'report', name: r.name, body: { table: r.table, title: r.name, groupBy: r.groupBy ?? '', columns: r.columns ?? [], totals: {}, chart: false } });
  }
  return out;
}

