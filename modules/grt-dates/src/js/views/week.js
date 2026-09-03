/** The week and day grids. */

import { addDays, startOfWeek, today, minutesOfDay } from '../time.js';
import { occurrencesBetween, durationOf } from '../model.js';

/** Pixels per minute is decided in CSS; the layout works in minutes. */
export const DAY_MINUTES = 1440;

/**
 * @param {Object} model
 * @param {string} cursor
 * @param {{days?: number, weekStart?: number}} options
 * @returns {{days: Object[]}}
 */
export function weekLayout(model, cursor, { days = 7, weekStart = 1 } = {}) {
  const first = days === 7 ? startOfWeek(cursor, weekStart) : cursor;
  const last = addDays(first, days - 1);
  const now = today();

  const rows = occurrencesBetween(model, first, last);
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const columns = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(first, i);
    const all = byDate.get(date) ?? [];
    const allDay = all.filter((row) => row.entry.allDay);
    const timed = all.filter((row) => !row.entry.allDay);

    columns.push({
      date,
      isToday: date === now,
      allDay,
      timed: placeSideBySide(timed),
    });
  }

  return { days: columns, first, last };
}

/** Assigns overlapping events to side-by-side lanes. */
export function placeSideBySide(rows) {
  const sorted = [...rows].sort((a, b) => (
    a.minutes - b.minutes || durationOf(b.entry) - durationOf(a.entry)
  ));

  const placed = sorted.map((row) => {
    const start = row.minutes;
    const length = Math.max(durationOf(row.entry), 15);
    return { ...row, start, end: Math.min(start + length, DAY_MINUTES), lane: 0, lanes: 1 };
  });

  let cluster = [];
  let clusterEnd = -1;

  const closeCluster = () => {
    if (cluster.length === 0) return;
    const width = Math.max(...cluster.map((item) => item.lane)) + 1;
    for (const item of cluster) item.lanes = width;
    cluster = [];
    clusterEnd = -1;
  };

  for (const item of placed) {
    if (item.start >= clusterEnd) closeCluster();

    const taken = new Set(cluster.filter((other) => other.end > item.start)
      .map((other) => other.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    item.lane = lane;

    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  closeCluster();

  return placed;
}
