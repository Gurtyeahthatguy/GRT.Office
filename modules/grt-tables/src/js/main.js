/** Wiring. */

import { TablesController } from './controller.js';
import {
  TYPES, ON_DELETE, newTable, newColumn, createTableSql, dropTableSql,
  alterationsPossible,
} from './schema.js';
import { showPanel, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { withPassword, passwordFields, wirePasswordFields, passwordFrom, PROTECTION } from './core/protection.js';
import { readOds, writeOds } from './core/formats/ods.js';
import { readXlsx, writeXlsx } from './core/formats/xlsx.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { sheetRows, tablesAsSpreadsheet } from './spreadsheets.js';
import { printablePages, reportPages } from './printing.js';
import { isOwnTable, inputFor, valuesFrom, recordSql, countSql, searchFilter, buildReport, reportHtml, TOTALS } from './forms.js';
import { quoteIdent, renameTableSql, checkName } from './schema.js';
import { createMenubar, paletteEntries } from './core/menubar.js';
import { tablesMenus } from './menus.js';
import { readOdb, sqliteImport, writeOdb } from './odb.js';
import { tableModel, inKeyOrder, odbForm, odbReport, reportDocument, objectsFromOdb } from './base.js';
import { writeOdt } from './core/formats/odt-write.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { searchEverywhere } from './core/everywhere.js';
import { THEMES, applyTheme, isTheme } from './core/theme.js';
import * as io from './io.js';

const el = (id) => document.getElementById(id);

let sheet = null;               // the controller.
let runtime = { ephemeral: false, version: '0.0.0', initialFile: null };
let settings = { theme: 'system' };
let view = 'data';
let designing = null;           // the table being designed.
let saved = { query: [], form: [], report: [] };
let selected = null;            // { kind, name } of the object last chosen in the sidebar.
let currentForm = null;         // the saved form being shown, with its fields.
let copied = null;              // { name, cut } of the table on the clipboard.
let allRowsSelected = false;
let menus = [];

// Startup

async function start() {
  runtime = await io.runtimeInfo();
  settings = { theme: isTheme((await io.readSettings())?.theme) ? (await io.readSettings()).theme : 'system' };
  applyTheme(settings.theme);

  el('version').textContent = runtime.version;
  el('ephemeral').classList.toggle('hidden', !runtime.ephemeral);

  sheet = new TablesController(io, { onChange: redraw });

  // A database in memory, so the program is usable the moment it opens
  //.
  await sheet.createDatabase(null);

  if (runtime.initialFile && await io.fileExists(runtime.initialFile)) {
    await openPath(runtime.initialFile);
  }

  wire();
  wireMenus();
  redraw();
}

// Drawing

function redraw() {
  drawTableList();
  drawObjectLists();
  drawStatus();

  if (view === 'data') drawData();
  if (view === 'design') drawDesign();
  if (view === 'form') drawForm();
  if (view === 'report') drawReportSetup();

  el('readonly-bar').classList.toggle('hidden', !sheet.database || !sheet.readOnly);
  for (const button of ['btn-new-table', 'btn-add-row', 'btn-delete-row', 'btn-import-csv', 'btn-share']) {
    el(button).disabled = sheet.readOnly;
  }
}

function drawStatus() {
  const path = sheet.database?.path;
  el('db-path').textContent = path
    ? path
    : (sheet.database?.inMemory ? 'A new database, not saved anywhere yet' : '');
}

function drawTableList() {
  const list = el('table-list');
  const tables = sheet.tables.filter((entry) => !isOwnTable(entry.name));

  if (tables.length === 0) {
    list.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: 'No tables yet.',
    }));
    return;
  }

  list.replaceChildren(...tables.map((entry) => {
    const row = document.createElement('button');
    row.className = 'table-row';
    row.dataset.table = entry.name;
    row.classList.toggle('current', entry.name === sheet.table);

    const name = document.createElement('span');
    name.textContent = entry.name;
    row.append(name);

    if (entry.kind === 'view') {
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = 'view';
      row.append(kind);
    }

    return row;
  }));
}

/** The saved queries, forms and reports, each list read again whenever the database changes. */
async function drawObjectLists() {
  if (!sheet?.database) return;
  const lists = await Promise.all(['query', 'form', 'report'].map((kind) => sheet.objects(kind)));
  saved = { query: lists[0], form: lists[1], report: lists[2] };
  for (const kind of ['query', 'form', 'report']) {
    const host = el(`${kind}-list`);
    if (!saved[kind].length) {
      host.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: `No ${kind === 'query' ? 'queries' : `${kind}s`} yet.` }));
      continue;
    }
    host.replaceChildren(...saved[kind].map((entry) => {
      const row = document.createElement('button');
      row.className = 'table-row';
      row.dataset.kind = kind;
      row.dataset.name = entry.name;
      row.classList.toggle('current', selected?.kind === kind && selected.name === entry.name);
      row.textContent = entry.name;
      return row;
    }));
  }
}

function drawData() {
  const host = el('data-grid');
  const page = sheet.page;

  if (!page || page.rows.length === 0) {
    host.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'empty',
      textContent: sheet.table ? 'This table is empty.' : 'No table selected.',
    }));
    el('page-label').textContent = '';
    drawFilterColumns();
    return;
  }

  host.replaceChildren(gridTable(sheet.displayColumns, page.rows.map((row) => row.slice(1)), {
    onSort: true,
    rowIds: page.rows.map((row) => row[0]),
  }));

  el('page-label').textContent =
    `${page.total} row(s), page ${sheet.pageNumber} of ${sheet.pageCount}`;
  el('btn-prev-page').disabled = sheet.pageNumber <= 1;
  el('btn-next-page').disabled = sheet.pageNumber >= sheet.pageCount;

  drawFilterColumns();
}

function drawFilterColumns() {
  const select = el('filter-column');
  const wanted = ['', ...sheet.displayColumns];
  const current = select.value;

  select.replaceChildren(...wanted.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name === '' ? 'Any column' : name;
    return option;
  }));

  if (wanted.includes(current)) select.value = current;
}

/** A table of values. */
function gridTable(columns, rows, { onSort = false, rowIds = null } = {}) {
  const table = document.createElement('table');

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of columns) {
    const cell = document.createElement('th');
    cell.textContent = name;
    if (onSort) {
      cell.dataset.column = name;
      if (sheet.orderBy === name) {
        const mark = document.createElement('span');
        mark.className = 'sort';
        mark.textContent = sheet.descending ? '▾' : '▴';
        cell.append(mark);
      }
    }
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  rows.forEach((row, index) => {
    const line = document.createElement('tr');
    if (rowIds) {
      line.dataset.rowid = String(rowIds[index]);
      line.classList.toggle('selected', allRowsSelected || rowIds[index] === sheet.selectedRow);
    }

    for (const value of row) {
      const cell = document.createElement('td');
      if (value === null) {
        cell.textContent = 'null';
        cell.className = 'null';
      } else if (typeof value === 'number') {
        cell.textContent = String(value);
        cell.className = 'number';
      } else {
        cell.textContent = String(value);
      }
      line.append(cell);
    }
    body.append(line);
  });
  table.append(body);

  return table;
}

