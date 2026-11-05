/** A syntax tree to a value, or to a block of values that spills into the cells beside it. */

import { NODE, parse } from '../parser/parser.js';
import { FUNCTIONS, VOLATILE } from '../functions/index.js';
import {
  ERROR, isError, isBlank, toNumber, toText, toBoolean, compare, formatNumberForText, Matrix, isMatrix,
} from './values.js';
import { cellsInRange, parseRange, parseRef, ROW_COUNT, COL_COUNT } from '../references.js';

/** How many cells a single range argument may carry. */
const RANGE_LIMIT = 2_000_000;

/** How deep defined names may refer to one another. */
const NAME_DEPTH = 32;

/**
 * @param {Object} ast
 * @param {{valueAt: Function, sheetIdFor: Function, sheetId: string, row?: number, col?: number}} context
 * @returns {number|string|boolean|null|Matrix}
 */
export function evaluate(ast, context) {
  return visit(ast, context);
}

/** One argument as the library sees it: its first value, all of them, and the block they form. */
export function argument(result) {
  if (isMatrix(result)) return { value: result.first, values: result.flat, grid: result.data, matrix: result };
  return { value: result, values: [result], grid: [[result]], matrix: null };
}

/** The single value of a result, as an operator that cannot take a block needs it. */
const single = (result) => (isMatrix(result) ? result.first : result);

function visit(node, context) {
  if (!node) return ERROR.value;

  switch (node.type) {
    case NODE.number: return node.value;
    case NODE.string: return node.value;
    case NODE.boolean: return node.value;
    case NODE.error: return node.value;
    case NODE.array: return new Matrix(node.value.map((row) => [...row]));

    case NODE.ref: {
      const sheetId = sheetFor(node, context);
      if (!sheetId) return ERROR.ref;
      return context.valueAt(sheetId, node.ref.row, node.ref.col);
    }

    case NODE.spill: {
      const sheetId = sheetFor(node, context);
      if (!sheetId || !context.spillAt) return ERROR.ref;
      return context.spillAt(sheetId, node.ref.row, node.ref.col) ?? ERROR.ref;
    }

    case NODE.range: return rangeValue(node, context);

    case NODE.name: return nameValue(node.name, context);

    case NODE.unary: {
      const apply = (value) => {
        const number = toNumber(value);
        if (isError(number)) return number;
        return node.op === '-' ? -number : number;
      };
      return mapResult(visit(node.operand, context), apply);
    }

    case NODE.percent: {
      return mapResult(visit(node.operand, context), (value) => {
        const number = toNumber(value);
        return isError(number) ? number : number / 100;
      });
    }

    case NODE.binary: return binary(node, context);
    case NODE.call: return call(node, context);

    default: return ERROR.value;
  }
}

function mapResult(result, apply) {
  if (!isMatrix(result)) return apply(result);
  return Matrix.of(result.rows, result.cols, (r, c) => apply(result.data[r][c]));
}

/** Two results combined value by value; a single value or row or column stretches over the other. */
export function broadcast(left, right, apply) {
  if (!isMatrix(left) && !isMatrix(right)) return apply(left, right);
  const a = isMatrix(left) ? left : new Matrix([[left]]);
  const b = isMatrix(right) ? right : new Matrix([[right]]);
  const rows = Math.max(a.rows, b.rows);
  const cols = Math.max(a.cols, b.cols);
  if (rows * cols > RANGE_LIMIT) return ERROR.num;
  return Matrix.of(rows, cols, (r, c) => apply(a.at(r, c), b.at(r, c)));
}

const sheetFor = (node, context) => (node.sheet ? context.sheetIdFor(node.sheet) : context.sheetId);

/** A range as a block, whole columns and rows cut to where the sheet has content. */
function rangeValue(node, context) {
  const sheetId = sheetFor(node, context);
  if (!sheetId) return ERROR.ref;
  return blockOf(sheetId, node.range, context);
}

function blockOf(sheetId, range, context) {
  let top = Math.min(range.from.row, range.to.row);
  let bottom = Math.max(range.from.row, range.to.row);
  let left = Math.min(range.from.col, range.to.col);
  let right = Math.max(range.from.col, range.to.col);

  if (range.whole) {
    const used = context.boundsOf?.(sheetId);
    if (!used) return new Matrix([[null]]);
    if (range.whole === 'col') bottom = Math.min(bottom, used.bottom);
    if (range.whole === 'row') right = Math.min(right, used.right);
    if (bottom < top || right < left) return new Matrix([[null]]);
  }

  if ((bottom - top + 1) * (right - left + 1) > RANGE_LIMIT) return ERROR.num;

  const data = [];
  for (let row = top; row <= bottom; row += 1) {
    const line = [];
    for (let col = left; col <= right; col += 1) line.push(context.valueAt(sheetId, row, col));
    data.push(line);
  }
  const block = new Matrix(data);
  block.origin = { sheetId, top, left, bottom, right };
  return block;
}

