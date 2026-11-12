/** Selection, navigation, editing. */

import { Engine } from './engine/recalc.js';
import { UndoStack } from './core/undo.js';
import { parseInput } from './format.js';
import { a1, key, columnName } from './references.js';
import { parseCsv, toCsv, coerce, sniff } from './core/csv.js';
import { normalisePrint } from './model.js';
import { ERROR } from './engine/values.js';
import { cleanLook, sameLook, SIDES } from './core/formats/cell-look.js';
import { ConditionalLooks, validate, validationAt, listOptions } from './conditions.js';
import {
  currentRegion, looksLikeHeader, sortPermutation, filteredRows, duplicateRows, splitText, seriesValues, groupBreaks,
} from './data.js';
import { computePivot, readSource } from './pivot.js';
import { seekGoal, solveModel } from './whatif.js';

export class SheetController {
  /**
   * @param {import('./model.js').GridModel} model
   * @param {{onChange?: Function}} options
   */
  constructor(model, options = {}) {
    this.model = model;
    this.engine = new Engine(model);
    this.undo = new UndoStack(model);
    this.onChange = options.onChange ?? (() => {});

    /** The cell the keyboard acts on. */
    /** How the sheet is shown, not saved with it: formulas instead of results, grid lines, the active row and column, values by kind. */
    this.view = { formulas: false, gridlines: true, crosshair: false, values: false, comments: false };
    this.active = { row: 0, col: 0 };
    /**
     * The other corner of the selected block; equal to `active` when single.
     */
    this.anchor = { row: 0, col: 0 };
    /** Text being typed, or null when not editing. */
    this.editing = null;
    /**
     * What the cell said when the edit began, so an untouched edit writes
     * nothing.
     */
    this.editingOrigin = null;

    this.engine.recalculateAll();
    for (const sheet of model.sheets) sheet.filtered = filteredRows(sheet, sheet.filter);
  }

  get sheet() {
    return this.model.sheet;
  }

  get sheetId() {
    return this.model.sheet.id;
  }

  // Selection

  get selection() {
    return {
      top: Math.min(this.active.row, this.anchor.row),
      bottom: Math.max(this.active.row, this.anchor.row),
      left: Math.min(this.active.col, this.anchor.col),
      right: Math.max(this.active.col, this.anchor.col),
    };
  }

  get selectionIsSingle() {
    return this.active.row === this.anchor.row && this.active.col === this.anchor.col;
  }

  /** The address shown in the name box: `A1` or `A1:C4`. */
  get selectionLabel() {
    const { top, bottom, left, right } = this.selection;
    return this.selectionIsSingle ? a1(top, left) : `${a1(top, left)}:${a1(bottom, right)}`;
  }

  select(row, col, { extend = false } = {}) {
    this.commitEdit();
    this.active = { row: Math.max(0, row), col: Math.max(0, col) };
    if (!extend) this.anchor = { ...this.active };
    this.onChange({ selection: true });
  }

  selectRange(top, left, bottom, right) {
    this.commitEdit();
    this.active = { row: top, col: left };
    this.anchor = { row: bottom, col: right };
    this.onChange({ selection: true });
  }

  /** Selects a whole column, as clicking its header does. */
  selectColumn(col, rows = 999) {
    this.selectRange(0, col, rows, col);
  }

  selectRow(row, cols = 999) {
    this.selectRange(row, 0, row, cols);
  }

  /** Moves the active cell. */
  move(rowDelta, colDelta, { extend = false, jump = false } = {}) {
    this.commitEdit();

    let { row, col } = this.active;

    if (jump) {
      ({ row, col } = this.edgeFrom(row, col, rowDelta, colDelta));
    } else {
      row = Math.max(0, row + rowDelta);
      col = Math.max(0, col + colDelta);
    }

    this.active = { row, col };
    if (!extend) this.anchor = { ...this.active };
    this.onChange({ selection: true });
    return this.active;
  }

  /** Where Ctrl+arrow lands. */
  edgeFrom(row, col, rowDelta, colDelta) {
    if (rowDelta === 0 && colDelta === 0) return { row, col };

    const filled = (r, c) => this.sheet.cell(r, c) !== null;
    const bounds = this.sheet.usedBounds();
    const limit = 10000;

    const beyond = (r, c) => {
      if (r < 0 || c < 0) return true;
      if (!bounds) return true;
      return r > bounds.bottom + 1 || c > bounds.right + 1;
    };

    let r = row;
    let c = col;

    const runningThroughData = filled(r + rowDelta, c + colDelta);

    for (let i = 0; i < limit; i += 1) {
      const nextRow = r + rowDelta;
      const nextCol = c + colDelta;
      if (beyond(nextRow, nextCol)) break;

      if (runningThroughData) {
        if (!filled(nextRow, nextCol)) break;
        r = nextRow;
        c = nextCol;
      } else {
        r = nextRow;
        c = nextCol;
        if (filled(r, c)) break;
      }
    }

    return { row: Math.max(0, r), col: Math.max(0, c) };
  }

  // Editing

  /** The text the formula bar shows: the formula if there is one. */
  get activeText() {
    if (this.editing !== null) return this.editing;
    const { row, col } = this.active;
    const formula = this.sheet.formulaAt(row, col);
    if (formula) return formula;
    const value = this.sheet.valueAt(row, col);
    return value === null ? '' : String(value);
  }

  /** Starts editing, optionally with a first character. */
  beginEdit(initial = null) {
    if (this.editing === null) this.editingOrigin = this.activeText;
    this.editing = initial ?? this.editing ?? this.editingOrigin;
    this.onChange({ editing: true });
    return this.editing;
  }

  /** The edit buffer now says this. */
  updateEdit(text) {
    if (this.editing === null) this.editingOrigin = this.activeText;
    this.editing = String(text ?? '');
  }

  cancelEdit() {
    if (this.editing === null) return false;
    this.editing = null;
    this.editingOrigin = null;
    this.onChange({ editing: false });
    return true;
  }

  /** Writes what was typed into the cell. */
  commitEdit() {
    if (this.editing === null) return false;

    const text = this.editing;
    const unchanged = text === this.editingOrigin;
    this.editing = null;
    this.editingOrigin = null;

    if (unchanged) {
      this.onChange({ editing: false });
      return false;
    }

    this.setCell(this.active.row, this.active.col, text);
    return true;
  }

  /**
   * Puts text in a cell, deciding whether it is a formula, a number or a
   * label.
   */
  setCell(row, col, text) {
    const parsed = parseInput(text);
    // A value a rule refuses is not written when the rule says stop; the caller is told either way.
    const rule = parsed.kind === 'formula' ? null : validationAt(this.sheet, row, col);
    if (rule) {
      const verdict = validate(rule, parsed.kind === 'blank' ? null : parsed.value, row, col, this.sheet, this.engine);
      if (!verdict.ok) {
        parsed.refused = rule.error ?? { style: 'stop' };
        if ((rule.error?.style ?? 'stop') === 'stop') {
          this.onChange({ refused: parsed.refused });
          return parsed;
        }
      }
    }

    this.record(() => {
      if (parsed.kind === 'blank') this.engine.clearContent(this.sheetId, row, col);
      else if (parsed.kind === 'formula') this.engine.setFormula(this.sheetId, row, col, parsed.value);
      else this.engine.setValue(this.sheetId, row, col, parsed.value);

      if (parsed.percent) this.applyStyleTo(row, col, 'percent');
    });
    if (parsed.refused) this.onChange({ refused: parsed.refused, written: true });

    return parsed;
  }

