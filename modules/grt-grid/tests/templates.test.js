// @vitest-environment jsdom

/** Spreadsheet templates: written as .ots and .xltx, read back, and opened by LibreOffice as templates. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { asTemplate, baseFormat, isTemplate } from '../src/js/core/formats/templates.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';

const document = () => new GridModel({ version: 1, sheets: [{ name: 'Budget', cells: { '0,0': { v: 'Item' }, '0,1': { v: 'Cost' }, '1,1': { f: '=SUM(B3:B9)' } } }] }).exportJSON();
const text = (entries, name) => new TextDecoder().decode(decodeBlock(encodeBlock(entries)).bytes(name));

describe('spreadsheet templates', () => {
  it('know their kind', () => {
    expect(isTemplate('ots')).toBe(true);
    expect(isTemplate('ods')).toBe(false);
    expect(baseFormat('xltx')).toBe('xlsx');
  });

  it('are marked as templates in the package, and read like the document they hold', () => {
    const ots = asTemplate(writeOds(document()).entries, 'ots');
    expect(text(ots, 'mimetype')).toBe('application/vnd.oasis.opendocument.spreadsheet-template');
    expect(text(ots, 'META-INF/manifest.xml')).toContain('spreadsheet-template');
    expect(readOds(decodeBlock(encodeBlock(ots))).document.sheets[0].cells['1,1'].f).toBe('=SUM(B3:B9)');
    const xltx = asTemplate(writeXlsx(document()).entries, 'xltx');
    expect(text(xltx, '[Content_Types].xml')).toContain('spreadsheetml.template.main+xml');
    expect(readXlsx(decodeBlock(encodeBlock(xltx))).document.sheets[0].cells['0,1'].v).toBe('Cost');
  });

  it.skipIf(!oracleAvailable())('LibreOffice opens them as templates of its own', () => {
    const dir = scratch();
    try {
      for (const [format, filter] of [['ots', 'ods'], ['xltx', 'xlsx:Calc MS Excel 2007 XML']]) {
        const entries = format === 'ots' ? writeOds(document()).entries : writeXlsx(document()).entries;
        const file = join(dir, `budget.${format}`);
        writeBlock(encodeBlock(asTemplate(entries, format)), file);
        const info = execFileSync('file', ['-b', file]).toString();
        if (format === 'ots') expect(info).toMatch(/template/i);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        const back = (format === 'ots' ? readOds : readXlsx)(decodeBlock(readBlock(saved))).document;
        expect(back.sheets[0].cells['0,0'].v).toBe('Item');
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
