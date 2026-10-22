/** How a sheet prints, in the terms spreadsheet files use. */

import { PAGE_SIZES, pageDimensions, pageSizeFields } from '../editor/model.js';

export const SHEET_PRINT_DEFAULTS = Object.freeze({
  size: 'A4',
  orientation: 'portrait',
  margin: 15,
  fitWidth: false,
  gridlines: false,
  labels: true,
  area: null,
  repeatRows: null,
  rowBreaks: Object.freeze([]),
  colBreaks: Object.freeze([]),
});

/** A sheet's print settings with every field present. */
export function sheetPrint(sheet) {
  return { ...SHEET_PRINT_DEFAULTS, ...(sheet?.print ?? {}) };
}

/** The paper in millimetres, short side first, and which way it lies. */
export function paperOf(print) {
  const size = pageDimensions(print);
  return { short: size.w, long: size.h, landscape: print.orientation === 'landscape' };
}

/** The fields for paper read from a file. */
export function paperFields(width, height) {
  return pageSizeFields(width, height);
}

// Excel numbers its paper sizes.
const EXCEL_PAPER = { 1: 'Letter', 3: 'Tabloid', 5: 'Legal', 7: 'Executive', 8: 'A3', 9: 'A4', 11: 'A5', 34: 'B5', 70: 'A6' };
// The same papers under other numbers, and a few more by their size.
const EXCEL_ALIASES = { 2: 'Letter', 4: 'Tabloid', 10: 'A4' };
const EXCEL_CUSTOM = { 6: [140, 216], 12: [257, 364], 13: [182, 257], 66: [420, 594] };

/** The paper an Excel number names; 0, which some programs write, names none. */
export function paperFromExcel(code) {
  if (code === 0) return { size: SHEET_PRINT_DEFAULTS.size };
  if (EXCEL_ALIASES[code]) return { size: EXCEL_ALIASES[code] };
  if (EXCEL_PAPER[code]) return { size: EXCEL_PAPER[code] };
  if (EXCEL_CUSTOM[code]) return paperFields(...EXCEL_CUSTOM[code]);
  return null;
}

export function excelPaperCode(print) {
  const found = Object.entries(EXCEL_PAPER).find(([, id]) => id === print.size);
  return found ? found[0] : null;
}

const quoted = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

function columnIndex(letters) {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function columnLetters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** An endpoint without its sheet: what follows the last `!` or `.` outside quotes. */
function bare(endpoint) {
  let cut = -1;
  let inQuotes = false;
  for (let i = 0; i < endpoint.length; i += 1) {
    const c = endpoint[i];
    if (c === "'") inQuotes = !inQuotes;
    else if (!inQuotes && (c === '!' || c === '.')) cut = i;
  }
  return endpoint.slice(cut + 1).replace(/\$/g, '');
}

/**
 * One reference to cells, whole rows or whole columns, as files write them:
 * `Data!$A$1:$P$60`, `$Data.$A$1:.$P$60`, `'My data'!$1:$2`, `Data!$A:$A`.
 * @returns {?{kind: 'cells'|'rows'|'cols', top?: number, left?: number, bottom?: number, right?: number}}
 */
export function parseSheetRange(text) {
  const parts = splitOutsideQuotes(String(text ?? '').trim(), ':');
  if (parts.length === 0 || parts.length > 2) return null;
  const [a, b = parts[0]] = parts.map(bare);
  let m = /^([A-Za-z]{1,3})(\d+)$/.exec(a);
  let n = /^([A-Za-z]{1,3})(\d+)$/.exec(b);
  if (m && n) {
    const rows = [Number(m[2]) - 1, Number(n[2]) - 1];
    const cols = [columnIndex(m[1]), columnIndex(n[1])];
    return { kind: 'cells', top: Math.min(...rows), bottom: Math.max(...rows), left: Math.min(...cols), right: Math.max(...cols) };
  }
  m = /^(\d+)$/.exec(a);
  n = /^(\d+)$/.exec(b);
  if (m && n) return { kind: 'rows', top: Math.min(m[1], n[1]) - 1, bottom: Math.max(m[1], n[1]) - 1 };
  m = /^([A-Za-z]{1,3})$/.exec(a);
  n = /^([A-Za-z]{1,3})$/.exec(b);
  if (m && n) return { kind: 'cols', left: Math.min(columnIndex(m[1]), columnIndex(n[1])), right: Math.max(columnIndex(m[1]), columnIndex(n[1])) };
  return null;
}

/** Splits on a separator that is not inside quotes. */
export function splitOutsideQuotes(text, separator) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (const c of text) {
    if (c === "'") inQuotes = !inQuotes;
    if (c === separator && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** `'My data'!$A$1:$P$60`, as Excel writes a print area. */
export function excelArea(sheetName, area) {
  return `${quoted(sheetName)}!$${columnLetters(area.left)}$${area.top + 1}:$${columnLetters(area.right)}$${area.bottom + 1}`;
}

/** `'My data'!$1:$2`, as Excel writes rows to repeat. */
export function excelRows(sheetName, rows) {
  return `${quoted(sheetName)}!$${rows.top + 1}:$${rows.bottom + 1}`;
}

/** `'My data'.A1:'My data'.P60`, as OpenDocument writes a print range. */
export function odfArea(sheetName, area) {
  const name = quoted(sheetName);
  return `${name}.${columnLetters(area.left)}${area.top + 1}:${name}.${columnLetters(area.right)}${area.bottom + 1}`;
}

export { PAGE_SIZES };
