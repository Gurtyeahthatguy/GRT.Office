/** The only bridge between the interface and the filesystem. */

const { invoke } = window.__TAURI__.core;

export const FILTERS = {
  grt: [{ name: 'GRT spreadsheet', extensions: ['grt'] }],
  csv: [{ name: 'Comma-separated values', extensions: ['csv', 'tsv', 'txt'] }],
};

function toPath(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return toPath(result[0]);
  if (typeof result === 'object' && typeof result.path === 'string') return result.path;
  return null;
}

export async function pickToOpen(filters = FILTERS.grt, title = 'Open') {
  return toPath(await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: false, filters },
  }));
}

export async function pickToSave(defaultPath, filters = FILTERS.grt, title = 'Save') {
  return toPath(await invoke('plugin:dialog|save', { options: { title, defaultPath, filters } }));
}

export async function confirm(message, title = 'GRT Grid') {
  try {
    return await invoke('plugin:dialog|ask', { options: { message, title, kind: 'warning' } });
  } catch {
    return false;
  }
}

export async function notify(message, title = 'GRT Grid') {
  try {
    await invoke('plugin:dialog|message', { options: { message, title } });
  } catch { /** a dialog that will not open must not stop the program. */ }
}

export async function readDocument(path) {
  const { parts } = await invoke('read_grt', { path });
  const raw = parts['content/main.json'];
  if (!raw) throw new Error('That file has no spreadsheet in it');
  return JSON.parse(raw);
}

export async function writeDocument(path, document) {
  return invoke('write_grt', {
    path,
    parts: { 'content/main.json': `${JSON.stringify(document, null, 2)}\n` },
  });
}

export async function readText(path) {
  const bytes = new Uint8Array(await invoke('read_file', { path }));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export async function writeText(path, text) {
  await invoke('write_file_atomic', new TextEncoder().encode(text), {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

export async function fileExists(path) {
  return invoke('file_exists', { path });
}

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
