/** Expanding RRULE. */

import {
  dayNumber, dateFromDayNumber, addDays, addMonths, addYears,
  weekday, parseDate, daysInMonth, formatDate,
} from './time.js';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Parts this expander implements. */
const IMPLEMENTED = new Set([
  'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST',
]);

/** How many occurrences to generate before giving up on a runaway rule. */
const CEILING = 2000;

/**
 * Reads an RRULE string.
 * @returns {{freq, interval, count, until, byday, bymonthday, bymonth,
 */
export function parseRule(text) {
  const rule = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: [],
    bymonthday: [],
    bymonth: [],
    weekStart: 1,
    unsupported: [],
  };

  if (!text) return rule;

  for (const piece of String(text).split(';')) {
    const equals = piece.indexOf('=');
    if (equals === -1) continue;
    const key = piece.slice(0, equals).toUpperCase();
    const value = piece.slice(equals + 1);

    if (!IMPLEMENTED.has(key)) {
      rule.unsupported.push(key);
      continue;
    }

    switch (key) {
      case 'FREQ': rule.freq = value.toUpperCase(); break;
      case 'INTERVAL': rule.interval = Math.max(1, Number.parseInt(value, 10) || 1); break;
      case 'COUNT': rule.count = Number.parseInt(value, 10) || null; break;
      case 'UNTIL': rule.until = untilDate(value); break;
      case 'BYMONTHDAY':
        rule.bymonthday = value.split(',')
          .map((n) => Number.parseInt(n, 10))
          .filter((n) => Number.isFinite(n) && n !== 0);
        break;
      case 'BYMONTH':
        rule.bymonth = value.split(',')
          .map((n) => Number.parseInt(n, 10))
          .filter((n) => n >= 1 && n <= 12);
        break;
      case 'WKST': {
        const index = DAY_CODES.indexOf(value.toUpperCase());
        if (index !== -1) rule.weekStart = index;
        break;
      }
      case 'BYDAY':
        for (const item of value.split(',')) {
          const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(item.trim());
          if (!match) continue;
          rule.byday.push({
            ordinal: match[1] ? Number.parseInt(match[1], 10) : 0,
            day: DAY_CODES.indexOf(match[2].toUpperCase()),
          });
        }
        break;
      default: break;
    }
  }

  // A rule with implemented parts but no FREQ is not a rule at all.
  if (!rule.freq) rule.unsupported.push('FREQ');

  return rule;
}

