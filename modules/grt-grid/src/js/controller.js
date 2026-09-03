/** Selection, navigation, editing. */

import { Engine } from './engine/recalc.js';
import { UndoStack } from './core/undo.js';
import { parseInput } from './format.js';
import { a1, key, columnName } from './references.js';
import { parseCsv, toCsv, coerce, sniff } from './core/csv.js';

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

    this.record(() => {
      if (parsed.kind === 'blank') this.engine.clear(this.sheetId, row, col);
      else if (parsed.kind === 'formula') this.engine.setFormula(this.sheetId, row, col, parsed.value);
      else this.engine.setValue(this.sheetId, row, col, parsed.value);

      if (parsed.percent) this.applyStyleTo(row, col, 'percent');
    });

    return parsed;
  }

  /** Empties every cell in the selection. */
  clearSelection() {
    const { top, bottom, left, right } = this.selection;
    this.record(() => {
      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) this.engine.clear(this.sheetId, row, col);
      }
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
              this.engine.setFormula(this.sheetId, row, col, moved);
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

  /** Like setCell, but without its own undo entry. */
  setCellQuietly(row, col, text) {
    const parsed = parseInput(text);
    if (parsed.kind === 'blank') this.engine.clear(this.sheetId, row, col);
    else if (parsed.kind === 'formula') this.engine.setFormula(this.sheetId, row, col, parsed.value);
    else this.engine.setValue(this.sheetId, row, col, parsed.value);
  }

  /** Fills the selection from its first row or column. */
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
            this.engine.setFormula(this.sheetId, row, col, moved);
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

  switchSheet(id) {
    this.commitEdit();
    if (!this.model.sheetById(id)) return false;
    this.model.activeSheetId = id;
    this.active = { row: 0, col: 0 };
    this.anchor = { row: 0, col: 0 };
    this.onChange({ sheet: true });
    return true;
  }

  // Undo

  /** Runs a change as one undo step. */
  record(mutate) {
    const before = this.model.snapshot();
    const selectionBefore = { active: { ...this.active }, anchor: { ...this.anchor } };

    mutate();

    this.undo.past.push({ ...before, selection: selectionBefore });
    if (this.undo.past.length > this.undo.limit) this.undo.past.shift();
    this.undo.future.length = 0;

    this.onChange({ edited: true });
  }

  step(direction) {
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

    return toCsv(rows, { separator });
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
