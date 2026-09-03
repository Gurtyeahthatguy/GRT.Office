/** The only bridge between the interface and the backend. */

const { invoke } = window.__TAURI__.core;

export const FILTERS = {
  sqlite: [{ name: 'Database', extensions: ['sqlite', 'db', 'sqlite3'] }],
  grt: [{ name: 'GRT archive', extensions: ['grt'] }],
  csv: [{ name: 'Comma-separated values', extensions: ['csv', 'tsv', 'txt'] }],
};

function toPath(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return toPath(result[0]);
  if (typeof result === 'object' && typeof result.path === 'string') return result.path;
  return null;
}

export async function pickToOpen(filters = FILTERS.sqlite, title = 'Open') {
  return toPath(await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: false, filters },
  }));
}

export async function pickToSave(defaultPath, filters = FILTERS.sqlite, title = 'Save') {
  return toPath(await invoke('plugin:dialog|save', { options: { title, defaultPath, filters } }));
}

export async function confirm(message, title = 'GRT Tables') {
  try {
    return await invoke('plugin:dialog|ask', { options: { message, title, kind: 'warning' } });
  } catch {
    return false;
  }
}

export async function notify(message, title = 'GRT Tables') {
  try {
    await invoke('plugin:dialog|message', { options: { message, title } });
  } catch { /** a dialog that will not open must not stop the program. */ }
}

// The database

export const createDatabase = (path = null) => invoke('create_database', { path });
export const openDatabase = (path) => invoke('open_database', { path });
export const unlockDatabase = () => invoke('unlock_database');
export const closeDatabase = () => invoke('close_database');
export const databaseInfo = () => invoke('database_info');

export const tableSchema = (table) => invoke('table_schema', { table });

export const tablePage = ({
  table, limit, offset, orderBy, descending, filterColumn, filterValue,
}) => invoke('table_page', {
  table, limit, offset, orderBy, descending, filterColumn, filterValue,
});

export const insertRow = (table, values) => invoke('insert_row', { table, values });
export const updateRow = (table, rowid, values) => invoke('update_row', { table, rowid, values });
export const deleteRow = (table, rowid) => invoke('delete_row', { table, rowid });

export const runSchema = (sql) => invoke('run_schema', { sql });
export const inspectSql = (sql) => invoke('inspect_sql', { sql });
export const runQuery = (sql, params = []) => invoke('run_query', { sql, params });

export const undo = () => invoke('undo');
export const undoDepth = () => invoke('undo_depth');
export const prepareForSharing = () => invoke('prepare_for_sharing');

export const exportGrt = (path) => invoke('export_grt', { path });
export const importGrt = (archive, into = null) => invoke('import_grt', { archive, into });

// Files

export async function readText(path) {
  const bytes = new Uint8Array(await invoke('read_file', { path }));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export async function writeText(path, text) {
  await invoke('write_file_atomic', new TextEncoder().encode(text), {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

export const fileExists = (path) => invoke('file_exists', { path });

// Settings and startup

export async function runtimeInfo() {
  try {
    return await invoke('runtime_info');
  } catch {
    return { ephemeral: false, version: '0.0.0', initialFile: null };
  }
}

export async function readSettings() {
  try { return await invoke('read_settings'); } catch { return {}; }
}

export async function writeSettings(settings) {
  try { return await invoke('write_settings', { settings }); } catch { return false; }
}

export function baseName(path) {
  return String(path ?? '').split(/[/\\]/).pop() ?? '';
}

export function withExtension(path, extension) {
  return path.endsWith(`.${extension}`) ? path : `${path}.${extension}`;
}
