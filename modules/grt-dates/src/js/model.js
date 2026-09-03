/** Calendars, events and tasks. */

import { newUid } from './ids.js';
import { expand } from './recurrence.js';
import {
  dayNumber, addDays, today, minutesOfDay, addMinutes, minutesBetween,
} from './time.js';

/** Calendar colours. */
export const COLOURS = [
  '#2e6b58', '#c43635', '#2b5f8a', '#e5a754',
  '#8b1e62', '#4a7c2f', '#a4551f', '#4b4b8f',
];

export function createModel() {
  return {
    directory: null,
    calendars: [],
    view: 'month',
    cursor: today(),
    selection: null,
    search: '',
  };
}

// Calendars

export function addCalendar(model, { name, path = null, entries = [], colour = null }) {
  const calendar = {
    id: newUid(),
    name,
    path,
    colour: colour ?? COLOURS[model.calendars.length % COLOURS.length],
    visible: true,
    dirty: path === null,
    entries,
  };
  model.calendars.push(calendar);
  return calendar;
}

export function calendarById(model, id) {
  return model.calendars.find((calendar) => calendar.id === id) ?? null;
}

export function removeCalendar(model, id) {
  const index = model.calendars.findIndex((calendar) => calendar.id === id);
  if (index === -1) return null;
  return model.calendars.splice(index, 1)[0];
}

export function visibleCalendars(model) {
  return model.calendars.filter((calendar) => calendar.visible);
}

