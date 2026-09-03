/** Dates and times, without a Date object doing arithmetic. */

// Days as integers

/** Days since 1970-01-01, from a civil date. */
export function toDays(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse: a civil date from days since 1970-01-01. */
export function fromDays(days) {
  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
}

// ISO date strings

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** `{year, month, day}` to `YYYY-MM-DD`. */
export function formatDate({ year, month, day }) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** `YYYY-MM-DD` to `{year, month, day}`. */
export function parseDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!match) throw new Error(`Not a date: ${iso}`);
  return { year: +match[1], month: +match[2], day: +match[3] };
}

/** Days since the epoch, from `YYYY-MM-DD`. */
export function dayNumber(iso) {
  const { year, month, day } = parseDate(iso);
  return toDays(year, month, day);
}

/** `YYYY-MM-DD`, from days since the epoch. */
export function dateFromDayNumber(days) {
  return formatDate(fromDays(days));
}

/** `n` days after `iso`. */
export function addDays(iso, n) {
  return dateFromDayNumber(dayNumber(iso) + n);
}

/** Adds months, clamping the day to the length of the target month. */
export function addMonths(iso, n) {
  const { year, month, day } = parseDate(iso);
  const total = year * 12 + (month - 1) + n;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  const clamped = Math.min(day, daysInMonth(targetYear, targetMonth));
  return formatDate({ year: targetYear, month: targetMonth, day: clamped });
}

export function addYears(iso, n) {
  const { year, month, day } = parseDate(iso);
  const clamped = Math.min(day, daysInMonth(year + n, month));
  return formatDate({ year: year + n, month, day: clamped });
}

export function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Weekday, 0 = Sunday through 6 = Saturday. */
export function weekday(iso) {
  const n = dayNumber(iso);
  return ((n + 4) % 7 + 7) % 7;
}

/** The first day of the week containing `iso`. */
export function startOfWeek(iso, weekStart = 1) {
  const shift = (weekday(iso) - weekStart + 7) % 7;
  return addDays(iso, -shift);
}

export function startOfMonth(iso) {
  const { year, month } = parseDate(iso);
  return formatDate({ year, month, day: 1 });
}

export function endOfMonth(iso) {
  const { year, month } = parseDate(iso);
  return formatDate({ year, month, day: daysInMonth(year, month) });
}

/** The six-week grid a month view draws. */
export function monthGrid(iso, weekStart = 1) {
  const first = startOfWeek(startOfMonth(iso), weekStart);
  return Array.from({ length: 42 }, (unused, i) => addDays(first, i));
}

// Times

/** `HH:MM` to minutes after midnight. */
export function minutesOfDay(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!match) throw new Error(`Not a time: ${time}`);
  return +match[1] * 60 + +match[2];
}

/** Minutes after midnight to `HH:MM`. */
export function timeFromMinutes(total) {
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** Adds minutes to a wall-clock point, carrying into the date. */
export function addMinutes({ date, time }, delta) {
  const total = minutesOfDay(time) + delta;
  const dayShift = Math.floor(total / 1440);
  return { date: addDays(date, dayShift), time: timeFromMinutes(total) };
}

/** Minutes between two wall-clock points, end minus start. */
export function minutesBetween(from, to) {
  const days = dayNumber(to.date) - dayNumber(from.date);
  return days * 1440 + minutesOfDay(to.time) - minutesOfDay(from.time);
}

// The only place a real timezone is consulted

/** Today, in the machine's own timezone. */
export function today(now = new Date()) {
  return formatDate({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  });
}

export function currentTime(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Converts an instant expressed in some named zone to local wall-clock time.
 */
export function toLocalWallClock({ date, time, zone }) {
  if (!zone || !time) return { date, time };

  try {
    const { year, month, day } = parseDate(date);
    const [hour, minute] = time.split(':').map(Number);

    // Interpret the wall-clock reading as being in `zone`, by finding the
    // instant whose rendering in that zone matches the input.
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const offset = zoneOffsetAt(guess, zone);
    const instant = guess - offset;

    const local = new Date(instant);
    return {
      date: formatDate({
        year: local.getFullYear(),
        month: local.getMonth() + 1,
        day: local.getDate(),
      }),
      time: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
    };
  } catch {
    return { date, time };
  }
}

/** The offset of `zone` at an instant, in milliseconds. */
function zoneOffsetAt(instant, zone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone === 'UTC' ? 'UTC' : zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = +part.value;
  }

  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour % 24, parts.minute, parts.second,
  );
  return asUtc - instant;
}

// Display

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday'];

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May',
  'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthTitle(iso) {
  const { year, month } = parseDate(iso);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** `Monday 1 September 2026`, without asking the platform to localise it. */
export function longDate(iso) {
  const { year, month, day } = parseDate(iso);
  return `${WEEKDAY_NAMES[weekday(iso)]} ${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** `1 Sep`, for a compact row. */
export function shortDate(iso) {
  const { month, day } = parseDate(iso);
  return `${day} ${MONTH_NAMES[month - 1].slice(0, 3)}`;
}
