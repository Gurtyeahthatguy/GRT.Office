/** Formatting that depends on a cell's value, and rules on what a cell accepts. */

import { parse, transform, NODE } from './parser/parser.js';
import { evaluate } from './engine/evaluate.js';
import { ERROR, isError, isBlank, toBoolean, compare, isMatrix } from './engine/values.js';
import { translate } from './references.js';

/** A formula a rule holds, parsed once; its relative references follow the cell it is tried on. */
function compile(text) {
  const { ast, error } = parse(String(text ?? '').startsWith('=') ? text : `=${text}`);
  return error ? null : ast;
}

/** The tree with its relative references moved by an offset, as a copy of the formula would have them. */
function shifted(ast, rows, cols) {
  if (rows === 0 && cols === 0) return ast;
  return transform(ast, (node) => {
    if (node.type === NODE.ref || node.type === NODE.spill) {
      const ref = translate(node.ref, rows, cols);
      return ref ? { ...node, ref } : { type: NODE.error, value: ERROR.ref };
    }
    if (node.type === NODE.range && !node.range.whole) {
      const from = translate(node.range.from, rows, cols);
      const to = translate(node.range.to, rows, cols);
      return from && to ? { ...node, range: { ...node.range, from, to } } : { type: NODE.error, value: ERROR.ref };
    }
    return node;
  });
}

const valueOf = (result) => (isMatrix(result) ? result.first : result);

/** A formula of a rule worked out for one cell of its area. */
function evaluateAt(ast, rule, row, col, engine, sheetId) {
  if (!ast) return ERROR.name;
  const tree = shifted(ast, row - rule.area.top, col - rule.area.left);
  return valueOf(evaluate(tree, engine.contextFor(sheetId, row, col)));
}

const inside = (area, row, col) => row >= area.top && row <= area.bottom && col >= area.left && col <= area.right;

/** Whether a value meets a comparison with one or two bounds. */
function meets(value, op, first, second) {
  if (isError(value)) return false;
  const c1 = compare(value, first);
  if (isError(c1)) return false;
  switch (op) {
    case '=': return c1 === 0;
    case '<>': return c1 !== 0;
    case '<': return c1 < 0;
    case '<=': return c1 <= 0;
    case '>': return c1 > 0;
    case '>=': return c1 >= 0;
    case 'between': case 'not-between': {
      let [low, high] = [first, second];
      if (compare(low, high) > 0) [low, high] = [high, low];
      const within = compare(value, low) >= 0 && compare(value, high) <= 0;
      return op === 'between' ? within : !within;
    }
    default: return false;
  }
}

