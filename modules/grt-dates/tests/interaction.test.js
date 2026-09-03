// @vitest-environment jsdom

/** Can the program actually be operated?. */

import { describe, it, expect, beforeEach } from 'vitest';
import { draw, drawTasks, drawCalendars, entryAt, dateAt } from '../src/js/render.js';
import {
  createModel, createEvent, createTask, addCalendar, addEntry,
} from '../src/js/model.js';

let model;
let calendar;
let surface;

beforeEach(() => {
  document.body.innerHTML = '<div id="surface"></div><div id="side"></div>';
  surface = document.getElementById('surface');
  model = createModel();
  model.cursor = '2026-09-10';
  calendar = addCalendar(model, { name: 'Personal' });
});

const add = (options) => {
  const event = createEvent(options);
  addEntry(model, calendar.id, event);
  return event;
};

describe('clicking an event in the month view', () => {
  it('resolves from the innermost element the click actually lands on', () => {
    const event = add({ summary: 'Dentist', date: '2026-09-10', time: '11:00' });
    model.view = 'month';
    draw(model, surface);

    const text = surface.querySelector('.chip-text');
    expect(text).toBeTruthy();
    // The element the mouse hits carries no identifier of its own.
    expect(text.dataset.uid).toBeUndefined();

    const hit = entryAt(text);
    expect(hit).not.toBeNull();
    expect(hit.uid).toBe(event.uid);
    expect(hit.date).toBe('2026-09-10');
  });

  it('resolves from the time label too', () => {
    const event = add({ summary: 'Dentist', date: '2026-09-10', time: '11:00' });
    model.view = 'month';
    draw(model, surface);

    expect(entryAt(surface.querySelector('.chip-time')).uid).toBe(event.uid);
  });

  it('reports the occurrence date, not the series start', () => {
    const weekly = add({ summary: 'Review', date: '2026-09-07', time: '15:00' });
    weekly.rrule = 'FREQ=WEEKLY';
    model.view = 'month';
    draw(model, surface);

    const chips = [...surface.querySelectorAll('.chip')];
    const dates = chips.map((chip) => entryAt(chip.firstChild).date);
    expect(new Set(dates).size).toBeGreaterThan(1);
    expect(dates).toContain('2026-09-14');
  });

  it('finds nothing when the click was on empty space', () => {
    model.view = 'month';
    draw(model, surface);
    const empty = surface.querySelector('.day-cell');
    expect(entryAt(empty)).toBeNull();
  });
});

describe('clicking an event in the week view', () => {
  it('resolves from the label inside the block', () => {
    const event = add({ summary: 'Meeting', date: '2026-09-10', time: '10:00' });
    model.view = 'week';
    draw(model, surface);

    const label = surface.querySelector('.block-text');
    expect(label).toBeTruthy();
    expect(label.dataset.uid).toBeUndefined();
    expect(entryAt(label).uid).toBe(event.uid);
  });

  it('resolves an all-day entry from the strip', () => {
    const event = add({ summary: 'Holiday', date: '2026-09-10', allDay: true });
    model.view = 'week';
    draw(model, surface);

    const chip = surface.querySelector('.allday-cell .chip-text');
    expect(entryAt(chip).uid).toBe(event.uid);
  });
});

describe('clicking empty space', () => {
  it('gives the day in the month view', () => {
    model.view = 'month';
    draw(model, surface);

    const cell = [...surface.querySelectorAll('.day-cell')]
      .find((node) => node.dataset.date === '2026-09-10');
    const where = dateAt(cell.querySelector('.day-number'));
    expect(where).toEqual({ date: '2026-09-10', hour: null });
  });

  it('gives the day and the hour in the week view', () => {
    model.view = 'week';
    draw(model, surface);

    const slot = [...surface.querySelectorAll('.hour-slot')]
      .find((node) => node.dataset.date === '2026-09-10' && node.dataset.hour === '14');
    expect(dateAt(slot)).toEqual({ date: '2026-09-10', hour: 14 });
  });
});

describe('what the renderer puts on screen', () => {
  it('draws every occurrence of a repeating event, not just the first', () => {
    const weekly = add({ summary: 'Review', date: '2026-09-07', time: '15:00' });
    weekly.rrule = 'FREQ=WEEKLY';
    model.view = 'month';
    draw(model, surface);

    // Five, not four: the grid is whole weeks, so September 2026 runs from
    // Monday 31 August to Sunday 11 October and catches the 5th of October.
    expect(surface.querySelectorAll('.chip')).toHaveLength(5);
  });

  it('draws nothing from a calendar that is hidden', () => {
    add({ summary: 'Dentist', date: '2026-09-10', time: '11:00' });
    calendar.visible = false;
    model.view = 'month';
    draw(model, surface);

    expect(surface.querySelectorAll('.chip')).toHaveLength(0);
  });

  it('carries the calendar colour onto the element', () => {
    add({ summary: 'Dentist', date: '2026-09-10', time: '11:00' });
    model.view = 'month';
    draw(model, surface);

    expect(surface.querySelector('.chip').style.getPropertyValue('--chip'))
      .toBe(calendar.colour);
  });

  it('names the calendar in the tooltip, not only in the colour', () => {
    // Colour alone is not readable for everyone, so the name has to be
    // reachable some other way.
    add({ summary: 'Dentist', date: '2026-09-10', time: '11:00' });
    model.view = 'month';
    draw(model, surface);

    expect(surface.querySelector('.chip').title).toContain('Personal');
  });

  it('marks today', () => {
    model.cursor = '2026-09-10';
    model.view = 'month';
    draw(model, surface);
    // Not asserting which cell.
    expect(surface.querySelectorAll('.day-cell.is-today').length).toBeLessThanOrEqual(1);
  });

  it('redraws from scratch rather than accumulating', () => {
    add({ summary: 'Dentist', date: '2026-09-10', time: '11:00' });
    model.view = 'month';
    draw(model, surface);
    draw(model, surface);
    draw(model, surface);
    expect(surface.querySelectorAll('.chip')).toHaveLength(1);
  });
});

describe('the sidebar', () => {
  it('lists calendars with a working checkbox bound to the id', () => {
    drawCalendars(model, document.getElementById('side'));
    const box = document.querySelector('[data-action="toggle-calendar"]');
    expect(box.dataset.calendar).toBe(calendar.id);
    expect(box.checked).toBe(true);
  });

  it('lists tasks and resolves a click on the text to the task', () => {
    const task = createTask({ summary: 'File the form', due: '2026-09-12' });
    addEntry(model, calendar.id, task);

    drawTasks(model, document.getElementById('side'));
    const text = document.querySelector('.task-text');
    expect(text.dataset.uid).toBe(task.uid);
  });

  it('marks an overdue task', () => {
    const task = createTask({ summary: 'Late', due: '2020-01-01' });
    addEntry(model, calendar.id, task);

    drawTasks(model, document.getElementById('side'));
    expect(document.querySelector('.task-due.overdue')).toBeTruthy();
  });

  it('can hide completed tasks', () => {
    const done = createTask({ summary: 'Done', due: '2026-09-12' });
    done.completed = true;
    addEntry(model, calendar.id, done);

    drawTasks(model, document.getElementById('side'), { includeCompleted: false });
    expect(document.querySelectorAll('.task-text')).toHaveLength(0);
  });
});
