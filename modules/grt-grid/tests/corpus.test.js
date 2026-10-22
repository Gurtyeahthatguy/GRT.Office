// @vitest-environment jsdom

/** Real spreadsheets listed in GRT_CORPUS, compared with the results kept beside the list. */

import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOds } from '../src/js/core/formats/ods.js';
import { readXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock } from '../src/js/core/package.js';
import {
  oracleAvailable, readBlock, convert, scratch, cleanup,
} from '../../../scripts/oracle.mjs';

const list = process.env.GRT_CORPUS;
const files = list && existsSync(list)
  ? readFileSync(list, 'utf8').split('\n').map((line) => line.trim()).filter((line) => /\.(ods|fods|xlsx)$/i.test(line))
  : [];

function ours(file) {
  if (/\.fods$/i.test(file)) return readOds(readFileSync(file, 'utf8'));
  const pkg = decodeBlock(readBlock(file));
  return /\.xlsx$/i.test(file) ? readXlsx(pkg) : readOds(pkg);
}

const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  return a === b;
};

/** How many of LibreOffice's non-empty cells read back with the same value. */
function agreement(mine, theirs) {
  let total = 0;
  let matched = 0;
  theirs.sheets.forEach((sheet, index) => {
    const other = mine.sheets.find((s) => s.name === sheet.name) ?? mine.sheets[index];
    for (const [key, cell] of Object.entries(sheet.cells)) {
      if (cell.v === undefined || cell.v === '') continue;
      total += 1;
      const found = other?.cells[key];
      // LibreOffice stores logical values as numbers.
      const value = typeof found?.v === 'boolean' && typeof cell.v === 'number' ? Number(found.v) : found?.v;
      if (found && same(value, cell.v)) matched += 1;
    }
  });
  return { total, share: total === 0 ? 1 : matched / total };
}

const baselineFile = list ? `${list}.baseline.json` : null;
const baseline = baselineFile && existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
const results = {};
const keyOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

describe.skipIf(files.length === 0 || !oracleAvailable())('the spreadsheet corpus', () => {
  const dir = files.length ? scratch() : null;
  afterAll(() => {
    cleanup(dir);
    if (process.env.GRT_CORPUS_UPDATE) writeFileSync(baselineFile, `${JSON.stringify(results, null, 1)}\n`);
  });

  for (const [index, file] of files.entries()) {
    const label = file.includes('/GRT Corpus/') ? file.split('/GRT Corpus/')[1] : `workbook ${index + 1}`;
    it(label, () => {
      const out = join(dir, String(index));
      let theirs = null;
      try {
        theirs = readOds(decodeBlock(readBlock(convert(file, 'ods', out)))).document;
      } catch {
        theirs = null;
      }
      let result;
      try {
        result = ours(file);
      } catch (error) {
        cleanup(out);
        console.log(`[corpus] ${label}: ${theirs ? 'ERROR' : 'refused, as LibreOffice did'}: ${error.message.split('\n')[0]}`);
        results[keyOf(file)] = theirs ? 0 : 1;
        if (theirs && !process.env.GRT_CORPUS_UPDATE) throw error;
        return;
      }
      cleanup(out);
      if (!theirs) {
        console.log(`[corpus] ${label}: ${result.document.sheets.length} sheets; LibreOffice could not open it`);
        return;
      }
      const { total, share } = agreement(result.document, theirs);
      const cells = result.document.sheets.reduce((sum, sheet) => sum + Object.keys(sheet.cells).length, 0);
      console.log(`[corpus] ${label}: ${result.document.sheets.length} sheets, ${cells} cells, `
        + `${Math.round(share * 1000) / 10}% of LibreOffice's ${total} values; lost: ${result.losses.lines().join('; ') || 'nothing'}`);
      const id = keyOf(file);
      results[id] = share;
      if (process.env.GRT_CORPUS_UPDATE) return;
      if (baseline[id] === undefined) expect(share).toBeGreaterThan(0.98);
      else expect(share).toBeGreaterThanOrEqual(baseline[id] - 0.01);
    }, 180000);
  }
});
