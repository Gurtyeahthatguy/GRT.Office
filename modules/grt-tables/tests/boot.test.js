// @vitest-environment jsdom

/** Start the actual program and use it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '..', 'src', 'index.html'), 'utf8');

function installPage() {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(indexHtml)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');
}

/** A backend holding one table in memory. */
function fakeBackend({ readOnly = false } = {}) {
  const rows = new Map();
  let nextRowid = 1;
  let locked = readOnly;
  const calls = [];
  let hasTable = false;

  const info = () => ({
    path: '/tmp/fake.sqlite',
    readOnly: locked,
    inMemory: false,
    tables: hasTable ? [{ name: 'contacts', kind: 'table' }] : [],
  });

  const written = new Map();
  const invoke = vi.fn(async (command, payload, options) => {
    calls.push({ command, payload });
    switch (command) {
      case 'runtime_info': return { ephemeral: false, version: '0.1.0', initialFile: null };
      case 'read_settings': return {};
      case 'write_settings': return true;

      case 'create_database': hasTable = false; locked = readOnly; rows.clear(); return info();
      case 'open_database': locked = true; return info();
      case 'unlock_database': locked = false; return true;
      case 'close_database': return { removed: [] };
      case 'database_info': return info();

      case 'table_schema': return {
        name: 'contacts',
        columns: [
          { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true, default: null },
          { name: 'name', type: 'TEXT', notNull: false, primaryKey: false, default: null },
        ],
        foreignKeys: [], indexes: [], sql: 'CREATE TABLE "contacts" (...)',
      };

      case 'table_page': {
        let entries = [...rows.entries()];
        if (payload.filterValue) {
          entries = entries.filter(([, row]) => String(row.name ?? '')
            .toLowerCase().includes(String(payload.filterValue).toLowerCase()));
        }
        const page = entries.slice(payload.offset, payload.offset + payload.limit);
        return {
          columns: ['rowid', 'id', 'name'],
          rows: page.map(([rowid, row]) => [rowid, rowid, row.name ?? null]),
          total: entries.length,
          offset: payload.offset,
          limit: payload.limit,
        };
      }

      case 'insert_row': {
        if (locked) throw new Error('read only');
        const rowid = nextRowid;
        nextRowid += 1;
        rows.set(rowid, { ...payload.values });
        return rowid;
      }
      case 'update_row':
        if (locked) throw new Error('read only');
        Object.assign(rows.get(payload.rowid) ?? {}, payload.values);
        return 1;
      case 'delete_row':
        if (locked) throw new Error('read only');
        return rows.delete(payload.rowid) ? 1 : 0;

      case 'run_schema':
        if (locked) throw new Error('read only');
        if (/CREATE TABLE/.test(payload.sql)) hasTable = true;
        if (/DROP TABLE/.test(payload.sql)) hasTable = false;
        return { ok: true };

      case 'inspect_sql': return {
        writes: !/^\s*select/i.test(payload.sql),
        unbounded: /^\s*delete\b(?![\s\S]*where)/i.test(payload.sql),
      };
      case 'run_query':
        if (/^\s*select/i.test(payload.sql)) {
          return { columns: ['n'], rows: [[1], [2]], changed: 0 };
        }
        return { columns: [], rows: [], changed: 1 };

      case 'undo': return true;
      case 'undo_depth': return 1;
      case 'prepare_for_sharing': return { removed: [] };
      case 'export_grt': case 'import_grt': return info();
      case 'read_file': return new Uint8Array();
      case 'write_file_atomic': return undefined;
      case 'file_exists': return false;

      case 'read_package': {
        const block = window.__PACKAGES__?.[payload.path];
        if (!block) throw new Error(`No file at ${payload.path}`);
        return block;
      }
      case 'write_package':
        written.set(decodeURIComponent(options.headers['x-grt-path']), payload);
        return undefined;
      case 'print_page': return null;
      case 'plugin:dialog|open': return window.__PICK__?.open ?? null;
      case 'plugin:dialog|save': return window.__PICK__?.save ?? null;
      case 'plugin:dialog|message': return payload.buttons ? (window.__ANSWER__ ?? 'No') : 'Ok';

      default:
        if (command.startsWith('plugin:dialog|')) return null;
        throw new Error(`unexpected command ${command}`);
    }
  });

  return { invoke, calls, rows, written, seed: () => { hasTable = true; } };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** Waits for a condition, bounded by the clock. */
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (let i = 0; Date.now() < deadline; i += 1) {
    if (predicate()) return true;
    await (i % 20 === 19 ? tick() : settle());
  }
  return predicate();
}

/** Waits for the program to finish starting. */
async function ready(extra = () => true) {
  // Startup is several awaits deep before there is anything to look at.
  for (let i = 0; i < 12; i += 1) await (i % 4 === 3 ? tick() : settle());

  let seen = -1;
  return until(() => {
    const calls = window.__TAURI_CALLS__?.length ?? 0;
    const quiet = calls === seen;
    seen = calls;
    return quiet && extra();
  });
}

