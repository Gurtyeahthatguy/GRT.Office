// @vitest-environment jsdom

/** Redaction in Grid: covered cells, and every cell drawn from them, are gone from the copy to share, checked on the bytes. */

import { describe, it, expect } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';
import { autoRedactCells, redactedDocument } from '../src/js/redact.js';
import { writeOds } from '../src/js/core/formats/ods.js';
import { writeXlsx } from '../src/js/core/formats/xlsx.js';
import { encodeBlock } from '../src/js/core/package.js';

function book() {
  const model = new GridModel();
  const sheet = new SheetController(model);
  sheet.setCell(0, 0, 'Mario Rossi');
  sheet.setCell(0, 1, 'IT60X0542811101000000123456');
  sheet.setCell(0, 2, '=LEFT(A1,5)');
  sheet.setCell(0, 3, '=C1&" ok"');
  sheet.setCell(1, 0, 'Public');
  sheet.setCell(1, 1, '42');
  sheet.setCell(1, 2, '=B2*2');
  sheet.select(0, 0);
  sheet.setNote('Mario lives in Rome');
  return { model, sheet };
}
const bytesOf = (entries) => new TextDecoder('utf-8', { fatal: false }).decode(encodeBlock(entries));

describe('a redacted copy of a spreadsheet', () => {
  it('has neither the covered cells nor what formulas drew from them, in .ods or .xlsx', () => {
    const { model, sheet } = book();
    sheet.select(0, 0);
    sheet.toggleRedact();
    expect(autoRedactCells(sheet, ['iban'])).toBe(1);
    const { document, covered } = redactedDocument(sheet);
    expect(covered).toBe(4);
    const all = JSON.stringify(document) + bytesOf(writeOds(document).entries) + bytesOf(writeXlsx(document).entries);
    for (const secret of ['Mario', 'IT60X054', 'LEFT(']) expect(all.includes(secret), secret).toBe(false);
    expect(document.sheets[0].cells['1,2']).toMatchObject({ v: 84 });
    expect(document.sheets[0].cells['1,0']).toMatchObject({ v: 'Public' });
    // The spreadsheet itself is untouched, and says so when written as it is.
    expect(model.sheet.valueAt(0, 0)).toBe('Mario Rossi');
    expect(writeOds(model.exportJSON()).losses.lines().join()).toMatch(/Redacted Export/);
  });
});
