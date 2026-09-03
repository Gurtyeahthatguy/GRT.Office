/** The only bridge between the interface and the filesystem. */

const { invoke } = window.__TAURI__.core;

export const FILTERS = {
  grt: [{ name: 'GRT document', extensions: ['grt'] }],
  pdf: [{ name: 'PDF document', extensions: ['pdf'] }],
  html: [{ name: 'Web page', extensions: ['html'] }],
  md: [{ name: 'Markdown', extensions: ['md'] }],
  txt: [{ name: 'Plain text', extensions: ['txt'] }],
  image: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  font: [{ name: 'Font', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
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
  return toPath(await invoke('plugin:dialog|save', {
    options: { title, defaultPath, filters },
  }));
}

export async function readDocument(path) {
  return invoke('read_grt', { path });
}

export async function readResource(path, name) {
  return new Uint8Array(await invoke('read_resource', { path, name }));
}

export async function stagePart(name, bytes) {
  await invoke('stage_part', bytes, {
    headers: { 'x-grt-name': encodeURIComponent(name) },
  });
}

export async function clearStaged() {
  return invoke('clear_staged');
}

export async function writeDocument(path, parts) {
  return invoke('write_grt', { path, parts });
}

export async function writeText(path, text) {
  await invoke('write_file_atomic', new TextEncoder().encode(text), {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

export async function writeBytes(path, bytes) {
  await invoke('write_file_atomic', bytes, {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

export async function readFileBytes(path) {
  return new Uint8Array(await invoke('read_file', { path }));
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
    const paths = event?.payload?.paths ?? [];
    if (paths.length > 0) handler(paths);
  });
}

export function baseName(path) {
  if (!path) return null;
  return path.split(/[\\/]/).pop() || null;
}

export function withExtension(path, extension) {
  if (!path) return `document.${extension}`;
  return `${path.replace(/\.[^.\\/]*$/, '')}.${extension}`;
}

export function mediaTypeFor(name) {
  const extension = String(name).toLowerCase().split('.').pop();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
  }[extension] ?? 'application/octet-stream';
}

/**
 * Bytes to a data URL, chunked so a large image does not overflow the stack.
 */
export function toDataUrl(bytes, name) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${mediaTypeFor(name)};base64,${btoa(binary)}`;
}
