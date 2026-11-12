/** Reading and writing iCalendar (RFC 5545). */

import { newUid } from './ids.js';
import { parseDate, formatDate, addDays, addMinutes } from './time.js';
import { readTimezone, zoneResolver, toLocal } from './zones.js';

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
 * @returns {{name: string|null, entries: Object[], unsupported: string[], timezones: Object[], kept: string[]}}
 *   `unsupported` names the components that were seen and kept as they are, in `kept`, so they go back into the file;
 *   `timezones` are the file's VTIMEZONE rules with their lines.
 */
export function parse(text) {
  const lines = unfold(text).split('\n').map((line) => line.trimEnd()).filter(Boolean);

  const entries = [];
  const unsupported = new Set();
  const timezones = [];
  const kept = [];
  let name = null;

  let current = null;
  // The lines of the entry being read, so one that cannot be shown is still written back as it came.
  let currentLines = [];
  let depth = [];
  // A component inside an entry, or a calendar-level one GRT does not show, is gathered whole.
  let block = null;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (current) currentLines.push(line);

    if (block) {
      block.lines.push(line);
      block.properties.push(parsed);
      if (parsed.name === 'BEGIN') block.depth += 1;
      if (parsed.name === 'END') block.depth -= 1;
      if (block.depth > 0) continue;
      closeBlock(block, current, { timezones, kept, unsupported });
      block = null;
      depth.pop();
      continue;
    }

    if (parsed.name === 'BEGIN') {
      const component = parsed.value.toUpperCase();
      depth.push(component);

      if ((component === 'VEVENT' || component === 'VTODO') && !current) {
        current = blankEntry(component === 'VEVENT' ? 'event' : 'task');
        currentLines = [line];
      } else if (component !== 'VCALENDAR') {
        block = { component, depth: 1, lines: [line], properties: [parsed] };
      }
      continue;
    }

    if (parsed.name === 'END') {
      const component = parsed.value.toUpperCase();
      depth.pop();
      if ((component === 'VEVENT' || component === 'VTODO') && current) {
        entries.push({ entry: current, lines: currentLines });
        current = null;
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

  // Zones are known once the whole file is read, wherever its VTIMEZONEs sit.
  const resolver = zoneResolver(timezones);
  // An entry dated outside the years 1 to 9999 cannot be shown, so it is kept as it came and counted.
  const finished = [];
  let dropped = 0;
  for (const { entry, lines: raw } of entries) {
    let done = null;
    try {
      done = finishEntry(entry, resolver);
    } catch {
      done = null;
    }
    if (done && [done.start, done.end, done.due].every(withinYears)) finished.push(done);
    else {
      dropped += 1;
      kept.push(...raw);
    }
  }
  return { name, entries: finished, unsupported: [...unsupported], timezones, kept, dropped };
}

function withinYears(point) {
  if (!point) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(point.date ?? '');
  return !!match && +match[1] >= 1 && +match[2] >= 1 && +match[2] <= 12 && +match[3] >= 1 && +match[3] <= 31;
}

/** A component gathered whole: a time zone, a reminder, or something kept as it arrived. */
function closeBlock(block, entry, { timezones, kept, unsupported }) {
  if (block.component === 'VTIMEZONE' && !entry) {
    const zone = readTimezone(block.properties);
    if (zone && timezones.length < 100) timezones.push({ ...zone, lines: block.lines });
    return;
  }
  if (block.component === 'VALARM' && entry) {
    const alarm = readAlarm(block.properties);
    if (alarm && entry.alarms.length < 20) entry.alarms.push(alarm);
    else entry.extra.push(...block.lines);
    return;
  }
  if (entry) {
    entry.extra.push(...block.lines);
    return;
  }
  unsupported.add(block.component);
  kept.push(...block.lines);
}

/** A reminder: how long before the start, when it is that simple; null otherwise, and it is kept as written. */
function readAlarm(properties) {
  const trigger = properties.find((p) => p.name === 'TRIGGER');
  const action = properties.find((p) => p.name === 'ACTION')?.value.trim().toUpperCase();
  if (!trigger || (action && action !== 'DISPLAY' && action !== 'AUDIO')) return null;
  if (trigger.params.RELATED === 'END' || trigger.params.VALUE === 'DATE-TIME') return null;
  const minutes = durationMinutes(trigger.value);
  return minutes === null ? null : { before: -minutes };
}

/** An iCalendar duration, such as -PT15M or P1DT2H, in minutes. */
export function durationMinutes(text) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(text ?? '').trim());
  if (!match || text.trim() === 'P' || text.trim().endsWith('T')) return null;
  const [, sign, w = 0, d = 0, h = 0, m = 0, sec = 0] = match;
  const total = Number(w) * 10080 + Number(d) * 1440 + Number(h) * 60 + Number(m) + Math.floor(Number(sec) / 60);
  return sign === '-' ? -total : total;
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
    alarms: [],
    duration: null,
    zone: null,
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
    case 'DURATION': entry.duration = durationMinutes(value); break;

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

function finishEntry(entry, resolver) {
  if (entry.start) {
    entry.allDay = entry.start.time === null;
    if (!entry.end && entry.duration !== null) {
      entry.end = entry.start.time
        ? { ...addMinutes(entry.start, entry.duration), zone: entry.start.zone }
        : { date: addDays(entry.start.date, Math.max(1, Math.round(entry.duration / 1440))), time: null, zone: null };
    }
    const zone = entry.start.zone;
    if (zone && entry.start.time && !resolver.knows(zone)) entry.unknownZone = zone;
    if (zone && entry.start.time && entry.rrule && resolver.knows(zone)) {
      // A repeating event keeps its zone, so each occurrence lands at the right hour across changes to summer time.
      entry.zone = zone;
      entry.start = { date: entry.start.date, time: entry.start.time, zone: null };
      if (entry.end) entry.end = { ...(entry.end.zone && entry.end.zone !== zone ? toLocal(entry.end, entry.end.zone, resolver) : entry.end), zone: null };
    } else {
      entry.start = { ...toLocal(entry.start, zone, resolver), zone: null };
      if (entry.end) entry.end = { ...toLocal(entry.end, entry.end.zone, resolver), zone: null };
    }
  }
  if (entry.due) entry.due = { ...toLocal(entry.due, entry.due.zone, resolver), zone: null };
  delete entry.duration;
  if (entry.status === 'COMPLETED') entry.completed = true;
  if (!entry.uid) entry.uid = newUid();
  return entry;
}

// Writing

/** Serialises a calendar, with the VTIMEZONEs its repeating events use and the components kept as they came. */
export function serialise({ name = null, entries = [], timezones = [], kept = [] } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
  ];

  if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`);

  const used = new Set(entries.map((e) => e.zone).filter(Boolean));
  for (const zone of timezones) if (used.has(zone.tzid)) lines.push(...zone.lines);
  const sorted = [...entries].sort((a, b) => a.uid.localeCompare(b.uid));
  for (const entry of sorted) lines.push(...entryLines(entry));
  lines.push(...kept);

  lines.push('END:VCALENDAR');

  return `${lines.map(fold).join('\r\n')}\r\n`;
}

function entryLines(entry) {
  const component = entry.kind === 'task' ? 'VTODO' : 'VEVENT';
  const lines = [`BEGIN:${component}`];

  lines.push(`UID:${entry.uid}`);
  lines.push(`DTSTAMP:${FIXED_DTSTAMP}`);

  if (entry.summary) lines.push(`SUMMARY:${escapeText(entry.summary)}`);

  // A repeating event that came with a zone keeps it; everything else is written as the local wall clock.
  const zoned = (property, at) => (entry.zone === 'UTC'
    ? `${property}:${formatDateValue(at)}Z`
    : `${property};TZID=${entry.zone}:${formatDateValue(at)}`);
  if (entry.start) {
    lines.push(entry.allDay
      ? `DTSTART;VALUE=DATE:${formatDateValue(entry.start)}`
      : entry.zone ? zoned('DTSTART', entry.start) : `DTSTART:${formatDateValue(entry.start)}`);
  }

  if (entry.end) {
    lines.push(entry.allDay
      ? `DTEND;VALUE=DATE:${formatDateValue(entry.end)}`
      : entry.zone ? zoned('DTEND', entry.end) : `DTEND:${formatDateValue(entry.end)}`);
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
      : entry.zone && entry.zone !== 'UTC'
        ? `EXDATE;TZID=${entry.zone}:${values.map((d) => formatDateValue({ date: d, time: entry.start?.time ?? '00:00' })).join(',')}`
        : `EXDATE:${values.map((d) => `${formatDateValue({ date: d, time: entry.start?.time ?? '00:00' })}${entry.zone === 'UTC' ? 'Z' : ''}`).join(',')}`);
  }

  if (entry.location) lines.push(`LOCATION:${escapeText(entry.location)}`);
  if (entry.description) lines.push(`DESCRIPTION:${escapeText(entry.description)}`);
  if (entry.note) lines.push(`X-GRT-NOTE:${entry.note}`);

  if (entry.kind === 'task') {
    lines.push(`STATUS:${entry.completed ? 'COMPLETED' : 'NEEDS-ACTION'}`);
    if (entry.completed) lines.push('PERCENT-COMPLETE:100');
    if (entry.priority) lines.push(`PRIORITY:${entry.priority}`);
  }

  for (const alarm of entry.alarms ?? []) {
    const before = Math.max(0, Math.round(alarm.before));
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(entry.summary || 'Reminder')}`, before ? `TRIGGER:-PT${before}M` : 'TRIGGER:PT0S', 'END:VALARM');
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
