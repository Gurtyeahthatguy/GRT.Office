// @vitest-environment jsdom

/** The inspector for Grid: what it lists is gone from the clean copy, checked on the bytes of .ods and .xlsx. */

import { describe, it, expect } from 'vitest';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';
import { gridFindings, cleanGridCopy } from '../src/js/inspect.js';
import { writeOds } from '../src/js/core/formats/ods.js';
import { writeXlsx } from '../src/js/core/formats/xlsx.js';
import { encodeBlock } from '../src/js/core/package.js';

const bytesOf = (entries) => new TextDecoder('utf-8', { fatal: false }).decode(encodeBlock(entries));

describe('the inspector of a workbook', () => {
  it('lists hidden sheets, rows, columns, comments and links, and the clean copy has none of them', () => {
    const model = new GridModel();
    const sheet = new SheetController(model);
    sheet.setCell(0, 0, 'Visible');
    sheet.setCell(1, 0, 'Row secret');
    sheet.setCell(0, 3, 'Column secret');
    sheet.select(0, 0);
    sheet.setNote('Note secret');
    sheet.setLink('https://hidden.example.com/');
    model.sheet.rows.set(1, { hidden: true });
    model.sheet.cols.set(3, { hidden: true });
    const extra = model.addSheet('Salaries');
    extra.set(0, 0, { v: 'Sheet secret' });
    extra.hidden = true;
    const found = Object.fromEntries(gridFindings(sheet).map((f) => [f.id, f.count]));
    expect(found).toMatchObject({ comments: 1, sheets: 1, rows: 1, cols: 1, links: 1 });
    const copy = cleanGridCopy(sheet, ['comments', 'sheets', 'rows', 'cols', 'links']);
    const all = JSON.stringify(copy) + bytesOf(writeOds(copy).entries) + bytesOf(writeXlsx(copy).entries);
    for (const secret of ['Row secret', 'Column secret', 'Note secret', 'hidden.example.com', 'Sheet secret', 'Salaries']) expect(all.includes(secret), secret).toBe(false);
    expect(all.includes('Visible')).toBe(true);
  });
});
