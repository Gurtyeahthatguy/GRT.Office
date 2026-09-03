/** What the program is doing, between the window and the engine. */

import { parseCsv, sniff, coerce, toCsv } from './core/csv.js';
import { inferSchema, createTableSql, quoteIdent } from './schema.js';

export const PAGE_SIZE = 100;

export class TablesController {
  /**
   * @param {Object} backend the io module, or a fake
   * @param {{onChange?: Function}} options
   */
  constructor(backend, options = {}) {
    this.backend = backend;
    this.onChange = options.onChange ?? (() => {});

    this.database = null;      // { path, readOnly, tables, inMemory }.
    this.table = null;         // the table being looked at.
    this.schema = null;        // its columns, keys and indexes.
    this.page = null;          // { columns, rows, total, offset, limit }.

    this.offset = 0;
    this.orderBy = null;
    this.descending = false;
    this.filterColumn = null;
    this.filterValue = '';

    this.selectedRow = null;   // rowid.
    this.queryResult = null;   // the result of a hand-written query.
    this.lastError = null;
  }

  get readOnly() {
    return this.database?.readOnly !== false;
  }

  get tables() {
    return this.database?.tables ?? [];
  }

  // Opening

  async createDatabase(path = null) {
    this.database = await this.backend.createDatabase(path);
    await this.afterSchemaChange();
    return this.database;
  }

  /**
   * Opens a file. It arrives read-only, and stays that way until the
   * interface asks the user and calls `unlock`.
   */
  async openDatabase(path) {
    this.database = await this.backend.openDatabase(path);
    await this.afterSchemaChange();
    return this.database;
  }

  async unlock() {
    await this.backend.unlockDatabase();
    if (this.database) this.database.readOnly = false;
    this.onChange({ database: true });
    return true;
  }

  async close() {
    const result = await this.backend.closeDatabase();
    this.database = null;
    this.table = null;
    this.schema = null;
    this.page = null;
    this.onChange({ database: true });
    return result;
  }

  /** Re-reads the table list and reopens whatever was being looked at. */
  async afterSchemaChange() {
    this.database = await this.backend.databaseInfo();

    const names = this.tables.map((entry) => entry.name);
    if (this.table && !names.includes(this.table)) this.table = null;
    if (!this.table) this.table = names[0] ?? null;

    if (this.table) await this.showTable(this.table);
    else {
      this.schema = null;
      this.page = null;
      this.onChange({ database: true });
    }
  }

  // Looking at a table

  async showTable(name) {
    this.table = name;
    this.offset = 0;
    this.orderBy = null;
    this.descending = false;
    this.filterColumn = null;
    this.filterValue = '';
    this.selectedRow = null;

    this.schema = await this.backend.tableSchema(name);
    await this.loadPage();
  }

  /** Fetches the current page. */
  async loadPage() {
    if (!this.table) return null;

    this.page = await this.backend.tablePage({
      table: this.table,
      limit: PAGE_SIZE,
      offset: this.offset,
      orderBy: this.orderBy,
      descending: this.descending,
      filterColumn: this.filterColumn,
      filterValue: this.filterValue || null,
    });

    this.onChange({ page: true });
    return this.page;
  }

  get pageCount() {
    if (!this.page) return 0;
    return Math.max(1, Math.ceil(this.page.total / PAGE_SIZE));
  }

  get pageNumber() {
    return Math.floor(this.offset / PAGE_SIZE) + 1;
  }

  async goToPage(number) {
    const wanted = Math.min(Math.max(1, number), this.pageCount);
    this.offset = (wanted - 1) * PAGE_SIZE;
    return this.loadPage();
  }

  async nextPage() { return this.goToPage(this.pageNumber + 1); }
  async previousPage() { return this.goToPage(this.pageNumber - 1); }

  /** Sorts by a column, reversing if it is already the sort column. */
  async sortBy(column) {
    if (this.orderBy === column) this.descending = !this.descending;
    else { this.orderBy = column; this.descending = false; }
    this.offset = 0;
    return this.loadPage();
  }

  async filter(column, value) {
    this.filterColumn = column;
    this.filterValue = value ?? '';
    this.offset = 0;
    return this.loadPage();
  }

  /** The column names of the current page, without the rowid this adds. */
  get displayColumns() {
    return (this.page?.columns ?? []).slice(1);
  }

  /** One row as an object, keyed by column name. */
  rowAt(index) {
    const row = this.page?.rows?.[index];
    if (!row) return null;

    const record = { rowid: row[0] };
    this.displayColumns.forEach((name, i) => { record[name] = row[i + 1]; });
    return record;
  }

  // Changing rows

  async addRow(values) {
    this.requireWritable();
    const rowid = await this.backend.insertRow(this.table, values);
    await this.loadPage();
    this.onChange({ edited: true });
    return rowid;
  }

