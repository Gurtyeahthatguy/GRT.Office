/** The only bridge between the interface and the filesystem. */

const { invoke } = window.__TAURI__.core;

const PDF_FILTER = [{ name: 'PDF document', extensions: ['pdf'] }];

/** Dialog results have changed shape between Tauri releases. */
function toPath(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return toPath(result[0]);
  if (typeof result === 'object' && typeof result.path === 'string') {
    return result.path;
  }
  return null;
}

/** Native "open file" dialog. */
export async function pickPdfToOpen(title = 'Open PDF') {
  const result = await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: false, filters: PDF_FILTER },
  });
  return toPath(result);
}

/** Native folder picker, for operations that write several files. */
export async function pickDirectory(title = 'Choose a folder') {
  const result = await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: true },
  });
  return toPath(result);
}

/** Native "save as" dialog. */
export async function pickPdfToSave(defaultPath, title = 'Save PDF') {
  const result = await invoke('plugin:dialog|save', {
    options: { title, defaultPath, filters: PDF_FILTER },
  });
  return toPath(result);
}

/** Reads a file as raw bytes. */
export async function readFileBytes(path) {
  const buffer = await invoke('read_file', { path });
  return new Uint8Array(buffer);
}

export async function fileExists(path) {
  return invoke('file_exists', { path });
}

/** Startup facts from the backend. */
export async function runtimeInfo() {
  try {
    return await invoke('runtime_info');
  } catch {
    return { ephemeral: false, version: '0.0.0' };
  }
}

/** Files dropped onto the window. */
export async function onFilesDropped(handler) {
  const { listen } = window.__TAURI__.event;
  await listen('tauri://drag-drop', (event) => {
    const paths = event?.payload?.paths ?? [];
    const pdfs = paths.filter((p) => p.toLowerCase().endsWith('.pdf'));
    if (pdfs.length > 0) handler(pdfs);
  });
}

/** Last path component, used for window titles and default file names. */
export function baseName(path) {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/** Joins a directory and a file name. */
export function joinPath(directory, name) {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const trimmed = directory.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${name}`;
}

/**
 * Builds a sibling path with a suffix: /a/b.pdf + "-extract" →
 * /a/b-extract.pdf.
 */
export function withSuffix(path, suffix) {
  if (!path) return `document${suffix}.pdf`;
  return path.replace(/(\.pdf)?$/i, `${suffix}.pdf`);
}
