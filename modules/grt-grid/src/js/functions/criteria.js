/** The conditions COUNTIF and its family take: `">5"`, `"<>x"`, `"ap*"`, or a plain value. */

import { isError, compare } from '../engine/values.js';

const ONE = { one: true };
const ANY = { any: true };

/** A pattern of `*`, `?` and `~`, as LibreOffice and Excel read it, as characters, ONE for `?` and ANY for `*`. */
function tokens(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '~' && i + 1 < text.length) {
      i += 1;
      out.push(text[i]);
    } else if (c === '*') {
      if (out.at(-1) !== ANY) out.push(ANY);
    } else out.push(c === '?' ? ONE : c);
  }
  return out;
}

const same = (a, b) => a === b || a.toLowerCase() === b.toLowerCase();
const fits = (token, unit) => token === ONE || (token !== ANY && same(token, unit));

/** Whether the units from a place on match the tokens to the end; only the last star is retried, so the work stays within their lengths multiplied. */
function matches(list, units, from = 0) {
  let i = from;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < units.length) {
    if (j < list.length && fits(list[j], units[i])) {
      i += 1;
      j += 1;
    } else if (list[j] === ANY) {
      star = j;
      j += 1;
      mark = i;
    } else if (star >= 0) {
      j = star + 1;
      mark += 1;
      i = mark;
    } else return false;
  }
  while (list[j] === ANY) j += 1;
  return j === list.length;
}

/** A text pattern with `*`, `?` and `~`, matched against a whole text without a regular expression, so no pattern can take long. */
export function wildcard(text) {
  const list = tokens(String(text));
  return { test: (value) => matches(list, String(value).split('')) };
}

/**
 * Where a pattern first matches the start of what follows, in a list of characters, or -1.
 * Past its first star the pattern is tried only once: a rest that fails from one place fails from every later one.
 */
export function wildcardFind(text, units) {
  const list = tokens(String(text));
  const lead = list.indexOf(ANY) === -1 ? list.length : list.indexOf(ANY);
  const rest = [...list.slice(lead), ANY];
  for (let k = 0; k + lead <= units.length; k += 1) {
    let j = 0;
    while (j < lead && fits(list[j], units[k + j])) j += 1;
    if (j < lead) continue;
    return lead === list.length || matches(rest, units, k + lead) ? k : -1;
  }
  return -1;
}

const hasWildcard = (text) => /[*?~]/.test(text);

/** A test for one value, or an error when the condition itself is one. */
export function criterion(raw) {
  if (isError(raw)) return raw;

  if (typeof raw === 'string') {
    const match = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(raw);
    const operator = match[1] ?? '=';
    const text = match[2];
    const numeric = text.trim() !== '' && Number.isFinite(Number(text));
    const wanted = text === '' ? null : numeric ? Number(text) : text;

    if (!numeric && text !== '' && (operator === '=' || operator === '<>') && hasWildcard(text)) {
      const pattern = wildcard(text);
      return (value) => {
        const hit = typeof value === 'string' && !isError(value) && pattern.test(value);
        return operator === '=' ? hit : !hit;
      };
    }

    return (value) => {
      // An empty condition matches empty cells; "<>" matches the cells that are not.
      if (wanted === null) {
        const empty = value === null || value === undefined || value === '';
        return operator === '<>' ? !empty : operator === '=' ? empty : false;
      }
      if (typeof wanted === 'number' && typeof value !== 'number') {
        const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
        if (!Number.isFinite(parsed)) return operator === '<>';
        value = parsed;
      }
      if (typeof wanted === 'string' && typeof value === 'number' && operator !== '=' && operator !== '<>') return false;
      const result = compare(value, wanted);
      if (isError(result)) return false;
      switch (operator) {
        case '<': return result < 0;
        case '<=': return result <= 0;
        case '>': return result > 0;
        case '>=': return result >= 0;
        case '<>': return result !== 0;
        default: return result === 0;
      }
    };
  }

  if (raw === null || raw === undefined) return (value) => value === null || value === undefined || value === '' || value === 0;
  return (value) => compare(value, raw) === 0;
}