/** `20260901` or `20260901T235959Z` to `YYYY-MM-DD`. */
function untilDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(String(value).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * Every date on which an entry occurs between `from` and `to`, inclusive.
 * @param {Object} entry needs `start.date`, and optionally `rrule`, `exdate`
 * @param {string} from `YYYY-MM-DD`
 * @param {string} to `YYYY-MM-DD`
 * @returns {string[]} dates, ascending
 */
export function expand(entry, from, to) {
  const first = entry?.start?.date;
  if (!first) return [];

  const excluded = new Set(entry.exdate ?? []);
  const rangeStart = dayNumber(from);
  const rangeEnd = dayNumber(to);

  if (!entry.rrule) {
    const day = dayNumber(first);
    if (day < rangeStart || day > rangeEnd || excluded.has(first)) return [];
    return [first];
  }

  const rule = parseRule(entry.rrule);
  if (!rule.freq || rule.freq === 'FREQ') return [];

  const found = [];
  let produced = 0;

  for (const date of candidates(first, rule)) {
    if (produced >= CEILING) break;
    if (rule.until && dayNumber(date) > dayNumber(rule.until)) break;

    produced += 1;
    if (rule.count && produced > rule.count) break;

    const day = dayNumber(date);
    if (day > rangeEnd) break;
    if (day >= rangeStart && !excluded.has(date)) found.push(date);
  }

  return found;
}

/** The occurrence dates a rule produces, in order, as a generator. */
function* candidates(first, rule) {
  const interval = rule.interval;

  if (rule.freq === 'DAILY') {
    let date = first;
    for (let i = 0; i < CEILING; i += 1) {
      if (matchesFilters(date, rule)) yield date;
      date = addDays(date, interval);
    }
    return;
  }

  if (rule.freq === 'WEEKLY') {
    // Which weekdays: the ones named, or the weekday the entry starts on.
    const days = rule.byday.length > 0
      ? [...new Set(rule.byday.map((d) => d.day))].sort((a, b) => a - b)
      : [weekday(first)];

    let weekStart = startOfWeekFor(first, rule.weekStart);
    for (let step = 0; step < CEILING; step += 1) {
      for (const day of days) {
        const offset = (day - rule.weekStart + 7) % 7;
        const date = addDays(weekStart, offset);
        if (dayNumber(date) < dayNumber(first)) continue;
        if (matchesMonthFilter(date, rule)) yield date;
      }
      weekStart = addDays(weekStart, 7 * interval);
    }
    return;
  }

  if (rule.freq === 'MONTHLY') {
    let month = first;
    for (let step = 0; step < CEILING; step += 1) {
      for (const date of monthOccurrences(month, first, rule)) yield date;
      month = addMonths(monthAnchor(month), interval);
    }
    return;
  }

  if (rule.freq === 'YEARLY') {
    let year = first;
    for (let step = 0; step < CEILING; step += 1) {
      for (const date of yearOccurrences(year, first, rule)) yield date;
      year = addYears(year, interval);
    }
  }
}

/** The first of the month containing `iso`, so adding months cannot clamp. */
function monthAnchor(iso) {
  const { year, month } = parseDate(iso);
  return formatDate({ year, month, day: 1 });
}

function startOfWeekFor(iso, weekStart) {
  const shift = (weekday(iso) - weekStart + 7) % 7;
  return addDays(iso, -shift);
}

/** The dates a MONTHLY rule produces within one month. */
function* monthOccurrences(anchor, first, rule) {
  const { year, month } = parseDate(anchor);
  if (rule.bymonth.length > 0 && !rule.bymonth.includes(month)) return;

  const length = daysInMonth(year, month);
  const days = new Set();

  if (rule.byday.length > 0) {
    for (const { ordinal, day } of rule.byday) {
      for (const found of daysMatching(year, month, day, ordinal)) days.add(found);
    }
  } else if (rule.bymonthday.length > 0) {
    for (const n of rule.bymonthday) {
      const day = n > 0 ? n : length + n + 1;
      if (day >= 1 && day <= length) days.add(day);
    }
  } else {
    // Neither given: the same day of the month as the entry started on.
    const { day } = parseDate(first);
    if (day <= length) days.add(day);
  }

  for (const day of [...days].sort((a, b) => a - b)) {
    const date = formatDate({ year, month, day });
    if (dayNumber(date) >= dayNumber(first)) yield date;
  }
}

/** The dates a YEARLY rule produces within one year. */
function* yearOccurrences(anchor, first, rule) {
  const { year } = parseDate(anchor);
  const months = rule.bymonth.length > 0 ? rule.bymonth : [parseDate(first).month];

  for (const month of months.slice().sort((a, b) => a - b)) {
    const monthStart = formatDate({ year, month, day: 1 });
    for (const date of monthOccurrences(monthStart, first, {
      ...rule,
      bymonth: [],
      // Without BYDAY or BYMONTHDAY, a yearly rule repeats the start date.
      bymonthday: rule.byday.length === 0 && rule.bymonthday.length === 0
        ? [parseDate(first).day] : rule.bymonthday,
    })) {
      if (dayNumber(date) >= dayNumber(first)) yield date;
    }
  }
}

/**
 * Days of a month falling on a weekday, optionally the nth or the nth-last.
 */
function daysMatching(year, month, targetDay, ordinal) {
  const length = daysInMonth(year, month);
  const all = [];

  for (let day = 1; day <= length; day += 1) {
    if (weekday(formatDate({ year, month, day })) === targetDay) all.push(day);
  }

  if (ordinal === 0) return all;
  if (ordinal > 0) return all[ordinal - 1] ? [all[ordinal - 1]] : [];
  return all[all.length + ordinal] ? [all[all.length + ordinal]] : [];
}

function matchesFilters(date, rule) {
  if (!matchesMonthFilter(date, rule)) return false;
  if (rule.byday.length > 0) {
    const day = weekday(date);
    if (!rule.byday.some((entry) => entry.day === day)) return false;
  }
  if (rule.bymonthday.length > 0) {
    const { year, month, day } = parseDate(date);
    const length = daysInMonth(year, month);
    const wanted = rule.bymonthday.some((n) => (n > 0 ? n : length + n + 1) === day);
    if (!wanted) return false;
  }
  return true;
}

function matchesMonthFilter(date, rule) {
  if (rule.bymonth.length === 0) return true;
  return rule.bymonth.includes(parseDate(date).month);
}

/** A rule in words, for the interface. */
export function describe(text) {
  const rule = parseRule(text);
  if (!rule.freq || rule.freq === 'FREQ') return null;

  const every = rule.interval === 1 ? '' : `every ${rule.interval} `;
  const unit = {
    DAILY: rule.interval === 1 ? 'Daily' : 'days',
    WEEKLY: rule.interval === 1 ? 'Weekly' : 'weeks',
    MONTHLY: rule.interval === 1 ? 'Monthly' : 'months',
    YEARLY: rule.interval === 1 ? 'Yearly' : 'years',
  }[rule.freq];
  if (!unit) return null;

  let text_ = rule.interval === 1 ? unit : `Repeats ${every}${unit}`;

  if (rule.byday.length > 0 && rule.freq === 'WEEKLY') {
    const names = rule.byday
      .map(({ day }) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]);
    text_ += ` on ${names.join(', ')}`;
  }

  if (rule.count) text_ += `, ${rule.count} times`;
  if (rule.until) text_ += `, until ${rule.until}`;
  if (rule.unsupported.length > 0) text_ += ' (shown approximately)';

  return text_;
}

export { dateFromDayNumber };