async function boot(options = {}) {
  vi.resetModules();
  installPage();
  const backend = fakeBackend(options);
  window.__TAURI__ = { core: { invoke: backend.invoke } };
  await import('../src/js/main.js');
  await ready();
  return backend;
}

let backend;

beforeEach(async () => { backend = await boot(); });

describe('the program starts', () => {
  it('asks the backend who it is and opens a database', () => {
    const commands = backend.calls.map((c) => c.command);
    expect(commands).toContain('runtime_info');
    expect(commands).toContain('create_database');
  });

  it('shows its version', () => {
    expect(document.getElementById('version').textContent).toBe('0.1.0');
  });

  it('says there are no tables yet', () => {
    expect(document.getElementById('table-list').textContent).toContain('No tables');
  });

  it('starts on the data tab', () => {
    expect(document.querySelector('.tab.active').dataset.view).toBe('data');
  });
});

describe('the designer', () => {
  it('shows the statement before anything runs', async () => {
    document.getElementById('btn-new-table').click();
    await settle();

    expect(document.querySelector('.tab.active').dataset.view).toBe('design');
    expect(document.getElementById('design-sql').textContent).toContain('CREATE TABLE');
  });

  it('updates the statement as the design changes', async () => {
    document.getElementById('btn-new-table').click();
    await settle();

    const name = document.querySelector('#design-panel input[type="text"]');
    name.value = 'contacts';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();

    expect(document.getElementById('design-sql').textContent).toContain('"contacts"');
  });

  it('CANARY: the statement does not already say contacts', async () => {
    document.getElementById('btn-new-table').click();
    await settle();
    expect(document.getElementById('design-sql').textContent).not.toContain('"contacts"');
  });
});

describe('the data grid', () => {
  beforeEach(async () => {
    backend.seed();
    document.querySelector('.tab[data-view="data"]').click();
    await settle();
    // Re-read the schema now that a table exists.
    await backend.invoke('database_info');
    document.getElementById('btn-new-table').click();
    await settle();
    document.querySelector('.tab[data-view="data"]').click();
    await settle();
  });

  it('says an empty table is empty', () => {
    expect(document.getElementById('data-grid').textContent).toMatch(/empty|No table/);
  });

  it('a second click on a row opens it, which is how a double-click arrives after the redraw', async () => {
    document.getElementById('btn-new-table').click();
    await settle();
    const name = document.querySelector('#design-panel input[placeholder="Table name"]');
    name.value = 'contacts';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    [...document.querySelectorAll('#design-panel button')].find((b) => b.textContent === 'Create table').click();
    await until(() => document.querySelector('#table-list [data-table="contacts"]'));
    await backend.invoke('insert_row', { table: 'contacts', values: { name: 'Ada' } });
    document.querySelector('#table-list [data-table="contacts"]').click();
    await until(() => document.querySelector('#data-grid tr[data-rowid="1"]'));

    for (const detail of [1, 2]) {
      document.querySelector('#data-grid tr[data-rowid="1"] td')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));
      await settle();
    }

    await until(() => /Row 1/.test(document.getElementById('panel-title').textContent));
    expect(document.querySelector('#panel-body [data-field="name"]').value).toBe('Ada');
  });
});

describe('a database that was opened rather than created', () => {
  it('shows the read-only bar and disables what would change it', async () => {
    backend = await boot({ readOnly: true });
    expect(document.getElementById('readonly-bar').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('btn-add-row').disabled).toBe(true);
    expect(document.getElementById('btn-new-table').disabled).toBe(true);
  });

  it('CANARY: an ordinary database shows no bar and enables them', () => {
    expect(document.getElementById('readonly-bar').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('btn-add-row').disabled).toBe(false);
  });
});

