/** Searching the archive. */

/**
 * Brings the index into line with the archive.
 * @param {Object} deps the io functions, injected so this can be tested
 * @returns {Promise<{indexed: number, removed: number, failed: string[]}>}
 */
export async function refresh(archiveNotes, deps) {
  const known = new Map(
    (await deps.indexState()).map((row) => [row.path, row.modified]),
  );

  let indexed = 0;
  const failed = [];
  const present = new Set();

  for (const page of archiveNotes) {
    present.add(page.path);
    if (known.get(page.path) === page.modified) continue;

    try {
      const note = await deps.readNote(page.path);
      await deps.indexUpsert({
        path: page.path,
        title: note.title || fallbackTitle(page),
        tags: note.tags.join(' '),
        body: note.plainText(),
        modified: page.modified,
      });
      indexed += 1;
    } catch (error) {
      // One unreadable note must not stop the rest of the archive being
      // searchable.
      failed.push(page.path);
    }
  }

  let removed = 0;
  for (const path of known.keys()) {
    if (present.has(path)) continue;
    await deps.indexRemove(path);
    removed += 1;
  }

  return { indexed, removed, failed };
}

/** A note with no title of its own is called after its file. */
export function fallbackTitle(page) {
  const stem = String(page.file ?? '').replace(/^\d+-/, '').replace(/-/g, ' ');
  return stem || 'Untitled';
}

/** A regular-expression search, done here rather than in SQLite. */
export function searchByPattern(rows, pattern, { limit = 60 } = {}) {
  let expression;
  try {
    expression = new RegExp(pattern, 'i');
  } catch {
    return { hits: [], error: 'That is not a valid pattern' };
  }

  const hits = [];
  for (const row of rows) {
    if (hits.length >= limit) break;
    const match = expression.exec(row.body ?? '') ?? expression.exec(row.title ?? '');
    if (!match) continue;
    hits.push({
      path: row.path,
      title: row.title,
      tags: '',
      snippet: snippetAround(row.body ?? '', match.index ?? 0, match[0].length),
    });
  }

  return { hits, error: null };
}

/** A little context either side of a match, with the match marked. */
export function snippetAround(text, at, length, width = 48) {
  const from = Math.max(0, at - width);
  const to = Math.min(text.length, at + length + width);
  const lead = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  return `${lead}${text.slice(from, at)}<<${text.slice(at, at + length)}>>${text.slice(at + length, to)}${tail}`
    .replace(/\n+/g, ' ');
}

/** Filters hits by notebook, section or tag. */
export function applyFilters(hits, { notebook = null, section = null, tag = null } = {}) {
  return hits.filter((hit) => {
    if (notebook && !hit.path.includes(`/${notebook}/`)) return false;
    if (section && !hit.path.includes(`/${section}/`)) return false;
    if (tag && !String(hit.tags ?? '').split(/\s+/).includes(tag)) return false;
    return true;
  });
}

/** Every tag in the archive, with how many notes carry it. */
export function tagCounts(notes) {
  const counts = new Map();
  for (const note of notes) {
    for (const tag of note.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}
