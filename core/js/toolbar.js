/**
 * Toolbars as LibreOffice lays them out, Standard and Formatting under the menus: each button runs the menu command
 * it names, so a button and its menu item never disagree, and shows whether that command is on or can be used.
 */

import { leaves } from './menubar.js';
import { icon } from './icons.js';

const isOn = (test) => (typeof test === 'function' ? test() : test !== false);

/** Every leaf of the menus by its path, as `Menu/Submenu/Item`. */
export function commandIndex(menus) {
  const index = new Map();
  for (const menu of menus) for (const { item, path } of leaves(menu.items)) index.set([menu.label, ...path, item.label].join('/'), item);
  return index;
}

/**
 * Wires the buttons under `root`: `data-icon` draws an icon; `data-command` runs that menu command, takes its name,
 * shortcut and state, and is left out when the program has no such command.
 * @returns {{refresh: Function}}
 */
export function wireToolbars(root, menus) {
  const index = commandIndex(menus);
  const commanded = [];
  for (const button of root.querySelectorAll('[data-icon]')) {
    const drawn = icon(button.dataset.icon);
    if (!drawn || button.querySelector('.grt-icon')) continue;
    const label = button.getAttribute('aria-label') || button.textContent.trim() || button.title;
    button.setAttribute('aria-label', label);
    button.innerHTML = drawn;
    button.classList.add('icon-button');
  }
  for (const button of root.querySelectorAll('[data-command]')) {
    const item = index.get(button.dataset.command);
    if (!item?.run) {
      button.remove();
      continue;
    }
    const name = item.label.replace(/…$/, '');
    if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', name);
    button.title = `${name}${item.shortcut ? ` (${item.shortcut})` : ''}`;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => { item.run(); refresh(); });
    commanded.push({ button, item });
  }
  // A group left empty goes too, so no separator stands alone.
  for (const group of root.querySelectorAll('.group')) if (!group.querySelector('button, select, input')) group.remove();

  function refresh() {
    for (const { button, item } of commanded) {
      button.disabled = !isOn(item.enabled ?? true);
      if (item.checked !== undefined) button.setAttribute('aria-pressed', String(isOn(item.checked)));
    }
  }
  refresh();
  return { refresh };
}
