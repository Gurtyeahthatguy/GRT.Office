/**
 * Review: changes recorded as marks on the text, put in (ins) or taken out (del), and comments anchored in it.
 * A change keeps no name and no date; a comment keeps its text, its replies and whether it is resolved.
 */

import { normaliseRuns, splitRuns, itemIndices, itemsOf, OBJECT } from './model.js';
import { point, collapsed, normalise, containersInRange, isCollapsed } from './selection.js';

let counter = 0;
/** A fresh id for a change or a comment, unlike any a file brought. */
export const freshId = (prefix) => `${prefix}${Date.now().toString(36)}${(counter += 1).toString(36)}`;

/** Every container of the document in reading order: paragraphs, list items, table cells. */
export function containers(model) {
  const out = [];
  for (const block of model.blocks) {
    if (itemsOf(block)) itemIndices(block).forEach((itemIndex) => out.push({ blockId: block.id, itemIndex }));
    else if (Array.isArray(block.runs)) out.push({ blockId: block.id, itemIndex: undefined });
  }
  return out;
}

const runsAt = (model, c) => {
  try {
    return model.runsOf(c.blockId, c.itemIndex) ?? [];
  } catch {
    return [];
  }
};

/** Marks a stretch of one container: text put in by this change goes, other text is marked as taken out. */
function markDeleted(runs, from, to, id) {
  const [before, rest] = splitRuns(runs, from);
  const [middle, after] = splitRuns(rest, to - from);
  const kept = middle.filter((run) => !run.ins).map((run) => (run.del ? run : { ...run, del: id }));
  return normaliseRuns([...before, ...kept, ...after]);
}

/** Deletes a range while recording: nothing leaves the text, it is marked; the caret goes to the range's start. */
export function trackedDeleteRange(model, selection) {
  if (isCollapsed(selection)) return selection.anchor;
  const { start, end } = normalise(selection, model);
  // Taking out the text beside a deletion goes on with that deletion, as one change.
  const id = deletionBeside(model, start, end) ?? freshId('d');
  for (const c of containersInRange(selection, model)) model.setRuns(c.blockId, markDeleted(runsAt(model, c), c.from, c.to, id), c.itemIndex);
  model.dirty = true;
  return start;
}

/** The id of a deletion that touches a range from before or after, if there is one. */
function deletionBeside(model, start, end) {
  const runAt = (at, offset) => {
    let seen = 0;
    for (const run of model.runsOf(at.blockId, at.itemIndex)) {
      if (offset >= seen && offset < seen + run.text.length) return run;
      seen += run.text.length;
    }
    return null;
  };
  const after = runAt(end, end.offset);
  if (after?.del && after.del !== true) return after.del;
  const before = start.offset > 0 ? runAt(start, start.offset - 1) : null;
  if (before?.del && before.del !== true) return before.del;
  return null;
}

/** Text taken out, character by character, skipping what is already marked as taken out. */
export function trackedDeleteStep(model, selection, direction) {
  if (!isCollapsed(selection)) return collapsed(trackedDeleteRange(model, selection));
  const at = selection.anchor;
  const runs = model.runsOf(at.blockId, at.itemIndex);
  const flags = [];
  for (const run of runs) for (let i = 0; i < run.text.length; i += 1) flags.push(Boolean(run.del));
  let offset = at.offset;
  if (direction < 0) {
    while (offset > 0 && flags[offset - 1]) offset -= 1;
    // Joining paragraphs is not recorded: at the start the caret only moves back.
    if (offset === 0) return selection;
    // The caret goes before the character, whether it is marked as taken out or, being one's own, really goes.
    const from = point(at.blockId, offset - 1, at.itemIndex);
    trackedDeleteRange(model, { anchor: from, focus: point(at.blockId, offset, at.itemIndex) });
    return collapsed(from);
  }
  while (offset < flags.length && flags[offset]) offset += 1;
  if (offset >= flags.length) return selection;
  const before = flags.length;
  trackedDeleteRange(model, { anchor: point(at.blockId, offset, at.itemIndex), focus: point(at.blockId, offset + 1, at.itemIndex) });
  const lost = before - model.runsOf(at.blockId, at.itemIndex).map((r) => r.text).join('').length;
  return collapsed(point(at.blockId, lost ? offset : offset + 1, at.itemIndex));
}

