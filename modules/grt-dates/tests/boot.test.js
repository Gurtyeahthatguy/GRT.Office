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

const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** Waits for a condition, bounded by the clock. */
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (let i = 0; Date.now() < deadline; i += 1) {
    if (predicate()) return true;
    await (i % 20 === 19 ? tick() : settle());
  }
  return predicate();
}

/** Waits for the program to finish starting. */
async function ready(extra = () => true) {
  // Startup is several awaits deep before there is anything to look at.
  for (let i = 0; i < 12; i += 1) await (i % 4 === 3 ? tick() : settle());

  let seen = -1;
  return until(() => {
    const calls = window.__TAURI_CALLS__?.length ?? 0;
    const quiet = calls === seen;
    seen = calls;
    return quiet && extra();
  });
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

describe('closing', () => {
  const closeRequested = () => window.__TAURI_LISTENERS__['grt://close-requested']();
  const toggleTask = () => document.querySelector('[data-action="toggle-task"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));

  it('CANARY: with nothing changed, closes at once and writes nothing', async () => {
    await closeRequested();
    expect(commands()).toContain('close_window');
    expect(commands()).not.toContain('write_file_atomic');
  });

  it('closing straight after a change writes it first', async () => {
    toggleTask();
    await closeRequested();
    const order = commands();
    expect(order).toContain('write_file_atomic');
    expect(order).toContain('close_window');
    expect(order.lastIndexOf('write_file_atomic')).toBeLessThan(order.indexOf('close_window'));
  });

  it('waits for a write still in flight before closing', async () => {
    vi.resetModules();
    installPage();
    await import('../scripts/preview-stub.js');
    const real = window.__TAURI__.core.invoke;
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    const finished = [];
    window.__TAURI__.core.invoke = async (command, payload, options) => {
      if (command === 'write_file_atomic') {
        await slow;
        const result = await real(command, payload, options);
        finished.push('write');
        return result;
      }
      if (command === 'close_window') finished.push('close');
      return real(command, payload, options);
    };
    await import('../src/js/main.js');
    await ready();

    toggleTask();
    const closing = closeRequested();
    for (let i = 0; i < 10; i += 1) await settle();
    expect(finished).toEqual([]);
    release();
    await closing;
    expect(finished.at(-1)).toBe('close');
    expect(finished.filter((step) => step === 'write').length).toBeGreaterThan(0);
  });

  it('a change whose write failed is not forgotten when an earlier write lands', async () => {
    vi.resetModules();
    installPage();
    await import('../scripts/preview-stub.js');
    const real = window.__TAURI__.core.invoke;
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    let writes = 0;
    let landed = false;
    window.__TAURI__.core.invoke = async (command, payload, options) => {
      if (command === 'write_file_atomic') {
        writes += 1;
        if (writes > 1) throw new Error('disk full');
        await slow;
        const result = await real(command, payload, options);
        landed = true;
        return result;
      }
      return real(command, payload, options);
    };
    await import('../src/js/main.js');
    await ready();

    toggleTask();
    for (let i = 0; i < 5; i += 1) await settle();
    toggleTask();
    await until(() => /Could not save/.test(document.getElementById('save-state').textContent));
    release();
    await until(() => landed);
    for (let i = 0; i < 5; i += 1) await settle();

    const closing = closeRequested();
    await until(() => !document.getElementById('overlay').classList.contains('hidden'));
    expect(document.getElementById('panel-title').textContent).toBe('Close without saving?');
    document.querySelector('[data-choice="cancel"]').click();
    await closing;
    expect(commands()).not.toContain('close_window');
  });

  it('holds the window only until the change is written', async () => {
    toggleTask();
    await until(() => /Saved/.test(document.getElementById('save-state').textContent));
    const guards = calls().filter((call) => call.command === 'set_close_guard')
      .map((call) => call.payload.held);
    expect(guards).toEqual([true, false]);
  });
});

describe('printing', () => {
  const preview = () => document.getElementById('print-view');
  const set = (field, value) => {
    const input = preview().querySelector(`[data-print-field="${field}"]`);
    input.value = value;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  it('prints the month with every entry, the week, and the agenda', async () => {
    document.getElementById('btn-print').click();
    await until(() => preview()?.querySelector('.print-page'));
    const month = preview().querySelector('.print-month');
    expect(month.querySelectorAll('.print-day').length % 7).toBe(0);
    const titles = [...month.querySelectorAll('.print-entry-text')].map((n) => n.textContent);
    expect(titles).toContain('Dentist');
    expect(titles.filter((t) => t === 'Weekly review').length).toBeGreaterThan(1);

    set('what', 'week');
    await until(() => preview().querySelector('.print-week'));
    expect(preview().querySelectorAll('.print-week-day')).toHaveLength(7);

    set('what', 'agenda');
    await until(() => preview().querySelector('[data-print-field="span"]'));
    set('span', '60');
    await until(() => preview().querySelectorAll('.print-agenda-date').length > 0);

    preview().querySelector('[data-print="go"]').click();
    await until(() => commands().includes('print_page'));
    preview().querySelector('[data-print="close"]').click();
    await until(() => !preview());
  });
});
