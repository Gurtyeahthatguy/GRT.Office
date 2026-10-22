/** Formulas between Grid, OpenFormula and Excel's files. */

import { describe, it, expect } from 'vitest';
import {
  fromOpenFormula, toOpenFormula, fromExcelFormula, toExcelFormula, shiftFormula,
} from '../src/js/core/formats/formulas.js';

const of = (text) => fromOpenFormula(text).formula;

describe('OpenFormula into Grid', () => {
  it('reads references, ranges and sheets', () => {
    expect(of('of:=SUM([.A1:.B2];[$Sheet2.C3])')).toBe('=SUM(A1:B2,Sheet2!C3)');
    expect(of("of:=['My Sheet'.$A$1]+[$'It''s'.B2:.C3]")).toBe("='My Sheet'!$A$1+'It''s'!B2:C3");
    expect(of('of:=COUNT([.A:.A])+[.2:.4]')).toBe('=COUNT(A:A)+2:4');
  });

  it('leaves strings alone, semicolons and brackets included', () => {
    expect(of('of:=IF([.A1]="a;[b]";1;2)')).toBe('=IF(A1="a;[b]",1,2)');
    expect(of('of:=CONCATENATE("say ""hi""";[.A1])')).toBe('=CONCATENATE("say ""hi""",A1)');
  });

  it('turns array constants around: columns by comma, rows by semicolon', () => {
    expect(of('of:=SUM({1;2|3;4})')).toBe('=SUM({1,2;3,4})');
  });

  it('reads Microsoft’s functions by their names, and broken references as #REF!', () => {
    expect(of('of:=COM.MICROSOFT.TEXTJOIN(",";1;[.A1:.A3])')).toBe('=TEXTJOIN(",",1,A1:A3)');
    expect(of('of:=[.#REF!]+1')).toBe('=#REF!+1');
  });

  it('reads Excel syntax stored in an ODF file as it is', () => {
    expect(of('msoxl:=SUM(A1:A3)')).toBe('=SUM(A1:A3)');
  });

  it('says what it could not carry', () => {
    expect(fromOpenFormula("of:=['file:///x.ods'#$Sheet1.A1]").problems).toContain('References to other files');
  });
});

describe('Grid into OpenFormula', () => {
  it('writes references, ranges and sheets in brackets', () => {
    expect(toOpenFormula('=SUM(A1:B2,Sheet2!C3)')).toBe('of:=SUM([.A1:.B2];[$Sheet2.C3])');
    expect(toOpenFormula("='My Sheet'!$A$1*2")).toBe("of:=[$'My Sheet'.$A$1]*2");
  });

  it('does not take a function, a number or a string for a reference', () => {
    expect(toOpenFormula('=LOG10(A1)+1E3+"B2"')).toBe('of:=LOG10([.A1])+1E3+"B2"');
    expect(toOpenFormula('=ATAN2(1,2)')).toBe('of:=ATAN2(1;2)');
  });

  it('writes Microsoft’s functions in their namespace, as LibreOffice does', () => {
    expect(toOpenFormula('=TEXTJOIN(",",TRUE,A1:A3)')).toBe('of:=COM.MICROSOFT.TEXTJOIN(",";TRUE;[.A1:.A3])');
  });

  it('comes back to where it started', () => {
    for (const formula of ['=SUM(A1:B2,Sheet2!C3)', "=IF('My Sheet'!$A$1>0,\"yes\",\"no\")", '=COUNT(A:A)', '=SUM({1,2;3,4})']) {
      expect(of(toOpenFormula(formula))).toBe(formula);
    }
  });
});

describe('Excel’s files', () => {
  it('drops the prefix newer functions are stored with, and puts it back', () => {
    expect(fromExcelFormula('_xlfn.CONCAT(A1,B1)')).toBe('=CONCAT(A1,B1)');
    expect(toExcelFormula('=CONCAT(A1,B1)+IFNA(C1,0)')).toBe('_xlfn.CONCAT(A1,B1)+_xlfn.IFNA(C1,0)');
    expect(toExcelFormula('=SUM(A1;B1)')).toBe('SUM(A1,B1)');
    expect(fromExcelFormula('TRANSPOSE(_xlfn._xlws.SORT(A1:A4))')).toBe('=TRANSPOSE(SORT(A1:A4))');
    expect(toExcelFormula('=SORT(A1:A4)')).toBe('_xlfn._xlws.SORT(A1:A4)');
  });

  it('moves a shared formula: relative parts move, fixed ones stay', () => {
    expect(shiftFormula('=A1*$B$1+B$2+$C3', 2, 1)).toBe('=B3*$B$1+C$2+$C5');
    expect(shiftFormula("=SUM('Other'!A1:A3)", 1, 0)).toBe("=SUM(Other!A2:A4)");
    expect(shiftFormula('=SUM(A:A)+COUNT(1:1)', 1, 1)).toBe('=SUM(B:B)+COUNT(2:2)');
    expect(shiftFormula('=A1', -1, 0)).toBe('=#REF!');
  });

  it('CANARY: leaves a formula without references as it is', () => {
    expect(shiftFormula('=PI()*2', 5, 5)).toBe('=PI()*2');
  });
});