// The designer

function drawDesign() {
  if (!designing) {
    designing = sheet.schema
      ? { name: sheet.schema.name, columns: columnsOf(sheet.schema), existing: true }
      : newTable('');
  }

  const host = el('design-panel');
  const table = document.createElement('table');
  table.className = 'design-table';

  const head = document.createElement('tr');
  for (const label of ['Name', 'Type', 'Required', 'Unique', 'Key', 'Default', '']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);

  designing.columns.forEach((column, index) => {
    const row = document.createElement('tr');
    row.append(
      field('text', column.name, (value) => { column.name = value; }),
      choice(TYPES.map((t) => [t.id, t.label]), column.type, (value) => { column.type = value; }),
      tick(column.notNull, (value) => { column.notNull = value; }),
      tick(column.unique, (value) => { column.unique = value; }),
      tick(column.primaryKey, (value) => { column.primaryKey = value; }),
      field('text', column.default ?? '', (value) => { column.default = value; }),
    );

    const remove = document.createElement('td');
    const button = document.createElement('button');
    button.textContent = '−';
    button.title = 'Remove this column';
    button.onclick = () => {
      designing.columns.splice(index, 1);
      drawDesign();
    };
    remove.append(button);
    row.append(remove);

    table.append(row);
  });

  const nameRow = document.createElement('div');
  nameRow.className = 'filter-bar';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = designing.name;
  nameInput.placeholder = 'Table name';
  nameInput.oninput = () => { designing.name = nameInput.value; drawSql(); };

  const add = document.createElement('button');
  add.textContent = 'Add column';
  add.onclick = () => { designing.columns.push(newColumn('')); drawDesign(); };

  const create = document.createElement('button');
  create.className = 'primary';
  create.textContent = designing.existing ? 'Table already exists' : 'Create table';
  create.disabled = Boolean(designing.existing) || sheet.readOnly;
  create.onclick = () => createDesignedTable();

  const drop = document.createElement('button');
  drop.className = 'danger';
  drop.textContent = 'Drop table';
  drop.disabled = !designing.existing || sheet.readOnly;
  drop.onclick = () => dropCurrentTable();

  nameRow.append(nameInput, add, create, drop);

  host.replaceChildren(nameRow, table);

  if (designing.existing) {
    const limits = alterationsPossible();
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `${limits.why} It can: ${limits.canDo.join(', ')}.`;
    host.append(note);
  }

  drawSql();
}

function drawSql() {
  const { sql, problems } = createTableSql(designing);
  el('design-sql').textContent = problems.length > 0
    ? `${sql}\n\n-- ${problems.join('\n-- ')}`
    : sql;
}

function columnsOf(schema) {
  return (schema.columns ?? []).map((column) => ({
    ...newColumn(column.name),
    type: column.type || 'TEXT',
    notNull: Boolean(column.notNull),
    primaryKey: Boolean(column.primaryKey),
    default: column.default ?? '',
  }));
}

function field(type, value, onInput) {
  const cell = document.createElement('td');
  const input = document.createElement('input');
  input.type = type;
  input.value = value ?? '';
  input.oninput = () => { onInput(input.value); drawSql(); };
  cell.append(input);
  return cell;
}

function tick(checked, onChange) {
  const cell = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.onchange = () => { onChange(input.checked); drawSql(); };
  cell.append(input);
  return cell;
}

function choice(options, value, onChange) {
  const cell = document.createElement('td');
  const select = document.createElement('select');
  for (const [id, label] of options) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    option.selected = id === value;
    select.append(option);
  }
  select.onchange = () => { onChange(select.value); drawSql(); };
  cell.append(select);
  return cell;
}

async function createDesignedTable() {
  try {
    const result = await sheet.createTable(designing);
    if (!result.ran) {
      await io.notify(result.problems.join('\n'), 'That table cannot be created');
      return;
    }
    designing = null;
    setView('data');
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Failed');
  }
}

async function dropCurrentTable() {
  const name = designing?.name;
  if (!name) return;

  // A destructive schema change is confirmed, and the statement is shown.
  const sure = await io.confirm(
    `${dropTableSql(name)}\n\nEvery row in ${name} goes with it. `
    + 'It can be undone while the program is open, and not afterwards.',
    'Drop table',
  );
  if (!sure) return;

  try {
    await sheet.dropTable(name);
    designing = null;
    setView('data');
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Failed');
  }
}

// Rows

async function addRow() {
  if (!sheet.schema) return;

  const fields = sheet.schema.columns
    .filter((column) => !(column.primaryKey && /INT/i.test(column.type)))
    .map((column) => `
      <label>${escapeHtml(column.name)}
        <span class="hint">${escapeHtml(column.type)}${column.notNull ? ' · required' : ''}</span>
        <input data-field="${escapeHtml(column.name)}">
      </label>`)
    .join('');

  const confirmed = await showPanel(`New row in ${sheet.table}`, fields, 'Add');
  if (!confirmed) return;

  const values = {};
  for (const [name, value] of Object.entries(readFields())) {
    if (value !== '') values[name] = value;
  }

  try {
    await sheet.addRow(values);
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Could not add that row');
  }
}

async function editRow(rowid) {
  const record = (sheet.page?.rows ?? [])
    .map((row, index) => ({ row, index }))
    .find(({ row }) => row[0] === rowid);
  if (!record) return;

  const values = sheet.rowAt(record.index);

  const fields = sheet.displayColumns.map((name) => `
    <label>${escapeHtml(name)}
      <input data-field="${escapeHtml(name)}" value="${escapeHtml(values[name] ?? '')}">
    </label>`).join('');

  const confirmed = await showPanel(`Row ${rowid} of ${sheet.table}`, fields, 'Save');
  if (!confirmed) return;

  const changes = {};
  for (const [name, value] of Object.entries(readFields())) {
    const was = values[name];
    if (String(was ?? '') !== value) changes[name] = value === '' ? null : value;
  }
  if (Object.keys(changes).length === 0) return;

  try {
    await sheet.changeRow(rowid, changes);
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Could not save that row');
  }
}

async function deleteSelectedRow() {
  if (sheet.selectedRow === null) {
    await io.notify('Choose a row first.', 'Nothing selected');
    return;
  }
  const sure = await io.confirm(`Delete row ${sheet.selectedRow} from ${sheet.table}?`, 'Delete row');
  if (!sure) return;

  try {
    await sheet.removeRow(sheet.selectedRow);
    sheet.selectedRow = null;
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Could not delete that row');
  }
}

// Queries

