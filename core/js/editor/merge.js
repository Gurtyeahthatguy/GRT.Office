/** Mail merge: a document's merge fields filled from one record of a table, as a new document; nothing is written to disk. */

import { normaliseRuns, itemsOf } from './model.js';
import { shownValue } from '../sources.js';

/** The names of the merge fields a document uses. */
export function mergeFields(json) {
  const names = new Set();
  const visit = (runs) => { for (const run of runs ?? []) if (run.object?.type === 'merge') names.add(run.object.name); };
  for (const block of json.blocks ?? []) {
    visit(block.runs);
    for (const item of itemsOf(block) ?? []) visit(item.runs);
  }
  return [...names];
}

/**
 * The document with each merge field replaced by the value of its column in a record, in the field's look.
 * A field whose column the table lacks is left empty.
 */
export function mergeRecord(json, columns, row) {
  const at = new Map(columns.map((name, i) => [String(name).trim().toLowerCase(), i]));
  const fill = (runs) => normaliseRuns((runs ?? []).map((run) => {
    if (run.object?.type !== 'merge') return run;
    const { object, ...look } = run;
    const index = at.get(object.name.trim().toLowerCase());
    return { ...look, text: index === undefined ? '' : shownValue(row[index]) };
  }));
  const copy = structuredClone(json);
  for (const block of copy.blocks ?? []) {
    if (Array.isArray(block.runs)) block.runs = fill(block.runs);
    for (const item of itemsOf(block) ?? []) item.runs = fill(item.runs);
  }
  return copy;
}
