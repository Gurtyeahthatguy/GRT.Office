/** Views over the notes, as Obsidian's Bases keep them in .base files: filters, formulas, sorting, tables and cards. */

import { readProperties } from './core/formats/obsidian.js';

// A small YAML: maps, lists, inline lists, quoted and plain scalars, which is what .base files hold.

const MAX_LINES = 5000;

function scalar(text) {
  const value = text.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (/^"(.*)"$/s.test(value)) return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  if (/^'(.*)'$/s.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\[.*\]$/.test(value)) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : splitTop(inner).map(scalar);
  }
  return value;
}

/** Splits on commas that are not inside quotes or brackets. */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current);
  return out;
}

/** A .base file's YAML as an object. */
export function parseYaml(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_LINES)
    .map((raw) => ({ indent: /^ */.exec(raw)[0].length, text: raw.replace(/\s+#.*$/, '').trimEnd() }))
    .filter((line) => line.text.trim() !== '' && !line.text.trim().startsWith('#'));
  let i = 0;
  const block = (indent) => {
    if (i >= lines.length) return null;
    if (lines[i].text.trim().startsWith('- ') || lines[i].text.trim() === '-') {
      const list = [];
      const at = lines[i].indent;
      while (i < lines.length && lines[i].indent === at && /^-(\s|$)/.test(lines[i].text.trim())) {
        const rest = lines[i].text.trim().slice(1).trim();
        if (rest === '') {
          i += 1;
          list.push(block(at + 1));
        } else if (/^[^"'[{][^:]*:(\s|$)/.test(rest) && !/^https?:/.test(rest)) {
          // A map that starts on the dash's line: its first key there, the rest indented below.
          lines[i] = { indent: at + 2, text: `${' '.repeat(at + 2)}${rest}` };
          list.push(map(at + 2));
        } else {
          list.push(scalar(rest));
          i += 1;
        }
      }
      return list;
    }
    return map(lines[i].indent >= indent ? lines[i].indent : indent);
  };
  const map = (at) => {
    const out = {};
    while (i < lines.length && lines[i].indent === at && !/^-(\s|$)/.test(lines[i].text.trim())) {
      const match = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(lines[i].text);
      if (!match) { i += 1; continue; }
      const key = String(scalar(match[1]));
      i += 1;
      if (match[2] !== undefined && match[2] !== '') out[key] = scalar(match[2]);
      else if (i < lines.length && (lines[i].indent > at || (lines[i].indent === at && /^-(\s|$)/.test(lines[i].text.trim())))) out[key] = block(at + 1);
      else out[key] = null;
    }
    return out;
  };
  return lines.length ? block(0) ?? {} : {};
}

// Expressions: Obsidian's formula language, a small JavaScript.

const MAX_STEPS = 100000;

function tokenize(source) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(==|!=|>=|<=|&&|\|\||[-+*/%<>!().,[\]])|([A-Za-z_À-￿][\wÀ-￿]*))/y;
  let match;
  re.lastIndex = 0;
  while (re.lastIndex < source.length) {
    const at = re.lastIndex;
    match = re.exec(source);
    if (!match) {
      if (source.slice(at).trim() === '') break;
      throw new Error(`Cannot read the formula at “${source.slice(at, at + 12)}”`);
    }
    if (match[1]) tokens.push({ type: 'num', value: Number(match[1]) });
    else if (match[2]) tokens.push({ type: 'str', value: match[2].slice(1, -1).replace(/\\(.)/g, '$1') });
    else if (match[3]) tokens.push({ type: 'op', value: match[3] });
    else if (match[4]) tokens.push({ type: 'id', value: match[4] });
    if (tokens.length > 2000) throw new Error('The formula is too long');
  }
  return tokens;
}

const BINARY = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

/** An expression as a tree. */
export function parseExpression(source) {
  const tokens = tokenize(String(source ?? ''));
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (value) => {
    if (value !== undefined && peek()?.value !== value) throw new Error(`Expected ${value} in the formula`);
    return tokens[pos++];
  };
  let depth = 0;
  const primary = () => {
    if ((depth += 1) > 100) throw new Error('The formula is nested too deeply');
    const token = take();
    if (!token) throw new Error('The formula ends too soon');
    let node;
    if (token.type === 'num' || token.type === 'str') node = { type: 'lit', value: token.value };
    else if (token.value === '(') { node = expression(0); take(')'); }
    else if (token.value === '!' || token.value === '-') node = { type: 'unary', op: token.value, arg: primary() };
    else if (token.value === '[') {
      const items = [];
      while (peek()?.value !== ']') { items.push(expression(0)); if (peek()?.value === ',') take(','); }
      take(']');
      node = { type: 'list', items };
    } else if (token.type === 'id') {
      node = token.value === 'true' || token.value === 'false' ? { type: 'lit', value: token.value === 'true' }
        : token.value === 'null' ? { type: 'lit', value: null } : { type: 'name', name: token.value };
    } else throw new Error(`Unexpected ${token.value} in the formula`);
    // Members, calls and indexes after it.
    for (;;) {
      if (peek()?.value === '.') {
        take('.');
        node = { type: 'member', object: node, name: take().value };
      } else if (peek()?.value === '(') {
        take('(');
        const args = [];
        while (peek()?.value !== ')') { args.push(expression(0)); if (peek()?.value === ',') take(','); }
        take(')');
        node = { type: 'call', callee: node, args };
      } else if (peek()?.value === '[') {
        take('[');
        node = { type: 'index', object: node, index: expression(0) };
        take(']');
      } else break;
    }
    depth -= 1;
    return node;
  };
  const expression = (min) => {
    let left = primary();
    while (peek()?.type === 'op' && BINARY[peek().value] > min) {
      const op = take().value;
      left = { type: 'binary', op, left, right: expression(BINARY[op]) };
    }
    return left;
  };
  const tree = expression(0);
  if (pos < tokens.length) throw new Error(`Unexpected ${tokens[pos].value} in the formula`);
  return tree;
}

const DAY = 86400000;
const isDate = (v) => v instanceof Date;
/** A link value: an object with its target, never a string, whose own `link` is a function. */
const isLink = (v) => !!v && typeof v === 'object' && typeof v.link === 'string';
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));