/** A file name for a calendar, unique within the ones already loaded. */
export function fileNameFor(model, name) {
  const cleaned = String(name || 'Calendar')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim() || 'Calendar';

  const taken = new Set(model.calendars
    .filter((calendar) => calendar.path)
    .map((calendar) => calendar.path.split(/[/\\]/).pop().toLowerCase()));

  let candidate = `${cleaned}.ics`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${cleaned} ${n}.ics`;
    n += 1;
  }
  return candidate;
}

// Entries

/** A new event. Times are wall-clock and floating, with no zone attached. */
export function createEvent({
  summary = '', date = today(), time = '09:00', durationMinutes = 60,
  allDay = false, description = '', location = '',
} = {}) {
  const start = { date, time: allDay ? null : time, zone: null };
  const end = allDay
    ? { date: addDays(date, 1), time: null, zone: null }
    : { ...addMinutes({ date, time }, durationMinutes), zone: null };

  return {
    kind: 'event',
    uid: newUid(),
    summary,
    description,
    location,
    start,
    end,
    due: null,
    allDay,
    rrule: null,
    exdate: [],
    status: null,
    priority: 0,
    completed: false,
    note: null,
    extra: [],
  };
}

/** A new task. Tasks have a due date rather than a span. */
export function createTask({
  summary = '', due = today(), time = null, priority = 0,
} = {}) {
  return {
    kind: 'task',
    uid: newUid(),
    summary,
    description: '',
    location: '',
    start: null,
    end: null,
    due: due ? { date: due, time, zone: null } : null,
    allDay: time === null,
    rrule: null,
    exdate: [],
    status: 'NEEDS-ACTION',
    priority,
    completed: false,
    note: null,
    extra: [],
  };
}

export function addEntry(model, calendarId, entry) {
  const calendar = calendarById(model, calendarId);
  if (!calendar) return null;
  calendar.entries.push(entry);
  calendar.dirty = true;
  return entry;
}

export function updateEntry(model, uid, changes) {
  for (const calendar of model.calendars) {
    const entry = calendar.entries.find((item) => item.uid === uid);
    if (!entry) continue;
    Object.assign(entry, changes);
    calendar.dirty = true;
    return entry;
  }
  return null;
}

export function removeEntry(model, uid) {
  for (const calendar of model.calendars) {
    const index = calendar.entries.findIndex((item) => item.uid === uid);
    if (index === -1) continue;
    const [removed] = calendar.entries.splice(index, 1);
    calendar.dirty = true;
    return removed;
  }
  return null;
}

export function findEntry(model, uid) {
  for (const calendar of model.calendars) {
    const entry = calendar.entries.find((item) => item.uid === uid);
    if (entry) return { entry, calendar };
  }
  return null;
}

/** Removes one occurrence of a recurring entry, by excluding its date. */
export function excludeOccurrence(model, uid, date) {
  const found = findEntry(model, uid);
  if (!found) return null;
  if (!found.entry.exdate.includes(date)) found.entry.exdate.push(date);
  found.calendar.dirty = true;
  return found.entry;
}

// Querying

/** Every occurrence between two dates, from the calendars currently shown. */
export function occurrencesBetween(model, from, to) {
  const rows = [];
  const needle = model.search.trim().toLowerCase();

  for (const calendar of visibleCalendars(model)) {
    for (const entry of calendar.entries) {
      if (entry.kind !== 'event') continue;
      if (needle && !matches(entry, needle)) continue;

      for (const date of expand(entry, from, to)) {
        rows.push({
          entry,
          calendar,
          date,
          time: entry.allDay ? null : entry.start.time,
          minutes: entry.allDay ? 0 : minutesOfDay(entry.start.time),
          lengthMinutes: durationOf(entry),
        });
      }
    }
  }

  rows.sort((a, b) => (
    dayNumber(a.date) - dayNumber(b.date)
    || Number(b.entry.allDay) - Number(a.entry.allDay)
    || a.minutes - b.minutes
    || a.entry.summary.localeCompare(b.entry.summary)
  ));

  return rows;
}

/** Occurrences on one day. */
export function occurrencesOn(model, date) {
  return occurrencesBetween(model, date, date);
}

/** How long an event lasts, in minutes. */
export function durationOf(entry) {
  if (entry.allDay || !entry.start?.time || !entry.end?.time) return 1440;
  const span = minutesBetween(entry.start, entry.end);
  return span > 0 ? span : 60;
}

/**
 * Tasks from the visible calendars, optionally filtered by the search box.
 */
export function tasks(model, { includeCompleted = true } = {}) {
  const needle = model.search.trim().toLowerCase();
  const rows = [];

  for (const calendar of visibleCalendars(model)) {
    for (const entry of calendar.entries) {
      if (entry.kind !== 'task') continue;
      if (!includeCompleted && entry.completed) continue;
      if (needle && !matches(entry, needle)) continue;
      rows.push({ entry, calendar });
    }
  }

  // Incomplete first, then by due date, then by priority.
  rows.sort((a, b) => (
    Number(a.entry.completed) - Number(b.entry.completed)
    || dueOrder(a.entry) - dueOrder(b.entry)
    || priorityOrder(a.entry) - priorityOrder(b.entry)
    || a.entry.summary.localeCompare(b.entry.summary)
  ));

  return rows;
}

function dueOrder(entry) {
  return entry.due?.date ? dayNumber(entry.due.date) : Number.MAX_SAFE_INTEGER;
}

/** RFC 5545 priority: 1 is highest, 9 lowest, 0 means unset. */
function priorityOrder(entry) {
  return entry.priority > 0 ? entry.priority : 10;
}

function matches(entry, needle) {
  return `${entry.summary} ${entry.description} ${entry.location}`
    .toLowerCase()
    .includes(needle);
}

// Moving things

/** Moves an entry to another day, keeping its length and its time of day. */
export function moveTo(model, uid, date, time = null) {
  const found = findEntry(model, uid);
  if (!found || !found.entry.start) return null;

  const entry = found.entry;
  const length = durationOf(entry);

  if (entry.allDay) {
    const span = dayNumber(entry.end.date) - dayNumber(entry.start.date);
    entry.start = { date, time: null, zone: null };
    entry.end = { date: addDays(date, Math.max(1, span)), time: null, zone: null };
  } else {
    const start = { date, time: time ?? entry.start.time };
    entry.start = { ...start, zone: null };
    entry.end = { ...addMinutes(start, length), zone: null };
  }

  found.calendar.dirty = true;
  return entry;
}