/** A name bound by LET, or one defined for the document. */
function nameValue(name, context) {
  if (context.scope?.has(name)) return context.scope.get(name);
  const ast = context.nameAst?.(name);
  if (!ast) return ERROR.name;
  const depth = (context.nameDepth ?? 0) + 1;
  if (depth > NAME_DEPTH) return ERROR.ref;
  return visit(ast, { ...context, nameDepth: depth, scope: null });
}

function compareOp(op, left, right) {
  const result = compare(left, right);
  if (isError(result)) return result;
  switch (op) {
    case '=': return result === 0;
    case '<>': return result !== 0;
    case '<': return result < 0;
    case '>': return result > 0;
    case '<=': return result <= 0;
    default: return result >= 0;
  }
}

function scalarBinary(op, left, right) {
  if (isError(left)) return left;
  if (isError(right)) return right;

  if (op === '&') {
    const a = toText(left);
    const b = toText(right);
    if (isError(a)) return a;
    if (isError(b)) return b;
    return a + b;
  }
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) return compareOp(op, left, right);

  const a = toNumber(left);
  const b = toNumber(right);
  if (isError(a)) return a;
  if (isError(b)) return b;
  switch (op) {
    case '+': return finite(a + b);
    case '-': return finite(a - b);
    case '*': return finite(a * b);
    case '/': return b === 0 ? ERROR.div0 : finite(a / b);
    case '^': return finite(a ** b);
    default: return ERROR.value;
  }
}

function binary(node, context) {
  const left = visit(node.left, context);
  const right = visit(node.right, context);
  return broadcast(left, right, (a, b) => scalarBinary(node.op, a, b));
}

const finite = (value) => (Number.isFinite(value) ? value : ERROR.num);