async function runQuery() {
  const sql = el('query-input').value.trim();
  if (!sql) return;

  const what = await sheet.inspect(sql);

  // A statement that would change everything is pointed out first.
  if (what.unbounded) {
    const sure = await io.confirm(
      `${sql}\n\nThis has no WHERE clause, so it applies to every row. Run it?`,
      'That affects everything',
    );
    if (!sure) return;
  }

  const result = await sheet.runQuery(sql);
  const host = el('query-result');
  const note = el('query-note');

  if (!result) {
    note.textContent = sheet.lastError ?? 'That did not run';
    note.className = 'warning';
    host.replaceChildren();
    return;
  }

  note.className = 'dim';

  if (result.rows.length === 0) {
    note.textContent = what.writes
      ? `${result.changed} row(s) changed`
      : 'No rows';
    host.replaceChildren();
    return;
  }

  note.textContent = `${result.rows.length} row(s)`;
  host.replaceChildren(gridTable(result.columns, result.rows));
}

// Files

async function openPath(path) {
  if (/\.odb$/i.test(path)) {
    await openOdb(path);
    return;
  }
  try {
    await sheet.openDatabase(path);
    designing = null;
    redraw();
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Could not open that database');
  }
}

/** Imports a CSV file or a spreadsheet's sheets, each as a new table. */
async function importFile() {
  const source = await io.pickToOpen(io.FILTERS.importable, 'Import');
  if (!source) return;
  if (/\.(ods|fods|xlsx)$/i.test(source)) await importSpreadsheet(source);
  else await importCsv(source);
}

async function importCsv(source) {
  const text = await io.readText(source);
  const plan = sheet.planCsvImport(text, {
    tableName: tableNameFrom(io.baseName(source).replace(/\.[^.]+$/, '')),
  });
  await confirmAndImport(plan, 'Import CSV');
}

const tableNameFrom = (name) => String(name ?? '').replace(/[^\w]/g, '_') || 'imported';

async function importSpreadsheet(source) {
  let opened;
  try {
    opened = await withPassword(io.baseName(source), async (password) => {
      if (/\.xlsx$/i.test(source)) return readXlsx(await readPackage(source, { password }));
      if (/\.fods$/i.test(source)) return readOds(await io.readText(source));
      return readOds(await readPackage(source, { password }));
    });
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Cannot read that spreadsheet');
    return;
  }
  if (!opened) return;
  const result = opened.value;
  const sheets = result.document.sheets
    .map((each) => ({ name: each.name, rows: sheetRows(each, result.document.styles) }))
    .filter((each) => each.rows.length > 0);
  if (sheets.length === 0) {
    await io.notify('Every sheet in it is empty.', 'Nothing to import');
    return;
  }
  let chosen = sheets;
  if (sheets.length > 1) {
    const confirmed = await showPanel('Import spreadsheet', `
      <p class="hint">Each sheet chosen becomes a table of its own.</p>
      ${sheets.map((each, i) => `
        <label class="inline"><input type="checkbox" data-field="sheet_${i}" checked>
        ${escapeHtml(each.name)} <span class="hint">${each.rows.length} row(s)</span></label>`).join('')}
    `, 'Next');
    if (!confirmed) return;
    const fields = readFields();
    chosen = sheets.filter((_, i) => fields[`sheet_${i}`]);
  }
  for (const each of chosen) {
    const plan = sheet.planRowsImport(each.rows, { tableName: tableNameFrom(each.name) });
    if (!await confirmAndImport(plan, `Import “${escapeHtml(each.name)}”`)) return;
  }
}

/** Shows the columns and types a plan proposes, lets them be changed, and imports. */
async function confirmAndImport(plan, title) {
  // The types are proposed with their evidence, and confirmed.
  const rows = plan.columns.map((column, index) => `
    <tr>
      <td><input data-field="name_${index}" value="${escapeHtml(column.name)}"></td>
      <td><select data-field="type_${index}">
        ${TYPES.map((type) => `<option value="${type.id}"${type.id === column.type ? ' selected' : ''}>${type.label}</option>`).join('')}
      </select></td>
      <td class="hint">${escapeHtml(column.sample.join(', ') || '-')}</td>
      <td class="hint">${column.confident ? '' : 'few values'}</td>
    </tr>`).join('');

  const confirmed = await showPanel(title, `
    <p class="hint">${escapeHtml(plan.reason)}</p>
    <label>Table name<input data-field="table" value="${escapeHtml(plan.table.name)}"></label>
    <label class="inline"><input type="checkbox" data-field="header"${plan.header ? ' checked' : ''}> The first row is column names</label>
    <p class="hint">${plan.rowCount} row(s). These types are a guess from the first rows; change any that are wrong.</p>
    <table class="design-table">
      <tr><th>Column</th><th>Type</th><th>Examples</th><th></th></tr>
      ${rows}
    </table>
  `, 'Import');

  if (!confirmed) return false;

  const fields = readFields();
  plan.header = Boolean(fields.header);
  plan.table.name = fields.table || plan.table.name;
  plan.table.columns = plan.columns.map((column, index) => ({
    ...column,
    name: fields[`name_${index}`] || column.name,
    type: fields[`type_${index}`] || column.type,
  }));

  try {
    const result = await sheet.importCsv(plan);
    if (!result.ran) {
      await io.notify(result.problems.join('\n'), 'That table cannot be created');
      return false;
    }
    await io.notify(`${result.imported} row(s) imported into ${plan.table.name}.`, 'Imported');
    return true;
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Import failed');
    return false;
  }
}

/** Exports the table, the query's result or every table, as CSV or as a spreadsheet. */
async function exportData() {
  const hasQuery = !!sheet.queryResult;
  let problem = '';
  let fields;
  let chosen = { what: view === 'query' && hasQuery ? 'query' : 'table', format: 'ods' };
  for (;;) {
    const answer = showPanel('Export', `
      <div class="form-grid">
        <label>What<select data-field="what">
          <option value="table"${chosen.what === 'table' ? ' selected' : ''}${sheet.table ? '' : ' disabled'}>This table</option>
          <option value="query"${chosen.what === 'query' ? ' selected' : ''}${hasQuery ? '' : ' disabled'}>The query's result</option>
          <option value="all"${chosen.what === 'all' ? ' selected' : ''}${sheet.tables.length > 0 ? '' : ' disabled'}>Every table, a sheet each</option>
        </select></label>
        <label>Format<select data-field="format">
          <option value="ods"${chosen.format === 'ods' ? ' selected' : ''}>OpenDocument spreadsheet (.ods)</option>
          <option value="xlsx"${chosen.format === 'xlsx' ? ' selected' : ''}>Excel workbook (.xlsx)</option>
          <option value="csv"${chosen.format === 'csv' ? ' selected' : ''}>CSV, one table only</option>
          <option value="odb"${chosen.format === 'odb' ? ' selected' : ''}>LibreOffice Base database (.odb), everything</option>
        </select></label>
      </div>
      ${passwordFields(null, problem)}
      <p class="hint">Rows go out as they are filtered and sorted now. Dates stored as text become dates in a spreadsheet.
      A CSV file cannot carry a password.</p>
    `, 'Choose file');
    wirePasswordFields();
    if (!await answer) return;
    fields = readFields();
    const protection = passwordFrom(fields, fields.format);
    if (!protection.error) {
      fields.password = protection.password;
      break;
    }
    problem = protection.error;
    chosen = fields;
  }
  const { what, format, password } = fields;
  if (format === 'odb') {
    await exportOdb(password);
    return;
  }
  if (format === 'csv' && what === 'all') {
    await io.notify('A CSV file holds one table. Choose a spreadsheet to export them all.', 'Export');
    return;
  }
  const suggested = what === 'query' ? 'query' : what === 'all' ? 'database' : sheet.table ?? 'table';
  const destination = await io.pickToSave(`${suggested}.${format}`, io.FILTERS[format], 'Export');
  if (!destination) return;
  const path = io.withExtension(destination, format);

  if (format === 'csv') {
    await io.writeText(path, await sheet.exportCsv({ fromQuery: what === 'query' }));
    await io.notify('Saved. It opens in GRT Grid.', 'Exported');
    return;
  }
  const tables = what === 'all'
    ? await Promise.all(sheet.tables.map((table) => sheet.allRows({ table: table.name ?? table })))
    : [await sheet.allRows({ fromQuery: what === 'query' })];
  const document = tablesAsSpreadsheet(tables);
  const { entries } = format === 'xlsx' ? writeXlsx(document) : writeOds(document);
  await writePackage(path, entries, { protection: PROTECTION[format], password });
  await io.notify(`${tables.reduce((n, t) => n + t.rows.length, 0)} row(s) saved. It opens in GRT Grid.`, 'Exported');
}

