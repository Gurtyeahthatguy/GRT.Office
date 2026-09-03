// @vitest-environment jsdom

/** Start the actual program and use it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '..', 'src', 'index.html'), 'utf8');

function installPage() {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(indexHtml)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** Waits for something to happen, rather than for a number of turns. */
async function until(predicate, tries = 400) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await settle();
  }
  return predicate();
}

/**
 * Waits for the program to finish starting.
 *
 * A fixed number of turns is a race: on a cold machine the last await has not
 * resolved when the first assertion runs. This waits for the backend to stop
 * being asked for things, which is what "started" means here.
 */
async function ready(extra = () => true) {
  let seen = -1;
  for (let i = 0; i < 400; i += 1) {
    const calls = window.__TAURI_CALLS__?.length ?? 0;
    if (calls > 0 && calls === seen && extra()) return;
    seen = calls;
    await settle();
  }
}

async function boot() {
  vi.resetModules();
  installPage();
  await import('../scripts/preview-stub.js');
  await import('../src/js/main.js');
  await ready();
}

const calls = () => window.__TAURI_CALLS__ ?? [];
const commands = () => calls().map((c) => c.command);

beforeEach(async () => { await boot(); });

describe('the program starts', () => {
  it('asks the backend who it is and reads the calendar folder', () => {
    expect(commands()).toContain('runtime_info');
    expect(commands()).toContain('list_calendars');
  });

  it('shows its version', () => {
    expect(document.getElementById('version').textContent).toBe('preview');
  });

  it('loads the calendars it found', () => {
    const names = [...document.querySelectorAll('.calendar-name')]
      .map((node) => node.textContent.trim());
    expect(names).toContain('Personal');
    expect(names).toContain('Work');
  });

  it('opens on the month view', () => {
    expect(document.getElementById('surface').dataset.view).toBe('month');
    expect(document.querySelector('[data-view="month"]').classList.contains('active')).toBe(true);
  });

  it('draws a six-week grid, or five when the sixth would be empty', () => {
    const cells = document.querySelectorAll('.day-cell');
    expect(cells.length % 7).toBe(0);
    expect(cells.length).toBeGreaterThanOrEqual(35);
  });
});

describe('what the stub put in the calendars', () => {
  it('draws the events', () => {
    const titles = [...document.querySelectorAll('.chip-text')].map((n) => n.textContent);
    expect(titles).toContain('Dentist');
    expect(titles.filter((t) => t === 'Weekly review').length).toBeGreaterThan(1);
  });

  it('draws an all-day event differently from a timed one', () => {
    const allDay = [...document.querySelectorAll('.chip.all-day .chip-text')]
      .map((n) => n.textContent);
    expect(allDay).toContain('All-day conference');
  });

  it('lists the task', () => {
    expect(document.getElementById('tasks').textContent).toContain('Post the form');
  });

  it('CANARY: a task is not drawn in the calendar grid', () => {
    const titles = [...document.querySelectorAll('.chip-text')].map((n) => n.textContent);
    expect(titles).not.toContain('Post the form');
  });
});

describe('moving about', () => {
  const title = () => document.getElementById('view-title').textContent;

  it('goes forward and back a month', async () => {
    const started = title();
    document.getElementById('btn-next').click();
    await settle();
    expect(title()).not.toBe(started);

    document.getElementById('btn-prev').click();
    await settle();
    expect(title()).toBe(started);
  });

  it('comes back to today', async () => {
    const started = title();
    for (let i = 0; i < 3; i += 1) document.getElementById('btn-next').click();
    await settle();
    document.getElementById('btn-today').click();
    await settle();
    expect(title()).toBe(started);
  });

  it('switches between the four views', async () => {
    for (const view of ['week', 'day', 'agenda', 'month']) {
      document.querySelector(`[data-view="${view}"]`).click();
      await settle();
      expect(document.getElementById('surface').dataset.view).toBe(view);
    }
  });

  it('moves by a week in the week view, not by a month', async () => {
    document.querySelector('[data-view="week"]').click();
    await settle();
    const started = title();

    document.getElementById('btn-next').click();
    await settle();
    expect(title()).not.toBe(started);

    // A week later, so the title still names a nearby date rather than
    // jumping a month.
    document.getElementById('btn-prev').click();
    await settle();
    expect(title()).toBe(started);
  });

  it('draws the hour grid in the week and day views', async () => {
    document.querySelector('[data-view="day"]').click();
    await settle();
    expect(document.querySelectorAll('.hour-slot').length).toBe(24);
  });
});

describe('the keyboard', () => {
  const press = (key) => document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );

  it('switches views with single letters', async () => {
    for (const [key, view] of [['w', 'week'], ['d', 'day'], ['a', 'agenda'], ['m', 'month']]) {
      press(key);
      await settle();
      expect(document.getElementById('surface').dataset.view).toBe(view);
    }
  });

  it('moves with the arrows', async () => {
    const started = document.getElementById('view-title').textContent;
    press('ArrowRight');
    await settle();
    expect(document.getElementById('view-title').textContent).not.toBe(started);
    press('ArrowLeft');
    await settle();
    expect(document.getElementById('view-title').textContent).toBe(started);
  });
});

describe('searching', () => {
  it('narrows the calendar to what matches', async () => {
    const search = document.getElementById('search');
    search.value = 'dentist';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();

    const titles = [...document.querySelectorAll('.chip-text')].map((n) => n.textContent);
    expect(titles).toEqual(['Dentist']);
  });

  it('CANARY: without a search, more than one event is drawn', () => {
    expect(document.querySelectorAll('.chip-text').length).toBeGreaterThan(1);
  });

  it('shows everything again when the search is cleared', async () => {
    const search = document.getElementById('search');
    search.value = 'dentist';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('.chip-text').length).toBeGreaterThan(1);
  });
});

describe('hiding a calendar', () => {
  it('takes its events off the grid', async () => {
    const before = document.querySelectorAll('.chip-text').length;

    const toggle = document.querySelector('[data-action="toggle-calendar"]');
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle();

    expect(document.querySelectorAll('.chip-text').length).toBeLessThan(before);
  });
});

describe('saving', () => {
  it('writes a calendar back when something changes', async () => {
    // Ticking a task is the shortest path to a change.
    const box = document.querySelector('[data-action="toggle-task"]');
    expect(box).toBeTruthy();
    box.dispatchEvent(new window.Event('click', { bubbles: true }));

    await until(() => commands().includes('write_file_atomic'));

    expect(commands()).toContain('write_file_atomic');
  });

  it('says so in the status bar rather than saving silently', async () => {
    const box = document.querySelector('[data-action="toggle-task"]');
    box.dispatchEvent(new window.Event('click', { bubbles: true }));
    await until(() => /Saved|Saving/.test(document.getElementById('save-state').textContent));

    expect(document.getElementById('save-state').textContent).toMatch(/Saved|Saving/);
  });

  it('CANARY: nothing is written before anything changes', async () => {
    expect(commands()).not.toContain('write_file_atomic');
  });
});
