/** The calendar on paper: a month, a week, or the agenda for some days. */

import { monthLayout } from './views/month.js';
import { weekLayout } from './views/week.js';
import { agendaLayout } from './views/agenda.js';
import { monthTitle, longDate, shortDate, parseDate, weekday } from './time.js';
import { makePage, paperSize, flowBreaks, flowPage, measuringColumn } from './core/print.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MM = 96 / 25.4;
const MARGIN = 10;
const TITLE = 10;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One entry as a line: its time, its title, the calendar's colour beside it. */
function line(row) {
  const node = element('div', 'print-entry');
  node.style.setProperty('--chip', row.calendar.colour);
  if (!row.entry.allDay) node.append(element('span', 'print-entry-time', row.time));
  node.append(element('span', 'print-entry-text', row.entry.summary || '(no title)'));
  return node;
}

function pageWithTitle(paper, title) {
  const page = makePage(paper.width, paper.height);
  page.classList.add('dates-print');
  const heading = element('div', 'print-header', title);
  Object.assign(heading.style, {
    position: 'absolute', left: `${MARGIN}mm`, top: `${MARGIN}mm`, right: `${MARGIN}mm`,
    font: '600 14pt system-ui, sans-serif', color: '#111',
  });
  page.append(heading);
  return page;
}

function body(paper) {
  const node = element('div', 'print-calendar');
  Object.assign(node.style, {
    position: 'absolute', left: `${MARGIN}mm`, top: `${MARGIN + TITLE}mm`,
    width: `${paper.width - 2 * MARGIN}mm`, height: `${paper.height - 2 * MARGIN - TITLE}mm`,
  });
  return node;
}

function monthPage(model, cursor, paper, weekStart) {
  const layout = monthLayout(model, cursor, weekStart);
  const page = pageWithTitle(paper, monthTitle(cursor));
  const grid = body(paper);
  grid.classList.add('print-month');
  grid.style.gridTemplateRows = `auto repeat(${layout.weeks.length}, 1fr)`;
  for (let i = 0; i < 7; i += 1) grid.append(element('div', 'print-month-head', WEEKDAYS[(i + weekStart) % 7]));
  for (const week of layout.weeks) {
    for (const cell of week) {
      const day = element('div', 'print-day');
      day.classList.toggle('outside', !cell.inMonth);
      day.append(element('div', 'print-day-number', String(cell.day)));
      for (const row of cell.entries) day.append(line(row));
      grid.append(day);
    }
  }
  page.append(grid);
  return page;
}

function weekPage(model, cursor, paper, weekStart) {
  const layout = weekLayout(model, cursor, { weekStart });
  const page = pageWithTitle(paper, `${shortDate(layout.first)} to ${shortDate(layout.last)} ${parseDate(layout.last).year}`);
  const grid = body(paper);
  grid.classList.add('print-week');
  for (const column of layout.days) {
    const day = element('div', 'print-week-day');
    day.append(element('div', 'print-week-head', `${WEEKDAYS[weekday(column.date)]} ${parseDate(column.date).day}`));
    const rows = [...column.allDay, ...column.timed.slice().sort((a, b) => a.start - b.start)];
    for (const row of rows) day.append(line(row));
    grid.append(day);
  }
  page.append(grid);
  return page;
}

function agendaPages(model, cursor, paper, span) {
  const layout = agendaLayout(model, cursor, span);
  const title = `${longDate(layout.from)} to ${longDate(layout.to)}`;
  const width = paper.width - 2 * MARGIN;
  const column = measuringColumn(width, 'dates-print print-agenda');
  try {
    if (layout.days.length === 0) column.append(element('p', 'print-empty', 'Nothing in these days.'));
    for (const day of layout.days) {
      column.append(element('h3', 'print-agenda-date', longDate(day.date)));
      for (const row of day.entries) {
        const entry = line(row);
        if (row.entry.location) entry.append(element('span', 'print-entry-where', row.entry.location));
        column.append(entry);
      }
    }
    const windows = flowBreaks(column, (paper.height - 2 * MARGIN - TITLE) * MM, {
      keepWithNext: (element_) => element_.tagName === 'H3',
    });
    return windows.map((window, index) => {
      const page = pageWithTitle(paper, windows.length > 1 ? `${title} · ${index + 1} / ${windows.length}` : title);
      const holder = flowPage(column, window);
      holder.classList.add('dates-print', 'print-agenda');
      Object.assign(holder.style, { position: 'absolute', left: `${MARGIN}mm`, top: `${MARGIN + TITLE}mm`, width: `${width}mm` });
      page.append(holder);
      return page;
    });
  } finally {
    column.remove();
  }
}

/**
 * @param {object} model
 * @param {{what: 'month'|'week'|'agenda', span: number, size: string, orientation: string}} setup
 * @param {number} weekStart
 */
export function printablePages(model, setup, weekStart = 1) {
  const paper = paperSize(setup);
  const pages = setup.what === 'week' ? [weekPage(model, model.cursor, paper, weekStart)]
    : setup.what === 'agenda' ? agendaPages(model, model.cursor, paper, Math.max(1, Number(setup.span) || 14))
      : [monthPage(model, model.cursor, paper, weekStart)];
  return { width: paper.width, height: paper.height, pages };
}
