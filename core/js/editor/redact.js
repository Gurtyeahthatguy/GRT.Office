/** Redaction in a text document: stretches marked to be covered, and a copy in which they are gone for good. */

import { normaliseRuns, splitRuns, itemsOf } from './model.js';
import { containersInRange } from './selection.js';
import { containers } from './review.js';
import { findSensitive, REDACTED } from '../sensitive.js';

const runsAt = (model, c) => model.runsOf(c.blockId, c.itemIndex) ?? [];

/** Marks the selection to be covered, or uncovers it when it all is. */
export function toggleRedact(model, selection) {
  const parts = containersInRange(selection, model);
  const covered = parts.every((c) => {
    const [, rest] = splitRuns(runsAt(model, c), c.from);
    const [middle] = splitRuns(rest, c.to - c.from);
    return middle.every((run) => run.redact || run.text === '');
  });
  for (const c of parts) {
    const [before, rest] = splitRuns(runsAt(model, c), c.from);
    const [middle, after] = splitRuns(rest, c.to - c.from);
    const changed = middle.map((run) => {
      if (covered) {
        const { redact: _r, ...plain } = run;
        return plain;
      }
      return run.object ? run : { ...run, redact: true };
    });
    model.setRuns(c.blockId, normaliseRuns([...before, ...changed, ...after]), c.itemIndex);
  }
  model.dirty = true;
  return selection;
}

/** Marks every stretch the finder finds, in every paragraph, item and cell; how many it marked. */
export function autoRedact(model, kinds, extra = []) {
  let count = 0;
  for (const c of containers(model)) {
    const runs = runsAt(model, c);
    const text = runs.map((r) => r.text).join('');
    const found = findSensitive(text, kinds, extra);
    if (found.length === 0) continue;
    let out = runs;
    for (const hit of found) {
      const [before, rest] = splitRuns(out, hit.from);
      const [middle, after] = splitRuns(rest, hit.to - hit.from);
      out = normaliseRuns([...before, ...middle.map((run) => (run.object ? run : { ...run, redact: true })), ...after]);
      count += 1;
    }
    model.setRuns(c.blockId, out, c.itemIndex);
  }
  if (count) model.dirty = true;
  return count;
}

/** Runs as a redacted copy has them: covered text replaced, the same mark every time, and nothing left to give it away. */
function cleanRuns(runs) {
  const out = [];
  for (const run of runs ?? []) {
    // Text taken out by a recorded change is still in a file; in a copy to share it goes.
    if (run.del) continue;
    const { ins: _i, chgnote: _n, cmt: _c, ...rest } = run;
    if (rest.object?.type === 'comment') continue;
    if (rest.object?.type === 'note') {
      out.push({ ...rest, object: { ...rest.object, runs: cleanRuns(rest.object.runs) } });
      continue;
    }
    if (rest.redact) {
      const { redact: _r, ...look } = rest;
      const last = out[out.length - 1];
      // Covered stretches side by side stand for one, so their number tells nothing either.
      if (!(last?.text === REDACTED && last.redacted)) out.push({ ...look, object: undefined, text: REDACTED, redacted: true });
      continue;
    }
    out.push(rest);
  }
  return normaliseRuns(out.map(({ redacted: _x, ...run }) => run));
}

/**
 * The document as a copy to share: covered text replaced by blocks, tracked deletions and comments gone,
 * insertions kept as plain text. The document itself is left as it is.
 */
export function redactedCopy(json) {
  const copy = structuredClone(json);
  for (const block of copy.blocks ?? []) {
    if (Array.isArray(block.runs)) block.runs = cleanRuns(block.runs);
    if (Array.isArray(block.caption)) block.caption = cleanRuns(block.caption);
    for (const item of itemsOf(block) ?? []) item.runs = cleanRuns(item.runs);
  }
  if (copy.review) copy.review = { recording: false, protect: null };
  return copy;
}

/** How many stretches are covered in a document. */
export function redactedCount(model) {
  let count = 0;
  for (const c of containers(model)) {
    let open = false;
    for (const run of runsAt(model, c)) {
      if (run.redact && !open) count += 1;
      open = Boolean(run.redact);
    }
  }
  return count;
}
