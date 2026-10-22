// @vitest-environment jsdom

/** Spreadsheets in and out of a database. */

import { describe, it, expect } from 'vitest';
import { sheetRows, tablesAsSpreadsheet, serialText, textSerial } from '../src/js/spreadsheets.js';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';

const through = (entries) => decodeBlock(encodeBlock(entries));

describe('dates between spreadsheets and text', () => {
  it('turn serials into ISO text and back', () => {
    expect(serialText(46312, 'date')).toBe('2026-10-17');
    expect(serialText(46312.5, 'datetime')).toBe('2026-10-17 12:00:00');
    expect(serialText(0.75, 'time')).toBe('18:00:00');
    expect(textSerial('2026-10-17')).toBe(46312);
    expect(textSerial('2026-10-17 12:00:00')).toBe(46312.5);
    expect(textSerial('17/10/2026')).toBeNull();
  });
});

describe('a sheet as rows', () => {
  it('starts where the data starts, shows dates as dates and drops empty rows', () => {
    const sheet = {
      cells: {
        '2,1': { v: 'Name' }, '2,2': { v: 'Born' }, '2,3': { v: 'Score' },
        '3,1': { v: 'Ada' }, '3,2': { v: 46312, s: 'd' }, '3,3': { v: 12.5 },
        '5,1': { v: 'Linus' }, '5,2': { v: 46313, s: 'd' }, '5,3': { v: true },
      },
    };
    expect(sheetRows(sheet, { d: { format: 'dd/mm/yyyy' } })).toEqual([
      ['Name', 'Born', 'Score'], ['Ada', '2026-10-17', '12.5'], ['Linus', '2026-10-18', 'true'],
    ]);
    expect(sheetRows({ cells: {} })).toEqual([]);
  });
});

describe('tables as a spreadsheet', () => {
  const tables = [
    { name: 'people', columns: ['id', 'name', 'born', 'photo'], rows: [[1, 'Ada', '1815-12-10', new Uint8Array([1])], [2, 'Grace', null, null]] },
    { name: 'a/b:c', columns: ['x'], rows: [[3.5]] },
  ];

  it('goes out to OpenDocument and Excel with names in bold, dates as dates, and comes back', () => {
    const document = tablesAsSpreadsheet(tables);
    for (const back of [readOds(through(writeOds(document).entries)).document, readXlsx(through(writeXlsx(document).entries)).document]) {
      expect(back.sheets.map((s) => s.name)).toEqual(['people', 'a_b_c']);
      expect(sheetRows(back.sheets[0], back.styles)).toEqual([
        ['id', 'name', 'born', 'photo'], ['1', 'Ada', '1815-12-10', '(file)'], ['2', 'Grace', '', ''],
      ]);
      expect(back.styles[back.sheets[0].cells['0,0'].s].bold).toBe(true);
      expect(back.sheets[0].frozen).toEqual({ rows: 1, cols: 0 });
    }
  });
});
