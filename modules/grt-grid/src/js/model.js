/** The sheet, sparsely. */

import { key, parseKey, columnName } from './references.js';
import { SHEET_PRINT_DEFAULTS } from './core/formats/sheet-print.js';

export const FORMAT_VERSION = 1;

export const DEFAULT_COLUMN_WIDTH = 96;
export const DEFAULT_ROW_HEIGHT = 24;

export const DEFAULT_STYLES = {
  normal: { name: 'Default' },
  header: { name: 'Heading', bold: true, bg: '#eeeeee' },
  currency: { name: 'Currency', format: '#,##0.00' },
  percent: { name: 'Percent', format: '0.00%' },
  date: { name: 'Date', format: 'yyyy-mm-dd' },
  // LibreOffice's own cell styles, with its colours, so a sheet styled there looks the same here.
  accent: { name: 'Accent', bold: true },
  accent1: { name: 'Accent 1', bold: true, color: '#ffffff', bg: '#000000' },
  accent2: { name: 'Accent 2', bold: true, color: '#ffffff', bg: '#808080' },
  accent3: { name: 'Accent 3', bold: true, bg: '#dddddd' },
  heading1: { name: 'Heading 1', bold: true, size: 18 },
  heading2: { name: 'Heading 2', bold: true, size: 12 },
  good: { name: 'Good', color: '#006600', bg: '#ccffcc' },
  bad: { name: 'Bad', color: '#cc0000', bg: '#ffcccc' },
  neutral: { name: 'Neutral', color: '#996600', bg: '#ffffcc' },
  error: { name: 'Error', bold: true, color: '#ffffff', bg: '#cc0000' },
  warning: { name: 'Warning', color: '#cc0000' },
  footnote: { name: 'Footnote', italic: true, color: '#808080', size: 10 },
  note: { name: 'Note', color: '#333333', bg: '#ffffcc', borders: { top: { style: 'solid', width: 1, color: '#808080' }, bottom: { style: 'solid', width: 1, color: '#808080' }, left: { style: 'solid', width: 1, color: '#808080' }, right: { style: 'solid', width: 1, color: '#808080' } } },
};

/** How a sheet prints, when nothing has been chosen; files read and write the same. */
export const PRINT_DEFAULTS = SHEET_PRINT_DEFAULTS;