// Printing

let printSetup = { what: 'table', size: 'A4', orientation: 'portrait', margin: 12 };

async function printData() {
  const hasQuery = !!sheet.queryResult;
  if (!sheet.table && !hasQuery) {
    await io.notify('Open a table, or run a query, to have something to print.', 'Print');
    return;
  }
  const loaded = new Map();
  const rowsFor = async (what) => {
    if (!loaded.has(what)) loaded.set(what, await sheet.allRows({ fromQuery: what === 'query' }));
    return loaded.get(what);
  };
  printSetup = await printPreview({
    title: 'Print',
    setup: { ...printSetup, what: view === 'query' && hasQuery ? 'query' : sheet.table ? 'table' : 'query' },
    controls: (s) => `
      <label>Print<select data-print-field="what">
        <option value="table"${s.what === 'table' ? ' selected' : ''}${sheet.table ? '' : ' disabled'}>This table</option>
        <option value="query"${s.what === 'query' ? ' selected' : ''}${hasQuery ? '' : ' disabled'}>The query's result</option>
      </select></label>
      ${pageControls(s, { margins: true })}`,
    build: async (s) => printablePages(await rowsFor(s.what), s),
  });
}

async function exportArchive() {
  let problem = '';
  let password;
  for (;;) {
    const answer = showPanel('Export archive', `
      <p class="hint">The archive holds the schema and the data as readable text.</p>
      ${passwordFields(null, problem)}
      <p class="hint">A password protects the archive only: the .sqlite file you work on stays as it is.</p>`, 'Choose file');
    wirePasswordFields();
    if (!await answer) return;
    const protection = passwordFrom(readFields());
    if (!protection.error) {
      ({ password } = protection);
      break;
    }
    problem = protection.error;
  }
  const destination = await io.pickToSave('database.grt', io.FILTERS.grt, 'Export archive');
  if (!destination) return;

  await sheet.exportArchive(io.withExtension(destination, 'grt'), password);
  await io.notify(
    'Saved. The archive holds the schema and the data as readable text, so it '
    + 'can be inspected in any editor and compared in version control.',
    'Archive written',
  );
}

async function importArchive(chosen = null) {
  const source = typeof chosen === 'string' ? chosen : await io.pickToOpen(io.FILTERS.grt, 'Import archive');
  if (!source) return;

  const destination = runtime.ephemeral ? null : await io.pickToSave('imported.sqlite');
  if (!runtime.ephemeral && !destination) return;

  try {
    const into = destination ? io.withExtension(destination, 'sqlite') : null;
    const opened = await withPassword(io.baseName(source), (password) => sheet.importArchive(source, into, password));
    if (!opened) return;
    designing = null;
    redraw();
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Import failed');
  }
}

async function prepareForSharing() {
  const sure = await io.confirm(
    'This compacts the file so that deleted records are really gone from it, '
    + 'and removes the journal files beside it.\n\nUndo history is lost.',
    'Prepare for sharing',
  );
  if (!sure) return;

  try {
    const result = await sheet.prepareForSharing();
    await io.notify(
      `Done. ${result.removed.length} file(s) removed from beside the database.`,
      'Ready to share',
    );
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Failed');
  }
}

// Settings

async function openSettings() {
  const themes = THEMES.map((theme) => (
    `<option value="${theme.id}"${theme.id === settings.theme ? ' selected' : ''}>${theme.label}</option>`
  )).join('');

  const confirmed = await showPanel('Settings', `
    <label>Theme<select data-field="theme">${themes}</select></label>
    <p class="hint">There is no scripting engine here and there will not be one,
    for the same reason as in GRT Grid.</p>
    <p class="hint">Journal files are switched off and deleted content is
    overwritten, so a database does not leave recent rows in files beside it.
    "Prepare for sharing" compacts the file itself.</p>
  `, 'Apply');

  if (!confirmed) return;
  settings.theme = readFields().theme;
  applyTheme(settings.theme);
  io.writeSettings(settings);
}

// Wiring

/** A short note in the status bar, gone after a moment. */
let noteTimer = null;
function toast(message) {
  const node = el('status-note');
  node.textContent = message;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { node.textContent = ''; }, 2500);
}

// Forms: one record at a time

const form = { offset: 0, count: 0, rowid: null, search: '', table: null, ticket: 0 };

/** For each foreign key, the rows it may point at, named by their first text column. */
async function keyChoices() {
  const choices = new Map();
  for (const key of sheet.schema?.foreignKeys ?? []) {
    try {
      const target = await io.tableSchema(key.table);
      const label = target.columns.find((c) => /TEXT|CHAR|CLOB/i.test(c.type ?? '') && c.name !== key.toColumn)?.name ?? key.toColumn;
      const to = key.toColumn ?? target.columns.find((c) => c.primaryKey)?.name ?? 'rowid';
      const options = await sheet.read(`SELECT ${quoteIdent(to)}, ${quoteIdent(label ?? to)} FROM ${quoteIdent(key.table)} LIMIT 1000`);
      choices.set(key.column, new Map((options?.rows ?? []).map((r) => [String(r[0]), String(r[1] ?? r[0])])));
    } catch {
      // A broken key is a plain field.
    }
  }
  return choices;
}

