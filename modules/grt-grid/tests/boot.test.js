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

const SLOT = { id: '0123456789abcdef', path: '/cache/0123456789abcdef.grt' };

function fakeBackend({ orphans = [] } = {}) {
  const written = new Map();
  const calls = [];
  const listeners = new Map();

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
      case 'recovery_begin': return SLOT;
      case 'recovery_list': return orphans;
      case 'recovery_saved': case 'recovery_discard': case 'recovery_remove':
      case 'set_close_guard': case 'close_ack': case 'close_window': return null;
      case 'print_page': return null;
      default:
        if (command.startsWith('plugin:dialog|')) return null;
        throw new Error(`unexpected command ${command}`);
    }
  });

  const listen = vi.fn(async (name, handler) => {
    listeners.set(name, handler);
    return () => {};
  });

  return { invoke, listen, listeners, written, calls };
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
  await boot(fakeBackend());
});

/** What each run of the program hung on the document, taken off before the next one starts. */
const hung = [];
const hang = document.addEventListener.bind(document);
document.addEventListener = (...args) => {
  hung.push(args);
  hang(...args);
};

async function boot(fake) {
  vi.resetModules();
  for (const args of hung.splice(0)) document.removeEventListener(...args);
  installPage();
  backend = fake;
  window.__TAURI__ = { core: { invoke: backend.invoke }, event: { listen: backend.listen } };
  await import('../src/js/main.js');
  await ready();
}

const called = (command) => backend.calls.filter((call) => call.command === command);
const dialogTitle = () => document.getElementById('panel-title').textContent;
const dialogOpen = () => !document.getElementById('overlay').classList.contains('hidden');
const choose = (id) => document.querySelector(`[data-choice="${id}"]`).click();

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

  it('Tab while typing keeps the value and moves right, Shift+Tab left', async () => {
    const input = document.getElementById('formula-input');
    input.focus();
    input.value = 'left';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await settle();
    expect(cellAt(0, 0).textContent).toBe('left');
    expect(document.getElementById('name-box').textContent).toBe('B1');

    input.focus();
    input.value = 'right';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(cellAt(0, 1).textContent).toBe('right');
    expect(document.getElementById('name-box').textContent).toBe('A1');
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
    // A spreadsheet that was never saved is asked for a format first.
    await until(dialogOpen);
    document.getElementById('panel-confirm').click();
    await until(() => backend.written.has('/tmp/sheet.grt'));

    const parts = backend.written.get('/tmp/sheet.grt');
    expect(parts).toBeTruthy();
    expect(parts['content/main.json']).toContain('saved value');
    expect(parts['content/main.json']).toContain('"type": "grid"');
  });
});

describe('a new document', () => {
  it('replaces the grid instead of drawing a second one over it', async () => {
    await typeInto('old');
    document.getElementById('btn-new').click();
    await until(dialogOpen);
    choose('discard');
    await until(() => cellAt(0, 0).textContent === '');
    const places = [...document.querySelectorAll('.cell')]
      .map((node) => `${node.dataset.row},${node.dataset.col}`);
    expect(new Set(places).size).toBe(places.length);
    const heads = [...document.querySelectorAll('.column-head')].map((node) => node.textContent);
    expect(new Set(heads).size).toBe(heads.length);
  });
});

