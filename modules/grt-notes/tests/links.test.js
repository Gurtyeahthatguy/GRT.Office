/** Links between notes. */

import { describe, it, expect } from 'vitest';
import {
  linksIn, linksInNote, buildTitleIndex, resolve, isAmbiguous, backlinksTo,
  complete, pendingLink,
} from '../src/js/links.js';
import { makeBlock } from '../src/js/core/editor/model.js';

const noteWith = (...texts) => ({
  blocks: texts.map((text) => {
    const block = makeBlock('paragraph');
    block.runs = [{ text }];
    return block;
  }),
});

describe('finding links in text', () => {
  it('finds one', () => {
    expect(linksIn('see [[Kant]] on this')).toEqual(['Kant']);
  });

  it('finds several', () => {
    expect(linksIn('[[Kant]] and [[Hume]]')).toEqual(['Kant', 'Hume']);
  });

  it('does not repeat the same one', () => {
    expect(linksIn('[[Kant]] then [[kant]] again')).toEqual(['Kant']);
  });

  it('ignores an unclosed bracket', () => {
    expect(linksIn('[[Kant and nothing')).toEqual([]);
  });

  it('ignores an empty one', () => {
    expect(linksIn('[[]] and [[   ]]')).toEqual([]);
  });

  it('does not run across a line', () => {
    expect(linksIn('[[Kant\nHume]]')).toEqual([]);
  });

  it('reads links from a whole note, including list items', () => {
    const note = noteWith('see [[Kant]]');
    const list = makeBlock('list');
    list.items = [{ level: 0, runs: [{ text: 'and [[Hume]]' }] }];
    note.blocks.push(list);
    expect(linksInNote(note)).toEqual(['Kant', 'Hume']);
  });
});

describe('resolving a link', () => {
  const catalogue = [
    { path: '/a/001-kant.grt', title: 'Kant', links: [] },
    { path: '/a/002-hume.grt', title: 'Hume', links: ['Kant'] },
  ];
  const index = buildTitleIndex(catalogue);

  it('finds the note by title, ignoring case', () => {
    expect(resolve('Kant', index)).toBe('/a/001-kant.grt');
    expect(resolve('  kant ', index)).toBe('/a/001-kant.grt');
  });

  /** a link to a note that does not exist must not break anything. */
  it('returns null for a note that does not exist, rather than throwing', () => {
    expect(resolve('Spinoza', index)).toBeNull();
  });

  it('handles an empty archive without complaint', () => {
    const empty = buildTitleIndex([]);
    expect(resolve('Anything', empty)).toBeNull();
  });

  it('reports two notes sharing a title instead of quietly picking one', () => {
    const twins = buildTitleIndex([
      { path: '/a/1.grt', title: 'Notes' },
      { path: '/b/2.grt', title: 'Notes' },
    ]);
    expect(isAmbiguous('Notes', twins)).toBe(true);
    expect(resolve('Notes', twins)).toBe('/a/1.grt');
  });

  it('ignores notes with no title at all', () => {
    const index2 = buildTitleIndex([{ path: '/a/1.grt', title: '' }]);
    expect(resolve('', index2)).toBeNull();
  });
});

describe('backlinks', () => {
  const catalogue = [
    { path: '/a/kant.grt', title: 'Kant', links: [] },
    { path: '/a/hume.grt', title: 'Hume', links: ['Kant'] },
    { path: '/a/ethics.grt', title: 'Ethics', links: ['kant', 'Hume'] },
    { path: '/a/lonely.grt', title: 'Lonely', links: ['Spinoza'] },
  ];
  const index = buildTitleIndex(catalogue);

  it('lists what points here', () => {
    const found = backlinksTo('/a/kant.grt', catalogue, index);
    expect(found.map((f) => f.title).sort()).toEqual(['Ethics', 'Hume']);
  });

  it('does not count a note as linking to itself', () => {
    const selfish = [{ path: '/a/x.grt', title: 'X', links: ['X'] }];
    expect(backlinksTo('/a/x.grt', selfish, buildTitleIndex(selfish))).toEqual([]);
  });

  it('ignores links that point nowhere', () => {
    expect(backlinksTo('/a/nothing.grt', catalogue, index)).toEqual([]);
  });
});

describe('completion', () => {
  const titles = ['Kant', 'Kantian ethics', 'Immanuel and Kant compared', 'Hume'];

  it('puts titles that start with what was typed first', () => {
    expect(complete('kan', titles)).toEqual(['Kant', 'Kantian ethics', 'Immanuel and Kant compared']);
  });

  it('offers everything when nothing has been typed', () => {
    expect(complete('', titles)).toEqual(titles);
  });

  it('respects the limit', () => {
    expect(complete('', titles, 2)).toHaveLength(2);
  });
});

describe('spotting a half-typed link', () => {
  it('finds one and reports what has been typed so far', () => {
    expect(pendingLink('see [[kan', 9)).toEqual({ from: 4, query: 'kan' });
  });

  it('finds an empty one, so the list opens as soon as the brackets do', () => {
    expect(pendingLink('see [[', 6)).toEqual({ from: 4, query: '' });
  });

  it('says nothing once the link is closed', () => {
    expect(pendingLink('see [[Kant]] more', 17)).toBeNull();
  });

  it('says nothing when there are no brackets', () => {
    expect(pendingLink('just text', 9)).toBeNull();
  });

  it('does not reach back across a line break', () => {
    expect(pendingLink('[[start\nnow typing', 18)).toBeNull();
  });
});
