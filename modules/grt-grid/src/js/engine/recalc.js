/** Recalculating only what changed. */

import { pivotData, readSource } from '../pivot.js';
import { parse, transform, NODE } from '../parser/parser.js';
import { evaluate, dependenciesOf, nameFormula, implicitValue } from './evaluate.js';
import { DependencyGraph, nodeId, parseNodeId } from './graph.js';
import { ERROR, Matrix, isMatrix } from './values.js';
import {
  key, translate, shiftForStructuralChange, shiftRangeForStructuralChange, formatRef, formatRange, ROW_COUNT, COL_COUNT,
} from '../references.js';

/** The most cells one formula may spill into. */
const SPILL_LIMIT = 1_000_000;
/** How many times spills may ripple into other formulas within one recalculation. */
const SPILL_ROUNDS = 16;

export class Engine {
  /**
   * @param {import('../model.js').GridModel} model
   */
  constructor(model) {
    this.model = model;
    this.graph = new DependencyGraph();
    /** node id → {ast, error, volatile}. */
    this.formulas = new Map();
    /** Counts evaluations, so a test can prove only the right cells ran. */
    this.evaluations = 0;
    /** Upper-case name to its parsed formula. */
    this.nameAsts = new Map();
    this.bounds = new Map();

    this.rebuild();
    // Spills are not saved: the formulas that make them run again when the document opens.
    const spilling = [];
    for (const sheet of model.sheets) {
      for (const [at, cell] of sheet.cells) {
        if (cell.f && (cell.sp || cell.v === undefined)) {
          const { row, col } = splitKey(at);
          spilling.push(nodeId(sheet.id, row, col));
        }
      }
    }
    if (spilling.length > 0) this.evaluateSet(new Set(spilling));
  }

  // Reading

  sheetIdFor(name) {
    return this.model.sheetNamed(name)?.id ?? null;
  }

