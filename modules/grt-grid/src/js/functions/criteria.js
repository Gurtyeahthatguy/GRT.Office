/** The conditions COUNTIF and its family take: `">5"`, `"<>x"`, `"ap*"`, or a plain value. */

import { isError, compare } from '../engine/values.js';

/** A text pattern with `*`, `?` and `~`, as LibreOffice and Excel read them, to a regular expression. */
export function wildcard(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '~' && i + 1 < text.length) {
      i += 1;
      out += text[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '*') out += '[\\s\\S]*';
    else if (c === '?') out += '[\\s\\S]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
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
