/** Every change the document can undergo. */

import {
  normaliseRuns, splitRuns, sliceRuns, formatRuns, runsLength, makeBlock,
} from './model.js';
import {
  point, collapsed, normalise, containersInRange, isCollapsed, lengthOf,
  backward, endOfPrevious,
} from './selection.js';

/**
 * Inserts text at a collapsed selection, or over a range.
 * @param {DocumentModel} model
 * @param {Object} selection
 * @param {string} text
 * @param {Object} [marks] formatting for the inserted text
 * @returns {Object} the selection afterwards
 */
export function insertText(model, selection, text, marks = {}) {
  let at = selection;
  if (!isCollapsed(at)) at = collapsed(deleteRange(model, at));

  const where = at.anchor;
  const runs = model.runsOf(where.blockId, where.itemIndex);
  const [before, after] = splitRuns(runs, where.offset);

  model.setRuns(
    where.blockId,
    [...before, { text, ...marks }, ...after],
    where.itemIndex,
  );

  return collapsed(point(where.blockId, where.offset + text.length, where.itemIndex));
}

/**
 * Deletes everything the selection covers.
 * @returns {Object} the position the cursor ends at
 */
export function deleteRange(model, selection) {
  if (isCollapsed(selection)) return selection.anchor;

  const { start, end } = normalise(selection, model);
  const containers = containersInRange(selection, model);
  if (containers.length === 0) return start;

  // Within one container it is a straight cut.
  if (containers.length === 1) {
    const only = containers[0];
    const runs = model.runsOf(only.blockId, only.itemIndex);
    const [before] = splitRuns(runs, only.from);
    const [, after] = splitRuns(runs, only.to);
    model.setRuns(only.blockId, [...before, ...after], only.itemIndex);
    return point(only.blockId, only.from, only.itemIndex);
  }

  const first = containers[0];
  const last = containers[containers.length - 1];

  const head = splitRuns(model.runsOf(first.blockId, first.itemIndex), first.from)[0];
  const tail = splitRuns(model.runsOf(last.blockId, last.itemIndex), last.to)[1];

  // Blocks strictly between the ends go entirely.
  const startIndex = model.indexOf(start.blockId);
  const endIndex = model.indexOf(end.blockId);
  const doomed = model.blocks.slice(startIndex + 1, endIndex).map((b) => b.id);

  const firstBlock = model.block(first.blockId);
  const lastBlock = model.block(last.blockId);

  if (firstBlock?.kind === 'list' && lastBlock === firstBlock) {
    // Inside one list: keep the first item, drop the ones the range
    // swallowed.
    firstBlock.items[first.itemIndex].runs = normaliseRuns([...head, ...tail]);
    firstBlock.items.splice(first.itemIndex + 1, last.itemIndex - first.itemIndex);
  } else {
    model.setRuns(first.blockId, [...head, ...tail], first.itemIndex);

    for (const id of doomed) model.removeBlock(id);
    if (lastBlock && lastBlock !== firstBlock) {
      // The tail has been carried into the first block, so the last one goes.
      if (lastBlock.kind === 'list' && lastBlock.items.length > (last.itemIndex ?? 0) + 1) {
        lastBlock.items.splice(0, (last.itemIndex ?? 0) + 1);
      } else {
        model.removeBlock(lastBlock.id);
      }
    }
  }

  model.dirty = true;
  return point(first.blockId, first.from, first.itemIndex);
}

/** Deletes one character backwards, or the selection if there is one. */
export function deleteBackward(model, selection) {
  if (!isCollapsed(selection)) return collapsed(deleteRange(model, selection));

  const at = selection.anchor;
  if (at.offset > 0) {
    const from = point(at.blockId, at.offset - 1, at.itemIndex);
    return collapsed(deleteRange(model, { anchor: from, focus: at }));
  }

  const previous = endOfPrevious(at, model);
  if (!previous) return selection;

  return collapsed(mergeBackward(model, at, previous));
}

