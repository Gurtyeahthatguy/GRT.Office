/** Reading and writing iCalendar (RFC 5545). */

import { newUid } from './ids.js';
import { parseDate, formatDate, addDays, toLocalWallClock } from './time.js';

/** Identifies the software. */
export const PRODID = '-//GRT//Calendar//EN';

/** The fixed `DTSTAMP`. */
export const FIXED_DTSTAMP = '19800101T000000Z';

/** Properties handled by name. */
const KNOWN_EVENT = new Set([
  'UID', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'DTSTART', 'DTEND', 'DURATION',
  'RRULE', 'EXDATE', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE',
  'TRANSP', 'CATEGORIES', 'STATUS', 'PRIORITY', 'DUE', 'COMPLETED',
  'PERCENT-COMPLETE', 'X-GRT-NOTE', 'X-GRT-COLOUR',
]);

// Line handling

/** Undoes RFC 5545 line folding. */
export function unfold(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

/** Folds a line to 75 octets, continuing with a space. */
export function fold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const pieces = [];
  let current = '';
  let width = 0;
  let limit = 75;

  for (const character of line) {
    const size = encoder.encode(character).length;
    if (width + size > limit) {
      pieces.push(current);
      current = '';
      width = 1;      // the leading space of a continuation line.
      limit = 75;
    }
    current += character;
    width += size;
  }
  if (current) pieces.push(current);

  return pieces.join('\r\n ');
}

/** Splits `NAME;PARAM=value:content` into its three parts. */
export function parseLine(line) {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) { colon = i; break; }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(';');

  const params = {};
  for (const piece of rest) {
    const equals = piece.indexOf('=');
    if (equals === -1) continue;
    const key = piece.slice(0, equals).toUpperCase();
    params[key] = piece.slice(equals + 1).replace(/^"|"$/g, '');
  }

  return { name: name.toUpperCase(), params, value, raw: line };
}

/** Undoes TEXT escaping: `\\`, `\;`, `\,`, `\n`. */
export function unescapeText(value) {
  return String(value).replace(/\\([\\;,nN])/g, (match, c) => (
    c === 'n' || c === 'N' ? '\n' : c
  ));
}

/** Applies TEXT escaping. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Date and time values

/** Reads a DATE or DATE-TIME value into wall-clock components. */
export function parseDateValue(value, params = {}) {
  const text = String(value).trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (dateOnly || params.VALUE === 'DATE') {
    const match = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(text);
    if (!match) return null;
    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      time: null,
      zone: null,
    };
  }

  const full = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(text);
  if (!full) return null;

  return {
    date: `${full[1]}-${full[2]}-${full[3]}`,
    time: `${full[4]}:${full[5]}`,
    zone: full[7] ? 'UTC' : (params.TZID ?? null),
  };
}

