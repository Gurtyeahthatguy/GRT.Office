/** What the program does, driven against a fake database. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TablesController, PAGE_SIZE } from '../src/js/controller.js';

/** A backend that keeps tables in memory and records what it was asked. */
function fakeBackend() {
  const tables = new Map();      // name → { columns, rows: Map<rowid, object> }.
  const calls = [];
  let readOnly = false;
  let nextRowid = 1;
  let undoDepth = 0;

  const info = () => ({
    path: '/tmp/fake.sqlite',
    readOnly,
    inMemory: false,
    tables: [...tables.keys()].sort().map((name) => ({ name, kind: 'table' })),
  });

  const backend = {
    tables,
    calls,
    setReadOnly: (value) => { readOnly = value; },

    createDatabase: async () => { tables.clear(); readOnly = false; return info(); },
    openDatabase: async () => { readOnly = true; return info(); },
    unlockDatabase: async () => { readOnly = false; return true; },
    closeDatabase: async () => ({ removed: [] }),
    databaseInfo: async () => info(),

    tableSchema: async (name) => ({
      name,
      columns: (tables.get(name)?.columns ?? []).map((column) => ({
        name: column.name,
        type: column.type,
        notNull: Boolean(column.notNull),
        primaryKey: column.name === 'id',
        default: null,
      })),
      foreignKeys: [],
      indexes: [],
      sql: `CREATE TABLE "${name}" (...)`,
    }),

    tablePage: async (request) => {
      calls.push({ command: 'tablePage', request });
      const held = tables.get(request.table);
      if (!held) throw new Error(`no table ${request.table}`);

      const names = held.columns.map((c) => c.name);
      let entries = [...held.rows.entries()];

      if (request.filterColumn && request.filterValue) {
        const needle = String(request.filterValue).toLowerCase();
        entries = entries.filter(([, row]) => String(row[request.filterColumn] ?? '')
          .toLowerCase().includes(needle));
      }

      if (request.orderBy) {
        entries.sort((a, b) => String(a[1][request.orderBy] ?? '')
          .localeCompare(String(b[1][request.orderBy] ?? '')));
        if (request.descending) entries.reverse();
      }

      const total = entries.length;
      const page = entries.slice(request.offset, request.offset + request.limit);

      return {
        columns: ['rowid', ...names],
        rows: page.map(([rowid, row]) => [rowid, ...names.map((n) => row[n] ?? null)]),
        total,
        offset: request.offset,
        limit: request.limit,
      };
    },

    insertRow: async (table, values) => {
      if (readOnly) throw new Error('read only');
      const held = tables.get(table);
      const rowid = nextRowid;
      nextRowid += 1;
      held.rows.set(rowid, { ...values });
      undoDepth += 1;
      return rowid;
    },

    updateRow: async (table, rowid, values) => {
      if (readOnly) throw new Error('read only');
      const held = tables.get(table);
      const row = held.rows.get(rowid);
      if (!row) return 0;
      Object.assign(row, values);
      undoDepth += 1;
      return 1;
    },

    deleteRow: async (table, rowid) => {
      if (readOnly) throw new Error('read only');
      undoDepth += 1;
      return tables.get(table).rows.delete(rowid) ? 1 : 0;
    },

    runSchema: async (sql) => {
      calls.push({ command: 'runSchema', sql });
      if (readOnly) throw new Error('read only');

      const create = /CREATE TABLE "([^"]+)"\s*\(([\s\S]*)\)/.exec(sql);
      if (create) {
        const columns = create[2]
          .split(',\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('"'))
          .map((line) => {
            const [, name, type] = /^"([^"]+)"\s+(\w+)/.exec(line) ?? [];
            return { name, type: type ?? 'TEXT' };
          })
          .filter((column) => column.name);
        tables.set(create[1], { columns, rows: new Map() });
        undoDepth += 1;
        return { ok: true };
      }

      const drop = /DROP TABLE "([^"]+)"/.exec(sql);
      if (drop) { tables.delete(drop[1]); undoDepth += 1; return { ok: true }; }

      return { ok: true };
    },

    inspectSql: async (sql) => ({
      writes: !/^\s*(select|with)/i.test(sql),
      unbounded: /^\s*(delete|update)\b(?![\s\S]*\bwhere\b)/i.test(sql) || /^\s*drop\b/i.test(sql),
    }),

    runQuery: async (sql) => {
      calls.push({ command: 'runQuery', sql });
      if (/fail/i.test(sql)) throw new Error('no such table: fail');
      if (/^\s*select/i.test(sql)) {
        return { columns: ['a', 'b'], rows: [[1, 'x'], [2, 'y']], changed: 0 };
      }
      undoDepth += 1;
      return { columns: [], rows: [], changed: 3 };
    },

    undo: async () => { if (undoDepth === 0) return false; undoDepth -= 1; return true; },
    undoDepth: async () => undoDepth,
    prepareForSharing: async () => ({ removed: ['/tmp/fake.sqlite-wal'] }),
    exportGrt: vi.fn(async () => undefined),
    importGrt: vi.fn(async () => info()),
  };

  return backend;
}