async function drawForm() {
  // Only the latest drawing may fill the form in, or a slower earlier one could show one record and save another.
  const ticket = ++form.ticket;
  const stale = () => ticket !== form.ticket;
  const host = el('form-fields');
  if (!sheet.schema) {
    host.innerHTML = '<p class="hint">Choose a table to fill in.</p>';
    return;
  }
  if (form.table !== sheet.table) Object.assign(form, { offset: 0, rowid: null, search: '', table: sheet.table });
  const every = sheet.schema.columns;
  const chosen = currentForm?.table === sheet.table && currentForm.fields?.length ? currentForm.fields : null;
  const columns = chosen ? chosen.map((name) => every.find((c) => c.name === name)).filter(Boolean) : every;
  const { where, params } = searchFilter(every, form.search);
  const counted = await sheet.read(countSql(sheet.table, where), params);
  if (stale()) return;
  form.count = Number(counted?.rows?.[0]?.[0] ?? 0);
  form.offset = Math.max(0, Math.min(form.offset, Math.max(0, form.count - 1)));
  const found = form.count && form.rowid !== 'new' ? await sheet.read(recordSql(sheet.table, where), [...params, form.offset]) : null;
  if (stale()) return;
  const names = found?.columns ?? [];
  const row = found?.rows?.[0] ?? null;
  const record = row ? Object.fromEntries(names.map((n, i) => [n, row[i]])) : {};
  const rowid = row ? record.__rowid : 'new';
  const choices = await keyChoices();
  if (stale()) return;
  host.innerHTML = columns.map((column) => `
    <label class="form-field"><span>${escapeHtml(column.name)}${column.notNull ? ' *' : ''}</span>
      ${inputFor(column, record[column.name], { choices: choices.get(column.name) ?? null })}</label>`).join('');
  form.rowid = rowid;
  el('form-position').textContent = form.rowid === 'new' ? `New record (${form.count} in all)` : `${form.offset + 1} of ${form.count}`;
  for (const id of ['btn-form-new', 'btn-form-delete', 'btn-form-save']) el(id).disabled = sheet.readOnly;
}

async function saveForm() {
  if (!sheet.schema) return;
  const values = valuesFrom(sheet.schema.columns, readFormFields(el('form-fields')));
  try {
    if (form.rowid === 'new') {
      await sheet.addRow(values);
      form.offset = form.count;
    } else {
      await sheet.changeRow(form.rowid, values);
    }
    form.rowid = null;
    toast('Saved');
    drawForm();
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Could not save that record');
  }
}

/** The fields of a form as a plain object, checkboxes as booleans. */
function readFormFields(host) {
  const out = {};
  for (const field of host.querySelectorAll('[data-field]')) out[field.dataset.field] = field.type === 'checkbox' ? field.checked : field.value;
  return out;
}

// Reports: groups, totals, a chart, on paper

let reportDefinition = { title: '', groupBy: '', sortBy: '', descending: false, columns: [], totals: {}, chart: true };
let lastReport = null;

