/** The archive is the filesystem. */

/** How many digits the ordering prefix uses. */
const WIDTH = 3;

/** Turns a title into something safe to put in a file name. */
export function slugify(title) {
  return String(title ?? '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase() || 'note';
}

/** `001-kant.grt` from an order and a title. */
export function noteFileName(order, title) {
  return `${String(order).padStart(WIDTH, '0')}-${slugify(title)}.grt`;
}

/** Reads the order and the slug back out of a file name. */
export function parseNoteFile(stem) {
  const match = /^(\d+)-(.*)$/.exec(String(stem));
  if (!match) return { order: Number.MAX_SAFE_INTEGER, slug: String(stem) };
  return { order: Number.parseInt(match[1], 10), slug: match[2] };
}

/** The next free ordering number in a folder. */
export function nextOrder(fileStems) {
  const orders = fileStems
    .map((stem) => parseNoteFile(stem).order)
    .filter((n) => Number.isFinite(n) && n < Number.MAX_SAFE_INTEGER);
  return orders.length === 0 ? 1 : Math.max(...orders) + 1;
}

/** Joins path pieces with the separator already in use. */
export function join(...pieces) {
  const parts = pieces.filter(Boolean).map(String);
  const separator = parts.some((p) => p.includes('\\')) && !parts.some((p) => p.includes('/'))
    ? '\\' : '/';
  return parts
    .map((part, i) => (i === 0 ? part.replace(/[/\\]+$/, '') : part.replace(/^[/\\]+|[/\\]+$/g, '')))
    .join(separator);
}

export function baseName(path) {
  return String(path).split(/[/\\]/).pop() ?? '';
}

export function parentOf(path) {
  const pieces = String(path).split(/[/\\]/);
  pieces.pop();
  return pieces.join('/');
}

/** Flattens the archive the backend reported into a list ready to draw. */
export function flatten(archive, { collapsed = new Set() } = {}) {
  const rows = [];

  for (const notebook of archive.notebooks ?? []) {
    const shut = collapsed.has(notebook.path);
    rows.push({
      kind: 'notebook',
      name: notebook.name,
      path: notebook.path,
      depth: 0,
      collapsed: shut,
      count: countNotes(notebook),
    });
    if (shut) continue;

    for (const page of sortPages(notebook.pages ?? [])) {
      rows.push({ kind: 'note', ...pageRow(page), depth: 1 });
    }

    for (const section of notebook.sections ?? []) {
      const sectionShut = collapsed.has(section.path);
      rows.push({
        kind: 'section',
        name: section.name,
        path: section.path,
        depth: 1,
        collapsed: sectionShut,
        count: (section.pages ?? []).length,
      });
      if (sectionShut) continue;

      for (const page of sortPages(section.pages ?? [])) {
        rows.push({ kind: 'note', ...pageRow(page), depth: 2 });
      }
    }
  }

  return rows;
}

function pageRow(page) {
  const { order, slug } = parseNoteFile(page.file);
  return {
    name: page.title || slug.replace(/-/g, ' '),
    path: page.path,
    file: page.file,
    order,
    modified: page.modified,
  };
}

function sortPages(pages) {
  return [...pages].sort((a, b) => {
    const left = parseNoteFile(a.file);
    const right = parseNoteFile(b.file);
    return left.order - right.order || left.slug.localeCompare(right.slug);
  });
}

export function countNotes(notebook) {
  const direct = (notebook.pages ?? []).length;
  const inSections = (notebook.sections ?? [])
    .reduce((total, section) => total + (section.pages ?? []).length, 0);
  return direct + inSections;
}

/** Every note in the archive, as a flat list. */
export function allNotes(archive) {
  const out = [];
  for (const notebook of archive.notebooks ?? []) {
    for (const page of notebook.pages ?? []) {
      out.push({ ...page, notebook: notebook.name, section: null });
    }
    for (const section of notebook.sections ?? []) {
      for (const page of section.pages ?? []) {
        out.push({ ...page, notebook: notebook.name, section: section.name });
      }
    }
  }
  return out;
}

/** Folder names have to be usable as directory names, but keep their case. */
export function folderName(name) {
  return String(name ?? '')
    .trim()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'Untitled';
}
