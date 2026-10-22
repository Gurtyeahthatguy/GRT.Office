/** The only bridge between the interface and the filesystem. */

import { fromParts, toParts, fromMarkdown, toMarkdown } from './note.js';

const { invoke } = window.__TAURI__.core;

export const FILTERS = {
  grt: [{ name: 'GRT note', extensions: ['grt'] }],
  md: [{ name: 'Markdown', extensions: ['md'] }],
};

function toPath(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return toPath(result[0]);
  if (typeof result === 'object' && typeof result.path === 'string') return result.path;
  return null;
}

export async function pickToOpen(title = 'Open note') {
  return toPath(await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: false, filters: FILTERS.grt },
  }));
}

export async function pickToSave(defaultPath, filters = FILTERS.md, title = 'Export') {
  return toPath(await invoke('plugin:dialog|save', { options: { title, defaultPath, filters } }));
}

export async function pickDirectory(title = 'Choose the archive folder') {
  return toPath(await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: true },
  }));
}

export async function confirm(message, title = 'GRT Notes') {
  try {
    return await invoke('plugin:dialog|message', { message, title, kind: 'warning', buttons: 'YesNo' }) === 'Yes';
  } catch {
    return false;
  }
}

export async function notify(message, title = 'GRT Notes') {
  try {
    await invoke('plugin:dialog|message', { message, title });
  } catch {
    // A dialog that will not open must not stop the program.
  }
}

// The archive

export async function readArchive(root = null) {
  return invoke('read_archive', { root });
}

export async function createFolder(path) {
  return invoke('create_folder', { path });
}

export async function renameEntry(from, to) {
  return invoke('rename_entry', { from, to });
}

export async function deleteEntry(path) {
  return invoke('delete_entry', { path });
}

// Notes

const isMarkdown = (path) => /\.md$/i.test(path);
const stem = (path) => String(path).split(/[/\\]/).pop().replace(/\.md$/i, '');

export async function readNote(path) {
  if (isMarkdown(path)) return fromMarkdown(await readText(path), stem(path));
  const { parts } = await invoke('read_grt', { path });
  return fromParts(parts);
}

export async function writeNote(path, note) {
  if (isMarkdown(path)) return writeText(path, toMarkdown(note));
  return invoke('write_grt', { path, parts: toParts(note) });
}

export async function readText(path) {
  const bytes = new Uint8Array(await invoke('read_file', { path }));
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

// A vault

/** Says whether a folder may be opened as a vault, and why not when it may not. */
export async function checkVault(path) {
  return invoke('check_vault', { path });
}

export async function readVault(root) {
  return invoke('read_vault', { root });
}

export async function writeText(path, text) {
  await invoke('write_file_atomic', new TextEncoder().encode(text), {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

// The index

export async function indexState() {
  return invoke('index_state');
}

export async function indexUpsert({ path, title, tags, body, modified }) {
  return invoke('index_upsert', { path, title, tags, body, modified });
}

export async function indexRemove(path) {
  return invoke('index_remove', { path });
}

export async function indexSearch(query, limit = 60) {
  return invoke('index_search', { query, limit });
}

export async function indexDump() {
  return invoke('index_dump');
}

export async function indexForget() {
  return invoke('index_forget');
}

// Settings and startup

export async function runtimeInfo() {
  try {
    return await invoke('runtime_info');
  } catch {
    return { ephemeral: false, version: '0.0.0', defaultRoot: null };
  }
}

export async function readSettings() {
  try {
    return await invoke('read_settings');
  } catch {
    return {};
  }
}

export async function writeSettings(settings) {
  try {
    return await invoke('write_settings', { settings });
  } catch {
    return false;
  }
}

export async function forgetSettings() {
  try {
    await invoke('forget_settings');
    return true;
  } catch {
    return false;
  }
}
