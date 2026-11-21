/** Notes, text, signatures and filled forms: what is added on top of a PDF reaches the saved file. */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';
import { DocumentModel } from '../src/js/document-model.js';
import { buildBytesFromPlan } from '../src/js/save.js';
import { formFields } from '../src/js/forms.js';
import { encodeSession, decodeSession } from '../src/js/session.js';
import { deepText } from './helpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const build = (model, options = {}) => buildBytesFromPlan(model, model.buildPlan(), { audit: false, ...options });
const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };

async function plain() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Page', { x: 50, y: 700, size: 24, font });
  return doc.save();
}

async function withForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  form.createTextField('name').addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
  form.createCheckBox('agree').addToPage(page, { x: 50, y: 650, width: 16, height: 16 });
  const choice = form.createDropdown('city');
  choice.addOptions(['Roma', 'Milano']);
  choice.addToPage(page, { x: 50, y: 600, width: 120, height: 24 });
  return doc.save();
}

describe('Additions on top of the pages', () => {
  it('a note is a sticky note every reader shows, with its words', async () => {
    const model = new DocumentModel(await plain(), 1);
    model.addMark(0, 'note', rect, { text: 'Rivedere questo punto' });
    const out = await PDFDocument.load(await build(model));
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'));
    const note = annots.lookup(0);
    expect(note.lookup(PDFName.of('Subtype')).toString()).toBe('/Text');
    expect(note.lookup(PDFName.of('Contents')).decodeText()).toBe('Rivedere questo punto');
  });

  it('text is drawn into the page, and letters the standard font lacks are counted', async () => {
    const model = new DocumentModel(await plain(), 1);
    model.addMark(0, 'text', rect, { text: 'Approvato è così\nΩ', size: 14, color: '#c00000' });
    let dropped = 0;
    const bytes = await build(model, { onDropped: (n) => { dropped = n; } });
    expect(deepText(bytes)).toContain('Approvato');
    expect(dropped).toBe(1);
  });

  it('a signature is a picture in the place drawn for it', async () => {
    const model = new DocumentModel(await plain(), 1);
    model.addMark(0, 'image', rect, { image: PNG });
    const out = await PDFDocument.load(await build(model));
    const resources = out.getPage(0).node.Resources();
    expect(resources.lookup(PDFName.of('XObject')).keys().length).toBeGreaterThan(0);
  });

  it('a filled form keeps its answers in the pages, and the recovery copy keeps them too', async () => {
    const source = await withForm();
    const fields = await formFields(source);
    expect(fields.map((f) => [f.name, f.kind])).toEqual([['name', 'text'], ['agree', 'check'], ['city', 'choice']]);
    const model = new DocumentModel(source, 1);
    model.forms = { 0: { name: 'Mario Rossi', agree: true, city: 'Milano' } };
    const bytes = await build(model);
    const out = await PDFDocument.load(bytes);
    expect(out.getForm().getFields()).toHaveLength(0);
    // The answer is drawn as the field's appearance, in the hex strings pdf-lib writes.
    const hex = [...'Mario Rossi'].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
    expect(deepText(bytes).toUpperCase()).toContain(hex);
    const again = decodeSession(encodeSession(model, {}));
    expect(again.forms).toEqual({ 0: { name: 'Mario Rossi', agree: true, city: 'Milano' } });
  });

  it('recognised words go in as invisible text over the page, so it can be searched', async () => {
    const model = new DocumentModel(await plain(), 1);
    model.addMark(0, 'ocr', { x: 0, y: 0, width: 1, height: 1 }, { words: [{ text: 'Fattura', x: 0.1, y: 0.1, w: 0.2, h: 0.03 }, { text: 'n.42', x: 0.32, y: 0.1, w: 0.08, h: 0.03 }, { text: 'bad', x: 2, y: 0, w: 1, h: 1 }] });
    expect(model.visiblePages[0].marks[0].words).toHaveLength(2);
    const text = deepText(await build(model));
    expect(text).toContain('Fattura');
    expect(text).toContain('n.42');
  });
});