async function drawReportSetup() {
  const host = el('report-setup');
  if (!sheet.schema) {
    host.innerHTML = '<p class="hint">Choose a table to report on.</p>';
    el('report-output').replaceChildren();
    return;
  }
  const columns = sheet.schema.columns.map((c) => c.name);
  const numeric = sheet.schema.columns.filter((c) => /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(c.type ?? '')).map((c) => c.name);
  const def = reportDefinition;
  const option = (value, label, chosen) => `<option value="${escapeHtml(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  host.innerHTML = `
    <label>Title<input data-report="title" value="${escapeHtml(def.title || sheet.table)}"></label>
    <label>Group by<select data-report="groupBy">${option('', '(no groups)', def.groupBy)}${columns.map((c) => option(c, c, def.groupBy)).join('')}</select></label>
    <label>Sort by<select data-report="sortBy">${option('', '(as stored)', def.sortBy)}${columns.map((c) => option(c, c, def.sortBy)).join('')}</select></label>
    <label class="inline"><input type="checkbox" data-report="descending"${def.descending ? ' checked' : ''}> Highest first</label>
    ${numeric.map((c) => `<label>${escapeHtml(c)}<select data-total="${escapeHtml(c)}">${option('', 'No total', def.totals[c] ?? '')}${Object.entries(TOTALS).map(([k, l]) => option(k, l, def.totals[c] ?? '')).join('')}</select></label>`).join('')}
    <label class="inline"><input type="checkbox" data-report="chart"${def.chart ? ' checked' : ''}> A chart of the totals by group</label>
    <button id="btn-report-print">Print…</button>
    <button id="btn-report-save">Save report…</button>
    <button id="btn-report-text">As a text document…</button>`;
  host.oninput = host.onchange = () => {
    for (const field of host.querySelectorAll('[data-report]')) reportDefinition[field.dataset.report] = field.type === 'checkbox' ? field.checked : field.value;
    reportDefinition.totals = Object.fromEntries([...host.querySelectorAll('[data-total]')].filter((f) => f.value).map((f) => [f.dataset.total, f.value]));
    showReport();
  };
  el('btn-report-print').onclick = () => printReport();
  el('btn-report-save').onclick = () => saveReport();
  el('btn-report-text').onclick = () => reportToText();
  showReport();
}

async function showReport() {
  const result = await sheet.read(`SELECT * FROM ${quoteIdent(sheet.table)} LIMIT 50000`);
  if (!result) return;
  lastReport = buildReport({ ...reportDefinition, title: reportDefinition.title || sheet.table }, result.columns, result.rows, { labels: await keyChoices() });
  el('report-output').innerHTML = reportHtml(lastReport, reportDefinition);
}

/** The report on paper: its HTML flowed onto pages by the shared print engine. */
async function printReport() {
  if (!lastReport) return;
  const html = reportHtml(lastReport, reportDefinition);
  printSetup = await printPreview({
    title: 'Print the report',
    setup: { ...printSetup },
    controls: (s) => pageControls(s, { margins: true }),
    build: async (s) => reportPages(html, s),
  });
}

function setView(next) {
  view = next;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === next);
  }
  for (const name of ['data', 'design', 'query', 'form', 'report']) {
    el(`view-${name}`).classList.toggle('hidden', name !== next);
  }
  redraw();
}

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => setView(tab.dataset.view);
  }

  const goTo = (offset) => {
    form.offset = offset;
    form.rowid = null;
    drawForm();
  };
  el('btn-form-first').onclick = () => goTo(0);
  el('btn-form-prev').onclick = () => goTo(Math.max(0, form.offset - 1));
  el('btn-form-next').onclick = () => goTo(Math.min(form.count - 1, form.offset + 1));
  el('btn-form-last').onclick = () => goTo(Math.max(0, form.count - 1));
  el('btn-form-new').onclick = () => {
    form.rowid = 'new';
    drawForm();
  };
  el('btn-form-save').onclick = () => saveForm();
  el('btn-form-delete').onclick = async () => {
    if (form.rowid === 'new' || form.rowid === null) return;
    if (!await io.confirm('Delete this record?', 'Delete record')) return;
    await sheet.removeRow(form.rowid);
    form.rowid = null;
    drawForm();
  };
  el('form-search').oninput = (event) => {
    form.search = event.target.value;
    goTo(0);
  };

  el('table-list').addEventListener('click', (event) => {
    const row = event.target.closest('[data-table]');
    if (!row) return;
    designing = null;
    currentForm = null;
    allRowsSelected = false;
    selected = { kind: 'table', name: row.dataset.table };
    sheet.showTable(row.dataset.table);
  });
  for (const kind of ['query', 'form', 'report']) {
    el(`${kind}-list`).addEventListener('click', (event) => {
      const row = event.target.closest('[data-name]');
      if (row) openObject(kind, row.dataset.name);
    });
  }
  el('btn-save-query').onclick = () => saveQuery();
  el('btn-save-view').onclick = () => saveView();
  el('btn-save-form').onclick = () => saveFormAs();

  el('data-grid').addEventListener('click', (event) => {
    const header = event.target.closest('th[data-column]');
    if (header) { sheet.sortBy(header.dataset.column); return; }

    const row = event.target.closest('tr[data-rowid]');
    if (!row) return;
    allRowsSelected = false;
    // The second click of a double click opens the row.
    if (event.detail === 2) {
      editRow(Number(row.dataset.rowid));
      return;
    }
    sheet.selectedRow = Number(row.dataset.rowid);
    redraw();
  });

  el('btn-new').onclick = async () => {
    const path = runtime.ephemeral ? null : await io.pickToSave('database.sqlite');
    if (!runtime.ephemeral && !path) return;
    await sheet.createDatabase(path ? io.withExtension(path, 'sqlite') : null);
    designing = null;
    redraw();
  };

  el('btn-open').onclick = async () => {
    const path = await io.pickToOpen(io.FILTERS.openable);
    if (path) await openPath(path);
  };

  el('btn-close').onclick = async () => {
    const result = await sheet.close();
    await sheet.createDatabase(null);
    if (result.removed.length > 0) {
      await io.notify(`${result.removed.length} journal file(s) removed.`, 'Closed');
    }
    redraw();
  };

  el('btn-unlock').onclick = async () => {
    const sure = await io.confirm(
      'This database was opened rather than created here. Allow changes to it?',
      'Allow changes',
    );
    if (sure) await sheet.unlock();
  };

  el('btn-new-table').onclick = () => { designing = newTable(''); setView('design'); };
  el('btn-undo').onclick = async () => {
    try {
      const undone = await sheet.undo();
      if (!undone) await io.notify('There is nothing to undo.', 'Undo');
    } catch (error) {
      await io.notify(String(error?.message ?? error), 'Undo');
    }
  };

  el('btn-add-row').onclick = () => addRow();
  el('btn-delete-row').onclick = () => deleteSelectedRow();

  el('btn-prev-page').onclick = () => sheet.previousPage();
  el('btn-next-page').onclick = () => sheet.nextPage();

  el('filter-value').oninput = () => {
    sheet.filter(el('filter-column').value || null, el('filter-value').value);
  };
  el('filter-column').onchange = () => {
    if (el('filter-value').value) el('filter-value').dispatchEvent(new Event('input'));
  };

  el('btn-run-query').onclick = () => runQuery();
  el('query-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      runQuery();
    }
  });

  el('btn-import-csv').onclick = () => importFile();
  el('btn-export-csv').onclick = () => exportData();
  el('btn-print').onclick = () => printData();
  el('btn-export-grt').onclick = () => exportArchive();
  el('btn-import-grt').onclick = () => importArchive();
  el('btn-share').onclick = () => prepareForSharing();
  el('btn-settings').onclick = () => openSettings();

  document.addEventListener('keydown', (event) => {
    if (isDialogOpen() || isPaletteOpen() || isPrintPreviewOpen()) return;
    const control = event.ctrlKey || event.metaKey;
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement || target?.isContentEditable;
    // The keys that click a button only do what the button would, so a disabled one does nothing.
    const press = (id) => { if (!el(id).disabled && !el(id).closest('.hidden')) { event.preventDefault(); el(id).click(); } };

    if (!control) {
      // Page Up and Page Down turn pages of rows, or records in a form; not while typing, which would lose an edit.
      if (typing) return;
      const keys = view === 'form'
        ? { PageUp: 'btn-form-prev', PageDown: 'btn-form-next', Home: 'btn-form-first', End: 'btn-form-last' }
        : view === 'data' ? { PageUp: 'btn-prev-page', PageDown: 'btn-next-page' } : {};
      if (keys[event.key]) press(keys[event.key]);
      return;
    }

    if (event.key === 'f' && (view === 'data' || view === 'form')) {
      event.preventDefault();
      const box = el(view === 'form' ? 'form-search' : 'filter-value');
      box.focus();
      box.select();
    }
    else if (event.key === 's' && view === 'form') press('btn-form-save');
    else if (event.key === 'k') { event.preventDefault(); openPalette(commands()); }
    else if (event.key === 'o') { event.preventDefault(); el('btn-open').click(); }
    else if (event.key === 'p') { event.preventDefault(); printData(); }
    else if (event.key === 'z') { event.preventDefault(); el('btn-undo').click(); }
  });
}

function commands() {
  return paletteEntries(menus).filter((entry) => entry.enabled());
}

function wireMenus() {
  const has = {
    table: () => Boolean(sheet.table),
    copied: () => Boolean(copied),
    selected: () => Boolean(selected),
    report: () => Boolean(lastReport),
  };
  menus = tablesMenus({
    view: () => view,
    has,
    actions: {
      newDatabase: () => el('btn-new').click(),
      open: () => el('btn-open').click(),
      close: () => el('btn-close').click(),
      importFile, exportData, exportOdb: () => exportOdb(), reportToText, exportArchive, importArchive,
      print: () => printData(), prepareForSharing,
      undo: () => el('btn-undo').click(),
      cutTable: () => copyTable(true), copyTable: () => copyTable(false), pasteTable, selectAll, copyRows,
      rename: renameSelected, remove: removeSelected, saveView, saveQuery,
      setView, newTable: () => el('btn-new-table').click(), formWizard, reportWizard, addRow,
      settings: () => openSettings(),
      // A Tables archive found is imported, which asks where its database goes.
      everywhere: () => searchEverywhere({ kind: 'tables', open: (path) => importArchive(path), toast }),
    },
  });
  createMenubar(el('menubar'), menus);
}

// Base's objects: saved queries, forms and reports

/** Asks for a name, with a hint of what it is for; null when cancelled. */
async function askName(title, value, hint = '') {
  const confirmed = await showPanel(title, `
    <label>Name<input data-field="name" value="${escapeHtml(value ?? '')}"></label>
    ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ''}`, 'OK');
  if (!confirmed) return null;
  const name = String(readFields().name ?? '').trim();
  const problem = checkName(name);
  if (problem) {
    await io.notify(problem, title);
    return null;
  }
  return name;
}

async function openObject(kind, name) {
  // One just saved may not be in the list drawn a moment ago.
  if (!saved[kind].some((o) => o.name === name)) saved[kind] = await sheet.objects(kind);
  const entry = saved[kind].find((o) => o.name === name);
  if (!entry) return;
  selected = { kind, name };
  if (kind === 'query') {
    setView('query');
    el('query-input').value = entry.sql ?? '';
    await runQuery();
    return;
  }
  if (!sheet.tables.some((t) => t.name === entry.table)) {
    await io.notify(`The table ${entry.table ?? ''} it shows is not in this database.`, `Cannot open ${name}`);
    return;
  }
  await sheet.showTable(entry.table);
  if (kind === 'form') {
    currentForm = entry;
    setView('form');
  } else {
    reportDefinition = { title: '', groupBy: '', sortBy: '', descending: false, columns: [], totals: {}, chart: true, ...entry };
    setView('report');
  }
}

async function saveQuery() {
  const sql = el('query-input').value.trim();
  if (!sql) {
    await io.notify('Write a query in the Query view first.', 'Save query');
    return;
  }
  const name = await askName('Save query', selected?.kind === 'query' ? selected.name : '', 'Saved queries are kept in the database and listed on the left.');
  if (!name) return;
  await guarded('Could not save the query', async () => {
    await sheet.saveObject('query', name, { sql });
    selected = { kind: 'query', name };
    toast('Saved');
  });
}

async function saveView() {
  const sql = el('query-input').value.trim().replace(/;\s*$/, '');
  if (!/^(SELECT|WITH)\b/i.test(sql) || sql.includes(';')) {
    await io.notify('A view is one SELECT query. Write it in the Query view first.', 'Create as view');
    return;
  }
  const name = await askName('Create as view', '', 'A view is opened like a table, and always shows what the query finds now.');
  if (!name) return;
  await guarded('Could not create the view', () => sheet.runSchema(`CREATE VIEW ${quoteIdent(name)} AS ${sql};`));
}

async function saveFormAs() {
  if (!sheet.table) return;
  const name = await askName('Save form', currentForm?.name ?? sheet.table);
  if (!name) return;
  const body = { table: sheet.table, fields: currentForm?.table === sheet.table ? currentForm.fields ?? [] : [] };
  await guarded('Could not save the form', async () => {
    await sheet.saveObject('form', name, body);
    currentForm = { name, ...body };
    selected = { kind: 'form', name };
    toast('Saved');
  });
}

async function saveReport() {
  if (!sheet.table) return;
  const name = await askName('Save report', selected?.kind === 'report' ? selected.name : reportDefinition.title || sheet.table);
  if (!name) return;
  await guarded('Could not save the report', async () => {
    await sheet.saveObject('report', name, { ...reportDefinition, table: sheet.table });
    selected = { kind: 'report', name };
    toast('Saved');
  });
}

const tableOptions = (chosen) => sheet.tables.filter((t) => !isOwnTable(t.name))
  .map((t) => `<option value="${escapeHtml(t.name)}"${t.name === chosen ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('');

/** The form wizard: a table, the fields it shows and their order, and a name. */
async function formWizard() {
  if (!sheet.tables.some((t) => !isOwnTable(t.name))) {
    await io.notify('Make a table first.', 'New form');
    return;
  }
  if (!await showPanel('New form', `<label>Table<select data-field="table">${tableOptions(sheet.table)}</select></label>`, 'Next')) return;
  const table = readFields().table;
  const described = await io.tableSchema(table);
  const confirmed = await showPanel('New form', `
    <label>Name<input data-field="name" value="${escapeHtml(table)}"></label>
    <p class="hint">The fields it shows, one under the other. Untick those it should leave out.</p>
    ${described.columns.map((c, i) => `<label class="inline"><input type="checkbox" data-field="field_${i}" checked> ${escapeHtml(c.name)}</label>`).join('')}`, 'Create');
  if (!confirmed) return;
  const fields = readFields();
  const name = String(fields.name ?? '').trim() || table;
  const chosen = described.columns.filter((_, i) => fields[`field_${i}`]).map((c) => c.name);
  await guarded('Could not save the form', async () => {
    await sheet.saveObject('form', name, { table, fields: chosen });
    await openObject('form', name);
  });
}

/** The report wizard: a table, how it is grouped and sorted, what is totalled, and a name. */
async function reportWizard() {
  if (!sheet.tables.some((t) => !isOwnTable(t.name))) {
    await io.notify('Make a table first.', 'New report');
    return;
  }
  if (!await showPanel('New report', `<label>Table<select data-field="table">${tableOptions(sheet.table)}</select></label>`, 'Next')) return;
  const table = readFields().table;
  const described = await io.tableSchema(table);
  const names = described.columns.map((c) => c.name);
  const numeric = described.columns.filter((c) => /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(c.type ?? '')).map((c) => c.name);
  const option = (value, label) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  const confirmed = await showPanel('New report', `
    <label>Name<input data-field="name" value="${escapeHtml(table)}"></label>
    <label>Group by<select data-field="groupBy">${option('', '(no groups)')}${names.map((c) => option(c, c)).join('')}</select></label>
    <label>Sort by<select data-field="sortBy">${option('', '(as stored)')}${names.map((c) => option(c, c)).join('')}</select></label>
    ${numeric.map((c, i) => `<label>${escapeHtml(c)}<select data-field="total_${i}">${option('', 'No total')}${Object.entries(TOTALS).map(([k, l]) => option(k, l)).join('')}</select></label>`).join('')}
    <label class="inline"><input type="checkbox" data-field="chart" checked> A chart of the totals by group</label>`, 'Create');
  if (!confirmed) return;
  const fields = readFields();
  const name = String(fields.name ?? '').trim() || table;
  const totals = Object.fromEntries(numeric.map((c, i) => [c, fields[`total_${i}`]]).filter(([, fn]) => fn));
  const body = { table, title: name, groupBy: fields.groupBy ?? '', sortBy: fields.sortBy ?? '', descending: false, columns: [], totals, chart: Boolean(fields.chart) };
  await guarded('Could not save the report', async () => {
    await sheet.saveObject('report', name, body);
    await openObject('report', name);
  });
}

/** The report as an OpenDocument text, ready for Paper. */
async function reportToText() {
  if (!lastReport) {
    await io.notify('Open a report first, in the Report view.', 'Report as a text document');
    return;
  }
  const destination = await io.pickToSave(`${lastReport.title || 'report'}.odt`, io.FILTERS.odt, 'Save the report');
  if (!destination) return;
  await guarded('Could not save the report', async () => {
    const { entries } = writeOdt(reportDocument(lastReport, reportDefinition));
    await writePackage(io.withExtension(destination, 'odt'), entries);
    toast('Saved. It opens in GRT Paper.');
  });
}

async function renameSelected() {
  if (!selected) return;
  const name = await askName(`Rename ${selected.name}`, selected.name);
  if (!name || name === selected.name) return;
  await guarded('Could not rename it', async () => {
    if (selected.kind === 'table') {
      await sheet.runSchema(renameTableSql(selected.name, name));
      for (const kind of ['form', 'report']) {
        for (const entry of saved[kind].filter((o) => o.table === selected.name)) {
          const { name: own, ...body } = entry;
          await sheet.saveObject(kind, own, { ...body, table: name });
        }
      }
      await sheet.showTable(name);
    } else {
      await sheet.renameObject(selected.kind, selected.name, name);
    }
    selected = { ...selected, name };
  });
}

async function removeSelected() {
  if (!selected) return;
  const what = selected.kind === 'table' ? 'table, with every row in it' : selected.kind;
  if (!await io.confirm(`Delete the ${what} “${selected.name}”?`, 'Delete')) return;
  await guarded('Could not delete it', async () => {
    if (selected.kind === 'table') await sheet.dropTable(selected.name);
    else await sheet.deleteObject(selected.kind, selected.name);
    selected = null;
  });
}

function copyTable(cut) {
  if (!sheet.table) return;
  copied = { name: sheet.table, cut };
  toast(cut ? 'Cut: paste it to move it' : 'Copied');
}

/** Pastes the table on the clipboard as Base's copy-table wizard does: with its rows, empty, as a view, or into a table. */
async function pasteTable() {
  if (!copied) return;
  const source = copied.name;
  const confirmed = await showPanel('Paste table', `
    <label>Name<input data-field="name" value="${escapeHtml(`${source}_copy`)}"></label>
    <label class="inline"><input type="radio" name="how" data-field="how_both" checked> Definition and data</label>
    <label class="inline"><input type="radio" name="how" data-field="how_definition"> Definition only</label>
    <label class="inline"><input type="radio" name="how" data-field="how_view"> As a view</label>
    <label class="inline"><input type="radio" name="how" data-field="how_append"> Append its rows to the table named above</label>`, 'Paste');
  if (!confirmed) return;
  const fields = readFields();
  const name = String(fields.name ?? '').trim();
  const problem = checkName(name);
  if (problem) {
    await io.notify(problem, 'Paste table');
    return;
  }
  await guarded('Could not paste the table', async () => {
    if (fields.how_view) {
      await sheet.runSchema(`CREATE VIEW ${quoteIdent(name)} AS SELECT * FROM ${quoteIdent(source)};`);
    } else if (fields.how_append) {
      const target = await io.tableSchema(name);
      const from = await io.tableSchema(source);
      const common = from.columns.map((c) => c.name).filter((c) => target.columns.some((t) => t.name === c));
      await sheet.runSchema(`INSERT INTO ${quoteIdent(name)} (${common.map(quoteIdent).join(', ')}) SELECT ${common.map(quoteIdent).join(', ')} FROM ${quoteIdent(source)};`);
    } else {
      const from = await io.tableSchema(source);
      const create = String(from.sql ?? '').replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/i, `CREATE TABLE ${quoteIdent(name)}`);
      if (!/^CREATE TABLE/i.test(create)) throw new Error('That table cannot be copied');
      await sheet.runSchema(`${create};`);
      if (fields.how_both) await sheet.runSchema(`INSERT INTO ${quoteIdent(name)} SELECT * FROM ${quoteIdent(source)};`);
    }
    if (copied.cut && !fields.how_view && await io.confirm(`Delete ${source} now that it has been moved?`, 'Cut table')) await sheet.dropTable(source);
    copied = null;
    await sheet.showTable(name);
  });
}

