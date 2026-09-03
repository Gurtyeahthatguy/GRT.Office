/** Formatting, blocks, typing groups and pagination. */

import { describe, it, expect } from 'vitest';
import { PaperModel, runsText, normaliseRuns, formatRuns, sliceRuns } from '../src/js/core/editor/model.js';
import { point, collapsed } from '../src/js/core/editor/selection.js';
import {
  applyFormat, hasFormat, setBlockKind, setBlockStyle, setAlign, indentList,
  insertBlocks, insertText,
} from '../src/js/core/editor/commands.js';
import { TypingGroup } from '../src/js/core/editor/input.js';
import { paginate } from '../src/js/pagination.js';

function twoParagraphs(text1 = 'First paragraph', text2 = 'Second paragraph') {
  return new PaperModel({
    blocks: [
      { id: 'b1', kind: 'paragraph', runs: [{ text: text1 }] },
      { id: 'b2', kind: 'paragraph', runs: [{ text: text2 }] },
    ],
  });
}

const range = (b1, o1, b2, o2) => ({ anchor: point(b1, o1), focus: point(b2, o2) });

describe('Runs never fragment', () => {
  it('adjacent runs with the same formatting are merged', () => {
    // without this the document fragments into one-character runs and the
    // file grows for no reason.
    const runs = normaliseRuns([
      { text: 'a', bold: true }, { text: 'b', bold: true }, { text: 'c', bold: true },
    ]);

    expect(runs).toEqual([{ text: 'abc', bold: true }]);
  });

  it('runs with different formatting stay apart', () => {
    expect(normaliseRuns([{ text: 'a' }, { text: 'b', bold: true }])).toHaveLength(2);
  });

  it('empty runs are dropped, but a block keeps one to hold the cursor', () => {
    expect(normaliseRuns([{ text: '' }, { text: 'x' }, { text: '' }]))
      .toEqual([{ text: 'x' }]);
    expect(normaliseRuns([])).toEqual([{ text: '' }]);
  });

  it('formatting the middle of a run splits it into exactly three', () => {
    expect(formatRuns([{ text: 'abcdef' }], 2, 4, 'bold')).toEqual([
      { text: 'ab' }, { text: 'cd', bold: true }, { text: 'ef' },
    ]);
  });

  it('formatting the whole of a run leaves one run, not three', () => {
    expect(formatRuns([{ text: 'abc' }], 0, 3, 'bold')).toEqual([{ text: 'abc', bold: true }]);
  });

  it('removing a mark merges the neighbours back together', () => {
    const runs = formatRuns(
      [{ text: 'ab' }, { text: 'cd', bold: true }, { text: 'ef' }], 2, 4, 'bold', false,
    );

    expect(runs).toEqual([{ text: 'abcdef' }]);
  });
});

describe('Formatting a selection', () => {
  it('applies across three blocks, partial ends included', () => {
    const model = new PaperModel({
      blocks: [
        { id: 'b1', kind: 'paragraph', runs: [{ text: 'aaaa' }] },
        { id: 'b2', kind: 'paragraph', runs: [{ text: 'bbbb' }] },
        { id: 'b3', kind: 'paragraph', runs: [{ text: 'cccc' }] },
      ],
    });

    applyFormat(model, range('b1', 2, 'b3', 2), 'bold');

    expect(sliceRuns(model.block('b1').runs, 2, 4)[0].bold).toBe(true);
    expect(model.block('b2').runs[0].bold).toBe(true);
    expect(sliceRuns(model.block('b3').runs, 0, 2)[0].bold).toBe(true);
    // Outside the range, untouched.
    expect(sliceRuns(model.block('b1').runs, 0, 2)[0].bold).toBeUndefined();
  });

  it('toggles off when everything in the range already has the mark', () => {
    const model = twoParagraphs('bold text');
    const selection = range('b1', 0, 'b1', 4);

    applyFormat(model, selection, 'bold');
    expect(hasFormat(model, selection, 'bold')).toBe(true);

    applyFormat(model, selection, 'bold');
    expect(hasFormat(model, selection, 'bold')).toBe(false);
  });

  it('a half-formatted range becomes fully formatted, not inverted', () => {
    // Deciding per run would toggle each half the opposite way and look like
    // nothing happened.
    const model = new PaperModel({
      blocks: [{ id: 'b1', kind: 'paragraph', runs: [{ text: 'ab', bold: true }, { text: 'cd' }] }],
    });

    const selection = range('b1', 0, 'b1', 4);
    applyFormat(model, selection, 'bold');

    expect(hasFormat(model, selection, 'bold')).toBe(true);
  });

  it('does nothing when the selection is a single point', () => {
    const model = twoParagraphs();
    const before = JSON.stringify(model.toJSON());

    applyFormat(model, collapsed(point('b1', 3)), 'bold');

    expect(JSON.stringify(model.toJSON())).toBe(before);
  });
});

