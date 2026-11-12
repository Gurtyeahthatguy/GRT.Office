// @vitest-environment jsdom

/** The shared menu bar: menus, submenus, keyboard, and the palette's list of commands. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMenubar, paletteEntries } from '../src/js/core/menubar.js';

let ran;
const menus = () => [
  { label: 'Format', items: [
    { label: 'Bold', run: () => ran.push('bold'), shortcut: 'Ctrl+B' },
    { label: 'Text', items: [
      { label: 'UPPERCASE', run: () => ran.push('upper') },
      { label: 'lowercase', run: () => ran.push('lower'), shortcut: 'Ctrl+Alt+L' },
    ] },
  ] },
  { label: 'Help', items: [{ label: 'About', run: () => ran.push('about') }] },
];

const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const rowNamed = (name) => [...document.querySelectorAll('.grt-menu [role^="menuitem"]')].find((r) => r.firstChild.textContent === name);

beforeEach(() => {
  ran = [];
  document.body.innerHTML = '<nav id="bar"></nav>';
});

describe('a submenu', () => {
  it('opens beside its row and runs what is chosen in it', () => {
    createMenubar(document.getElementById('bar'), menus());
    document.querySelector('#bar > button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    rowNamed('Text').dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelectorAll('.grt-menu')).toHaveLength(2);
    rowNamed('UPPERCASE').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ran).toEqual(['upper']);
    expect(document.querySelectorAll('.grt-menu')).toHaveLength(0);
  });

  it('is reached by the keyboard: down to it, right into it, Enter on an item, left back out', () => {
    createMenubar(document.getElementById('bar'), menus());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true }));
    key('ArrowDown');
    key('ArrowRight');
    // Each test leaves a bar behind on the one document, so menus are counted by name.
    expect(document.querySelector('.grt-menu[aria-label="Text"]')).not.toBeNull();
    key('ArrowLeft');
    expect(document.querySelector('.grt-menu[aria-label="Text"]')).toBeNull();
    key('ArrowRight');
    key('ArrowDown');
    key('Enter');
    expect([...new Set(ran)]).toEqual(['lower']);
  });

  it('gives the palette its items with the way to them, and binds their shortcuts', () => {
    createMenubar(document.getElementById('bar'), menus());
    const entries = paletteEntries(menus());
    expect(entries.map((e) => `${e.detail}: ${e.label}`)).toEqual(['Format: Bold', 'Format › Text: UPPERCASE', 'Format › Text: lowercase', 'Help: About']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true }));
    expect([...new Set(ran)]).toEqual(['lower']);
  });
});
