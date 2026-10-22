// @vitest-environment jsdom

/** One workbook beside LibreOffice's reading of it: GRT_FILE=path npm test -- tests/compare.test.js */

import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOds } from '../src/js/core/formats/ods.js';
import { readXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock } from '../src/js/core/package.js';
import { readBlock, convert, scratch, cleanup } from '../../../scripts/oracle.mjs';

it.skipIf(!process.env.GRT_FILE)('compares one workbook with LibreOffice', () => {
  const file = process.env.GRT_FILE;
  const pkg = /\.fods$/i.test(file) ? readFileSync(file, 'utf8') : decodeBlock(readBlock(file));
  const mine = (/\.xlsx$/i.test(file) ? readXlsx(pkg) : readOds(pkg)).document;
  const dir = scratch();
  const theirs = readOds(decodeBlock(readBlock(convert(file, 'ods', join(dir, 'x'))))).document;
  cleanup(dir);
  const lines = [];
  theirs.sheets.forEach((sheet, index) => {
    const other = mine.sheets.find((s) => s.name === sheet.name) ?? mine.sheets[index];
    for (const [key, cell] of Object.entries(sheet.cells)) {
      const found = other?.cells[key];
      if (cell.v === undefined) continue;
      const a = found?.v;
      const ok = typeof a === 'number' && typeof cell.v === 'number' ? Math.abs(a - cell.v) <= 1e-9 * Math.max(1, Math.abs(a)) : a === cell.v;
      if (!ok) lines.push(`${sheet.name}!${key}: ours ${JSON.stringify(a)} (${found?.f ?? ''}) theirs ${JSON.stringify(cell.v)} (${cell.f ?? ''})`);
    }
  });
  console.log(`DIFF ${lines.length}\n${lines.slice(0, 25).join('\n')}`);
});
