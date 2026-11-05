/** A menu bar, the same in every module: reached by mouse or keyboard, and the source of the command palette. */

const STYLE_ID = 'grt-menubar-style';

const CSS = `
.grt-menubar { display: flex; gap: 2px; padding: 2px 6px; background: var(--bg-sunken, #eee); border-bottom: 1px solid var(--border, #ccc); font: 13px system-ui, sans-serif; user-select: none; }
.grt-menubar > button { background: none; border: none; color: var(--text, #111); padding: 4px 9px; border-radius: 4px; font: inherit; cursor: default; }
.grt-menubar > button[aria-expanded="true"], .grt-menubar > button:focus-visible { background: color-mix(in srgb, var(--accent, #1f6feb) 18%, transparent); outline: none; }
.grt-menu { position: fixed; z-index: 40; min-width: 220px; max-height: 80vh; overflow-y: auto; padding: 4px; background: var(--bg-raised, #fff); color: var(--text, #111); border: 1px solid var(--border, #ccc); border-radius: 6px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3); font: 13px system-ui, sans-serif; }
.grt-menu [role="menuitem"], .grt-menu [role="menuitemcheckbox"] { display: flex; justify-content: space-between; gap: 24px; padding: 5px 10px; border-radius: 4px; white-space: nowrap; cursor: default; }
.grt-menu [aria-disabled="true"] { opacity: 0.45; }
.grt-menu .active { background: var(--accent, #1f6feb); color: #fff; }
.grt-menu .active .grt-menu-hint { color: rgba(255, 255, 255, 0.85); }
.grt-menu-hint { color: var(--text-dim, #777); font-size: 12px; }
.grt-menu hr { border: none; border-top: 1px solid var(--border, #ccc); margin: 4px 2px; }
.grt-menu [aria-checked="true"]::before { content: "✓ "; }
`;

function installStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}

const isOn = (test) => (typeof test === 'function' ? test() : test !== false);

/**
 * Puts a menu bar in `host`.
 * @param {HTMLElement} host
 * @param {{label: string, items: Array}[]} menus each item {label, run, shortcut?, enabled?, checked?, aliases?, items?} or 'separator'
 */