function selectAll() {
  if (!sheet.table) return;
  allRowsSelected = true;
  setView('data');
}

/** The rows on show, or the one chosen, as tab-separated text on the clipboard. */
async function copyRows() {
  const page = sheet.page;
  if (!page) return;
  const rows = allRowsSelected ? page.rows : page.rows.filter((row) => row[0] === sheet.selectedRow);
  const text = [sheet.displayColumns, ...rows.map((row) => row.slice(1))].map((row) => row.map((v) => (v === null ? '' : String(v).replace(/[\t\n]/g, ' '))).join('\t')).join('\n');
  await navigator.clipboard?.writeText(text);
  toast(`${rows.length} row(s) copied`);
}

async function guarded(title, work) {
  try {
    await work();
  } catch (error) {
    await io.notify(String(error?.message ?? error), title);
  }
}

// LibreOffice Base files

/** Opens a .odb: its tables and rows into a GRT database, its queries, forms and reports beside them. */
async function openOdb(path) {
  let opened;
  try {
    opened = await withPassword(io.baseName(path), async (password) => readOdb(await readPackage(path, { password })));
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Cannot read that Base file');
    return;
  }
  if (!opened) return;
  const database = opened.value;
  const destination = runtime.ephemeral ? null : await io.pickToSave(`${io.baseName(path).replace(/\.odb$/i, '')}.sqlite`, io.FILTERS.sqlite, 'Keep it as a GRT database');
  if (!runtime.ephemeral && !destination) return;
  try {
    const { schema, data } = sqliteImport({ ...database, tables: inKeyOrder(database.tables) });
    await sheet.importSql(schema, data, destination ? io.withExtension(destination, 'sqlite') : null);
    for (const entry of objectsFromOdb(database)) await sheet.saveObject(entry.kind, entry.name, entry.body);
    designing = null;
    currentForm = null;
    redraw();
    const rows = database.tables.reduce((n, t) => n + t.rows.length, 0);
    const notes = [
      `${database.tables.length} table(s) and ${rows} row(s) read from ${database.engine === 'firebird' ? 'Firebird' : 'HSQLDB'}.`,
      database.queries.length || database.views.length ? `Queries and views are kept as saved queries; their SQL is run only when opened.` : '',
      ...database.losses,
    ].filter(Boolean);
    await io.notify(notes.join('\n'), 'Base file opened');
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Cannot open that Base file');
  }
}

