// @vitest-environment jsdom

/** Every function Grid has, worked out by LibreOffice from the same sheet, value for value. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readOds, writeOds } from '../src/js/core/formats/ods.js';
import { readXlsx, writeXlsx } from '../src/js/core/formats/xlsx.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';
import { key } from '../src/js/references.js';

const ready = oracleAvailable();

// The data the formulas read: numbers in A, words in B, dates in C, a line in D:E, a square in F:H.
const NUMBERS = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
const WORDS = ['apple', 'Banana', 'cherry', 'apple', 'date', 'fig', 'grape', 'apple', 'kiwi', 'lemon'];
const DATES = [45306, 45337, 45366, 45397, 45427, 45458, 45488, 45519, 45550, 45580];
const XS = [1, 2, 3, 4, 5];
const YS = [2.1, 3.9, 6.2, 7.8, 10.1];
const SQUARE = [[2, 1, 0], [1, 3, 1], [0, 1, 4]];

/** One formula per entry; arrays are read through INDEX or a sum, so LibreOffice gives one value too. */
const FORMULAS = [
  // Dates and times
  'DATEDIF(DATE(2020,1,15),DATE(2024,3,10),"d")', 'DATEDIF(DATE(2020,1,15),DATE(2024,3,10),"m")',
  'DATEDIF(DATE(2020,1,15),DATE(2024,3,10),"y")', 'DATEDIF(DATE(2020,1,15),DATE(2024,3,10),"ym")',
  'DATEDIF(DATE(2020,1,15),DATE(2024,3,10),"yd")', 'DATEDIF(DATE(2020,1,31),DATE(2024,3,1),"md")',
  'DATEDIF(DATE(2024,3,10),DATE(2020,1,15),"d")',
  'DATEVALUE("2024-02-29")', 'TIMEVALUE("14:30:15")',
  'TIME(14,30,15)', 'TIME(25,0,0)', 'TIME(0,90,0)',
  'HOUR(0.75)', 'MINUTE(0.7604166667)', 'SECOND(TIME(1,2,3))', 'HOUR(45306.999999)',
  'DAYS360(DATE(2024,1,31),DATE(2024,3,31))', 'DAYS360(DATE(2024,2,29),DATE(2025,2,28))',
  'DAYS360(DATE(2024,1,31),DATE(2024,3,31),TRUE())',
  'DAYSINMONTH(DATE(2024,2,10))', 'DAYSINMONTH(DATE(2023,2,10))', 'DAYSINYEAR(DATE(2024,5,1))',
  'ISLEAPYEAR(DATE(1900,3,1))', 'ISLEAPYEAR(DATE(2000,3,1))', 'WEEKSINYEAR(DATE(2020,6,1))', 'WEEKSINYEAR(DATE(2024,6,1))',
  'EASTERSUNDAY(2024)', 'EASTERSUNDAY(2025)', 'EASTERSUNDAY(19)',
  'EDATE(DATE(2024,1,31),1)', 'EDATE(DATE(2024,3,31),-1)', 'EOMONTH(DATE(2024,1,15),1)', 'EOMONTH(DATE(2024,1,15),-13)',
  'ISOWEEKNUM(DATE(2021,1,1))', 'ISOWEEKNUM(DATE(2024,12,30))',
  'WEEKNUM(DATE(2024,1,1))', 'WEEKNUM(DATE(2024,1,7),2)', 'WEEKNUM(DATE(2024,12,31),21)', 'WEEKNUM(DATE(2024,6,15),13)',
  'WEEKNUM_OOO(DATE(2024,1,1),1)', 'WEEKNUM_OOO(DATE(2024,1,1),2)', 'WEEKNUM_OOO(DATE(2023,1,1),1)',
  'MONTHS(DATE(2024,1,31),DATE(2024,3,1),0)', 'MONTHS(DATE(2024,1,31),DATE(2024,3,1),1)',
  'YEARS(DATE(2020,6,15),DATE(2024,6,14),0)', 'YEARS(DATE(2020,6,15),DATE(2024,6,14),1)',
  'WEEKS(DATE(2024,1,1),DATE(2024,3,1),0)', 'WEEKS(DATE(2024,1,3),DATE(2024,3,1),1)',
  'NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))', 'NETWORKDAYS(DATE(2024,1,31),DATE(2024,1,1))',
  'NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31),C1:C3)',
  'NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,31),11)', 'NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,31),"0000110")',
  'NETWORKDAYS.INTL(DATE(2024,1,1),DATE(2024,1,31),7)',
  'WORKDAY(DATE(2024,1,5),10)', 'WORKDAY(DATE(2024,1,5),-3)', 'WORKDAY(DATE(2024,1,5),10,C1:C3)',
  'WORKDAY.INTL(DATE(2024,1,5),10,2)', 'WORKDAY.INTL(DATE(2024,1,5),10,"1000001")',
  'YEARFRAC(DATE(2024,1,15),DATE(2025,6,30),0)', 'YEARFRAC(DATE(2024,1,15),DATE(2025,6,30),1)',
  'YEARFRAC(DATE(2024,1,15),DATE(2025,6,30),2)', 'YEARFRAC(DATE(2024,1,15),DATE(2025,6,30),3)',
  'YEARFRAC(DATE(2024,1,15),DATE(2025,6,30),4)', 'YEARFRAC(DATE(2023,3,1),DATE(2024,2,29),1)',
  // Logic
  'IFS(A1>5,"big",A1>2,"middle",TRUE(),"small")', 'IFS(A2>5,"big")', 'SWITCH(B2,"apple",1,"Banana",2,0)',
  'SWITCH(A1,1,"one",2,"two","other")', 'SWITCH(A1,1,"one")', 'IF(A1>2,,5)', 'IFERROR(1/0,"none")', 'IFNA(MATCH(99,A1:A10,0),-1)',
  'IF(SUM(A1:A3)>5,SUM(A1:A3),-1)',
  // Lookup and dynamic arrays
  'XLOOKUP("date",B1:B10,A1:A10)', 'XLOOKUP("nope",B1:B10,A1:A10,"missing")', 'XLOOKUP(5,A1:A10,B1:B10,,0,-1)',
  'XLOOKUP(7,SORT(A1:A10),SORT(A1:A10),,-1)', 'XLOOKUP(7,SORT(A1:A10),SORT(A1:A10),,1)', 'XLOOKUP("ch*",B1:B10,A1:A10,,2)',
  'XMATCH(5,A1:A10)', 'XMATCH(5,A1:A10,0,-1)', 'XMATCH(4.5,SORT(A1:A10),1)', 'XMATCH(4.5,SORT(A1:A10),-1,2)',
  'LOOKUP(4.5,SORT(A1:A10))', 'LOOKUP(3,D1:D5,E1:E5)', 'LOOKUP(0,D1:D5,E1:E5)',
  'INDEX(SORT(A1:A10),3)', 'INDEX(SORT(A1:A10,1,-1),2)', 'INDEX(SORT(B1:B10),1)', 'INDEX(SORT(B1:B10),10)',
  'SUM(FILTER(A1:A10,A1:A10>3))', 'INDEX(FILTER(B1:B10,A1:A10>4),2)', 'FILTER(A1:A10,A1:A10>100,0)',
  'ROWS(UNIQUE(B1:B10))', 'INDEX(UNIQUE(A1:A10),4)', 'ROWS(UNIQUE(A1:A10,FALSE(),TRUE()))',
  'INDEX(SORTBY(B1:B10,A1:A10,1),1)', 'INDEX(SORTBY(B1:B10,A1:A10,-1),1)',
  'SUM(CHOOSECOLS(F1:H3,1,3))', 'SUM(CHOOSECOLS(F1:H3,-1))', 'SUM(CHOOSEROWS(F1:H3,2))',
  'SUM(TAKE(A1:A10,3))', 'SUM(TAKE(A1:A10,-3))', 'SUM(DROP(A1:A10,7))', 'SUM(DROP(F1:H3,1,1))',
  'ROWS(EXPAND(F1:H3,5,4,0))', 'INDEX(EXPAND(F1:H3,4,4,7),4,4)',
  'SUM(HSTACK(A1:A3,D1:D3))', 'COLUMNS(HSTACK(A1:A3,F1:H3))', 'ROWS(VSTACK(A1:A3,D1:D5))', 'SUM(VSTACK(A1:A3,D1:D2))',
  'SUM(TOCOL(F1:H3))', 'INDEX(TOCOL(F1:H3,0,TRUE()),2)', 'INDEX(TOROW(F1:H3),5)',
  'INDEX(WRAPROWS(A1:A10,3),2,2)', 'INDEX(WRAPCOLS(A1:A10,3),2,2)', 'ROWS(WRAPROWS(A1:A10,4))',
  'INDEX(TEXTSPLIT("a,b;c,d",",",";"),2,1)', 'COLUMNS(TEXTSPLIT("a,b,,c",","))', 'COLUMNS(TEXTSPLIT("a,b,,c",",",,TRUE()))',
  'ADDRESS(3,4)', 'ADDRESS(3,4,2)', 'ADDRESS(3,4,3)', 'ADDRESS(3,4,4)', 'ADDRESS(3,4,1,FALSE())',
  'AREAS(A1:B3)', 'CHOOSE(2,"a","b","c")', 'CHOOSE(A2,10,20)', 'COLUMN(D5)', 'COLUMN()', 'ROW(D5)', 'ROW()',
  'SUM(ROW(A3:A5))', 'COLUMNS(F1:H3)', 'ROWS(F1:H3)',
  'ERROR.TYPE(1/0)', 'ERROR.TYPE(NA())', 'ERRORTYPE(1/0)',
  'HYPERLINK("http://example.org","site")', 'INDIRECT("A3")', 'SUM(INDIRECT("A1:A4"))', 'SUM(OFFSET(A1,2,0,3,1))', 'OFFSET(A1,1,1)',
  'LET(x,5,y,x*2,x+y)', 'LET(s,SUM(A1:A10),s/COUNT(A1:A10))', 'SHEET()', 'SHEETS()',
  'SUM(A:A)', 'COUNTA(B:B)', 'MAX(1:1)',
  // Arrays of numbers
  'MDETERM(F1:H3)', 'INDEX(MINVERSE(F1:H3),2,2)', 'INDEX(MMULT(F1:H3,F1:H3),1,2)', 'SUM(MUNIT(4))',
  'SUM(SEQUENCE(4,3))', 'INDEX(SEQUENCE(3,2,10,5),3,2)', 'SUMPRODUCT(D1:D5,E1:E5)', 'SUMPRODUCT((A1:A10>3)*A1:A10)',
  'SUMX2MY2(D1:D5,E1:E5)', 'SUMX2PY2(D1:D5,E1:E5)', 'SUMXMY2(D1:D5,E1:E5)', 'INDEX(TRANSPOSE(F1:H3),1,3)',
  'INDEX(FREQUENCY(A1:A10,{2;5}),1)', 'INDEX(FREQUENCY(A1:A10,{2;5}),3)',
  'INDEX(LINEST(E1:E5,D1:D5),1)', 'INDEX(LINEST(E1:E5,D1:D5),2)', 'INDEX(LINEST(E1:E5,D1:D5,FALSE()),1)',
  'INDEX(LINEST(E1:E5,D1:D5,TRUE(),TRUE()),3,1)', 'INDEX(LINEST(E1:E5,D1:D5,TRUE(),TRUE()),2,1)',
  'INDEX(LINEST(E1:E5,D1:D5,TRUE(),TRUE()),4,1)', 'INDEX(LINEST(E1:E5,D1:D5,TRUE(),TRUE()),5,2)',
  'INDEX(LOGEST(E1:E5,D1:D5),1)', 'INDEX(LOGEST(E1:E5,D1:D5),2)', 'INDEX(TREND(E1:E5,D1:D5,{6;7}),2)',
  'INDEX(GROWTH(E1:E5,D1:D5,{6}),1)', 'INDEX(TREND(E1:E5),5)',
  'INDEX(FOURIER(A1:A4,TRUE()),2,1)', 'INDEX(FOURIER(A1:A4,TRUE()),2,2)', 'INDEX(FOURIER(A1:A4,TRUE(),TRUE()),1,1)',
  // Statistics
  'AVERAGEA(A1:B10)', 'MAXA(A1:A10,TRUE())', 'MINA(B1:B10)', 'VAR(A1:A10)', 'VAR.S(A1:A10)', 'VARP(A1:A10)', 'VAR.P(A1:A10)',
  'STDEV.S(A1:A10)', 'STDEVP(A1:A10)', 'STDEV.P(A1:A10)', 'LARGE(A1:A10,2)', 'SMALL(A1:A10,3)', 'LARGE(A1:A10,11)',
  'MODE(A1:A10)', 'MODE.SNGL(D1:D5)', 'PERCENTILE(A1:A10,0.3)', 'PERCENTILE.INC(A1:A10,0.9)', 'QUARTILE(A1:A10,1)',
  'QUARTILE.INC(A1:A10,3)', 'RANK(5,A1:A10)', 'RANK(5,A1:A10,1)', 'RANK.EQ(1,A1:A10)', 'CORREL(D1:D5,E1:E5)',
  'COUNTIFS(A1:A10,">2",B1:B10,"apple")', 'COUNTIFS(B1:B10,"a*")', 'COUNTIFS(B1:B10,"?ig")', 'COUNTIFS(A1:A10,"<>3")',
  'AVERAGEIFS(A1:A10,B1:B10,"apple")', 'MAXIFS(A1:A10,B1:B10,"<>apple")', 'MINIFS(A1:A10,A1:A10,">1")', 'SUMIFS(A1:A10,B1:B10,"*e*")',
  'COUNTIF(B1:B10,"APPLE")', 'SUMIF(A1:A10,">=5")', 'COUNTIF(A1:A10,"")',
];

