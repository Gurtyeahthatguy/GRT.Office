/** Protected notebooks: which notes they hold, and what stays out of the index. */

import { describe, it, expect } from 'vitest';
import { notebookOf, isProtected, lockedFileName, Keys } from '../src/js/locks.js';
import { refresh } from '../src/js/search.js';

const archive = {
  notebooks: [
    { name: 'Health', path: '/a/Health', protected: true },
    { name: 'Health records', path: '/a/Health records', protected: false },
  ],
};

describe('protected notebooks', () => {
  it('know which notes are theirs, and not a neighbour with a longer name', () => {
    expect(notebookOf(archive, '/a/Health/Visits/001-note.grt').name).toBe('Health');
    expect(notebookOf(archive, '/a/Health records/001-x.grt').name).toBe('Health records');
    expect(isProtected(archive, '/a/Health records/001-x.grt')).toBe(false);
    expect(isProtected(archive, '/a/Health')).toBe(true);
  });

  it('name files by order only', () => {
    expect(lockedFileName(7)).toBe('007-note.grt');
  });

  it('keep passwords in memory, per notebook, until forgotten', () => {
    const keys = new Keys();
    keys.set('/a/Health', 'pw');
    expect(keys.get(archive, '/a/Health/001-note.grt')).toBe('pw');
    expect(keys.get(archive, '/a/Health records/001-x.grt')).toBeNull();
    keys.forget();
    expect(keys.get(archive, '/a/Health/001-note.grt')).toBeNull();
  });

  it('leave the search index, and are never read for it', async () => {
    const read = [];
    const removed = [];
    const pages = [{ path: '/a/Health/001-note.grt', modified: 2 }, { path: '/a/Other/001-x.grt', modified: 2 }];
    const result = await refresh(pages, {
      indexState: async () => [{ path: '/a/Health/001-note.grt', modified: 1 }],
      indexUpsert: async () => {},
      indexRemove: async (path) => { removed.push(path); },
      readNote: async (path) => { read.push(path); return { title: 'x', tags: [], plainText: () => '' }; },
      skip: (page) => page.path.startsWith('/a/Health/'),
    });
    expect(read).toEqual(['/a/Other/001-x.grt']);
    expect(removed).toEqual(['/a/Health/001-note.grt']);
    expect(result.indexed).toBe(1);
  });
});
