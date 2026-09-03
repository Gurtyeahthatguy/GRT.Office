/** Model to DOM. */

import { monthLayout } from './views/month.js';
import { weekLayout, DAY_MINUTES } from './views/week.js';
import { agendaLayout } from './views/agenda.js';
import { tasks } from './model.js';
import { describe } from './recurrence.js';
import {
  today, longDate, shortDate, monthTitle, parseDate, weekday,
} from './time.js';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The title above the grid, which depends on which view is showing. */
export function viewTitle(model, weekStart = 1) {
  if (model.view === 'month') return monthTitle(model.cursor);
  if (model.view === 'day') return longDate(model.cursor);
  if (model.view === 'agenda') return `From ${longDate(model.cursor)}`;
  const { first, last } = weekLayout(model, model.cursor, { weekStart });
  return `${shortDate(first)} — ${shortDate(last)} ${parseDate(last).year}`;
}

/** Draws whichever view is current into `surface`. */
export function draw(model, surface, { weekStart = 1 } = {}) {
  surface.dataset.view = model.view;

  if (model.view === 'month') surface.replaceChildren(monthView(model, weekStart));
  else if (model.view === 'week') surface.replaceChildren(timeGrid(model, 7, weekStart));
  else if (model.view === 'day') surface.replaceChildren(timeGrid(model, 1, weekStart));
  else surface.replaceChildren(agendaView(model));
}

// Month

function monthView(model, weekStart) {
  const layout = monthLayout(model, model.cursor, weekStart);
  const grid = element('div', 'month');

  const head = element('div', 'month-head');
  for (let i = 0; i < 7; i += 1) {
    head.append(element('div', 'month-head-cell', WEEKDAY_SHORT[(i + weekStart) % 7]));
  }
  grid.append(head);

  const body = element('div', 'month-body');
  body.style.setProperty('--rows', String(layout.weeks.length));

  for (const week of layout.weeks) {
    for (const cell of week) {
      const day = element('div', 'day-cell');
      day.dataset.date = cell.date;
      day.classList.toggle('outside', !cell.inMonth);
      day.classList.toggle('is-today', cell.isToday);
      day.classList.toggle('weekend', cell.isWeekend);

      const number = element('div', 'day-number', String(cell.day));
      day.append(number);

      for (const row of cell.shown) day.append(chip(row));

      if (cell.hidden > 0) {
        const more = element('button', 'more', `+${cell.hidden} more`);
        more.dataset.date = cell.date;
        more.dataset.action = 'show-day';
        day.append(more);
      }

      body.append(day);
    }
  }

  grid.append(body);
  return grid;
}

function chip(row) {
  const node = element('button', 'chip');
  node.dataset.uid = row.entry.uid;
  node.dataset.date = row.date;
  node.style.setProperty('--chip', row.calendar.colour);
  node.classList.toggle('all-day', row.entry.allDay);

  if (!row.entry.allDay) node.append(element('span', 'chip-time', row.time));
  node.append(element('span', 'chip-text', row.entry.summary || '(no title)'));

  // The calendar's name goes in the tooltip as well as its colour on the
  // edge.
  node.title = `${row.entry.summary || '(no title)'}\n${row.calendar.name}`
    + (row.entry.rrule ? `\n${describe(row.entry.rrule) ?? 'Repeats'}` : '');

  return node;
}

// Week and day

function timeGrid(model, days, weekStart) {
  const layout = weekLayout(model, model.cursor, { days, weekStart });
  const wrapper = element('div', 'timegrid');
  wrapper.style.setProperty('--columns', String(days));

  // Column headings.
  const head = element('div', 'timegrid-head');
  head.append(element('div', 'gutter-head'));
  for (const column of layout.days) {
    const cell = element('div', 'timegrid-head-cell');
    cell.dataset.date = column.date;
    cell.classList.toggle('is-today', column.isToday);
    cell.append(element('div', 'head-day', WEEKDAY_SHORT[weekday(column.date)]));
    cell.append(element('div', 'head-number', String(parseDate(column.date).day)));
    head.append(cell);
  }
  wrapper.append(head);

  // All-day strip, only when something is in it.
  if (layout.days.some((column) => column.allDay.length > 0)) {
    const strip = element('div', 'allday-strip');
    strip.append(element('div', 'gutter-head', 'All day'));
    for (const column of layout.days) {
      const cell = element('div', 'allday-cell');
      cell.dataset.date = column.date;
      for (const row of column.allDay) cell.append(chip(row));
      strip.append(cell);
    }
    wrapper.append(strip);
  }

  // Hours and columns.
  const body = element('div', 'timegrid-body');

  const gutter = element('div', 'gutter');
  for (let hour = 0; hour < 24; hour += 1) {
    const label = element('div', 'hour-label', hour === 0 ? '' : `${String(hour).padStart(2, '0')}:00`);
    gutter.append(label);
  }
  body.append(gutter);

  for (const column of layout.days) {
    const cell = element('div', 'day-column');
    cell.dataset.date = column.date;
    cell.classList.toggle('is-today', column.isToday);

    for (let hour = 0; hour < 24; hour += 1) {
      const line = element('div', 'hour-slot');
      line.dataset.date = column.date;
      line.dataset.hour = String(hour);
      cell.append(line);
    }

    for (const row of column.timed) cell.append(block(row));

    if (column.isToday) {
      const marker = element('div', 'now-line');
      marker.style.setProperty('--at', String(nowFraction()));
      cell.append(marker);
    }

    body.append(cell);
  }

  wrapper.append(body);
  return wrapper;
}

