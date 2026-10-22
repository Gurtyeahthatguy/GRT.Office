/** The sheet, sparsely. */

import { key, parseKey, columnName } from './references.js';
import { SHEET_PRINT_DEFAULTS } from './core/formats/sheet-print.js';

export const FORMAT_VERSION = 1;

export const DEFAULT_COLUMN_WIDTH = 96;
export const DEFAULT_ROW_HEIGHT = 24;

export const DEFAULT_STYLES = {
  normal: {},
  header: { bold: true, bg: '#eeeeee' },
  currency: { format: '#,##0.00' },
  percent: { format: '0.00%' },
  date: { format: 'yyyy-mm-dd' },
};

/** How a sheet prints, when nothing has been chosen; files read and write the same. */
export const PRINT_DEFAULTS = SHEET_PRINT_DEFAULTS;

const index = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/** A sheet's print settings, every field present and sane. */
export function normalisePrint(raw = {}) {
  const out = { ...PRINT_DEFAULTS, rowBreaks: [], colBreaks: [] };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.size === 'string') out.size = raw.size;
  if (raw.size === 'custom') {
    if (raw.width > 0 && raw.height > 0) Object.assign(out, { width: raw.width, height: raw.height });
    else out.size = PRINT_DEFAULTS.size;
  }
  if (raw.orientation === 'landscape') out.orientation = 'landscape';
  if (Number.isFinite(raw.margin)) out.margin = Math.min(50, Math.max(0, raw.margin));
  for (const flag of ['fitWidth', 'gridlines', 'labels']) if (typeof raw[flag] === 'boolean') out[flag] = raw[flag];
  const area = raw.area;
  if (area && [area.top, area.left, area.bottom, area.right].every((v) => index(v) !== null)
    && area.bottom >= area.top && area.right >= area.left) {
    out.area = { top: area.top, left: area.left, bottom: area.bottom, right: area.right };
  }
  const repeat = raw.repeatRows;
  if (repeat && index(repeat.top) !== null && index(repeat.bottom) !== null && repeat.bottom >= repeat.top) {
    out.repeatRows = { top: repeat.top, bottom: repeat.bottom };
  }
  for (const list of ['rowBreaks', 'colBreaks']) {
    if (Array.isArray(raw[list])) {
      out[list] = [...new Set(raw[list].filter((v) => index(v) !== null && v > 0))].sort((a, b) => a - b);
    }
  }
  return out;
}

