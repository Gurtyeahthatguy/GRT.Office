/** Reminders: which ones fall due between two moments, worked out from the events shown, with no network and nothing scheduled outside the program. */

import { occurrencesBetween } from './model.js';
import { addDays, today, dayNumber, parseDate } from './time.js';

/** The choices the event dialog offers, in minutes before the start. */
export const REMINDERS = [
  ['', 'No reminder'], ['0', 'At the start'], ['5', '5 minutes before'], ['10', '10 minutes before'], ['15', '15 minutes before'],
  ['30', '30 minutes before'], ['60', '1 hour before'], ['120', '2 hours before'], ['1440', '1 day before'],
];

/** A local wall-clock reading as an instant. */
function instantOf(date, time) {
  const { year, month, day } = parseDate(date);
  const [hour, minute] = (time ?? '00:00').split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/**
 * The reminders that fall due after `from` and up to `to`, both instants in milliseconds.
 * @returns {{key: string, entry: object, date: string, time: ?string, at: number}[]}
 */
export function dueReminders(model, from, to) {
  if (!(to > from)) return [];
  const first = today(new Date(from));
  // The longest reminder offered is a day, so tomorrow's and the day after's events can be due now.
  const last = addDays(today(new Date(to)), 2);
  if (dayNumber(last) - dayNumber(first) > 40) return [];
  // Every calendar reminds, shown or hidden, whatever the search box holds.
  const everything = { ...model, search: '', calendars: model.calendars.map((c) => ({ ...c, visible: true })) };
  const out = [];
  for (const row of occurrencesBetween(everything, first, last)) {
    for (const alarm of row.entry.alarms ?? []) {
      const at = instantOf(row.date, row.time) - alarm.before * 60000;
      if (at > from && at <= to) out.push({ key: `${row.entry.uid}|${row.date}|${alarm.before}`, entry: row.entry, date: row.date, time: row.time, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What a reminder says: the title, and when and where. */
export function reminderText(due) {
  const when = due.time ? `${due.time}` : 'Today';
  return {
    summary: due.entry.summary || 'Event',
    body: [when, due.entry.location].filter(Boolean).join(', '),
  };
}
