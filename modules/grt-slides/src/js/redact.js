/** Redaction in a presentation: text and table cells marked to be covered, and a copy to share without them, notes or comments. */

import { findSensitive, REDACTED } from './core/sensitive.js';
import { formatPart } from './paragraphs.js';
import { normaliseTable } from './tables.js';

const textOf = (element) => (element.content ?? []).map((r) => r.text).join('');

/** Marks what the finder flags on every slide: stretches of text boxes, whole table cells. How many. */
export function autoRedactSlides(model, kinds, extra = []) {
  let count = 0;
  for (const slide of model.slides) {
    for (const element of slide.elements ?? []) {
      if (element.kind === 'text') {
        let content = element.content;
        for (const hit of findSensitive(textOf(element), kinds, extra)) {
          content = formatPart(content, hit.from, hit.to, 'redact', true);
          count += 1;
        }
        if (content !== element.content) model.setContent(slide.id, element.id, content, element.paras ?? null);
      } else if (element.kind === 'table') {
        element.cells.forEach((row, r) => row.forEach((cell, c) => {
          if (findSensitive(cell, kinds, extra).length === 0) return;
          const key = `${r},${c}`;
          element.redact = [...new Set([...(element.redact ?? []), key])];
          count += 1;
        }));
      }
    }
  }
  if (count) model.dirty = true;
  return count;
}

/** Text runs as the copy has them: each covered stretch one same black mark, no links. */
function cleanRuns(runs) {
  const out = [];
  for (const run of runs ?? []) {
    if (!run.redact) {
      out.push(run);
      continue;
    }
    const { redact: _r, link: _l, ...look } = run;
    // A line break inside a covered stretch stays, so the lines around it stay where they were.
    const pieces = run.text.split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) out.push({ text: '\n' });
      if (piece === '') return;
      const last = out[out.length - 1];
      if (!(last && last.text === REDACTED)) out.push({ ...look, text: REDACTED });
    });
  }
  return out;
}

/** The copy to share: covered text and cells replaced, speaker notes and comments left out. The presentation is not changed. */
export function redactedPresentation(json) {
  const copy = structuredClone(json);
  for (const slide of copy.slides ?? []) {
    slide.notes = '';
    delete slide.comments;
    for (const element of slide.elements ?? []) {
      if (element.kind === 'text') element.content = cleanRuns(element.content);
      if (element.kind === 'table') {
        for (const key of element.redact ?? []) {
          const [r, c] = key.split(',').map(Number);
          if (element.cells[r]?.[c] !== undefined) element.cells[r][c] = REDACTED;
        }
        delete element.redact;
      }
    }
  }
  return copy;
}

/** Marks the chosen cells of a table to be covered, or uncovers them when all are. */
export function toggleCells(element, area) {
  const keys = [];
  for (let r = area.top; r <= area.bottom; r += 1) for (let c = area.left; c <= area.right; c += 1) keys.push(`${r},${c}`);
  const set = new Set(element.redact ?? []);
  const all = keys.every((k) => set.has(k));
  for (const k of keys) {
    if (all) set.delete(k);
    else set.add(k);
  }
  if (set.size) element.redact = [...set];
  else delete element.redact;
  normaliseTable(element);
  return true;
}

export const redactedCount = (model) => model.slides.reduce((sum, slide) => sum + (slide.elements ?? []).reduce((n, e) => {
  if (e.kind === 'table') return n + (e.redact?.length ?? 0);
  if (e.kind === 'text') return n + (e.content ?? []).filter((r) => r.redact).length;
  return n;
}, 0), 0);
