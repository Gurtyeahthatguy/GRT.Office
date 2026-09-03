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

function fakeBackend() {
  const written = new Map();
  const calls = [];

  const invoke = vi.fn(async (command, payload) => {
    calls.push({ command, payload });
    switch (command) {
      case 'runtime_info': return { ephemeral: false, version: '0.1.0', initialFile: null };
      case 'read_settings': return {};
      case 'write_settings': return true;
      case 'write_grt': written.set(payload.path, payload.parts); return undefined;
      case 'read_grt': return { parts: written.get(payload.path) ?? {}, resources: [] };
      case 'read_file': return new Uint8Array();
      case 'write_file_atomic': return undefined;
      case 'file_exists': return false;
      default:
        if (command.startsWith('plugin:dialog|')) return null;
        throw new Error(`unexpected command ${command}`);
    }
  });

  return { invoke, written, calls };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Waits for something to happen, bounded by the clock rather than by a number
 * of turns.
 *
 * A turn is a setImmediate, which costs nothing; every twentieth turn is a
 * real timer, so that work waiting on one can proceed. Counting turns was the
 * mistake: setTimeout(fn, 0) is clamped, so the same loop that took a
 * comfortable second here took far longer on a Windows runner.
 */
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

  // Then wait until the backend stops being asked for things. Not every
  // module's fake records its calls; where none are recorded this settles on
  // the next turn.
  let seen = -1;
  return until(() => {
    const calls = window.__TAURI_CALLS__?.length ?? 0;
    const quiet = calls === seen;
    seen = calls;
    return quiet && extra();
  });
}

/** Types a character with the keyboard, as a person would. */
function press(key, options = {}) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...options,
  }));
}

/** Types into the formula bar and commits with Enter. */
async function typeInto(text) {
  const input = document.getElementById('formula-input');
  input.focus();
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await settle();
}

const cellAt = (row, col) => document.querySelector(
  `.cell[data-row="${row}"][data-col="${col}"]`,
);

let backend;

beforeEach(async () => {
  vi.resetModules();
  installPage();
  backend = fakeBackend();
  window.__TAURI__ = { core: { invoke: backend.invoke } };

  await import('../src/js/main.js');
  await ready();
});

describe('the program starts', () => {
  it('asks the backend who it is', () => {
    expect(backend.calls.map((c) => c.command)).toContain('runtime_info');
  });

  it('shows its version', () => {
    expect(document.getElementById('version').textContent).toBe('0.1.0');
  });

  it('draws cells, and nothing like a million of them', () => {
    const cells = document.querySelectorAll('.cell');
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(5000);
  });

  it('draws row and column headers', () => {
    expect(document.querySelector('.column-head')).toBeTruthy();
    expect(document.querySelector('.row-head')).toBeTruthy();
  });

  it('starts with A1 selected', () => {
    expect(document.getElementById('name-box').textContent).toBe('A1');
    expect(cellAt(0, 0).classList.contains('active')).toBe(true);
  });
});

describe('typing into a cell', () => {
  it('puts a number in the grid', async () => {
    await typeInto('42');
    expect(cellAt(0, 0).textContent).toBe('42');
  });

  it('calculates a formula', async () => {
    await typeInto('2');
    await typeInto('3');
    press('ArrowUp');
    press('ArrowUp');
    press('ArrowRight');
    await settle();
    await typeInto('=A1+A2');
    expect(cellAt(0, 1).textContent).toBe('5');
  });

  it('moves down after Enter, as a spreadsheet does', async () => {
    await typeInto('1');
    expect(document.getElementById('name-box').textContent).toBe('A2');
  });

  it('CANARY: a cell is empty until something is typed into it', () => {
    expect(cellAt(0, 0).textContent).toBe('');
  });
});

describe('the keyboard', () => {
  it('moves the selection with the arrows', async () => {
    press('ArrowDown');
    press('ArrowRight');
    await settle();
    expect(document.getElementById('name-box').textContent).toBe('B2');
  });

  it('extends the selection with shift', async () => {
    press('ArrowDown', { shiftKey: true });
    press('ArrowRight', { shiftKey: true });
    await settle();
    expect(document.getElementById('name-box').textContent).toBe('A1:B2');
  });

  it('moves with Tab', async () => {
    press('Tab');
    await settle();
    expect(document.getElementById('name-box').textContent).toBe('B1');
  });

  it('starts an edit when a printable character is typed', async () => {
    press('7');
    await settle();
    expect(document.getElementById('formula-input').value).toBe('7');
  });

  it('clears the selection with Delete', async () => {
    await typeInto('5');
    press('ArrowUp');
    await settle();
    press('Delete');
    await settle();
    expect(cellAt(0, 0).textContent).toBe('');
  });

  it('undoes with Ctrl+Z', async () => {
    await typeInto('5');
    press('z', { ctrlKey: true });
    await settle();
    expect(cellAt(0, 0).textContent).toBe('');
  });
});

describe('clicking', () => {
  it('selects the cell that was clicked', async () => {
    cellAt(2, 3).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await settle();
    expect(document.getElementById('name-box').textContent).toBe('D3');
  });

  it('selects a whole column from its header', async () => {
    const head = document.querySelector('.column-head[data-col="2"]');
    head.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await settle();
    expect(document.getElementById('name-box').textContent).toMatch(/^C1:C/);
  });
});

describe('the toolbar', () => {
  it('inserts a row', async () => {
    await typeInto('first');
    press('ArrowUp');
    await settle();

    document.getElementById('btn-insert-row').click();
    await settle();

    expect(cellAt(0, 0).textContent).toBe('');
    expect(cellAt(1, 0).textContent).toBe('first');
  });

  it('applies a style', async () => {
    await typeInto('1234.5');
    press('ArrowUp');
    await settle();

    const picker = document.getElementById('style-picker');
    picker.value = 'currency';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();

    expect(cellAt(0, 0).textContent).toBe('1,234.50');
  });

  it('adds a sheet and switches to it', async () => {
    await typeInto('on the first sheet');
    document.getElementById('btn-add-sheet').click();
    await settle();

    const tabs = document.querySelectorAll('.sheet-tab');
    expect(tabs).toHaveLength(2);

    tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();
    expect(cellAt(0, 0).textContent).toBe('');
  });
});

describe('the status bar', () => {
  it('sums the selection', async () => {
    await typeInto('10');
    await typeInto('20');
    press('ArrowUp');
    press('ArrowUp');
    press('ArrowDown', { shiftKey: true });
    await settle();

    expect(document.getElementById('summary').textContent).toContain('Sum 30');
    expect(document.getElementById('summary').textContent).toContain('Count 2');
  });

  it('says nothing when there are no numbers', async () => {
    expect(document.getElementById('summary').textContent).toBe('');
  });
});

describe('saving', () => {
  it('writes the document through the container', async () => {
    await typeInto('saved value');

    backend.invoke.mockImplementation(async (command, payload) => {
      if (command.startsWith('plugin:dialog|save')) return '/tmp/sheet.grt';
      if (command === 'write_grt') { backend.written.set(payload.path, payload.parts); return undefined; }
      return null;
    });

    document.getElementById('btn-save').click();
    await until(() => backend.written.has('/tmp/sheet.grt'));

    const parts = backend.written.get('/tmp/sheet.grt');
    expect(parts).toBeTruthy();
    expect(parts['content/main.json']).toContain('saved value');
    expect(parts['content/main.json']).toContain('"type": "grid"');
  });
});