let backend;
let sheet;

async function withTable(name = 'contacts', rows = []) {
  await sheet.createTable({
    name,
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true },
      { name: 'name', type: 'TEXT' },
      { name: 'age', type: 'INTEGER' },
    ],
  });
  for (const row of rows) await sheet.addRow(row);
}

beforeEach(async () => {
  backend = fakeBackend();
  sheet = new TablesController(backend);
  await sheet.createDatabase(null);
});

describe('opening', () => {
  it('starts with a database and no tables', () => {
    expect(sheet.database).toBeTruthy();
    expect(sheet.tables).toEqual([]);
  });

  /**
   * opening someone else's file is the riskiest thing this module does.
   */
  it('opens an existing database read-only', async () => {
    await sheet.openDatabase('/tmp/theirs.sqlite');
    expect(sheet.readOnly).toBe(true);
  });

  it('refuses to change anything until it is unlocked', async () => {
    await sheet.openDatabase('/tmp/theirs.sqlite');
    expect(() => sheet.requireWritable()).toThrow(/reading only/);
  });

  it('allows changes once unlocked', async () => {
    await sheet.openDatabase('/tmp/theirs.sqlite');
    await sheet.unlock();
    expect(sheet.readOnly).toBe(false);
    expect(() => sheet.requireWritable()).not.toThrow();
  });

  it('CANARY: a database it created is writable from the start', () => {
    expect(sheet.readOnly).toBe(false);
  });
});

describe('tables', () => {
  it('creates one from the designer and shows it', async () => {
    await withTable();
    expect(sheet.tables.map((t) => t.name)).toEqual(['contacts']);
    expect(sheet.table).toBe('contacts');
    expect(sheet.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'age']);
  });

  it('refuses a design that would not work, without running anything', async () => {
    const before = backend.calls.filter((c) => c.command === 'runSchema').length;
    const result = await sheet.createTable({ name: '', columns: [] });

    expect(result.ran).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(backend.calls.filter((c) => c.command === 'runSchema')).toHaveLength(before);
  });

  it('returns the statement it ran, so the interface can show it', async () => {
    const result = await sheet.createTable({
      name: 'x', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }],
    });
    expect(result.sql).toContain('CREATE TABLE "x"');
    expect(result.ran).toBe(true);
  });

  it('drops one and moves to whatever is left', async () => {
    await withTable('a');
    await withTable('b');
    await sheet.dropTable('b');

    expect(sheet.tables.map((t) => t.name)).toEqual(['a']);
    expect(sheet.table).toBe('a');
  });
});

