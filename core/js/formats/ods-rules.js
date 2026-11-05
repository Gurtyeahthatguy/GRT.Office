/** Conditional formats and validity rules as LibreOffice keeps them in a spreadsheet. */

import { NS, kids, kid, attr, tag } from '../xml.js';
import { fromOpenFormula, toOpenFormula } from './formulas.js';
import { odfArea } from './sheet-print.js';

/** An OpenFormula expression without its namespace, for inside a condition. */
const bare = (formula) => toOpenFormula(String(formula ?? '').startsWith('=') ? formula : `=${formula}`).replace(/^of:=/, '');
/** An expression from a condition back to a Grid formula. */
const grid = (expression) => fromOpenFormula(`of:=${expression}`).formula ?? '=';

/** The arguments of `name(a,b)`, split at top-level commas. */
function argumentsOf(text) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if (!quoted && (c === '(' || c === '[')) depth += 1;
    if (!quoted && (c === ')' || c === ']')) depth -= 1;
    if (!quoted && depth === 0 && c === ',') {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out;
}

const unquote = (text) => (/^".*"$/s.test(text.trim()) ? text.trim().slice(1, -1).replace(/""/g, '"') : text.trim());

const COMPARISONS = [['>=', '>='], ['<=', '<='], ['!=', '<>'], ['=', '='], ['>', '>'], ['<', '<']];

/** One `calcext:condition` value to a Grid rule, or null. */
function readCondition(value) {
  const call = /^([a-z-]+)\((.*)\)$/s.exec(value);
  if (call) {
    const [, name, inner] = call;
    const args = argumentsOf(inner);
    switch (name) {
      case 'between': return { type: 'cell', op: 'between', values: args.map(grid) };
      case 'not-between': return { type: 'cell', op: 'not-between', values: args.map(grid) };
      case 'formula-is': return { type: 'formula', formula: grid(inner) };
      case 'contains-text': return { type: 'text', op: 'contains', value: unquote(inner) };
      case 'not-contains-text': return { type: 'text', op: 'not-contains', value: unquote(inner) };
      case 'begins-with': return { type: 'text', op: 'begins', value: unquote(inner) };
      case 'ends-with': return { type: 'text', op: 'ends', value: unquote(inner) };
      case 'top-elements': return { type: 'top', count: Number(inner) };
      case 'bottom-elements': return { type: 'top', count: Number(inner), bottom: true };
      case 'top-percent': return { type: 'top', count: Number(inner), percent: true };
      case 'bottom-percent': return { type: 'top', count: Number(inner), percent: true, bottom: true };
      default: return null;
    }
  }
  const simple = {
    duplicate: { type: 'duplicate' }, unique: { type: 'unique' }, 'is-error': { type: 'error' }, 'is-no-error': { type: 'error', op: 'not' },
    'above-average': { type: 'average' }, 'below-average': { type: 'average', below: true },
    'above-equal-average': { type: 'average', equal: true }, 'below-equal-average': { type: 'average', below: true, equal: true },
  }[value];
  if (simple) return { ...simple };
  for (const [symbol, op] of COMPARISONS) {
    if (value.startsWith(symbol)) return { type: 'cell', op, values: [grid(value.slice(symbol.length))] };
  }
  return null;
}

