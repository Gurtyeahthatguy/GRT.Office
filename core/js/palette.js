/** Ctrl+K, the same in every module. */

const STYLE_ID = 'grt-palette-style';

const CSS = `
.grt-palette-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: 30;
}
.grt-palette {
  width: min(560px, 92vw);
  background: var(--bg-raised, #fff);
  color: var(--text, #111);
  border: 1px solid var(--border, #ccc);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.grt-palette input {
  width: 100%;
  box-sizing: border-box;
  font: 15px system-ui, sans-serif;
  color: inherit;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border, #ccc);
  padding: 12px 14px;
  outline: none;
}
.grt-palette ul { list-style: none; margin: 0; padding: 4px; max-height: 46vh; overflow-y: auto; }
.grt-palette li {
  padding: 7px 10px;
  border-radius: 5px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font: 13px system-ui, sans-serif;
}
.grt-palette li[aria-selected="true"] { background: var(--accent, #1f6feb); color: #fff; }
.grt-palette li[aria-selected="true"] .grt-palette-hint { color: rgba(255, 255, 255, 0.8); }
.grt-palette-hint { color: var(--text-dim, #777); font-size: 12px; white-space: nowrap; }
.grt-palette-empty { padding: 14px; color: var(--text-dim, #777); font: 13px system-ui, sans-serif; }
`;

/**
 * Fuzzy subsequence match.
 * @param {string} query
 * @param {string} text
 * @returns {?number}
 */
export function fuzzyScore(query, text) {
  const needle = query.trim().toLowerCase();
  if (needle === '') return 0;

  const hay = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;

  for (const character of needle) {
    const at = hay.indexOf(character, from);
    if (at === -1) return null;

    // Distance from the previous match: far away is a weaker match.
    score += at - from;
    if (at === previous + 1) score -= 1;                    // consecutive.
    if (at === 0 || /[\s\-_/]/.test(hay[at - 1])) score -= 2; // start of a word.

    previous = at;
    from = at + 1;
  }

  // Shorter labels win ties: "Save" should outrank "Save as" for "save".
  return score + text.length * 0.01;
}

/**
 * Ranks commands against a query.
 * @param {{id: string, label: string, hint?: string}[]} commands
 * @param {string} query
 */
export function rankCommands(commands, query) {
  return commands
    .map((command) => {
      const score = fuzzyScore(query, command.label);
      return score === null ? null : { command, score };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.command);
}

let root = null;
let closeCurrent = null;

function ensureMarkup() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }

  if (root) return root;

  root = document.createElement('div');
  root.className = 'grt-palette-backdrop';
  root.innerHTML = `
    <div class="grt-palette" role="dialog" aria-modal="true">
      <input type="text" placeholder="Type a command…" aria-label="Command" />
      <ul role="listbox"></ul>
    </div>`;
  return root;
}

/**
 * Whether the palette is on screen, so a host can ignore its own shortcuts.
 */
export function isPaletteOpen() {
  return closeCurrent !== null;
}

/**
 * Opens the palette over the current page.
 * @param {{id: string, label: string, hint?: string, run: Function}[]} commands
 */
export function openPalette(commands) {
  if (closeCurrent) closeCurrent();

  const element = ensureMarkup();
  const input = element.querySelector('input');
  const list = element.querySelector('ul');

  let matches = commands;
  let active = 0;

  const render = () => {
    if (matches.length === 0) {
      list.innerHTML = '<li class="grt-palette-empty">No matching command</li>';
      return;
    }
    list.replaceChildren(...matches.map((command, index) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === active));
      item.textContent = command.label;

      if (command.hint) {
        const hint = document.createElement('span');
        hint.className = 'grt-palette-hint';
        hint.textContent = command.hint;
        item.append(hint);
      }

      item.onmousedown = (event) => {
        event.preventDefault();
        choose(index);
      };
      return item;
    }));

    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    element.remove();
    closeCurrent = null;
  };

  const choose = (index) => {
    const command = matches[index];
    close();
    // Run after closing, so a command that opens another dialog is not
    // fighting this one for the keyboard.
    if (command) command.run();
  };

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    }
    // Everything else reaches the input and refilters below.
    event.stopPropagation();
  }

  input.value = '';
  input.oninput = () => {
    matches = rankCommands(commands, input.value);
    active = 0;
    render();
  };

  document.body.append(element);
  document.addEventListener('keydown', onKey, true);
  matches = commands;
  render();
  input.focus();

  closeCurrent = close;
}
