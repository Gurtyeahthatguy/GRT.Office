/** Wiring. */

import { TablesController } from './controller.js';
import {
  TYPES, ON_DELETE, newTable, newColumn, createTableSql, dropTableSql,
  alterationsPossible,
} from './schema.js';
import { showPanel, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { readOds, writeOds } from './core/formats/ods.js';
import { readXlsx, writeXlsx } from './core/formats/xlsx.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { sheetRows, tablesAsSpreadsheet } from './spreadsheets.js';
import { printablePages } from './printing.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme, isTheme } from './core/theme.js';
import * as io from './io.js';

const el = (id) => document.getElementById(id);

let sheet = null;               // the controller.
let runtime = { ephemeral: false, version: '0.0.0', initialFile: null };
let settings = { theme: 'system' };
let view = 'data';
let designing = null;           // the table being designed.

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
  redraw();
}

// Drawing

function redraw() {
  drawTableList();
  drawStatus();

  if (view === 'data') drawData();
  if (view === 'design') drawDesign();

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
  const tables = sheet.tables;

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
      line.classList.toggle('selected', rowIds[index] === sheet.selectedRow);
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
  let result;
  try {
    if (/\.xlsx$/i.test(source)) result = readXlsx(await readPackage(source));
    else if (/\.fods$/i.test(source)) result = readOds(await io.readText(source));
    else result = readOds(await readPackage(source));
  } catch (error) {
    await io.notify(String(error?.message ?? error), 'Cannot read that spreadsheet');
    return;
  }
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
  const confirmed = await showPanel('Export', `
    <div class="form-grid">
      <label>What<select data-field="what">
        <option value="table"${view !== 'query' || !hasQuery ? ' selected' : ''}${sheet.table ? '' : ' disabled'}>This table</option>
        <option value="query"${view === 'query' && hasQuery ? ' selected' : ''}${hasQuery ? '' : ' disabled'}>The query's result</option>
        <option value="all"${sheet.tables.length > 0 ? '' : ' disabled'}>Every table, a sheet each</option>
      </select></label>
      <label>Format<select data-field="format">
        <option value="ods">OpenDocument spreadsheet (.ods)</option>
        <option value="xlsx">Excel workbook (.xlsx)</option>
        <option value="csv">CSV, one table only</option>
      </select></label>
    </div>
    <p class="hint">Rows go out as they are filtered and sorted now. Dates stored as text become dates in a spreadsheet.</p>
  `, 'Choose file');
  if (!confirmed) return;
  const { what, format } = readFields();
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
  await writePackage(path, entries);
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
  const destination = await io.pickToSave('database.grt', io.FILTERS.grt, 'Export archive');
  if (!destination) return;

  await sheet.exportArchive(io.withExtension(destination, 'grt'));
  await io.notify(
    'Saved. The archive holds the schema and the data as readable text, so it '
    + 'can be inspected in any editor and compared in version control.',
    'Archive written',
  );
}

async function importArchive() {
  const source = await io.pickToOpen(io.FILTERS.grt, 'Import archive');
  if (!source) return;

  const destination = runtime.ephemeral ? null : await io.pickToSave('imported.sqlite');
  if (!runtime.ephemeral && !destination) return;

  try {
    await sheet.importArchive(source, destination ? io.withExtension(destination, 'sqlite') : null);
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

function setView(next) {
  view = next;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === next);
  }
  for (const name of ['data', 'design', 'query']) {
    el(`view-${name}`).classList.toggle('hidden', name !== next);
  }
  redraw();
}

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => setView(tab.dataset.view);
  }

  el('table-list').addEventListener('click', (event) => {
    const row = event.target.closest('[data-table]');
    if (!row) return;
    designing = null;
    sheet.showTable(row.dataset.table);
  });

  el('data-grid').addEventListener('click', (event) => {
    const header = event.target.closest('th[data-column]');
    if (header) { sheet.sortBy(header.dataset.column); return; }

    const row = event.target.closest('tr[data-rowid]');
    if (!row) return;
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
    const path = await io.pickToOpen();
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
    if (!control) return;

    if (event.key === 'k') { event.preventDefault(); openPalette(commands()); }
    else if (event.key === 'p') { event.preventDefault(); printData(); }
    else if (event.key === 'z') { event.preventDefault(); el('btn-undo').click(); }
  });
}

function commands() {
  const entry = (label, hint, run) => ({ id: label, label, hint, run });
  return [
    entry('New database', '', () => el('btn-new').click()),
    entry('Open database', '', () => el('btn-open').click()),
    entry('New table', '', () => el('btn-new-table').click()),
    entry('Add row', '', () => addRow()),
    entry('Run query', 'Ctrl+Enter', () => setView('query')),
    entry('Import CSV or a spreadsheet…', '', () => importFile()),
    entry('Export as a spreadsheet or CSV…', '', () => exportData()),
    entry('Print…', 'Ctrl+P', () => printData()),
    entry('Export readable archive', '', () => exportArchive()),
    entry('Import readable archive', '', () => importArchive()),
    entry('Prepare for sharing', '', () => prepareForSharing()),
    entry('Undo', 'Ctrl+Z', () => el('btn-undo').click()),
    entry('Settings', '', () => openSettings()),
  ];
}

export { ON_DELETE };

start();
