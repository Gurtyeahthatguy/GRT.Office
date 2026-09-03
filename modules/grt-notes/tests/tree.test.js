/**
 * The archive is the filesystem, so these are tests about file names.
 */

import { describe, it, expect } from 'vitest';
import {
  slugify, noteFileName, parseNoteFile, nextOrder, join, baseName, parentOf,
  flatten, allNotes, countNotes, folderName,
} from '../src/js/tree.js';

describe('slugs', () => {
  it('lower-cases and joins with hyphens', () => {
    expect(slugify('Critique of Pure Reason')).toBe('critique-of-pure-reason');
  });

  it('keeps letters from any alphabet', () => {
    expect(slugify('Università')).toBe('università');
    expect(slugify('Философия')).toBe('философия');
  });

  it('drops what a filesystem would object to', () => {
    expect(slugify('a/b:c*d?e')).toBe('abcde');
    expect(slugify('../../etc/passwd')).toBe('etcpasswd');
  });

  it('never returns an empty name', () => {
    expect(slugify('///')).toBe('note');
    expect(slugify('')).toBe('note');
  });

  it('does not run away with a very long title', () => {
    expect(slugify('word '.repeat(60)).length).toBeLessThanOrEqual(60);
  });
});

describe('note file names', () => {
  it('pads the ordering prefix so names sort as numbers do', () => {
    expect(noteFileName(1, 'Kant')).toBe('001-kant.grt');
    expect(noteFileName(42, 'Hume')).toBe('042-hume.grt');
  });

  it('sorts correctly past ten, which is the point of the padding', () => {
    const names = [noteFileName(2, 'b'), noteFileName(10, 'j'), noteFileName(1, 'a')];
    expect([...names].sort()).toEqual([names[2], names[0], names[1]]);
  });

  it('reads the order and slug back out', () => {
    expect(parseNoteFile('001-kant')).toEqual({ order: 1, slug: 'kant' });
  });

  it('accepts a file someone dropped in by hand, sorting it last', () => {
    const parsed = parseNoteFile('notes-from-elsewhere');
    expect(parsed.order).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsed.slug).toBe('notes-from-elsewhere');
  });

  it('finds the next free number', () => {
    expect(nextOrder(['001-a', '002-b', '007-c'])).toBe(8);
    expect(nextOrder([])).toBe(1);
    expect(nextOrder(['loose-file'])).toBe(1);
  });
});

describe('paths', () => {
  it('joins without doubling separators', () => {
    expect(join('/home/x', 'Notes', '001-a.grt')).toBe('/home/x/Notes/001-a.grt');
    expect(join('/home/x/', '/Notes/')).toBe('/home/x/Notes');
  });

  it('reads the last piece and the parent', () => {
    expect(baseName('/home/x/Notes/001-a.grt')).toBe('001-a.grt');
    expect(parentOf('/home/x/Notes/001-a.grt')).toBe('/home/x/Notes');
  });
});

const archive = {
  root: '/a',
  notebooks: [
    {
      name: 'University',
      path: '/a/University',
      pages: [{ path: '/a/University/002-loose.grt', file: '002-loose', modified: 5 }],
      sections: [
        {
          name: 'Philosophy',
          path: '/a/University/Philosophy',
          pages: [
            { path: '/a/University/Philosophy/002-hume.grt', file: '002-hume', modified: 2 },
            { path: '/a/University/Philosophy/001-kant.grt', file: '001-kant', modified: 1 },
          ],
        },
      ],
    },
    { name: 'Projects', path: '/a/Projects', pages: [], sections: [] },
  ],
};

describe('flattening the archive for the sidebar', () => {
  it('produces notebooks, their loose notes, then their sections', () => {
    const rows = flatten(archive);
    expect(rows.map((r) => r.kind)).toEqual([
      'notebook', 'note', 'section', 'note', 'note', 'notebook',
    ]);
  });

  it('orders notes by their numeric prefix, not by how the disk listed them', () => {
    const notes = flatten(archive).filter((r) => r.depth === 2);
    expect(notes.map((r) => r.path)).toEqual([
      '/a/University/Philosophy/001-kant.grt',
      '/a/University/Philosophy/002-hume.grt',
    ]);
  });

  it('indents by depth so the sidebar is a loop, not a recursion', () => {
    const rows = flatten(archive);
    expect(rows[0].depth).toBe(0);
    expect(rows[1].depth).toBe(1);
    expect(rows[3].depth).toBe(2);
  });

  it('hides what is inside a collapsed folder', () => {
    const rows = flatten(archive, { collapsed: new Set(['/a/University']) });
    expect(rows.map((r) => r.name)).toEqual(['University', 'Projects']);
  });

  it('counts every note under a notebook, sections included', () => {
    expect(countNotes(archive.notebooks[0])).toBe(3);
    expect(countNotes(archive.notebooks[1])).toBe(0);
  });
});

describe('listing every note', () => {
  it('returns them all with where they live', () => {
    const notes = allNotes(archive);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.notebook)).toEqual(['University', 'University', 'University']);
    expect(notes.filter((n) => n.section === 'Philosophy')).toHaveLength(2);
  });
});

describe('folder names', () => {
  it('keeps the case, unlike a note file name', () => {
    expect(folderName('University')).toBe('University');
  });

  it('removes separators and never returns nothing', () => {
    expect(folderName('a/b\\c')).toBe('abc');
    expect(folderName('   ')).toBe('Untitled');
  });
});