/** Deletes one character forwards, or the selection. */
export function deleteForward(model, selection) {
  if (!isCollapsed(selection)) return collapsed(deleteRange(model, selection));

  const at = selection.anchor;
  const block = model.block(at.blockId);
  const length = lengthOf(model, block, at.itemIndex);

  if (at.offset < length) {
    const to = point(at.blockId, at.offset + 1, at.itemIndex);
    return collapsed(deleteRange(model, { anchor: at, focus: to }));
  }

  // At the end: pull the next container up into this one.
  const runs = model.runsOf(at.blockId, at.itemIndex);
  const nextBlock = model.blocks[model.indexOf(at.blockId) + 1];

  if (block?.kind === 'list' && (at.itemIndex ?? 0) < block.items.length - 1) {
    const next = block.items[at.itemIndex + 1];
    block.items[at.itemIndex].runs = normaliseRuns([...runs, ...next.runs]);
    block.items.splice(at.itemIndex + 1, 1);
    model.dirty = true;
    return selection;
  }

  if (!nextBlock || nextBlock.kind === 'image') return selection;

  const nextRuns = nextBlock.kind === 'list'
    ? nextBlock.items[0].runs
    : nextBlock.runs;

  model.setRuns(at.blockId, [...runs, ...nextRuns], at.itemIndex);

  if (nextBlock.kind === 'list' && nextBlock.items.length > 1) nextBlock.items.shift();
  else model.removeBlock(nextBlock.id);

  return selection;
}

/**
 * Joins a container into the one before it, leaving the cursor at the seam.
 */
function mergeBackward(model, at, previous) {
  const block = model.block(at.blockId);
  const runs = model.runsOf(at.blockId, at.itemIndex);

  if (block?.kind === 'list' && (at.itemIndex ?? 0) > 0) {
    const target = block.items[at.itemIndex - 1];
    const seam = runsLength(target.runs);
    target.runs = normaliseRuns([...target.runs, ...runs]);
    block.items.splice(at.itemIndex, 1);
    model.dirty = true;
    return point(block.id, seam, at.itemIndex - 1);
  }

  const previousBlock = model.block(previous.blockId);
  if (!previousBlock) return at;

  // Backspace at the start of a paragraph that follows an image removes the
  // image rather than trying to merge text into it.
  if (previousBlock.kind === 'image') {
    model.removeBlock(previousBlock.id);
    return point(at.blockId, 0, at.itemIndex);
  }

  const seam = lengthOf(model, previousBlock, previous.itemIndex);
  const previousRuns = model.runsOf(previous.blockId, previous.itemIndex);
  model.setRuns(previous.blockId, [...previousRuns, ...runs], previous.itemIndex);

  if (block.kind === 'list' && block.items.length > 1) block.items.splice(at.itemIndex, 1);
  else model.removeBlock(block.id);

  return point(previous.blockId, seam, previous.itemIndex);
}

/** Splits a block at the cursor. */
export function splitBlock(model, selection) {
  let at = selection;
  if (!isCollapsed(at)) at = collapsed(deleteRange(model, at));

  const where = at.anchor;
  const block = model.block(where.blockId);
  if (!block) return at;

  const runs = model.runsOf(where.blockId, where.itemIndex);
  const [before, after] = splitRuns(runs, where.offset);

  if (block.kind === 'list') {
    block.items[where.itemIndex].runs = normaliseRuns(before);
    block.items.splice(where.itemIndex + 1, 0, {
      level: block.items[where.itemIndex].level,
      runs: normaliseRuns(after),
    });
    model.dirty = true;
    return collapsed(point(block.id, 0, where.itemIndex + 1));
  }

  model.setRuns(block.id, before, null);

  const kind = block.kind === 'heading' ? 'paragraph' : block.kind;
  const created = model.insertBlock(
    { ...makeBlock(kind), style: kind === block.kind ? block.style : 'body', align: block.align },
    model.indexOf(block.id) + 1,
  );
  created.runs = normaliseRuns(after);

  return collapsed(point(created.id, 0));
}

