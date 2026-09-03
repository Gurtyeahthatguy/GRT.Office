/** Tokens to a syntax tree. */

import { tokenize, TOKEN } from './tokenizer.js';
import { parseRef } from '../references.js';

export const NODE = {
  number: 'number',
  string: 'string',
  boolean: 'boolean',
  error: 'error',
  ref: 'ref',
  range: 'range',
  name: 'name',
  call: 'call',
  binary: 'binary',
  unary: 'unary',
  percent: 'percent',
};

class Failure extends Error {}

/**
 * @param {string} text
 * @returns {{ast: ?Object, error: ?string}}
 */
export function parse(text) {
  const { tokens, error } = tokenize(text);
  if (error) return { ast: null, error };
  if (tokens.length === 0) return { ast: null, error: 'Empty formula' };

  const state = { tokens, i: 0 };

  try {
    const ast = comparison(state);
    if (state.i < tokens.length) throw new Failure('Unexpected trailing input');
    return { ast, error: null };
  } catch (failure) {
    if (failure instanceof Failure) return { ast: null, error: failure.message };
    throw failure;
  }
}

// The grammar

const peek = (state) => state.tokens[state.i];
const next = (state) => state.tokens[state.i++];

function expect(state, type, what) {
  const token = next(state);
  if (!token || token.type !== type) throw new Failure(`Expected ${what}`);
  return token;
}

function operatorAhead(state, values) {
  const token = peek(state);
  return token && token.type === TOKEN.operator && values.includes(token.value);
}

function binaryLevel(state, operators, below) {
  let left = below(state);
  while (operatorAhead(state, operators)) {
    const { value } = next(state);
    const right = below(state);
    left = { type: NODE.binary, op: value, left, right };
  }
  return left;
}

const comparison = (state) => binaryLevel(state, ['=', '<>', '<', '>', '<=', '>='], concat);
const concat = (state) => binaryLevel(state, ['&'], additive);
const additive = (state) => binaryLevel(state, ['+', '-'], multiplicative);
const multiplicative = (state) => binaryLevel(state, ['*', '/'], exponent);

/** `2^3^2` is `2^(3^2)`, right to left, as in every spreadsheet. */
function exponent(state) {
  const left = unary(state);
  if (!operatorAhead(state, ['^'])) return left;
  next(state);
  return { type: NODE.binary, op: '^', left, right: exponent(state) };
}

function unary(state) {
  if (operatorAhead(state, ['-', '+'])) {
    const { value } = next(state);
    return { type: NODE.unary, op: value, operand: unary(state) };
  }
  return percent(state);
}

function percent(state) {
  let node = primary(state);
  while (operatorAhead(state, ['%'])) {
    next(state);
    node = { type: NODE.percent, operand: node };
  }
  return node;
}

function primary(state) {
  const token = next(state);
  if (!token) throw new Failure('Formula ends too early');

  switch (token.type) {
    case TOKEN.number: return { type: NODE.number, value: token.value };
    case TOKEN.string: return { type: NODE.string, value: token.value };
    case TOKEN.boolean: return { type: NODE.boolean, value: token.value };
    case TOKEN.error: return { type: NODE.error, value: token.value };

    case TOKEN.open: {
      const inner = comparison(state);
      expect(state, TOKEN.close, 'a closing bracket');
      return inner;
    }

    case TOKEN.sheet: return afterSheet(state, token.value);

    case TOKEN.reference: return reference(state, token.value, null);

    case TOKEN.identifier: {
      if (peek(state)?.type === TOKEN.open) return call(state, token.value);
      return { type: NODE.name, name: token.value };
    }

    default:
      throw new Failure('Unexpected token');
  }
}

/** `Sheet2!A1` and `Sheet2!A1:B3`. */
function afterSheet(state, sheet) {
  const token = next(state);
  if (!token || token.type !== TOKEN.reference) {
    throw new Failure('Expected a reference after a sheet name');
  }
  return reference(state, token.value, sheet);
}

function reference(state, text, sheet) {
  const from = parseRef(text);
  if (!from) throw new Failure(`${text} is not a reference`);

  if (peek(state)?.type !== TOKEN.colon) {
    return { type: NODE.ref, ref: from, sheet };
  }

  next(state);
  const second = next(state);
  if (!second || second.type !== TOKEN.reference) {
    throw new Failure('Expected a reference after the colon');
  }

  const to = parseRef(second.value);
  if (!to) throw new Failure(`${second.value} is not a reference`);

  return { type: NODE.range, range: { from, to }, sheet };
}

function call(state, name) {
  expect(state, TOKEN.open, 'an opening bracket');

  const args = [];
  if (peek(state)?.type === TOKEN.close) {
    next(state);
    return { type: NODE.call, name, args };
  }

  for (;;) {
    args.push(comparison(state));
    const token = next(state);
    if (!token) throw new Failure('A function call was never closed');
    if (token.type === TOKEN.close) break;
    if (token.type !== TOKEN.separator) throw new Failure('Expected a comma or a bracket');
  }

  return { type: NODE.call, name, args };
}

// Walking a tree

/** Calls `visit` on every node, depth first. */
export function walk(node, visit) {
  if (!node) return;
  visit(node);
  switch (node.type) {
    case NODE.binary: walk(node.left, visit); walk(node.right, visit); break;
    case NODE.unary: walk(node.operand, visit); break;
    case NODE.percent: walk(node.operand, visit); break;
    case NODE.call: for (const arg of node.args) walk(arg, visit); break;
    default: break;
  }
}

/** Rebuilds a tree with every node passed through `change`. */
export function transform(node, change) {
  if (!node) return node;

  const changed = change(node) ?? node;

  switch (changed.type) {
    case NODE.binary:
      return {
        ...changed,
        left: transform(changed.left, change),
        right: transform(changed.right, change),
      };
    case NODE.unary:
    case NODE.percent:
      return { ...changed, operand: transform(changed.operand, change) };
    case NODE.call:
      return { ...changed, args: changed.args.map((arg) => transform(arg, change)) };
    default:
      return changed;
  }
}
