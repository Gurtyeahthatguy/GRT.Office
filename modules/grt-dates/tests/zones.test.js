/** Time zones and reminders: an invitation from another zone lands at the right local hour, across summer time on both sides. */

import { describe, it, expect, beforeAll } from 'vitest';
import { parse, serialise, durationMinutes } from '../src/js/ical.js';
import { zoneName, zoneResolver, toLocal, readTimezone } from '../src/js/zones.js';
import { createModel, addCalendar, occurrencesBetween, excludeOccurrence, moveTo } from '../src/js/model.js';
import { parseLine } from '../src/js/ical.js';

// The local clock of these tests is Rome's, whatever the machine's is.
beforeAll(() => {
  process.env.TZ = 'Europe/Rome';
});

const NEW_YORK = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];
const calendar = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const event = (...lines) => ['BEGIN:VEVENT', 'UID:e1', 'SUMMARY:Call', ...lines, 'END:VEVENT'];

function shown(text, from, to) {
  const parsed = parse(text);
  const model = createModel();
  addCalendar(model, { name: 'x', entries: parsed.entries, timezones: parsed.timezones, kept: parsed.kept });
  return { parsed, model, rows: occurrencesBetween(model, from, to).map((r) => `${r.date} ${r.time}`) };
}

describe('zone names', () => {
  it('knows the webview names, the Windows names and the prefixed names', () => {
    expect(zoneName('Europe/Rome')).toBe('Europe/Rome');
    expect(zoneName('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(zoneName('/mozilla.org/20070129_1/America/New_York')).toBe('America/New_York');
    expect(zoneName('Somewhere/Nowhere')).toBe(null);
  });
});

describe('an invitation from another zone', () => {
  it('lands at the right local hour, whatever names its zone', () => {
    const at = (tzid) => parse(calendar(...event(`DTSTART;TZID=${tzid}:20260115T180000`, `DTEND;TZID=${tzid}:20260115T190000`))).entries[0];
    expect(at('Asia/Tokyo').start).toEqual({ date: '2026-01-15', time: '10:00', zone: null });
    expect(at('"Tokyo Standard Time"').start).toEqual({ date: '2026-01-15', time: '10:00', zone: null });
    expect(at('/citadel.org/20190914_1/Asia/Tokyo').end).toEqual({ date: '2026-01-15', time: '11:00', zone: null });
  });

  it('keeps the hour as written when the zone is unknown, and says so', () => {
    const entry = parse(calendar(...event('DTSTART;TZID=Mars/Olympus:20260115T180000'))).entries[0];
    expect(entry.start.time).toBe('18:00');
    expect(entry.unknownZone).toBe('Mars/Olympus');
  });

  it('follows the rules of a VTIMEZONE whose name only the file knows', () => {
    const own = NEW_YORK.map((line) => line.replace('TZID:America/New_York', 'TZID:Eastern (own rules)'));
    const text = calendar(...own, ...event('DTSTART;TZID=Eastern (own rules):20260309T090000'));
    expect(parse(text).entries[0].start).toEqual({ date: '2026-03-09', time: '14:00', zone: null });
    const winter = calendar(...own, ...event('DTSTART;TZID=Eastern (own rules):20260115T090000'));
    expect(parse(winter).entries[0].start).toEqual({ date: '2026-01-15', time: '15:00', zone: null });
  });

  it('places each occurrence of a repeating meeting on the local clock, across both changes to summer time', () => {
    const text = calendar(...NEW_YORK, ...event('DTSTART;TZID=America/New_York:20260302T090000', 'DTEND;TZID=America/New_York:20260302T100000', 'RRULE:FREQ=WEEKLY;COUNT=5'));
    const { rows } = shown(text, '2026-03-01', '2026-04-05');
    // New York moves on 8 March, Rome on 29 March: three weeks at a five-hour gap instead of six.
    expect(rows).toEqual(['2026-03-02 15:00', '2026-03-09 14:00', '2026-03-16 14:00', '2026-03-23 14:00', '2026-03-30 15:00']);
  });

  it('keeps the zone and its rules when the file is written again', () => {
    const text = calendar(...NEW_YORK, ...event('DTSTART;TZID=America/New_York:20260302T090000', 'RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=America/New_York:20260316T090000'));
    const { parsed } = shown(text, '2026-03-01', '2026-04-05');
    const written = serialise(parsed);
    expect(written).toContain('DTSTART;TZID=America/New_York:20260302T090000');
    expect(written).toContain('EXDATE;TZID=America/New_York:20260316T090000');
    expect(written).toContain('BEGIN:VTIMEZONE\r\nTZID:America/New_York');
    expect(shown(written, '2026-03-01', '2026-04-05').rows).toEqual(['2026-03-02 15:00', '2026-03-09 14:00', '2026-03-23 14:00', '2026-03-30 15:00']);
  });

  it('removes one occurrence by the day it shows on, and a moved series takes the local clock', () => {
    const text = calendar(...event('DTSTART;TZID=Asia/Tokyo:20260105T070000', 'RRULE:FREQ=DAILY;COUNT=3'));
    const { model } = shown(text, '2026-01-01', '2026-01-10');
    // 07:00 in Tokyo is 23:00 the day before in Rome.
    expect(occurrencesBetween(model, '2026-01-01', '2026-01-10').map((r) => r.date)).toEqual(['2026-01-04', '2026-01-05', '2026-01-06']);
    excludeOccurrence(model, 'e1', '2026-01-05');
    expect(model.calendars[0].entries[0].exdate).toEqual(['2026-01-06']);
    moveTo(model, 'e1', '2026-01-04', '20:00');
    expect(model.calendars[0].entries[0].zone).toBe(null);
  });

  it('reads a series written in UTC per occurrence too', () => {
    const { rows } = shown(calendar(...event('DTSTART:20260323T140000Z', 'RRULE:FREQ=WEEKLY;COUNT=2')), '2026-03-20', '2026-04-05');
    expect(rows).toEqual(['2026-03-23 15:00', '2026-03-30 16:00']);
  });
});

describe('a VTIMEZONE from a hostile file', () => {
  it('reads no more than it should', () => {
    const rdates = Array.from({ length: 2000 }, (_, i) => `2026${String(1 + (i % 12)).padStart(2, '0')}01T000000`).join(',');
    const zone = readTimezone(['TZID:X', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', `RDATE:${rdates}`, 'END:STANDARD'].map(parseLine));
    expect(zone.observances[0].rdates.length).toBe(500);
    expect(zoneResolver([zone]).instant({ date: '2026-05-01', time: '12:00' }, 'X')).toBe(Date.UTC(2026, 4, 1, 11, 0));
    expect(toLocal({ date: '2026-05-01', time: '12:00' }, 'X', zoneResolver([zone]))).toEqual({ date: '2026-05-01', time: '13:00' });
  });
});

describe('reminders', () => {
  it('are read from VALARM and written back', () => {
    const text = calendar(...event('DTSTART:20260115T180000', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:PT0S', 'END:VALARM'));
    const parsed = parse(text);
    expect(parsed.entries[0].alarms).toEqual([{ before: 15 }]);
    const written = serialise(parsed);
    expect(written).toContain('BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Call\r\nTRIGGER:-PT15M\r\nEND:VALARM');
    // One it cannot express is kept whole, inside its own BEGIN and END.
    expect(written).toContain('BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;RELATED=END:PT0S\r\nEND:VALARM');
  });

  it('reads iCalendar durations', () => {
    expect(durationMinutes('-PT15M')).toBe(-15);
    expect(durationMinutes('P1D')).toBe(1440);
    expect(durationMinutes('PT1H30M')).toBe(90);
    expect(durationMinutes('P1W')).toBe(10080);
    expect(durationMinutes('P')).toBe(null);
    expect(durationMinutes('soon')).toBe(null);
  });

  it('gives an event without an end the length its DURATION says', () => {
    const entry = parse(calendar(...event('DTSTART:20260115T180000', 'DURATION:PT90M'))).entries[0];
    expect(entry.end).toEqual({ date: '2026-01-15', time: '19:30', zone: null });
  });
});

describe('reminders falling due', () => {
  it('are found between two moments, a day ahead included, and not twice', async () => {
    const { dueReminders } = await import('../src/js/reminders.js');
    const text = calendar(...event('DTSTART:20260115T180000', 'LOCATION:Room 4', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM'),
      'BEGIN:VEVENT', 'UID:e2', 'SUMMARY:Trip', 'DTSTART:20260116T080000', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'END:VALARM', 'END:VEVENT');
    const parsed = parse(text);
    const model = createModel();
    const hidden = addCalendar(model, { name: 'x', entries: parsed.entries });
    hidden.visible = false;
    model.search = 'nothing matches this';
    const at = (h, m) => new Date(2026, 0, 15, h, m).getTime();
    expect(dueReminders(model, at(7, 59), at(8, 0)).map((d) => d.entry.summary)).toEqual(['Trip']);
    expect(dueReminders(model, at(17, 40), at(17, 45)).map((d) => [d.entry.summary, d.time])).toEqual([['Call', '18:00']]);
    expect(dueReminders(model, at(17, 45), at(17, 50))).toEqual([]);
  });
});
