/** PDF forms: the fields a document asks to be filled, and their answers written in for good. */

import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup } from '../vendor/pdf-lib.esm.js';

const MAX_FIELDS = 2000;

/** The fields of a PDF's form, with what each holds now. */
export async function formFields(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  let form;
  try { form = doc.getForm(); } catch { return []; }
  return form.getFields().slice(0, MAX_FIELDS).map((field) => {
    const name = field.getName();
    if (field instanceof PDFTextField) return { name, kind: 'text', value: field.getText() ?? '', multiline: field.isMultiline(), max: field.getMaxLength() ?? null };
    if (field instanceof PDFCheckBox) return { name, kind: 'check', value: field.isChecked() };
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) return { name, kind: 'choice', value: field.getSelected()[0] ?? '', options: field.getOptions() };
    if (field instanceof PDFRadioGroup) return { name, kind: 'radio', value: field.getSelected() ?? '', options: field.getOptions() };
    return null;
  }).filter(Boolean);
}

/**
 * Writes the answers into a loaded document's fields and makes them part of the pages, so every reader shows them the same.
 * @param {PDFDocument} doc
 * @param {Object<string, string|boolean>} values by field name
 * @returns {{written: number, refused: string[]}}
 */
export function fillAndFlatten(doc, values) {
  let form;
  try { form = doc.getForm(); } catch { return { written: 0, refused: [] }; }
  let written = 0;
  const refused = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values)) continue;
    const value = values[name];
    try {
      if (field instanceof PDFTextField) field.setText(String(value ?? ''));
      else if (field instanceof PDFCheckBox) { if (value) field.check(); else field.uncheck(); } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) { if (value) field.select(String(value)); } else if (field instanceof PDFRadioGroup) { if (value) field.select(String(value)); }
      written += 1;
    } catch {
      // Letters the form's standard font cannot write: the field is left as it was, and said.
      refused.push(name);
    }
  }
  try { form.flatten(); } catch { refused.push('(the form as a whole)'); }
  return { written, refused };
}