describe('Block kinds and styles', () => {
  it('turning a paragraph into a heading sets the matching style', () => {
    const model = twoParagraphs();
    setBlockKind(model, collapsed(point('b1', 0)), 'heading', { level: 2 });

    expect(model.block('b1').kind).toBe('heading');
    expect(model.block('b1').style).toBe('h2');
    expect(runsText(model.block('b1').runs)).toBe('First paragraph');
  });

  it('applies to every block a selection touches', () => {
    const model = twoParagraphs();
    setBlockStyle(model, range('b1', 2, 'b2', 2), 'quote');

    expect(model.blocks.every((b) => b.style === 'quote')).toBe(true);
  });

  it('turning paragraphs into a list keeps their text as items', () => {
    const model = twoParagraphs();
    setBlockKind(model, collapsed(point('b1', 0)), 'list', { listType: 'bullet' });

    const block = model.block('b1');
    expect(block.kind).toBe('list');
    expect(runsText(block.items[0].runs)).toBe('First paragraph');
  });

  it('collapsing a list back joins its items rather than losing them', () => {
    const model = new PaperModel({
      blocks: [{
        id: 'l1', kind: 'list',
        items: [{ level: 0, runs: [{ text: 'one' }] }, { level: 0, runs: [{ text: 'two' }] }],
      }],
    });

    model.setBlockKind('l1', 'paragraph');
    expect(runsText(model.block('l1').runs)).toBe('one two');
  });

  it('alignment applies per block and rejects nonsense', () => {
    const model = twoParagraphs();
    setAlign(model, collapsed(point('b1', 0)), 'justify');
    model.setAlign('b1', 'sideways');

    expect(model.block('b1').align).toBe('justify');
  });

  it('indenting a list item stops at the outermost and innermost level', () => {
    const model = new PaperModel({
      blocks: [{ id: 'l1', kind: 'list', items: [{ level: 0, runs: [{ text: 'x' }] }] }],
    });
    const at = collapsed(point('l1', 0, 0));

    indentList(model, at, -1);
    expect(model.block('l1').items[0].level).toBe(0);

    for (let i = 0; i < 10; i += 1) indentList(model, at, 1);
    expect(model.block('l1').items[0].level).toBe(5);
  });
});

describe('Typing groups into sentences, not letters', () => {
  it('continuous typing stays one entry', () => {
    // Ctrl+Z has to undo a sentence.
    const group = new TypingGroup(500);
    let now = 1000;

    expect(group.shouldStartNew('H', point('b1', 0), now)).toBe(true);
    for (const [i, ch] of [...'ello'].entries()) {
      now += 60;
      expect(group.shouldStartNew(ch, point('b1', i + 1), now)).toBe(false);
    }
  });

  it('a pause starts a new entry', () => {
    const group = new TypingGroup(500);
    group.shouldStartNew('a', point('b1', 0), 1000);

    expect(group.shouldStartNew('b', point('b1', 1), 1700)).toBe(true);
  });

  it('a space ends the group at the word boundary', () => {
    const group = new TypingGroup(500);
    group.shouldStartNew('a', point('b1', 0), 1000);
    group.shouldStartNew(' ', point('b1', 1), 1050);

    expect(group.shouldStartNew('b', point('b1', 2), 1100)).toBe(true);
  });

  it('moving the cursor elsewhere starts a new entry', () => {
    const group = new TypingGroup(500);
    group.shouldStartNew('a', point('b1', 0), 1000);

    expect(group.shouldStartNew('b', point('b2', 5), 1050)).toBe(true);
  });

  it('anything that is not typing ends the group', () => {
    const group = new TypingGroup(500);
    group.shouldStartNew('a', point('b1', 0), 1000);
    group.end();

    expect(group.shouldStartNew('b', point('b1', 1), 1050)).toBe(true);
  });
});

