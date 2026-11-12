/** Customize: the person's own keyboard shortcuts for menu commands, kept in the program's settings. */

import { showChoice, escapeHtml } from './panel.js';
import { leaves, chordOf } from './menubar.js';

/** Every command of the menus with its id, as the palette names it, and the shortcut it was given by the program. */
export function commandsOf(menus) {
  const out = [];
  for (const menu of menus) {
    for (const { item, path } of leaves(menu.items)) {
      if (!item.run) continue;
      if (!('defaultShortcut' in item)) item.defaultShortcut = item.shortcut ?? '';
      out.push({ id: [menu.label, ...path, item.label].join('/'), label: item.label, where: [menu.label, ...path].join(' › '), item });
    }
  }
  return out;
}

/** The keys an event pressed, written as menus write them; null for keys a shortcut cannot be, such as a plain letter. */
export function chordFromEvent(event) {
  const mods = [];
  if (event.ctrlKey || event.metaKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  let key = null;
  let shift = event.shiftKey;
  if (/^Key[A-Z]$/.test(event.code ?? '')) key = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code ?? '')) key = event.code.slice(5);
  else if (/^F\d{1,2}$/.test(event.key) || ['Enter', 'Delete', 'Insert'].includes(event.key)) key = event.key;
  else if (/^Arrow(Left|Right|Up|Down)$/.test(event.key)) key = event.key.slice(5);
  else if (typeof event.key === 'string' && [...event.key].length === 1 && !/\s/.test(event.key)) {
    // Punctuation is read as typed, so Shift belongs to the layout, not to the shortcut.
    key = event.key;
    shift = false;
  }
  if (!key) return null;
  if (shift) mods.push('Shift');
  const text = [...mods, key].join('+');
  return chordOf(text) ? text : null;
}

/** Overrides from a settings file, kept only where the command exists and the keys can be a shortcut. */
export function cleanOverrides(overrides, menus) {
  const ids = new Set(commandsOf(menus).map((c) => c.id));
  const out = {};
  for (const [id, chord] of Object.entries(overrides && typeof overrides === 'object' ? overrides : {})) {
    if (!ids.has(id) || typeof chord !== 'string') continue;
    if (chord === '' || (chord.length <= 40 && chordOf(chord))) out[id] = chord;
  }
  return out;
}

/** Puts the person's shortcuts on the menus; a command they did not change keeps the program's. */
export function applyShortcuts(menus, overrides) {
  const clean = cleanOverrides(overrides, menus);
  const given = new Set(Object.values(clean).filter(Boolean).map((c) => c.toLowerCase()));
  for (const command of commandsOf(menus)) {
    const { item } = command;
    if (command.id in clean) {
      item.shortcut = clean[command.id] || undefined;
      item.customShortcut = Boolean(clean[command.id]);
    } else {
      // A program's shortcut given by the person to another command leaves this one.
      item.shortcut = item.defaultShortcut && !given.has(item.defaultShortcut.toLowerCase()) ? item.defaultShortcut : undefined;
      item.customShortcut = false;
    }
  }
  return clean;
}

/**
 * The Customize dialog: commands found by typing, a shortcut pressed and assigned, removed, or all reset.
 * @returns {Promise<?Object>} the new overrides, or null when cancelled
 */
export async function customizeDialog(menus, overrides) {
  const commands = commandsOf(menus);
  // What each command's shortcut is while the dialog is open.
  const current = new Map(commands.map((c) => [c.id, c.id in overrides ? overrides[c.id] : c.item.defaultShortcut ?? '']));
  for (const c of commands) if (!(c.id in overrides) && Object.values(overrides).some((v) => v && v.toLowerCase() === (c.item.defaultShortcut ?? '').toLowerCase())) current.set(c.id, '');
  const answer = showChoice('Customize', `
    <label>Find<input data-cz-filter placeholder="Part of a command's name or its keys"></label>
    <div class="template-list customize-list" role="listbox" aria-label="Commands"></div>
    <div class="customize-keys">
      <label>New shortcut<input data-cz-keys data-keeps-keys readonly placeholder="Press the keys here"></label>
      <button type="button" data-cz-assign>Assign</button>
      <button type="button" data-cz-remove>Remove</button>
      <button type="button" data-cz-reset>Reset All</button>
    </div>
    <p class="hint" data-cz-state>A shortcut needs Ctrl or Alt, or is a function key. Keys the text itself uses, such as the arrows alone, cannot be taken.</p>`,
  [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', primary: true }]);
  const panel = document.getElementById('panel-body');
  const list = panel.querySelector('.customize-list');
  const filter = panel.querySelector('[data-cz-filter]');
  const keys = panel.querySelector('[data-cz-keys]');
  const state = panel.querySelector('[data-cz-state]');
  let chosen = null;

  function draw() {
    const text = filter.value.trim().toLowerCase();
    const rows = commands
      .filter((c) => !text || `${c.label} ${c.where} ${current.get(c.id)}`.toLowerCase().includes(text))
      .slice(0, 400)
      .map((c) => `<button type="button" role="option" class="customize-row${c.id === chosen ? ' chosen' : ''}" data-cz-id="${escapeHtml(c.id)}" aria-selected="${c.id === chosen}">
        <span>${escapeHtml(c.label)} <span class="hint">${escapeHtml(c.where)}</span></span><code>${escapeHtml(current.get(c.id) || '')}</code></button>`);
    list.innerHTML = rows.join('') || '<p class="hint">No command has that name.</p>';
  }

  filter.addEventListener('input', draw);
  list.addEventListener('click', (event) => {
    const row = event.target.closest('[data-cz-id]');
    if (!row) return;
    chosen = row.dataset.czId;
    draw();
    keys.focus();
  });
  keys.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') return;
    // Escape alone still closes the dialog.
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey) {
      document.getElementById('panel-cancel')?.click();
      document.querySelector('[data-choice="cancel"]')?.click();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    const chord = chordFromEvent(event);
    keys.value = chord ?? '';
    state.textContent = chord ? `Press Assign to give ${chord} to the chosen command.` : 'Those keys cannot be a shortcut: use Ctrl or Alt with them, or a function key.';
  });
  panel.querySelector('[data-cz-assign]').addEventListener('click', () => {
    if (!chosen || !keys.value) {
      state.textContent = 'Choose a command and press its new keys first.';
      return;
    }
    const taken = commands.find((c) => c.id !== chosen && (current.get(c.id) ?? '').toLowerCase() === keys.value.toLowerCase());
    if (taken) current.set(taken.id, '');
    current.set(chosen, keys.value);
    state.textContent = taken ? `${keys.value} now runs ${chosen.split('/').pop()}, no longer ${taken.label}.` : `${keys.value} now runs ${chosen.split('/').pop()}.`;
    draw();
  });
  panel.querySelector('[data-cz-remove]').addEventListener('click', () => {
    if (!chosen) return;
    current.set(chosen, '');
    draw();
  });
  panel.querySelector('[data-cz-reset]').addEventListener('click', () => {
    for (const c of commands) current.set(c.id, c.item.defaultShortcut ?? '');
    state.textContent = 'Every shortcut is back to the program\'s own.';
    draw();
  });
  draw();
  filter.focus();

  if (await answer !== 'ok') return null;
  const out = {};
  for (const c of commands) {
    const now = current.get(c.id) ?? '';
    if (now !== (c.item.defaultShortcut ?? '')) out[c.id] = now;
  }
  return out;
}
