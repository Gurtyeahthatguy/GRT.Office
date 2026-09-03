/** The only bridge between the interface and the filesystem. */

const { invoke } = window.__TAURI__.core;

export const FILTERS = {
  grt: [{ name: 'GRT document', extensions: ['grt'] }],
  html: [{ name: 'Web page', extensions: ['html'] }],
  pdf: [{ name: 'PDF document', extensions: ['pdf'] }],
  svg: [{ name: 'SVG image', extensions: ['svg'] }],
  png: [{ name: 'PNG image', extensions: ['png'] }],
  image: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  pptx: [{ name: 'PowerPoint presentation', extensions: ['pptx'] }],
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

/** Reads the text parts of a document, plus the names of its resources. */
export async function readDocument(path) {
  return invoke('read_grt', { path });
}

/** Reads any ZIP-based document, used by the PowerPoint import. */
export async function readZip(path) {
  return invoke('read_zip', { path });
}

/** Reads one resource as raw bytes. */
export async function readResource(path, name) {
  return new Uint8Array(await invoke('read_resource', { path, name }));
}

/** Holds a binary part for the next save. */
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
  if (!path) return `presentation.${extension}`;
  return `${path.replace(/\.[^.\\/]*$/, '')}.${extension}`;
}

/**
 * Guesses a media type from a file name, for the data URLs the HTML export
 * needs.
 */
export function mediaTypeFor(name) {
  const extension = String(name).toLowerCase().split('.').pop();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  }[extension] ?? 'application/octet-stream';
}

/** Bytes to a data URL, for inlining an image into the exported HTML. */
export function toDataUrl(bytes, name) {
  let binary = '';
  // Chunked: a single spread of a multi-megabyte array overflows the stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${mediaTypeFor(name)};base64,${btoa(binary)}`;
}