describe('Pagination', () => {
  const blocks = (heights, extra = {}) => heights.map((height, i) => ({
    id: `b${i}`, height, lineHeight: 20, lines: Math.round(height / 20), ...extra,
  }));

  it('fills a page and starts the next', () => {
    // Three lines each: too short to split fairly, so each block moves whole.
    const short = blocks([100, 100, 100]).map((b) => ({ ...b, lines: 3 }));
    const { pages } = paginate(short, 250);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual(['b0', 'b1']);
    expect(pages[1]).toEqual(['b2']);
  });

  it('keeps a heading with what follows it', () => {
    // a heading must not be left alone at the foot of a page.
    const list = blocks([200, 40, 120]);
    list[1].keepWithNext = true;
    list[1].lines = 2;

    const { pages } = paginate(list, 250);

    expect(pages[0]).toEqual(['b0']);
    expect(pages[1]).toEqual(['b1', 'b2']);
  });

  it('honours a manual break', () => {
    const list = blocks([50, 50]);
    list[1].breakBefore = true;

    expect(paginate(list, 500).pages).toHaveLength(2);
  });

  it('splits a long paragraph but leaves two lines on each side', () => {
    // Widows and orphans.
    const list = blocks([80, 200]);   // ten lines in the second.
    const { pages } = paginate(list, 140);

    expect(pages[0]).toContain('b1');
    expect(pages[1]).toContain('b1');
  });

  it('moves a short paragraph rather than splitting it', () => {
    const list = blocks([100, 60]);   // three lines: nowhere to split fairly.
    const { pages } = paginate(list, 130);

    expect(pages[0]).toEqual(['b0']);
    expect(pages[1]).toEqual(['b1']);
  });

  it('an empty document is one empty page, not none', () => {
    expect(paginate([], 500).pages).toHaveLength(1);
  });
});

describe('Pasting into the document', () => {
  it('a single paragraph pastes inline, without breaking the sentence', () => {
    const model = twoParagraphs('Hello world');
    const after = insertBlocks(model, collapsed(point('b1', 5)), [
      { kind: 'paragraph', runs: [{ text: ' there' }] },
    ]);

    expect(model.blocks).toHaveLength(2);
    expect(runsText(model.block('b1').runs)).toBe('Hello there world');
    expect(after.anchor.offset).toBe(11);
  });

  it('several blocks arrive as blocks', () => {
    const model = twoParagraphs();
    insertBlocks(model, collapsed(point('b1', 15)), [
      { kind: 'heading', level: 2, style: 'h2', runs: [{ text: 'Heading' }] },
      { kind: 'paragraph', runs: [{ text: 'Body' }] },
    ]);

    const kinds = model.blocks.map((b) => b.kind);
    expect(kinds).toContain('heading');
    expect(model.blocks.length).toBeGreaterThan(2);
  });

  it('pasting over a selection replaces it', () => {
    const model = twoParagraphs();
    insertBlocks(model, range('b1', 0, 'b2', 6), [
      { kind: 'paragraph', runs: [{ text: 'Replaced' }] },
    ]);

    expect(model.blocks).toHaveLength(1);
    expect(runsText(model.blocks[0].runs)).toBe('Replaced paragraph');
  });
});

describe('Counting', () => {
  it('reports words and characters', () => {
    const model = twoParagraphs('one two three', 'four five');
    const counts = model.counts();

    expect(counts.words).toBe(5);
    expect(counts.charactersNoSpaces).toBe(19);
  });

  it('counts list items too', () => {
    const model = new PaperModel({
      blocks: [{
        id: 'l1', kind: 'list',
        items: [{ level: 0, runs: [{ text: 'alpha beta' }] }, { level: 0, runs: [{ text: 'gamma' }] }],
      }],
    });

    expect(model.counts().words).toBe(3);
  });
});
