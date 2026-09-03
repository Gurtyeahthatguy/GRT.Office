/** Keeping the index in step with the archive. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  refresh, fallbackTitle, searchByPattern, snippetAround, applyFilters, tagCounts,
} from '../src/js/search.js';

/** A pretend index and archive, recording what was asked of it. */
function harness(notes) {
  const rows = new Map();
  const readCount = new Map();

  return {
    rows,
    readCount,
    deps: {
      indexState: async () => [...rows.entries()]
        .map(([path, row]) => ({ path, modified: row.modified })),
      indexUpsert: async (row) => { rows.set(row.path, row); },
      indexRemove: async (path) => { rows.delete(path); },
      readNote: async (path) => {
        readCount.set(path, (readCount.get(path) ?? 0) + 1);
        const note = notes[path];
        if (!note) throw new Error(`no note at ${path}`);
        return note;
      },
    },
  };
}

const note = (title, body, tags = []) => ({
  title,
  tags,
  plainText: () => body,
});

let notes;
let pages;

beforeEach(() => {
  notes = {
    '/a/N/001-kant.grt': note('Kant', 'the categorical imperative', ['philosophy']),
    '/a/N/002-hume.grt': note('Hume', 'a treatise of human nature', ['philosophy']),
  };
  pages = [
    { path: '/a/N/001-kant.grt', file: '001-kant', modified: 100 },
    { path: '/a/N/002-hume.grt', file: '002-hume', modified: 200 },
  ];
});

describe('building the index', () => {
  it('indexes everything the first time', async () => {
    const h = harness(notes);
    const result = await refresh(pages, h.deps);

    expect(result.indexed).toBe(2);
    expect(h.rows.size).toBe(2);
    expect(h.rows.get('/a/N/001-kant.grt').body).toContain('categorical');
  });

  it('stores the title and the tags, not just the text', async () => {
    const h = harness(notes);
    await refresh(pages, h.deps);
    const row = h.rows.get('/a/N/001-kant.grt');
    expect(row.title).toBe('Kant');
    expect(row.tags).toBe('philosophy');
  });

  it('reads nothing at all on a second run that changed nothing', async () => {
    const h = harness(notes);
    await refresh(pages, h.deps);
    h.readCount.clear();

    const result = await refresh(pages, h.deps);
    expect(result.indexed).toBe(0);
    expect(h.readCount.size).toBe(0);
  });

  it('re-reads only the note whose file changed', async () => {
    const h = harness(notes);
    await refresh(pages, h.deps);
    h.readCount.clear();

    pages[1].modified = 999;
    const result = await refresh(pages, h.deps);

    expect(result.indexed).toBe(1);
    expect([...h.readCount.keys()]).toEqual(['/a/N/002-hume.grt']);
  });
});

// a deleted index rebuilds without loss

describe('a deleted index', () => {
  it('rebuilds completely from the archive', async () => {
    const h = harness(notes);
    await refresh(pages, h.deps);
    const before = new Map(h.rows);

    h.rows.clear();                       // as if the file had been deleted.
    const result = await refresh(pages, h.deps);

    expect(result.indexed).toBe(2);
    expect(h.rows.size).toBe(before.size);
    for (const [path, row] of before) {
      expect(h.rows.get(path).body).toBe(row.body);
      expect(h.rows.get(path).title).toBe(row.title);
    }
  });

  it('CANARY: the comparison would notice if the rebuild lost something', async () => {
    // Proof that the assertions above are checking content rather than
    // comparing an empty map with an empty map.
    const h = harness(notes);
    await refresh(pages, h.deps);
    expect(h.rows.size).toBe(2);
    expect(h.rows.get('/a/N/001-kant.grt').body).toBe('the categorical imperative');
  });
});

// a note moved by hand is found