  async changeRow(rowid, values) {
    this.requireWritable();
    const changed = await this.backend.updateRow(this.table, rowid, values);
    await this.loadPage();
    this.onChange({ edited: true });
    return changed;
  }

  async removeRow(rowid) {
    this.requireWritable();
    const removed = await this.backend.deleteRow(this.table, rowid);
    await this.loadPage();
    this.onChange({ edited: true });
    return removed;
  }

  requireWritable() {
    if (this.readOnly) {
      throw new Error('This database is open for reading only. Unlock it first.');
    }
  }

  // The designer

  /** Creates a table from what the designer built. */
  async createTable(table) {
    this.requireWritable();
    const { sql, problems } = createTableSql(table);
    if (problems.length > 0) return { sql, problems, ran: false };

    await this.backend.runSchema(sql);
    await this.afterSchemaChange();
    await this.showTable(table.name);
    return { sql, problems: [], ran: true };
  }

  async runSchema(sql) {
    this.requireWritable();
    await this.backend.runSchema(sql);
    await this.afterSchemaChange();
    return true;
  }

  async dropTable(name) {
    this.requireWritable();
    await this.backend.runSchema(`DROP TABLE ${quoteIdent(name)};`);
    if (this.table === name) this.table = null;
    await this.afterSchemaChange();
    return true;
  }

  // Queries

  /** What a statement would do, before it does it. */
  async inspect(sql) {
    return this.backend.inspectSql(sql);
  }

  async runQuery(sql, params = []) {
    this.lastError = null;
    try {
      this.queryResult = await this.backend.runQuery(sql, params);
      if (this.queryResult.changed > 0) await this.afterSchemaChange();
      this.onChange({ query: true });
      return this.queryResult;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.queryResult = null;
      this.onChange({ query: true });
      return null;
    }
  }

  // Undo

  /** Undoes the last change. */
  async undo() {
    this.requireWritable();
    const undone = await this.backend.undo();
    if (undone) await this.afterSchemaChange();
    return undone;
  }

  async undoDepth() {
    return this.backend.undoDepth();
  }

  // Sharing

  async prepareForSharing() {
    this.requireWritable();
    return this.backend.prepareForSharing();
  }

  // CSV

  /** Reads a CSV file and proposes what to do with it. */
  planCsvImport(text, { tableName = null, separator = null } = {}) {
    const guess = sniff(text);
    const chosen = separator ?? guess.separator;
    const rows = parseCsv(text, { separator: chosen });
    const { header, columns } = inferSchema(rows);

    return {
      separator: chosen,
      decimal: guess.decimal,
      confident: guess.confident,
      reason: guess.reason,
      header,
      columns,
      rowCount: Math.max(0, rows.length - (header ? 1 : 0)),
      table: { name: tableName ?? 'imported', columns },
      rows,
    };
  }

  /** Carries out a plan the user has confirmed. */
  async importCsv(plan) {
    this.requireWritable();

    const created = await this.createTable(plan.table);
    if (!created.ran) return { ...created, imported: 0 };

    const names = plan.table.columns.map((column) => column.name);
    const body = plan.header ? plan.rows.slice(1) : plan.rows;

    let imported = 0;
    for (const row of body) {
      const values = {};
      names.forEach((name, index) => {
        const raw = row[index];
        if (raw === undefined || raw === '') return;
        const type = plan.table.columns[index].type;
        values[name] = type === 'TEXT' || type === 'DATE' || type === 'TIME'
          ? String(raw)
          : coerce(raw, { decimal: plan.decimal });
      });
      if (Object.keys(values).length === 0) continue;
      await this.backend.insertRow(plan.table.name, values);
      imported += 1;
    }

    await this.showTable(plan.table.name);
    return { ...created, imported };
  }

  /** The current table, or the last query's result, as CSV. */
  async exportCsv({ fromQuery = false, separator = ',' } = {}) {
    if (fromQuery && this.queryResult) {
      return toCsv([this.queryResult.columns, ...this.queryResult.rows], { separator });
    }

    if (!this.table) return '';

    // Read it a page at a time, for the same reason the grid does.
    const rows = [];
    let offset = 0;
    let columns = null;

    for (;;) {
      const page = await this.backend.tablePage({
        table: this.table,
        limit: 500,
        offset,
        orderBy: this.orderBy,
        descending: this.descending,
        filterColumn: this.filterColumn,
        filterValue: this.filterValue || null,
      });

      columns ??= page.columns.slice(1);
      for (const row of page.rows) rows.push(row.slice(1));

      offset += page.rows.length;
      if (page.rows.length === 0 || offset >= page.total) break;
    }

    return toCsv([columns ?? [], ...rows], { separator });
  }

  // The readable archive

  async exportArchive(path) {
    return this.backend.exportGrt(path);
  }

  async importArchive(archive, into = null) {
    this.database = await this.backend.importGrt(archive, into);
    await this.afterSchemaChange();
    return this.database;
  }
}
