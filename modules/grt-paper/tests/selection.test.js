/** The most important file here. */

import { describe, it, expect } from 'vitest';
import { PaperModel, runsText, runsLength } from '../src/js/core/editor/model.js';
import {
  point, collapsed, isCollapsed, normalise, isBefore, containersInRange,
  clampSelection, forward, backward, endOfPrevious, startOfNext,
} from '../src/js/core/editor/selection.js';
import { deleteRange, insertText, splitBlock, deleteBackward } from '../src/js/core/editor/commands.js';
import { UndoStack } from '../src/js/core/undo.js';

/**
 * Three paragraphs, so the awkward cross-block cases have somewhere to
 * happen.
 */
function threeParagraphs() {
  const model = new PaperModel({
    version: 1,
    type: 'paper',
    blocks: [
      { id: 'b1', kind: 'paragraph', runs: [{ text: 'First paragraph' }] },
      { id: 'b2', kind: 'paragraph', runs: [{ text: 'Second paragraph' }] },
      { id: 'b3', kind: 'paragraph', runs: [{ text: 'Third paragraph' }] },
    ],
  });
  return model;
}

const across = (fromBlock, fromOffset, toBlock, toOffset) => ({
  anchor: point(fromBlock, fromOffset),
  focus: point(toBlock, toOffset),
});

describe('Ordering a selection', () => {
  it('leaves a forward selection alone', () => {
    const model = threeParagraphs();
    const { start, end } = normalise(across('b1', 2, 'b3', 4), model);

    expect(start.blockId).toBe('b1');
    expect(end.blockId).toBe('b3');
  });

  it('turns a backwards selection round', () => {
    // Dragging upwards puts the focus before the anchor.
    const model = threeParagraphs();
    const { start, end } = normalise(across('b3', 4, 'b1', 2), model);

    expect(start.blockId).toBe('b1');
    expect(start.offset).toBe(2);
    expect(end.blockId).toBe('b3');
  });

  it('orders two points in the same block by offset', () => {
    const model = threeParagraphs();
    expect(isBefore(point('b2', 1), point('b2', 5), model)).toBe(true);
    expect(isBefore(point('b2', 5), point('b2', 1), model)).toBe(false);
  });

  it('knows a collapsed selection from a range', () => {
    expect(isCollapsed(collapsed(point('b1', 3)))).toBe(true);
    expect(isCollapsed(across('b1', 3, 'b1', 4))).toBe(false);
  });
});

describe('What a range covers', () => {
  it('one container when it stays inside a block', () => {
    const model = threeParagraphs();
    const containers = containersInRange(across('b2', 2, 'b2', 6), model);

    expect(containers).toHaveLength(1);
    expect(containers[0]).toMatchObject({ blockId: 'b2', from: 2, to: 6, whole: false });
  });

  it('three containers across three blocks, with the middle one whole', () => {
    const model = threeParagraphs();
    const containers = containersInRange(across('b1', 6, 'b3', 5), model);

    expect(containers.map((c) => c.blockId)).toEqual(['b1', 'b2', 'b3']);
    expect(containers[0]).toMatchObject({ from: 6, to: 15 });
    expect(containers[1].whole).toBe(true);
    expect(containers[2]).toMatchObject({ from: 0, to: 5 });
  });

  it('covers list items one by one', () => {
    const model = new PaperModel({
      blocks: [{
        id: 'l1', kind: 'list', listType: 'bullet',
        items: [
          { level: 0, runs: [{ text: 'alpha' }] },
          { level: 0, runs: [{ text: 'beta' }] },
          { level: 0, runs: [{ text: 'gamma' }] },
        ],
      }],
    });

    const containers = containersInRange({
      anchor: point('l1', 2, 0), focus: point('l1', 3, 2),
    }, model);

    expect(containers).toHaveLength(3);
    expect(containers[1]).toMatchObject({ itemIndex: 1, whole: true });
  });

  it('skips list items outside the range even though their block is inside it', () => {
    const model = new PaperModel({
      blocks: [{
        id: 'l1', kind: 'list',
        items: [
          { level: 0, runs: [{ text: 'one' }] },
          { level: 0, runs: [{ text: 'two' }] },
          { level: 0, runs: [{ text: 'three' }] },
        ],
      }],
    });

    const containers = containersInRange({
      anchor: point('l1', 0, 1), focus: point('l1', 1, 1),
    }, model);

    expect(containers).toHaveLength(1);
    expect(containers[0].itemIndex).toBe(1);
  });
});

