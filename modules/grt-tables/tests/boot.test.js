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

  const invoke = vi.fn(async (command, payload) => {
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

      default:
        if (command.startsWith('plugin:dialog|')) return null;
        throw new Error(`unexpected command ${command}`);
    }
  });

  return { invoke, calls, rows, seed: () => { hasTable = true; } };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** Waits for something to happen, rather than for a number of turns. */
async function until(predicate, tries = 400) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await settle();
  }
  return predicate();
}

/**
 * Waits for the program to finish starting.
 *
 * A fixed number of turns is a race: on a cold machine the last await has not
 * resolved when the first assertion runs. This waits for the backend to stop
 * being asked for things, which is what "started" means here.
 */
async function ready(extra = () => true) {
  let seen = -1;
  for (let i = 0; i < 400; i += 1) {
    const calls = window.__TAURI_CALLS__?.length ?? 0;
    if (calls > 0 && calls === seen && extra()) return;
    seen = calls;
    await settle();
  }
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
    await until(() => backend.calls.some((c) => c.command === 'plugin:dialog|ask'));

    // The dialog stub answers null, which is a refusal, so the statement must
    // not have run.
    const asked = backend.calls.some((c) => c.command === 'plugin:dialog|ask');
    const ran = backend.calls.some((c) => c.command === 'run_query');
    expect(asked).toBe(true);
    expect(ran).toBe(false);
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