/** The print settings that differ from the defaults. */
function printJson(print) {
  const out = {};
  for (const [name, value] of Object.entries(print)) {
    if (JSON.stringify(value) !== JSON.stringify(PRINT_DEFAULTS[name])) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Where a row or column ends up when some are inserted or removed; null when it was removed. */
export function shiftIndex(at, change) {
  if (change.count > 0) return at < change.at ? at : at + change.count;
  const removed = -change.count;
  if (at < change.at) return at;
  return at < change.at + removed ? null : at - removed;
}

/** A span of rows or columns after the same, or null when all of it went. */
function shiftSpan(low, high, change) {
  if (change.count > 0) {
    return [low < change.at ? low : low + change.count, high < change.at ? high : high + change.count];
  }
  const removed = -change.count;
  const end = change.at + removed;
  const from = low < change.at ? low : low < end ? change.at : low - removed;
  const to = high < change.at ? high : high < end ? change.at - 1 : high - removed;
  return to >= from ? [from, to] : null;
}

let counter = 0;
const nextId = (prefix) => {
  counter += 1;
  return `${prefix}${counter}`;
};

/** One sheet. `cells` maps `"row,col"` to `{v, f, s}`. */
export class Sheet {
  constructor({ id = null, name = 'Sheet1', cells = {}, cols = {}, rows = {}, frozen = null, print = null } = {}) {
    this.id = id ?? nextId('sh');
    this.name = name;
    this.cells = new Map(Object.entries(cells));
    this.cols = new Map(Object.entries(cols).map(([k, v]) => [Number(k), v]));
    this.rows = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
    this.frozen = frozen ? { rows: frozen.rows ?? 0, cols: frozen.cols ?? 0 } : { rows: 0, cols: 0 };
    this.print = normalisePrint(print ?? {});
  }

  /**
   * Moves what belongs to rows or columns, other than cells, when some are inserted or removed:
   * their sizes, the frozen panes and the print settings.
   * @param {{axis: 'row'|'col', at: number, count: number}} change
   */
  shiftAxis(change) {
    const sizes = change.axis === 'row' ? this.rows : this.cols;
    const moved = new Map();
    for (const [at, size] of sizes) {
      const to = shiftIndex(at, change);
      if (to !== null) moved.set(to, size);
    }
    if (change.axis === 'row') this.rows = moved;
    else this.cols = moved;

    const frozen = change.axis === 'row' ? 'rows' : 'cols';
    if (this.frozen[frozen] > 0) {
      const span = shiftSpan(0, this.frozen[frozen] - 1, change);
      this.frozen = { ...this.frozen, [frozen]: span ? span[1] + 1 : 0 };
    }

    const print = { ...this.print };
    const [low, high] = change.axis === 'row' ? ['top', 'bottom'] : ['left', 'right'];
    if (print.area) {
      const span = shiftSpan(print.area[low], print.area[high], change);
      print.area = span ? { ...print.area, [low]: span[0], [high]: span[1] } : null;
    }
    if (change.axis === 'row' && print.repeatRows) {
      const span = shiftSpan(print.repeatRows.top, print.repeatRows.bottom, change);
      print.repeatRows = span ? { top: span[0], bottom: span[1] } : null;
    }
    const breaks = change.axis === 'row' ? 'rowBreaks' : 'colBreaks';
    print[breaks] = print[breaks].map((at) => shiftIndex(at, change)).filter((at) => at !== null && at > 0);
    this.print = normalisePrint(print);
  }

  cell(row, col) {
    return this.cells.get(key(row, col)) ?? null;
  }

  /** The stored value of a cell. */
  valueAt(row, col) {
    const cell = this.cells.get(key(row, col));
    return cell === undefined ? null : (cell.v ?? null);
  }

  formulaAt(row, col) {
    return this.cells.get(key(row, col))?.f ?? null;
  }

  styleAt(row, col) {
    return this.cells.get(key(row, col))?.s ?? null;
  }

  /** Writes a cell; null for everything removes it. */
  set(row, col, { v = undefined, f = undefined, s = undefined } = {}) {
    const at = key(row, col);
    const existing = this.cells.get(at);
    const cell = { ...(existing ?? {}) };

    if (v !== undefined) { if (v === null) delete cell.v; else cell.v = v; }
    if (f !== undefined) { if (f === null) delete cell.f; else cell.f = f; }
    if (s !== undefined) { if (s === null) delete cell.s; else cell.s = s; }

    if (Object.keys(cell).length === 0) this.cells.delete(at);
    else this.cells.set(at, cell);

    return cell;
  }

  clear(row, col) {
    this.cells.delete(key(row, col));
  }

  columnWidth(col) {
    return this.cols.get(col)?.w ?? DEFAULT_COLUMN_WIDTH;
  }

  rowHeight(row) {
    return this.rows.get(row)?.h ?? DEFAULT_ROW_HEIGHT;
  }

  setColumnWidth(col, width) {
    this.cols.set(col, { ...(this.cols.get(col) ?? {}), w: Math.max(24, Math.round(width)) });
  }

  setRowHeight(row, height) {
    this.rows.set(row, { ...(this.rows.get(row) ?? {}), h: Math.max(14, Math.round(height)) });
  }

  /** Where the content stops. */
  usedBounds() {
    let top = Infinity;
    let left = Infinity;
    let bottom = -Infinity;
    let right = -Infinity;

    for (const [at, cell] of this.cells) {
      // A cell with formatting alone holds nothing.
      if (cell.f === undefined && (cell.v === undefined || cell.v === null || cell.v === '')) continue;
      const { row, col } = parseKey(at);
      if (row < top) top = row;
      if (col < left) left = col;
      if (row > bottom) bottom = row;
      if (col > right) right = col;
    }

    return top === Infinity ? null : { top, left, bottom, right };
  }

  /** Every cell that holds a formula, as `[key, text]`. */
  *formulas() {
    for (const [at, cell] of this.cells) {
      if (cell.f) yield [at, cell.f];
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cells: Object.fromEntries([...this.cells.entries()].sort(compareKeys)),
      cols: Object.fromEntries([...this.cols.entries()].sort((a, b) => a[0] - b[0])),
      rows: Object.fromEntries([...this.rows.entries()].sort((a, b) => a[0] - b[0])),
      frozen: this.frozen,
      ...(printJson(this.print) ? { print: printJson(this.print) } : {}),
    };
  }
}

/** Cell keys sort by row then column, numerically. */
function compareKeys([a], [b]) {
  const left = parseKey(a);
  const right = parseKey(b);
  return left.row - right.row || left.col - right.col;
}

/** A whole document: sheets and the styles they share. */
export class GridModel {
  constructor(document = null) {
    this.sheets = [];
    this.styles = structuredClone(DEFAULT_STYLES);
    this.charts = [];
    this.path = null;
    this.dirty = false;
    this.activeSheetId = null;

    if (document) this.load(document);
    if (this.sheets.length === 0) this.addSheet('Sheet1');
    this.activeSheetId ??= this.sheets[0].id;
    this.dirty = false;
  }

  load(document) {
    this.sheets = (document.sheets ?? []).map((sheet) => new Sheet(sheet));
    this.styles = { ...structuredClone(DEFAULT_STYLES), ...(document.styles ?? {}) };
    this.charts = structuredClone(document.charts ?? []);
    this.activeSheetId = this.sheets[0]?.id ?? null;
  }

  get sheet() {
    return this.sheets.find((s) => s.id === this.activeSheetId) ?? this.sheets[0];
  }

  sheetNamed(name) {
    const wanted = String(name ?? '').toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === wanted) ?? null;
  }

  sheetById(id) {
    return this.sheets.find((s) => s.id === id) ?? null;
  }

  addSheet(name = null) {
    const taken = new Set(this.sheets.map((s) => s.name.toLowerCase()));
    let chosen = name ?? `Sheet${this.sheets.length + 1}`;
    let n = 2;
    while (taken.has(chosen.toLowerCase())) {
      chosen = `${name ?? 'Sheet'}${n}`;
      n += 1;
    }

    const sheet = new Sheet({ name: chosen });
    this.sheets.push(sheet);
    this.dirty = true;
    return sheet;
  }

  removeSheet(id) {
    if (this.sheets.length <= 1) return null;
    const index = this.sheets.findIndex((s) => s.id === id);
    if (index === -1) return null;

    const [removed] = this.sheets.splice(index, 1);
    if (this.activeSheetId === id) {
      this.activeSheetId = this.sheets[Math.min(index, this.sheets.length - 1)].id;
    }
    this.dirty = true;
    return removed;
  }

  renameSheet(id, name) {
    const sheet = this.sheetById(id);
    if (!sheet) return false;
    const cleaned = String(name ?? '').trim();
    if (!cleaned || this.sheets.some((s) => s !== sheet && s.name.toLowerCase() === cleaned.toLowerCase())) {
      return false;
    }
    sheet.name = cleaned;
    this.dirty = true;
    return true;
  }

  // Undo

  snapshot() {
    return {
      sheets: this.sheets.map((sheet) => sheet.toJSON()),
      styles: structuredClone(this.styles),
      charts: structuredClone(this.charts),
      activeSheetId: this.activeSheetId,
      dirty: this.dirty,
    };
  }

  restore(state) {
    this.sheets = state.sheets.map((sheet) => new Sheet(sheet));
    this.styles = structuredClone(state.styles);
    this.charts = structuredClone(state.charts);
    this.activeSheetId = state.activeSheetId;
    this.dirty = state.dirty;
  }

  toJSON() {
    return {
      version: FORMAT_VERSION,
      type: 'grid',
      sheets: this.sheets.map((sheet) => sheet.toJSON()),
      styles: this.styles,
      charts: this.charts,
    };
  }
}

/** `A1` style label for a column header. */
export { columnName };