/** Text put in while recording carries the change it belongs to. */
export function trackedInsert(model, selection, text, marks = {}) {
  let at = selection;
  if (!isCollapsed(at)) at = collapsed(trackedDeleteRange(model, at));
  const where = at.anchor;
  const runs = model.runsOf(where.blockId, where.itemIndex);
  const [before, after] = splitRuns(runs, where.offset);
  // Typing on from a change of one's own continues it.
  const previous = before[before.length - 1];
  const id = previous?.ins && previous.ins !== true ? previous.ins : freshId('i');
  const { del: _gone, ...look } = marks;
  model.setRuns(where.blockId, [...before, { text, ...look, ins: id }, ...after], where.itemIndex);
  model.dirty = true;
  return collapsed(point(where.blockId, where.offset + text.length, where.itemIndex));
}

/**
 * The changes in the document, in reading order: each a stretch of text put in or taken out within one container.
 * @returns {{kind: 'insert'|'delete', id: string|true, blockId: string, itemIndex: any, from: number, to: number, text: string, note: ?string}[]}
 */
export function listChanges(model) {
  const out = [];
  for (const c of containers(model)) {
    let at = 0;
    let open = null;
    for (const run of runsAt(model, c)) {
      const kind = run.ins ? 'insert' : run.del ? 'delete' : null;
      const id = run.ins ?? run.del ?? null;
      if (open && (open.kind !== kind || open.id !== id)) {
        out.push(open);
        open = null;
      }
      if (kind) {
        if (!open) open = { kind, id, blockId: c.blockId, itemIndex: c.itemIndex, from: at, to: at, text: '', note: run.chgnote ?? null };
        open.to += run.text.length;
        open.text += run.object ? '' : run.text;
      }
      at += run.text.length;
    }
    if (open) out.push(open);
  }
  return out;
}

/** Settles one change: accepted, an insertion stays and a deletion goes; rejected, the other way round. */
export function settle(model, change, accept) {
  const runs = model.runsOf(change.blockId, change.itemIndex);
  const [before, rest] = splitRuns(runs, change.from);
  const [middle, after] = splitRuns(rest, change.to - change.from);
  const keep = (change.kind === 'insert') === accept;
  const settled = keep ? middle.map((run) => {
    const { ins: _i, del: _d, chgnote: _n, ...plain } = run;
    return plain;
  }) : [];
  model.setRuns(change.blockId, normaliseRuns([...before, ...settled, ...after]), change.itemIndex);
  model.dirty = true;
  return point(change.blockId, change.from + (keep ? change.to - change.from : 0), change.itemIndex);
}

/**
 * Rejects while recording: an insertion is marked as taken out, a deletion comes back as text put in,
 * so the rejection is itself a change to review.
 */
export function rejectButTrack(model, change) {
  const runs = model.runsOf(change.blockId, change.itemIndex);
  const [before, rest] = splitRuns(runs, change.from);
  const [middle, after] = splitRuns(rest, change.to - change.from);
  const id = freshId(change.kind === 'insert' ? 'd' : 'i');
  const turned = middle.map((run) => {
    const { ins: _i, del: _d, chgnote: _n, ...plain } = run;
    return change.kind === 'insert' ? { ...plain, del: id } : { ...plain, ins: id };
  });
  model.setRuns(change.blockId, normaliseRuns([...before, ...turned, ...after]), change.itemIndex);
  model.dirty = true;
  return point(change.blockId, change.to, change.itemIndex);
}

/** Sets the note on a change, every stretch of it. */
export function noteChange(model, change, note) {
  for (const c of containers(model)) {
    const runs = runsAt(model, c);
    if (!runs.some((run) => (run.ins ?? run.del) === change.id)) continue;
    model.setRuns(c.blockId, normaliseRuns(runs.map((run) => ((run.ins ?? run.del) === change.id ? { ...run, chgnote: note || undefined } : run))), c.itemIndex);
  }
  model.dirty = true;
}

// Comments

/** Every comment in reading order, with where its mark stands. */
export function listComments(model) {
  const out = [];
  for (const c of containers(model)) {
    let at = 0;
    for (const run of runsAt(model, c)) {
      if (run.object?.type === 'comment') out.push({ ...run.object, blockId: c.blockId, itemIndex: c.itemIndex, offset: at });
      at += run.text.length;
    }
  }
  return out;
}