describe('Moving a step', () => {
  it('crosses into the next block at the end of one', () => {
    const model = threeParagraphs();
    const at = forward(point('b1', 15), model);

    expect(at).toMatchObject({ blockId: 'b2', offset: 0 });
  });

  it('crosses back into the previous block at the start', () => {
    const model = threeParagraphs();
    const at = backward(point('b2', 0), model);

    expect(at).toMatchObject({ blockId: 'b1', offset: 15 });
  });

  it('stays put at the very beginning and the very end', () => {
    const model = threeParagraphs();
    expect(backward(point('b1', 0), model)).toMatchObject({ blockId: 'b1', offset: 0 });
    expect(forward(point('b3', 15), model)).toMatchObject({ blockId: 'b3', offset: 15 });
    expect(endOfPrevious(point('b1', 0), model)).toBeNull();
    expect(startOfNext(point('b3', 0), model)).toBeNull();
  });

  it('walks between list items before leaving the block', () => {
    const model = new PaperModel({
      blocks: [{
        id: 'l1', kind: 'list',
        items: [{ level: 0, runs: [{ text: 'ab' }] }, { level: 0, runs: [{ text: 'cd' }] }],
      }],
    });

    expect(forward(point('l1', 2, 0), model)).toMatchObject({ itemIndex: 1, offset: 0 });
    expect(backward(point('l1', 0, 1), model)).toMatchObject({ itemIndex: 0, offset: 2 });
  });
});

describe('Deleting across blocks', () => {
  it('joins the two ends and removes what was between them', () => {
    const model = threeParagraphs();
    const at = deleteRange(model, across('b1', 6, 'b3', 6));

    expect(model.blocks).toHaveLength(1);
    expect(runsText(model.blocks[0].runs)).toBe('First paragraph');
    expect(at).toMatchObject({ blockId: 'b1', offset: 6 });
  });

  it('works the same when the selection was dragged backwards', () => {
    const forwards = threeParagraphs();
    const backwards = threeParagraphs();

    deleteRange(forwards, across('b1', 6, 'b3', 6));
    deleteRange(backwards, across('b3', 6, 'b1', 6));

    expect(JSON.stringify(backwards.toJSON().blocks))
      .toBe(JSON.stringify(forwards.toJSON().blocks));
  });

  it('a cut inside one block keeps the block', () => {
    const model = threeParagraphs();
    deleteRange(model, across('b2', 0, 'b2', 7));

    expect(model.blocks).toHaveLength(3);
    expect(runsText(model.block('b2').runs)).toBe('paragraph');
  });

  it('keeps the formatting of what survives on either side', () => {
    const model = new PaperModel({
      blocks: [
        { id: 'b1', kind: 'paragraph', runs: [{ text: 'keep', bold: true }, { text: 'cut' }] },
        { id: 'b2', kind: 'paragraph', runs: [{ text: 'gone' }, { text: 'stay', italic: true }] },
      ],
    });

    deleteRange(model, across('b1', 4, 'b2', 4));
    const runs = model.blocks[0].runs;

    expect(runs[0]).toEqual({ text: 'keep', bold: true });
    expect(runs[1]).toEqual({ text: 'stay', italic: true });
  });

  it('selecting the whole document leaves one empty block to type in', () => {
    const model = threeParagraphs();
    deleteRange(model, across('b1', 0, 'b3', 15));

    expect(model.blocks.length).toBeGreaterThanOrEqual(1);
    expect(runsText(model.blocks[0].runs)).toBe('');
  });
});

describe('Undo restores the text AND the cursor', () => {
  it('after deleting a range across three blocks', () => {
    // 's first requirement, and 's reason for it.
    const model = threeParagraphs();
    const undo = new UndoStack(model);

    const selectionBefore = across('b1', 6, 'b3', 6);
    let selectionAfter = null;

    const snapshot = model.snapshot();
    selectionAfter = collapsed(deleteRange(model, selectionBefore));
    undo.past.push({ ...snapshot, selection: selectionBefore });

    expect(model.blocks).toHaveLength(1);
    expect(selectionAfter.anchor).toMatchObject({ blockId: 'b1', offset: 6 });

    const restored = undo.past[undo.past.length - 1];
    undo.undo();

    expect(model.blocks).toHaveLength(3);
    expect(runsText(model.block('b2').runs)).toBe('Second paragraph');
    expect(restored.selection.anchor).toMatchObject({ blockId: 'b1', offset: 6 });
    expect(restored.selection.focus).toMatchObject({ blockId: 'b3', offset: 6 });
  });

  it('and the restored positions still exist in the restored document', () => {
    const model = threeParagraphs();
    const before = model.snapshot();
    const selection = across('b1', 6, 'b3', 6);

    deleteRange(model, selection);
    model.restore(before);

    const clamped = clampSelection(selection, model);
    expect(clamped.anchor).toMatchObject({ blockId: 'b1', offset: 6 });
    expect(clamped.focus).toMatchObject({ blockId: 'b3', offset: 6 });
  });
});

