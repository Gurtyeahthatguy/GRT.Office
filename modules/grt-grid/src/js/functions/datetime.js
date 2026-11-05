/** Dates and times: serial numbers counted from 1899-12-30, the day as the unit. */

import { ERROR, isError, isBlank, toNumber, toText, toBoolean } from '../engine/values.js';

const DAY = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);

/** The serial of a calendar day. */
export const serialOf = (year, month, day) => Math.round((Date.UTC(year, month - 1, day) - EPOCH) / DAY);

/** The calendar day of a serial, in UTC so no time zone moves it. */
export function dayOf(serial) {
  const date = new Date(EPOCH + Math.floor(serial) * DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** One argument as a date serial, refusing what is not one. */
function serialArg(arg) {
  if (!arg || arg.missing) return ERROR.value;
  const value = arg.value;
  if (typeof value === 'string' && !isError(value)) {
    const parsed = parseDate(value);
    return parsed === null ? ERROR.value : parsed;
  }
  const number = toNumber(value);
  return isError(number) ? number : number;
}

function numberArg(arg, fallback = null) {
  if (!arg || arg.missing) return fallback;
  return toNumber(arg.value);
}

/** A two-digit year as LibreOffice reads it, between 1930 and 2029. */
const fullYear = (year) => (year < 100 ? (year < 30 ? 2000 + year : 1900 + year) : year);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date written as text: ISO, month/day/year, or with the month's name; null when it is none. */
export function parseDate(text) {
  const t = String(text).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](.*))?$/.exec(t);
  if (m) return withTime(valid(+m[1], +m[2], +m[3]), m[4]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(.*))?$/.exec(t);
  if (m) return withTime(valid(fullYear(+m[3]), +m[1], +m[2]), m[4]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(.*))?$/.exec(t);
  if (m) return withTime(valid(fullYear(+m[3]), +m[2], +m[1]), m[4]);
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s-]+(\d{2,4})$/.exec(t);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return valid(fullYear(+m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(t);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return valid(fullYear(+m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
  return null;
}

function valid(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return serialOf(year, month, day);
}

function withTime(serial, rest) {
  if (serial === null) return null;
  if (!rest) return serial;
  const time = parseTime(rest);
  return time === null ? null : serial + time;
}

/** A time written as text, as a fraction of a day; null when it is none. */
export function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/.exec(String(text).trim());
  if (!m) return null;
  let hours = +m[1];
  const minutes = +m[2];
  const seconds = m[3] ? +m[3] : 0;
  if (m[4]) {
    if (hours > 12) return null;
    hours = hours % 12 + (m[4].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (minutes > 59 || seconds >= 60) return null;
  return (hours * 3600 + minutes * 60 + seconds) / 86400;
}

/** Hours, minutes and seconds of a serial, rounded to the second as spreadsheets show them. */
function clock(serial) {
  const day = Math.min(86399, Math.floor((serial - Math.floor(serial)) * 86400 + 1e-6));
  return { hour: Math.floor(day / 3600), minute: Math.floor((day % 3600) / 60), second: day % 60 };
}

/** The ISO 8601 week of a serial. */
function isoWeek(serial) {
  const { weekday } = dayOf(serial);
  const thursday = Math.floor(serial) - ((weekday + 6) % 7) + 3;
  const year = dayOf(thursday).year;
  return Math.floor((thursday - serialOf(year, 1, 1)) / 7) + 1;
}

/** Excel's WEEKNUM return types: which day starts the week, and 21 for ISO. */
const WEEK_STARTS = { 1: 0, 2: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 0 };

function weekNumber(serial, type) {
  if (type === 21) return isoWeek(serial);
  const start = WEEK_STARTS[type];
  if (start === undefined) return ERROR.num;
  const { year } = dayOf(serial);
  const first = serialOf(year, 1, 1);
  const offset = (dayOf(first).weekday - start + 7) % 7;
  return Math.floor((Math.floor(serial) - first + offset) / 7) + 1;
}

/** Which weekdays are off: an array of seven flags from Monday, as NETWORKDAYS.INTL reads its weekend. */
function weekendOf(arg) {
  if (!arg || arg.missing) return [0, 0, 0, 0, 0, 1, 1];
  const value = arg.value;
  if (typeof value === 'string' && /^[01]{7}$/.test(value)) {
    if (value === '1111111') return ERROR.value;
    return [...value].map(Number);
  }
  const code = toNumber(value);
  if (isError(code)) return code;
  const flags = [0, 0, 0, 0, 0, 0, 0];
  if (code >= 1 && code <= 7) {
    flags[(code + 4) % 7] = 1;
    flags[(code + 5) % 7] = 1;
    return flags;
  }
  if (code >= 11 && code <= 17) {
    flags[(code - 11 + 6) % 7] = 1;
    return flags;
  }
  return ERROR.num;
}

/** The weekend as LibreOffice's own NETWORKDAYS takes it: a range of seven, Monday first, 1 for a day off. */
function workdaysArg(arg) {
  if (!arg || arg.missing) return [0, 0, 0, 0, 0, 1, 1];
  const values = arg.values.map((v) => toNumber(v));
  if (values.length !== 7 || values.some(isError)) return ERROR.value;
  return values.map((v) => (v ? 1 : 0));
}

function holidaysOf(arg) {
  if (!arg || arg.missing) return new Set();
  const out = new Set();
  for (const value of arg.values) {
    if (isBlank(value)) continue;
    const serial = typeof value === 'string' ? parseDate(value) : toNumber(value);
    if (serial === null || isError(serial)) return ERROR.value;
    out.add(Math.floor(serial));
  }
  return out;
}

const isOff = (serial, weekend, holidays) => weekend[(dayOf(serial).weekday + 6) % 7] === 1 || holidays.has(serial);

function networkDays(start, end, weekend, holidays) {
  for (const value of [start, end, weekend, holidays]) if (isError(value)) return value;
  const from = Math.floor(start);
  const to = Math.floor(end);
  const sign = to >= from ? 1 : -1;
  let count = 0;
  for (let day = from; sign > 0 ? day <= to : day >= to; day += sign) {
    if (!isOff(day, weekend, holidays)) count += 1;
    if (Math.abs(day - from) > 1e7) return ERROR.num;
  }
  return sign * count;
}

function workday(start, days, weekend, holidays) {
  for (const value of [start, days, weekend, holidays]) if (isError(value)) return value;
  let day = Math.floor(start);
  let left = Math.trunc(days);
  const step = left >= 0 ? 1 : -1;
  let guard = 0;
  while (left !== 0) {
    day += step;
    if (!isOff(day, weekend, holidays)) left -= step;
    guard += 1;
    if (guard > 1e7) return ERROR.num;
  }
  return day;
}

/** Days between two dates in a 360-day year, the US way or the European one. */
function days360(start, end, european) {
  const a = dayOf(start);
  const b = dayOf(end);
  let d1 = a.day;
  let d2 = b.day;
  if (european) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    const lastOfFeb = (d) => d.month === 2 && d.day === daysInMonth(d.year, 2);
    if (lastOfFeb(a)) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
    if (d1 === 31) d1 = 30;
  }
  return (b.year - a.year) * 360 + (b.month - a.month) * 30 + (d2 - d1);
}

/** The fraction of a year between two dates, by one of the five day-count bases. */
function yearFrac(start, end, basis) {
  let a = Math.floor(start);
  let b = Math.floor(end);
  if (a > b) [a, b] = [b, a];
  const da = dayOf(a);
  const db = dayOf(b);
  switch (basis) {
    case 0: return days360(a, b, false) / 360;
    case 1: {
      if (da.year === db.year) return (b - a) / (isLeap(da.year) ? 366 : 365);
      const oneYear = db.year === da.year + 1 && (db.month < da.month || (db.month === da.month && db.day <= da.day));
      if (oneYear) {
        const leapDay = (isLeap(da.year) && (da.month < 3)) || (isLeap(db.year) && (db.month > 2 || (db.month === 2 && db.day === 29)));
        return (b - a) / (leapDay ? 366 : 365);
      }
      let days = 0;
      for (let y = da.year; y <= db.year; y += 1) days += isLeap(y) ? 366 : 365;
      return (b - a) / (days / (db.year - da.year + 1));
    }
    case 2: return (b - a) / 360;
    case 3: return (b - a) / 365;
    case 4: return days360(a, b, true) / 360;
    default: return ERROR.num;
  }
}

function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return serialOf(year, month, day);
}

/** Months added to a date, the day kept unless the month is shorter. */
function addMonths(serial, months) {
  const { year, month, day } = dayOf(serial);
  const total = year * 12 + (month - 1) + Math.trunc(months);
  const y = Math.floor(total / 12);
  const mo = total - y * 12 + 1;
  return serialOf(y, mo, Math.min(day, daysInMonth(y, mo)));
}

/** Every argument a function takes as dates, failing on the first that is not one. */
function serials(args, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const value = serialArg(args[i]);
    if (isError(value)) return value;
    out.push(value);
  }
  return out;
}

export const DATETIME = {
  TIME: (args) => {
    const [h, m, s] = [0, 1, 2].map((i) => numberArg(args[i], 0));
    for (const v of [h, m, s]) if (isError(v)) return v;
    const total = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s);
    if (total < 0) return ERROR.num;
    return (total % 86400) / 86400;
  },
  TIMEVALUE: (args) => {
    const text = toText(args[0]?.value);
    if (isError(text)) return text;
    const time = parseTime(text);
    if (time !== null) return time;
    const date = parseDate(text);
    return date === null ? ERROR.value : date - Math.floor(date);
  },
  DATEVALUE: (args) => {
    const text = toText(args[0]?.value);
    if (isError(text)) return text;
    const date = parseDate(text);
    return date === null ? ERROR.value : Math.floor(date);
  },
  HOUR: (args) => { const s = serialArg(args[0]); return isError(s) ? s : clock(s).hour; },
  MINUTE: (args) => { const s = serialArg(args[0]); return isError(s) ? s : clock(s).minute; },
  SECOND: (args) => { const s = serialArg(args[0]); return isError(s) ? s : clock(s).second; },

  DATEDIF: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    const unit = toText(args[2]?.value).toLowerCase();
    const [start, end] = dates.map(Math.floor);
    if (start > end) return ERROR.num;
    const a = dayOf(start);
    const b = dayOf(end);
    let months = (b.year - a.year) * 12 + (b.month - a.month);
    if (b.day < a.day) months -= 1;
    switch (unit) {
      case 'd': return end - start;
      case 'm': return months;
      case 'y': return Math.floor(months / 12);
      case 'ym': return months % 12;
      case 'yd': {
        let anniversary = serialOf(b.year, a.month, Math.min(a.day, daysInMonth(b.year, a.month)));
        if (anniversary > end) anniversary = serialOf(b.year - 1, a.month, Math.min(a.day, daysInMonth(b.year - 1, a.month)));
        return end - anniversary;
      }
      case 'md': {
        if (b.day >= a.day) return b.day - a.day;
        const prevMonth = b.month === 1 ? 12 : b.month - 1;
        const prevYear = b.month === 1 ? b.year - 1 : b.year;
        return daysInMonth(prevYear, prevMonth) - a.day + b.day;
      }
      default: return ERROR.value;
    }
  },
  DAYS360: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    const european = args[2] && !args[2].missing ? toBoolean(args[2].value) : false;
    if (isError(european)) return european;
    return days360(Math.floor(dates[0]), Math.floor(dates[1]), european);
  },
  DAYSINMONTH: (args) => { const s = serialArg(args[0]); if (isError(s)) return s; const d = dayOf(s); return daysInMonth(d.year, d.month); },
  DAYSINYEAR: (args) => { const s = serialArg(args[0]); return isError(s) ? s : (isLeap(dayOf(s).year) ? 366 : 365); },
  ISLEAPYEAR: (args) => { const s = serialArg(args[0]); return isError(s) ? s : (isLeap(dayOf(s).year) ? 1 : 0); },
  WEEKSINYEAR: (args) => {
    const s = serialArg(args[0]);
    if (isError(s)) return s;
    return isoWeek(serialOf(dayOf(s).year, 12, 28));
  },
  EASTERSUNDAY: (args) => {
    const year = numberArg(args[0]);
    if (isError(year) || year === null) return ERROR.value;
    const y = fullYear(Math.trunc(year));
    return y < 1583 || y > 9956 ? ERROR.value : easter(y);
  },
  EDATE: (args) => {
    const start = serialArg(args[0]);
    const months = numberArg(args[1]);
    if (isError(start)) return start;
    if (isError(months) || months === null) return ERROR.value;
    return addMonths(start, months);
  },
  EOMONTH: (args) => {
    const start = serialArg(args[0]);
    const months = numberArg(args[1]);
    if (isError(start)) return start;
    if (isError(months) || months === null) return ERROR.value;
    const moved = dayOf(addMonths(serialOf(dayOf(start).year, dayOf(start).month, 1), months));
    return serialOf(moved.year, moved.month, daysInMonth(moved.year, moved.month));
  },
  ISOWEEKNUM: (args) => { const s = serialArg(args[0]); return isError(s) ? s : isoWeek(s); },
  WEEKNUM: (args) => {
    const s = serialArg(args[0]);
    if (isError(s)) return s;
    const type = numberArg(args[1], 1);
    return isError(type) ? type : weekNumber(s, Math.trunc(type));
  },
  WEEKNUM_EXCEL2003: (args) => {
    const s = serialArg(args[0]);
    if (isError(s)) return s;
    const type = numberArg(args[1], 1);
    if (isError(type)) return type;
    return type === 1 || type === 2 ? weekNumber(s, type) : ERROR.num;
  },
  WEEKNUM_OOO: (args) => {
    const s = serialArg(args[0]);
    if (isError(s)) return s;
    const mode = numberArg(args[1], 1);
    if (isError(mode)) return mode;
    // Mode 1 counts weeks from Sunday, any other from Monday; both as ISO 8601 numbers them.
    return Math.trunc(mode) === 1 ? isoWeek(Math.floor(s) + 1) : isoWeek(s);
  },
  MONTHS: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    const mode = numberArg(args[2], 0);
    const [a, b] = dates.map((d) => dayOf(d));
    const months = (b.year - a.year) * 12 + (b.month - a.month);
    if (Math.trunc(mode) === 1) return months;
    if (Math.floor(dates[1]) >= Math.floor(dates[0])) return b.day < a.day ? months - 1 : months;
    return b.day > a.day ? months + 1 : months;
  },
  YEARS: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    const mode = numberArg(args[2], 0);
    const [a, b] = dates.map((d) => dayOf(d));
    if (Math.trunc(mode) === 1) return b.year - a.year;
    let years = b.year - a.year;
    const before = b.month < a.month || (b.month === a.month && b.day < a.day);
    const after = b.month > a.month || (b.month === a.month && b.day > a.day);
    if (Math.floor(dates[1]) >= Math.floor(dates[0])) { if (before) years -= 1; } else if (after) years += 1;
    return years;
  },
  WEEKS: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    const mode = numberArg(args[2], 0);
    const [start, end] = dates.map(Math.floor);
    if (Math.trunc(mode) === 1) {
      const monday = (d) => d - ((dayOf(d).weekday + 6) % 7);
      return Math.trunc((monday(end) - monday(start)) / 7);
    }
    return Math.trunc((end - start) / 7);
  },
  NETWORKDAYS: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    return networkDays(dates[0], dates[1], workdaysArg(args[3]), holidaysOf(args[2]));
  },
  NETWORKDAYS_EXCEL2003: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    return networkDays(dates[0], dates[1], [0, 0, 0, 0, 0, 1, 1], holidaysOf(args[2]));
  },
  'NETWORKDAYS.INTL': (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    return networkDays(dates[0], dates[1], weekendOf(args[2]), holidaysOf(args[3]));
  },
  WORKDAY: (args) => {
    const start = serialArg(args[0]);
    if (isError(start)) return start;
    return workday(start, numberArg(args[1], 0), [0, 0, 0, 0, 0, 1, 1], holidaysOf(args[2]));
  },
  'WORKDAY.INTL': (args) => {
    const start = serialArg(args[0]);
    if (isError(start)) return start;
    return workday(start, numberArg(args[1], 0), weekendOf(args[2]), holidaysOf(args[3]));
  },
  YEARFRAC: (args) => {
    const dates = serials(args, 2);
    if (isError(dates)) return dates;
    const basis = numberArg(args[2], 0);
    if (isError(basis)) return basis;
    return yearFrac(dates[0], dates[1], Math.trunc(basis));
  },
};