/** Puts a comment at the start of the selection, the selected text marked as what it is about. */
export function addComment(model, selection, text) {
  const id = freshId('k');
  if (!isCollapsed(selection)) {
    for (const c of containersInRange(selection, model)) {
      const runs = runsAt(model, c);
      const [before, rest] = splitRuns(runs, c.from);
      const [middle, after] = splitRuns(rest, c.to - c.from);
      model.setRuns(c.blockId, normaliseRuns([...before, ...middle.map((run) => (run.object ? run : { ...run, cmt: id })), ...after]), c.itemIndex);
    }
  }
  const { start } = normalise(selection, model);
  const runs = model.runsOf(start.blockId, start.itemIndex);
  const [before, after] = splitRuns(runs, start.offset);
  model.setRuns(start.blockId, [...before, { text: OBJECT, object: { type: 'comment', id, text } }, ...after], start.itemIndex);
  model.dirty = true;
  return id;
}

/** Changes the comment with an id, or the reply with that id, through a function given the thread. */
export function updateComment(model, id, change) {
  for (const c of containers(model)) {
    const runs = runsAt(model, c);
    const index = runs.findIndex((run) => run.object?.type === 'comment' && (run.object.id === id || run.object.replies?.some((r) => r.id === id)));
    if (index < 0) continue;
    const thread = structuredClone(runs[index].object);
    const next = change(thread);
    const out = [...runs];
    if (next === null) {
      out.splice(index, 1);
      // The text the thread was about is no longer marked.
      for (const each of containers(model)) {
        const list = each.blockId === c.blockId && each.itemIndex === c.itemIndex ? out : runsAt(model, each);
        if (!list.some((run) => run.cmt === thread.id)) continue;
        const cleaned = list.map((run) => {
          if (run.cmt !== thread.id) return run;
          const { cmt: _c, ...rest } = run;
          return rest;
        });
        if (list === out) out.splice(0, out.length, ...cleaned);
        else model.setRuns(each.blockId, normaliseRuns(cleaned), each.itemIndex);
      }
    } else if (Array.isArray(next)) out.splice(index, 1, ...next.map((object) => ({ text: OBJECT, object })));
    else out[index] = { text: OBJECT, object: next };
    model.setRuns(c.blockId, normaliseRuns(out), c.itemIndex);
    model.dirty = true;
    return true;
  }
  return false;
}

export const replyTo = (model, id, text) => updateComment(model, id, (thread) => ({
  ...thread, replies: [...(thread.replies ?? []), { id: freshId('k'), text }],
}));

/** Marks the comment or reply with an id resolved, or not; the whole thread when asked. */
export const resolve = (model, id, done, { thread: whole = false } = {}) => updateComment(model, id, (thread) => {
  if (whole) return { ...thread, done, replies: (thread.replies ?? []).map((r) => ({ ...r, done })) };
  if (thread.id === id) return { ...thread, done };
  return { ...thread, replies: thread.replies.map((r) => (r.id === id ? { ...r, done } : r)) };
});

/** Takes away one comment: a reply alone, or a thread's first comment, its replies then standing on their own. */
export const deleteOne = (model, id) => updateComment(model, id, (thread) => {
  if (thread.id !== id) return { ...thread, replies: thread.replies.filter((r) => r.id !== id) };
  const [first, ...rest] = thread.replies ?? [];
  return first ? { type: 'comment', id: thread.id, text: first.text, ...(first.done ? { done: true } : {}), ...(rest.length ? { replies: rest } : {}) } : null;
});

export const deleteThread = (model, id) => updateComment(model, id, () => null);

/** A reply made into a comment of its own, at the same place, after its thread. */
export const promote = (model, id) => updateComment(model, id, (thread) => {
  const reply = thread.replies?.find((r) => r.id === id);
  if (!reply) return thread;
  return [{ ...thread, replies: thread.replies.filter((r) => r.id !== id) }, { type: 'comment', id: freshId('k'), text: reply.text, ...(reply.done ? { done: true } : {}) }];
});

export function deleteAllComments(model) {
  for (const c of containers(model)) {
    const runs = runsAt(model, c);
    if (!runs.some((run) => run.object?.type === 'comment' || run.cmt)) continue;
    model.setRuns(c.blockId, normaliseRuns(runs.filter((run) => run.object?.type !== 'comment').map((run) => {
      const { cmt: _c, ...rest } = run;
      return rest;
    })), c.itemIndex);
  }
  model.dirty = true;
}

export { collapsed, point };
