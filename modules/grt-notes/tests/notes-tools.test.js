/** Mentions not yet linked, search operators, renaming with links, merging and splitting. */

import { describe, it, expect } from 'vitest';
import {
  unlinkedMentions, linkFirstMention, renameLinks, parseQuery, meetsOperators, hasOperators, mergeInto, splitAt,
} from '../src/js/notes-tools.js';
import { makeBlock, runsText } from '../src/js/core/editor/model.js';

const noteWith = (...texts) => ({
  title: 'Here',
  tags: [],
  blocks: texts.map((text) => {
    const block = makeBlock('paragraph');
    block.runs = [{ text }];
    return block;
  }),
});
const textOf = (note) => note.blocks.map((b) => runsText(b.runs ?? [])).join('\n');

describe('unlinked mentions', () => {
  const catalogue = [
    { path: 'a', title: 'Kant', links: [], body: 'About Kant and reason.' },
    { path: 'b', title: 'Hume', links: ['Kant'], body: 'Hume read [[Kant]] and Kant read Hume.' },
    { path: 'c', title: 'Others', links: [], body: 'Kantian ethics, not the man.' },
    { path: 'd', title: 'Lower', links: [], body: 'kant in lower case.' },
  ];

  it('finds notes naming the title as a word, not those linking it or using it inside a word', () => {
    const found = unlinkedMentions('Kant', 'x', catalogue).map((m) => m.path);
    expect(found).toEqual(['a', 'd']);
  });

  it('leaves the note itself out and ignores very short titles', () => {
    expect(unlinkedMentions('Kant', 'a', catalogue).map((m) => m.path)).toEqual(['d']);
    expect(unlinkedMentions('AI', 'x', [{ path: 'a', title: 't', body: 'AI here' }])).toEqual([]);
  });

  it('treats the title as text, not a pattern', () => {
    expect(unlinkedMentions('C++ (old)', 'x', [{ path: 'a', title: 't', links: [], body: 'I like C++ (old) best' }])).toHaveLength(1);
    expect(unlinkedMentions('a.b', 'x', [{ path: 'a', title: 't', links: [], body: 'axb' }])).toHaveLength(0);
  });

  it('links the first mention and keeps the words as written', () => {
    const note = noteWith('nothing here', 'the kant question and Kant again');
    expect(linkFirstMention(note, 'Kant')).toBe(true);
    expect(textOf(note)).toBe('nothing here\nthe [[kant]] question and Kant again');
    expect(note.dirty).toBe(true);
  });

  it('does not link inside a link already there', () => {
    const note = noteWith('[[Kant]] only');
    expect(linkFirstMention(note, 'Kant')).toBe(false);
  });
});

describe('renaming changes the links to that note and no others', () => {
  it('changes every form of link to the old title', () => {
    const note = noteWith('see [[Kant]], [[kant|the man]], [[Philosophy/Kant#Ethics]] and [[Kant#A|b]]');
    expect(renameLinks(note, 'Kant', 'Immanuel Kant')).toBe(4);
    expect(textOf(note)).toBe('see [[Immanuel Kant]], [[Immanuel Kant|the man]], [[Philosophy/Immanuel Kant#Ethics]] and [[Immanuel Kant#A|b]]');
  });

  it('leaves links to other titles, and the plain text, alone', () => {
    const note = noteWith('Kant wrote; see [[Kantian]], [[Hume]], [[Kant 2]] and [[Kant]]');
    expect(renameLinks(note, 'Kant', 'K')).toBe(1);
    expect(textOf(note)).toBe('Kant wrote; see [[Kantian]], [[Hume]], [[Kant 2]] and [[K]]');
  });

  it('reaches list items and changes nothing when nothing matches', () => {
    const list = makeBlock('list');
    list.items = [{ runs: [{ text: 'item [[Kant]]' }] }];
    const note = { blocks: [list] };
    expect(renameLinks(note, 'Kant', 'New')).toBe(1);
    expect(list.items[0].runs[0].text).toBe('item [[New]]');
    const other = noteWith('no links');
    expect(renameLinks(other, 'Kant', 'New')).toBe(0);
    expect(other.dirty).toBeUndefined();
  });
});

describe('search operators', () => {
  it('takes the operators out of the text', () => {
    const q = parseQuery('reason tag:#philosophy path:"Old notes" task-todo:read [status:draft] critique');
    expect(q.text).toBe('reason critique');
    expect(q.tags).toEqual(['philosophy']);
    expect(q.paths).toEqual(['old notes']);
    expect(q.tasks).toEqual([{ state: false, text: 'read' }]);
    expect(q.properties).toEqual([{ key: 'status', value: 'draft' }]);
    expect(hasOperators(q)).toBe(true);
    expect(hasOperators(parseQuery('plain words'))).toBe(false);
  });

  it('matches tags with their children, paths, tasks and properties', () => {
    const todo = makeBlock('todo');
    todo.runs = [{ text: 'Read the critique' }];
    todo.done = false;
    const note = { tags: ['philosophy/german'], blocks: [todo], properties: [{ key: 'status', value: 'Draft' }, { key: 'authors', value: ['Kant', 'Hume'] }] };
    const meets = (q) => meetsOperators(note, 'Studies/Kant.grt', parseQuery(q));
    expect(meets('tag:philosophy')).toBe(true);
    expect(meets('tag:philo')).toBe(false);
    expect(meets('path:studies')).toBe(true);
    expect(meets('path:work')).toBe(false);
    expect(meets('task:critique')).toBe(true);
    expect(meets('task-todo:critique')).toBe(true);
    expect(meets('task-done:critique')).toBe(false);
    expect(meets('[status:draft]')).toBe(true);
    expect(meets('[authors:hume]')).toBe(true);
    expect(meets('[status:]')).toBe(true);
    expect(meets('[missing:]')).toBe(false);
  });
});

describe('merging and splitting', () => {
  it('puts one note after another under its title, with both sets of tags', () => {
    const target = { ...noteWith('first'), tags: ['a'] };
    const source = { ...noteWith('second'), title: 'Source', tags: ['a', 'b'] };
    mergeInto(target, source);
    expect(textOf(target)).toBe('first\nSource\nsecond');
    expect(target.blocks[1].kind).toBe('heading');
    expect(target.tags).toEqual(['a', 'b']);
    // The source is copied, not shared.
    source.blocks[0].runs[0].text = 'changed';
    expect(textOf(target)).toContain('second');
  });

  it('takes the blocks from one on, and refuses the first or none', () => {
    const note = noteWith('one', 'two', 'three');
    expect(splitAt(note, 0)).toBeNull();
    expect(splitAt(note, 3)).toBeNull();
    const moved = splitAt(note, 1);
    expect(moved.map((b) => b.runs[0].text)).toEqual(['two', 'three']);
    expect(textOf(note)).toBe('one');
  });
});