/** Functions that look at their arguments before, or instead of, working them out. */
const LAZY = {
  IF(args, context) {
    if (args.length < 2) return ERROR.value;
    const test = visit(args[0], context);
    const choose = (value, yes, no) => {
      const flag = toBoolean(value);
      if (isError(flag)) return flag;
      return flag ? yes() : no();
    };
    const yes = () => (args[1].type === NODE.missing ? 0 : visit(args[1], context));
    const no = () => (args.length > 2 ? visit(args[2], context) : false);
    if (!isMatrix(test)) return orBlank(choose(test, yes, no));
    const a = yes();
    const b = no();
    return broadcast(test, broadcast(a, b, (x, y) => [x, y]), (t, pair) => (
      Array.isArray(pair) ? orBlank(choose(t, () => pair[0], () => pair[1])) : pair));
  },
  IFS(args, context) {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const flag = toBoolean(single(visit(args[i], context)));
      if (isError(flag)) return flag;
      if (flag) return orBlank(visit(args[i + 1], context));
    }
    return ERROR.na;
  },
  IFERROR(args, context) {
    const value = visit(args[0], context);
    if (isMatrix(value)) return mapResult(value, (v) => (isError(v) ? single(visit(args[1], context)) : v));
    return isError(value) ? orBlank(visit(args[1], context)) : orBlank(value);
  },
  IFNA(args, context) {
    const value = visit(args[0], context);
    if (isMatrix(value)) return mapResult(value, (v) => (v === ERROR.na ? single(visit(args[1], context)) : v));
    return value === ERROR.na ? orBlank(visit(args[1], context)) : orBlank(value);
  },
  CHOOSE(args, context) {
    const index = toNumber(single(visit(args[0], context)));
    if (isError(index)) return index;
    const at = Math.trunc(index);
    if (at < 1 || at >= args.length) return ERROR.value;
    return orBlank(visit(args[at], context));
  },
  SWITCH(args, context) {
    const value = single(visit(args[0], context));
    if (isError(value)) return value;
    let i = 1;
    for (; i + 1 < args.length; i += 2) {
      if (compare(value, single(visit(args[i], context))) === 0) return orBlank(visit(args[i + 1], context));
    }
    return i < args.length ? orBlank(visit(args[i], context)) : ERROR.na;
  },
  LET(args, context) {
    if (args.length < 3 || args.length % 2 === 0) return ERROR.value;
    const scope = new Map(context.scope ?? []);
    const inner = { ...context, scope };
    for (let i = 0; i + 1 < args.length; i += 2) {
      if (args[i].type !== NODE.name) return ERROR.value;
      scope.set(args[i].name, visit(args[i + 1], inner));
    }
    return visit(args[args.length - 1], inner);
  },
  GETPIVOTDATA(args, context) {
    if (args.length < 2 || args.length % 2 !== 0) return ERROR.value;
    const field = visit(args[0], context);
    const area = areaOf(args[1], context);
    if (!area || !context.pivotData) return ERROR.ref;
    const pairs = [];
    for (let i = 2; i < args.length; i += 2) {
      const name = single(visit(args[i], context));
      const item = single(visit(args[i + 1], context));
      if (isError(name)) return name;
      if (isError(item)) return item;
      pairs.push([name, item]);
    }
    if (isError(single(field))) return single(field);
    return context.pivotData(area.sheetId, area.top, area.left, single(field), pairs);
  },
  ROW(args, context) {
    if (args.length === 0) return (context.row ?? 0) + 1;
    const area = areaOf(args[0], context);
    if (!area) return ERROR.value;
    if (area.top === area.bottom) return area.top + 1;
    return Matrix.of(area.bottom - area.top + 1, 1, (r) => area.top + r + 1);
  },
  COLUMN(args, context) {
    if (args.length === 0) return (context.col ?? 0) + 1;
    const area = areaOf(args[0], context);
    if (!area) return ERROR.value;
    if (area.left === area.right) return area.left + 1;
    return Matrix.of(1, area.right - area.left + 1, (r, c) => area.left + c + 1);
  },
  ROWS(args, context) {
    const area = areaOf(args[0], context);
    if (area) return area.bottom - area.top + 1;
    const value = visit(args[0], context);
    return isMatrix(value) ? value.rows : 1;
  },
  COLUMNS(args, context) {
    const area = areaOf(args[0], context);
    if (area) return area.right - area.left + 1;
    const value = visit(args[0], context);
    return isMatrix(value) ? value.cols : 1;
  },
  AREAS(args) {
    return args[0] && (args[0].type === NODE.ref || args[0].type === NODE.range || args[0].type === NODE.spill) ? 1 : ERROR.value;
  },
  ISREF(args) {
    return Boolean(args[0]) && [NODE.ref, NODE.range, NODE.spill].includes(args[0].type);
  },
  ISFORMULA(args, context) {
    const area = areaOf(args[0], context);
    return Boolean(area && context.formulaAt?.(area.sheetId, area.top, area.left));
  },
  FORMULA(args, context) {
    const area = areaOf(args[0], context);
    return (area && context.formulaAt?.(area.sheetId, area.top, area.left)) ?? ERROR.na;
  },
  SHEET(args, context) {
    if (args.length === 0) return context.sheetIndex?.(context.sheetId) ?? 1;
    const area = areaOf(args[0], context);
    if (area) return context.sheetIndex?.(area.sheetId) ?? ERROR.ref;
    const name = single(visit(args[0], context));
    const id = context.sheetIdFor(String(name));
    return id ? context.sheetIndex(id) : ERROR.na;
  },
  SHEETS(args, context) {
    return args.length === 0 ? (context.sheetCount?.() ?? 1) : 1;
  },
  OFFSET(args, context) {
    const area = areaOf(args[0], context);
    if (!area) return ERROR.value;
    const number = (i, fallback) => (args[i] && args[i].type !== NODE.missing ? toNumber(single(visit(args[i], context))) : fallback);
    const rows = number(1, 0);
    const cols = number(2, 0);
    const height = number(3, area.bottom - area.top + 1);
    const width = number(4, area.right - area.left + 1);
    for (const value of [rows, cols, height, width]) if (isError(value)) return value;
    const top = area.top + Math.trunc(rows);
    const left = area.left + Math.trunc(cols);
    const h = Math.trunc(height);
    const w = Math.trunc(width);
    if (h < 1 || w < 1 || top < 0 || left < 0 || top + h > ROW_COUNT || left + w > COL_COUNT) return ERROR.ref;
    if (h === 1 && w === 1) return context.valueAt(area.sheetId, top, left);
    return blockOf(area.sheetId, { from: { row: top, col: left }, to: { row: top + h - 1, col: left + w - 1 } }, context);
  },
  INDIRECT(args, context) {
    const text = toText(single(visit(args[0], context)));
    if (isError(text)) return text;
    const area = areaFromText(text, context);
    if (!area) return ERROR.ref;
    if (area.top === area.bottom && area.left === area.right) return context.valueAt(area.sheetId, area.top, area.left);
    return blockOf(area.sheetId, { from: { row: area.top, col: area.left }, to: { row: area.bottom, col: area.right } }, context);
  },
};

const orBlank = (value) => (value === undefined ? null : value);

