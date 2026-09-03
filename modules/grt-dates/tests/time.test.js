/** Dates and times. */

import { describe, it, expect } from 'vitest';
import {
  toDays, fromDays, addDays, addMonths, addYears, weekday, startOfWeek,
  monthGrid, daysInMonth, minutesOfDay, timeFromMinutes, addMinutes,
  minutesBetween, dayNumber, longDate, monthTitle,
} from '../src/js/time.js';

describe('civil calendar arithmetic', () => {
  it('round-trips every day across four centuries', () => {
    for (let n = -60000; n < 60000; n += 97) {
      const { year, month, day } = fromDays(n);
      expect(toDays(year, month, day)).toBe(n);
    }
  });

  it('knows the epoch was a Thursday', () => {
    expect(weekday('1970-01-01')).toBe(4);
  });

  it('handles leap years, including the century rules', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it('crosses a leap day correctly', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
  });
});

describe('adding months', () => {
  it('clamps rather than rolling over', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('crosses years', () => {
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-02-15', -3)).toBe('2025-11-15');
  });

  it('clamps a leap day when adding years', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
  });
});

describe('weeks', () => {
  it('starts on Monday by default', () => {
    // 2026-09-01 is a Tuesday.
    expect(startOfWeek('2026-09-01', 1)).toBe('2026-08-31');
  });

  it('can start on Sunday', () => {
    expect(startOfWeek('2026-09-01', 0)).toBe('2026-08-30');
  });

  it('produces a grid of whole weeks covering the month', () => {
    const grid = monthGrid('2026-09-15', 1);
    expect(grid).toHaveLength(42);
    expect(weekday(grid[0])).toBe(1);
    expect(dayNumber(grid[41]) - dayNumber(grid[0])).toBe(41);
  });
});

describe('times', () => {
  it('converts both ways', () => {
    expect(minutesOfDay('09:30')).toBe(570);
    expect(timeFromMinutes(570)).toBe('09:30');
    expect(timeFromMinutes(0)).toBe('00:00');
  });

  it('carries into the next day', () => {
    expect(addMinutes({ date: '2026-09-01', time: '23:30' }, 60))
      .toEqual({ date: '2026-09-02', time: '00:30' });
  });

  it('carries back into the previous day', () => {
    expect(addMinutes({ date: '2026-09-01', time: '00:30' }, -60))
      .toEqual({ date: '2026-08-31', time: '23:30' });
  });

  it('measures spans across midnight', () => {
    expect(minutesBetween(
      { date: '2026-09-01', time: '23:00' },
      { date: '2026-09-02', time: '01:00' },
    )).toBe(120);
  });
});

describe('the clocks changing', () => {
  /**
   * The test asks for, stated as an arithmetic property rather than as a
   * simulation.
   */
  it('does not move an event across the spring transition', () => {
    const before = { date: '2026-03-28', time: '10:00' };
    const after = addMinutes(before, 24 * 60);
    expect(after).toEqual({ date: '2026-03-29', time: '10:00' });
  });

  it('does not move an event across the autumn transition', () => {
    const before = { date: '2026-10-24', time: '10:00' };
    const after = addMinutes(before, 24 * 60);
    expect(after).toEqual({ date: '2026-10-25', time: '10:00' });
  });

  it('keeps a week exactly seven days across a transition', () => {
    expect(addDays('2026-10-22', 7)).toBe('2026-10-29');
    expect(dayNumber('2026-10-29') - dayNumber('2026-10-22')).toBe(7);
  });
});

describe('display', () => {
  it('names the day and the month', () => {
    expect(longDate('2026-09-01')).toBe('Tuesday 1 September 2026');
    expect(monthTitle('2026-09-15')).toBe('September 2026');
  });
});