  valueAt(sheetId, row, col) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return ERROR.ref;
    return sheet.valueAt(row, col);
  }

  contextFor(sheetId, row = 0, col = 0) {
    return {
      sheetId,
      row,
      col,
      valueAt: (id, r, c) => this.valueAt(id, r, c),
      sheetIdFor: (name) => this.sheetIdFor(name),
      boundsOf: (id) => this.boundsOf(id),
      spillAt: (id, r, c) => this.spillAt(id, r, c),
      nameAst: (name) => this.nameAsts.get(name) ?? null,
      formulaAt: (id, r, c) => this.model.sheetById(id)?.formulaAt(r, c) ?? null,
      sheetIndex: (id) => this.model.sheets.findIndex((sheet) => sheet.id === id) + 1 || null,
      sheetCount: () => this.model.sheets.length,
      sheetName: (id) => this.model.sheetById(id)?.name ?? null,
      formatAt: (id, r, c) => {
        const style = this.model.sheetById(id)?.styleAt(r, c);
        return (style && this.model.styles?.[style]?.format) || null;
      },
      alignAt: (id, r, c) => {
        const style = this.model.sheetById(id)?.styleAt(r, c);
        return (style && this.model.styles?.[style]?.align) || null;
      },
      columnWidth: (id, c) => this.model.sheetById(id)?.columnWidth(c) ?? null,
      isHidden: (id, r) => this.model.sheetById(id)?.isHidden('row', r) ?? false,
      isFiltered: (id, r) => this.model.sheetById(id)?.filtered.has(r) ?? false,
      pivotData: (id, r, c, field, pairs) => {
        const pivot = this.model.sheetById(id)?.pivots?.find((p) => p.area && r >= p.area.top && r <= p.area.bottom && c >= p.area.left && c <= p.area.right);
        return pivot ? pivotData(pivot, readSource(pivot.source, this, id), field, pairs) : ERROR.ref;
      },
    };
  }

  /** Where a sheet's content stops, kept until something changes. */
  boundsOf(sheetId) {
    if (!this.bounds.has(sheetId)) this.bounds.set(sheetId, this.model.sheetById(sheetId)?.usedBounds() ?? null);
    return this.bounds.get(sheetId);
  }

  /** The whole block a formula spills, as A1# reads it. */
  spillAt(sheetId, row, col) {
    const sheet = this.model.sheetById(sheetId);
    const anchor = sheet?.anchors.get(key(row, col));
    if (!anchor) {
      const formula = sheet?.formulaAt(row, col);
      return formula ? sheet.valueAt(row, col) : ERROR.ref;
    }
    if (anchor.blocked) return ERROR.spill;
    return Matrix.of(anchor.rows, anchor.cols, (r, c) => sheet.valueAt(row + r, col + c));
  }

  // Names

  /** Defines a name, or removes it when the text is empty, and recalculates everything. */
  setName(name, text) {
    const upper = String(name).toUpperCase();
    if (text) this.model.names[upper] = text.startsWith('=') ? text : `=${text}`;
    else delete this.model.names[upper];
    this.model.dirty = true;
    this.rebuild();
    return this.recalculateAll();
  }

  // Building

  /**
   * Parses every formula in the document and rebuilds the graph from scratch.
   */
  rebuild() {
    this.graph.clear();
    this.formulas.clear();
    this.bounds.clear();
    for (const sheet of this.model.sheets) {
      sheet.spills.clear();
      sheet.anchors.clear();
    }
    this.nameAsts = new Map(Object.entries(this.model.names ?? {})
      .map(([name, text]) => [name.toUpperCase(), nameFormula(text)])
      .filter(([, ast]) => ast));

    for (const sheet of this.model.sheets) {
      for (const [at, text] of sheet.formulas()) {
        const { row, col } = splitKey(at);
        this.register(sheet.id, row, col, text);
      }
    }
  }

  /** Parses one formula and records what it reads. */
  register(sheetId, row, col, text) {
    const id = nodeId(sheetId, row, col);
    const { ast, error } = parse(text);

    if (error || !ast) {
      this.formulas.set(id, { ast: null, error, volatile: false });
      this.graph.setDependencies(id, {});
      return { ast: null, error };
    }

    const reads = dependenciesOf(ast, this.contextFor(sheetId, row, col));
    this.formulas.set(id, { ast, error: null, volatile: reads.volatile });
    this.graph.setDependencies(id, { cells: reads.cells, ranges: reads.ranges });
    return { ast, error: null };
  }

  forget(sheetId, row, col) {
    const id = nodeId(sheetId, row, col);
    this.formulas.delete(id);
    this.graph.remove(id);
  }

  // Changing

  /** Puts a literal value in a cell and recalculates what depended on it. */
  setValue(sheetId, row, col, value) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;

    this.forget(sheetId, row, col);
    this.unspill(sheet, row, col);
    sheet.set(row, col, { v: value, f: null, sp: null });
    this.model.dirty = true;
    this.bounds.delete(sheetId);

    return this.recalculateFrom([nodeId(sheetId, row, col)]);
  }

  /** Puts literal values in several cells of one sheet, then recalculates once. */
  setValues(sheetId, cells) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;
    for (const { row, col, value } of cells) {
      this.forget(sheetId, row, col);
      this.unspill(sheet, row, col);
      sheet.set(row, col, { v: value, f: null, sp: null });
    }
    this.model.dirty = true;
    this.bounds.delete(sheetId);
    return this.recalculateFrom(cells.map(({ row, col }) => nodeId(sheetId, row, col)));
  }

  /**
   * Puts a formula in a cell and recalculates.
   * @param {boolean} [implicit] whether it intersects instead of spilling; left out, the cell keeps what it had
   */
  setFormula(sheetId, row, col, text, implicit = undefined) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;

    const normalised = text.startsWith('=') ? text : `=${text}`;
    const cell = sheet.set(row, col, { f: normalised });
    if (implicit === true) cell.i = 1;
    else if (implicit === false) delete cell.i;
    this.model.dirty = true;
    this.bounds.delete(sheetId);

    this.register(sheetId, row, col, normalised);
    return this.recalculateFrom([nodeId(sheetId, row, col)]);
  }

  /** Takes what a cell holds and leaves its look and its comment, as Calc's Delete key does. */
  clearContent(sheetId, row, col) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;

    this.forget(sheetId, row, col);
    this.unspill(sheet, row, col);
    sheet.set(row, col, { v: null, f: null, sp: null });
    this.model.dirty = true;
    this.bounds.delete(sheetId);

    return this.recalculateFrom([nodeId(sheetId, row, col)]);
  }

  clear(sheetId, row, col) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;

    this.forget(sheetId, row, col);
    this.unspill(sheet, row, col);
    sheet.clear(row, col);
    this.model.dirty = true;
    this.bounds.delete(sheetId);

    return this.recalculateFrom([nodeId(sheetId, row, col)]);
  }

  // Recalculation

  /**
   * Recalculates the cells downstream of the given ones.
   * @returns {{evaluated: string[], cyclic: string[]}}
   */
  recalculateFrom(changed) {
    const affected = this.graph.affectedBy([...changed, ...this.anchorsOver(changed)]);

    // The changed cells themselves are only recalculated if they hold
    // formulas; a typed number needs no evaluation.
    const toEvaluate = new Set(
      [...affected].filter((id) => this.formulas.has(id)),
    );

    for (const [id, held] of this.formulas) {
      if (held.volatile) toEvaluate.add(id);
    }

    return this.evaluateSet(toEvaluate);
  }

  /** Recalculates everything. */
  recalculateAll() {
    return this.evaluateSet(new Set(this.formulas.keys()));
  }

  evaluateSet(ids, round = 0) {
    const { order, cyclic } = this.graph.topologicalOrder(ids);

    for (const id of cyclic) {
      const { sheetId, row, col } = parseNodeId(id);
      this.model.sheetById(sheetId)?.set(row, col, { v: ERROR.ref });
    }

    const evaluated = [];
    const spilled = new Set();
    for (const id of order) {
      const held = this.formulas.get(id);
      if (!held) continue;

      const { sheetId, row, col } = parseNodeId(id);
      const sheet = this.model.sheetById(sheetId);
      if (!sheet) continue;

      let value = held.error || !held.ast
        ? ERROR.name
        : evaluate(held.ast, this.contextFor(sheetId, row, col));
      // A formula read from LibreOffice or an older Excel does not spill; it shows the value on its row.
      if (isMatrix(value) && sheet.cells.get(key(row, col))?.i) value = implicitValue(value, row, col);

      if (isMatrix(value) && value.rows * value.cols > 1) {
        value = this.spill(sheet, row, col, value, spilled);
      } else {
        if (isMatrix(value)) value = value.first;
        this.unspill(sheet, row, col, spilled);
      }

      this.evaluations += 1;
      sheet.set(row, col, { v: value ?? null });
      evaluated.push(id);
    }

    // What changed in the spilled cells reaches the formulas that read them.
    if (spilled.size > 0 && round < SPILL_ROUNDS) {
      const done = new Set(evaluated);
      const next = new Set([...this.graph.affectedBy([...spilled, ...this.anchorsOver([...spilled])])]
        .filter((id) => this.formulas.has(id) && !(done.has(id) && !this.anchorsOver([...spilled]).includes(id))));
      if (next.size > 0) {
        const more = this.evaluateSet(next, round + 1);
        evaluated.push(...more.evaluated);
        cyclic.push(...more.cyclic);
      }
    }

    return { evaluated, cyclic };
  }

  /** Puts a block's values in the cells beside its formula; the formula's own cell gets the first. */
  spill(sheet, row, col, block, changed) {
    const at = key(row, col);
    this.unspill(sheet, row, col, changed);
    const size = block.rows * block.cols;
    let blocked = size > SPILL_LIMIT || row + block.rows > ROW_COUNT || col + block.cols > COL_COUNT;
    for (let r = 0; r < block.rows && !blocked; r += 1) {
      for (let c = 0; c < block.cols && !blocked; c += 1) {
        if (r === 0 && c === 0) continue;
        const target = key(row + r, col + c);
        const cell = sheet.cells.get(target);
        if (cell && (cell.f || (cell.v !== undefined && cell.v !== null && cell.v !== ''))) blocked = true;
        else if (sheet.spills.has(target)) blocked = true;
      }
    }
    sheet.anchors.set(at, { rows: block.rows, cols: block.cols, blocked });
    sheet.set(row, col, { sp: blocked ? null : 1 });
    this.bounds.delete(sheet.id);
    if (blocked) return ERROR.spill;
    for (let r = 0; r < block.rows; r += 1) {
      for (let c = 0; c < block.cols; c += 1) {
        if (r === 0 && c === 0) continue;
        sheet.spills.set(key(row + r, col + c), block.data[r]?.[c] ?? null);
        changed?.add(nodeId(sheet.id, row + r, col + c));
      }
    }
    return block.first;
  }

  /** Takes back the values a formula spilled. */
  unspill(sheet, row, col, changed = null) {
    const at = key(row, col);
    const anchor = sheet.anchors.get(at);
    if (!anchor) return;
    sheet.anchors.delete(at);
    if (sheet.cells.get(at)?.sp) sheet.set(row, col, { sp: null });
    this.bounds.delete(sheet.id);
    if (anchor.blocked) return;
    for (let r = 0; r < anchor.rows; r += 1) {
      for (let c = 0; c < anchor.cols; c += 1) {
        if (r === 0 && c === 0) continue;
        sheet.spills.delete(key(row + r, col + c));
        changed?.add(nodeId(sheet.id, row + r, col + c));
      }
    }
  }

  /** The formulas whose spill covers, or would cover, any of these cells. */
  anchorsOver(ids) {
    const out = [];
    for (const id of ids) {
      const { sheetId, row, col } = parseNodeId(id);
      const sheet = this.model.sheetById(sheetId);
      if (!sheet || sheet.anchors.size === 0) continue;
      for (const [at, anchor] of sheet.anchors) {
        const origin = splitKey(at);
        if (origin.row === row && origin.col === col) continue;
        if (row >= origin.row && row < origin.row + anchor.rows && col >= origin.col && col < origin.col + anchor.cols) {
          out.push(nodeId(sheetId, origin.row, origin.col));
        }
      }
    }
    return out;
  }

  // Copying

  /** The text a formula becomes when copied to another cell. */
  translateFormula(text, rowDelta, colDelta) {
    const { ast, error } = parse(text);
    if (error || !ast) return text;

    const moved = transform(ast, (node) => {
      if (node.type === NODE.ref || node.type === NODE.spill) {
        const shifted = translate(node.ref, rowDelta, colDelta);
        return shifted ? { ...node, ref: shifted } : { type: NODE.error, value: ERROR.ref };
      }
      if (node.type === NODE.range) {
        const from = translate(node.range.from, rowDelta, colDelta);
        const to = translate(node.range.to, rowDelta, colDelta);
        return from && to
          ? { ...node, range: { ...node.range, from, to } }
          : { type: NODE.error, value: ERROR.ref };
      }
      return node;
    });

    return `=${print(moved)}`;
  }

  /** A formula moved from one cell to another with the block turned on its side: its relative offsets swap. */
  transposeFormula(text, from, to) {
    const { ast, error } = parse(text);
    if (error || !ast) return text;
    const turn = (ref) => {
      const row = ref.rowAbs ? ref.row : to.row + (ref.col - from.col);
      const col = ref.colAbs ? ref.col : to.col + (ref.row - from.row);
      return row < 0 || col < 0 ? null : { ...ref, row, col };
    };
    const moved = transform(ast, (node) => {
      if (node.type === NODE.ref || node.type === NODE.spill) {
        const ref = turn(node.ref);
        return ref ? { ...node, ref } : { type: NODE.error, value: ERROR.ref };
      }
      if (node.type === NODE.range) {
        const a = turn(node.range.from);
        const b = turn(node.range.to);
        return a && b ? { ...node, range: { ...node.range, from: a, to: b } } : { type: NODE.error, value: ERROR.ref };
      }
      return node;
    });
    return `=${print(moved)}`;
  }

  // Rows and columns

  /**
   * Inserts or removes rows or columns, moving cells and rewriting formulas.
   * @param {string} sheetId
   * @param {{axis: 'row'|'col', at: number, count: number}} change
   */
  applyStructuralChange(sheetId, change) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;

    const { axis, at, count } = change;
    const moved = new Map();

    for (const [cellKey, cell] of sheet.cells) {
      const { row, col } = splitKey(cellKey);
      const index = axis === 'row' ? row : col;

      if (count > 0) {
        if (index < at) { moved.set(cellKey, cell); continue; }
        const to = axis === 'row' ? key(row + count, col) : key(row, col + count);
        moved.set(to, cell);
        continue;
      }

      const removed = -count;
      if (index < at) { moved.set(cellKey, cell); continue; }
      if (index < at + removed) continue;               // deleted with the rows.
      const to = axis === 'row' ? key(row - removed, col) : key(row, col - removed);
      moved.set(to, cell);
    }

    sheet.cells = moved;
    sheet.shiftAxis(change);

    // Every formula in the document may refer to the cells that moved, so all
    // of them are rewritten.
    for (const other of this.model.sheets) {
      for (const [cellKey, cell] of [...other.cells]) {
        if (!cell.f) continue;
        const rewritten = this.shiftFormula(cell.f, sheetId, other.id, change);
        if (rewritten !== cell.f) {
          const { row, col } = splitKey(cellKey);
          other.set(row, col, { f: rewritten });
        }
      }
    }

    // Names and the ranges charts draw from follow the cells too, and a chart moves with its anchor.
    for (const [name, text] of Object.entries(this.model.names ?? {})) {
      this.model.names[name] = this.shiftFormula(text, sheetId, this.model.sheets[0]?.id, change);
    }
    for (const other of this.model.sheets) {
      for (const pivot of other.pivots ?? []) pivot.source = this.shiftFormula(`=${pivot.source}`, sheetId, other.id, change).slice(1);
    }
    for (const chart of this.model.charts ?? []) {
      const shift = (ref) => (ref ? this.shiftFormula(`=${ref}`, sheetId, chart.sheet, change).slice(1) : ref);
      for (const series of chart.series ?? []) {
        for (const field of ['values', 'categories', 'x', 'nameRef']) if (series[field]) series[field] = shift(series[field]);
      }
      if (chart.sheet === sheetId && chart.anchor) {
        const index = axis === 'row' ? 'row' : 'col';
        if (chart.anchor[index] >= at) chart.anchor[index] = Math.max(at, chart.anchor[index] + count);
      }
    }

    this.model.dirty = true;
    this.rebuild();
    return this.recalculateAll();
  }

  /**
   * Moves a block of cells, as cutting and pasting or inserting cells does: what pointed into the block
   * follows it, what the moved formulas point at outside it stays.
   */
  moveBlock(sheetId, area, rowDelta, colDelta) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet || (rowDelta === 0 && colDelta === 0)) return null;
    const moving = [];
    for (const [at, cell] of sheet.cells) {
      const { row, col } = splitKey(at);
      if (row >= area.top && row <= area.bottom && col >= area.left && col <= area.right) moving.push([row, col, cell]);
    }
    for (const [row, col] of moving) sheet.cells.delete(key(row, col));
    for (const [row, col, cell] of moving) {
      if (row + rowDelta < 0 || col + colDelta < 0) continue;
      sheet.cells.set(key(row + rowDelta, col + colDelta), cell);
    }
    const inside = (ref) => ref.row >= area.top && ref.row <= area.bottom && ref.col >= area.left && ref.col <= area.right;
    const shift = (ref) => ({ ...ref, row: ref.row + rowDelta, col: ref.col + colDelta });
    this.rewriteReferences(sheetId, (node) => {
      if ((node.type === NODE.ref || node.type === NODE.spill) && inside(node.ref)) return { ...node, ref: shift(node.ref) };
      if (node.type === NODE.range && !node.range.whole && inside(node.range.from) && inside(node.range.to)) {
        return { ...node, range: { ...node.range, from: shift(node.range.from), to: shift(node.range.to) } };
      }
      return node;
    });
    sheet.merges = sheet.merges.map((m) => (inside({ row: m.top, col: m.left }) && inside({ row: m.bottom, col: m.right })
      ? { top: m.top + rowDelta, left: m.left + colDelta, bottom: m.bottom + rowDelta, right: m.right + colDelta } : m));
    this.model.dirty = true;
    this.rebuild();
    return this.recalculateAll();
  }

  /** Turns every reference into a block of cells into #REF!, before those cells go. */
  breakReferences(sheetId, area) {
    const touches = (ref) => ref.row >= area.top && ref.row <= area.bottom && ref.col >= area.left && ref.col <= area.right;
    this.rewriteReferences(sheetId, (node) => {
      if ((node.type === NODE.ref || node.type === NODE.spill) && touches(node.ref)) return { type: NODE.error, value: ERROR.ref };
      if (node.type === NODE.range && !node.range.whole && touches(node.range.from) && touches(node.range.to)) {
        return { type: NODE.error, value: ERROR.ref };
      }
      return node;
    });
  }

  /** Passes every reference to a sheet, in every formula of the document, through `change`. */
  rewriteReferences(sheetId, change) {
    for (const other of this.model.sheets) {
      for (const [cellKey, cell] of [...other.cells]) {
        if (!cell.f) continue;
        const { ast, error } = parse(cell.f);
        if (error || !ast) continue;
        const applies = (node) => (node.sheet ? this.sheetIdFor(node.sheet) : other.id) === sheetId;
        const changed = transform(ast, (node) => (applies(node) ? change(node) : node));
        const text = `=${print(changed)}`;
        if (text !== cell.f) {
          const { row, col } = splitKey(cellKey);
          other.set(row, col, { f: text });
        }
      }
    }
  }

  /**
   * Points the formulas and names that name a sheet at its new name, or at #REF! when it is gone.
   * @param {string} oldName
   * @param {string|null} newName null when the sheet was deleted
   */
  renameSheetReferences(oldName, newName) {
    const wanted = oldName.toLowerCase();
    const rewrite = (text) => {
      const { ast, error } = parse(text);
      if (error || !ast) return text;
      const changed = transform(ast, (node) => {
        if (![NODE.ref, NODE.range, NODE.spill].includes(node.type) || node.sheet?.toLowerCase() !== wanted) return node;
        return newName === null ? { type: NODE.error, value: ERROR.ref } : { ...node, sheet: newName };
      });
      return `=${print(changed)}`;
    };
    for (const sheet of this.model.sheets) {
      for (const [cellKey, cell] of [...sheet.cells]) {
        if (!cell.f) continue;
        const text = rewrite(cell.f);
        if (text !== cell.f) {
          const { row, col } = splitKey(cellKey);
          sheet.set(row, col, { f: text });
        }
      }
    }
    for (const [name, text] of Object.entries(this.model.names)) this.model.names[name] = rewrite(text);
    // Chart series keep their ranges as text without the equals sign.
    for (const chart of this.model.charts) {
      for (const series of chart.series ?? []) {
        for (const key of ['values', 'categories', 'nameRef']) {
          if (typeof series[key] === 'string' && series[key].includes('!')) series[key] = rewrite(`=${series[key]}`).slice(1);
        }
      }
    }
  }

  /** Rewrites the references in one formula for a structural change. */
  shiftFormula(text, changedSheetId, formulaSheetId, change) {
    const { ast, error } = parse(text);
    if (error || !ast) return text;

    const appliesTo = (node) => {
      const sheetId = node.sheet ? this.sheetIdFor(node.sheet) : formulaSheetId;
      return sheetId === changedSheetId;
    };

    const shifted = transform(ast, (node) => {
      if ((node.type === NODE.ref || node.type === NODE.spill) && appliesTo(node)) {
        const next = shiftForStructuralChange(node.ref, change);
        return next ? { ...node, ref: next } : { type: NODE.error, value: ERROR.ref };
      }
      if (node.type === NODE.range && appliesTo(node)) {
        const next = shiftRangeForStructuralChange(node.range, change);
        return next ? { ...node, range: next } : { type: NODE.error, value: ERROR.ref };
      }
      return node;
    });

    return `=${print(shifted)}`;
  }
}

