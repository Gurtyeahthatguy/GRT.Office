/** A syntax tree to a value. */

import { NODE } from '../parser/parser.js';
import { FUNCTIONS } from '../functions/index.js';
import {
  ERROR, isError, toNumber, toText, toBoolean, compare, formatNumberForText,
} from './values.js';
import { cellsInRange } from '../references.js';

/** How many cells a single range argument may carry. */
const RANGE_LIMIT = 200000;

/**
 * @param {Object} ast
 * @param {{valueAt: Function, sheetIdFor: Function, sheetId: string}} context
 * @returns {number|string|boolean|null}
 */
export function evaluate(ast, context) {
  const result = visit(ast, context);
  return result && typeof result === 'object' ? result.value : result;
}

function visit(node, context) {
  if (!node) return ERROR.value;

  switch (node.type) {
    case NODE.number: return node.value;
    case NODE.string: return node.value;
    case NODE.boolean: return node.value;
    case NODE.error: return node.value;

    case NODE.ref: {
      const sheetId = sheetFor(node, context);
      if (!sheetId) return ERROR.ref;
      return context.valueAt(sheetId, node.ref.row, node.ref.col);
    }

    case NODE.range: return rangeArgument(node, context);

    case NODE.name:
      // A bare word that is not a function is a defined name, and there are
      // none yet ( lists them as an open question).
      return ERROR.name;

    case NODE.unary: {
      const value = valueOf(visit(node.operand, context));
      const number = toNumber(value);
      if (isError(number)) return number;
      return node.op === '-' ? -number : number;
    }

    case NODE.percent: {
      const value = toNumber(valueOf(visit(node.operand, context)));
      return isError(value) ? value : value / 100;
    }

    case NODE.binary: return binary(node, context);
    case NODE.call: return call(node, context);

    default: return ERROR.value;
  }
}

const valueOf = (result) => (result && typeof result === 'object' ? result.value : result);

function sheetFor(node, context) {
  if (!node.sheet) return context.sheetId;
  return context.sheetIdFor(node.sheet);
}

/** A range as a function argument. */
function rangeArgument(node, context) {
  const sheetId = sheetFor(node, context);
  if (!sheetId) return { value: ERROR.ref, values: [ERROR.ref], grid: [[ERROR.ref]] };

  const { from, to } = node.range;
  const top = Math.min(from.row, to.row);
  const bottom = Math.max(from.row, to.row);
  const left = Math.min(from.col, to.col);
  const right = Math.max(from.col, to.col);

  if ((bottom - top + 1) * (right - left + 1) > RANGE_LIMIT) {
    return { value: ERROR.num, values: [ERROR.num], grid: [[ERROR.num]] };
  }

  const grid = [];
  const values = [];
  for (let row = top; row <= bottom; row += 1) {
    const line = [];
    for (let col = left; col <= right; col += 1) {
      const value = context.valueAt(sheetId, row, col);
      line.push(value);
      values.push(value);
    }
    grid.push(line);
  }

  return { value: values[0] ?? null, values, grid };
}

function binary(node, context) {
  const left = valueOf(visit(node.left, context));
  const right = valueOf(visit(node.right, context));

  if (isError(left)) return left;
  if (isError(right)) return right;

  switch (node.op) {
    case '&': {
      const a = toText(left);
      const b = toText(right);
      if (isError(a)) return a;
      if (isError(b)) return b;
      return a + b;
    }

    case '=': case '<>': case '<': case '>': case '<=': case '>=': {
      const result = compare(left, right);
      if (isError(result)) return result;
      switch (node.op) {
        case '=': return result === 0;
        case '<>': return result !== 0;
        case '<': return result < 0;
        case '>': return result > 0;
        case '<=': return result <= 0;
        default: return result >= 0;
      }
    }

    default: {
      const a = toNumber(left);
      const b = toNumber(right);
      if (isError(a)) return a;
      if (isError(b)) return b;

      switch (node.op) {
        case '+': return finite(a + b);
        case '-': return finite(a - b);
        case '*': return finite(a * b);
        case '/': return b === 0 ? ERROR.div0 : finite(a / b);
        case '^': return finite(a ** b);
        default: return ERROR.value;
      }
    }
  }
}

const finite = (value) => (Number.isFinite(value) ? value : ERROR.num);

function call(node, context) {
  const implementation = FUNCTIONS[node.name];
  if (!implementation) return ERROR.name;

  const args = node.args.map((arg) => {
    const result = visit(arg, context);
    if (result && typeof result === 'object') return result;
    return { value: result, values: [result] };
  });

  try {
    const result = implementation(args);
    return result === undefined ? null : result;
  } catch {
    // A function that throws is a bug in this program, not in the sheet.
    return ERROR.value;
  }
}

/**
 * Which cells and ranges a formula reads.
 * @returns {{cells: string[], ranges: Object[], volatile: boolean}}
 */
export function dependenciesOf(ast, context) {
  const cells = new Set();
  const ranges = [];
  let isVolatile = false;

  const walkNode = (node) => {
    if (!node) return;

    switch (node.type) {
      case NODE.ref: {
        const sheetId = node.sheet ? context.sheetIdFor(node.sheet) : context.sheetId;
        if (sheetId) cells.add(`${sheetId}!${node.ref.row},${node.ref.col}`);
        break;
      }
      case NODE.range: {
        const sheetId = node.sheet ? context.sheetIdFor(node.sheet) : context.sheetId;
        if (sheetId) ranges.push({ sheetId, from: node.range.from, to: node.range.to });
        break;
      }
      case NODE.call:
        if (VOLATILE_NAMES.has(node.name)) isVolatile = true;
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

const VOLATILE_NAMES = new Set(['RAND', 'RANDBETWEEN', 'TODAY', 'NOW']);

export { cellsInRange, formatNumberForText };
