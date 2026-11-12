// @vitest-environment jsdom

/** AutoCorrect over written text, plain or as changes to review, and the settings it is kept in. */

import { describe, it, expect } from 'vitest';
import { DocumentModel, makeBlock, runsText } from '../src/js/core/editor/model.js';
import { point } from '../src/js/core/editor/selection.js';
import { settle, listChanges } from '../src/js/core/editor/review.js';
import {
  applyToDocument, autocorrectSettings, parseTableText, cleanAutoText, autoTextBefore, selectedText,
} from '../src/js/core/autocorrect-ui.js';
import { DEFAULT_REPLACEMENTS } from '../src/js/core/autocorrect.js';

function documentOf(...texts) {
  const model = new DocumentModel();
  model.blocks = texts.map((text) => {
    const block = makeBlock('paragraph');
    block.runs = [{ text }];
    return block;
  });
  return model;
}
const texts = (model) => model.blocks.map((b) => runsText(b.runs ?? []));
const rules = autocorrectSettings(null);

describe('applying AutoCorrect to written text', () => {
  it('corrects every paragraph, list item and table cell, and leaves code alone', () => {
    const model = documentOf('teh end. next', '"quoted"');
    const list = makeBlock('list');
    list.items = [{ runs: [{ text: 'adn (c)' }] }];
    const code = makeBlock('code');
    code.runs = [{ text: 'x = "teh"' }];
    model.blocks.push(list, code);
    const result = applyToDocument(model, null, rules);
    expect(result).toEqual({ changed: 3, skipped: 0 });
    expect(texts(model).slice(0, 2)).toEqual(['The end. Next', '“Quoted”']);
    expect(runsText(list.items[0].runs)).toBe('And ©');
    expect(runsText(code.runs)).toBe('x = "teh"');
  });

  it('corrects only the selected paragraphs when there is a selection', () => {
    const model = documentOf('teh one', 'teh two');
    const [, second] = model.blocks;
    applyToDocument(model, { anchor: point(second.id, 0), focus: point(second.id, 3) }, rules);
    expect(texts(model)).toEqual(['teh one', 'The two']);
  });

  it('records its corrections as changes that can be rejected', () => {
    const model = documentOf('teh cat');
    const result = applyToDocument(model, null, rules, { track: true });
    expect(result.changed).toBe(1);
    expect(listChanges(model).length).toBeGreaterThan(0);
    const kept = structuredClone(model.blocks);
    const settleAll = (accept) => {
      for (let change = listChanges(model).at(-1); change; change = listChanges(model).at(-1)) settle(model, change, accept);
    };
    settleAll(false);
    expect(texts(model)).toEqual(['teh cat']);
    model.blocks = kept;
    settleAll(true);
    expect(texts(model)).toEqual(['The cat']);
  });

  it('leaves paragraphs with changes not yet settled', () => {
    const model = documentOf('');
    model.blocks[0].runs = [{ text: 'teh ' }, { text: 'gone', del: 'd1' }];
    expect(applyToDocument(model, null, rules)).toEqual({ changed: 0, skipped: 1 });
  });
});

describe('settings', () => {
  it('fills what a file lacks and keeps what it can use', () => {
    expect(autocorrectSettings(null).table).toEqual(DEFAULT_REPLACEMENTS);
    expect(autocorrectSettings({ options: { quotes: false }, table: [['a', 'b'], ['bad'], ['gone', '']] })).toEqual({
      options: { ...rules.options, quotes: false }, table: [['a', 'b']],
    });
    expect(autocorrectSettings({ table: 'junk' }).table).toEqual(DEFAULT_REPLACEMENTS);
  });

  it('reads the table as typed, splitting at the first " = "', () => {
    expect(parseTableText('<= = ≤\n=> = ⇒\nno separator\nteh = the\n = empty')).toEqual([['<=', '≤'], ['=>', '⇒'], ['teh', 'the']]);
  });

  it('keeps AutoText entries with a name and text, each short form once', () => {
    expect(cleanAutoText([{ name: 'Sig', short: 'sg', text: 'Regards' }, { name: 'Dup', short: 'SG', text: 'x' }, { name: '', text: 'x' }, 'junk']))
      .toEqual([{ name: 'Sig', short: 'sg', text: 'Regards' }]);
    expect(autoTextBefore('Best SG', [{ name: 'Sig', short: 'sg', text: 'Regards' }])?.text).toBe('Regards');
    expect(autoTextBefore('Best sgx', [{ name: 'Sig', short: 'sg', text: 'Regards' }])).toBeNull();
    const model = documentOf('First line', 'Second\uFFFC line');
    const [a, b] = model.blocks;
    expect(selectedText(model, { anchor: point(a.id, 6), focus: point(b.id, 7) })).toBe('line\nSecond');
    expect(selectedText(model, { anchor: point(a.id, 2), focus: point(a.id, 2) })).toBe('');
  });
});