describe('keeping unsaved work', () => {
  it('CANARY: a document nobody touched closes without asking', async () => {
    await backend.listeners.get('grt://close-requested')();
    expect(called('close_window')).toHaveLength(1);
  });

  it('asks before New drops a change, and Cancel keeps it', async () => {
    await typeInto('42');
    document.getElementById('btn-new').click();
    await until(dialogOpen);
    expect(dialogTitle()).toBe('Save changes to “Untitled”?');
    choose('cancel');
    await until(() => !dialogOpen());
    expect(cellAt(0, 0).textContent).toBe('42');
  });

  it('asks before closing, and Don’t save closes', async () => {
    await typeInto('42');
    const closing = backend.listeners.get('grt://close-requested')();
    await until(dialogOpen);
    choose('discard');
    await closing;
    expect(called('recovery_discard').length).toBeGreaterThan(0);
    expect(called('close_window')).toHaveLength(1);
  });

  it('a cell still being typed counts as a change when closing', async () => {
    const input = document.getElementById('formula-input');
    input.focus();
    input.value = 'half typed';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    const closing = backend.listeners.get('grt://close-requested')();
    await until(dialogOpen);
    choose('cancel');
    await closing;
    expect(called('close_window')).toHaveLength(0);
    expect(cellAt(0, 0).textContent).toBe('half typed');
  });

  it('a change made while the file is being written still counts as unsaved', async () => {
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    const original = backend.invoke.getMockImplementation();
    backend.invoke.mockImplementation(async (command, payload) => {
      if (command === 'plugin:dialog|save') return '/tmp/sheet.grt';
      if (command === 'write_grt' && payload.path === '/tmp/sheet.grt') await slow;
      return original(command, payload);
    });

    await typeInto('first');
    document.getElementById('btn-save').click();
    await until(() => called('write_grt').some((call) => call.payload.path === '/tmp/sheet.grt'));
    await typeInto('second');
    release();
    await until(() => backend.written.has('/tmp/sheet.grt'));
    await settle();

    expect(backend.written.get('/tmp/sheet.grt')['content/main.json']).not.toContain('second');
    const closing = backend.listeners.get('grt://close-requested')();
    await until(dialogOpen);
    expect(dialogTitle()).toBe('Save changes to “sheet.grt”?');
    choose('cancel');
    await closing;
    expect(called('close_window')).toHaveLength(0);
  });

  it('writes a recovery copy after a pause', async () => {
    await typeInto('kept');
    await until(() => backend.written.has(SLOT.path), 4000);
    expect(backend.written.get(SLOT.path)['content/main.json']).toContain('kept');
    expect(called('recovery_saved').at(-1).payload.meta).toEqual({ path: null, name: 'Untitled' });
  }, 15000);

  it('offers back the work of a run that crashed', async () => {
    const orphan = {
      id: 'fedcba9876543210',
      path: '/cache/fedcba9876543210.grt',
      meta: { path: '/docs/budget.grt', name: 'budget.grt' },
    };
    const fake = fakeBackend({ orphans: [orphan] });
    fake.written.set(orphan.path, {
      'content/main.json': JSON.stringify({
        version: 1, type: 'grid', sheets: [{ name: 'Sheet1', cells: { '0,0': { v: 'recovered' } } }],
      }),
    });
    await boot(fake);
    await until(dialogOpen);
    expect(dialogTitle()).toBe('Recover “budget.grt”?');
    choose('recover');
    await until(() => called('recovery_remove').length > 0);
    expect(cellAt(0, 0).textContent).toBe('recovered');
    expect(called('recovery_remove')[0].payload).toEqual({ id: orphan.id });
  });
});

describe('other programs’ workbooks', () => {
  const idle = async () => { for (let i = 0; i < 10; i += 1) await settle(); };

  function routes(extra) {
    const original = backend.invoke.getMockImplementation();
    backend.invoke.mockImplementation(async (command, payload, options) => {
      const handled = await extra(command, payload, options);
      return handled === undefined ? original(command, payload, options) : handled;
    });
  }

  async function excelFile() {
    const { writeXlsx } = await import('../src/js/core/formats/xlsx.js');
    const { encodeBlock } = await import('../src/js/core/package.js');
    const { entries } = writeXlsx({
      sheets: [{ name: 'Budget', cells: { '0,0': { v: 3 }, '0,1': { v: 4 }, '0,2': { f: '=A1*B1', v: 12 } } }],
      styles: {},
    });
    const index = entries.findIndex((entry) => entry.name === 'xl/worksheets/sheet1.xml');
    entries[index].data = entries[index].data.replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells><sheetProtection sheet="1"/><drawing r:id="rIdX"/>');
    return encodeBlock(entries);
  }

  it('opens an Excel workbook, computes with it, and says what did not come across', async () => {
    const block = await excelFile();
    routes(async (command, payload) => {
      if (command === 'plugin:dialog|open') return '/docs/budget.xlsx';
      if (command === 'read_package') return block;
      return undefined;
    });
    document.getElementById('btn-open').click();
    await until(dialogOpen);
    expect(document.getElementById('panel-title').textContent).toBe('Opened budget.xlsx');
    expect(document.getElementById('panel-body').textContent).toContain('Pictures and drawings');
    document.getElementById('panel-cancel').click();
    await until(() => !dialogOpen());
    await idle();
    expect(cellAt(0, 2).textContent).toBe('12');
    await typeInto('5');
    expect(cellAt(0, 2).textContent).toBe('20');
  });

  it('saves as OpenDocument when asked, with its formulas in OpenFormula', async () => {
    const { decodeBlock } = await import('../src/js/core/package.js');
    let written = null;
    routes(async (command, payload, options) => {
      if (command === 'plugin:dialog|save') return '/docs/new.ods';
      if (command === 'write_package') {
        written = { path: decodeURIComponent(options.headers['x-grt-path']), block: payload };
        return null;
      }
      return undefined;
    });
    await typeInto('2');
    await typeInto('=A1*3');
    document.getElementById('btn-save').click();
    await until(dialogOpen);
    document.querySelector('[data-field="format"]').value = 'ods';
    document.getElementById('panel-confirm').click();
    await until(() => written);
    expect(written.path).toBe('/docs/new.ods');
    const content = decodeBlock(written.block).text('content.xml');
    expect(content).toContain('table:formula="of:=[.A1]*3"');
    expect(content).toContain('office:value="6"');
  });
});