/** A date and a duration such as "1d", "2 weeks" or "-3M". */
function shift(date, text) {
  const match = /^\s*(-?\d+)\s*(y|years?|M|months?|w|weeks?|d|days?|h|hours?|m|minutes?|s|seconds?)\s*$/.exec(String(text));
  if (!match) return null;
  const n = Number(match[1]);
  const out = new Date(date);
  const unit = match[2];
  if (/^y/.test(unit)) out.setFullYear(out.getFullYear() + n);
  else if (unit === 'M' || /^months?$/.test(unit)) out.setMonth(out.getMonth() + n);
  else if (/^w/.test(unit)) out.setDate(out.getDate() + 7 * n);
  else if (/^d/.test(unit)) out.setDate(out.getDate() + n);
  else if (/^h/.test(unit)) out.setHours(out.getHours() + n);
  else if (unit === 'm' || /^minutes?$/.test(unit)) out.setMinutes(out.getMinutes() + n);
  else out.setSeconds(out.getSeconds() + n);
  return out;
}

function compare(a, b) {
  if (isDate(a) && isDate(b)) return a - b;
  if (isDate(a) && typeof b === 'string') return a - new Date(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b))) return a - Number(b);
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
}

function equal(a, b) {
  if (isDate(a) || isDate(b)) return compare(a, b) === 0;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isLink(a) || isLink(b)) return String(isLink(a) ? a.link : a).toLowerCase() === String(isLink(b) ? b.link : b).toLowerCase();
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof b === 'number' && typeof a === 'string') return Number(a) === b;
  return (a ?? null) === (b ?? null);
}

const text = (v) => (v === null || v === undefined ? '' : isDate(v) ? v.toISOString().slice(0, 10) : Array.isArray(v) ? v.map(text).join(', ') : isLink(v) ? v.link : String(v));

