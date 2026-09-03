/** The only bridge between the interface and the filesystem. */

const { invoke } = window.__TAURI__.core;

const GRT_FILTER = [{ name: 'GRT document', extensions: ['grt'] }];
const SVG_FILTER = [{ name: 'SVG image', extensions: ['svg'] }];
const PNG_FILTER = [{ name: 'PNG image', extensions: ['png'] }];
const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];
const PDF_FILTER = [{ name: 'PDF document', extensions: ['pdf'] }];

export const FILTERS = {
  grt: GRT_FILTER, svg: SVG_FILTER, png: PNG_FILTER, json: JSON_FILTER, pdf: PDF_FILTER,
};

function toPath(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return toPath(result[0]);
  if (typeof result === 'object' && typeof result.path === 'string') return result.path;
  return null;
}

export async function pickToOpen(filters = GRT_FILTER, title = 'Open') {
  return toPath(await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: false, filters },
  }));
}

export async function pickToSave(defaultPath, filters = GRT_FILTER, title = 'Save') {
  return toPath(await invoke('plugin:dialog|save', {
    options: { title, defaultPath, filters },
  }));
}

/** Reads a `.grt` document: a map of archive path to text. */
export async function readDocument(path) {
  return invoke('read_grt', { path });
}

/** Writes a `.grt` document. */
export async function writeDocument(path, parts) {
  return invoke('write_grt', { path, parts });
}

/** Writes any text file, for the SVG and JSON exports. */
export async function writeText(path, text) {
  const bytes = new TextEncoder().encode(text);
  await invoke('write_file_atomic', bytes, {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

/** Writes raw bytes, for the PNG export. */
export async function writeBytes(path, bytes) {
  await invoke('write_file_atomic', bytes, {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

/** Reads a plain text file. */
export async function readText(path) {
  const buffer = await invoke('read_file', { path });
  return new TextDecoder().decode(new Uint8Array(buffer));
}

export async function fileExists(path) {
  return invoke('file_exists', { path });
}

export async function runtimeInfo() {
  try {
    return await invoke('runtime_info');
  } catch {
    return { ephemeral: false, version: '0.0.0' };
  }
}

export async function onFilesDropped(handler) {
  const { listen } = window.__TAURI__.event;
  await listen('tauri://drag-drop', (event) => {
    const paths = (event?.payload?.paths ?? []).filter((p) => /\.(grt|json)$/i.test(p));
    if (paths.length > 0) handler(paths);
  });
}

export function baseName(path) {
  if (!path) return null;
  return path.split(/[\\/]/).pop() || null;
}

export function withExtension(path, extension) {
  if (!path) return `diagram.${extension}`;
  return path.replace(/\.[^.\\/]*$/, '') + `.${extension}`;
}
