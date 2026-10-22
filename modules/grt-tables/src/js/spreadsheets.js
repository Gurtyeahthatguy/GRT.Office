/** Spreadsheets in and out: a sheet as rows to import, tables and results as sheets. */

const DAY = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);

/** Whether a number format shows a date or a time rather than a number. */
function dateKind(format) {
  const bare = String(format ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  if (!/[ymdhs]/i.test(bare) || /[#0?]/.test(bare)) return null;
  const date = /[yd]/i.test(bare) || /m{3,}/i.test(bare);
  const time = /[hs]/i.test(bare);
  return date && time ? 'datetime' : date ? 'date' : 'time';
}

const pad = (n) => String(n).padStart(2, '0');

/** A spreadsheet serial as ISO text: a date, a time or both. */
export function serialText(serial, kind) {
  const moment = new Date(EPOCH + Math.round(serial * DAY / 1000) * 1000);
  const date = `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`;
  const time = `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}`;
  if (kind === 'date') return date;
  if (kind === 'time') return time;
  return `${date} ${time}`;
}

/** An ISO date, or date and time, as a spreadsheet serial; null when it is not one. */
export function textSerial(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text ?? ''));
  if (!match) return null;
  const [, y, mo, d, h = 0, mi = 0, s = 0] = match.map((v) => (v === undefined ? undefined : Number(v)));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(ms)) return null;
  return (ms - EPOCH) / DAY;
}

/**
 * A sheet of a Grid document as rows of text, the way a CSV file arrives.
 * @param {{cells: Object<string, {v?: any, s?: string}>}} sheet
 * @param {Object<string, {format?: string}>} styles
 * @returns {string[][]}
 */
export function sheetRows(sheet, styles = {}) {
  let bottom = -1;
  let right = -1;
  const cells = [];
  for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
    const [row, col] = key.split(',').map(Number);
    const value = cell?.v;
    if (value === null || value === undefined || value === '') continue;
    let text;
    const kind = typeof value === 'number' ? dateKind(styles[cell.s]?.format) : null;
    if (kind) text = serialText(value, kind);
    else if (typeof value === 'boolean') text = value ? 'true' : 'false';
    else if (typeof value === 'object') text = String(value.error ?? value.code ?? '');
    else text = String(value);
    cells.push([row, col, text]);
    bottom = Math.max(bottom, row);
    right = Math.max(right, col);
  }
  if (cells.length === 0) return [];
  const top = Math.min(...cells.map(([row]) => row));
  const left = Math.min(...cells.map(([, col]) => col));
  const rows = Array.from({ length: bottom - top + 1 }, () => Array(right - left + 1).fill(''));
  for (const [row, col, text] of cells) rows[row - top][col - left] = text;
  // Rows left wholly empty between the data say nothing a table can keep.
  return rows.filter((row) => row.some((value) => value !== ''));
}

/**
 * Tables or results as a Grid document, ready for the spreadsheet writers.
 * @param {{name: string, columns: string[], rows: any[][]}[]} tables
 */
export function tablesAsSpreadsheet(tables) {
  const sheets = tables.map((table, index) => {
    const dated = table.columns.map((_, col) => {
      const values = table.rows.map((row) => row[col]).filter((value) => value !== null && value !== undefined && value !== '');
      return values.length > 0 && values.every((value) => typeof value === 'string' && textSerial(value) !== null);
    });
    const cells = {};
    table.columns.forEach((name, col) => {
      cells[`0,${col}`] = { v: String(name), s: 'header' };
    });
    table.rows.forEach((row, r) => {
      row.forEach((value, col) => {
        if (value === null || value === undefined) return;
        if (dated[col] && textSerial(value) !== null) {
          cells[`${r + 1},${col}`] = { v: textSerial(value), s: /\d:\d/.test(value) ? 'datetime' : 'date' };
        } else if (typeof value === 'number' || typeof value === 'string') {
          cells[`${r + 1},${col}`] = { v: value };
        } else if (typeof value === 'boolean') {
          cells[`${r + 1},${col}`] = { v: value };
        } else {
          cells[`${r + 1},${col}`] = { v: '(file)' };
        }
      });
    });
    return { name: safeSheetName(table.name, index), cells, cols: {}, rows: {}, frozen: { rows: 1, cols: 0 } };
  });
  return {
    version: 1,
    type: 'grid',
    sheets,
    styles: {
      header: { bold: true, bg: '#eeeeee' },
      date: { format: 'yyyy-mm-dd' },
      datetime: { format: 'yyyy-mm-dd hh:mm:ss' },
    },
    charts: [],
  };
}

/** Spreadsheets refuse some characters in sheet names, and names longer than 31. */
function safeSheetName(name, index) {
  return String(name ?? '').replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || `Sheet${index + 1}`;
}
