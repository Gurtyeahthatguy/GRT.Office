/** Add and Delete Decimal Place, and the indent steps, as Calc's buttons change a cell's look. */

import { describe, it, expect } from 'vitest';
import { decimalsChanged, SheetController } from '../src/js/controller.js';
import { GridModel } from '../src/js/model.js';

describe('Decimal places and indents', () => {
  it('one more or one fewer digit after the point, in every part, quoted text left alone', () => {
    expect(decimalsChanged(null, 1)).toBe('0.0');
    expect(decimalsChanged('0', 1)).toBe('0.0');
    expect(decimalsChanged('0.00', -1)).toBe('0.0');
    expect(decimalsChanged('0.0', -1)).toBe('0');
    expect(decimalsChanged('#,##0', 1)).toBe('#,##0.0');
    expect(decimalsChanged('0%', 1)).toBe('0.0%');
    expect(decimalsChanged('#,##0.00 "€";-#,##0.00 "€"', 1)).toBe('#,##0.000 "€";-#,##0.000 "€"');
    expect(decimalsChanged('"Tot 10" 0', 1)).toBe('"Tot 10" 0.0');
    expect(decimalsChanged('0.00E+00', 1)).toBe('0.000E+00');
  });

  it('the controller changes the cells chosen, and the indent goes by steps, never below none', () => {
    const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells: { '0,0': { v: 3.14159 } } }] });
    const sheet = new SheetController(model, { onChange: () => {} });
    sheet.changeDecimals(1);
    sheet.changeDecimals(1);
    expect(sheet.styleAt(0, 0).format).toBe('0.00');
    sheet.changeIndent(1);
    expect(sheet.styleAt(0, 0).indent).toBe(1);
    sheet.changeIndent(-1);
    sheet.changeIndent(-1);
    expect(sheet.styleAt(0, 0).indent).toBeUndefined();
  });
});