export function createMenubar(host, menus) {
  const doc = host.ownerDocument;
  installStyle(doc);
  host.classList.add('grt-menubar');
  host.setAttribute('role', 'menubar');
  host.replaceChildren();
  const buttons = menus.map((menu, index) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = menu.label;
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.tabIndex = index === 0 ? 0 : -1;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (open?.index === index) close();
      else show(index);
    });
    button.addEventListener('mouseenter', () => { if (open && open.index !== index) show(index); });
    host.append(button);
    return button;
  });

  /** The menu on screen: its index, its element, the items it lists and the one marked. */
  let open = null;

  function close() {
    if (!open) return;
    open.element.remove();
    buttons[open.index].setAttribute('aria-expanded', 'false');
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('mousedown', onOutside, true);
    open = null;
  }

  function show(index, focusFirst = false) {
    close();
    const menu = menus[index];
    const element = doc.createElement('div');
    element.className = 'grt-menu';
    element.setAttribute('role', 'menu');
    element.setAttribute('aria-label', menu.label);
    const entries = [];
    for (const item of menu.items) {
      if (item === 'separator') {
        element.append(doc.createElement('hr'));
        continue;
      }
      const row = doc.createElement('div');
      const checkable = item.checked !== undefined;
      row.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
      if (checkable) row.setAttribute('aria-checked', String(isOn(item.checked)));
      const enabled = isOn(item.enabled ?? true);
      if (!enabled) row.setAttribute('aria-disabled', 'true');
      const label = doc.createElement('span');
      label.textContent = item.label;
      const hint = doc.createElement('span');
      hint.className = 'grt-menu-hint';
      hint.textContent = item.shortcut ?? '';
      row.append(label, hint);
      row.addEventListener('mouseenter', () => mark(entries.findIndex((e) => e.row === row)));
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (enabled) activate(item);
      });
      element.append(row);
      entries.push({ row, item, enabled });
    }
    const box = buttons[index].getBoundingClientRect();
    element.style.left = `${Math.round(box.left)}px`;
    element.style.top = `${Math.round(box.bottom + 2)}px`;
    doc.body.append(element);
    buttons[index].setAttribute('aria-expanded', 'true');
    open = { index, element, entries, at: -1 };
    if (focusFirst) mark(entries.findIndex((e) => e.enabled));
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('mousedown', onOutside, true);
  }

  function mark(at) {
    if (!open) return;
    open.entries.forEach((e, i) => e.row.classList.toggle('active', i === at));
    open.at = at;
    open.entries[at]?.row.scrollIntoView?.({ block: 'nearest' });
  }

  function activate(item) {
    close();
    item.run?.();
  }

  function onOutside(event) {
    if (!open) return;
    if (open.element.contains(event.target) || host.contains(event.target)) return;
    close();
  }

  function onKey(event) {
    if (!open) return;
    const { entries } = open;
    const step = (from, by) => {
      for (let i = 1; i <= entries.length; i += 1) {
        const next = (from + by * i + entries.length * 2) % entries.length;
        if (entries[next].enabled) return next;
      }
      return from;
    };
    switch (event.key) {
      case 'Escape': close(); buttons[0].focus(); break;
      case 'ArrowDown': mark(step(open.at, 1)); break;
      case 'ArrowUp': mark(step(open.at < 0 ? 0 : open.at, -1)); break;
      case 'ArrowRight': show((open.index + 1) % menus.length, true); break;
      case 'ArrowLeft': show((open.index - 1 + menus.length) % menus.length, true); break;
      case 'Enter': case ' ': if (open.at >= 0 && entries[open.at].enabled) activate(entries[open.at].item); break;
      default: {
        // A letter jumps to the next item that starts with it.
        if (event.key.length !== 1) return;
        const letter = event.key.toLowerCase();
        const found = entries.findIndex((e, i) => i > open.at && e.enabled && e.item.label.toLowerCase().startsWith(letter));
        const again = found === -1 ? entries.findIndex((e) => e.enabled && e.item.label.toLowerCase().startsWith(letter)) : found;
        if (again !== -1) mark(again);
      }
    }
    event.preventDefault();
    event.stopPropagation();
  }

  // F10 and Alt open the first menu, as desktop programs do.
  doc.addEventListener('keydown', (event) => {
    if (open) return;
    if (event.key === 'F10' || (event.altKey && !event.ctrlKey && event.key.length === 1)) {
      const index = event.key === 'F10' ? 0 : menus.findIndex((m) => m.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (index === -1) return;
      event.preventDefault();
      show(index, true);
    }
  });

  // Every shortcut a menu shows works, unless the program has already answered the key itself.
  const bound = menus.flatMap((menu) => menu.items).filter((item) => item !== 'separator' && item.run && item.shortcut && chordOf(item.shortcut));
  doc.defaultView.addEventListener('keydown', (event) => {
    if (open || event.defaultPrevented || busyElsewhere(doc, event)) return;
    const item = bound.find((each) => matches(chordOf(each.shortcut), event));
    if (!item || !isOn(item.enabled ?? true)) return;
    event.preventDefault();
    item.run();
  });

  return { close, show, get isOpen() { return Boolean(open); } };
}

/**
 * A menu of items at the pointer, closed by a choice, Escape or a click elsewhere.
 * @param {MouseEvent} event the contextmenu event, whose place the menu opens at
 * @param {(object|'separator')[]} items as in a menu of the bar
 */