describe('Clamping after the document changed', () => {
  it('pulls an offset back to the end of what is left', () => {
    const model = threeParagraphs();
    const clamped = clampSelection(collapsed(point('b1', 999)), model);

    expect(clamped.anchor.offset).toBe(15);
  });

  it('falls back to the first block when the one it named is gone', () => {
    const model = threeParagraphs();
    const clamped = clampSelection(collapsed(point('vanished', 3)), model);

    expect(clamped.anchor.blockId).toBe('b1');
  });
});

describe('Splitting and merging', () => {
  it('Enter in the middle splits the paragraph in two', () => {
    const model = threeParagraphs();
    const after = splitBlock(model, collapsed(point('b2', 6)));

    expect(model.blocks).toHaveLength(4);
    expect(runsText(model.block('b2').runs)).toBe('Second');
    expect(runsText(model.block(after.anchor.blockId).runs)).toBe(' paragraph');
    expect(after.anchor.offset).toBe(0);
  });

  it('Enter after a heading starts body text, not another heading', () => {
    const model = new PaperModel({
      blocks: [{ id: 'h', kind: 'heading', level: 1, style: 'h1', runs: [{ text: 'Title' }] }],
    });

    const after = splitBlock(model, collapsed(point('h', 5)));
    const created = model.block(after.anchor.blockId);

    expect(created.kind).toBe('paragraph');
    expect(created.style).toBe('body');
  });

  it('Backspace at the start of a block merges it into the one above', () => {
    const model = threeParagraphs();
    const after = deleteBackward(model, collapsed(point('b2', 0)));

    expect(model.blocks).toHaveLength(2);
    expect(runsText(model.blocks[0].runs)).toBe('First paragraphSecond paragraph');
    // The cursor lands at the seam, which is where the text now joins.
    expect(after.anchor).toMatchObject({ blockId: 'b1', offset: 15 });
  });

  it('Backspace at the very start of the document does nothing', () => {
    const model = threeParagraphs();
    const after = deleteBackward(model, collapsed(point('b1', 0)));

    expect(model.blocks).toHaveLength(3);
    expect(after.anchor).toMatchObject({ blockId: 'b1', offset: 0 });
  });

  it('splitting a list item makes another item, not another block', () => {
    const model = new PaperModel({
      blocks: [{
        id: 'l1', kind: 'list',
        items: [{ level: 2, runs: [{ text: 'one two' }] }],
      }],
    });

    const after = splitBlock(model, collapsed(point('l1', 3, 0)));

    expect(model.blocks).toHaveLength(1);
    expect(model.block('l1').items).toHaveLength(2);
    // The new item keeps the level of the one it came from.
    expect(model.block('l1').items[1].level).toBe(2);
    expect(after.anchor).toMatchObject({ itemIndex: 1, offset: 0 });
  });
});

describe('Typing', () => {
  it('inserts at the cursor and moves it along', () => {
    const model = threeParagraphs();
    const after = insertText(model, collapsed(point('b1', 5)), 'XYZ');

    expect(runsText(model.block('b1').runs)).toBe('FirstXYZ paragraph');
    expect(after.anchor.offset).toBe(8);
  });

  it('typing over a selection replaces it', () => {
    const model = threeParagraphs();
    const after = insertText(model, across('b1', 0, 'b2', 6), 'New');

    expect(model.blocks).toHaveLength(2);
    expect(runsText(model.blocks[0].runs)).toBe('New paragraph');
    expect(after.anchor.offset).toBe(3);
  });

  it('inserted text can carry formatting, and merges with a like neighbour', () => {
    const model = new PaperModel({
      blocks: [{ id: 'b1', kind: 'paragraph', runs: [{ text: 'bold', bold: true }] }],
    });

    insertText(model, collapsed(point('b1', 4)), 'er', { bold: true });
    const runs = model.block('b1').runs;

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ text: 'bolder', bold: true });
  });
});
