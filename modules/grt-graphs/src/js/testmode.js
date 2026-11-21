/**
 * Test mode: a dialogue tree or a state machine walked by choosing answers.
 * A connector's `if` is a condition and a node's or connector's `set` gives values, both worked out by Grid's formulas,
 * which only calculate: nothing in a diagram can run anything.
 */

import { parse } from './parser/parser.js';
import { evaluate } from './engine/evaluate.js';
import { ERROR, isError } from './engine/values.js';

const MAX_STEPS = 10000;
const MAX_PATHS = 2000;
const CELL_LIKE = /^[A-Za-z]{1,3}\d+$/;

/** A value as a formula sees it, worked out with the variables so far; a mistake comes back as an error value. */
export function calculate(text, variables) {
  const source = String(text ?? '').trim().replace(/^=/, '');
  if (!source) return null;
  const { ast, error } = parse(source);
  if (error || !ast) return ERROR.value;
  try {
    return evaluate(ast, { valueAt: () => ERROR.ref, sheetIdFor: () => null, sheetId: 'test', scope: new Map([...variables].map(([k, v]) => [k.toUpperCase(), v])) });
  } catch {
    return ERROR.value;
  }
}

/** `score = score + 1; name = "Ada"` as its assignments, each a name and a formula; quotes keep their semicolons. */
export function assignments(text) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const ch of String(text ?? '')) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) { out.push(current); current = ''; } else current += ch;
  }
  out.push(current);
  return out.map((part) => /^\s*([A-Za-z_][\w.]*)\s*=(?!=)\s*(.+?)\s*$/.exec(part)).filter(Boolean)
    .filter((m) => !CELL_LIKE.test(m[1])).map((m) => ({ name: m[1].toUpperCase(), formula: m[2] }));
}

/** The variables after a `set`: each assignment worked out in turn, so a later one sees an earlier one's value. */
export function applySet(text, variables) {
  const next = new Map(variables);
  for (const { name, formula } of assignments(text)) {
    const value = calculate(formula, next);
    next.set(name, value && typeof value === 'object' && 'first' in value ? value.first : value);
  }
  return next;
}

const truthy = (value) => value === true || (typeof value === 'number' && value !== 0) || (typeof value === 'string' && /^true$/i.test(value));

/** Where a walk starts: the node chosen, else one marked `start`, else the first nothing points at. */
export function startNode(model, chosen = null) {
  if (chosen && model.node(chosen)) return chosen;
  const marked = model.nodes.find((n) => n.data?.start !== undefined && n.data.start !== '' && n.data.start !== 'false');
  if (marked) return marked.id;
  const pointed = new Set(model.edges.map((e) => e.to));
  return (model.nodes.find((n) => !pointed.has(n.id)) ?? model.nodes[0])?.id ?? null;
}

/** The answers open at a node: its connectors whose condition holds, each with what it reads. */
export function choicesAt(model, nodeId, variables) {
  return model.edges.filter((e) => e.from === nodeId && model.node(e.to)).map((e) => {
    const condition = e.data?.if;
    const value = condition ? calculate(condition, variables) : true;
    return { edge: e, label: e.label || model.node(e.to).text || '(no words)', open: !isError(value) && truthy(value), error: isError(value) ? value : null };
  });
}

/** Arriving somewhere: the node's own `set` worked out. */
export const arrive = (model, nodeId, variables) => applySet(model.node(nodeId)?.data?.set, variables);

/** Taking an answer: the connector's `set`, then the node it leads to. */
export function take(model, edge, variables) {
  return { node: edge.to, variables: arrive(model, edge.to, applySet(edge.data?.set, variables)) };
}

/**
 * Every way through, each choice taken in turn: the endings reached, where a walk gets stuck with answers but none open,
 * conditions that are mistakes, and loops, which are followed once round.
 */
export function explore(model, start) {
  const report = { endings: new Map(), stuck: new Map(), mistakes: new Set(), loops: 0, paths: 0, cut: false };
  if (!start) return report;
  let steps = 0;
  const walk = (nodeId, variables, seen) => {
    if (report.paths >= MAX_PATHS || (steps += 1) > MAX_STEPS) { report.cut = true; return; }
    const choices = choicesAt(model, nodeId, variables);
    for (const c of choices) if (c.error) report.mistakes.add(c.edge.id);
    const open = choices.filter((c) => c.open);
    if (!choices.length) { report.paths += 1; report.endings.set(nodeId, (report.endings.get(nodeId) ?? 0) + 1); return; }
    if (!open.length) { report.paths += 1; report.stuck.set(nodeId, (report.stuck.get(nodeId) ?? 0) + 1); return; }
    for (const c of open) {
      const key = `${c.edge.to}`;
      if (seen.has(key)) { report.loops += 1; report.paths += 1; continue; }
      const next = take(model, c.edge, variables);
      walk(next.node, next.variables, new Set([...seen, key]));
    }
  };
  walk(start, arrive(model, start, new Map()), new Set([start]));
  return report;
}