/** Applies or toggles a mark across the selection. */
export function applyFormat(model, selection, mark, value = null) {
  if (isCollapsed(selection)) return selection;

  // Decided once for the whole range.
  const containers = containersInRange(selection, model);
  const decided = value !== null ? value : !containers.every((c) => {
    const runs = sliceRuns(model.runsOf(c.blockId, c.itemIndex), c.from, c.to);
    return runs.every((run) => !!run[mark]);
  });

  for (const container of containers) {
    if (container.from === container.to) continue;
    const runs = model.runsOf(container.blockId, container.itemIndex);
    model.setRuns(
      container.blockId,
      formatRuns(runs, container.from, container.to, mark, decided),
      container.itemIndex,
    );
  }

  return selection;
}

/** Whether every character in the selection already carries a mark. */
export function hasFormat(model, selection, mark) {
  if (isCollapsed(selection)) return false;
  return containersInRange(selection, model).every((c) => {
    if (c.from === c.to) return true;
    const runs = sliceRuns(model.runsOf(c.blockId, c.itemIndex), c.from, c.to);
    return runs.every((run) => !!run[mark]);
  });
}

/** Sets the kind and style of every block the selection touches. */
export function setBlockKind(model, selection, kind, options = {}) {
  const touched = blocksInRange(model, selection);
  for (const id of touched) model.setBlockKind(id, kind, options);
  return selection;
}

export function setBlockStyle(model, selection, style) {
  for (const id of blocksInRange(model, selection)) model.setBlockStyle(id, style);
  return selection;
}

export function setAlign(model, selection, align) {
  for (const id of blocksInRange(model, selection)) model.setAlign(id, align);
  return selection;
}

export function blocksInRange(model, selection) {
  const { start, end } = normalise(selection, model);
  const from = model.indexOf(start.blockId);
  const to = model.indexOf(end.blockId);
  if (from === -1 || to === -1) return [];
  return model.blocks.slice(from, to + 1).map((b) => b.id);
}

/** Indents or outdents list items in the selection. */
export function indentList(model, selection, delta) {
  for (const container of containersInRange(selection, model)) {
    const block = model.block(container.blockId);
    if (block?.kind !== 'list') continue;
    const item = block.items[container.itemIndex ?? 0];
    if (item) item.level = Math.max(0, Math.min(item.level + delta, 5));
  }
  model.dirty = true;
  return selection;
}

/** Inserts a block that is not text. */
export function insertBlockAt(model, selection, block) {
  const at = isCollapsed(selection) ? selection.anchor : deleteRange(model, selection);
  const index = model.indexOf(at.blockId);

  const created = model.insertBlock(block, index + 1);
  if (model.indexOf(created.id) === model.blocks.length - 1) {
    model.insertBlock(makeBlock('paragraph'), model.blocks.length);
  }

  const next = model.blocks[model.indexOf(created.id) + 1];
  return collapsed(point(next ? next.id : created.id, 0));
}

/** Replaces the selection with pasted content. */
export function insertBlocks(model, selection, blocks) {
  if (blocks.length === 0) return selection;

  let at = selection;
  if (!isCollapsed(at)) at = collapsed(deleteRange(model, at));

  // A single paragraph pastes as text, so pasting mid-sentence does not break
  // the paragraph in two.
  if (blocks.length === 1 && blocks[0].kind === 'paragraph') {
    return insertRuns(model, at, blocks[0].runs);
  }

  const where = at.anchor;
  const tailSelection = splitBlock(model, at);
  let index = model.indexOf(tailSelection.anchor.blockId);
  let last = null;

  for (const block of blocks) {
    last = model.insertBlock(structuredClone(block), index);
    index += 1;
  }

  // The split left an empty block behind if the cursor was at the very start.
  const original = model.block(where.blockId);
  if (original && runsLength(original.runs ?? []) === 0 && original.kind === 'paragraph') {
    model.removeBlock(original.id);
  }

  return collapsed(point(last.id, runsLength(last.runs ?? [])));
}

/** Inserts formatted runs at a collapsed selection. */
export function insertRuns(model, selection, runs) {
  const where = selection.anchor;
  const existing = model.runsOf(where.blockId, where.itemIndex);
  const [before, after] = splitRuns(existing, where.offset);
  const added = normaliseRuns(runs);

  model.setRuns(where.blockId, [...before, ...added, ...after], where.itemIndex);

  return collapsed(point(
    where.blockId,
    where.offset + runsLength(added),
    where.itemIndex,
  ));
}
