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
  // Mathematics, 0.4
  'PI()', 'SIN(1)', 'COS(1)', 'TAN(1)', 'COT(1)', 'COT(0)', 'SEC(1)', 'CSC(1)', 'CSC(0)', 'ASIN(0.5)', 'ASIN(2)', 'ACOS(0.5)', 'ACOS(-2)',
  'ATAN(1)', 'ACOT(2)', 'ACOT(0)', 'ATAN2(1,1)', 'ATAN2(-1,0)', 'ATAN2(0,0)', 'SINH(1)', 'COSH(1)', 'TANH(1)', 'COTH(2)', 'COTH(0)',
  'SECH(1)', 'CSCH(1)', 'ASINH(1)', 'ACOSH(2)', 'ACOSH(0.5)', 'ATANH(0.5)', 'ATANH(1)', 'ACOTH(2)', 'ACOTH(0.5)',
  'DEGREES(PI())', 'RADIANS(180)', 'SQRTPI(2)', 'SQRTPI(-1)', 'LOG(100)', 'LOG(8,2)', 'LOG(0)', 'LOG(10,1)', 'LOG(-1,2)',
  'FACT(5)', 'FACT(0)', 'FACT(5.9)', 'FACT(-1)', 'FACT(171)', 'COMBIN(10,3)', 'COMBIN(10.7,3.2)', 'COMBIN(3,10)', 'COMBIN(50,25)',
  'COMBINA(4,3)', 'COMBINA(0,0)', 'COMBINA(10,3)', 'MULTINOMIAL(2,3,4)', 'MULTINOMIAL(A1:A3)', 'MULTINOMIAL(-1,2)',
  'GCD(24,36,48)', 'GCD(A1:A10)', 'GCD(0,0)', 'GCD(-2,4)', 'GCD(7.9,14.2)', 'LCM(4,6,10)', 'LCM(A1:A5)', 'LCM(0,5)', 'LCM(-1,2)',
  'GCD_EXCEL2003(12,18)', 'LCM_EXCEL2003(12,18)', 'QUOTIENT(7,2)', 'QUOTIENT(-7,2)', 'QUOTIENT(1,0)',
  'RAWSUBTRACT(0.3,0.1,0.2)', 'RAWSUBTRACT(10,1,2,3)', 'SUMSQ(1,2,3)', 'SUMSQ(A1:A10)', 'SUMSQ(B1:B3,2)',
  'SERIESSUM(2,1,2,F1:H1)', 'SERIESSUM(0.5,0,1,A1:A4)',
  'TRUNC(8.9)', 'TRUNC(-8.9)', 'TRUNC(3.14159,2)', 'TRUNC(1234.5,-2)', 'ROUNDSIG(123.456,2)', 'ROUNDSIG(-0.0012345,3)', 'ROUNDSIG(5,0)',
  'EVEN(1.5)', 'EVEN(3)', 'EVEN(-1)', 'EVEN(0)', 'ODD(1.5)', 'ODD(2)', 'ODD(-2)', 'ODD(0)',
  'MROUND(10,3)', 'MROUND(-10,-3)', 'MROUND(1.3,0.2)', 'MROUND(5,0)', 'MROUND(-10,3)', 'MROUND(2.5,5)',
  'CEILING.PRECISE(4.3)', 'CEILING.PRECISE(-4.3)', 'CEILING.PRECISE(4.3,-2)', 'CEILING.PRECISE(4.3,0)', 'ISO.CEILING(-4.3,2)',
  'FLOOR.PRECISE(4.3)', 'FLOOR.PRECISE(-4.3)', 'FLOOR.PRECISE(4.3,-2)', 'FLOOR.PRECISE(-3.2,0)',
  'CEILING.MATH(24.3,5)', 'CEILING.MATH(-8.1,2)', 'CEILING.MATH(-8.1,2,-1)', 'CEILING.MATH(6.7)', 'CEILING.MATH(-5.5,2,1)',
  'FLOOR.MATH(24.3,5)', 'FLOOR.MATH(-8.1,2)', 'FLOOR.MATH(-8.1,2,-1)', 'FLOOR.MATH(6.7)', 'FLOOR.MATH(-5.5,2,1)',
  'CEILING.XCL(2.5,1)', 'CEILING.XCL(-2.5,-2)', 'CEILING.XCL(-2.5,2)', 'CEILING.XCL(1.5,0.1)', 'CEILING.XCL(2.5,-2)', 'CEILING.XCL(0,3)',
  'FLOOR.XCL(3.7,2)', 'FLOOR.XCL(-2.5,-2)', 'FLOOR.XCL(-2.5,2)', 'FLOOR.XCL(1.58,0.1)', 'FLOOR.XCL(2.5,-2)', 'FLOOR.XCL(2.5,0)',
  'BITAND(13,25)', 'BITOR(13,25)', 'BITXOR(13,25)', 'BITLSHIFT(4,2)', 'BITLSHIFT(4,-1)', 'BITRSHIFT(13,2)', 'BITRSHIFT(13,-2)',
  'BITAND(-1,5)', 'BITAND(2^48,1)', 'BITAND(1.5,1)', 'BITLSHIFT(2^47,1)',
  'COLOR(255,0,0)', 'COLOR(0,128,255,10)', 'COLOR(256,0,0)',
  'EUROCONVERT(1,"DEM","EUR")', 'EUROCONVERT(100,"FRF","DEM")', 'EUROCONVERT(100,"FRF","DEM",TRUE())', 'EUROCONVERT(100,"FRF","DEM",TRUE(),3)',
  'EUROCONVERT(1000,"ITL","EUR")', 'EUROCONVERT(1,"EUR","ITL")', 'EUROCONVERT(1,"XYZ","EUR")',
  'CONVERT_OOO(100,"ATS","EUR")', 'CONVERT_OOO(100,"EUR","BEF")',
  'AGGREGATE(9,4,A1:A10)', 'AGGREGATE(1,6,A1:A10)', 'AGGREGATE(14,6,A1:A10,2)', 'AGGREGATE(15,6,A1:A10,3)', 'AGGREGATE(12,6,A1:A10)',
  'AGGREGATE(2,0,B1:B10)', 'AGGREGATE(3,0,B1:B10)', 'AGGREGATE(16,6,A1:A10,0.3)', 'AGGREGATE(17,6,A1:A10,1)', 'AGGREGATE(18,6,A1:A10,0.3)',
  'AGGREGATE(19,6,A1:A10,3)', 'AGGREGATE(7,6,A1:A10)', 'AGGREGATE(13,6,A1:A10)', 'AGGREGATE(20,6,A1:A10)', 'AGGREGATE(4,6,F1:H3)',
  'PERCENTILE.EXC(A1:A10,0.25)', 'PERCENTILE.EXC(A1:A10,0.01)', 'QUARTILE.EXC(A1:A10,1)', 'QUARTILE.EXC(A1:A10,4)',
  'ROWS(RANDARRAY(3,2))', 'COLUMNS(RANDARRAY(3,2))', 'AND(RAND.NV()>=0,RAND.NV()<1)', 'RANDBETWEEN.NV(5,5)', 'SUM(RANDARRAY(4,1,7,7,TRUE()))',
  // Financial, 0.4
  'FV(0.06/12,10,-200,-500,1)', 'FV(0.11/12,35,-2000,,1)', 'FV(0,12,-100,-1000)', 'FV(0.05,10,-100)',
  'PV(0.08/12,20*12,500)', 'PV(0,12,-100,1000)', 'PV(0.05,10,-100,0,1)',
  'PMT(0.08/12,10,10000)', 'PMT(0.08/12,10,10000,0,1)', 'PMT(0,10,1000)', 'PMT(0.06/12,18*12,0,50000)',
  'NPER(0.12/12,-100,-1000,10000,1)', 'NPER(0.12/12,-100,-1000)', 'NPER(0,-100,1000)',
  'IPMT(0.1/12,1,36,8000)', 'IPMT(0.1,3,3,8000)', 'IPMT(0.1/12,2,36,8000,0,1)', 'IPMT(0.1/12,1,36,8000,0,1)', 'IPMT(0.1,4,3,8000)',
  'PPMT(0.1/12,1,24,2000)', 'PPMT(0.08,10,10,200000)', 'PPMT(0.08,10,10,200000,0,1)',
  'ISPMT(0.1/12,1,36,8000000)', 'ISPMT(0.1,1,3,8000000)',
  'CUMIPMT(0.09/12,30*12,125000,13,24,0)', 'CUMIPMT(0.09/12,30*12,125000,1,1,0)', 'CUMIPMT(0.09/12,30*12,125000,1,1,1)', 'CUMIPMT(0.09/12,30*12,125000,13,24,1)', 'CUMIPMT(0,10,100,1,2,0)',
  'CUMPRINC(0.09/12,30*12,125000,13,24,0)', 'CUMPRINC(0.09/12,30*12,125000,1,1,0)', 'CUMPRINC(0.09/12,30*12,125000,1,12,1)',
  'CUMIPMT_ADD(0.09/12,30*12,125000,13,24,0)', 'CUMPRINC_ADD(0.09/12,30*12,125000,13,24,0)',
  'RATE(4*12,-200,8000)', 'RATE(4,-200,8000,0,1)', 'RATE(10,-100,1000,0,0,0.01)', 'RATE(12,-500,6000)', 'RATE(5,100,1000)',
  'NPV(0.1,-10000,3000,4200,6800)', 'NPV(0.08,A1:A5)', 'NPV(0.08,A1:A5,-9000)',
  'IRR(F1:H1)', 'IRR({-70000,12000,15000,18000,21000,26000})', 'IRR({-70000,12000,15000},-0.1)',
  'MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)', 'MIRR({-120000,39000,30000,21000},0.1,0.12)', 'MIRR({1,2,3},0.1,0.1)',
  'XNPV(0.09,{-10000,2750,4250,3250,2750},{39448,39508,39751,39859,39904})',
  'XIRR({-10000,2750,4250,3250,2750},{39448,39508,39751,39859,39904})', 'XIRR({-10000,2750,4250,3250,2750},{39448,39508,39751,39859,39904},0.5)',
  'FVSCHEDULE(1,{0.09,0.11,0.1})', 'FVSCHEDULE(100,A1:A3)',
  'EFFECT(0.0525,4)', 'EFFECT(0.1,4.9)', 'EFFECT(0,4)', 'EFFECT_ADD(0.0525,4)', 'NOMINAL(0.053543,4)', 'NOMINAL_ADD(0.053543,4)',
  'RRI(96,10000,11000)', 'RRI(0,1,2)', 'PDURATION(0.025,2000,2200)', 'PDURATION(0,1,2)',
  'SLN(30000,7500,10)', 'SLN(1,1,0)', 'SYD(30000,7500,10,1)', 'SYD(30000,7500,10,10)',
  'DDB(2400,300,10*365,1)', 'DDB(2400,300,10*12,1,2)', 'DDB(2400,300,10,1,2)', 'DDB(2400,300,10,10)', 'DDB(2400,300,10,2,1.5)', 'DDB(1000,100,2,1,3)',
  'DB(1000000,100000,6,1,7)', 'DB(1000000,100000,6,2,7)', 'DB(1000000,100000,6,6,7)', 'DB(1000000,100000,6,7,7)', 'DB(1000,100,5,1)',
  'VDB(2400,300,10*365,0,1)', 'VDB(2400,300,10*12,0,1)', 'VDB(2400,300,10,0,1)', 'VDB(2400,300,10*12,6,18)', 'VDB(2400,300,10*12,6,18,1.5)',
  'VDB(2400,300,10,0,0.875,1.5)', 'VDB(2400,300,10,1.5,3.25)', 'VDB(2400,300,10,0,10,2,TRUE())', 'VDB(2400,300,10,2.5,7.5,2,TRUE())',
  'AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)', 'AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,0,0.15,1)', 'AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,7,0.15,1)',
  'AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)', 'AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,0,0.15,1)', 'AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,4,0.15,1)',
  'AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,6,0.15,1)',
  'COUPPCD(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPNCD(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPNUM(DATE(2007,1,25),DATE(2008,11,15),2,1)',
  'COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),4,0)', 'COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),1,3)',
  'COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPDAYBS(DATE(2011,1,25),DATE(2011,11,15),2,0)', 'COUPDAYBS(DATE(2011,1,31),DATE(2011,8,31),2,4)',
  'COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,1)', 'COUPDAYSNC(DATE(2011,1,25),DATE(2011,11,15),2,0)', 'COUPDAYSNC(DATE(2011,2,28),DATE(2015,8,31),2,0)',
  'COUPPCD(DATE(2011,3,15),DATE(2015,2,28),2,0)', 'COUPNCD(DATE(2011,3,15),DATE(2015,2,28),4,0)', 'COUPNUM(DATE(2011,1,25),DATE(2011,11,15),3,1)',
  'PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,0)', 'PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,1)', 'PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,4,3)', 'PRICE(DATE(2008,2,15),DATE(2008,8,15),0.0575,0.065,100,2,0)',
  'YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,0)', 'YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,1)', 'YIELD(DATE(2008,2,15),DATE(2008,8,15),0.0575,99.8,100,2,0)',
  'DURATION(DATE(2018,7,1),DATE(2048,1,1),0.08,0.09,2,1)', 'DURATION(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,4,0)', 'MDURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)',
  'PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)', 'PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,1)',
  'PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)', 'PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,1)',
  'YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,2)', 'YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,1)',
  'YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)', 'YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,1)',
  'DISC(DATE(2007,1,25),DATE(2007,6,15),97.975,100,1)', 'DISC(DATE(2007,1,25),DATE(2007,6,15),97.975,100,0)',
  'INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,2)', 'INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,1)',
  'RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,2)', 'RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,1)',
  'ACCRINT(DATE(2008,3,1),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0)', 'ACCRINT(DATE(2008,3,1),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,1)', 'ACCRINT(DATE(2008,3,1),DATE(2008,8,31),DATE(2008,5,1),0.1,,2,4)',
  'ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)', 'ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,1)', 'ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1)',
  'TBILLEQ(DATE(2008,3,31),DATE(2008,6,1),0.0914)', 'TBILLPRICE(DATE(2008,3,31),DATE(2008,6,1),0.09)', 'TBILLYIELD(DATE(2008,3,31),DATE(2008,6,1),98.45)',
  'ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,0)', 'ODDLPRICE(DATE(2008,2,7),DATE(2008,6,15),DATE(2007,10,15),0.0375,0.0405,100,2,1)',
  'ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,100,2,0)', 'ODDLYIELD(DATE(2008,4,20),DATE(2008,6,15),DATE(2007,12,24),0.0375,99.875,100,2,1)',
  'COUPDAYBS(DATE(2011,2,28),DATE(2015,8,31),2,0)', 'COUPDAYBS(DATE(2012,2,29),DATE(2015,8,31),2,0)', 'COUPDAYSNC(DATE(2012,2,29),DATE(2015,8,31),2,0)',
  'COUPDAYBS(DATE(2011,3,31),DATE(2015,8,31),2,0)', 'COUPDAYSNC(DATE(2011,3,31),DATE(2015,8,31),2,0)', 'COUPDAYBS(DATE(2011,3,30),DATE(2015,8,30),2,0)',
  'COUPDAYBS(DATE(2011,2,28),DATE(2015,8,31),2,4)', 'COUPDAYSNC(DATE(2011,2,28),DATE(2015,8,31),2,4)', 'COUPDAYBS(DATE(2011,5,31),DATE(2015,11,30),2,0)',
  'COUPDAYSNC(DATE(2011,5,31),DATE(2015,11,30),2,0)', 'COUPDAYBS(DATE(2011,6,15),DATE(2015,8,31),4,0)', 'COUPDAYSNC(DATE(2011,6,15),DATE(2015,8,31),4,0)',
  'PRICE(DATE(2011,2,28),DATE(2015,8,31),0.05,0.06,100,2,0)', 'PRICE(DATE(2011,3,31),DATE(2015,8,31),0.05,0.06,100,2,0)',
  'DOLLARDE(1.02,16)', 'DOLLARDE(1.1,32)', 'DOLLARDE(-1.02,16)', 'DOLLARDE(1.02,0)', 'DOLLARFR(1.125,16)', 'DOLLARFR(1.125,32)', 'DOLLARFR(1.125,-1)',
  // Options, 0.4
  'OPT_BARRIER(100,0.2,0.05,0.02,1,100,0,0,0,"c","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"p","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,0,120,0,"c","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,0,120,0,"p","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,120,0,"c","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,120,0,"p","i","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,3,"c","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,3,"c","i","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,120,0,"c","o","e")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"p","i","e")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,95,0,110,2,"c","i","e")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,105,0,0,"c","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,80,0,90,0,"c","o","c")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","d")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","g")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","t")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","e")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","o")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","a")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","r")', 'OPT_BARRIER(100,0.2,0.05,0.02,1,100,90,0,0,"c","o","c","f")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,90,0,"d","i","c")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,90,0,"d","o","c")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,0,110,"f","i","c")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,90,110,"d","o","c")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,90,110,"f","i","c")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,90,110,"d","o","e")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,0,110,"d","i","e")', 'OPT_TOUCH(100,0.2,0.05,0.02,1,90,110,"d","o","c","d")', 'OPT_PROB_HIT(100,0.2,0.03,1,90,0)', 'OPT_PROB_HIT(100,0.2,0.03,1,0,110)', 'OPT_PROB_HIT(100,0.2,0.03,1,90,110)', 'OPT_PROB_HIT(100,0.2,-0.05,2,80,0)', 'OPT_PROB_INMONEY(100,0.2,0.03,1,90,110)', 'OPT_PROB_INMONEY(100,0.2,0.03,1,0,110)', 'OPT_PROB_INMONEY(100,0.2,0.03,1,90,110,100,"c")', 'OPT_PROB_INMONEY(100,0.2,0.03,1,90,0,100,"p")', 'OPT_PROB_INMONEY(100,0.2,0.03,1,120,110)', 'OPT_PROB_INMONEY(100,0.2,0.03,1,0,0,100,"c")', 'OPT_PROB_INMONEY(100,0.2,0.03,1,90,110,100,"p")', 'OPT_PROB_INMONEY(100,0.2,0.03,1,0,110,100,"c")', 'OPT_PROB_INMONEY(100,0.2,0.03,1,90,0,100,"c")', 'OPT_PROB_INMONEY(100,0.2,0.03,1,90,110,100,"c")', 'OPT_PROB_INMONEY(100,0.2,0.03,1,0,0,100,"p")',
  // Text, information and databases, 0.4
  'ARABIC("MCMXCIX")',
  'ARABIC("mmxxiv")',
  'ARABIC("")',
  'ARABIC("ABC")',
  'ARABIC("-XIV")',
  'ROMAN(1999)',
  'ROMAN(499,0)',
  'ROMAN(499,1)',
  'ROMAN(499,2)',
  'ROMAN(499,3)',
  'ROMAN(499,4)',
  'ROMAN(1999,4)',
  'ROMAN(0)',
  'ROMAN(4000)',
  'ROMAN(3888,2)',
  'BASE(255,16)',
  'BASE(255,2,12)',
  'BASE(-1,2)',
  'BASE(10,37)',
  'DECIMAL("FF",16)',
  'DECIMAL("0xff",16)',
  'DECIMAL("11111111",2)',
  'DECIMAL("zz",36)',
  'DECIMAL("12",2)',
  'BAHTTEXT(1234.5)',
  'BAHTTEXT(0)',
  'BAHTTEXT(21)',
  'BAHTTEXT(11)',
  'BAHTTEXT(101)',
  'BAHTTEXT(1000000)',
  'BAHTTEXT(-15.25)',
  'BAHTTEXT(25000000.01)',
  'ASC("ＡＢＣ\u3000１２３")',
  'JIS("ABC 123")',
  'CHAR(65)',
  'CHAR(0)',
  'CODE("A")',
  'CODE("")',
  'UNICHAR(8364)',
  'UNICODE("€")',
  'UNICHAR(0)',
  'CLEAN("a"&CHAR(9)&"b"&CHAR(10)&"c")',
  'T("x")',
  'T(5)',
  'T(B1)',
  'ROT13("Hello")',
  'REPT("ab",3)',
  'REPT("x",0)',
  'REPT("x",-1)',
  'REPLACE("abcdef",2,3,"XY")',
  'REPLACE("abc",5,1,"Z")',
  'REPLACE("abc",0,1,"Z")',
  'SEARCH("an",B2)',
  'SEARCH("A?P",B1)',
  'SEARCH("*e",B5)',
  'SEARCH("z",B1)',
  'SEARCH("p",B1,3)',
  'SEARCH("",B1)',
  'NUMBERVALUE("1.234,5",",",".")',
  'NUMBERVALUE("12%")',
  'NUMBERVALUE(" 3 . 5 ")',
  'NUMBERVALUE("1,2,3",",")',
  'NUMBERVALUE("2.5%%")',
  'ENCODEURL("a b&c/é")',
  'FILTERXML("<a><b>1</b><b>2</b></a>","//b[2]")',
  'FILTERXML("<a><b>x</b></a>","//b")',
  'FILTERXML("<a><b>1</b><b>2</b></a>","count(//b)")',
  'FILTERXML("<a/>","//b")',
  'REGEX("abc123def","[0-9]+")',
  'REGEX("abc123def456","[0-9]+","#")',
  'REGEX("abc123def456","[0-9]+","#","g")',
  'REGEX("abc123def456","[0-9]+","#",2)',
  'REGEX("abc","x")',
  'REGEX("John Smith","(\\w+) (\\w+)","$2, $1")',
  'REGEX("abc123","[0-9]+",,1)',
  'TEXTBEFORE("a-b-c","-")',
  'TEXTBEFORE("a-b-c","-",2)',
  'TEXTBEFORE("a-b-c","-",-1)',
  'TEXTBEFORE("a-b-c","x")',
  'TEXTBEFORE("a-b-c","x",,,,"none")',
  'TEXTBEFORE("aXbxc","x",1,1)',
  'TEXTBEFORE("abc","x",1,0,1)',
  'TEXTAFTER("a-b-c","-")',
  'TEXTAFTER("a-b-c","-",2)',
  'TEXTAFTER("a-b-c","-",-1)',
  'TEXTAFTER("a-b-c","-",-3)',
  'TEXTAFTER("a-b-c",{"-","b"})',
  'TEXTJOIN(", ",TRUE(),B1:B3)',
  'TEXTJOIN("-",FALSE(),"a","","b")',
  'TEXTJOIN("-",TRUE(),"a","","b")',
  'TEXTJOIN({"1","2"},TRUE(),A1:A5)',
  'LENB("abc")',
  'LENB("日本語")',
  'LEFTB("日本語",3)',
  'RIGHTB("日本語",4)',
  'MIDB("日本語",2,3)',
  'REPLACEB("日本語",3,2,"X")',
  'FINDB("本","日本語")',
  'SEARCHB("B","abc")',
  'TEXT(1234.5,"#,##0.00")',
  'TEXT(0.25,"0%")',
  'TEXT(45306,"yyyy-mm-dd")',
  'TEXT("abc","@")',
  'TEXT(3.14159,"0.00")',
  'SUBSTITUTE("a-b-c","-","+",2)',
  'SUBSTITUTE("a-b-c","-","+",5)',
  'PROPER("hELLO wORLD")',
  'WEEKDAY(DATE(2024,1,7),2)',
  'WEEKDAY(DATE(2024,1,7),3)',
  'WEEKDAY(DATE(2024,1,7),16)',
  'ISERR(1/0)',
  'ISERR(NA())',
  'ISNA(NA())',
  'ISNA(1)',
  'ISLOGICAL(TRUE())',
  'ISLOGICAL(1)',
  'ISNONTEXT(B1)',
  'ISNONTEXT(A1)',
  'ISNONTEXT(Z99)',
  'ISEVEN(4)',
  'ISEVEN(-3.5)',
  'ISEVEN(Z99)',
  'ISODD(3)',
  'ISODD(2.9)',
  'ISEVEN_ADD(4)',
  'ISODD_ADD(3)',
  'ISEVEN("x")',
  'N(5)',
  'N("x")',
  'N(TRUE())',
  'N(B1)',
  'N(C1)',
  'TYPE(1)',
  'TYPE("a")',
  'TYPE(TRUE())',
  'TYPE(1/0)',
  'TYPE({1,2})',
  'TYPE(A1)',
  'TYPE(K1)',
  'CURRENT()',
  '1+2+CURRENT()',
  '3*4+CURRENT()',
  'CELL("col",C5)',
  'CELL("row",C5)',
  'CELL("sheet",C5)',
  'CELL("address",C5)',
  'CELL("contents",A2)',
  'CELL("type",B1)',
  'CELL("type",A1)',
  'CELL("type",Z99)',
  'CELL("prefix",B1)',
  'CELL("protect",A1)',
  'CELL("coord",C5)',
  'INFO("numfile")',
  'INFO("recalc")',
  'INFO("nonsense")',
  'FIXED(1234.567)', 'FIXED(1234.567,1)', 'FIXED(1234.567,-2)', 'FIXED(-1234.567,2,TRUE())', 'FIXED(0.5,0)', 'FIXED(1e6,0)',
  'DOLLAR(1234.567)', 'DOLLAR(-1234.567,1)', 'DOLLAR(0.125,2)', 'DOLLAR(1234.5,-2)',
  'DSUM({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"n",{"name";"apple"})',
  'DSUM({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},3,{"n";">1"})',
  'DAVERAGE({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"name";"apple"})',
  'DCOUNT({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"n",{"n";">=2"})',
  'DCOUNTA({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"name",{"d";">15"})',
  'DGET({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"name";"pear"})',
  'DGET({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"name";"apple"})',
  'DGET({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"name";"kiwi"})',
  'DMAX({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"name";"apple"})',
  'DMIN({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"name","n";"apple",">1"})',
  'DPRODUCT({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"n",{"name";"apple";"fig"})',
  'DSTDEV({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"n";">0"})',
  'DSTDEVP({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"n";">0"})',
  'DVAR({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"n";">0"})',
  'DVARP({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"d",{"n";">0"})',
  'DSUM({"name","n","d";"apple",1,10;"pear",2,20;"apple",3,30;"fig",4,40},"nope",{"name";"apple"})',
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
  // An empty text reads back from the file as an empty cell.
  if (ours === '' && theirs === null) return true;
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
