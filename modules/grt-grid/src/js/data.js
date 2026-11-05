/** Working on a block of data: sorting, filtering, duplicates, splitting text, subtotals, series. */

import { compare, isError, isBlank } from './engine/values.js';
import { key } from './references.js';
import { formatValue } from './format.js';
import { criterion } from './functions/criteria.js';

/** The block of data around a cell: every row and column reached through cells that are not empty. */
export function currentRegion(sheet, row, col) {
  const filled = (r, c) => r >= 0 && c >= 0 && !isBlank(sheet.valueAt(r, c));
  let area = { top: row, left: col, bottom: row, right: col };
  for (let grown = true; grown;) {
    grown = false;
    const { top, left, bottom, right } = area;
    const scan = (r0, r1, c0, c1) => {
      for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) if (filled(r, c)) return true;
      return false;
    };
    if (top > 0 && scan(top - 1, top - 1, left - 1, right + 1)) { area = { ...area, top: top - 1 }; grown = true; }
    if (scan(bottom + 1, bottom + 1, left - 1, right + 1)) { area = { ...area, bottom: bottom + 1 }; grown = true; }
    if (left > 0 && scan(area.top, area.bottom, left - 1, left - 1)) { area = { ...area, left: left - 1 }; grown = true; }
    if (scan(area.top, area.bottom, right + 1, right + 1)) { area = { ...area, right: right + 1 }; grown = true; }
    if (area.bottom - area.top > 1_048_575 || area.right - area.left > 16_383) break;
  }
  return area;
}

/** Whether the first row reads as column names: text over at least one column that holds numbers below. */
export function looksLikeHeader(sheet, area) {
  if (area.bottom === area.top) return false;
  let text = 0;
  let numbersBelow = false;
  for (let c = area.left; c <= area.right; c += 1) {
    const first = sheet.valueAt(area.top, c);
    const second = sheet.valueAt(area.top + 1, c);
    if (typeof first === 'string' && !isError(first)) text += 1;
    if (typeof second === 'number' || (typeof second === 'string' && typeof first === 'string' && first !== second)) numbersBelow = true;
  }
  return text === area.right - area.left + 1 && numbersBelow;
}

/** Orders two values for a sort: blanks always last, otherwise as the spreadsheet compares them. */
function sortOrder(a, b, order, caseSensitive) {
  const blankA = isBlank(a);
  const blankB = isBlank(b);
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  if (caseSensitive && typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()) {
    return order * (a < b ? 1 : a > b ? -1 : 0);
  }
  let result = compare(a, b);
  if (isError(result)) result = isError(a) ? (isError(b) ? 0 : 1) : -1;
  return order * Math.sign(result);
}

/**
 * The rows (or columns) of a block in their new order, as the indices they came from.
 * @param {{keys: {index: number, order: 1|-1}[], header?: boolean, byColumns?: boolean, caseSensitive?: boolean}} plan
 */
export function sortPermutation(sheet, area, plan) {
  const byColumns = Boolean(plan.byColumns);
  const first = (byColumns ? area.left : area.top) + (plan.header ? 1 : 0);
  const last = byColumns ? area.right : area.bottom;
  const lines = [];
  for (let i = first; i <= last; i += 1) lines.push(i);
  const value = (line, at) => (byColumns ? sheet.valueAt(at, line) : sheet.valueAt(line, at));
  return lines.slice().sort((a, b) => {
    for (const k of plan.keys) {
      const result = sortOrder(value(a, k.index), value(b, k.index), k.order, plan.caseSensitive);
      if (result !== 0) return result;
    }
    return a - b;
  }).map((from, i) => ({ from, to: first + i }));
}

/** What each column of a filter lets through, and whether a row passes all of them. */
export function filterTest(sheet, filter) {
  const tests = [];
  for (const [offset, rule] of Object.entries(filter.columns ?? {})) {
    const col = filter.area.left + Number(offset);
    if (rule.values) {
      const allowed = new Set(rule.values);
      tests.push((row) => allowed.has(shownText(sheet, row, col)));
    }
    if (rule.conditions?.length) {
      const checks = rule.conditions.map((c) => conditionTest(c));
      tests.push((row) => {
        const value = sheet.valueAt(row, col);
        return rule.join === 'or' ? checks.some((t) => t(value)) : checks.every((t) => t(value));
      });
    }
    if (rule.top) {
      const values = [];
      for (let r = filter.area.top + 1; r <= filter.area.bottom; r += 1) {
        const v = sheet.valueAt(r, col);
        if (typeof v === 'number') values.push(v);
      }
      values.sort((a, b) => (rule.top.largest === false ? a - b : b - a));
      const count = rule.top.percent ? Math.ceil(values.length * rule.top.count / 100) : rule.top.count;
      const limit = values[Math.min(values.length, Math.max(1, count)) - 1];
      tests.push((row) => {
        const v = sheet.valueAt(row, col);
        return typeof v === 'number' && limit !== undefined && (rule.top.largest === false ? v <= limit : v >= limit);
      });
    }
  }
  return (row) => tests.every((test) => test(row));
}