// Printing a tree back to text

/** Turns a syntax tree back into a formula. */
export function print(node) {
  if (!node) return '';

  switch (node.type) {
    case NODE.number: return String(node.value);
    case NODE.string: return `"${String(node.value).replace(/"/g, '""')}"`;
    case NODE.boolean: return node.value ? 'TRUE' : 'FALSE';
    case NODE.error: return node.value;
    case NODE.name: return node.name;

    case NODE.ref:
      return `${node.sheet ? `${quoteSheet(node.sheet)}!` : ''}${formatRef(node.ref)}`;
    case NODE.range:
      return `${node.sheet ? `${quoteSheet(node.sheet)}!` : ''}${formatRange(node.range)}`;
    case NODE.spill:
      return `${node.sheet ? `${quoteSheet(node.sheet)}!` : ''}${formatRef(node.ref)}#`;

    case NODE.call: return `${node.name}(${node.args.map(print).join(',')})`;
    case NODE.missing: return '';
    case NODE.array:
      return `{${node.value.map((row) => row.map((v) => (typeof v === 'string' && !v.startsWith('#') ? `"${v.replace(/"/g, '""')}"`
        : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))).join(',')).join(';')}}`;
    case NODE.unary: return `${node.op}${print(node.operand)}`;
    case NODE.percent: return `${print(node.operand)}%`;

    case NODE.binary: {
      const left = needsBrackets(node.left, node) ? `(${print(node.left)})` : print(node.left);
      const right = needsBrackets(node.right, node, true) ? `(${print(node.right)})` : print(node.right);
      return `${left}${node.op}${right}`;
    }

    default: return '';
  }
}

const PRECEDENCE = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
};

function needsBrackets(child, parent, isRight = false) {
  if (!child || child.type !== NODE.binary) return false;
  const inner = PRECEDENCE[child.op] ?? 0;
  const outer = PRECEDENCE[parent.op] ?? 0;
  if (inner < outer) return true;
  // Same precedence on the right of a non-associative operator: a-(b-c).
  return inner === outer && isRight && ['-', '/', '^'].includes(parent.op);
}

function quoteSheet(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name}'`;
}

function splitKey(text) {
  const [row, col] = String(text).split(',').map(Number);
  return { row, col };
}
