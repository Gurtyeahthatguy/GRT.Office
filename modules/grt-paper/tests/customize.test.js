// @vitest-environment jsdom

/** Customize: keys written as menus write them, the person's shortcuts put on the menus, and the dialog that changes them. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chordFromEvent, cleanOverrides, applyShortcuts, customizeDialog, commandsOf } from '../src/js/core/customize.js';
import { createMenubar } from '../src/js/core/menubar.js';

const key = (init) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

function makeMenus(calls) {
  return [
    { label: 'File', items: [
      { label: 'Save', shortcut: 'Ctrl+S', run: () => calls.push('save') },
      { label: 'Export', items: [{ label: 'PDF…', run: () => calls.push('pdf') }] },
    ] },
    { label: 'Edit', items: [{ label: 'Find', shortcut: 'Ctrl+F', run: () => calls.push('find') }, 'separator', { label: 'Group' }] },
  ];
}

beforeEach(() => {
  document.body.innerHTML = `<div id="menubar"></div><div id="overlay" class="hidden"><h2 id="panel-title"></h2><div id="panel-body"></div>
    <div class="panel-actions"><button id="panel-cancel">Close</button><button id="panel-confirm" class="hidden">OK</button></div></div>`;
});

describe('keys', () => {
  it('writes what was pressed as the menus write it', () => {
    expect(chordFromEvent(key({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+K');
    expect(chordFromEvent(key({ key: 'F7', code: 'F7' }))).toBe('F7');
    expect(chordFromEvent(key({ key: '3', code: 'Digit3', altKey: true }))).toBe('Alt+3');
    expect(chordFromEvent(key({ key: 'ArrowUp', ctrlKey: true }))).toBe('Ctrl+Up');
    expect(chordFromEvent(key({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }))).toBe('Ctrl++');
    expect(chordFromEvent(key({ key: 'k', code: 'KeyK' }))).toBeNull();
    expect(chordFromEvent(key({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBeNull();
  });
});

describe('the person\'s shortcuts', () => {
  it('keeps only overrides for commands that exist, with keys that can be a shortcut', () => {
    const menus = makeMenus([]);
    expect(cleanOverrides({ 'File/Save': 'Ctrl+Alt+S', 'File/Export/PDF…': '', 'Nope/X': 'Ctrl+X', 'Edit/Find': 'k', 'Edit/Group': 'Ctrl+G' }, menus))
      .toEqual({ 'File/Save': 'Ctrl+Alt+S', 'File/Export/PDF…': '' });
    expect(cleanOverrides('junk', menus)).toEqual({});
  });

  it('puts them on the menus, takes a taken key from its old command, and goes back on reset', () => {
    const calls = [];
    const menus = makeMenus(calls);
    createMenubar(document.getElementById('menubar'), menus);
    applyShortcuts(menus, { 'File/Export/PDF…': 'Ctrl+S' });
    const [save, pdf] = [menus[0].items[0], menus[0].items[1].items[0]];
    expect(save.shortcut).toBeUndefined();
    expect(pdf.shortcut).toBe('Ctrl+S');
    // A shortcut the person gave wins over the program's own handling of the keys.
    document.addEventListener('keydown', (event) => { if (event.ctrlKey) { event.preventDefault(); calls.push('program'); } });
    document.body.dispatchEvent(key({ key: 's', code: 'KeyS', ctrlKey: true }));
    expect(calls).toEqual(['pdf']);
    applyShortcuts(menus, {});
    expect([save.shortcut, pdf.shortcut]).toEqual(['Ctrl+S', undefined]);
    expect(commandsOf(menus).map((c) => c.id)).toEqual(['File/Save', 'File/Export/PDF…', 'Edit/Find']);
  });
});

describe('the dialog', () => {
  it('assigns pressed keys to the chosen command, removes one, and gives back only what differs', async () => {
    const menus = makeMenus([]);
    const done = customizeDialog(menus, {});
    const body = document.getElementById('panel-body');
    const filter = body.querySelector('[data-cz-filter]');
    filter.value = 'pdf';
    filter.dispatchEvent(new Event('input'));
    expect(body.querySelectorAll('[data-cz-id]')).toHaveLength(1);
    body.querySelector('[data-cz-id]').click();
    const keys = body.querySelector('[data-cz-keys]');
    keys.dispatchEvent(key({ key: 'f', code: 'KeyF', ctrlKey: true }));
    expect(keys.value).toBe('Ctrl+F');
    // The dialog stays open: the field keeps its keys, even Enter with Ctrl.
    keys.dispatchEvent(key({ key: 'Enter', ctrlKey: true }));
    expect(document.getElementById('overlay').classList.contains('hidden')).toBe(false);
    keys.dispatchEvent(key({ key: 'f', code: 'KeyF', ctrlKey: true }));
    body.querySelector('[data-cz-assign]').click();
    expect(body.querySelector('[data-cz-state]').textContent).toMatch(/no longer Find/);
    filter.value = 'save';
    filter.dispatchEvent(new Event('input'));
    body.querySelector('[data-cz-id]').click();
    body.querySelector('[data-cz-remove]').click();
    document.querySelector('[data-choice="ok"]').click();
    expect(await done).toEqual({ 'File/Save': '', 'File/Export/PDF…': 'Ctrl+F', 'Edit/Find': '' });
  });

  it('gives nothing back when cancelled, and resets everything when asked', async () => {
    const menus = makeMenus([]);
    let done = customizeDialog(menus, { 'File/Save': 'Ctrl+Alt+S' });
    document.querySelector('[data-choice="cancel"]').click();
    expect(await done).toBeNull();
    done = customizeDialog(menus, { 'File/Save': 'Ctrl+Alt+S' });
    document.querySelector('[data-cz-reset]').click();
    document.querySelector('[data-choice="ok"]').click();
    expect(await done).toEqual({});
  });
});
