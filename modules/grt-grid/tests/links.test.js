// @vitest-environment jsdom

/** Links on cells, and what the honest link window says about an address. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { examineLink } from '../src/js/core/honest-links.js';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

describe('an honest look at a link', () => {
  it('refuses what runs code or reads the disk, however it is spelt', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' \u0001javascript:x', 'file:///etc/passwd', 'data:text/html,<b>', 'vbscript:x']) {
      expect(examineLink(href).refused, href).toBeTruthy();
    }
    expect(examineLink('java\nscript:x').warnings.join()).toMatch(/hidden characters/);
  });

  it('says when the words name another site', () => {
    expect(examineLink('https://evil.example/login', 'www.mybank.it').warnings[0]).toMatch(/text says www\.mybank\.it, but the link goes to evil\.example/);
    expect(examineLink('https://www.mybank.it/login', 'mybank.it').warnings).toEqual([]);
    expect(examineLink('https://login.mybank.it/', 'mybank.it').warnings).toEqual([]);
    expect(examineLink('https://www.mybank.it/', 'Your bank').warnings).toEqual([]);
  });

  it('points out the tricks of the address itself', () => {
    expect(examineLink('https://mybank.it@evil.example/').warnings.join()).toMatch(/before @ .* evil\.example/);
    expect(examineLink('https://аpple.com/').warnings.join()).toMatch(/other alphabets.*xn--/);
    expect(examineLink('http://192.168.0.1/').warnings.join()).toMatch(/bare number[\s\S]*not encrypted/);
    expect(examineLink('ms-settings:privacy').warnings.join()).toMatch(/starts another program/);
    expect(examineLink('#Sheet2.A1')).toMatchObject({ internal: true, refused: null });
    expect(examineLink('example.com').refused).toMatch(/not a full address/);
  });
});

function linked() {
  const model = new GridModel();
  const sheet = new SheetController(model);
  sheet.setCell(0, 0, 'Our site');
  sheet.setLink('https://example.org/a?b=1&c=2');
  sheet.select(1, 0);
  sheet.setCell(1, 0, 'Back to the top');
  sheet.setLink('#Sheet1.A1');
  sheet.select(3, 0);
  sheet.setCell(3, 0, '42');
  sheet.setLink('https://example.com/n');
  sheet.select(2, 0);
  sheet.setLink('https://example.net/');
  return { model, sheet };
}

describe('links on cells', () => {
  it('are set with their text, or the address as text, and taken off', () => {
    const { model, sheet } = linked();
    expect(model.sheet.cell(0, 0)).toMatchObject({ v: 'Our site', l: 'https://example.org/a?b=1&c=2' });
    expect(model.sheet.cell(2, 0)).toMatchObject({ v: 'https://example.net/', l: 'https://example.net/' });
    sheet.select(0, 0);
    sheet.setLink(null);
    expect(sheet.linkAt(0, 0)).toBe(null);
    expect(model.sheet.valueAt(0, 0)).toBe('Our site');
  });

  it('go through .ods and .xlsx, inner ones included', () => {
    const { model } = linked();
    const ods = readOds(through(writeOds(model.toJSON()).entries)).document.sheets[0].cells;
    expect(ods['0,0'].l).toBe('https://example.org/a?b=1&c=2');
    expect(ods['1,0']).toMatchObject({ v: 'Back to the top', l: '#Sheet1.A1' });
    expect(ods['3,0']).toMatchObject({ v: 42, l: 'https://example.com/n' });
    const xlsx = readXlsx(through(writeXlsx(model.toJSON()).entries)).document.sheets[0].cells;
    expect(xlsx['0,0'].l).toBe('https://example.org/a?b=1&c=2');
    expect(xlsx['1,0']).toMatchObject({ v: 'Back to the top', l: '#Sheet1!A1' });
    expect(xlsx['3,0']).toMatchObject({ v: 42, l: 'https://example.com/n' });
    expect(xlsx['2,0'].l).toBe('https://example.net/');
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Grid’s links', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  // Calc keeps a link as a field in a cell's text, so a number loses its link there; Grid keeps it.
  it('reads them from .ods and .xlsx and writes them back', () => {
    const { model } = linked();
    for (const [format, write, filter] of [['ods', writeOds, 'xlsx:Calc MS Excel 2007 XML'], ['xlsx', writeXlsx, 'ods']]) {
      const file = join(dir, `links.${format}`);
      writeBlock(encodeBlock(write(model.toJSON()).entries), file);
      const saved = convert(file, filter, join(dir, `from-${format}`));
      const cells = (format === 'ods' ? readXlsx : readOds)(decodeBlock(readBlock(saved))).document.sheets[0].cells;
      expect(cells['0,0'].l, format).toBe('https://example.org/a?b=1&c=2');
      expect(cells['1,0'].l, format).toMatch(/^#Sheet1[.!]A1$/);
    }
  }, 120000);
});
