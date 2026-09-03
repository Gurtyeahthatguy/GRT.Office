/** A running list of what is coming. */

import { addDays, today } from '../time.js';
import { occurrencesBetween } from '../model.js';

/**
 * @param {Object} model
 * @param {string} from
 * @param {number} span how many days to cover
 * @returns {{days: Object[], from: string, to: string}}
 */
export function agendaLayout(model, from, span = 30) {
  const to = addDays(from, span - 1);
  const rows = occurrencesBetween(model, from, to);
  const now = today();

  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const days = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, entries]) => ({ date, isToday: date === now, entries }));

  return { days, from, to };
}