/** A Grid rule to a `calcext:condition` value, or null for scales and bars. */
function writeCondition(rule) {
  const back = { '=': '=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
  const area = rule.area;
  const top = `[.${String.fromCharCode(65)}1]`;
  switch (rule.type) {
    case 'cell':
      if (rule.op === 'between' || rule.op === 'not-between') return `${rule.op}(${(rule.values ?? []).map(bare).join(',')})`;
      return `${back[rule.op] ?? '='}${bare(rule.values?.[0] ?? '0')}`;
    case 'formula': return `formula-is(${bare(rule.formula)})`;
    case 'text': {
      const name = { contains: 'contains-text', 'not-contains': 'not-contains-text', begins: 'begins-with', ends: 'ends-with' }[rule.op ?? 'contains'];
      return `${name}("${String(rule.value ?? '').replace(/"/g, '""')}")`;
    }
    case 'duplicate': return 'duplicate';
    case 'unique': return 'unique';
    case 'error': return rule.op === 'not' ? 'is-no-error' : 'is-error';
    case 'blank': {
      const cell = `[.${columnName(area.left)}${area.top + 1}]`;
      return `formula-is(LEN(TRIM(${cell}))${rule.op === 'not' ? '>' : '='}0)`;
    }
    case 'top': return `${rule.bottom ? 'bottom' : 'top'}-${rule.percent ? 'percent' : 'elements'}(${rule.count})`;
    case 'average': return `${rule.below ? 'below' : 'above'}${rule.equal ? '-equal' : ''}-average`;
    default: return top && null;
  }
}

function columnName(index) {
  let name = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
}

const POINT_TYPES = { minimum: 'min', maximum: 'max', number: 'number', percent: 'percent', percentile: 'percentile', 'auto-minimum': 'min', 'auto-maximum': 'max' };
const POINT_TYPES_BACK = { min: 'minimum', max: 'maximum', number: 'number', percent: 'percent', percentile: 'percentile' };

/**
 * The conditional formats of a table.
 * @param {Element} table
 * @param {(name: string) => Object} lookOf the look of a named cell style
 * @param {(text: string) => ?{area: Object}} addressOf
 */
export function readOdsConditions(table, lookOf, addressOf, losses) {
  const out = [];
  for (const holder of kids(table, NS.calcext, 'conditional-formats')) {
    for (const format of kids(holder, NS.calcext, 'conditional-format')) {
      const areas = String(attr(format, NS.calcext, 'target-range-address') ?? '').split(' ').map(addressOf).filter(Boolean).map((a) => a.area);
      for (const child of kids(format)) {
        let rule = null;
        if (child.localName === 'condition') {
          rule = readCondition(attr(child, NS.calcext, 'value') ?? '');
          if (rule) rule.style = lookOf(attr(child, NS.calcext, 'apply-style-name') ?? '');
        } else if (child.localName === 'color-scale') {
          const entries = kids(child, NS.calcext, 'color-scale-entry');
          rule = {
            type: 'scale',
            points: entries.map((e) => ({ type: POINT_TYPES[attr(e, NS.calcext, 'type')] ?? 'min', value: attr(e, NS.calcext, 'value') ?? '0' })),
            colors: entries.map((e) => attr(e, NS.calcext, 'color') ?? '#ffffff'),
          };
        } else if (child.localName === 'data-bar') {
          rule = {
            type: 'bar', color: attr(child, NS.calcext, 'positive-color') ?? '#638ec6',
            points: kids(child, NS.calcext, 'formatting-entry').map((e) => ({ type: POINT_TYPES[attr(e, NS.calcext, 'type')] ?? 'min', value: attr(e, NS.calcext, 'value') ?? '0' })),
          };
        } else if (child.localName === 'icon-set') losses.add('Icon sets and other conditional formats GRT Grid does not draw, left out');
        if (!rule) continue;
        for (const area of areas) out.push({ ...structuredClone(rule), area });
      }
    }
  }
  return out;
}

/** The conditional formats of a sheet, with the named styles they apply registered through `styleFor`. */
export function writeOdsConditions(sheetName, conditions, styleFor) {
  if (!conditions?.length) return null;
  return tag('calcext:conditional-formats', {}, conditions.map((rule) => {
    const target = odfArea(sheetName, rule.area);
    const base = target.split(':')[0];
    let content;
    if (rule.type === 'scale') {
      content = tag('calcext:color-scale', {}, rule.points.map((p, i) => tag('calcext:color-scale-entry', {
        'calcext:value': String(p.value ?? 0), 'calcext:type': POINT_TYPES_BACK[p.type] ?? 'minimum', 'calcext:color': rule.colors[i],
      })));
    } else if (rule.type === 'bar') {
      content = tag('calcext:data-bar', { 'calcext:positive-color': rule.color ?? '#638ec6', 'calcext:negative-color': '#ff0000', 'calcext:axis-position': 'none' },
        (rule.points ?? [{ type: 'min' }, { type: 'max' }]).map((p) => tag('calcext:formatting-entry', {
          'calcext:value': String(p.value ?? 0), 'calcext:type': POINT_TYPES_BACK[p.type] ?? 'minimum',
        })));
    } else {
      const value = writeCondition(rule);
      if (!value) return null;
      content = tag('calcext:condition', { 'calcext:apply-style-name': styleFor(rule.style ?? {}), 'calcext:value': value, 'calcext:base-cell-address': base });
    }
    return tag('calcext:conditional-format', { 'calcext:target-range-address': target }, content);
  }));
}

const KINDS = {
  'cell-content-is-whole-number()': 'whole', 'cell-content-is-decimal-number()': 'decimal',
  'cell-content-is-date()': 'date', 'cell-content-is-time()': 'time',
};

/** The rule a `table:content-validation` sets, by its name; the cells that use it are found while reading them. */
export function readOdsValidations(body) {
  const rules = new Map();
  for (const node of kids(kid(body, NS.table, 'content-validations'), NS.table, 'content-validation')) {
    const name = attr(node, NS.table, 'name');
    const condition = String(attr(node, NS.table, 'condition') ?? '').replace(/^of:/, '');
    const rule = { allowBlank: attr(node, NS.table, 'allow-empty-cell') !== 'false' };
    const list = /^cell-content-is-in-list\((.*)\)$/s.exec(condition);
    const custom = /^is-true-formula\((.*)\)$/s.exec(condition);
    const length = /^cell-content-text-length(?:-is-(between|not-between)\((.*)\)|\(\)\s*(>=|<=|!=|=|>|<)(.*))$/s.exec(condition);
    const typed = /^(cell-content-is-[a-z-]+\(\)) and (.*)$/s.exec(condition);
    if (list) {
      const items = argumentsOf(list[1].replace(/;/g, ','));
      if (items.every((item) => /^\s*".*"\s*$/s.test(item))) rule.list = items.map(unquote);
      else rule.source = grid(list[1]);
      rule.type = 'list';
      if (attr(node, NS.table, 'display-list') === 'no') rule.dropdown = false;
    } else if (custom) {
      Object.assign(rule, { type: 'custom', formula: grid(custom[1]) });
    } else if (length) {
      Object.assign(rule, { type: 'length', ...comparisonOf(length[1], length[2], length[3], length[4]) });
    } else if (typed && KINDS[typed[1]]) {
      const second = /^cell-content(?:-is-(between|not-between)\((.*)\)|\(\)\s*(>=|<=|!=|=|>|<)(.*))$/s.exec(typed[2]);
      if (!second) continue;
      Object.assign(rule, { type: KINDS[typed[1]], ...comparisonOf(second[1], second[2], second[3], second[4]) });
    } else continue;
    const error = kid(node, NS.table, 'error-message');
    rule.error = error && attr(error, NS.table, 'display') !== 'false'
      ? { style: { warning: 'warning', information: 'info' }[attr(error, NS.table, 'message-type')] ?? 'stop', title: attr(error, NS.table, 'title') ?? '', message: textOf(error) }
      : { style: 'info' };
    const help = kid(node, NS.table, 'help-message');
    if (help && attr(help, NS.table, 'display') === 'true') rule.input = { title: attr(help, NS.table, 'title') ?? '', message: textOf(help) };
    rules.set(name, rule);
  }
  return rules;
}

function comparisonOf(range, args, symbol, value) {
  if (range) return { op: range, values: argumentsOf(args.replace(/;/g, ',')).map(grid) };
  const op = Object.fromEntries(COMPARISONS)[symbol] ?? '=';
  return { op, values: [grid(value)] };
}

const textOf = (node) => kids(node, NS.text, 'p').map((p) => p.textContent).join('\n');

/** A rule's condition as OpenFormula keeps it. */
function validationCondition(rule) {
  const back = { '=': '=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
  const compareText = (subject) => (rule.op === 'between' || rule.op === 'not-between'
    ? `${subject}-is-${rule.op}(${(rule.values ?? []).map(bare).join(',')})`
    : `${subject}()${back[rule.op] ?? '='}${bare(rule.values?.[0] ?? '0')}`);
  switch (rule.type) {
    case 'list': return `of:cell-content-is-in-list(${rule.list ? rule.list.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';') : bare(rule.source)})`;
    case 'custom': return `of:is-true-formula(${bare(rule.formula)})`;
    case 'length': return `of:${compareText('cell-content-text-length')}`;
    default: {
      const kind = Object.entries(KINDS).find(([, k]) => k === rule.type)?.[0] ?? 'cell-content-is-decimal-number()';
      return `of:${kind} and ${compareText('cell-content')}`;
    }
  }
}

/** The validations of every sheet, each with the name its cells refer to. */
export function writeOdsValidations(sheets) {
  const elements = [];
  const names = sheets.map((sheet) => (sheet.validations ?? []).map((rule) => {
    const name = `val${elements.length + 1}`;
    const error = rule.error ?? { style: 'stop' };
    elements.push(tag('table:content-validation', {
      'table:name': name, 'table:condition': validationCondition(rule),
      'table:allow-empty-cell': rule.allowBlank === false ? 'false' : 'true',
      'table:display-list': rule.type === 'list' ? (rule.dropdown === false ? 'no' : 'unsorted') : null,
      'table:base-cell-address': odfArea(sheet.name ?? 'Sheet1', rule.area).split(':')[0],
    },
    rule.input ? tag('table:help-message', { 'table:title': rule.input.title || null, 'table:display': 'true' }, tag('text:p', {}, rule.input.message ?? '')) : null,
    tag('table:error-message', {
      'table:message-type': error.style === 'warning' ? 'warning' : error.style === 'info' ? 'information' : 'stop',
      'table:title': error.title || null, 'table:display': error.style === 'info' && !error.message ? 'false' : 'true',
    }, error.message ? tag('text:p', {}, error.message) : null)));
    return { name, area: rule.area };
  }));
  return { element: elements.length ? tag('table:content-validations', {}, elements) : null, names };
}