/** How a cell shows, which is what the filter's list of values offers. */
export function shownText(sheet, row, col, styles = null) {
  const cell = sheet.cell(row, col);
  const value = sheet.valueAt(row, col);
  const format = styles && cell?.s ? styles[cell.s]?.format : undefined;
  return isBlank(value) ? '' : formatValue(value, format);
}

/** One condition of a standard filter: an operator and a value. */
export function conditionTest({ op, value }) {
  const text = String(value ?? '');
  switch (op) {
    case 'contains': return (v) => !isBlank(v) && String(v).toLowerCase().includes(text.toLowerCase());
    case 'not-contains': return (v) => isBlank(v) || !String(v).toLowerCase().includes(text.toLowerCase());
    case 'begins': return (v) => !isBlank(v) && String(v).toLowerCase().startsWith(text.toLowerCase());
    case 'ends': return (v) => !isBlank(v) && String(v).toLowerCase().endsWith(text.toLowerCase());
    case 'empty': return (v) => isBlank(v);
    case 'not-empty': return (v) => !isBlank(v);
    default: {
      const symbol = { '=': '=', '<>': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' }[op] ?? '=';
      const test = criterion(`${symbol}${text}`);
      return isError(test) ? () => false : test;
    }
  }
}

/** The rows a filter hides. */
export function filteredRows(sheet, filter) {
  const hidden = new Set();
  if (!filter) return hidden;
  const passes = filterTest(sheet, filter);
  for (let row = filter.area.top + 1; row <= filter.area.bottom; row += 1) if (!passes(row)) hidden.add(row);
  return hidden;
}

/** The rows of a block that repeat an earlier one in the chosen columns. */
export function duplicateRows(sheet, area, { header = false, columns = null } = {}) {
  const cols = columns ?? Array.from({ length: area.right - area.left + 1 }, (_, i) => area.left + i);
  const seen = new Set();
  const repeated = [];
  for (let row = area.top + (header ? 1 : 0); row <= area.bottom; row += 1) {
    const signature = JSON.stringify(cols.map((c) => {
      const v = sheet.valueAt(row, c);
      return typeof v === 'string' ? v.toLowerCase() : v;
    }));
    if (seen.has(signature)) repeated.push(row);
    else seen.add(signature);
  }
  return repeated;
}

/** Text split at a separator, quotes respected, as Text to Columns does it. */
export function splitText(text, { separators = [','], merge = false, quote = '"' } = {}) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote && c === quote) {
      if (quoted && text[i + 1] === quote) { field += quote; i += 1; } else quoted = !quoted;
    } else if (!quoted && separators.includes(c)) {
      out.push(field);
      field = '';
      if (merge) while (separators.includes(text[i + 1])) i += 1;
    } else field += c;
  }
  out.push(field);
  return out;
}

/** The values a series fills in, from a start and a step: linear, growth, or dates by day, month or year. */
export function seriesValues(start, count, { type = 'linear', step = 1, unit = 'day', stop = null } = {}) {
  const out = [];
  let value = start;
  for (let i = 0; i < count; i += 1) {
    if (stop !== null && (step >= 0 ? value > stop : value < stop)) break;
    out.push(value);
    if (type === 'growth') value *= step;
    else if (type === 'date' && unit !== 'day') value = addDateStep(value, unit, step);
    else value += step;
  }
  return out;
}

function addDateStep(serial, unit, step) {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + step);
  else if (unit === 'year') date.setUTCFullYear(date.getUTCFullYear() + step);
  else if (unit === 'weekday') {
    let left = step;
    while (left > 0) {
      date.setUTCDate(date.getUTCDate() + 1);
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) left -= 1;
    }
  }
  return Math.round((date.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

/** The rows where a subtotal goes: after each run of equal values in the grouping column. */
export function groupBreaks(sheet, area, groupCol) {
  const breaks = [];
  let previous;
  for (let row = area.top + 1; row <= area.bottom; row += 1) {
    const v = sheet.valueAt(row, groupCol);
    if (row > area.top + 1 && compare(v, previous) !== 0) breaks.push(row);
    previous = v;
  }
  breaks.push(area.bottom + 1);
  return breaks;
}

export { key };
