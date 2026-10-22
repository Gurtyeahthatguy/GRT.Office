/** The recovery copy: what goes in comes back out, and damage is refused. */

import { describe, it, expect } from 'vitest';
import { DocumentModel } from '../src/js/document-model.js';
import { encodeSession, decodeSession } from '../src/js/session.js';

const bytes = (...values) => new Uint8Array(values);

function editedModel() {
  const model = new DocumentModel(bytes(1, 2, 3, 4), 3, '/docs/a.pdf');
  model.appendSource(bytes(9, 8, 7), 2);
  model.rotatePage(0, 90);
  model.deletePages([1]);
  model.addMark(0, 'redact', { x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
  model.cropPages([2], { left: 0.1, bottom: 0, right: 0, top: 0.05 });
  return model;
}

const OPTIONS = {
  watermark: { text: 'DRAFT', opacity: 0.2 },
  pageNumbers: null,
  metadata: { title: 'Kept' },
};

describe('a recovery copy', () => {
  it('gives back the sources, the pages as edited, and the export options', () => {
    const model = editedModel();
    const session = decodeSession(encodeSession(model, OPTIONS));
    expect(session.sources).toEqual([bytes(1, 2, 3, 4), bytes(9, 8, 7)]);
    expect(session.pages).toEqual(model.snapshot().pages);
    expect(session.exportOptions).toEqual(OPTIONS);
  });

  it('restores into a model that plans the same pages', () => {
    const model = editedModel();
    const session = decodeSession(encodeSession(model, OPTIONS));
    const restored = new DocumentModel(session.sources[0], 3, '/docs/a.pdf');
    restored.appendSource(session.sources[1], 2);
    restored.restore({ pages: session.pages, sourceCount: session.sources.length, dirty: true });
    expect(restored.buildPlan()).toEqual(model.buildPlan());
    expect(restored.dirty).toBe(true);
  });

  it('CANARY: an untouched document comes back untouched', () => {
    const model = new DocumentModel(bytes(5), 1, null);
    const session = decodeSession(encodeSession(model, { watermark: null, pageNumbers: null, metadata: null }));
    expect(session.pages).toEqual([{
      sourceId: 0, originalIndex: 0, rotation: 0, crop: null, marks: [], deleted: false,
    }]);
  });

  it('refuses a file that is not one', () => {
    expect(() => decodeSession(new TextEncoder().encode('%PDF-1.7 hello'))).toThrow('not a recovery copy');
    expect(() => decodeSession(bytes())).toThrow('not a recovery copy');
  });

  it('refuses a copy cut short, or with bytes added', () => {
    const whole = encodeSession(editedModel(), OPTIONS);
    expect(() => decodeSession(whole.slice(0, whole.length - 1))).toThrow('damaged');
    const longer = new Uint8Array(whole.length + 1);
    longer.set(whole);
    expect(() => decodeSession(longer)).toThrow('damaged');
    expect(() => decodeSession(whole.slice(0, 20))).toThrow('damaged');
  });

  it('refuses pages that point at a source it does not carry', () => {
    const model = editedModel();
    const snapshot = model.snapshot();
    snapshot.pages[0].sourceId = 5;
    const forged = { sources: model.sources, snapshot: () => snapshot };
    expect(() => decodeSession(encodeSession(forged, OPTIONS))).toThrow('damaged');
  });

  it('refuses a rotation that is not a quarter turn', () => {
    const model = editedModel();
    const snapshot = model.snapshot();
    snapshot.pages[0].rotation = 45;
    const forged = { sources: model.sources, snapshot: () => snapshot };
    expect(() => decodeSession(encodeSession(forged, OPTIONS))).toThrow('damaged');
  });

  it('drops export options that are not objects', () => {
    const session = decodeSession(encodeSession(editedModel(), { watermark: 'x', pageNumbers: [1], metadata: null }));
    expect(session.exportOptions).toEqual({ watermark: null, pageNumbers: null, metadata: null });
  });
});