function block(row) {
  const node = element('button', 'event-block');
  node.dataset.uid = row.entry.uid;
  node.dataset.date = row.date;
  node.style.setProperty('--top', String(row.start / DAY_MINUTES));
  node.style.setProperty('--height', String((row.end - row.start) / DAY_MINUTES));
  node.style.setProperty('--lane', String(row.lane));
  node.style.setProperty('--lanes', String(row.lanes));
  node.style.setProperty('--chip', row.calendar.colour);

  node.append(element('span', 'block-time', row.time));
  node.append(element('span', 'block-text', row.entry.summary || '(no title)'));
  node.title = `${row.entry.summary || '(no title)'}\n${row.calendar.name}`;

  return node;
}

function nowFraction() {
  const now = new Date();
  return (now.getHours() * 60 + now.getMinutes()) / DAY_MINUTES;
}

// Agenda

function agendaView(model) {
  const layout = agendaLayout(model, model.cursor, 60);
  const list = element('div', 'agenda');

  if (layout.days.length === 0) {
    list.append(element('p', 'empty', 'Nothing in the next two months.'));
    return list;
  }

  for (const day of layout.days) {
    const group = element('section', 'agenda-day');
    group.classList.toggle('is-today', day.isToday);

    const heading = element('h3', 'agenda-date', longDate(day.date));
    group.append(heading);

    for (const row of day.entries) {
      const line = element('button', 'agenda-row');
      line.dataset.uid = row.entry.uid;
      line.dataset.date = row.date;
      line.style.setProperty('--chip', row.calendar.colour);
      line.append(element('span', 'agenda-time', row.entry.allDay ? 'All day' : row.time));
      line.append(element('span', 'agenda-text', row.entry.summary || '(no title)'));
      if (row.entry.location) {
        line.append(element('span', 'agenda-where', row.entry.location));
      }
      group.append(line);
    }

    list.append(group);
  }

  return list;
}

// Side panel

/** The calendar list: colour, name, and whether it is showing. */
export function drawCalendars(model, container) {
  const list = element('div', 'calendar-list');

  for (const calendar of model.calendars) {
    const row = element('div', 'calendar-row');
    row.dataset.calendar = calendar.id;

    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.checked = calendar.visible;
    toggle.dataset.calendar = calendar.id;
    toggle.dataset.action = 'toggle-calendar';
    toggle.id = `cal-${calendar.id}`;

    const swatch = element('span', 'swatch');
    swatch.style.background = calendar.colour;

    const label = element('label', 'calendar-name', calendar.name);
    label.htmlFor = `cal-${calendar.id}`;
    if (calendar.dirty) label.append(element('span', 'dirty-mark', ' •'));

    row.append(toggle, swatch, label);
    list.append(row);
  }

  if (model.calendars.length === 0) {
    list.append(element('p', 'empty', 'No calendars yet.'));
  }

  container.replaceChildren(list);
}

/** The task list. */
export function drawTasks(model, container, { includeCompleted = true } = {}) {
  const rows = tasks(model, { includeCompleted });
  const list = element('div', 'task-list');

  if (rows.length === 0) {
    list.append(element('p', 'empty', 'No tasks.'));
    container.replaceChildren(list);
    return;
  }

  const now = today();

  for (const { entry, calendar } of rows) {
    const row = element('div', 'task-row');
    row.dataset.uid = entry.uid;
    row.classList.toggle('done', entry.completed);

    const box = element('input');
    box.type = 'checkbox';
    box.checked = entry.completed;
    box.dataset.uid = entry.uid;
    box.dataset.action = 'toggle-task';

    const text = element('button', 'task-text', entry.summary || '(no title)');
    text.dataset.uid = entry.uid;
    text.style.setProperty('--chip', calendar.colour);

    row.append(box, text);

    if (entry.due?.date) {
      const overdue = !entry.completed && entry.due.date < now;
      const due = element('span', `task-due${overdue ? ' overdue' : ''}`,
        shortDate(entry.due.date));
      row.append(due);
    }

    if (entry.priority > 0 && entry.priority <= 4) {
      row.append(element('span', 'task-priority', '!'));
    }

    list.append(row);
  }

  container.replaceChildren(list);
}

// Hit resolution

/** The entry a click landed on, or null. */
export function entryAt(node) {
  const found = node?.closest?.('[data-uid]');
  if (!found) return null;
  return { uid: found.dataset.uid, date: found.dataset.date ?? null };
}

/** The date cell a click landed on, or null. */
export function dateAt(node) {
  const slot = node?.closest?.('.hour-slot');
  if (slot) return { date: slot.dataset.date, hour: Number(slot.dataset.hour) };
  const cell = node?.closest?.('[data-date]');
  return cell ? { date: cell.dataset.date, hour: null } : null;
}
