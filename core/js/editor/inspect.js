/** The document inspector for text documents: what a file carries besides its text, and a copy without it. */

import { DocumentModel, normaliseRuns, itemsOf } from './model.js';
import { listChanges, listComments, settle } from './review.js';
import { runListsOf } from './fields.js';
import { redactedCopy, redactedCount } from './redact.js';

const allRuns = (model) => model.blocks.flatMap((block) => [...runListsOf(block)].flatMap(({ runs }) => runs));

/** What the document carries that whoever receives it may not expect. */
export function textFindings(json) {
  const model = new DocumentModel(json);
  const runs = allRuns(model);
  const comments = listComments(model);
  const links = runs.filter((r) => r.link && !r.link.startsWith('#'));
  const hosts = [...new Set(links.map((r) => {
    try { return new URL(r.link).hostname || r.link; } catch { return r.link; }
  }))];
  return [
    { id: 'comments', label: 'Comments', count: comments.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0), detail: 'Threads and their replies' },
    { id: 'changes', label: 'Recorded changes', count: listChanges(model).length, detail: 'Left out by accepting them: the copy has the text as it reads now, and none of what was taken out' },
    { id: 'redact', label: 'Text marked to be covered', count: redactedCount(model), detail: 'Covered with black blocks in the copy' },
    { id: 'links', label: 'Links to web addresses', count: links.length, detail: hosts.slice(0, 6).join(', '), keep: true },
    { id: 'paths', label: 'Paths of the spreadsheets charts are linked to', count: model.blocks.filter((b) => b.link?.path).length, detail: 'Full paths name your folders; the copy keeps the charts as they are now' },
    { id: 'protect', label: 'Password guarding the recording of changes', count: model.review?.protect ? 1 : 0, detail: 'A hash of it is in the file' },
  ];
}

/** The copy without what was chosen; the JSON given is not changed. */
export function cleanTextCopy(json, out) {
  let copy = structuredClone(json);
  if (out.includes('changes')) {
    const model = new DocumentModel(copy);
    for (const change of listChanges(model).reverse()) settle(model, change, true);
    copy = model.toJSON();
  }
  if (out.includes('redact')) copy = redactedCopy(copy);
  const clean = (runs) => normaliseRuns((runs ?? []).filter((r) => !(out.includes('comments') && r.object?.type === 'comment')).map((run) => {
    const next = { ...run };
    if (out.includes('comments')) delete next.cmt;
    if (out.includes('links') && next.link && !next.link.startsWith('#')) delete next.link;
    if (next.object?.type === 'note') next.object = { ...next.object, runs: clean(next.object.runs) };
    return next;
  }));
  for (const block of copy.blocks ?? []) {
    if (out.includes('paths') && block.link?.path) delete block.link;
    if (Array.isArray(block.runs)) block.runs = clean(block.runs);
    if (Array.isArray(block.caption)) block.caption = clean(block.caption);
    for (const item of itemsOf(block) ?? []) item.runs = clean(item.runs);
  }
  if (out.includes('protect') || out.includes('changes')) copy.review = { recording: false, protect: null };
  return copy;
}
