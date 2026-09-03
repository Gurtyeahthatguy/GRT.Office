/** iCalendar reading and writing. */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import {
  parse, serialise, unfold, fold, parseLine, escapeText, unescapeText,
  parseDateValue, formatDateValue, PRODID, FIXED_DTSTAMP,
  allDayEndFor, allDayLastDay,
} from '../src/js/ical.js';
import { createEvent, createTask } from '../src/js/model.js';

const hostname = os.hostname();
const username = os.userInfo().username;

function calendarWith(entries, name = 'Personal') {
  return serialise({ name, entries });
}

// nothing identifying gets written

describe('a written calendar identifies nobody', () => {
  it('puts no hostname or user name in any UID', () => {
    const text = calendarWith([
      createEvent({ summary: 'Dentist', date: '2026-09-10' }),
      createEvent({ summary: 'Lunch', date: '2026-09-11' }),
    ]);

    const uids = [...text.matchAll(/^UID:(.*)$/gm)].map((m) => m[1]);
    expect(uids).toHaveLength(2);

    for (const uid of uids) {
      expect(uid).not.toContain('@');
      expect(uid.toLowerCase()).not.toContain(hostname.toLowerCase());
      expect(uid.toLowerCase()).not.toContain(username.toLowerCase());
    }
  });

  it('CANARY: the same check does find a hostname when one is present', () => {
    // If this fails, the assertions above have gone vacuous and prove
    // nothing.
    const fake = `UID:abc@${hostname}`;
    const uid = /^UID:(.*)$/m.exec(fake)[1];
    expect(uid.toLowerCase()).toContain(hostname.toLowerCase());
  });

  it('names no software and no version in PRODID', () => {
    const text = calendarWith([createEvent({ summary: 'Thing' })]);
    expect(text).toContain(`PRODID:${PRODID}`);
    expect(PRODID).not.toMatch(/\d+\.\d+/);
    expect(text).not.toMatch(/PRODID:.*\d+\.\d+/);
  });

  it('CANARY: the PRODID version check does catch a version', () => {
    expect('PRODID:-//Acme//Calendar 3.2//EN').toMatch(/PRODID:.*\d+\.\d+/);
  });

  it('writes a constant DTSTAMP rather than the time of writing', () => {
    const text = calendarWith([createEvent({ summary: 'Thing' })]);
    const stamps = [...text.matchAll(/^DTSTAMP:(.*)$/gm)].map((m) => m[1]);
    expect(stamps).toEqual([FIXED_DTSTAMP]);
    expect(stamps[0]).toBe('19800101T000000Z');
  });

  it('writes no CREATED, LAST-MODIFIED or TZID at all', () => {
    const text = calendarWith([
      createEvent({ summary: 'Thing', date: '2026-09-10', time: '10:00' }),
    ]);
    expect(text).not.toContain('CREATED');
    expect(text).not.toContain('LAST-MODIFIED');
    expect(text).not.toContain('TZID');
  });

  it('CANARY: those absence checks would catch the fields if written', () => {
    const withThem = 'CREATED:20260101T000000Z\r\nTZID:Europe/Rome';
    expect(withThem).toContain('CREATED');
    expect(withThem).toContain('TZID');
  });

  it('discards timestamps that arrived from another program', () => {
    const incoming = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:kept-1',
      'SUMMARY:Imported',
      'DTSTART:20260910T100000',
      'DTSTAMP:20250101T120000Z',
      'CREATED:20250101T120000Z',
      'LAST-MODIFIED:20250601T080000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const out = serialise({ entries: parse(incoming).entries });
    expect(out).not.toContain('20250101T120000Z');
    expect(out).not.toContain('20250601T080000Z');
    expect(out).toContain(`DTSTAMP:${FIXED_DTSTAMP}`);
  });
});

// two saves are byte-identical

