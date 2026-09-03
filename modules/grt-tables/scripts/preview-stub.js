// Enough of the backend for the frontend to start in a plain browser.
const rows = new Map();
let nextRowid = 1;
let tables = [{ name: 'contacts', kind: 'table' }];

const info = () => ({
  path: 'preview (nothing is written)',
  readOnly: false,
  inMemory: true,
  tables,
});

for (const [name, note] of [['Ada Lovelace', 'first'], ['Grace Hopper', 'second'],
                            ["O'Brien", 'a name with a quote in it']]) {
  rows.set(nextRowid, { name, note });
  nextRowid += 1;
}

window.__TAURI__ = {
  core: {
    invoke: async (command, payload) => {
      switch (command) {
        case 'runtime_info':
          return { ephemeral: false, version: 'preview', initialFile: null };
        case 'read_settings': return {};
        case 'write_settings': return true;

        case 'create_database': case 'open_database':
        case 'database_info': case 'import_grt': return info();
        case 'unlock_database': return true;
        case 'close_database': return { removed: [] };

        case 'table_schema': return {
          name: 'contacts',
          columns: [
            { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true, default: null },
            { name: 'name', type: 'TEXT', notNull: true, primaryKey: false, default: null },
            { name: 'note', type: 'TEXT', notNull: false, primaryKey: false, default: null },
          ],
          foreignKeys: [], indexes: [], sql: 'CREATE TABLE "contacts" (...)',
        };

        case 'table_page': {
          let entries = [...rows.entries()];
          if (payload.filterValue) {
            const needle = String(payload.filterValue).toLowerCase();
            entries = entries.filter(([, row]) => Object.values(row)
              .some((v) => String(v ?? '').toLowerCase().includes(needle)));
          }
          if (payload.orderBy) {
            entries.sort((a, b) => String(a[1][payload.orderBy] ?? '')
              .localeCompare(String(b[1][payload.orderBy] ?? '')));
            if (payload.descending) entries.reverse();
          }
          const page = entries.slice(payload.offset, payload.offset + payload.limit);
          return {
            columns: ['rowid', 'id', 'name', 'note'],
            rows: page.map(([rowid, row]) => [rowid, rowid, row.name ?? null, row.note ?? null]),
            total: entries.length,
            offset: payload.offset,
            limit: payload.limit,
          };
        }

        case 'insert_row': {
          const rowid = nextRowid;
          nextRowid += 1;
          rows.set(rowid, { ...payload.values });
          return rowid;
        }
        case 'update_row':
          Object.assign(rows.get(payload.rowid) ?? {}, payload.values);
          return 1;
        case 'delete_row': return rows.delete(payload.rowid) ? 1 : 0;

        case 'run_schema': {
          const created = /CREATE TABLE "([^"]+)"/.exec(payload.sql);
          if (created) tables = [...tables, { name: created[1], kind: 'table' }];
          const dropped = /DROP TABLE "([^"]+)"/.exec(payload.sql);
          if (dropped) tables = tables.filter((t) => t.name !== dropped[1]);
          return { ok: true };
        }

        case 'inspect_sql': return {
          writes: !/^\s*select/i.test(payload.sql),
          unbounded: /^\s*delete\b(?![\s\S]*where)/i.test(payload.sql),
        };
        case 'run_query':
          if (/^\s*select/i.test(payload.sql)) {
            return {
              columns: ['id', 'name'],
              rows: [...rows.entries()].map(([id, row]) => [id, row.name]),
              changed: 0,
            };
          }
          return { columns: [], rows: [], changed: 0 };

        case 'undo': return true;
        case 'undo_depth': return 1;
        case 'prepare_for_sharing': return { removed: [] };
        case 'read_file': return new Uint8Array();
        case 'write_file_atomic': case 'export_grt': return undefined;
        case 'file_exists': return false;
        default: return null;
      }
    },
  },
};
