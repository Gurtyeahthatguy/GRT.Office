/** Calendars made to hurt the reader: each one opens or gives an error, quickly. */

import { describe, it, expect } from 'vitest';
import { parse } from '../src/js/ical.js';
import { expand } from '../src/js/recurrence.js';

function quickly(work, seconds = 5) {
  const start = performance.now();
  let result;
  try {
    result = work();
  } catch (err) {
    expect(err).not.toBeInstanceOf(RangeError);
  }
  expect((performance.now() - start) / 1000).toBeLessThan(seconds);
  return result;
}

const event = (i, extra = '') => `BEGIN:VEVENT\r\nUID:${i}\r\nDTSTART;VALUE=DATE:20260101\r\nSUMMARY:Event ${i}\r\n${extra}END:VEVENT\r\n`;
const calendar = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;

describe('a calendar made to hurt the reader', () => {
  it('two hundred thousand events', () => {
    const result = quickly(() => parse(calendar(Array.from({ length: 200000 }, (_, i) => event(i)).join(''))), 10);
    expect(result.entries.length).toBe(200000);
  });

  it('components opened a hundred thousand times and never closed', () => {
    quickly(() => parse(calendar('BEGIN:VALARM\r\n'.repeat(100000))));
  });

  it('one line folded into ten megabytes', () => {
    quickly(() => parse(calendar(event(1, `DESCRIPTION:${'x'.repeat(74)}\r\n ${'y'.repeat(73)}\r\n `.repeat(70000)))));
  });

  it('rules that never end, or never move', () => {
    for (const rrule of ['FREQ=DAILY;INTERVAL=0', 'FREQ=WEEKLY;INTERVAL=-1', 'FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=2', 'FREQ=YEARLY;BYSETPOS=-400;BYDAY=MO',
      'FREQ=DAILY;COUNT=999999999999', 'FREQ=MONTHLY;INTERVAL=99999999999', 'FREQ=SECONDLY', `FREQ=DAILY;BYDAY=${'MO,'.repeat(10000)}TU`]) {
      quickly(() => expand({ start: { date: '2026-01-01' }, rrule: rrule }, '2026-01-01', '2126-12-31'));
    }
  });
});
