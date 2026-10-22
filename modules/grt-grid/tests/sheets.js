/** A workbook that uses what the formats have to carry. */

import { GridModel } from '../src/js/model.js';
import { Engine } from '../src/js/engine/recalc.js';

/** Builds a workbook through the engine. */
export function workbook() {
  const model = new GridModel();
  const engine = new Engine(model);
  const first = model.sheets[0];
  model.renameSheet(first.id, 'Data');
  const other = model.addSheet('My Other');
  model.styles['imported-1'] = { bold: true, bg: '#ffee88', align: 'center' };
  model.styles['imported-2'] = { format: '#,##0.00 "€"', color: '#cc0000' };
  model.styles['imported-3'] = { format: 'dd/mm/yyyy' };
  model.styles['imported-4'] = { format: 'hh:mm:ss' };
  model.styles['imported-5'] = { format: '0.0%' };

  const set = (sheet, address, value) => {
    const col = address.charCodeAt(0) - 65;
    const row = Number(address.slice(1)) - 1;
    if (typeof value === 'string' && value.startsWith('=')) engine.setFormula(sheet.id, row, col, value);
    else engine.setValue(sheet.id, row, col, value);
    return { row, col };
  };
  const style = (sheet, address, name) => {
    const col = address.charCodeAt(0) - 65;
    const row = Number(address.slice(1)) - 1;
    sheet.set(row, col, { s: name });
  };

  set(first, 'A1', 'Item');
  set(first, 'B1', 'Price');
  style(first, 'A1', 'imported-1');
  style(first, 'B1', 'imported-1');
  set(first, 'A2', 'Two  spaces and "quotes"');
  set(first, 'B2', 1234.5);
  style(first, 'B2', 'imported-2');
  set(first, 'A3', 'Negative');
  set(first, 'B3', -42.125);
  set(first, 'C3', true);
  set(first, 'D3', 45356);
  style(first, 'D3', 'imported-3');
  set(first, 'E3', 0.5465625);
  style(first, 'E3', 'imported-4');
  set(first, 'F3', 0.125);
  style(first, 'F3', 'imported-5');
  set(first, 'B4', '=SUM(B2:B3)');
  set(first, 'B5', "=B4*'My Other'!A1");
  set(first, 'B6', '=IF(C3,"yes","no")&" ok"');
  set(first, 'B7', '=1/0');
  set(first, 'B8', '=2^3^2');
  set(first, 'B9', '=ROUND(B2/3,2)');
  set(other, 'A1', 2);
  set(other, 'A2', '=Data!B2+1');
  first.setColumnWidth(0, 180);
  first.setRowHeight(0, 32);
  first.frozen = { rows: 1, cols: 0 };
  return { model, engine };
}

/** The cells of a document as plain values, for comparing two of them. */
export function cellsOf(document) {
  return document.sheets.map((sheet) => ({
    name: sheet.name,
    cells: Object.fromEntries(Object.entries(sheet.cells).map(([key, cell]) => [key, { v: cell.v ?? null, f: cell.f ?? null }])),
  }));
}