function sheetWithFormulas() {
  const cells = {};
  NUMBERS.forEach((v, r) => { cells[key(r, 0)] = { v }; });
  WORDS.forEach((v, r) => { cells[key(r, 1)] = { v }; });
  DATES.forEach((v, r) => { cells[key(r, 2)] = { v }; });
  XS.forEach((v, r) => { cells[key(r, 3)] = { v }; });
  YS.forEach((v, r) => { cells[key(r, 4)] = { v }; });
  SQUARE.forEach((row, r) => row.forEach((v, c) => { cells[key(r, 5 + c)] = { v }; }));
  FORMULAS.forEach((f, r) => { cells[key(r, 10)] = { f: `=${f}` }; });
  const model = new GridModel({ version: 1, sheets: [{ name: 'Data', cells }] });
  const controller = new SheetController(model, { onChange: () => {} });
  controller.engine.recalculateAll();
  return model;
}

/** The package with every formula's result taken out, so LibreOffice computes them itself. */
function withoutResults(entries) {
  return entries.map((entry) => (entry.name !== 'content.xml' ? entry : {
    ...entry,
    data: entry.data.replace(/(<table:table-cell [^>]*table:formula="[^"]*")[^>]*?(\/?>)(?:<text:p>.*?<\/text:p>)?/g, (match, open, close) => {
      const kept = open.replace(/ office:(value-type|value|date-value|time-value|boolean-value|string-value)="[^"]*"/g, '');
      return close === '/>' ? `${kept}/>` : `${kept}>`;
    }),
  }));
}

