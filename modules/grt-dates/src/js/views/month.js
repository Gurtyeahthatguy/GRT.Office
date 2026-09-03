/** The month grid. */

import { monthGrid, parseDate, today, dayNumber } from '../time.js';
import { occurrencesBetween } from '../model.js';

/** How many entries fit in a cell before it collapses to "+n more". */
export const CELL_CAPACITY = 3;

/**
 * @param {Object} model
 * @param {string} cursor any date in the month to show
 * @param {number} weekStart 0 Sunday, 1 Monday
 * @returns {{weeks: Object[][], month: number, year: number}}
 */
export function monthLayout(model, cursor, weekStart = 1) {
  const days = monthGrid(cursor, weekStart);
  const { year, month } = parseDate(cursor);
  const now = today();

  const rows = occurrencesBetween(model, days[0], days[days.length - 1]);
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const cells = days.map((date) => {
    const all = byDate.get(date) ?? [];
    return {
      date,
      day: parseDate(date).day,
      inMonth: parseDate(date).month === month,
      isToday: date === now,
      isWeekend: isWeekend(date, weekStart),
      shown: all.slice(0, CELL_CAPACITY),
      hidden: Math.max(0, all.length - CELL_CAPACITY),
      total: all.length,
    };
  });

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // A trailing week entirely outside the month and entirely empty is dropped.
  while (weeks.length > 5) {
    const last = weeks[weeks.length - 1];
    if (last.every((cell) => !cell.inMonth && cell.total === 0)) weeks.pop();
    else break;
  }

  return { weeks, month, year };
}

function isWeekend(date, weekStart) {
  const index = (dayNumber(date) + 4) % 7;      // 0 = Sunday.
  const day = ((index % 7) + 7) % 7;
  return weekStart === 1 ? (day === 0 || day === 6) : (day === 0 || day === 6);
}
