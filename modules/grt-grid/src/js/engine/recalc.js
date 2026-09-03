/** Recalculating only what changed. */

import { parse, transform, NODE } from '../parser/parser.js';
import { evaluate, dependenciesOf } from './evaluate.js';
import { DependencyGraph, nodeId, parseNodeId } from './graph.js';
import { ERROR } from './values.js';
import { key, translate, shiftForStructuralChange, shiftRangeForStructuralChange, formatRef, formatRange } from '../references.js';

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

    this.rebuild();
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

  contextFor(sheetId) {
    return {
      sheetId,
      valueAt: (id, row, col) => this.valueAt(id, row, col),
      sheetIdFor: (name) => this.sheetIdFor(name),
    };
  }

  // Building

  /**
   * Parses every formula in the document and rebuilds the graph from scratch.
   */
  rebuild() {
    this.graph.clear();
    this.formulas.clear();

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

    const reads = dependenciesOf(ast, this.contextFor(sheetId));
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
    sheet.set(row, col, { v: value, f: null });
    this.model.dirty = true;

    return this.recalculateFrom([nodeId(sheetId, row, col)]);
  }

  /** Puts a formula in a cell and recalculates. */
  setFormula(sheetId, row, col, text) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;

    const normalised = text.startsWith('=') ? text : `=${text}`;
    sheet.set(row, col, { f: normalised });
    this.model.dirty = true;

    this.register(sheetId, row, col, normalised);
    return this.recalculateFrom([nodeId(sheetId, row, col)]);
  }

  clear(sheetId, row, col) {
    const sheet = this.model.sheetById(sheetId);
    if (!sheet) return null;

    this.forget(sheetId, row, col);
    sheet.clear(row, col);
    this.model.dirty = true;

    return this.recalculateFrom([nodeId(sheetId, row, col)]);
  }

  // Recalculation

  /**
   * Recalculates the cells downstream of the given ones.
   * @returns {{evaluated: string[], cyclic: string[]}}
   */
  recalculateFrom(changed) {
    const affected = this.graph.affectedBy(changed);

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

  evaluateSet(ids) {
    const { order, cyclic } = this.graph.topologicalOrder(ids);

    for (const id of cyclic) {
      const { sheetId, row, col } = parseNodeId(id);
      this.model.sheetById(sheetId)?.set(row, col, { v: ERROR.ref });
    }

    const evaluated = [];
    for (const id of order) {
      const held = this.formulas.get(id);
      if (!held) continue;

      const { sheetId, row, col } = parseNodeId(id);
      const sheet = this.model.sheetById(sheetId);
      if (!sheet) continue;

      const value = held.error || !held.ast
        ? ERROR.name
        : evaluate(held.ast, this.contextFor(sheetId));

      this.evaluations += 1;
      sheet.set(row, col, { v: value ?? null });
      evaluated.push(id);
    }

    return { evaluated, cyclic };
  }

  // Copying

  /** The text a formula becomes when copied to another cell. */
  translateFormula(text, rowDelta, colDelta) {
    const { ast, error } = parse(text);
    if (error || !ast) return text;

    const moved = transform(ast, (node) => {
      if (node.type === NODE.ref) {
        const shifted = translate(node.ref, rowDelta, colDelta);
        return shifted ? { ...node, ref: shifted } : { type: NODE.error, value: ERROR.ref };
      }
      if (node.type === NODE.range) {
        const from = translate(node.range.from, rowDelta, colDelta);
        const to = translate(node.range.to, rowDelta, colDelta);
        return from && to
          ? { ...node, range: { from, to } }
          : { type: NODE.error, value: ERROR.ref };
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

    this.model.dirty = true;
    this.rebuild();
    return this.recalculateAll();
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
      if (node.type === NODE.ref && appliesTo(node)) {
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

    case NODE.call: return `${node.name}(${node.args.map(print).join(',')})`;
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