describe('determinism', () => {
  it('produces identical bytes for the same calendar twice', () => {
    const entries = [
      createEvent({ summary: 'B', date: '2026-09-11' }),
      createEvent({ summary: 'A', date: '2026-09-10' }),
    ];
    expect(calendarWith(entries)).toBe(calendarWith(entries));
  });

  it('does not depend on the order entries happen to be in', () => {
    const a = createEvent({ summary: 'A', date: '2026-09-10' });
    const b = createEvent({ summary: 'B', date: '2026-09-11' });
    expect(calendarWith([a, b])).toBe(calendarWith([b, a]));
  });

  it('survives a full round trip unchanged', () => {
    const once = calendarWith([
      createEvent({ summary: 'Standup', date: '2026-09-10', time: '09:15' }),
      createTask({ summary: 'File the thing', due: '2026-09-12' }),
    ]);
    const twice = serialise({ name: 'Personal', entries: parse(once).entries });
    expect(twice).toBe(once);
  });
});

// what we cannot interpret, we keep

describe('preserving what is not understood', () => {
  const exotic = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:exotic-1',
    'SUMMARY:Board meeting',
    'DTSTART:20260107T140000',
    'RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1;WKST=MO',
    'ATTENDEE;CN=Someone:mailto:someone@example.org',
    'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
    'GEO:41.9;12.5',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('keeps a recurrence rule it cannot fully expand, character for character', () => {
    const { entries } = parse(exotic);
    expect(entries[0].rrule).toBe('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1;WKST=MO');

    const out = serialise({ entries });
    expect(out).toContain('RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1;WKST=MO');
  });

  it('keeps properties it has never heard of', () => {
    const out = serialise({ entries: parse(exotic).entries });
    expect(out).toContain('X-MICROSOFT-CDO-BUSYSTATUS:BUSY');
    expect(out).toContain('GEO:41.9;12.5');
    expect(out).toContain('ATTENDEE;CN=Someone:mailto:someone@example.org');
  });

  it('is stable: saving twice does not accumulate or lose anything', () => {
    const first = serialise({ entries: parse(exotic).entries });
    const second = serialise({ entries: parse(first).entries });
    expect(second).toBe(first);
  });

  it('reports components it kept but does not display', () => {
    const withAlarm = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Rome',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART:20260910T100000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(parse(withAlarm).unsupported).toContain('VTIMEZONE');
  });
});

// Line handling

describe('folding', () => {
  it('unfolds continuation lines', () => {
    expect(unfold('SUMMARY:A very\r\n  long title')).toBe('SUMMARY:A very long title');
  });

  it('accepts bare newlines, which real files use', () => {
    expect(unfold('SUMMARY:A\n B')).toBe('SUMMARY:AB');
  });

  it('folds long lines at 75 octets', () => {
    const folded = fold(`SUMMARY:${'x'.repeat(200)}`);
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(76);
    }
  });

  it('never splits a multi-byte character', () => {
    const folded = fold(`SUMMARY:${'è'.repeat(120)}`);
    // A split character would not survive the decode.
    expect(unfold(folded)).toBe(`SUMMARY:${'è'.repeat(120)}`);
  });

  it('round-trips a long accented title through a whole file', () => {
    const summary = `Riunione ${'à'.repeat(90)} finale`;
    const text = calendarWith([createEvent({ summary, date: '2026-09-10' })]);
    expect(parse(text).entries[0].summary).toBe(summary);
  });
});

describe('parsing a line', () => {
  it('splits name, parameters and value', () => {
    const line = parseLine('DTSTART;TZID=Europe/Rome;VALUE=DATE-TIME:20260910T100000');
    expect(line.name).toBe('DTSTART');
    expect(line.params.TZID).toBe('Europe/Rome');
    expect(line.value).toBe('20260910T100000');
  });

  it('ignores a colon inside a quoted parameter', () => {
    const line = parseLine('ATTENDEE;CN="Smith:Jones":mailto:a@b.c');
    expect(line.params.CN).toBe('Smith:Jones');
    expect(line.value).toBe('mailto:a@b.c');
  });
});