describe('printing', () => {
  const preview = () => document.getElementById('print-view');
  const field = (name) => preview().querySelector(`[data-print-field="${name}"]`);
  const change = (name, value) => {
    const input = field(name);
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  it('previews the sheet, prints it on its paper, and keeps the settings with the file', async () => {
    await typeInto('Heading');
    await typeInto('Figure');
    document.getElementById('btn-print').click();
    await until(() => preview()?.querySelector('.print-page'));
    expect([...preview().querySelectorAll('.print-cell')].map((c) => c.textContent)).toEqual(['Heading', 'Figure']);

    change('orientation', 'landscape');
    await until(() => preview().querySelector('.print-page').style.width === '297mm');
    change('gridlines', true);
    await until(() => preview().querySelectorAll('.print-rule').length > 0);
    change('area', 'A2');
    await until(() => preview().querySelectorAll('.print-cell').length === 1);
    expect(preview().querySelector('.print-cell').textContent).toBe('Figure');

    preview().querySelector('[data-print="go"]').click();
    await until(() => called('print_page').length > 0);
    expect(called('print_page')[0].payload).toEqual({ width: 297, height: 210 });

    preview().querySelector('[data-print="close"]').click();
    await until(() => !preview());

    backend.invoke.mockImplementation(async (command, payload) => {
      if (command.startsWith('plugin:dialog|save')) return '/tmp/printed.grt';
      if (command === 'write_grt') { backend.written.set(payload.path, payload.parts); return undefined; }
      return null;
    });
    document.getElementById('btn-save').click();
    await until(dialogOpen);
    document.getElementById('panel-confirm').click();
    await until(() => backend.written.has('/tmp/printed.grt'));
    const saved = JSON.parse(backend.written.get('/tmp/printed.grt')['content/main.json']);
    expect(saved.sheets[0].print).toEqual({
      orientation: 'landscape', gridlines: true, area: { top: 1, left: 0, bottom: 1, right: 0 },
    });

    document.getElementById('btn-undo').click();
    document.getElementById('btn-print').click();
    await until(() => preview()?.querySelector('.print-page'));
    expect(field('orientation').value).toBe('portrait');
    expect(field('area').value).toBe('');
  });
});

describe('the menus and the data commands', () => {
  const down = (node) => node.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

  /** Opens a menu of the bar and picks an item by its label. */
  async function menu(name, item) {
    down([...document.querySelectorAll('#menubar > button')].find((b) => b.textContent === name));
    await settle();
    const row = [...document.querySelectorAll('.grt-menu [role^="menuitem"]')].find((r) => r.firstChild.textContent === item);
    down(row);
    await settle();
  }

  async function fillColumnAt(col, values) {
    cellAt(0, col).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    for (const value of values) await typeInto(value);
    cellAt(0, 0).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await settle();
  }

  async function fillColumn(values) {
    for (const value of values) await typeInto(value);
    for (let i = 0; i < values.length; i += 1) press('ArrowUp');
    await settle();
  }

  it('a bar of menus, the commands of each also in the palette under LibreOffice’s names', async () => {
    const names = [...document.querySelectorAll('#menubar > button')].map((b) => b.textContent);
    expect(names).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Sheet', 'Data', 'Help']);
    press('k', { ctrlKey: true });
    await settle();
    const input = document.querySelector('.grt-palette input');
    input.value = 'Validity';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    expect(document.querySelector('.grt-palette li').textContent).toMatch(/Validity/);
    press('Escape');
  });

  it('sorts from the Data menu, the header row left in place', async () => {
    await fillColumn(['Name', 'pear', 'apple', 'fig']);
    await menu('Data', 'Sort descending');
    expect([0, 1, 2, 3].map((r) => cellAt(r, 0).textContent)).toEqual(['Name', 'pear', 'fig', 'apple']);
  });

  it('an autofilter puts an arrow on the header, and its list hides rows', async () => {
    await fillColumn(['Fruit', 'pear', 'apple', 'pear']);
    press('l', { ctrlKey: true, shiftKey: true });
    await settle();
    const arrow = cellAt(0, 0).querySelector('.filter-button');
    expect(arrow).not.toBeNull();
    down(arrow);
    await until(dialogOpen);
    const boxes = [...document.querySelectorAll('#panel-body input[type="checkbox"]')];
    boxes.find((b) => b.parentElement.textContent.trim() === 'pear').checked = false;
    choose('apply');
    await settle();
    expect(document.querySelector('.row-head[data-row="1"]').hidden).toBe(true);
    expect(document.querySelector('.row-head[data-row="2"]').hidden).toBe(false);
    expect(cellAt(0, 0).querySelector('.filter-button').classList.contains('on')).toBe(true);
  });

  it('validity refuses a value outside the rule, and says why', async () => {
    await menu('Data', 'Validity…');
    await until(dialogOpen);
    const field = (name) => document.querySelector(`#panel-body [data-field="${name}"]`);
    field('type').value = 'whole';
    field('op').value = 'between';
    field('v1').value = '1';
    field('v2').value = '10';
    field('errorMessage').value = 'From 1 to 10.';
    choose('apply');
    await settle();
    await typeInto('42');
    await until(dialogOpen);
    expect(document.getElementById('panel-body').textContent).toContain('From 1 to 10.');
    document.getElementById('panel-cancel').click();
    await settle();
    expect(cellAt(0, 0).textContent).toBe('');
    press('ArrowUp');
    await typeInto('7');
    expect(cellAt(0, 0).textContent).toBe('7');
  });

  it('a list of choices drops down with Alt+Down and writes the one picked', async () => {
    await menu('Data', 'Validity…');
    await until(dialogOpen);
    document.querySelector('#panel-body [data-field="type"]').value = 'list';
    document.querySelector('#panel-body [data-field="list"]').value = 'red\ngreen\nblue';
    choose('apply');
    await settle();
    expect(cellAt(0, 0).querySelector('.list-button')).not.toBeNull();
    press('ArrowDown', { altKey: true });
    await until(() => document.querySelector('.choice-list'));
    press('ArrowDown');
    press('Enter');
    await settle();
    expect(cellAt(0, 0).textContent).toBe('green');
  });

  it('conditional formatting colours the cells that meet the rule', async () => {
    await fillColumn(['5', '50']);
    press('ArrowDown', { shiftKey: true });
    await settle();
    await menu('Format', 'Conditional formatting…');
    await until(dialogOpen);
    document.querySelector('#panel-body [data-field="op"]').value = '>';
    document.querySelector('#panel-body [data-field="value1"]').value = '10';
    choose('add');
    await settle();
    expect(cellAt(1, 0).style.background || cellAt(1, 0).style.backgroundColor).not.toBe('');
    expect(cellAt(0, 0).style.background || cellAt(0, 0).style.backgroundColor).toBe('');
  });

  it('find and replace changes every match', async () => {
    await fillColumn(['cat', 'dog', 'catalogue']);
    press('h', { ctrlKey: true });
    await until(dialogOpen);
    document.querySelector('#panel-body [data-field="find"]').value = 'cat';
    document.querySelector('#panel-body [data-field="replace"]').value = 'cow';
    choose('all');
    await settle();
    expect([0, 1, 2].map((r) => cellAt(r, 0).textContent)).toEqual(['cow', 'dog', 'cowalogue']);
  });

  it('merging asks first when it would empty cells', async () => {
    await fillColumn(['a', 'b']);
    press('ArrowDown', { shiftKey: true });
    await settle();
    await menu('Format', 'Merge cells');
    await until(dialogOpen);
    choose('merge');
    await settle();
    expect(cellAt(0, 0).classList.contains('merged')).toBe(true);
    expect(cellAt(0, 0).textContent).toBe('a');
  });

  it('Ctrl+B makes the selection bold, and again takes it off', async () => {
    await typeInto('word');
    press('ArrowUp');
    press('b', { ctrlKey: true });
    await settle();
    expect(cellAt(0, 0).style.fontWeight).toBe('700');
    press('b', { ctrlKey: true });
    await settle();
    expect(cellAt(0, 0).style.fontWeight).toBe('');
  });

  it('Format cells shows the change before it is applied, and applies it on top of the named style', async () => {
    await typeInto('1234.5');
    press('ArrowUp');
    const picker = document.getElementById('style-picker');
    picker.value = 'header';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
    press('1', { ctrlKey: true });
    await until(dialogOpen);
    const field = (name) => document.querySelector(`#panel-body [data-field="${name}"]`);
    field('formatChoice').value = '#,##0.00';
    field('formatChoice').dispatchEvent(new window.Event('change', { bubbles: true }));
    field('italic').checked = true;
    field('italic').dispatchEvent(new window.Event('change', { bubbles: true }));
    field('borders').value = 'outline';
    expect(document.getElementById('format-sample').textContent).toBe('1,234.50');
    expect(document.getElementById('format-sample').style.fontStyle).toBe('italic');
    expect(cellAt(0, 0).textContent).toBe('1234.5');
    document.getElementById('panel-confirm').click();
    await settle();
    expect(cellAt(0, 0).textContent).toBe('1,234.50');
    expect(cellAt(0, 0).style.fontStyle).toBe('italic');
    expect(cellAt(0, 0).style.fontWeight).toBe('700');
    expect(cellAt(0, 0).style.borderTop).toMatch(/solid/);
    expect(picker.value).toBe('header');
    press('m', { ctrlKey: true });
    await settle();
    expect(cellAt(0, 0).style.fontStyle).toBe('');
    expect(cellAt(0, 0).style.fontWeight).toBe('700');
  });

  it('a new named style joins the list and changes every cell when updated', async () => {
    await fillColumn(['a', 'b']);
    press('b', { ctrlKey: true });
    await settle();
    press('F11');
    await until(dialogOpen);
    document.querySelector('#panel-body [data-field="name"]').value = 'Total';
    choose('new');
    await settle();
    const picker = document.getElementById('style-picker');
    expect([...picker.options].map((o) => o.textContent)).toContain('Total');
    press('ArrowDown');
    picker.value = 'named-total';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
    expect(cellAt(1, 0).style.fontWeight).toBe('700');
    press('i', { ctrlKey: true });
    await settle();
    press('F11');
    await until(dialogOpen);
    document.querySelector('#panel-body [data-field="style"]').value = 'named-total';
    choose('update');
    await settle();
    expect(cellAt(0, 0).style.fontStyle).toBe('italic');
  });

  it('inserts a chart of the data from the menu, and it follows the data', async () => {
    await fillColumn(['Fruit', 'pear', 'apple']);
    press('ArrowRight');
    await fillColumnAt(1, ['Kilos', '3', '5']);
    await menu('Insert', 'Chart…');
    await until(dialogOpen);
    expect(document.querySelector('#chart-preview svg')).not.toBeNull();
    document.querySelector('#panel-body [data-field="title"]').value = 'Stock';
    document.getElementById('panel-confirm').click();
    await settle();
    const frame = document.querySelector('.chart-frame');
    expect(frame.querySelector('svg').textContent).toContain('Stock');
    expect(frame.querySelectorAll('rect[fill="#2f6fdf"]')).toHaveLength(2);
    press('Escape');
    cellAt(2, 1).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await typeInto('9');
    expect(document.querySelector('.chart-frame svg').textContent).toContain('9');
    down(document.querySelector('.chart-frame'));
    document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
    await settle();
    expect(document.querySelector('.chart-frame').classList.contains('chosen')).toBe(true);
    press('Delete');
    await settle();
    expect(document.querySelector('.chart-frame')).toBeNull();
  });
});