const same = (ours, theirs) => {
  if (typeof ours === 'number' && typeof theirs === 'number') {
    return Math.abs(ours - theirs) <= 1e-9 * Math.max(1, Math.abs(ours), Math.abs(theirs));
  }
  return ours === theirs;
};

describe.skipIf(!ready)('LibreOffice and every function', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('gives the same value for every formula', () => {
    const model = sheetWithFormulas();
    const file = join(dir, 'functions.ods');
    writeBlock(encodeBlock(withoutResults(writeOds(model.toJSON()).entries)), file);
    const saved = convert(file, 'ods', join(dir, 'resaved'));
    const back = readOds(decodeBlock(readBlock(saved))).document.sheets[0].cells;
    const differences = [];
    FORMULAS.forEach((formula, r) => {
      const ours = model.sheet.valueAt(r, 10);
      const theirs = back[key(r, 10)]?.v ?? null;
      if (!same(ours, theirs)) differences.push(`${formula}: Grid ${JSON.stringify(ours)}, LibreOffice ${JSON.stringify(theirs)}`);
    });
    if (differences.length) console.log(differences.join("\n"));
    expect(differences).toEqual([]);
  }, 180000);

  for (const format of ['ods', 'xlsx']) {
    it(`fills a block formula's cells from a .${format} Grid wrote, and gives it back whole`, () => {
      const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells: {
        '0,0': { v: 5 }, '1,0': { v: 2 }, '2,0': { v: 9 }, '0,2': { f: '=SORT(A1:A3)' }, '0,3': { f: '=SEQUENCE(2,2,10)' },
      } }] });
      new SheetController(model, { onChange: () => {} });
      const json = model.exportJSON();
      const entries = format === 'ods' ? writeOds(json).entries : writeXlsx(json).entries;
      const file = join(dir, `blocks.${format}`);
      writeBlock(encodeBlock(entries), file);
      const csv = readFileSync(convert(file, 'csv', join(dir, `csv-${format}`)), 'utf8').trim().split(/\r?\n/).map((line) => line.split(','));
      expect(csv.map((row) => row[2])).toEqual(['2', '5', '9']);
      expect(csv.slice(0, 2).map((row) => row.slice(3, 5))).toEqual([['10', '11'], ['12', '13']]);
      const saved = convert(file, format === 'ods' ? 'ods' : 'xlsx:Calc MS Excel 2007 XML', join(dir, `again-${format}`));
      const document = (format === 'ods' ? readOds : readXlsx)(decodeBlock(readBlock(saved))).document;
      const back = new GridModel(document);
      new SheetController(back, { onChange: () => {} });
      expect([0, 1, 2].map((r) => back.sheet.valueAt(r, 2))).toEqual([2, 5, 9]);
      expect(back.sheet.valueAt(1, 4)).toBe(13);
      expect(back.sheet.formulaAt(1, 2)).toBeNull();
    }, 180000);
  }
});