const index = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/** Whether something is a block of cells: top, left, bottom and right, in order. */
export const isArea = (a) => Boolean(a) && [a.top, a.left, a.bottom, a.right].every((v) => index(v) !== null)
  && a.bottom >= a.top && a.right >= a.left;

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
  constructor({
    id = null, name = 'Sheet1', cells = {}, cols = {}, rows = {}, frozen = null, print = null,
    merges = [], filter = null, conditions = [], validations = [], pivots = [], hidden = false, tab = null,
  } = {}) {
    this.id = id ?? nextId('sh');
    this.name = name;
    this.hidden = Boolean(hidden);
    /** The colour of the sheet's tab, as `#rrggbb`, or null. */
    this.tab = /^#[0-9a-f]{6}$/i.test(tab ?? '') ? tab.toLowerCase() : null;
    this.cells = new Map(Object.entries(cells));
    this.cols = new Map(Object.entries(cols).map(([k, v]) => [Number(k), v]));
    this.rows = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
    this.frozen = frozen ? { rows: frozen.rows ?? 0, cols: frozen.cols ?? 0 } : { rows: 0, cols: 0 };
    this.print = normalisePrint(print ?? {});
    /** Blocks shown as one cell, the top-left one holding the content. */
    this.merges = (merges ?? []).filter(isArea).map((area) => ({ ...area }));
    /** The autofilter: the area it covers and, by column offset, what each column lets through. */
    this.filter = filter && isArea(filter.area) ? { area: { ...filter.area }, columns: { ...(filter.columns ?? {}) } } : null;
    /** Rows the filter hides, worked out again from the filter rather than saved. */
    this.filtered = new Set();
    /** Formatting that depends on a cell's value, in the order it is tried. */
    this.conditions = structuredClone(conditions ?? []);
    /** Rules on what cells accept. */
    this.validations = structuredClone(validations ?? []);
    /** Pivot tables whose results sit on this sheet, each with the area it last filled. */
    this.pivots = structuredClone(pivots ?? []).filter((p) => p && typeof p.source === 'string' && (!p.area || isArea(p.area)));
    /** Values a formula spills into the cells beside it, worked out again rather than saved. */
    this.spills = new Map();
    /** The cells whose formula spills, with the size of the block. */
    this.anchors = new Map();
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
    // Merged blocks, the filter and the areas of conditions and rules move with their cells.
    const shiftArea = (area) => {
      const span = shiftSpan(area[low], area[high], change);
      return span ? { ...area, [low]: span[0], [high]: span[1] } : null;
    };
    this.merges = this.merges.map(shiftArea).filter(Boolean);
    if (this.filter) {
      const area = shiftArea(this.filter.area);
      this.filter = area ? { ...this.filter, area } : null;
    }
    for (const list of ['conditions', 'validations']) {
      this[list] = this[list].map((rule) => ({ ...rule, area: shiftArea(rule.area) })).filter((rule) => rule.area);
    }
    for (const pivot of this.pivots) if (pivot.area) pivot.area = shiftArea(pivot.area) ?? pivot.area;

    const breaks = change.axis === 'row' ? 'rowBreaks' : 'colBreaks';
    print[breaks] = print[breaks].map((at) => shiftIndex(at, change)).filter((at) => at !== null && at > 0);
    this.print = normalisePrint(print);
  }

  cell(row, col) {
    return this.cells.get(key(row, col)) ?? null;
  }

  /** The stored value of a cell. */
  valueAt(row, col) {
    const at = key(row, col);
    const cell = this.cells.get(at);
    if (cell !== undefined && (cell.v !== undefined || cell.f !== undefined)) return cell.v ?? null;
    return this.spills.has(at) ? this.spills.get(at) : null;
  }

  formulaAt(row, col) {
    return this.cells.get(key(row, col))?.f ?? null;
  }

  styleAt(row, col) {
    return this.cells.get(key(row, col))?.s ?? null;
  }

  /** Writes a cell; null for everything removes it. */
  set(row, col, { v = undefined, f = undefined, s = undefined, sp = undefined } = {}) {
    const at = key(row, col);
    const existing = this.cells.get(at);
    const cell = { ...(existing ?? {}) };

    if (v !== undefined) { if (v === null) delete cell.v; else cell.v = v; }
    if (f !== undefined) { if (f === null) delete cell.f; else cell.f = f; }
    if (s !== undefined) { if (s === null) delete cell.s; else cell.s = s; }
    // Marks a formula that spills, so it runs again when the document opens.
    if (sp !== undefined) { if (sp === null) delete cell.sp; else cell.sp = sp; }

    if (Object.keys(cell).length === 0) this.cells.delete(at);
    else this.cells.set(at, cell);

    return cell;
  }

  clear(row, col) {
    this.cells.delete(key(row, col));
  }

  columnWidth(col) {
    const column = this.cols.get(col);
    return column?.hidden ? 0 : column?.w ?? DEFAULT_COLUMN_WIDTH;
  }

  rowHeight(row) {
    const line = this.rows.get(row);
    if (line?.hidden || this.filtered.has(row)) return 0;
    return line?.h ?? DEFAULT_ROW_HEIGHT;
  }

  /** Whether a row or column is out of sight, hidden by hand or by the filter. */
  isHidden(axis, index) {
    if (axis === 'row') return Boolean(this.rows.get(index)?.hidden) || this.filtered.has(index);
    return Boolean(this.cols.get(index)?.hidden);
  }

  setHidden(axis, index, hidden) {
    const map = axis === 'row' ? this.rows : this.cols;
    const line = { ...(map.get(index) ?? {}) };
    if (hidden) line.hidden = true; else delete line.hidden;
    if (Object.keys(line).length === 0) map.delete(index); else map.set(index, line);
  }

  /** The merged block a cell belongs to, or null. */
  mergeAt(row, col) {
    return this.merges.find((m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right) ?? null;
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

    for (const [at, anchor] of this.anchors) {
      if (anchor.blocked) continue;
      const { row, col } = parseKey(at);
      top = Math.min(top, row);
      left = Math.min(left, col);
      bottom = Math.max(bottom, row + anchor.rows - 1);
      right = Math.max(right, col + anchor.cols - 1);
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
      ...(this.hidden ? { hidden: true } : {}),
      ...(this.tab ? { tab: this.tab } : {}),
      ...(printJson(this.print) ? { print: printJson(this.print) } : {}),
      ...(this.merges.length > 0 ? { merges: this.merges.map((m) => ({ ...m })) } : {}),
      ...(this.filter ? { filter: structuredClone(this.filter) } : {}),
      ...(this.conditions.length > 0 ? { conditions: structuredClone(this.conditions) } : {}),
      ...(this.validations.length > 0 ? { validations: structuredClone(this.validations) } : {}),
      ...(this.pivots.length > 0 ? { pivots: structuredClone(this.pivots) } : {}),
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
    /** Defined names: upper-case name to the text of what it stands for, such as `=Sheet1!$A$1:$A$9`. */
    this.names = {};
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
    // A chart read from a file names its sheet by position.
    this.charts = structuredClone(document.charts ?? []).map((chart) => (typeof chart.sheet === 'number'
      ? { ...chart, sheet: this.sheets[chart.sheet]?.id ?? this.sheets[0]?.id } : chart));
    this.names = { ...(document.names ?? {}) };
    // One sheet at least stays in view.
    if (this.sheets.length && this.sheets.every((s) => s.hidden)) this.sheets[0].hidden = false;
    this.activeSheetId = this.sheets.find((s) => !s.hidden)?.id ?? this.sheets[0]?.id ?? null;
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
    if (this.sheets.every((s) => s.hidden)) this.sheets[0].hidden = false;
    this.charts = this.charts.filter((chart) => chart.sheet !== id);
    if (this.activeSheetId === id) this.activeSheetId = this.nearestShown(index);
    this.dirty = true;
    return removed;
  }

  /** The id of the shown sheet nearest a position, looking forward first. */
  nearestShown(index) {
    const after = this.sheets.slice(index).find((s) => !s.hidden);
    const before = this.sheets.slice(0, index).reverse().find((s) => !s.hidden);
    return (after ?? before ?? this.sheets[0]).id;
  }

  /** Hides or shows a sheet; the last one shown is not hidden. */
  setSheetHidden(id, hidden) {
    const sheet = this.sheetById(id);
    if (!sheet || sheet.hidden === hidden) return false;
    if (hidden && this.sheets.filter((s) => !s.hidden).length <= 1) return false;
    sheet.hidden = hidden;
    if (hidden && this.activeSheetId === id) this.activeSheetId = this.nearestShown(this.sheets.indexOf(sheet));
    this.dirty = true;
    return true;
  }

  /** Moves a sheet to a position among the sheets. */
  moveSheet(id, to) {
    const from = this.sheets.findIndex((s) => s.id === id);
    if (from === -1) return false;
    const at = Math.max(0, Math.min(this.sheets.length - 1, to));
    if (at === from) return false;
    const [sheet] = this.sheets.splice(from, 1);
    this.sheets.splice(at, 0, sheet);
    this.dirty = true;
    return true;
  }

  /** A copy of a sheet, with its charts, put at a position under a free name. */
  copySheet(id, to = null, name = null) {
    const source = this.sheetById(id);
    if (!source) return null;
    const { id: _id, name: _name, ...rest } = source.toJSON();
    const taken = new Set(this.sheets.map((s) => s.name.toLowerCase()));
    const base = name ?? `${source.name}_2`;
    let chosen = base;
    for (let n = 2; taken.has(chosen.toLowerCase()); n += 1) chosen = `${name ?? source.name}_${n}`;
    // Pivot tables stay with the sheet they were made on.
    const copy = new Sheet({ ...rest, name: chosen, hidden: false, pivots: [] });
    this.sheets.splice(to ?? this.sheets.indexOf(source) + 1, 0, copy);
    for (const chart of this.charts.filter((c) => c.sheet === id)) {
      this.charts.push({ ...structuredClone(chart), id: nextId('chart'), sheet: copy.id });
    }
    this.dirty = true;
    return copy;
  }

  /** Sets the colour of a sheet's tab; null takes it away. */
  setTabColour(id, colour) {
    const sheet = this.sheetById(id);
    if (!sheet) return false;
    sheet.tab = /^#[0-9a-f]{6}$/i.test(colour ?? '') ? colour.toLowerCase() : null;
    this.dirty = true;
    return true;
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
      names: { ...this.names },
      activeSheetId: this.activeSheetId,
      dirty: this.dirty,
    };
  }

  restore(state) {
    this.sheets = state.sheets.map((sheet) => new Sheet(sheet));
    this.styles = structuredClone(state.styles);
    this.charts = structuredClone(state.charts);
    this.names = { ...(state.names ?? {}) };
    this.activeSheetId = state.activeSheetId;
    this.dirty = state.dirty;
  }

  /** The document as other programs' formats take it: spilled values written out, block formulas marked with their size. */
  exportJSON() {
    const json = this.toJSON();
    json.sheets.forEach((out, i) => {
      const sheet = this.sheets[i];
      const cells = { ...out.cells };
      for (const [at, cell] of Object.entries(cells)) {
        if (cell.sp) {
          const { sp, ...rest } = cell;
          cells[at] = rest;
        }
      }
      for (const [at, anchor] of sheet.anchors) {
        if (!anchor.blocked && cells[at]) cells[at] = { ...cells[at], a: [anchor.rows, anchor.cols] };
      }
      for (const [at, value] of sheet.spills) {
        if (value !== null && value !== undefined) cells[at] = { ...(cells[at] ?? {}), v: value };
      }
      out.cells = cells;
      if (sheet.filtered.size > 0) out.filteredRows = [...sheet.filtered].sort((x, y) => x - y);
    });
    return json;
  }

  toJSON() {
    return {
      version: FORMAT_VERSION,
      type: 'grid',
      sheets: this.sheets.map((sheet) => sheet.toJSON()),
      styles: this.styles,
      charts: this.charts,
      ...(Object.keys(this.names).length > 0 ? { names: Object.fromEntries(Object.entries(this.names).sort()) } : {}),
    };
  }
}

/** `A1` style label for a column header. */
export { columnName };