export function showContextMenu(event, items) {
  event.preventDefault();
  const doc = event.target.ownerDocument ?? document;
  installStyle(doc);
  const element = doc.createElement('div');
  element.className = 'grt-menu';
  element.setAttribute('role', 'menu');
  const entries = [];
  let at = -1;
  const mark = (index) => {
    entries.forEach((e, i) => e.row.classList.toggle('active', i === index));
    at = index;
  };
  const close = () => {
    element.remove();
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('mousedown', onOutside, true);
  };
  const activate = (item) => {
    close();
    item.run?.();
  };
  for (const item of items) {
    if (item === 'separator') {
      element.append(doc.createElement('hr'));
      continue;
    }
    const row = doc.createElement('div');
    row.setAttribute('role', 'menuitem');
    const enabled = isOn(item.enabled ?? true);
    if (!enabled) row.setAttribute('aria-disabled', 'true');
    const label = doc.createElement('span');
    label.textContent = item.label;
    row.append(label);
    row.addEventListener('mouseenter', () => mark(entries.findIndex((e) => e.row === row)));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (enabled) activate(item);
    });
    element.append(row);
    entries.push({ row, item, enabled });
  }
  function onOutside(e) {
    if (!element.contains(e.target)) close();
  }
  function onKey(e) {
    const step = (by) => {
      for (let i = 1; i <= entries.length; i += 1) {
        const next = (at + by * i + entries.length * 2) % entries.length;
        if (entries[next].enabled) return next;
      }
      return at;
    };
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') mark(step(1));
    else if (e.key === 'ArrowUp') mark(step(at < 0 ? 0 : -1));
    else if ((e.key === 'Enter' || e.key === ' ') && entries[at]?.enabled) activate(entries[at].item);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  doc.body.append(element);
  // Kept inside the window.
  const view = doc.defaultView;
  const box = element.getBoundingClientRect();
  element.style.left = `${Math.max(0, Math.min(event.clientX, view.innerWidth - box.width - 4))}px`;
  element.style.top = `${Math.max(0, Math.min(event.clientY, view.innerHeight - box.height - 4))}px`;
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('mousedown', onOutside, true);
  return { close };
}

/** A shortcut as written in a menu, such as Ctrl+Alt+F or F11; plain keys are left to the program. */
function chordOf(text) {
  const parts = String(text).split('+');
  // "Ctrl++" names the plus key.
  if (parts.at(-1) === '' && parts.length > 1) {
    parts.pop();
    parts[parts.length - 1] = '+';
  }
  const key = parts.pop();
  const mods = new Set(parts.map((m) => m.toLowerCase()));
  const chord = { ctrl: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift'), key };
  return chord.ctrl || chord.alt || /^F\d{1,2}$/.test(key) ? chord : null;
}

function matches(chord, event) {
  if (chord.ctrl !== (event.ctrlKey || event.metaKey) || chord.alt !== event.altKey) return false;
  const key = chord.key;
  if (/^[A-Za-z]$/.test(key)) return chord.shift === event.shiftKey && event.code === `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return chord.shift === event.shiftKey && event.code === `Digit${key}`;
  if (/^F\d{1,2}$/.test(key) || key === 'Enter' || key === 'Delete' || key === 'Insert') return chord.shift === event.shiftKey && event.key === key;
  // Punctuation is read as typed, so Shift is whatever the layout needs for it.
  return event.key === key;
}

/** Whether a dialog, the palette or a field of a form has the keyboard. */
function busyElsewhere(doc, event) {
  if (doc.querySelector('#overlay:not(.hidden), .grt-palette, #print-view')) return true;
  const target = event.target;
  return Boolean(target?.closest?.('input, textarea, select') && !target.isContentEditable);
}

/**
 * Every command of the menus as the palette lists it: the menu's name before the item's, and the names
 * other programs give it as aliases.
 */
export function paletteEntries(menus) {
  const out = [];
  for (const menu of menus) {
    for (const item of menu.items) {
      if (item === 'separator' || !item.run) continue;
      out.push({
        id: `${menu.label}/${item.label}`,
        label: item.label,
        hint: item.shortcut ?? '',
        detail: menu.label,
        aliases: item.aliases ?? [],
        enabled: () => isOn(item.enabled ?? true),
        run: item.run,
      });
    }
  }
  return out;
}