/** A colour between two, as a scale puts it. */
function mix(a, b, t) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) || 0);
  const [x, y] = [parse(a), parse(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** The numbers in a rule's area, for scales, bars, top values and averages. */
function numbersIn(sheet, area) {
  const out = [];
  for (let r = area.top; r <= area.bottom; r += 1) {
    for (let c = area.left; c <= area.right; c += 1) {
      const v = sheet.valueAt(r, c);
      if (typeof v === 'number') out.push(v);
    }
  }
  return out;
}

/** Where a scale or bar point sits: the lowest, the highest, a number, a percent or a percentile. */
function pointValue(point, numbers, sorted) {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  switch (point?.type) {
    case 'number': return Number(point.value);
    case 'percent': return min + (max - min) * Number(point.value) / 100;
    case 'percentile': {
      const at = (Number(point.value) / 100) * (sorted.length - 1);
      const low = Math.floor(at);
      return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
    }
    case 'max': return max;
    default: return min;
  }
}

/** What a rule needs once per redraw: compiled formulas and the statistics of its area. */
function prepare(rule, sheet) {
  const prepared = { rule };
  if (rule.type === 'cell') prepared.bounds = (rule.values ?? []).map(compile);
  if (rule.type === 'formula') prepared.formula = compile(rule.formula);
  if (['scale', 'bar', 'top', 'average', 'duplicate', 'unique'].includes(rule.type)) {
    const numbers = numbersIn(sheet, rule.area);
    prepared.sorted = [...numbers].sort((a, b) => a - b);
    prepared.mean = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
    if (rule.type === 'duplicate' || rule.type === 'unique') {
      prepared.counts = new Map();
      for (let r = rule.area.top; r <= rule.area.bottom; r += 1) {
        for (let c = rule.area.left; c <= rule.area.right; c += 1) {
          const v = sheet.valueAt(r, c);
          if (isBlank(v)) continue;
          const k = typeof v === 'string' ? v.toLowerCase() : v;
          prepared.counts.set(k, (prepared.counts.get(k) ?? 0) + 1);
        }
      }
    }
  }
  return prepared;
}

/** The look one rule gives a cell, or null when it does not apply. */
function lookOf(prepared, row, col, sheet, engine) {
  const { rule } = prepared;
  const value = sheet.valueAt(row, col);
  switch (rule.type) {
    case 'cell': {
      if (isBlank(value) && rule.op !== '=' && rule.op !== '<>') return null;
      const [a, b] = prepared.bounds.map((ast) => evaluateAt(ast, rule, row, col, engine, sheet.id));
      return meets(value, rule.op, a, b) ? rule.style : null;
    }
    case 'formula': {
      const result = toBoolean(evaluateAt(prepared.formula, rule, row, col, engine, sheet.id));
      return result === true ? rule.style : null;
    }
    case 'text': {
      if (typeof value !== 'string') return null;
      const text = String(rule.value ?? '').toLowerCase();
      const v = value.toLowerCase();
      const hit = { contains: v.includes(text), 'not-contains': !v.includes(text), begins: v.startsWith(text), ends: v.endsWith(text) }[rule.op ?? 'contains'];
      return hit ? rule.style : null;
    }
    case 'blank': return isBlank(value) === (rule.op !== 'not') ? rule.style : null;
    case 'error': return isError(value) === (rule.op !== 'not') ? rule.style : null;
    case 'duplicate':
    case 'unique': {
      if (isBlank(value)) return null;
      const count = prepared.counts.get(typeof value === 'string' ? value.toLowerCase() : value) ?? 0;
      return (rule.type === 'duplicate' ? count > 1 : count === 1) ? rule.style : null;
    }
    case 'top': {
      if (typeof value !== 'number' || prepared.sorted.length === 0) return null;
      const { sorted } = prepared;
      const n = rule.percent ? Math.max(1, Math.floor(sorted.length * rule.count / 100)) : rule.count;
      const limit = rule.bottom ? sorted[Math.min(n, sorted.length) - 1] : sorted[Math.max(0, sorted.length - n)];
      return (rule.bottom ? value <= limit : value >= limit) ? rule.style : null;
    }
    case 'average': {
      if (typeof value !== 'number') return null;
      const hit = rule.below ? (rule.equal ? value <= prepared.mean : value < prepared.mean) : (rule.equal ? value >= prepared.mean : value > prepared.mean);
      return hit ? rule.style : null;
    }
    case 'scale': {
      if (typeof value !== 'number' || prepared.sorted.length === 0) return null;
      const points = rule.points.map((p) => pointValue(p, null, prepared.sorted));
      const colors = rule.colors;
      if (colors.length === 3) {
        if (value <= points[1]) return { bg: mix(colors[0], colors[1], ratio(value, points[0], points[1])) };
        return { bg: mix(colors[1], colors[2], ratio(value, points[1], points[2])) };
      }
      return { bg: mix(colors[0], colors[1], ratio(value, points[0], points[1])) };
    }
    case 'bar': {
      if (typeof value !== 'number' || prepared.sorted.length === 0) return null;
      const low = pointValue(rule.points?.[0] ?? { type: 'min' }, null, prepared.sorted);
      const high = pointValue(rule.points?.[1] ?? { type: 'max' }, null, prepared.sorted);
      return { bar: { color: rule.color ?? '#638ec6', fraction: Math.max(0, Math.min(1, ratio(value, Math.min(low, 0), high))) } };
    }
    default: return null;
  }
}

const ratio = (v, low, high) => (high === low ? 1 : Math.max(0, Math.min(1, (v - low) / (high - low))));

/**
 * The look conditional formatting gives cells, worked out once per redraw.
 * The first rule that applies wins unless the rule says the next ones may add to it.
 */
export class ConditionalLooks {
  constructor(sheet, engine) {
    this.sheet = sheet;
    this.engine = engine;
    this.prepared = sheet.conditions.map((rule) => prepare(rule, sheet));
  }

  at(row, col) {
    let look = null;
    for (const prepared of this.prepared) {
      if (!inside(prepared.rule.area, row, col)) continue;
      const found = lookOf(prepared, row, col, this.sheet, this.engine);
      if (!found) continue;
      look = { ...(found ?? {}), ...(look ?? {}) };
      if (prepared.rule.stop !== false) break;
    }
    return look;
  }
}

/** Whether a value is one a validation rule accepts; the reason when it is not. */
export function validate(rule, value, row, col, sheet, engine) {
  if (isBlank(value)) return rule.allowBlank === false ? { ok: false } : { ok: true };
  const bound = (i) => {
    const ast = compile(rule.values?.[i] ?? '');
    return ast ? evaluateAt(ast, rule, row, col, engine, sheet.id) : null;
  };
  switch (rule.type) {
    case 'list': {
      const options = listOptions(rule, sheet, engine);
      return { ok: options.some((option) => compare(option, value) === 0) };
    }
    case 'whole':
      if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false };
      return { ok: meets(value, rule.op ?? 'between', bound(0), bound(1)) };
    case 'decimal':
    case 'date':
    case 'time':
      if (typeof value !== 'number') return { ok: false };
      return { ok: meets(value, rule.op ?? 'between', bound(0), bound(1)) };
    case 'length':
      return { ok: meets(String(value).length, rule.op ?? 'between', bound(0), bound(1)) };
    case 'custom': {
      const ast = compile(rule.formula);
      return { ok: toBoolean(evaluateAt(ast, rule, row, col, engine, sheet.id)) === true };
    }
    default: return { ok: true };
  }
}

/** The choices a list rule offers: typed in, or read from a range. */
export function listOptions(rule, sheet, engine) {
  if (Array.isArray(rule.list)) return rule.list;
  const ast = compile(rule.source ?? '');
  if (!ast) return [];
  const result = evaluate(ast, engine.contextFor(sheet.id, rule.area.top, rule.area.left));
  const values = isMatrix(result) ? result.flat : [result];
  return values.filter((v) => !isBlank(v) && !isError(v));
}

/** The rule that covers a cell, if any. */
export const validationAt = (sheet, row, col) => sheet.validations.find((rule) => inside(rule.area, row, col)) ?? null;