describe('the query editor', () => {
  it('runs a SELECT and shows the rows', async () => {
    document.querySelector('.tab[data-view="query"]').click();
    await settle();

    document.getElementById('query-input').value = 'SELECT n FROM t';
    document.getElementById('btn-run-query').click();
    await until(() => document.getElementById('query-result').textContent.includes('1'));

    expect(document.getElementById('query-result').textContent).toContain('1');
    expect(document.getElementById('query-note').textContent).toContain('2 row');
  });

  it('runs on Ctrl+Enter as well as the button', async () => {
    document.querySelector('.tab[data-view="query"]').click();
    await settle();

    const input = document.getElementById('query-input');
    input.value = 'SELECT n FROM t';
    input.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await until(() => document.getElementById('query-result').textContent.includes('1'));

    expect(document.getElementById('query-result').textContent).toContain('1');
  });

  it('asks before running a statement with no WHERE clause', async () => {
    document.querySelector('.tab[data-view="query"]').click();
    await settle();

    document.getElementById('query-input').value = 'DELETE FROM contacts';
    document.getElementById('btn-run-query').click();
    const asking = (c) => c.command === 'plugin:dialog|message' && c.payload?.buttons === 'YesNo';
    await until(() => backend.calls.some(asking));

    // The dialog stub answers No, so the statement must not have run.
    const asked = backend.calls.some(asking);
    const ran = backend.calls.some((c) => c.command === 'run_query');
    expect(asked).toBe(true);
    expect(ran).toBe(false);
  });

  it('runs it once the answer is Yes', async () => {
    window.__ANSWER__ = 'Yes';
    try {
      document.querySelector('.tab[data-view="query"]').click();
      await settle();
      document.getElementById('query-input').value = 'DELETE FROM contacts';
      document.getElementById('btn-run-query').click();
      await until(() => backend.calls.some((c) => c.command === 'run_query'));
      expect(backend.calls.some((c) => c.command === 'run_query')).toBe(true);
    } finally {
      delete window.__ANSWER__;
    }
  });

  it('CANARY: a SELECT is not asked about, it just runs', async () => {
    document.querySelector('.tab[data-view="query"]').click();
    await settle();

    document.getElementById('query-input').value = 'SELECT n FROM t';
    document.getElementById('btn-run-query').click();
    await until(() => backend.calls.some((c) => c.command === 'run_query'));

    expect(backend.calls.some((c) => c.command === 'run_query')).toBe(true);
  });
});

describe('the tabs', () => {
  it('switch what is shown', async () => {
    for (const name of ['design', 'query', 'data']) {
      document.querySelector(`.tab[data-view="${name}"]`).click();
      await settle();
      expect(document.getElementById(`view-${name}`).classList.contains('hidden')).toBe(false);
    }
  });
});

describe('spreadsheets and printing', () => {
  const dialogOpen = () => !document.getElementById('overlay').classList.contains('hidden');
  const preview = () => document.getElementById('print-view');

  it('imports a workbook’s sheet as a table, exports the table, and prints it', async () => {
    const { writeXlsx } = await import('../src/js/core/formats/xlsx.js');
    const { encodeBlock, decodeBlock } = await import('../src/js/core/package.js');
    const { readOds } = await import('../src/js/core/formats/ods.js');
    const workbook = {
      sheets: [
        { name: 'People', cells: { '0,0': { v: 'Name' }, '0,1': { v: 'Born' }, '1,0': { v: 'Ada' }, '1,1': { v: 46312, s: 'd' }, '2,0': { v: 'Grace' }, '2,1': { v: 46313, s: 'd' } } },
        { name: 'Empty', cells: {} },
      ],
      styles: { d: { format: 'yyyy-mm-dd' } },
    };
    window.__PACKAGES__ = { '/tmp/people.xlsx': encodeBlock(writeXlsx(workbook).entries) };
    window.__PICK__ = { open: '/tmp/people.xlsx' };
    document.getElementById('btn-import-csv').click();
    await until(dialogOpen);
    expect(document.getElementById('panel-title').textContent).toContain('People');
    expect(document.querySelector('[data-field="type_1"]').value).toBe('DATE');
    document.getElementById('panel-confirm').click();
    await until(() => backend.calls.filter((c) => c.command === 'insert_row').length === 2);
    expect(backend.calls.find((c) => c.command === 'run_schema').payload.sql).toContain('CREATE TABLE "People"');
    expect(backend.calls.filter((c) => c.command === 'insert_row').map((c) => c.payload.values))
      .toEqual([{ Name: 'Ada', Born: '2026-10-17' }, { Name: 'Grace', Born: '2026-10-18' }]);
    await until(() => !dialogOpen() || document.getElementById('panel-title').textContent === 'Imported');
    if (dialogOpen()) document.getElementById('panel-confirm').click();
    await until(() => !dialogOpen());

    window.__PICK__ = { save: '/tmp/out.ods' };
    document.getElementById('btn-export-csv').click();
    await until(dialogOpen);
    document.querySelector('[data-field="format"]').value = 'ods';
    document.getElementById('panel-confirm').click();
    await until(() => backend.written.has('/tmp/out.ods'));
    const exported = readOds(decodeBlock(backend.written.get('/tmp/out.ods'))).document;
    expect(exported.sheets[0].cells['0,1'].v).toBe('name');
    expect([exported.sheets[0].cells['1,0'].v, exported.sheets[0].cells['2,0'].v]).toEqual([1, 2]);
    await until(() => dialogOpen());
    document.getElementById('panel-confirm').click();
    await until(() => !dialogOpen());

    document.getElementById('btn-print').click();
    await until(() => preview()?.querySelector('.print-page'));
    expect([...preview().querySelectorAll('.print-table th')].map((th) => th.textContent)).toEqual(['id', 'name']);
    expect(preview().querySelectorAll('.print-table tbody tr')).toHaveLength(2);
    preview().querySelector('[data-print="go"]').click();
    await until(() => backend.calls.some((c) => c.command === 'print_page'));
    expect(backend.calls.find((c) => c.command === 'print_page').payload).toEqual({ width: 210, height: 297 });
  });
});
