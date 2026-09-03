/** The sheet, sparsely. */

import { key, parseKey, columnName } from './references.js';

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

let counter = 0;
const nextId = (prefix) => {
  counter += 1;
  return `${prefix}${counter}`;
};

/** One sheet. `cells` maps `"row,col"` to `{v, f, s}`. */
export class Sheet {
  constructor({ id = null, name = 'Sheet1', cells = {}, cols = {}, rows = {}, frozen = null } = {}) {
    this.id = id ?? nextId('sh');
    this.name = name;
    this.cells = new Map(Object.entries(cells));
    this.cols = new Map(Object.entries(cols).map(([k, v]) => [Number(k), v]));
    this.rows = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
    this.frozen = frozen ? { rows: frozen.rows ?? 0, cols: frozen.cols ?? 0 } : { rows: 0, cols: 0 };
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

  /**
   * Writes a cell. Passing null for everything removes it entirely, which is
   * what keeps the map sparse after a deletion.
   */
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
    if (this.cells.size === 0) return null;

    let top = Infinity;
    let left = Infinity;
    let bottom = -Infinity;
    let right = -Infinity;

    for (const at of this.cells.keys()) {
      const { row, col } = parseKey(at);
      if (row < top) top = row;
      if (col < left) left = col;
      if (row > bottom) bottom = row;
      if (col > right) right = col;
    }

    return { top, left, bottom, right };
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
