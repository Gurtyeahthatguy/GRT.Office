/**
 * View layouts. These are pure functions from the model to the shape of the
 * screen, so they are testable without a browser.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { monthLayout, CELL_CAPACITY } from '../src/js/views/month.js';
import { weekLayout, placeSideBySide, DAY_MINUTES } from '../src/js/views/week.js';
import { agendaLayout } from '../src/js/views/agenda.js';
import {
  createModel, createEvent, addCalendar, addEntry,
} from '../src/js/model.js';

let model;
let calendar;

beforeEach(() => {
  model = createModel();
  calendar = addCalendar(model, { name: 'Personal' });
});

const add = (options) => {
  const event = createEvent(options);
  addEntry(model, calendar.id, event);
  return event;
};

describe('the month grid', () => {
  it('covers the month in whole weeks starting on Monday', () => {
    const layout = monthLayout(model, '2026-09-15', 1);
    expect(layout.weeks[0]).toHaveLength(7);
    expect(layout.weeks[0][0].date).toBe('2026-08-31');
    expect(layout.month).toBe(9);
    expect(layout.year).toBe(2026);
  });

  it('marks which cells belong to the month', () => {
    const layout = monthLayout(model, '2026-09-15', 1);
    const cells = layout.weeks.flat();
    expect(cells.find((c) => c.date === '2026-08-31').inMonth).toBe(false);
    expect(cells.find((c) => c.date === '2026-09-01').inMonth).toBe(true);
  });

  it('puts an event in the cell for its day', () => {
    add({ summary: 'Dentist', date: '2026-09-10', time: '11:00' });
    const cells = monthLayout(model, '2026-09-15', 1).weeks.flat();
    const cell = cells.find((c) => c.date === '2026-09-10');
    expect(cell.shown.map((r) => r.entry.summary)).toEqual(['Dentist']);
    expect(cell.total).toBe(1);
  });

  it('collapses a crowded day rather than overflowing the cell', () => {
    for (let i = 0; i < CELL_CAPACITY + 3; i += 1) {
      add({ summary: `Thing ${i}`, date: '2026-09-10', time: `0${i + 1}:00` });
    }
    const cell = monthLayout(model, '2026-09-15', 1).weeks.flat()
      .find((c) => c.date === '2026-09-10');

    expect(cell.shown).toHaveLength(CELL_CAPACITY);
    expect(cell.hidden).toBe(3);
    expect(cell.total).toBe(CELL_CAPACITY + 3);
  });

  it('drops a trailing week that is entirely outside and entirely empty', () => {
    // February 2026 starts on a Sunday and has 28 days, so a Monday-start
    // grid needs five rows; the sixth would be all March and all empty.
    const layout = monthLayout(model, '2026-02-15', 1);
    expect(layout.weeks.length).toBeLessThanOrEqual(6);
    const last = layout.weeks[layout.weeks.length - 1];
    expect(last.some((cell) => cell.inMonth || cell.total > 0)).toBe(true);
  });

  it('keeps a trailing week that has something in it', () => {
    add({ summary: 'Spillover', date: '2026-03-05' });
    const layout = monthLayout(model, '2026-02-15', 1);
    const cells = layout.weeks.flat();
    expect(cells.some((c) => c.date === '2026-03-05')).toBe(true);
  });
});

describe('the week grid', () => {
  it('has seven columns beginning on the week start', () => {
    const layout = weekLayout(model, '2026-09-10', { days: 7, weekStart: 1 });
    expect(layout.days).toHaveLength(7);
    expect(layout.days[0].date).toBe('2026-09-07');
    expect(layout.first).toBe('2026-09-07');
    expect(layout.last).toBe('2026-09-13');
  });

  it('has one column in day mode, for the day asked for', () => {
    const layout = weekLayout(model, '2026-09-10', { days: 1 });
    expect(layout.days).toHaveLength(1);
    expect(layout.days[0].date).toBe('2026-09-10');
  });

  it('separates all-day entries from timed ones', () => {
    add({ summary: 'Holiday', date: '2026-09-10', allDay: true });
    add({ summary: 'Meeting', date: '2026-09-10', time: '10:00' });

    const day = weekLayout(model, '2026-09-10', { days: 1 }).days[0];
    expect(day.allDay.map((r) => r.entry.summary)).toEqual(['Holiday']);
    expect(day.timed.map((r) => r.entry.summary)).toEqual(['Meeting']);
  });
});

describe('overlapping events', () => {
  const row = (start, end, summary) => ({
    minutes: Number(start.slice(0, 2)) * 60 + Number(start.slice(3)),
    entry: {
      summary,
      allDay: false,
      start: { date: '2026-09-10', time: start },
      end: { date: '2026-09-10', time: end },
    },
  });

  it('gives a lone event the whole column', () => {
    const [only] = placeSideBySide([row('09:00', '10:00', 'A')]);
    expect(only.lane).toBe(0);
    expect(only.lanes).toBe(1);
  });

  it('splits two that overlap', () => {
    const placed = placeSideBySide([
      row('09:00', '10:00', 'A'),
      row('09:30', '10:30', 'B'),
    ]);
    expect(placed.map((p) => p.lanes)).toEqual([2, 2]);
    expect(new Set(placed.map((p) => p.lane)).size).toBe(2);
  });

  it('keeps a chain of overlaps to one width', () => {
    // A overlaps B, B overlaps C, A and C do not touch.
    const placed = placeSideBySide([
      row('09:00', '10:00', 'A'),
      row('09:30', '11:00', 'B'),
      row('10:30', '11:30', 'C'),
    ]);
    expect(placed.every((p) => p.lanes === 2)).toBe(true);
  });

  it('reuses a lane once it is free', () => {
    const placed = placeSideBySide([
      row('09:00', '10:00', 'A'),
      row('09:00', '11:00', 'B'),
      row('10:30', '11:30', 'C'),
    ]);
    const byName = Object.fromEntries(placed.map((p) => [p.entry.summary, p]));
    expect(byName.C.lane).toBe(byName.A.lane);
  });

  it('starts a fresh cluster once nothing overlaps', () => {
    const placed = placeSideBySide([
      row('09:00', '10:00', 'A'),
      row('09:30', '10:30', 'B'),
      row('14:00', '15:00', 'C'),
    ]);
    const alone = placed.find((p) => p.entry.summary === 'C');
    expect(alone.lanes).toBe(1);
  });

  it('gives a very short event a clickable height', () => {
    const [tiny] = placeSideBySide([row('09:00', '09:05', 'A')]);
    expect(tiny.end - tiny.start).toBeGreaterThanOrEqual(15);
  });

  it('does not run an event past the end of the day', () => {
    const [late] = placeSideBySide([row('23:30', '00:30', 'A')]);
    expect(late.end).toBeLessThanOrEqual(DAY_MINUTES);
  });
});

describe('the agenda', () => {
  it('lists only days that have something on them', () => {
    add({ summary: 'One', date: '2026-09-10' });
    add({ summary: 'Two', date: '2026-09-14' });

    const layout = agendaLayout(model, '2026-09-01', 30);
    expect(layout.days.map((d) => d.date)).toEqual(['2026-09-10', '2026-09-14']);
  });

  it('is empty when nothing is coming, rather than a wall of blank days', () => {
    expect(agendaLayout(model, '2026-09-01', 30).days).toEqual([]);
  });

  it('keeps the days in order', () => {
    add({ summary: 'Later', date: '2026-09-20' });
    add({ summary: 'Sooner', date: '2026-09-02' });

    const dates = agendaLayout(model, '2026-09-01', 30).days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
  });
});
