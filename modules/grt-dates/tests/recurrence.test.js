/** Recurrence expansion. */

import { describe, it, expect } from 'vitest';
import { parseRule, expand, describe as describeRule } from '../src/js/recurrence.js';
import { weekday, addDays } from '../src/js/time.js';

const event = (date, rrule = null, exdate = []) => ({
  start: { date, time: '10:00', zone: null },
  end: { date, time: '11:00', zone: null },
  allDay: false,
  rrule,
  exdate,
});

describe('parsing a rule', () => {
  it('reads the parts it implements', () => {
    const rule = parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10');
    expect(rule.freq).toBe('WEEKLY');
    expect(rule.interval).toBe(2);
    expect(rule.count).toBe(10);
    expect(rule.byday.map((d) => d.day)).toEqual([1, 3]);
    expect(rule.unsupported).toEqual([]);
  });

  it('reads an ordinal weekday', () => {
    expect(parseRule('FREQ=MONTHLY;BYDAY=2TU').byday).toEqual([{ ordinal: 2, day: 2 }]);
    expect(parseRule('FREQ=MONTHLY;BYDAY=-1FR').byday).toEqual([{ ordinal: -1, day: 5 }]);
  });

  it('reads UNTIL in both its forms', () => {
    expect(parseRule('FREQ=DAILY;UNTIL=20261231').until).toBe('2026-12-31');
    expect(parseRule('FREQ=DAILY;UNTIL=20261231T235959Z').until).toBe('2026-12-31');
  });

  it('names the parts it does not implement instead of ignoring them', () => {
    const rule = parseRule('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1;BYWEEKNO=3');
    expect(rule.unsupported).toContain('BYSETPOS');
    expect(rule.unsupported).toContain('BYWEEKNO');
    // What it does understand is still understood.
    expect(rule.freq).toBe('MONTHLY');
  });

  it('treats an interval of zero as one rather than looping forever', () => {
    expect(parseRule('FREQ=DAILY;INTERVAL=0').interval).toBe(1);
  });
});