describe('a note moved outside the program', () => {
  it('is indexed at its new path and forgotten at the old one', async () => {
    const h = harness(notes);
    await refresh(pages, h.deps);

    // Someone drags the file into another notebook using a file manager.
    notes['/a/Other/001-kant.grt'] = notes['/a/N/001-kant.grt'];
    delete notes['/a/N/001-kant.grt'];
    pages[0] = { path: '/a/Other/001-kant.grt', file: '001-kant', modified: 100 };

    const result = await refresh(pages, h.deps);

    expect(result.indexed).toBe(1);
    expect(result.removed).toBe(1);
    expect(h.rows.has('/a/N/001-kant.grt')).toBe(false);
    expect(h.rows.get('/a/Other/001-kant.grt').title).toBe('Kant');
  });

  it('forgets a note that was deleted outside the program', async () => {
    const h = harness(notes);
    await refresh(pages, h.deps);

    const result = await refresh([pages[0]], h.deps);
    expect(result.removed).toBe(1);
    expect(h.rows.has('/a/N/002-hume.grt')).toBe(false);
  });

  it('is found even when its modification time did not change', async () => {
    // Moving a file usually preserves its timestamp, so the path is what
    // changed and the path is what the diff is keyed on.
    const h = harness(notes);
    await refresh(pages, h.deps);

    notes['/a/Other/001-kant.grt'] = notes['/a/N/001-kant.grt'];
    pages[0] = { path: '/a/Other/001-kant.grt', file: '001-kant', modified: 100 };

    await refresh(pages, h.deps);
    expect(h.rows.has('/a/Other/001-kant.grt')).toBe(true);
  });
});

describe('a note that cannot be read', () => {
  it('is reported and does not stop the others being indexed', async () => {
    const h = harness(notes);
    pages.push({ path: '/a/N/003-broken.grt', file: '003-broken', modified: 300 });

    const result = await refresh(pages, h.deps);

    expect(result.failed).toEqual(['/a/N/003-broken.grt']);
    expect(result.indexed).toBe(2);
    expect(h.rows.size).toBe(2);
  });
});

describe('a note with no title', () => {
  it('is called after its file', () => {
    expect(fallbackTitle({ file: '001-some-thoughts' })).toBe('some thoughts');
    expect(fallbackTitle({ file: '' })).toBe('Untitled');
  });
});

describe('pattern search', () => {
  const rows = [
    { path: '/a/1.grt', title: 'Kant', body: 'the categorical imperative applies' },
    { path: '/a/2.grt', title: 'Hume', body: 'a treatise of human nature' },
  ];

  it('finds by regular expression', () => {
    const { hits } = searchByPattern(rows, 'categor\\w+');
    expect(hits.map((h) => h.path)).toEqual(['/a/1.grt']);
  });

  it('ignores case', () => {
    expect(searchByPattern(rows, 'TREATISE').hits).toHaveLength(1);
  });

  it('marks the match in the snippet', () => {
    const { hits } = searchByPattern(rows, 'imperative');
    expect(hits[0].snippet).toContain('<<imperative>>');
  });

  it('says a bad pattern is bad instead of throwing mid-keystroke', () => {
    const { hits, error } = searchByPattern(rows, '([');
    expect(hits).toEqual([]);
    expect(error).toBeTruthy();
  });
});

describe('snippets', () => {
  it('marks the match and trims either side', () => {
    const text = `${'x'.repeat(100)}needle${'y'.repeat(100)}`;
    const snippet = snippetAround(text, 100, 6);
    expect(snippet).toContain('<<needle>>');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('does not add ellipses when the whole text is shown', () => {
    expect(snippetAround('short needle here', 6, 6)).toBe('short <<needle>> here');
  });

  it('flattens line breaks so a result is one line', () => {
    expect(snippetAround('a\n\nneedle\nb', 3, 6)).not.toContain('\n');
  });
});

describe('filters and tags', () => {
  const hits = [
    { path: '/a/University/Philosophy/1.grt', title: 'Kant', tags: 'philosophy kant' },
    { path: '/a/Projects/GRT/2.grt', title: 'Ideas', tags: 'work' },
  ];

  it('filters by notebook', () => {
    expect(applyFilters(hits, { notebook: 'Projects' })).toHaveLength(1);
  });

  it('filters by tag', () => {
    expect(applyFilters(hits, { tag: 'kant' })).toHaveLength(1);
    expect(applyFilters(hits, { tag: 'nothing' })).toHaveLength(0);
  });

  it('counts tags, commonest first', () => {
    const counts = tagCounts([
      { tags: ['philosophy', 'kant'] },
      { tags: ['philosophy'] },
      { tags: [] },
    ]);
    expect(counts).toEqual([{ tag: 'philosophy', count: 2 }, { tag: 'kant', count: 1 }]);
  });
});