describe('text escaping', () => {
  it('escapes and unescapes the four special forms', () => {
    const original = 'A; B, C\\D\nE';
    expect(unescapeText(escapeText(original))).toBe(original);
  });

  it('escapes each special character exactly once', () => {
    // String.raw so the expected value says what it means.
    expect(escapeText('a;b')).toBe(String.raw`a\;b`);
    expect(escapeText('a,b')).toBe(String.raw`a\,b`);
    expect(escapeText(String.raw`a\b`)).toBe(String.raw`a\\b`);
  });

  it('carries a multi-line description through a file', () => {
    const description = 'Line one\nLine two; with a semicolon, and a comma';
    const event = createEvent({ summary: 'X', date: '2026-09-10', description });
    const back = parse(calendarWith([event])).entries[0];
    expect(back.description).toBe(description);
  });
});

// Dates and times

describe('date values', () => {
  it('reads an all-day value', () => {
    expect(parseDateValue('20260910', { VALUE: 'DATE' }))
      .toEqual({ date: '2026-09-10', time: null, zone: null });
  });

  it('reads a floating date-time', () => {
    expect(parseDateValue('20260910T100000'))
      .toEqual({ date: '2026-09-10', time: '10:00', zone: null });
  });

  it('notices a UTC value', () => {
    expect(parseDateValue('20260910T100000Z').zone).toBe('UTC');
  });

  it('notices a named zone', () => {
    expect(parseDateValue('20260910T100000', { TZID: 'Europe/Rome' }).zone)
      .toBe('Europe/Rome');
  });

  it('writes floating values with no zone marker', () => {
    expect(formatDateValue({ date: '2026-09-10', time: '10:00' }))
      .toBe('20260910T100000');
    expect(formatDateValue({ date: '2026-09-10', time: null })).toBe('20260910');
  });
});

describe('all-day events', () => {
  it('treats DTEND as exclusive', () => {
    expect(allDayEndFor('2026-09-10')).toBe('2026-09-11');
    expect(allDayLastDay('2026-09-11')).toBe('2026-09-10');
  });

  it('does not make a one-day event two days long on a round trip', () => {
    const event = createEvent({ summary: 'Holiday', date: '2026-09-10', allDay: true });
    const text = calendarWith([event]);
    expect(text).toContain('DTSTART;VALUE=DATE:20260910');
    expect(text).toContain('DTEND;VALUE=DATE:20260911');

    const back = parse(text).entries[0];
    expect(back.allDay).toBe(true);
    expect(back.start.date).toBe('2026-09-10');
    expect(allDayLastDay(back.end.date)).toBe('2026-09-10');
  });
});

// Tasks

describe('tasks', () => {
  it('writes a task as VTODO with its status', () => {
    const text = calendarWith([createTask({ summary: 'Post the form', due: '2026-09-15' })]);
    expect(text).toContain('BEGIN:VTODO');
    expect(text).toContain('STATUS:NEEDS-ACTION');
    expect(text).toContain('DUE;VALUE=DATE:20260915');
  });

  it('reads a completed task back as completed', () => {
    const task = createTask({ summary: 'Done thing', due: '2026-09-15' });
    task.completed = true;
    const back = parse(calendarWith([task])).entries[0];
    expect(back.kind).toBe('task');
    expect(back.completed).toBe(true);
  });
});

// Whole files

describe('reading a whole file', () => {
  it('reads the calendar name and both kinds of entry', () => {
    const text = calendarWith([
      createEvent({ summary: 'Meeting', date: '2026-09-10', time: '10:00' }),
      createTask({ summary: 'Task', due: '2026-09-11' }),
    ], 'Work');

    const parsed = parse(text);
    expect(parsed.name).toBe('Work');
    expect(parsed.entries.filter((e) => e.kind === 'event')).toHaveLength(1);
    expect(parsed.entries.filter((e) => e.kind === 'task')).toHaveLength(1);
  });

  it('gives an entry with no UID one of its own', () => {
    const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Nameless\r\nDTSTART:20260910\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const entry = parse(text).entries[0];
    expect(entry.uid).toBeTruthy();
    expect(entry.uid).not.toContain('@');
  });

  it('does not fall over on an empty file', () => {
    expect(parse('').entries).toEqual([]);
    expect(parse('BEGIN:VCALENDAR\r\nEND:VCALENDAR').entries).toEqual([]);
  });
});