/** The cells an argument names, when it names cells rather than computing a value. */
function areaOf(node, context) {
  if (!node) return null;
  if (node.type === NODE.ref || node.type === NODE.spill) {
    const sheetId = sheetFor(node, context);
    if (!sheetId) return null;
    if (node.type === NODE.spill) {
      const block = context.spillAt?.(node.sheet ? sheetId : context.sheetId, node.ref.row, node.ref.col);
      const rows = isMatrix(block) ? block.rows : 1;
      const cols = isMatrix(block) ? block.cols : 1;
      return { sheetId, top: node.ref.row, left: node.ref.col, bottom: node.ref.row + rows - 1, right: node.ref.col + cols - 1 };
    }
    return { sheetId, top: node.ref.row, left: node.ref.col, bottom: node.ref.row, right: node.ref.col };
  }
  if (node.type === NODE.range) {
    const sheetId = sheetFor(node, context);
    if (!sheetId) return null;
    const { from, to } = node.range;
    return {
      sheetId,
      top: Math.min(from.row, to.row),
      left: Math.min(from.col, to.col),
      bottom: Math.max(from.row, to.row),
      right: Math.max(from.col, to.col),
    };
  }
  if (node.type === NODE.name && !context.scope?.has(node.name)) {
    const ast = context.nameAst?.(node.name);
    return ast && ast !== node ? areaOf(ast, context) : null;
  }
  if (node.type === NODE.call && (node.name === 'OFFSET' || node.name === 'INDIRECT')) {
    const value = LAZY[node.name](node.args, context);
    if (isMatrix(value) && value.origin) return value.origin;
  }
  return null;
}

function areaFromText(text, context) {
  const trimmed = text.trim();
  const bang = trimmed.lastIndexOf('!');
  const sheetName = bang === -1 ? null : trimmed.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
  const where = bang === -1 ? trimmed : trimmed.slice(bang + 1);
  const sheetId = sheetName ? context.sheetIdFor(sheetName) : context.sheetId;
  if (!sheetId) return null;
  const range = parseRange(where);
  if (range) {
    return {
      sheetId,
      top: Math.min(range.from.row, range.to.row),
      left: Math.min(range.from.col, range.to.col),
      bottom: Math.max(range.from.row, range.to.row),
      right: Math.max(range.from.col, range.to.col),
    };
  }
  const ref = parseRef(where);
  if (ref) return { sheetId, top: ref.row, left: ref.col, bottom: ref.row, right: ref.col };
  const named = context.nameAst?.(where.toUpperCase());
  return named ? areaOf(named, context) : null;
}

function call(node, context) {
  const lazy = LAZY[node.name];
  if (lazy) {
    try {
      return orBlank(lazy(node.args, context));
    } catch {
      return ERROR.value;
    }
  }

  const implementation = FUNCTIONS[node.name];
  if (!implementation) return ERROR.name;

  const args = node.args.map((arg) => (arg.type === NODE.missing ? { value: null, values: [], grid: [[null]], matrix: null, missing: true }
    : argument(visit(arg, context))));

  try {
    const result = implementation(args, context);
    return result === undefined ? null : result;
  } catch {
    // A function that throws is a bug in this program, not in the sheet.
    return ERROR.value;
  }
}

/** Functions whose result depends on more than their arguments name. */
const DYNAMIC = new Set(['INDIRECT', 'OFFSET']);

/**
 * Which cells and ranges a formula reads.
 * @returns {{cells: string[], ranges: Object[], volatile: boolean}}
 */
export function dependenciesOf(ast, context) {
  const cells = new Set();
  const ranges = [];
  let isVolatile = false;
  const seenNames = new Set();

  const walkNode = (node) => {
    if (!node) return;

    switch (node.type) {
      case NODE.ref:
      case NODE.spill: {
        const sheetId = node.sheet ? context.sheetIdFor(node.sheet) : context.sheetId;
        if (sheetId) cells.add(`${sheetId}!${node.ref.row},${node.ref.col}`);
        break;
      }
      case NODE.range: {
        const sheetId = node.sheet ? context.sheetIdFor(node.sheet) : context.sheetId;
        if (sheetId) ranges.push({ sheetId, from: node.range.from, to: node.range.to });
        break;
      }
      case NODE.name: {
        if (seenNames.has(node.name)) break;
        seenNames.add(node.name);
        walkNode(context.nameAst?.(node.name));
        break;
      }
      case NODE.call:
        if (VOLATILE.has(node.name) || DYNAMIC.has(node.name)) isVolatile = true;
        for (const arg of node.args) walkNode(arg);
        break;
      case NODE.binary: walkNode(node.left); walkNode(node.right); break;
      case NODE.unary: case NODE.percent: walkNode(node.operand); break;
      default: break;
    }
  };

  walkNode(ast);
  return { cells: [...cells], ranges, volatile: isVolatile };
}

/** Parses the text of a defined name. */
export function nameFormula(text) {
  const { ast } = parse(String(text ?? '').replace(/^=?/, '='));
  return ast;
}

export { cellsInRange, formatNumberForText, isBlank };