/** The methods values answer to, by kind. */
function method(value, name, args, file) {
  const s = typeof value === 'string' ? value : null;
  const list = Array.isArray(value) ? value : null;
  const has = (needle) => (list ? list.some((v) => equal(v, needle) || (typeof v === 'string' && typeof needle === 'string' && v.toLowerCase() === needle.toLowerCase())) : String(value ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase()));
  switch (name) {
    case 'contains': return has(args[0]);
    case 'containsAll': return args.every(has);
    case 'containsAny': return args.some(has);
    case 'isEmpty': return !truthy(value) && value !== 0 && value !== false;
    case 'startsWith': return String(value ?? '').startsWith(String(args[0] ?? ''));
    case 'endsWith': return String(value ?? '').endsWith(String(args[0] ?? ''));
    case 'lower': return String(value ?? '').toLowerCase();
    case 'upper': return String(value ?? '').toUpperCase();
    case 'title': return String(value ?? '').replace(/\b\w/g, (c) => c.toUpperCase());
    case 'trim': return String(value ?? '').trim();
    case 'replace': return String(value ?? '').split(String(args[0] ?? '')).join(String(args[1] ?? ''));
    case 'split': return String(value ?? '').split(String(args[0] ?? ','));
    case 'slice': return (list ?? String(value ?? '')).slice(args[0], args[1]);
    case 'join': return (list ?? []).map(text).join(args[0] ?? ', ');
    case 'unique': return [...new Map((list ?? []).map((v) => [text(v), v])).values()];
    case 'sort': return [...(list ?? [])].sort(compare);
    case 'reverse': return [...(list ?? [])].reverse();
    case 'flat': return (list ?? []).flat();
    case 'toString': return text(value);
    case 'toFixed': return typeof value === 'number' ? value.toFixed(Math.max(0, Math.min(20, Number(args[0] ?? 0)))) : null;
    case 'abs': return typeof value === 'number' ? Math.abs(value) : null;
    case 'ceil': return typeof value === 'number' ? Math.ceil(value) : null;
    case 'floor': return typeof value === 'number' ? Math.floor(value) : null;
    case 'round': return typeof value === 'number' ? Number(value.toFixed(Math.max(0, Math.min(20, Number(args[0] ?? 0))))) : null;
    case 'format': return isDate(value) ? formatDateLike(value, String(args[0] ?? 'YYYY-MM-DD')) : text(value);
    case 'date': return isDate(value) ? new Date(value.getFullYear(), value.getMonth(), value.getDate()) : null;
    case 'relative': return isDate(value) ? `${Math.round((value - Date.now()) / DAY)}d` : null;
    // A file's own questions.
    case 'hasTag': return value === file && args.some((tag) => file.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase().replace(/^#/, '') || t.toLowerCase().startsWith(`${String(tag).toLowerCase().replace(/^#/, '')}/`)));
    case 'inFolder': {
      const folder = String(args[0] ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
      return value === file && (folder === '' || file.folder.toLowerCase() === folder || file.folder.toLowerCase().startsWith(`${folder}/`));
    }
    case 'hasLink': return value === file && file.links.some((l) => l.toLowerCase() === String(isLink(args[0]) ? args[0].link : args[0] ?? '').toLowerCase().replace(/\.md$/, ''));
    case 'hasProperty': return value === file && Object.hasOwn(file.properties, String(args[0]));
    case 'asLink': return value === file ? { link: file.basename } : null;
    default: return null;
  }
}

function formatDateLike(date, format) {
  const pad = (n) => String(n).padStart(2, '0');
  return format.replace(/YYYY|MM|DD|HH|mm/g, (t) => ({ YYYY: date.getFullYear(), MM: pad(date.getMonth() + 1), DD: pad(date.getDate()), HH: pad(date.getHours()), mm: pad(date.getMinutes()) }[t]));
}

const GLOBALS = {
  if: (args) => (truthy(args[0]) ? args[1] : args[2] ?? null),
  now: () => new Date(),
  today: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); },
  date: (args) => { const d = isDate(args[0]) ? args[0] : new Date(String(args[0] ?? '')); return Number.isNaN(d.getTime()) ? null : d; },
  number: (args) => { const n = Number(args[0]); return Number.isFinite(n) ? n : null; },
  list: (args) => (Array.isArray(args[0]) ? args[0] : args[0] === null || args[0] === undefined ? [] : [args[0]]),
  link: (args) => ({ link: String(args[0] ?? '') }),
  max: (args) => Math.max(...args.flat().filter((v) => typeof v === 'number')),
  min: (args) => Math.min(...args.flat().filter((v) => typeof v === 'number')),
};

/**
 * The value of an expression for one note.
 * @param {object} file the note: name, basename, path, folder, ext, size, ctime, mtime, tags, links, properties
 */
export function evaluate(tree, file, formulas = {}, budget = { steps: 0 }, seen = new Set()) {
  const run = (node) => {
    if ((budget.steps += 1) > MAX_STEPS) throw new Error('The formula takes too long');
    switch (node.type) {
      case 'lit': return node.value;
      case 'list': return node.items.map(run);
      case 'name':
        if (node.name === 'file') return file;
        if (node.name === 'note') return file.properties;
        if (node.name === 'formula') return { formulaRoot: true };
        return file.properties[node.name] ?? null;
      case 'member': {
        const object = run(node.object);
        if (object?.formulaRoot) {
          // A formula may use another, but not itself, however far round.
          if (seen.has(node.name) || !formulas[node.name]) return null;
          return evaluate(formulas[node.name], file, formulas, budget, new Set([...seen, node.name]));
        }
        if (object === file) {
          const field = { name: file.name, basename: file.basename, path: file.path, folder: file.folder, ext: file.ext, size: file.size, ctime: file.ctime, mtime: file.mtime, tags: file.tags, links: file.links.map((l) => ({ link: l })), properties: file.properties }[node.name];
          return field === undefined ? { method: node.name, of: file } : field;
        }
        if (object && typeof object === 'object' && !Array.isArray(object) && !isDate(object) && !isLink(object) && Object.hasOwn(object, node.name)) return object[node.name];
        if (node.name === 'length' && (typeof object === 'string' || Array.isArray(object))) return object.length;
        if (isDate(object) && ['year', 'month', 'day', 'hour', 'minute'].includes(node.name)) {
          return { year: object.getFullYear(), month: object.getMonth() + 1, day: object.getDate(), hour: object.getHours(), minute: object.getMinutes() }[node.name];
        }
        return { method: node.name, of: object };
      }
      case 'index': {
        const object = run(node.object);
        const index = run(node.index);
        return Array.isArray(object) ? object[index] ?? null : object && typeof object === 'object' ? object[index] ?? null : null;
      }
      case 'call': {
        const args = node.args.map(run);
        if (node.callee.type === 'name' && GLOBALS[node.callee.name]) return GLOBALS[node.callee.name](args);
        const callee = run(node.callee);
        return callee?.method ? method(callee.of, callee.method, args, file) : null;
      }
      case 'unary': {
        const v = run(node.arg);
        return node.op === '!' ? !truthy(v) : typeof v === 'number' ? -v : null;
      }
      case 'binary': {
        if (node.op === '&&') return truthy(run(node.left)) && truthy(run(node.right));
        if (node.op === '||') { const l = run(node.left); return truthy(l) ? l : run(node.right); }
        const a = run(node.left);
        const b = run(node.right);
        switch (node.op) {
          case '==': return equal(a, b);
          case '!=': return !equal(a, b);
          case '<': return a !== null && b !== null && compare(a, b) < 0;
          case '>': return a !== null && b !== null && compare(a, b) > 0;
          case '<=': return a !== null && b !== null && compare(a, b) <= 0;
          case '>=': return a !== null && b !== null && compare(a, b) >= 0;
          case '+':
            if (isDate(a) && typeof b === 'string') return shift(a, b);
            if (typeof a === 'number' && typeof b === 'number') return a + b;
            return text(a) + text(b);
          case '-':
            if (isDate(a) && typeof b === 'string') return shift(a, `-${b.replace(/^\s*-/, '')}`);
            if (isDate(a) && isDate(b)) return a - b;
            return typeof a === 'number' && typeof b === 'number' ? a - b : null;
          case '*': return typeof a === 'number' && typeof b === 'number' ? a * b : null;
          case '/': return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null;
          case '%': return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a % b : null;
          default: return null;
        }
      }
      default: return null;
    }
  };
  return run(tree);
}

/** A filter of a .base: a string expression, or `and`, `or`, `not` over a list of filters. */
function compileFilter(filter) {
  if (filter === null || filter === undefined) return () => true;
  if (typeof filter === 'string') {
    const tree = parseExpression(filter);
    return (file, formulas) => truthy(evaluate(tree, file, formulas));
  }
  if (Array.isArray(filter)) {
    const parts = filter.map(compileFilter);
    return (file, formulas) => parts.every((part) => part(file, formulas));
  }
  if (filter.and) { const parts = [].concat(filter.and).map(compileFilter); return (f, m) => parts.every((p) => p(f, m)); }
  if (filter.or) { const parts = [].concat(filter.or).map(compileFilter); return (f, m) => parts.some((p) => p(f, m)); }
  if (filter.not) { const parts = [].concat(filter.not).map(compileFilter); return (f, m) => !parts.some((p) => p(f, m)); }
  return () => true;
}

/** A property name of a view as an expression: `file.name`, `formula.total`, `status`. */
const propertyTree = (name) => parseExpression(/^[A-Za-z_][\w.]*$/.test(name) ? name : `note[${JSON.stringify(name)}]`);

/** What a note is to a view: its file facts, tags, links and properties, from its path and text. */
export function noteFacts(path, root, text, { modified = null } = {}) {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const name = relative.split('/').pop();
  const lines = String(text ?? '').split(/\r?\n/);
  const properties = {};
  let bodyStart = 0;
  if (lines[0] === '---') {
    const end = lines.findIndex((line, i) => i > 0 && (line === '---' || line === '...'));
    if (end > 0) {
      for (const property of readProperties(lines.slice(1, end))) {
        if (!property.key) continue;
        properties[property.key] = property.type === 'date' || property.type === 'datetime' ? new Date(property.value) : property.value;
      }
      bodyStart = end + 1;
    }
  }
  const body = lines.slice(bodyStart).join('\n').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const tags = new Set([].concat(properties.tags ?? properties.tag ?? []).map((t) => String(t).replace(/^#/, '')));
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) tags.add(match[1]);
  const links = [...new Set([...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim().replace(/\.md$/i, '')))];
  const when = modified ? new Date(modified * 1000) : null;
  return {
    path, name, basename: name.replace(/\.[^.]+$/, ''), ext: (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase(),
    folder: relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '',
    size: String(text ?? '').length, ctime: when, mtime: when, tags: [...tags], links, properties,
  };
}

/**
 * The rows of one view of a base, over the notes given.
 * @returns {{views: {name: string, type: string}[], view: object, columns: {key: string, label: string}[], groups: {key: string|null, rows: object[]}[], error?: string}}
 */
export function runBase(base, files, viewIndex = 0) {
  const views = Array.isArray(base?.views) && base.views.length ? base.views : [{ type: 'table', name: 'Table' }];
  const view = views[Math.max(0, Math.min(views.length - 1, viewIndex))] ?? views[0];
  const summary = views.map((v, i) => ({ name: String(v?.name ?? `View ${i + 1}`), type: v?.type === 'cards' ? 'cards' : 'table' }));
  try {
    const formulas = Object.fromEntries(Object.entries(base?.formulas ?? {}).map(([name, source]) => [name, parseExpression(String(source))]));
    const global = compileFilter(base?.filters);
    const local = compileFilter(view?.filters);
    const order = (Array.isArray(view?.order) && view.order.length ? view.order : ['file.name']).map(String);
    const displayName = (key) => base?.properties?.[key]?.displayName ?? key.replace(/^(note|formula)\./, '');
    const columns = order.map((key) => ({ key, label: String(displayName(key)), tree: propertyTree(key) }));
    let rows = files.filter((file) => global(file, formulas) && local(file, formulas)).map((file) => ({
      file, values: Object.fromEntries(columns.map((c) => [c.key, evaluate(c.tree, file, formulas)])),
    }));
    for (const rule of [].concat(view?.sort ?? []).reverse()) {
      const key = String(rule?.property ?? rule);
      const tree = propertyTree(key);
      const direction = String(rule?.direction ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
      const value = (row) => evaluate(tree, row.file, formulas);
      rows = rows.map((row) => ({ row, v: value(row) })).sort((a, b) => {
        if (a.v === null || a.v === undefined) return b.v === null || b.v === undefined ? 0 : 1;
        if (b.v === null || b.v === undefined) return -1;
        return direction * compare(a.v, b.v);
      }).map((x) => x.row);
    }
    if (Number(view?.limit) > 0) rows = rows.slice(0, Number(view.limit));
    let groups = [{ key: null, rows }];
    if (view?.groupBy) {
      const key = String(view.groupBy.property ?? view.groupBy);
      const tree = propertyTree(key);
      const map = new Map();
      for (const row of rows) {
        const g = text(evaluate(tree, row.file, formulas)) || '(none)';
        if (!map.has(g)) map.set(g, []);
        map.get(g).push(row);
      }
      const direction = String(view.groupBy.direction ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
      groups = [...map].sort((a, b) => direction * compare(a[0], b[0])).map(([g, r]) => ({ key: g, rows: r }));
    }
    return { views: summary, view: { ...summary[views.indexOf(view)], index: views.indexOf(view) }, columns: columns.map(({ key, label }) => ({ key, label })), groups };
  } catch (error) {
    return { views: summary, view: summary[0], columns: [], groups: [], error: error.message ?? String(error) };
  }
}

/** How a value shows in a cell. */
export const cellText = (value) => (value === true ? '✓' : value === false ? '' : text(value));
