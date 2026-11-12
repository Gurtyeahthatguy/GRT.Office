// @vitest-environment jsdom

/** Redaction: covered text, found by hand or by the finder, is gone from the copy to share, checked on the bytes. */

import { describe, it, expect } from 'vitest';
import { DocumentModel } from '../src/js/core/editor/model.js';
import { toggleRedact, autoRedact, redactedCopy, redactedCount } from '../src/js/core/editor/redact.js';
import { trackedDeleteRange } from '../src/js/core/editor/review.js';
import { point } from '../src/js/core/editor/selection.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { encodeBlock } from '../src/js/core/package.js';
import { findSensitive } from '../src/js/core/sensitive.js';

const SECRET = 'Mario Rossi, codice RSSMRA85T10A562S, IBAN IT60X0542811101000000123456, carta 4111 1111 1111 1111, scrivere a mario@example.it';
function doc() {
  const model = new DocumentModel();
  model.load({ version: 1, type: 'paper', blocks: [
    { id: 'a', kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: SECRET }] },
    { id: 'b', kind: 'list', listType: 'bullet', style: 'body', align: 'left', items: [{ level: 0, runs: [{ text: 'Chiamare il 347 123 4567' }] }] },
  ] });
  return model;
}
const bytesOf = (entries) => new TextDecoder('utf-8', { fatal: false }).decode(encodeBlock(entries));

describe('the finder', () => {
  it('finds what it should, checked by control characters, and nothing in plain prose', () => {
    expect(findSensitive(SECRET).map((f) => f.kind)).toEqual(['taxcode', 'iban', 'card', 'email']);
    expect(findSensitive('RSSMRA85T10A562X IT61X0542811101000000123456 4111 1111 1111 1112')).toEqual([]);
    expect(findSensitive('Il 12 maggio 2024 alle 10:30 abbiamo venduto 3 400 copie.')).toEqual([]);
  });
});

describe('a redacted copy', () => {
  it('has no covered text, no text taken out by a change, in the model, .odt or .docx', () => {
    const model = doc();
    toggleRedact(model, { anchor: point('a', 0), focus: point('a', 11) });
    expect(autoRedact(model, ['taxcode', 'iban', 'card', 'email', 'phone'])).toBe(5);
    expect(redactedCount(model)).toBe(6);
    model.review.recording = true;
    trackedDeleteRange(model, { anchor: point('a', 12), focus: point('a', 18) });
    const copy = redactedCopy(model.toJSON());
    const all = JSON.stringify(copy) + bytesOf(writeOdt(copy).entries) + bytesOf(writeDocx(copy).entries);
    for (const secret of ['Mario Rossi', 'RSSMRA85T10A562S', 'IT60X0542811101000000123456', '4111', 'mario@example.it', '347 123 4567', 'codice']) {
      expect(all.includes(secret), secret).toBe(false);
    }
    expect(JSON.stringify(copy)).toMatch(/█████/);
    // The document itself keeps everything, and saying so when it is written in another format.
    expect(model.toJSON().blocks[0].runs.map((r) => r.text).join('')).toBe(SECRET);
    expect(writeOdt(model.toJSON()).losses.lines().join()).toMatch(/Export Redacted/);
  });
});
