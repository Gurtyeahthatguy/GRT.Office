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

/**
 * A context menu's items from menu commands by their paths, as LibreOffice's right click repeats its menus; 'separator' stays, a missing command is left out.
 * @param {Object[]} menus
 * @param {string[]} paths such as 'Edit/Cut'
 */
export function contextItems(menus, paths) {
  const index = commandIndex(menus);
  const out = [];
  for (const path of paths) {
    if (path === 'separator') { if (out.length && out[out.length - 1] !== 'separator') out.push(path); continue; }
    const item = index.get(path);
    if (item?.run) out.push({ label: item.label, run: item.run, enabled: item.enabled });
  }
  while (out[out.length - 1] === 'separator') out.pop();
  return out;
}

/** A typed box of the Formatting bar: Enter or leaving it sets the value, Escape takes it back, and the document has the keys again unless another control was chosen. */
export function barBox(box, apply, back) {
  let given = box.value;
  let leavingTo = null;
  const give = () => { if (box.value !== given) { given = box.value; apply(box.value); } };
  // As in LibreOffice the first character typed on entering the box takes the place of what it shows.
  let fresh = false;
  box.addEventListener('mousedown', () => { if (box.ownerDocument.activeElement === box) fresh = false; });
  box.addEventListener('focus', () => { given = box.value; fresh = true; box.select(); });
  // The change comes before the blur, and setting the page's selection may take the focus: the control pressed has it back.
  box.addEventListener('blur', (event) => { leavingTo = event.relatedTarget; });
  box.addEventListener('change', () => {
    give();
    setTimeout(() => {
      const to = leavingTo;
      leavingTo = null;
      if (to?.matches?.('input, select, textarea, button')) to.focus();
      else back();
    });
  });
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); give(); back(); }
    else if (event.key === 'Escape') { event.preventDefault(); box.value = given; back(); }
    else if (fresh && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { box.value = ''; fresh = false; }
    else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) fresh = false;
  });
}