/** Writes the whole database as a .odb that LibreOffice Base opens: HSQLDB tables, queries and forms. */
async function exportOdb(password = null) {
  const destination = await io.pickToSave(`${io.baseName(sheet.database?.path ?? 'database').replace(/\.[^.]+$/, '')}.odb`, io.FILTERS.odb, 'Save as a Base database');
  if (!destination) return;
  await guarded('Could not save the Base file', async () => {
    const tables = [];
    const queries = (await sheet.objects('query')).map((q) => ({ name: q.name, sql: q.sql ?? '' }));
    for (const entry of sheet.tables) {
      if (isOwnTable(entry.name) || /^sqlite_/i.test(entry.name)) continue;
      const described = await io.tableSchema(entry.name);
      if (entry.kind === 'view') {
        const sql = /\bAS\s+([\s\S]*)$/i.exec(described.sql ?? '')?.[1];
        if (sql && !queries.some((q) => q.name === entry.name)) queries.push({ name: entry.name, sql: sql.trim() });
        continue;
      }
      tables.push(tableModel(described, await io.allRowsOf(entry.name)));
    }
    const forms = (await sheet.objects('form')).filter((f) => tables.some((t) => t.name === f.table))
      .map((f, i) => odbForm(f, tables.find((t) => t.name === f.table).columns, i));
    const savedReports = (await sheet.objects('report')).filter((r) => tables.some((t) => t.name === r.table));
    const reports = savedReports.map((r, i) => odbReport(r, tables.find((t) => t.name === r.table).columns, i));
    const entries = writeOdb({ tables: inKeyOrder(tables), queries }, { forms, reports });
    await writePackage(io.withExtension(destination, 'odb'), entries, { protection: password ? 'odf' : null, password });
    const totalled = savedReports.some((r) => Object.keys(r.totals ?? {}).length || r.chart);
    toast(totalled ? 'Saved. Report totals and charts stay in GRT; Base shows the groups and rows.' : 'Saved');
  });
}

export { ON_DELETE };

start();