  /** Empties every cell in the selection. */
  clearSelection() {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) this.engine.clearContent(this.sheetId, row, col);
      }
    });
  }

  // Comments

  noteAt(row, col) {
    const note = this.sheet.cell(row, col)?.n;
    return typeof note === 'string' && note !== '' ? note : null;
  }

  /** Gives the active cell a comment; empty text takes it away. */
  setNote(text, { row = this.active.row, col = this.active.col } = {}) {
    const clean = String(text ?? '').slice(0, 100_000);
    this.record(() => {
      this.sheet.set(row, col, { n: clean.trim() === '' ? null : clean });
      this.model.dirty = true;
    });
  }

  /** Takes the comments off every selected cell. */
  deleteNotes() {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (const [at, cell] of [...this.sheet.cells]) {
        const [row, col] = at.split(',').map(Number);
        if (cell.n && row >= top && row <= bottom && col >= left && col <= right) this.sheet.set(row, col, { n: null });
      }
      this.model.dirty = true;
    });
  }

  linkAt(row, col) {
    const link = this.sheet.cell(row, col)?.l;
    return typeof link === 'string' && link !== '' ? link : null;
  }

  /** Gives the active cell a link and, when given, the text it shows; an empty address takes the link away. */
  setLink(href, text = null, { row = this.active.row, col = this.active.col } = {}) {
    this.record(() => {
      const shown = text ?? this.sheet.valueAt(row, col);
      if (text !== null && text !== '' && !this.sheet.formulaAt(row, col)) this.engine.setValue(this.sheetId, row, col, text);
      else if ((shown === null || shown === '') && href) this.engine.setValue(this.sheetId, row, col, href);
      this.sheet.set(row, col, { l: href ? String(href).trim() : null });
      this.model.dirty = true;
    });
  }

  /** Marks the selected cells to be covered in a redacted copy, or uncovers them when all are. */
  toggleRedact() {
    const { top, bottom, left, right } = this.selection;
    let all = true;
    for (let row = top; row <= bottom && all; row += 1) for (let col = left; col <= right; col += 1) if (!this.sheet.cell(row, col)?.rd) { all = false; break; }
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) for (let col = left; col <= right; col += 1) this.sheet.set(row, col, { rd: !all });
      this.model.dirty = true;
    });
  }

  /** Shows the active cell's comment all the time, or only when the pointer is on the cell. */
  setNoteShown(shown) {
    const { row, col } = this.active;
    if (!this.noteAt(row, col)) return;
    this.record(() => {
      this.sheet.set(row, col, { ns: shown });
      this.model.dirty = true;
    });
  }

  applyStyleTo(row, col, style) {
    this.sheet.set(row, col, { s: style });
    this.model.dirty = true;
  }

  /** Applies a named style to everything selected. */
  applyStyle(style) {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) {
          this.sheet.set(row, col, { s: style === 'normal' ? null : style });
        }
      }
      this.model.dirty = true;
    });
  }

  // Formatting

  /**
   * Changes how the selected cells look; each keeps its named style underneath.
   * @param {Object|Function} change fields to set, or (look, row, col) => the new look
   */
  formatCells(change, area = this.selection) {
    this.record(() => {
      for (let row = area.top; row <= area.bottom; row += 1) {
        for (let col = area.left; col <= area.right; col += 1) {
          const id = this.sheet.cell(row, col)?.s ?? null;
          const before = id ? this.model.styles[id] ?? {} : {};
          const look = typeof change === 'function' ? change(before, row, col) : { ...before, ...change };
          this.sheet.set(row, col, { s: this.styleFor(look, id) });
        }
      }
      this.model.dirty = true;
    });
  }

  /** The style that gives a look, made the first time; it remembers the named style it was built on. */
  styleFor(look, fromId = null) {
    const from = fromId ? this.model.styles[fromId] : null;
    const parent = from?.name ? fromId : from?.parent ?? null;
    const clean = cleanLook(look);
    if (parent && sameLook(clean, this.model.styles[parent])) return parent;
    if (!parent && Object.keys(clean).length === 0) return null;
    const wanted = parent ? { ...clean, parent } : clean;
    const json = JSON.stringify(wanted);
    for (const [id, style] of Object.entries(this.model.styles)) if (!style.name && JSON.stringify(style) === json) return id;
    let n = Object.keys(this.model.styles).length + 1;
    while (this.model.styles[`look-${n}`]) n += 1;
    this.model.styles[`look-${n}`] = wanted;
    return `look-${n}`;
  }

  /**
   * Sums the numbers above the active cell, or to its left when there are none above, as LibreOffice's AutoSum does;
   * with a range of numbers selected, the sum goes in the cell below it.
   */
  autoSum() {
    const { top, bottom, left, right } = this.selection;
    const numeric = (row, col) => typeof this.engine.valueAt(this.sheetId, row, col) === 'number';
    let at = { row: this.active.row, col: this.active.col };
    if (bottom > top && left === right) at = { row: bottom + 1, col: left };
    let first = at.row - 1;
    while (first >= 0 && numeric(first, at.col)) first -= 1;
    let formula = null;
    if (first < at.row - 1) formula = `=SUM(${a1(first + 1, at.col)}:${a1(at.row - 1, at.col)})`;
    else {
      let start = at.col - 1;
      while (start >= 0 && numeric(at.row, start)) start -= 1;
      if (start < at.col - 1) formula = `=SUM(${a1(at.row, start + 1)}:${a1(at.row, at.col - 1)})`;
    }
    if (!formula) return false;
    this.setCell(at.row, at.col, formula);
    this.select(at.row, at.col);
    return true;
  }

  /** A number format over the selection, such as currency or percent. */
  setNumberFormat(format) {
    this.formatCells((look) => ({ ...look, format }));
  }

  /** Turns bold, italic, underline or strike on over the selection, or off when every cell has it. */
  toggleLook(field) {
    const { top, bottom, left, right } = this.selection;
    let all = true;
    for (let row = top; row <= bottom && all; row += 1) {
      for (let col = left; col <= right && all; col += 1) all = Boolean(this.styleAt(row, col)[field]);
    }
    // Single and double underline are one choice, as in Calc.
    const other = { underline: 'double', double: 'underline' }[field];
    this.formatCells((look) => ({ ...look, [field]: !all, ...(other && !all ? { [other]: false } : {}) }));
  }

  /**
   * Goal Seek: the value of the variable cell that makes the formula cell give the target.
   * The cells are left as they were; keepValue() writes the answer.
   */
  goalSeek({ formula, variable, target }) {
    if (!this.sheet.formulaAt(formula.row, formula.col)) return { error: 'The formula cell holds no formula' };
    if (this.sheet.formulaAt(variable.row, variable.col)) return { error: 'The variable cell must hold a value, not a formula' };
    const before = this.sheet.valueAt(variable.row, variable.col);
    const start = typeof before === 'number' ? before : 0;
    const dirty = this.model.dirty;
    const read = (x) => {
      this.engine.setValues(this.sheetId, [{ ...variable, value: x }]);
      return this.sheet.valueAt(formula.row, formula.col);
    };
    try {
      return seekGoal(read, start, target);
    } finally {
      this.putBack([{ ...variable, value: before }], dirty);
    }
  }

  /**
   * Solver: tries values in the variable cells, then puts back what was there.
   * @param {{objective: {row: number, col: number}, goal: string, target?: number, variables: {row: number, col: number}[],
   *   constraints: {cell: {row: number, col: number}, op: string, rhs: number}[], nonNegative?: boolean, integer?: boolean,
   *   engine?: string, seconds?: number}} spec
   */
  solve(spec) {
    const { objective, variables, constraints } = spec;
    if (variables.length === 0) return { error: 'Name the cells Solver may change' };
    if (variables.length > 200) return { error: 'Solver changes at most 200 cells' };
    if (constraints.length > 500) return { error: 'Solver takes at most 500 limiting conditions' };
    if (variables.some((v) => this.sheet.formulaAt(v.row, v.col))) return { error: 'The cells Solver changes must hold values, not formulas' };
    const index = (cell) => variables.findIndex((v) => v.row === cell.row && v.col === cell.col);
    const integers = new Set(spec.integer ? variables.map((_, j) => j) : []);
    const binaries = new Set();
    const limits = [];
    const sides = [];
    for (const k of constraints) {
      if (k.op === 'int' || k.op === 'bin') {
        const j = index(k.cell);
        if (j < 0) return { error: 'Integer and binary conditions go on the cells Solver changes' };
        (k.op === 'int' ? integers : binaries).add(j);
        continue;
      }
      if (!Number.isFinite(k.rhs)) return { error: 'Each condition needs a number to compare with' };
      limits.push({ index: sides.length, op: k.op, rhs: k.rhs });
      sides.push(k.cell);
    }
    const before = variables.map((v) => ({ ...v, value: this.sheet.valueAt(v.row, v.col) }));
    const dirty = this.model.dirty;
    const number = (row, col) => {
      const value = this.sheet.valueAt(row, col);
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const evaluate = (x) => {
      this.engine.setValues(this.sheetId, variables.map((v, j) => ({ ...v, value: x[j] })));
      return { objective: number(objective.row, objective.col), lhs: sides.map((c) => number(c.row, c.col)) };
    };
    try {
      const result = solveModel({
        start: before.map((b) => (typeof b.value === 'number' ? b.value : 0)),
        evaluate, constraints: limits, goal: spec.goal, target: spec.target,
        integers, binaries, nonNegative: !!spec.nonNegative, engine: spec.engine ?? 'auto', seconds: spec.seconds ?? 10,
      });
      return { ...result, variables };
    } finally {
      this.putBack(before, dirty);
    }
  }

  /** Writes the values a search found, as one step to undo. */
  keepValues(cells) {
    this.record(() => this.engine.setValues(this.sheetId, cells));
  }

  /** Puts trial cells back as they were, without a step to undo. */
  putBack(cells, dirty) {
    this.engine.setValues(this.sheetId, cells);
    this.model.dirty = dirty;
    this.looks = null;
  }

  /** Changes the case of the text in the selected cells; numbers and formulas stay as they are. */
  changeTextCase(change) {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) {
          const cell = this.sheet.cell(row, col);
          if (!cell || cell.f || typeof cell.v !== 'string' || /^#[A-Z/0!?]+[!?A]?$/.test(cell.v)) continue;
          const next = change(cell.v);
          if (next !== cell.v) this.engine.setValue(this.sheetId, row, col, next);
        }
      }
    });
  }

  /** The look of a cell, from its style. */
  styleAt(row, col) {
    const id = this.sheet.cell(row, col)?.s;
    return id ? this.model.styles[id] ?? {} : {};
  }

  /**
   * Draws borders over the selection: around it, inside it, everywhere, on one side, or none.
   * @param {'outline'|'inner'|'all'|'none'|'top'|'bottom'|'left'|'right'} where
   */
  setBorders(where, border = { style: 'solid', width: 1, color: '#000000' }) {
    const area = this.selection;
    this.formatCells((look, row, col) => {
      const borders = { ...(look.borders ?? {}) };
      const edge = { top: row === area.top, bottom: row === area.bottom, left: col === area.left, right: col === area.right };
      for (const side of SIDES) {
        const on = where === 'all' || where === side && edge[side] || where === 'outline' && edge[side] || where === 'inner' && !edge[side];
        if (where === 'none') delete borders[side];
        else if (on) borders[side] = { ...border };
      }
      return { ...look, borders };
    }, area);
  }

  /** Takes off what was set by hand, leaving each cell's named style. */
  clearDirectFormatting() {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) {
          const id = this.sheet.cell(row, col)?.s;
          if (!id) continue;
          const style = this.model.styles[id];
          this.sheet.set(row, col, { s: style?.name ? id : style?.parent ?? null });
        }
      }
      this.model.dirty = true;
    });
  }

  /** The named style under a cell's look. */
  namedStyleAt(row, col) {
    const id = this.sheet.cell(row, col)?.s;
    const style = id ? this.model.styles[id] : null;
    return style?.name ? id : style?.parent ?? 'normal';
  }

  /** A named style from the active cell's look, applied to the selection. */
  newStyle(name) {
    const id = `named-${name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
    const look = cleanLook(this.styleAt(this.active.row, this.active.col));
    this.record(() => {
      this.model.styles[id] = { ...look, name };
    });
    this.applyStyle(id);
    return id;
  }

  /** Gives a named style the active cell's look; every cell using it changes. */
  updateStyle(id) {
    const style = this.model.styles[id];
    if (!style?.name) return;
    const look = cleanLook(this.styleAt(this.active.row, this.active.col));
    this.record(() => {
      this.model.styles[id] = { ...look, name: style.name };
      this.model.dirty = true;
    });
  }

  /** The named styles, for the list to choose from. */
  get namedStyles() {
    return Object.entries(this.model.styles).filter(([, style]) => style.name).map(([id, style]) => ({ id, name: style.name }));
  }

  // Pivot tables

  /** The pivot table whose results cover a cell of the sheet in view. */
  pivotAt(row, col) {
    return this.sheet.pivots.find((p) => p.area && row >= p.area.top && row <= p.area.bottom && col >= p.area.left && col <= p.area.right) ?? null;
  }

  /** The cells a pivot table would fill, worked out from its source now. */
  pivotResult(pivot, sheetId = this.sheetId) {
    const source = readSource(pivot.source, this.engine, sheetId);
    return source.error ? { error: source.error } : computePivot(pivot, source);
  }

  /** Whether writing a pivot table's results at a corner would cover cells that hold something else. */
  pivotCovers(result, corner, sheet = this.sheet, own = null) {
    for (let r = 0; r < result.cells.length; r += 1) {
      for (let c = 0; c < result.cells[r].length; c += 1) {
        const row = corner.row + r;
        const col = corner.col + c;
        const inOwn = own && row >= own.top && row <= own.bottom && col >= own.left && col <= own.right;
        if (!inOwn && sheet.cell(row, col)?.v !== undefined) return true;
      }
    }
    return false;
  }

  /** The named styles pivot tables use, made the first time, as LibreOffice names them. */
  pivotStyles() {
    this.model.styles['pivot-category'] ??= { name: 'Pivot Table Category', bold: true };
    this.model.styles['pivot-result'] ??= { name: 'Pivot Table Result', bold: true, bg: '#e8eef7' };
  }

  /** Writes a pivot table's results into its sheet, emptying what it showed before. */
  writePivot(sheet, pivot, result) {
    if (pivot.area) {
      for (let row = pivot.area.top; row <= pivot.area.bottom; row += 1) {
        for (let col = pivot.area.left; col <= pivot.area.right; col += 1) this.engine.clear(sheet.id, row, col);
      }
    }
    this.pivotStyles();
    const corner = pivot.area ? { row: pivot.area.top, col: pivot.area.left } : pivot.corner;
    result.cells.forEach((line, r) => {
      const kind = r >= result.bodyTop ? result.kinds[r - result.bodyTop] : 'header';
      line.forEach((value, c) => {
        const row = corner.row + r;
        const col = corner.col + c;
        if (value !== null) this.engine.setValue(sheet.id, row, col, value);
        const style = kind === 'total' || kind === 'subtotal' ? 'pivot-result' : kind === 'header' && r >= result.headerTop ? 'pivot-category' : null;
        if (style && (value !== null || kind !== 'header')) sheet.set(row, col, { s: style });
      });
    });
    const width = Math.max(1, ...result.cells.map((l) => l.length));
    pivot.area = { top: corner.row, left: corner.col, bottom: corner.row + result.cells.length - 1, right: corner.col + width - 1 };
    delete pivot.corner;
  }

  /**
   * Makes a pivot table: on a new sheet, or at a cell of a sheet.
   * @param {{source: string}} pivot
   * @param {{sheetId?: string, row?: number, col?: number}} where nothing means a new sheet
   */
  createPivot(pivot, where = {}) {
    const result = this.pivotResult(pivot);
    if (result.error) return { error: result.error };
    let made = null;
    this.record(() => {
      let sheet = where.sheetId ? this.model.sheetById(where.sheetId) : null;
      if (!sheet) {
        let n = 1;
        while (this.model.sheetNamed(`Pivot Table_${this.sheet.name}_${n}`)) n += 1;
        sheet = this.model.addSheet(`Pivot Table_${this.sheet.name}_${n}`);
      }
      made = { id: `pivot-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, ...structuredClone(pivot), corner: { row: where.row ?? 0, col: where.col ?? 0 } };
      this.writePivot(sheet, made, result);
      sheet.pivots.push(made);
      this.model.activeSheetId = sheet.id;
      this.active = { row: made.area.top, col: made.area.left };
      this.anchor = { ...this.active };
      this.engine.rebuild();
      this.engine.recalculateAll();
      this.model.dirty = true;
    });
    this.onChange({ sheet: true });
    return { id: made.id };
  }

  /** Works a pivot table out again from its source, with changes to its fields when given. */
  updatePivot(id, changes = {}) {
    const sheet = this.model.sheets.find((s) => s.pivots.some((p) => p.id === id));
    const pivot = sheet?.pivots.find((p) => p.id === id);
    if (!pivot) return { error: 'No such pivot table' };
    const next = { ...pivot, ...structuredClone(changes) };
    const result = this.pivotResult(next, sheet.id);
    if (result.error) return { error: result.error };
    this.record(() => {
      Object.assign(pivot, next);
      this.writePivot(sheet, pivot, result);
      this.engine.rebuild();
      this.engine.recalculateAll();
      this.model.dirty = true;
    });
    return { id };
  }

  /** Every pivot table of the document worked out again. */
  refreshPivots() {
    for (const sheet of this.model.sheets) for (const pivot of [...sheet.pivots]) this.updatePivot(pivot.id);
  }

  deletePivot(id) {
    const sheet = this.model.sheets.find((s) => s.pivots.some((p) => p.id === id));
    const pivot = sheet?.pivots.find((p) => p.id === id);
    if (!pivot) return;
    this.record(() => {
      for (let row = pivot.area.top; row <= pivot.area.bottom; row += 1) {
        for (let col = pivot.area.left; col <= pivot.area.right; col += 1) this.engine.clear(sheet.id, row, col);
      }
      sheet.pivots = sheet.pivots.filter((p) => p.id !== id);
      this.model.dirty = true;
    });
  }

  // Charts

  /** Puts a chart on the sheet in view, beside the data it draws unless placed. */
  insertChart(chart) {
    const area = this.dataArea();
    const id = `chart-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const placed = {
      width: 480, height: 300, anchor: { row: area.top, col: area.right + 2, dx: 0, dy: 0 }, ...structuredClone(chart), id, sheet: this.sheetId,
    };
    this.record(() => {
      this.model.charts.push(placed);
      this.model.dirty = true;
    });
    this.chosenChart = id;
    return id;
  }

  updateChart(id, changes) {
    const chart = this.model.charts.find((c) => c.id === id);
    if (!chart) return;
    this.record(() => {
      Object.assign(chart, structuredClone(changes));
      this.model.dirty = true;
    });
  }

  deleteChart(id) {
    this.record(() => {
      this.model.charts = this.model.charts.filter((c) => c.id !== id);
      this.model.dirty = true;
    });
    if (this.chosenChart === id) this.chosenChart = null;
  }

  /** Chooses a chart for moving, resizing or deleting; null goes back to the cells. */
  chooseChart(id) {
    this.chosenChart = id;
    this.onChange({});
  }

  // Copying

  /** The selection, as text and as something that can be pasted back. */
  copy() {
    const { top, bottom, left, right } = this.selection;
    const cells = [];
    const text = [];

    for (let row = top; row <= bottom; row += 1) {
      const line = [];
      const textLine = [];
      for (let col = left; col <= right; col += 1) {
        const cell = this.sheet.cell(row, col);
        line.push(cell ? { ...cell } : null);
        textLine.push(cell?.v ?? '');
      }
      cells.push(line);
      text.push(textLine);
    }

    return {
      origin: { row: top, col: left },
      cells,
      text: toCsv(text, { separator: '\t' }),
    };
  }

  /** Pastes at the active cell. */
  paste(payload) {
    if (!payload) return false;
    const { row: toRow, col: toCol } = this.active;

    this.record(() => {
      if (payload.cells) {
        const rowDelta = toRow - payload.origin.row;
        const colDelta = toCol - payload.origin.col;

        payload.cells.forEach((line, r) => {
          line.forEach((cell, c) => {
            const row = toRow + r;
            const col = toCol + c;
            if (!cell) { this.engine.clear(this.sheetId, row, col); return; }

            if (cell.f) {
              const moved = this.engine.translateFormula(cell.f, rowDelta, colDelta);
              this.engine.setFormula(this.sheetId, row, col, moved, !!cell.i);
            } else {
              this.engine.setValue(this.sheetId, row, col, cell.v ?? null);
            }
            if (cell.s) this.sheet.set(row, col, { s: cell.s });
          });
        });
        return;
      }

      const rows = parseCsv(payload.text ?? '', { separator: '\t' });
      rows.forEach((line, r) => {
        line.forEach((field, c) => {
          this.setCellQuietly(toRow + r, toCol + c, field);
        });
      });
    });

    return true;
  }

  /**
   * Pastes part of what was copied: some kinds of content, turned on its side, or combined with what is there.
   * @param {{origin: {row: number, col: number}, cells: Array}} payload copied inside Grid
   * @param {{text?: boolean, numbers?: boolean, formulas?: boolean, formats?: boolean, transpose?: boolean,
   *   skipEmpty?: boolean, operation?: 'add'|'subtract'|'multiply'|'divide'|null}} options
   */
  pasteSpecial(payload, { text = true, numbers = true, formulas = true, formats = true, transpose = false, skipEmpty = false, operation = null } = {}) {
    if (!payload?.cells) return false;
    const { row: toRow, col: toCol } = this.active;
    const combine = {
      add: (a, b) => a + b, subtract: (a, b) => a - b, multiply: (a, b) => a * b, divide: (a, b) => (b === 0 ? ERROR.div0 : a / b),
    }[operation] ?? null;
    this.record(() => {
      payload.cells.forEach((line, r) => {
        line.forEach((cell, c) => {
          const row = toRow + (transpose ? c : r);
          const col = toCol + (transpose ? r : c);
          if (!cell) {
            if (!skipEmpty && text && numbers && formulas && !combine) this.engine.clear(this.sheetId, row, col);
            return;
          }
          const kind = cell.f ? 'formulas' : typeof cell.v === 'number' ? 'numbers' : 'text';
          const wanted = { text, numbers, formulas }[kind];
          if (wanted) {
            if (cell.f) {
              const from = { row: payload.origin.row + r, col: payload.origin.col + c };
              this.engine.setFormula(this.sheetId, row, col, transpose
                ? this.engine.transposeFormula(cell.f, from, { row, col })
                : this.engine.translateFormula(cell.f, row - from.row, col - from.col), !!cell.i);
            } else if (combine && typeof cell.v === 'number') {
              const here = this.sheet.valueAt(row, col);
              const base = typeof here === 'number' ? here : here === null || here === undefined || here === '' ? 0 : null;
              if (base !== null && !this.sheet.cell(row, col)?.f) this.engine.setValue(this.sheetId, row, col, combine(base, cell.v));
            } else {
              this.engine.setValue(this.sheetId, row, col, cell.v ?? null);
            }
          }
          if (formats && cell.s) this.sheet.set(row, col, { s: cell.s });
        });
      });
    });
    return true;
  }

  /**
   * Fills the selection with random numbers.
   * @param {{kind: 'uniform'|'integer'|'normal', a: number, b: number, decimals?: number|null}} options
   *   a and b are the bounds, or the mean and standard deviation of a normal distribution
   */
  fillRandom({ kind = 'uniform', a = 0, b = 1, decimals = null }, random = Math.random) {
    if (![a, b].every(Number.isFinite)) return false;
    const [low, high] = a <= b ? [a, b] : [b, a];
    const draw = {
      uniform: () => low + random() * (high - low),
      integer: () => Math.ceil(low) + Math.floor(random() * (Math.floor(high) - Math.ceil(low) + 1)),
      // Box and Muller's method.
      normal: () => a + b * Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()),
    }[kind];
    if (!draw) return false;
    const places = Number.isInteger(decimals) && decimals >= 0 ? Math.min(decimals, 15) : null;
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) {
          const value = draw();
          this.engine.setValue(this.sheetId, row, col, places === null ? value : Number(value.toFixed(places)));
        }
      }
    });
    return true;
  }

  /** Like setCell, but without its own undo entry. */
  setCellQuietly(row, col, text) {
    const parsed = parseInput(text);
    if (parsed.kind === 'blank') this.engine.clearContent(this.sheetId, row, col);
    else if (parsed.kind === 'formula') this.engine.setFormula(this.sheetId, row, col, parsed.value);
    else this.engine.setValue(this.sheetId, row, col, parsed.value);
  }

  /** Fills the selection from its first row or column. */
  /**
   * Copies the first row or column of the selection over the rest, toward the side named, formulas moved with it.
   * @param {'down'|'up'|'right'|'left'} direction
   */
  fill(direction) {
    if (direction === 'down') return this.fillDown();
    const { top, bottom, left, right } = this.selection;
    const across = direction === 'right' || direction === 'left';
    if (across ? right <= left : bottom <= top) return false;
    this.record(() => {
      const lines = across ? [top, bottom] : [left, right];
      for (let line = lines[0]; line <= lines[1]; line += 1) {
        const from = { right: [line, left], left: [line, right], up: [bottom, line] }[direction];
        const source = this.sheet.cell(from[0], from[1]);
        const cells = across
          ? Array.from({ length: right - left }, (_, i) => [line, direction === 'right' ? left + 1 + i : left + i])
          : Array.from({ length: bottom - top }, (_, i) => [top + i, line]);
        for (const [row, col] of cells) {
          if (!source) this.engine.clear(this.sheetId, row, col);
          else if (source.f) this.engine.setFormula(this.sheetId, row, col, this.engine.translateFormula(source.f, row - from[0], col - from[1]), !!source.i);
          else this.engine.setValue(this.sheetId, row, col, source.v ?? null);
        }
      }
    });
    return true;
  }

  /** Every cell of the rows, or of the columns, the selection touches. */
  selectWhole(axis) {
    const { top, bottom, left, right } = this.selection;
    // As far as selecting a whole row or column reaches elsewhere.
    if (axis === 'row') this.selectRange(top, 0, bottom, 999);
    else this.selectRange(0, left, 999, right);
  }

  /** The block of data around the active cell, selected. */
  selectDataArea() {
    const area = this.dataArea();
    this.selectRange(area.top, area.left, area.bottom, area.right);
  }

  /** Row heights or column widths over the selection, in pixels; a measure function gives each its best fit. */
  setSize(axis, size, measure = null) {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      const [from, to] = axis === 'row' ? [top, bottom] : [left, right];
      for (let i = from; i <= to; i += 1) {
        const value = measure ? measure(i) : size;
        if (axis === 'row') this.sheet.setRowHeight(i, value);
        else this.sheet.setColumnWidth(i, value);
      }
      this.model.dirty = true;
    });
    this.onChange({ layout: true });
  }

  /** Every formula worked out again from the start, whatever the engine thinks has changed. */
  recalculateHard() {
    this.engine.recalculateAll();
    this.onChange({ edited: true });
  }

  fillDown() {
    const { top, bottom, left, right } = this.selection;
    if (bottom <= top) return false;

    this.record(() => {
      for (let col = left; col <= right; col += 1) {
        const source = this.sheet.cell(top, col);
        const second = this.sheet.cell(top + 1, col);
        const step = seriesStep(source, second);

        for (let row = top + 1; row <= bottom; row += 1) {
          if (!source) { this.engine.clear(this.sheetId, row, col); continue; }
          if (source.f) {
            const moved = this.engine.translateFormula(source.f, row - top, 0);
            this.engine.setFormula(this.sheetId, row, col, moved, !!source.i);
          } else if (step !== null) {
            this.engine.setValue(this.sheetId, row, col, source.v + step * (row - top));
          } else {
            this.engine.setValue(this.sheetId, row, col, source.v ?? null);
          }
        }
      }
    });

    return true;
  }

  // Data

  /** The block a data command works on: the selection, or the data around the cell when one is selected. */
  dataArea() {
    if (!this.selectionIsSingle) return this.selection;
    return currentRegion(this.sheet, this.active.row, this.active.col);
  }

  /** Whether a block's first row names its columns. */
  hasHeader(area) {
    return looksLikeHeader(this.sheet, area);
  }

  /**
   * Sorts a block by one or more of its columns, or of its rows.
   * @param {{area?: Object, keys: {index: number, order: 1|-1}[], header?: boolean, byColumns?: boolean, caseSensitive?: boolean}} plan
   */
  sort(plan) {
    const area = plan.area ?? this.dataArea();
    const header = plan.header ?? this.hasHeader(area);
    const moves = sortPermutation(this.sheet, area, { ...plan, header });
    this.record(() => {
      const byColumns = Boolean(plan.byColumns);
      const taken = new Map();
      for (const { from } of moves) {
        const line = [];
        const span = byColumns ? [area.top, area.bottom] : [area.left, area.right];
        for (let i = span[0]; i <= span[1]; i += 1) {
          const [row, col] = byColumns ? [i, from] : [from, i];
          line.push(this.sheet.cell(row, col));
          this.sheet.cells.delete(key(row, col));
        }
        taken.set(from, line);
      }
      for (const { from, to } of moves) {
        const line = taken.get(from);
        line.forEach((cell, offset) => {
          if (!cell) return;
          const [row, col] = byColumns ? [(byColumns ? area.top : 0) + offset, to] : [to, area.left + offset];
          const moved = { ...cell };
          // A formula moves with its row the way a copy would, as LibreOffice and Excel sort them.
          if (moved.f) moved.f = this.engine.translateFormula(moved.f, byColumns ? 0 : to - from, byColumns ? to - from : 0);
          this.sheet.cells.set(key(row, col), moved);
        });
      }
      this.engine.rebuild();
      this.engine.recalculateAll();
      this.refilter();
      this.model.dirty = true;
    });
    return moves.length;
  }

  /** Turns the autofilter on over a block, or off. */
  setFilter(area) {
    this.record(() => {
      this.sheet.filter = area ? { area: { ...area }, columns: {} } : null;
      this.refilter();
      this.model.dirty = true;
    });
  }

  /** What one column of the filter lets through; null shows every row again. */
  setFilterColumn(col, rule) {
    const filter = this.sheet.filter;
    if (!filter) return;
    this.record(() => {
      const offset = String(col - filter.area.left);
      if (rule) filter.columns[offset] = rule; else delete filter.columns[offset];
      this.refilter();
      this.model.dirty = true;
    });
  }

  /** Works out again which rows the filter hides. */
  refilter() {
    for (const sheet of this.model.sheets) sheet.filtered = filteredRows(sheet, sheet.filter);
    this.onChange({ edited: false, layout: true });
  }

  /** Empties the rows of a block that repeat an earlier one, and closes the gaps. */
  removeDuplicates({ area = this.dataArea(), header = this.hasHeader(area), columns = null } = {}) {
    const repeated = new Set(duplicateRows(this.sheet, area, { header, columns }));
    if (repeated.size === 0) return 0;
    this.record(() => {
      let to = area.top + (header ? 1 : 0);
      for (let row = to; row <= area.bottom; row += 1) {
        if (repeated.has(row)) continue;
        for (let col = area.left; col <= area.right; col += 1) {
          const cell = this.sheet.cell(row, col);
          this.sheet.cells.delete(key(row, col));
          if (cell) this.sheet.cells.set(key(to, col), cell.f ? { ...cell, f: this.engine.translateFormula(cell.f, to - row, 0) } : cell);
        }
        to += 1;
      }
      for (let row = to; row <= area.bottom; row += 1) {
        for (let col = area.left; col <= area.right; col += 1) this.sheet.cells.delete(key(row, col));
      }
      this.engine.rebuild();
      this.engine.recalculateAll();
      this.model.dirty = true;
    });
    return repeated.size;
  }

  /** Splits the text of a column into the columns to its right. */
  textToColumns(options = {}) {
    const { top, bottom, left } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        const value = this.sheet.valueAt(row, left);
        if (typeof value !== 'string') continue;
        splitText(value, options).forEach((part, offset) => this.setCellQuietly(row, left + offset, part));
      }
    });
  }

  /** Fills the selection with a series, from its first cell along the rows or the columns. */
  fillSeries({ direction = 'down', type = 'linear', step = 1, unit = 'day', stop = null, start = null } = {}) {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      const down = direction === 'down';
      const outer = down ? [left, right] : [top, bottom];
      const length = down ? bottom - top + 1 : right - left + 1;
      for (let o = outer[0]; o <= outer[1]; o += 1) {
        const first = down ? this.sheet.valueAt(top, o) : this.sheet.valueAt(o, left);
        const from = start ?? (typeof first === 'number' ? first : 1);
        seriesValues(from, length, { type, step, unit, stop }).forEach((value, i) => {
          const [row, col] = down ? [top + i, o] : [o, left + i];
          this.engine.setValue(this.sheetId, row, col, value);
        });
      }
    });
  }

  /** Replaces the formulas in the selection with what they show. */
  formulasToValues() {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) {
          if (this.sheet.formulaAt(row, col)) this.engine.setValue(this.sheetId, row, col, this.sheet.valueAt(row, col));
        }
      }
    });
  }

  /** Adds a subtotal row after every group of a sorted block, and a grand total at the end. */
  subtotals({ area = this.dataArea(), groupCol, columns, fn = 9 }) {
    const breaks = groupBreaks(this.sheet, area, groupCol);
    this.record(() => {
      let start = area.top + 1;
      let inserted = 0;
      for (const at of breaks) {
        const row = at + inserted;
        this.engine.applyStructuralChange(this.sheetId, { axis: 'row', at: row, count: 1 });
        const label = this.sheet.valueAt(row - 1, groupCol);
        this.engine.setValue(this.sheetId, row, groupCol, `${label ?? ''} Total`.trim());
        for (const col of columns) {
          const name = a1(start + inserted, col).replace(/\d+$/, '');
          this.engine.setFormula(this.sheetId, row, col, `=SUBTOTAL(${fn},${name}${start + inserted + 1}:${name}${row})`);
        }
        inserted += 1;
        start = at;
      }
      const last = area.bottom + inserted + 1;
      this.engine.applyStructuralChange(this.sheetId, { axis: 'row', at: last, count: 1 });
      this.engine.setValue(this.sheetId, last, groupCol, 'Grand Total');
      for (const col of columns) {
        const name = a1(0, col).replace(/\d+$/, '');
        this.engine.setFormula(this.sheetId, last, col, `=SUBTOTAL(${fn},${name}${area.top + 2}:${name}${last})`);
      }
    });
  }

  // Finding

  /** Whether a cell matches what is looked for: its value, or its formula when asked. */
  matches(row, col, pattern, { inFormulas = false } = {}) {
    const formula = inFormulas ? this.sheet.formulaAt(row, col) : null;
    const value = formula ?? this.sheet.valueAt(row, col);
    if (value === null || value === undefined || value === '') return false;
    pattern.lastIndex = 0;
    return pattern.test(String(value));
  }

  /** The next cell after the active one that matches, wrapping round the sheet; null when none does. */
  findNext(query, options = {}) {
    const pattern = searchPattern(query, options);
    if (!pattern) return null;
    const places = [...this.sheet.cells.keys(), ...this.sheet.spills.keys()]
      .map((k) => k.split(',').map(Number))
      .sort((a, b) => (options.byColumns ? a[1] - b[1] || a[0] - b[0] : a[0] - b[0] || a[1] - b[1]));
    const after = (p) => (options.byColumns
      ? p[1] > this.active.col || (p[1] === this.active.col && p[0] > this.active.row)
      : p[0] > this.active.row || (p[0] === this.active.row && p[1] > this.active.col));
    const ordered = options.backwards ? places.reverse() : places;
    const start = options.backwards ? ordered.findIndex((p) => !after(p) && !(p[0] === this.active.row && p[1] === this.active.col))
      : ordered.findIndex(after);
    for (let i = 0; i < ordered.length; i += 1) {
      const p = ordered[((start === -1 ? 0 : start) + i) % ordered.length];
      if (this.matches(p[0], p[1], pattern, options)) {
        this.select(p[0], p[1]);
        return { row: p[0], col: p[1] };
      }
    }
    return null;
  }

  /** Replaces in every matching cell of the sheet, or of the selection; returns how many changed. */
  replaceAll(query, replacement, options = {}) {
    const pattern = searchPattern(query, { ...options, global: true });
    if (!pattern) return 0;
    const area = options.selectionOnly ? this.selection : null;
    let count = 0;
    this.record(() => {
      for (const [at, cell] of [...this.sheet.cells]) {
        const [row, col] = at.split(',').map(Number);
        if (area && (row < area.top || row > area.bottom || col < area.left || col > area.right)) continue;
        if (cell.f) {
          if (!options.inFormulas) continue;
          pattern.lastIndex = 0;
          if (!pattern.test(cell.f)) continue;
          const text = options.wholeCell ? replacement : cell.f.replace(pattern, replacement);
          this.engine.setFormula(this.sheetId, row, col, text);
          count += 1;
        } else if (cell.v !== undefined && cell.v !== null) {
          const shown = String(cell.v);
          pattern.lastIndex = 0;
          if (!pattern.test(shown)) continue;
          this.setCellQuietly(row, col, options.wholeCell ? replacement : shown.replace(pattern, replacement));
          count += 1;
        }
      }
    });
    return count;
  }

  /** Defines names from the labels in the selection's first row or first column. */
  namesFromLabels({ top = true } = {}) {
    const { top: t, bottom, left, right } = this.selection;
    const sheetName = this.sheet.name;
    const quoted = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
    let made = 0;
    this.record(() => {
      const lines = top ? range(left, right) : range(t, bottom);
      for (const line of lines) {
        const label = top ? this.sheet.valueAt(t, line) : this.sheet.valueAt(line, left);
        const name = String(label ?? '').trim().replace(/[^A-Za-z0-9_.]+/g, '_').replace(/^(\d)/, '_$1');
        if (!name) continue;
        const ref = top
          ? `${columnName(line)}$${t + 2}:$${columnName(line)}$${bottom + 1}`
          : `$${columnName(left + 1)}$${line + 1}:$${columnName(right)}$${line + 1}`;
        this.engine.setName(name, `=${quoted}!${top ? '$' : ''}${ref}`);
        made += 1;
      }
    });
    return made;
  }

  // Merging, hiding, freezing

  /** Shows a block as one cell; the other cells' content goes, as LibreOffice asks first. */
  merge(area = this.selection) {
    if (area.top === area.bottom && area.left === area.right) return false;
    this.record(() => {
      this.sheet.merges = this.sheet.merges.filter((m) => m.bottom < area.top || m.top > area.bottom || m.right < area.left || m.left > area.right);
      for (let row = area.top; row <= area.bottom; row += 1) {
        for (let col = area.left; col <= area.right; col += 1) {
          if (row !== area.top || col !== area.left) this.engine.clear(this.sheetId, row, col);
        }
      }
      this.sheet.merges.push({ ...area });
      this.active = { row: area.top, col: area.left };
      this.anchor = { row: area.bottom, col: area.right };
      this.model.dirty = true;
    });
    return true;
  }

  /** Whether merging the block would lose content beyond its first cell. */
  mergeLoses(area = this.selection) {
    for (let row = area.top; row <= area.bottom; row += 1) {
      for (let col = area.left; col <= area.right; col += 1) {
        if ((row !== area.top || col !== area.left) && this.sheet.cell(row, col)?.v !== undefined) return true;
      }
    }
    return false;
  }

  unmerge(area = this.selection) {
    this.record(() => {
      this.sheet.merges = this.sheet.merges.filter((m) => m.bottom < area.top || m.top > area.bottom || m.right < area.left || m.left > area.right);
      this.model.dirty = true;
    });
  }

  /** Hides or shows the selected rows or columns. */
  setHidden(axis, hidden) {
    const { top, bottom, left, right } = this.selection;
    const [from, to] = axis === 'row' ? [top, bottom] : [left, right];
    this.record(() => {
      for (let i = from; i <= to; i += 1) this.sheet.setHidden(axis, i, hidden);
      this.model.dirty = true;
    });
    this.onChange({ layout: true });
  }

  /** Keeps the rows above and the columns left of the active cell in view; nothing frozen at A1. */
  freeze(rows = this.active.row, cols = this.active.col) {
    this.record(() => {
      this.sheet.frozen = { rows, cols };
      this.model.dirty = true;
    });
  }

  // Cells

  /** Inserts empty cells, pushing the ones below or to the right along. */
  insertCells(shift = 'down') {
    const { top, bottom, left, right } = this.selection;
    const bounds = this.sheet.usedBounds();
    this.record(() => {
      if (shift === 'down') {
        const area = { top, left, bottom: Math.max(bounds?.bottom ?? top, top), right };
        this.engine.moveBlock(this.sheetId, area, bottom - top + 1, 0);
      } else {
        const area = { top, left, bottom, right: Math.max(bounds?.right ?? left, left) };
        this.engine.moveBlock(this.sheetId, area, 0, right - left + 1);
      }
    });
  }

  /** Deletes cells, pulling the ones below or to the right into their place; references to them break. */
  deleteCells(shift = 'up') {
    const area = this.selection;
    const bounds = this.sheet.usedBounds();
    this.record(() => {
      this.engine.breakReferences(this.sheetId, area);
      for (let row = area.top; row <= area.bottom; row += 1) {
        for (let col = area.left; col <= area.right; col += 1) this.sheet.cells.delete(key(row, col));
      }
      if (shift === 'up') {
        const below = { top: area.bottom + 1, left: area.left, bottom: Math.max(bounds?.bottom ?? area.bottom, area.bottom + 1), right: area.right };
        this.engine.moveBlock(this.sheetId, below, -(area.bottom - area.top + 1), 0);
      } else {
        const beside = { top: area.top, left: area.right + 1, bottom: area.bottom, right: Math.max(bounds?.right ?? area.right, area.right + 1) };
        this.engine.moveBlock(this.sheetId, beside, 0, -(area.right - area.left + 1));
      }
    });
  }

  // Rows and columns

  insertRows(at, count = 1) {
    this.record(() => this.engine.applyStructuralChange(this.sheetId, { axis: 'row', at, count }));
  }

  deleteRows(at, count = 1) {
    this.record(() => this.engine.applyStructuralChange(this.sheetId, { axis: 'row', at, count: -count }));
  }

  insertColumns(at, count = 1) {
    this.record(() => this.engine.applyStructuralChange(this.sheetId, { axis: 'col', at, count }));
  }

  deleteColumns(at, count = 1) {
    this.record(() => this.engine.applyStructuralChange(this.sheetId, { axis: 'col', at, count: -count }));
  }

  // Sheets

  addSheet(name = null) {
    this.record(() => {
      const sheet = this.model.addSheet(name);
      this.model.activeSheetId = sheet.id;
      this.engine.rebuild();
    });
  }

  /** Renames a sheet and the formulas, names and charts that name it; false when the name is taken or empty. */
  renameSheet(id, name) {
    const sheet = this.model.sheetById(id);
    const cleaned = String(name ?? '').trim();
    if (!sheet || !cleaned || /[\[\]*?:/\\]/.test(cleaned) || cleaned.length > 100) return false;
    if (this.model.sheets.some((s) => s !== sheet && s.name.toLowerCase() === cleaned.toLowerCase())) return false;
    if (cleaned === sheet.name) return true;
    this.record(() => {
      const old = sheet.name;
      this.model.renameSheet(id, cleaned);
      this.engine.renameSheetReferences(old, cleaned);
      this.engine.rebuild();
    });
    return true;
  }

  /** Deletes a sheet; what pointed at it shows #REF!. */
  deleteSheet(id) {
    const sheet = this.model.sheetById(id);
    if (!sheet || this.model.sheets.length <= 1) return false;
    this.record(() => {
      this.model.removeSheet(id);
      this.engine.renameSheetReferences(sheet.name, null);
      this.engine.rebuild();
    });
    this.onChange({ sheet: true });
    return true;
  }

  /** Hides or shows a sheet. */
  setSheetHidden(id, hidden) {
    const sheet = this.model.sheetById(id);
    if (!sheet || sheet.hidden === hidden) return false;
    if (hidden && this.model.sheets.filter((s) => !s.hidden).length <= 1) return false;
    this.record(() => this.model.setSheetHidden(id, hidden));
    if (hidden) this.onChange({ sheet: true });
    return true;
  }

  /** Moves a sheet to a position, or copies it there under a new name. */
  moveSheet(id, to, { copy = false, name = null } = {}) {
    if (!this.model.sheetById(id)) return false;
    this.record(() => {
      if (copy) {
        const made = this.model.copySheet(id, to, name);
        this.model.activeSheetId = made.id;
        this.engine.rebuild();
      } else this.model.moveSheet(id, to);
    });
    this.onChange({ sheet: true });
    return true;
  }

  /** Sets the colour of a sheet's tab; null takes it away. */
  setTabColour(id, colour) {
    if (!this.model.sheetById(id)) return false;
    this.record(() => this.model.setTabColour(id, colour));
    return true;
  }

  /** Goes to the next or previous shown sheet. */
  stepSheet(direction) {
    const shown = this.model.sheets.filter((s) => !s.hidden);
    const at = shown.findIndex((s) => s.id === this.model.activeSheetId);
    const next = shown[at + direction];
    return next ? this.switchSheet(next.id) : false;
  }

  /** Turns one of the ways of showing the sheet on or off. */
  toggleView(key) {
    if (!(key in this.view)) return;
    this.view[key] = !this.view[key];
    this.onChange({});
  }

  switchSheet(id) {
    this.commitEdit();
    if (!this.model.sheetById(id)) return false;
    this.model.activeSheetId = id;
    this.active = { row: 0, col: 0 };
    this.anchor = { row: 0, col: 0 };
    this.onChange({ sheet: true });
    return true;
  }

  // Printing

  /** Changes how a sheet prints, as one step that can be undone. */
  setPrint(sheetId, changes) {
    const target = this.model.sheetById(sheetId);
    if (!target) return;
    const next = normalisePrint({ ...target.print, ...changes });
    if (JSON.stringify(next) === JSON.stringify(target.print)) return;
    this.record(() => {
      target.print = next;
      this.model.dirty = true;
    });
  }

  /** Starts a new page above the selection's top row, or stops doing so. */
  toggleRowBreak() {
    const row = this.selection.top;
    if (row === 0) return;
    const breaks = new Set(this.sheet.print.rowBreaks);
    if (breaks.has(row)) breaks.delete(row); else breaks.add(row);
    this.setPrint(this.sheetId, { rowBreaks: [...breaks] });
  }

  /** Starts a new page left of the selection's first column, or stops doing so. */
  toggleColumnBreak() {
    const col = this.selection.left;
    if (col === 0) return;
    const breaks = new Set(this.sheet.print.colBreaks);
    if (breaks.has(col)) breaks.delete(col); else breaks.add(col);
    this.setPrint(this.sheetId, { colBreaks: [...breaks] });
  }

  // Undo

  // Conditional formatting and validity

  /** The look conditional formatting gives a cell of the sheet in view. */
  conditionalStyleAt(row, col) {
    if (this.sheet.conditions.length === 0) return null;
    if (!this.looks || this.looks.sheet !== this.sheet) this.looks = new ConditionalLooks(this.sheet, this.engine);
    return this.looks.at(row, col);
  }

  /** Adds a conditional format over a block; it is tried after the ones already there. */
  addCondition(rule) {
    this.record(() => {
      this.sheet.conditions.push(structuredClone(rule));
      this.model.dirty = true;
    });
  }

  /** Removes every conditional format that touches a block. */
  clearConditions(area = this.selection) {
    this.record(() => {
      this.sheet.conditions = this.sheet.conditions.filter((rule) => !overlaps(rule.area, area));
      this.model.dirty = true;
    });
  }

  /** Sets what a block accepts, replacing the rules it had; null removes them. */
  setValidation(rule, area = this.selection) {
    this.record(() => {
      this.sheet.validations = this.sheet.validations.filter((each) => !overlaps(each.area, area));
      if (rule) this.sheet.validations.push({ ...structuredClone(rule), area: { ...area } });
      this.model.dirty = true;
    });
  }

  /** The rule on what a cell accepts, if it has one. */
  validationAt(row, col) {
    return validationAt(this.sheet, row, col);
  }

  /** The choices a cell offers from a list rule, or null. */
  choicesAt(row, col) {
    const rule = validationAt(this.sheet, row, col);
    return rule?.type === 'list' && rule.dropdown !== false ? listOptions(rule, this.sheet, this.engine) : null;
  }

  /** Runs a change as one undo step. */
  record(mutate) {
    this.looks = null;
    this.stamp = (this.stamp ?? 0) + 1;
    const before = this.model.snapshot();
    const selectionBefore = { active: { ...this.active }, anchor: { ...this.anchor } };

    mutate();

    this.undo.past.push({ ...before, selection: selectionBefore });
    if (this.undo.past.length > this.undo.limit) this.undo.past.shift();
    this.undo.future.length = 0;

    this.onChange({ edited: true });
  }

  step(direction) {
    this.looks = null;
    this.stamp = (this.stamp ?? 0) + 1;
    const stack = direction > 0 ? this.undo.future : this.undo.past;
    const entry = stack[stack.length - 1];
    if (!entry) return false;

    const moved = direction > 0 ? this.undo.redo() : this.undo.undo();
    if (!moved) return false;

    if (entry.selection) {
      this.active = { ...entry.selection.active };
      this.anchor = { ...entry.selection.anchor };
    }

    // The engine holds parsed trees keyed by cell, and restoring a snapshot
    // replaces every cell object, so the trees have to be rebuilt.
    this.engine.rebuild();
    this.engine.recalculateAll();

    this.onChange({ edited: true });
    return true;
  }

  // CSV

  /**
   * What a CSV file looks like, so the interface can ask before importing.
   */
  static inspectCsv(text) {
    return sniff(text);
  }

  importCsv(text, { separator = ',', decimal = '.' } = {}) {
    const rows = parseCsv(text, { separator });

    this.record(() => {
      const sheet = this.sheet;
      sheet.cells.clear();
      this.engine.graph.clear();
      this.engine.formulas.clear();

      rows.forEach((line, row) => {
        line.forEach((field, col) => {
          const value = coerce(field, { decimal });
          if (value !== null) sheet.set(row, col, { v: value });
        });
      });

      this.model.dirty = true;
    });

    return { rows: rows.length, columns: Math.max(0, ...rows.map((r) => r.length)) };
  }

  exportCsv({ separator = ',' } = {}) {
    const bounds = this.sheet.usedBounds();
    if (!bounds) return '';

    const rows = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const line = [];
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        line.push(this.sheet.valueAt(row, col) ?? '');
      }
      rows.push(line);
    }

    return toCsv(rows, { separator, neutralise: true });
  }
}

/** The step between two cells of a numeric series, or null. */
function seriesStep(first, second) {
  if (!first || !second) return null;
  if (first.f || second.f) return null;
  if (typeof first.v !== 'number' || typeof second.v !== 'number') return null;
  return second.v - first.v;
}

export { columnName, key };

const overlaps = (a, b) => !(a.bottom < b.top || a.top > b.bottom || a.right < b.left || a.left > b.right);

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** What is looked for as a regular expression: escaped unless asked, the whole cell when asked. */
function searchPattern(query, { matchCase = false, wholeCell = false, regex = false, global = false } = {}) {
  if (!query) return null;
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeCell) source = `^(?:${source})$`;
  try {
    return new RegExp(source, `${matchCase ? '' : 'i'}${global ? 'g' : ''}`);
  } catch {
    return null;
  }
}
