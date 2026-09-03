/** The model: calendars, entries, and what the views ask it for. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createModel, createEvent, createTask, addCalendar, addEntry, updateEntry,
  removeEntry, findEntry, excludeOccurrence, calendarById, removeCalendar,
  visibleCalendars, occurrencesBetween, occurrencesOn, durationOf, tasks,
  moveTo, fileNameFor, COLOURS,
} from '../src/js/model.js';

let model;
let personal;

beforeEach(() => {
  model = createModel();
  personal = addCalendar(model, { name: 'Personal' });
});

describe('calendars', () => {
  it('gives each a distinct colour', () => {
    const work = addCalendar(model, { name: 'Work' });
    expect(work.colour).not.toBe(personal.colour);
    expect(COLOURS).toContain(work.colour);
  });

  it('marks a calendar with no file as needing to be saved', () => {
    expect(personal.dirty).toBe(true);
    const opened = addCalendar(model, { name: 'Work', path: '/tmp/work.ics' });
    expect(opened.dirty).toBe(false);
  });

  it('finds and removes by id', () => {
    expect(calendarById(model, personal.id)).toBe(personal);
    expect(removeCalendar(model, personal.id)).toBe(personal);
    expect(calendarById(model, personal.id)).toBeNull();
  });

  it('reports only the ones that are showing', () => {
    const work = addCalendar(model, { name: 'Work' });
    work.visible = false;
    expect(visibleCalendars(model)).toEqual([personal]);
  });
});

describe('entries', () => {
  it('adds, finds, updates and removes', () => {
    const event = createEvent({ summary: 'Dentist', date: '2026-09-10' });
    addEntry(model, personal.id, event);

    expect(findEntry(model, event.uid).entry).toBe(event);

    updateEntry(model, event.uid, { summary: 'Dentist, moved' });
    expect(event.summary).toBe('Dentist, moved');

    expect(removeEntry(model, event.uid)).toBe(event);
    expect(findEntry(model, event.uid)).toBeNull();
  });

  it('marks the calendar as changed on every mutation', () => {
    const opened = addCalendar(model, { name: 'Work', path: '/tmp/work.ics' });
    expect(opened.dirty).toBe(false);

    addEntry(model, opened.id, createEvent({ summary: 'X' }));
    expect(opened.dirty).toBe(true);
  });

  it('gives a new event an end an hour after its start', () => {
    const event = createEvent({ date: '2026-09-10', time: '09:00' });
    expect(event.end).toEqual({ date: '2026-09-10', time: '10:00', zone: null });
    expect(durationOf(event)).toBe(60);
  });

  it('gives an all-day event an exclusive end on the next day', () => {
    const event = createEvent({ date: '2026-09-10', allDay: true });
    expect(event.start.time).toBeNull();
    expect(event.end.date).toBe('2026-09-11');
  });

  it('never attaches a timezone to anything it creates', () => {
    const event = createEvent({ date: '2026-09-10', time: '09:00' });
    expect(event.start.zone).toBeNull();
    expect(event.end.zone).toBeNull();
  });
});

describe('occurrences', () => {
  beforeEach(() => {
    addEntry(model, personal.id, createEvent({
      summary: 'Standup', date: '2026-09-07', time: '09:15',
    }));
    const weekly = createEvent({ summary: 'Review', date: '2026-09-07', time: '15:00' });
    weekly.rrule = 'FREQ=WEEKLY';
    addEntry(model, personal.id, weekly);
  });

  it('returns one row per occurrence, not per entry', () => {
    const rows = occurrencesBetween(model, '2026-09-01', '2026-09-30');
    expect(rows.filter((r) => r.entry.summary === 'Review')).toHaveLength(4);
    expect(rows.filter((r) => r.entry.summary === 'Standup')).toHaveLength(1);
  });

  it('sorts by date, then all-day first, then by time', () => {
    const holiday = createEvent({ summary: 'Holiday', date: '2026-09-07', allDay: true });
    addEntry(model, personal.id, holiday);

    const rows = occurrencesOn(model, '2026-09-07');
    expect(rows.map((r) => r.entry.summary)).toEqual(['Holiday', 'Standup', 'Review']);
  });

  it('leaves out calendars that are hidden', () => {
    personal.visible = false;
    expect(occurrencesBetween(model, '2026-09-01', '2026-09-30')).toEqual([]);
  });

  it('filters by the search text, across title, place and notes', () => {
    model.search = 'review';
    expect(occurrencesOn(model, '2026-09-07').map((r) => r.entry.summary)).toEqual(['Review']);

    model.search = 'nothing here';
    expect(occurrencesOn(model, '2026-09-07')).toEqual([]);
  });

  it('excludes one occurrence without touching the rest', () => {
    const review = personal.entries.find((e) => e.summary === 'Review');
    excludeOccurrence(model, review.uid, '2026-09-14');

    const dates = occurrencesBetween(model, '2026-09-01', '2026-09-30')
      .filter((r) => r.entry.summary === 'Review')
      .map((r) => r.date);

    expect(dates).toEqual(['2026-09-07', '2026-09-21', '2026-09-28']);
    expect(review.rrule).toBe('FREQ=WEEKLY');
  });
});

describe('tasks', () => {
  beforeEach(() => {
    addEntry(model, personal.id, createTask({ summary: 'Later', due: '2026-09-20' }));
    addEntry(model, personal.id, createTask({ summary: 'Sooner', due: '2026-09-10' }));
    addEntry(model, personal.id, createTask({ summary: 'No deadline', due: null }));
    const done = createTask({ summary: 'Done', due: '2026-09-01' });
    done.completed = true;
    addEntry(model, personal.id, done);
  });

  it('puts unfinished first, then by due date, with undated last', () => {
    expect(tasks(model).map((r) => r.entry.summary))
      .toEqual(['Sooner', 'Later', 'No deadline', 'Done']);
  });

  it('can leave out what is finished', () => {
    expect(tasks(model, { includeCompleted: false }).map((r) => r.entry.summary))
      .not.toContain('Done');
  });

  it('sorts a high priority above a low one on the same day', () => {
    const model2 = createModel();
    const cal = addCalendar(model2, { name: 'C' });
    addEntry(model2, cal.id, createTask({ summary: 'Low', due: '2026-09-10', priority: 9 }));
    addEntry(model2, cal.id, createTask({ summary: 'High', due: '2026-09-10', priority: 1 }));
    expect(tasks(model2).map((r) => r.entry.summary)).toEqual(['High', 'Low']);
  });

  it('keeps tasks out of the calendar grid', () => {
    expect(occurrencesBetween(model, '2026-09-01', '2026-09-30')).toEqual([]);
  });
});

describe('moving an entry', () => {
  it('keeps its length and its time of day', () => {
    const event = createEvent({ date: '2026-09-10', time: '14:00', durationMinutes: 90 });
    addEntry(model, personal.id, event);

    moveTo(model, event.uid, '2026-09-12');
    expect(event.start).toEqual({ date: '2026-09-12', time: '14:00', zone: null });
    expect(durationOf(event)).toBe(90);
  });

  it('can move it to another time as well as another day', () => {
    const event = createEvent({ date: '2026-09-10', time: '14:00', durationMinutes: 90 });
    addEntry(model, personal.id, event);

    moveTo(model, event.uid, '2026-09-12', '08:30');
    expect(event.start.time).toBe('08:30');
    expect(event.end.time).toBe('10:00');
  });

  it('keeps the span of a multi-day all-day event', () => {
    const event = createEvent({ date: '2026-09-10', allDay: true });
    event.end = { date: '2026-09-14', time: null, zone: null };
    addEntry(model, personal.id, event);

    moveTo(model, event.uid, '2026-10-01');
    expect(event.start.date).toBe('2026-10-01');
    expect(event.end.date).toBe('2026-10-05');
  });

  it('does not drift when moved across a clock change', () => {
    const event = createEvent({ date: '2026-10-24', time: '10:00', durationMinutes: 60 });
    addEntry(model, personal.id, event);

    moveTo(model, event.uid, '2026-10-26');
    expect(event.start.time).toBe('10:00');
    expect(event.end.time).toBe('11:00');
  });
});

describe('naming a calendar file', () => {
  it('turns a name into a file name', () => {
    expect(fileNameFor(model, 'Work')).toBe('Work.ics');
  });

  it('keeps letters from any alphabet', () => {
    expect(fileNameFor(model, 'Università')).toBe('Università.ics');
    expect(fileNameFor(model, 'Календарь')).toBe('Календарь.ics');
  });

  it('strips what a filesystem would object to', () => {
    expect(fileNameFor(model, 'Work/Home')).toBe('WorkHome.ics');
    expect(fileNameFor(model, '../../etc/passwd')).toBe('etcpasswd.ics');
  });

  it('falls back rather than producing a nameless file', () => {
    expect(fileNameFor(model, '///')).toBe('Calendar.ics');
    expect(fileNameFor(model, '')).toBe('Calendar.ics');
  });

  it('does not hand back a name that is already in use', () => {
    addCalendar(model, { name: 'Work', path: '/home/x/GRT Calendar/Work.ics' });
    expect(fileNameFor(model, 'Work')).toBe('Work 2.ics');

    addCalendar(model, { name: 'Work', path: '/home/x/GRT Calendar/Work 2.ics' });
    expect(fileNameFor(model, 'Work')).toBe('Work 3.ics');
  });

  it('compares without regard to case, since some filesystems do not', () => {
    addCalendar(model, { name: 'Work', path: '/home/x/GRT Calendar/work.ics' });
    expect(fileNameFor(model, 'Work')).toBe('Work 2.ics');
  });
});