describe('daily', () => {
  it('repeats every day', () => {
    const dates = expand(event('2026-09-01', 'FREQ=DAILY'), '2026-09-01', '2026-09-05');
    expect(dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
  });

  it('honours an interval', () => {
    const dates = expand(event('2026-09-01', 'FREQ=DAILY;INTERVAL=3'), '2026-09-01', '2026-09-10');
    expect(dates).toEqual(['2026-09-01', '2026-09-04', '2026-09-07', '2026-09-10']);
  });

  it('stops at COUNT, counted from the first occurrence', () => {
    const dates = expand(event('2026-09-01', 'FREQ=DAILY;COUNT=3'), '2026-09-01', '2026-09-30');
    expect(dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('counts occurrences before the window when applying COUNT', () => {
    // The fifth occurrence is the 5th; asking about the 4th onwards must not
    // restart the count.
    const dates = expand(event('2026-09-01', 'FREQ=DAILY;COUNT=5'), '2026-09-04', '2026-09-30');
    expect(dates).toEqual(['2026-09-04', '2026-09-05']);
  });

  it('stops at UNTIL', () => {
    const dates = expand(event('2026-09-01', 'FREQ=DAILY;UNTIL=20260903'), '2026-09-01', '2026-09-30');
    expect(dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });
});

describe('weekly', () => {
  it('repeats on the starting weekday when no day is named', () => {
    const dates = expand(event('2026-09-01', 'FREQ=WEEKLY'), '2026-09-01', '2026-09-30');
    expect(dates).toEqual(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
    for (const date of dates) expect(weekday(date)).toBe(2);
  });

  it('repeats on several named days', () => {
    const dates = expand(event('2026-09-01', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'), '2026-09-01', '2026-09-14');
    expect(dates).toEqual([
      '2026-09-02', '2026-09-04', '2026-09-07', '2026-09-09',
      '2026-09-11', '2026-09-14',
    ]);
  });

  it('honours a fortnightly interval', () => {
    const dates = expand(event('2026-09-01', 'FREQ=WEEKLY;INTERVAL=2'), '2026-09-01', '2026-10-31');
    expect(dates).toEqual(['2026-09-01', '2026-09-15', '2026-09-29', '2026-10-13', '2026-10-27']);
  });

  it('never produces a date before the event starts', () => {
    const dates = expand(event('2026-09-03', 'FREQ=WEEKLY;BYDAY=MO,TH'), '2026-08-01', '2026-09-30');
    expect(dates[0]).toBe('2026-09-03');
  });
});

describe('monthly', () => {
  it('repeats on the same day of the month', () => {
    const dates = expand(event('2026-01-15', 'FREQ=MONTHLY'), '2026-01-01', '2026-06-30');
    expect(dates).toEqual([
      '2026-01-15', '2026-02-15', '2026-03-15',
      '2026-04-15', '2026-05-15', '2026-06-15',
    ]);
  });

  it('skips months that have no such day rather than sliding into the next', () => {
    const dates = expand(event('2026-01-31', 'FREQ=MONTHLY;BYMONTHDAY=31'), '2026-01-01', '2026-06-30');
    expect(dates).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(dates).not.toContain('2026-03-03');
  });

  it('finds the second Tuesday of each month', () => {
    const dates = expand(event('2026-01-13', 'FREQ=MONTHLY;BYDAY=2TU'), '2026-01-01', '2026-04-30');
    expect(dates).toEqual(['2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14']);
    for (const date of dates) expect(weekday(date)).toBe(2);
  });

  it('finds the last Friday of each month', () => {
    const dates = expand(event('2026-01-30', 'FREQ=MONTHLY;BYDAY=-1FR'), '2026-01-01', '2026-04-30');
    expect(dates).toEqual(['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
    for (const date of dates) {
      expect(weekday(date)).toBe(5);
      // Nothing seven days later is still in the same month.
      expect(addDays(date, 7).slice(5, 7)).not.toBe(date.slice(5, 7));
    }
  });

  it('handles counting by month number', () => {
    const dates = expand(event('2026-01-15', 'FREQ=MONTHLY;INTERVAL=3'), '2026-01-01', '2026-12-31');
    expect(dates).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  });
});

describe('yearly', () => {
  it('repeats on the same date', () => {
    const dates = expand(event('2026-03-14', 'FREQ=YEARLY'), '2026-01-01', '2029-12-31');
    expect(dates).toEqual(['2026-03-14', '2027-03-14', '2028-03-14', '2029-03-14']);
  });

  it('restricts to named months', () => {
    const dates = expand(
      event('2026-01-15', 'FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=15'),
      '2026-01-01', '2027-12-31',
    );
    expect(dates).toEqual(['2026-01-15', '2026-07-15', '2027-01-15', '2027-07-15']);
  });
});

// exceptions over a full year

describe('a recurring event with exceptions, across a year', () => {
  it('drops exactly the excluded dates and nothing else', () => {
    const entry = event('2026-01-06', 'FREQ=MONTHLY;BYDAY=2TU', ['2026-08-11', '2026-12-08']);
    // The rule starts on the 6th but the second Tuesday of January is the
    // 13th.
    const dates = expand(entry, '2026-01-01', '2026-12-31');

    expect(dates).toEqual([
      '2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14',
      '2026-05-12', '2026-06-09', '2026-07-14',
      '2026-09-08', '2026-10-13', '2026-11-10',
    ]);
    expect(dates).toHaveLength(10);
    expect(dates).not.toContain('2026-08-11');
    expect(dates).not.toContain('2026-12-08');
  });

  it('CANARY: without the exceptions those two dates are produced', () => {
    // Proof that the assertions above are testing exclusion rather than a
    // rule that never generated those dates in the first place.
    const dates = expand(event('2026-01-06', 'FREQ=MONTHLY;BYDAY=2TU'), '2026-01-01', '2026-12-31');
    expect(dates).toContain('2026-08-11');
    expect(dates).toContain('2026-12-08');
    expect(dates).toHaveLength(12);
  });

  it('expands a weekly meeting over a whole year without drifting', () => {
    const dates = expand(event('2026-01-05', 'FREQ=WEEKLY'), '2026-01-01', '2026-12-31');
    expect(dates).toHaveLength(52);
    for (const date of dates) expect(weekday(date)).toBe(1);
    expect(dates[0]).toBe('2026-01-05');
    expect(dates[51]).toBe('2026-12-28');
  });

  it('does not drift across the daylight-saving transitions', () => {
    // European clocks moved on 2026-03-29 and 2026-10-25.
    const dates = expand(event('2026-03-01', 'FREQ=WEEKLY'), '2026-03-01', '2026-11-01');
    expect(dates).toContain('2026-03-29');
    expect(dates).toContain('2026-10-25');
    for (const date of dates) expect(weekday(date)).toBe(0);
  });
});

describe('events without a rule', () => {
  it('produces the single date when it is in range', () => {
    expect(expand(event('2026-09-10'), '2026-09-01', '2026-09-30')).toEqual(['2026-09-10']);
  });

  it('produces nothing when it is not', () => {
    expect(expand(event('2026-09-10'), '2026-10-01', '2026-10-31')).toEqual([]);
  });

  it('respects an exclusion even without a rule', () => {
    expect(expand(event('2026-09-10', null, ['2026-09-10']), '2026-09-01', '2026-09-30'))
      .toEqual([]);
  });
});

describe('rules in words', () => {
  it('describes the common cases', () => {
    expect(describeRule('FREQ=DAILY')).toBe('Daily');
    expect(describeRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')).toBe('Repeats every 2 weeks on Mon, Wed');
    expect(describeRule('FREQ=MONTHLY;COUNT=6')).toBe('Monthly, 6 times');
  });

  it('admits when a rule is only shown approximately', () => {
    expect(describeRule('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=TU')).toContain('approximately');
  });

  it('says nothing rather than guessing at an unreadable rule', () => {
    expect(describeRule('NONSENSE')).toBeNull();
    expect(describeRule('')).toBeNull();
  });
});
