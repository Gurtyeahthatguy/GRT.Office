/** Writer's list commands: levels and moves with or without the items under them, unnumbered entries, restarts, and going by level. */

import { normaliseRuns } from './model.js';
import { point, collapsed, containersInRange } from './selection.js';

/** The list and the run of its items the selection covers, or null outside a list. */
function chosenItems(model, selection) {
  const inList = containersInRange(selection, model).filter((c) => model.block(c.blockId)?.kind === 'list');
  if (inList.length === 0) return null;
  const block = model.block(inList[0].blockId);
  const indices = inList.filter((c) => c.blockId === block.id).map((c) => c.itemIndex ?? 0);
  return { block, first: Math.min(...indices), last: Math.max(...indices) };
}

/** Where a group ends: the item, then those after it deeper than it. */
function groupEnd(items, index) {
  let end = index;
  while (end + 1 < items.length && items[end + 1].level > items[index].level) end += 1;
  return end;
}

/** The same selection, its items now at other indices. */
function moved(selection, blockId, shift) {
  const at = (p) => (p.blockId === blockId ? point(p.blockId, p.offset, (p.itemIndex ?? 0) + shift) : p);
  return { anchor: at(selection.anchor), focus: at(selection.focus) };
}

/** Demotes (1) or promotes (-1) the chosen items, and with subpoints the items under them too. */
export function shiftLevel(model, selection, delta, { withSub = false } = {}) {
  const chosen = chosenItems(model, selection);
  if (!chosen) return selection;
  const { block, first } = chosen;
  const last = withSub ? groupEnd(block.items, chosen.last) : chosen.last;
  // A group moves only as far as each of its items can, so it keeps its shape.
  const room = delta > 0
    ? Math.min(...block.items.slice(first, last + 1).map((item) => 5 - item.level))
    : Math.min(...block.items.slice(first, last + 1).map((item) => item.level));
  const step = Math.sign(delta) * Math.min(Math.abs(delta), room);
  if (step === 0) return selection;
  for (let i = first; i <= last; i += 1) block.items[i].level += step;
  model.dirty = true;
  return selection;
}

/** Moves the chosen items one place up (-1) or down (1); with subpoints, past the whole neighbouring group. */
export function moveItems(model, selection, direction, { withSub = false } = {}) {
  const chosen = chosenItems(model, selection);
  if (!chosen) return selection;
  const { block, first } = chosen;
  const items = block.items;
  const last = withSub ? groupEnd(items, chosen.last) : chosen.last;
  const group = items.slice(first, last + 1);
  let target;
  if (direction < 0) {
    if (first === 0) return selection;
    if (!withSub) target = first - 1;
    else {
      // The neighbour above is the nearest item at the group's level or higher, with what lies under it.
      target = first - 1;
      while (target > 0 && items[target].level > items[first].level) target -= 1;
    }
    items.splice(first, group.length);
    items.splice(target, 0, ...group);
    model.dirty = true;
    return moved(selection, block.id, target - first);
  }
  if (last + 1 >= items.length) return selection;
  const after = withSub ? groupEnd(items, last + 1) : last + 1;
  const passed = after - last;
  items.splice(first, group.length);
  items.splice(first + passed, 0, ...group);
  model.dirty = true;
  return moved(selection, block.id, passed);
}

/** Marks the chosen items as shown without a number or bullet, or with one again. */
export function toggleUnnumbered(model, selection) {
  const chosen = chosenItems(model, selection);
  if (!chosen) return selection;
  const items = chosen.block.items.slice(chosen.first, chosen.last + 1);
  const on = !items.every((item) => item.unnumbered);
  for (const item of items) {
    if (on) item.unnumbered = true;
    else delete item.unnumbered;
  }
  model.dirty = true;
  return selection;
}

/** Numbering starts again from the item the caret is in, or goes on as before. */
export function toggleRestart(model, selection) {
  const chosen = chosenItems(model, selection);
  if (!chosen) return selection;
  const item = chosen.block.items[chosen.first];
  if (item.restart) delete item.restart;
  else item.restart = true;
  model.dirty = true;
  return selection;
}

/** The paragraphs chosen join the list just before them, as its last items. */
export function addToList(model, selection) {
  const containers = containersInRange(selection, model);
  const firstBlock = model.block(containers[0]?.blockId);
  if (!firstBlock || firstBlock.kind === 'list') return selection;
  const index = model.indexOf(firstBlock.id);
  const list = model.blocks[index - 1];
  if (list?.kind !== 'list') return null;
  const ids = [...new Set(containers.map((c) => c.blockId))].filter((id) => {
    const block = model.block(id);
    return block && Array.isArray(block.runs) && ['paragraph', 'heading', 'quote'].includes(block.kind);
  });
  const start = list.items.length;
  for (const id of ids) {
    list.items.push({ level: list.items[list.items.length - 1]?.level ?? 0, runs: normaliseRuns(model.block(id).runs) });
    model.removeBlock(id);
  }
  model.dirty = true;
  return collapsed(point(list.id, selection.focus.offset ?? 0, start));
}

/** The caret goes to the next (1) or previous (-1) item at the same level, within its list. */
export function stepInLevel(model, selection, direction) {
  const chosen = chosenItems(model, selection);
  if (!chosen) return selection;
  const { block } = chosen;
  const from = direction > 0 ? chosen.last : chosen.first;
  const level = block.items[from].level;
  for (let i = from + direction; i >= 0 && i < block.items.length; i += direction) {
    if (block.items[i].level < level) break;
    if (block.items[i].level === level) return collapsed(point(block.id, 0, i));
  }
  return selection;
}