/** Writes wall-clock components back as a DATE or floating DATE-TIME. */
export function formatDateValue({ date, time }) {
  const { year, month, day } = parseDate(date);
  const compact = `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  if (!time) return compact;
  const [hour, minute] = time.split(':');
  return `${compact}T${hour}${minute}00`;
}

// Reading

/**
 * Parses a calendar file.
 * @returns {{name: string|null, entries: Object[], unsupported: string[]}}
 *   `unsupported` names the components that were seen and skipped, so the
 */
export function parse(text) {
  const lines = unfold(text).split('\n').map((line) => line.trimEnd()).filter(Boolean);

  const entries = [];
  const unsupported = new Set();
  let name = null;

  let current = null;
  let kind = null;
  let depth = [];

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (parsed.name === 'BEGIN') {
      const component = parsed.value.toUpperCase();
      depth.push(component);

      if (component === 'VEVENT' || component === 'VTODO') {
        kind = component === 'VEVENT' ? 'event' : 'task';
        current = blankEntry(kind);
      } else if (component !== 'VCALENDAR' && depth.length <= 2) {
        // VTIMEZONE, VALARM, VJOURNAL, VFREEBUSY: recorded, not interpreted.
        unsupported.add(component);
      }
      continue;
    }

    if (parsed.name === 'END') {
      const component = parsed.value.toUpperCase();
      depth.pop();
      if ((component === 'VEVENT' || component === 'VTODO') && current) {
        entries.push(finishEntry(current));
        current = null;
        kind = null;
      }
      continue;
    }

    if (!current) {
      // Calendar-level property.
      if (parsed.name === 'X-WR-CALNAME') name = unescapeText(parsed.value);
      continue;
    }

    absorb(current, parsed);
  }

  return { name, entries, unsupported: [...unsupported] };
}

function blankEntry(kind) {
  return {
    kind,
    uid: '',
    summary: '',
    description: '',
    location: '',
    start: null,
    end: null,
    due: null,
    allDay: false,
    rrule: null,
    exdate: [],
    status: null,
    priority: 0,
    completed: false,
    note: null,
    extra: [],
  };
}

function absorb(entry, { name, params, value, raw }) {
  switch (name) {
    case 'UID': entry.uid = value.trim(); break;
    case 'SUMMARY': entry.summary = unescapeText(value); break;
    case 'DESCRIPTION': entry.description = unescapeText(value); break;
    case 'LOCATION': entry.location = unescapeText(value); break;
    case 'X-GRT-NOTE': entry.note = value.trim(); break;

    case 'DTSTART': entry.start = parseDateValue(value, params); break;
    case 'DTEND': entry.end = parseDateValue(value, params); break;
    case 'DUE': entry.due = parseDateValue(value, params); break;

    // The rule is kept as written.
    case 'RRULE': entry.rrule = value.trim(); break;

    case 'EXDATE':
      for (const piece of value.split(',')) {
        const parsed = parseDateValue(piece, params);
        if (parsed) entry.exdate.push(parsed.date);
      }
      break;

    case 'STATUS': entry.status = value.trim().toUpperCase(); break;
    case 'PRIORITY': entry.priority = Number.parseInt(value, 10) || 0; break;
    case 'COMPLETED': entry.completed = true; break;
    case 'PERCENT-COMPLETE':
      if (Number.parseInt(value, 10) >= 100) entry.completed = true;
      break;

    // Written by us with fixed or absent values, so an incoming one is read
    // and discarded rather than carried forward.
    case 'DTSTAMP': case 'CREATED': case 'LAST-MODIFIED': case 'SEQUENCE':
      break;

    default:
      if (!KNOWN_EVENT.has(name)) entry.extra.push(raw);
  }
}

function finishEntry(entry) {
  if (entry.start) {
    entry.allDay = entry.start.time === null;
    const local = toLocalWallClock(entry.start);
    entry.start = { date: local.date, time: local.time, zone: null };
  }
  if (entry.end) {
    const local = toLocalWallClock(entry.end);
    entry.end = { date: local.date, time: local.time, zone: null };
  }
  if (entry.due) {
    const local = toLocalWallClock(entry.due);
    entry.due = { date: local.date, time: local.time, zone: null };
  }
  if (entry.status === 'COMPLETED') entry.completed = true;
  if (!entry.uid) entry.uid = newUid();
  return entry;
}

// Writing

/** Serialises a calendar. */
export function serialise({ name = null, entries = [] } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
  ];

  if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`);

  const sorted = [...entries].sort((a, b) => a.uid.localeCompare(b.uid));
  for (const entry of sorted) lines.push(...entryLines(entry));

  lines.push('END:VCALENDAR');

  return `${lines.map(fold).join('\r\n')}\r\n`;
}

function entryLines(entry) {
  const component = entry.kind === 'task' ? 'VTODO' : 'VEVENT';
  const lines = [`BEGIN:${component}`];

  lines.push(`UID:${entry.uid}`);
  lines.push(`DTSTAMP:${FIXED_DTSTAMP}`);

  if (entry.summary) lines.push(`SUMMARY:${escapeText(entry.summary)}`);

  if (entry.start) {
    lines.push(entry.allDay
      ? `DTSTART;VALUE=DATE:${formatDateValue(entry.start)}`
      : `DTSTART:${formatDateValue(entry.start)}`);
  }

  if (entry.end) {
    lines.push(entry.allDay
      ? `DTEND;VALUE=DATE:${formatDateValue(entry.end)}`
      : `DTEND:${formatDateValue(entry.end)}`);
  }

  if (entry.due) {
    lines.push(entry.due.time
      ? `DUE:${formatDateValue(entry.due)}`
      : `DUE;VALUE=DATE:${formatDateValue(entry.due)}`);
  }

  if (entry.rrule) lines.push(`RRULE:${entry.rrule}`);

  if (entry.exdate.length > 0) {
    const values = [...new Set(entry.exdate)].sort();
    lines.push(entry.allDay
      ? `EXDATE;VALUE=DATE:${values.map((d) => formatDateValue({ date: d, time: null })).join(',')}`
      : `EXDATE:${values.map((d) => formatDateValue({ date: d, time: entry.start?.time ?? '00:00' })).join(',')}`);
  }

  if (entry.location) lines.push(`LOCATION:${escapeText(entry.location)}`);
  if (entry.description) lines.push(`DESCRIPTION:${escapeText(entry.description)}`);
  if (entry.note) lines.push(`X-GRT-NOTE:${entry.note}`);

  if (entry.kind === 'task') {
    lines.push(`STATUS:${entry.completed ? 'COMPLETED' : 'NEEDS-ACTION'}`);
    if (entry.completed) lines.push('PERCENT-COMPLETE:100');
    if (entry.priority) lines.push(`PRIORITY:${entry.priority}`);
  }

  // Everything the parser did not recognise, exactly as it arrived.
  lines.push(...entry.extra);

  lines.push(`END:${component}`);
  return lines;
}

/** The end of an all-day event, as iCalendar means it. */
export function allDayEndFor(lastDay) {
  return addDays(lastDay, 1);
}

/** The inverse, for display: the last day the event actually covers. */
export function allDayLastDay(end) {
  return addDays(end, -1);
}

export { formatDate };
