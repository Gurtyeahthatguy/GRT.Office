// @vitest-environment jsdom

/** Compare and merge: differences between two versions written as recorded changes, word by word. */

import { describe, it, expect } from 'vitest';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { compareInto, diffRuns, commonPairs } from '../src/js/core/editor/compare.js';
import { listChanges, settle } from '../src/js/core/editor/review.js';

const doc = (...texts) => {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: texts.map((text, i) => ({ id: `b${i}`, kind: 'paragraph', style: 'body', align: 'left', runs: [{ text }] })) });
  return model;
};
const text = (model) => model.blocks.map((b) => (b.runs ?? []).map((r) => r.text).join(''));
const final = (model) => {
  for (const change of listChanges(model).reverse()) settle(model, change, true);
  return text(model).filter((t) => t !== '');
};
const original = (model) => {
  for (const change of listChanges(model).reverse()) settle(model, change, false);
  return text(model).filter((t) => t !== '');
};

describe('comparing', () => {
  it('pairs what two lists share', () => {
    expect(commonPairs(['a', 'b', 'c', 'd'], ['b', 'x', 'd'])).toEqual([[1, 0], [3, 2]]);
  });

  it('marks words, not letters', () => {
    const runs = diffRuns([{ text: 'The quick brown fox' }], [{ text: 'The slow brown fox', bold: true }], { ins: 'i', del: 'd' });
    expect(runs.filter((r) => r.del).map((r) => r.text)).toEqual(['quick']);
    expect(runs.filter((r) => r.ins).map((r) => r.text)).toEqual(['slow']);
  });

  it('shows what changed from an older version, and accepting gives this one, rejecting the older', () => {
    const older = ['Title', 'One paragraph that stays.', 'A paragraph that was cut.', 'Words that were changed here.'];
    const newer = ['Title', 'A paragraph that is new.', 'One paragraph that stays.', 'Words that are changed here.'];
    const model = doc(...newer);
    const counts = compareInto(model, doc(...older).toJSON(), 'compare');
    expect(counts.deleted).toBe(1);
    expect(final(structuredClone(model) instanceof DocumentModel ? model : model)).toEqual(newer);
    const again = doc(...newer);
    compareInto(again, doc(...older).toJSON(), 'compare');
    expect(original(again)).toEqual(older);
  });

  it('merges a newer copy in as changes to this one', () => {
    const model = doc('Alpha', 'Beta');
    compareInto(model, doc('Alpha', 'Beta gamma', 'Delta').toJSON(), 'merge');
    expect(listChanges(model).map((c) => [c.kind, c.text])).toEqual([['insert', ' gamma'], ['insert', 'Delta']]);
    expect(final(model)).toEqual(['Alpha', 'Beta gamma', 'Delta']);
  });

  it('finds nothing between a document and itself', () => {
    const model = doc('Same', 'text');
    compareInto(model, doc('Same', 'text').toJSON());
    expect(listChanges(model)).toEqual([]);
  });
});