describe('paging', () => {
  beforeEach(async () => {
    await withTable('people');
    for (let i = 0; i < 250; i += 1) {
      await backend.insertRow('people', { name: `person ${i}`, age: i });
    }
    await sheet.loadPage();
  });

  /** the limit and the offset are in the query, not in the interface. */
  it('asks the backend for one page, not for the table', () => {
    const request = backend.calls.filter((c) => c.command === 'tablePage').pop().request;
    expect(request.limit).toBe(PAGE_SIZE);
    expect(request.offset).toBe(0);
  });

  it('never receives more rows than a page', () => {
    expect(sheet.page.rows.length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(sheet.page.total).toBe(250);
  });

  it('counts the pages', () => {
    expect(sheet.pageCount).toBe(3);
    expect(sheet.pageNumber).toBe(1);
  });

  it('moves between them', async () => {
    await sheet.nextPage();
    expect(sheet.pageNumber).toBe(2);
    expect(sheet.offset).toBe(PAGE_SIZE);

    await sheet.previousPage();
    expect(sheet.pageNumber).toBe(1);
  });

  it('does not walk off either end', async () => {
    await sheet.goToPage(99);
    expect(sheet.pageNumber).toBe(3);
    await sheet.goToPage(-5);
    expect(sheet.pageNumber).toBe(1);
  });

  it('goes back to the first page when the sort changes', async () => {
    await sheet.nextPage();
    await sheet.sortBy('name');
    expect(sheet.offset).toBe(0);
  });

  it('reverses the sort when the same column is chosen again', async () => {
    await sheet.sortBy('name');
    expect(sheet.descending).toBe(false);
    await sheet.sortBy('name');
    expect(sheet.descending).toBe(true);
  });

  it('sends the filter as data, not as SQL', async () => {
    await sheet.filter('name', "'; DROP TABLE people; --");
    const request = backend.calls.filter((c) => c.command === 'tablePage').pop().request;
    expect(request.filterValue).toBe("'; DROP TABLE people; --");
    expect(request.filterColumn).toBe('name');
    expect(sheet.tables.map((t) => t.name)).toContain('people');
  });

  it('hides the rowid from the columns it shows', () => {
    expect(sheet.page.columns[0]).toBe('rowid');
    expect(sheet.displayColumns).toEqual(['id', 'name', 'age']);
  });

  it('reads a row back as an object', () => {
    const row = sheet.rowAt(0);
    expect(row.name).toBe('person 0');
    expect(typeof row.rowid).toBe('number');
  });
});

describe('rows', () => {
  beforeEach(async () => { await withTable(); });

  it('adds one and shows it', async () => {
    await sheet.addRow({ name: 'Ada', age: 36 });
    expect(sheet.page.total).toBe(1);
    expect(sheet.rowAt(0).name).toBe('Ada');
  });

  it('changes one', async () => {
    const rowid = await sheet.addRow({ name: 'Ada' });
    await sheet.changeRow(rowid, { name: 'Ada Lovelace' });
    expect(sheet.rowAt(0).name).toBe('Ada Lovelace');
  });

  it('removes one', async () => {
    const rowid = await sheet.addRow({ name: 'Ada' });
    await sheet.removeRow(rowid);
    expect(sheet.page.total).toBe(0);
  });

  it('refuses every change while the database is read-only', async () => {
    backend.setReadOnly(true);
    await sheet.afterSchemaChange();

    await expect(sheet.addRow({ name: 'x' })).rejects.toThrow(/reading only/);
    await expect(sheet.changeRow(1, { name: 'x' })).rejects.toThrow(/reading only/);
    await expect(sheet.removeRow(1)).rejects.toThrow(/reading only/);
  });
});

describe('queries', () => {
  it('returns rows for a SELECT', async () => {
    const result = await sheet.runQuery('SELECT a, b FROM t');
    expect(result.columns).toEqual(['a', 'b']);
    expect(result.rows).toHaveLength(2);
  });

  it('reports how many rows a write changed', async () => {
    const result = await sheet.runQuery('UPDATE t SET a = 1 WHERE b = 2');
    expect(result.changed).toBe(3);
  });

  it('keeps the error rather than throwing it at the interface', async () => {
    const result = await sheet.runQuery('SELECT * FROM fail');
    expect(result).toBeNull();
    expect(sheet.lastError).toContain('no such table');
  });

  /** a statement that would change everything is reported first. */
  it('says when a statement has no WHERE clause', async () => {
    expect(await sheet.inspect('DELETE FROM t')).toEqual({ writes: true, unbounded: true });
    expect(await sheet.inspect('DELETE FROM t WHERE id = 1'))
      .toEqual({ writes: true, unbounded: false });
    expect(await sheet.inspect('SELECT * FROM t')).toEqual({ writes: false, unbounded: false });
  });

  it('says when a statement drops something', async () => {
    expect((await sheet.inspect('DROP TABLE t')).unbounded).toBe(true);
  });
});

describe('undo', () => {
  it('undoes the last change', async () => {
    await withTable();
    expect(await sheet.undoDepth()).toBeGreaterThan(0);
    expect(await sheet.undo()).toBe(true);
  });

  it('does nothing when there is nothing to undo', async () => {
    expect(await sheet.undo()).toBe(false);
  });

  it('is refused on a read-only database', async () => {
    backend.setReadOnly(true);
    await sheet.afterSchemaChange();
    await expect(sheet.undo()).rejects.toThrow(/reading only/);
  });
});

// A CSV import proposes, and waits

describe('planning a CSV import', () => {
  const file = 'name,age,joined\nAda,36,1815-12-10\nGrace,85,1906-12-09\n';

  it('proposes a table without creating anything', () => {
    const before = backend.calls.filter((c) => c.command === 'runSchema').length;
    const plan = sheet.planCsvImport(file);

    expect(plan.table.columns.map((c) => c.name)).toEqual(['name', 'age', 'joined']);
    expect(plan.table.columns.map((c) => c.type)).toEqual(['TEXT', 'INTEGER', 'DATE']);
    expect(backend.calls.filter((c) => c.command === 'runSchema')).toHaveLength(before);
  });

  it('reports what it worked out about the punctuation', () => {
    const plan = sheet.planCsvImport(file);
    expect(plan.separator).toBe(',');
    expect(plan.confident).toBe(true);
    expect(plan.reason).toContain('Separator');
  });

  it('notices a semicolon file and its comma decimals', () => {
    const plan = sheet.planCsvImport('a;b\n1,5;2,5\n');
    expect(plan.separator).toBe(';');
    expect(plan.decimal).toBe(',');
  });

  it('counts the rows without the header', () => {
    expect(sheet.planCsvImport(file).rowCount).toBe(2);
  });

  it('carries out a plan once it is confirmed', async () => {
    const plan = sheet.planCsvImport(file, { tableName: 'people' });
    const result = await sheet.importCsv(plan);

    expect(result.ran).toBe(true);
    expect(result.imported).toBe(2);
    expect(sheet.table).toBe('people');
    expect(sheet.page.total).toBe(2);
  });

  it('honours a type the user corrected', async () => {
    const plan = sheet.planCsvImport(file, { tableName: 'people' });
    plan.table.columns[1].type = 'TEXT';

    await sheet.importCsv(plan);
    expect(sheet.schema.columns[1].type).toBe('TEXT');
  });

  it('is refused on a read-only database', async () => {
    backend.setReadOnly(true);
    await sheet.afterSchemaChange();
    await expect(sheet.importCsv(sheet.planCsvImport(file))).rejects.toThrow(/reading only/);
  });
});

describe('exporting', () => {
  it('writes the table as CSV, a page at a time', async () => {
    await withTable('people');
    for (let i = 0; i < 120; i += 1) await backend.insertRow('people', { name: `p${i}` });
    await sheet.loadPage();

    const csv = await sheet.exportCsv();
    const lines = csv.trim().split('\r\n');

    expect(lines[0]).toBe('id,name,age');
    expect(lines).toHaveLength(121);
  });

  it('writes a query result when asked for one', async () => {
    await sheet.runQuery('SELECT a, b FROM t');
    const csv = await sheet.exportCsv({ fromQuery: true });
    expect(csv).toContain('a,b');
    expect(csv).toContain('1,x');
  });

  it('hands the archive off to the backend', async () => {
    await sheet.exportArchive('/tmp/out.grt');
    expect(backend.exportGrt).toHaveBeenCalledWith('/tmp/out.grt');
  });
});

describe('preparing to share', () => {
  it('reports what was removed from beside the database', async () => {
    const result = await sheet.prepareForSharing();
    expect(result.removed).toContain('/tmp/fake.sqlite-wal');
  });

  it('is refused on a read-only database', async () => {
    backend.setReadOnly(true);
    await sheet.afterSchemaChange();
    await expect(sheet.prepareForSharing()).rejects.toThrow(/reading only/);
  });
});
