// @vitest-environment jsdom

/** Start the actual program and type into it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '..', 'src', 'index.html'), 'utf8');

/**
 * The page as shipped, minus the module script, which vitest imports itself.
 */
function installPage() {
  const body = /<body>([\s\S]*)<\/body>/.exec(indexHtml)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
}

/** A backend that keeps an archive and an index in memory. */
function fakeBackend() {
  const notes = new Map();
  const index = new Map();
  const folders = new Set(['/archive']);
  const calls = [];
  const vault = new Map();
  const writes = [];
  const packages = new Map();
  const messages = [];

  const invoke = vi.fn(async (command, payload, options) => {
    calls.push({ command, payload, options });

    switch (command) {
      case 'runtime_info':
        return { ephemeral: false, version: '0.1.0', initialFile: null, defaultRoot: '/archive' };
      case 'read_settings': return {};
      case 'write_settings': return true;
      case 'forget_settings': return undefined;

      case 'read_archive': {
        const notebooks = [...folders]
          .filter((path) => path !== '/archive' && path.split('/').length === 3)
          .map((path) => ({
            name: path.split('/').pop(),
            path,
            sections: [],
            pages: [...notes.keys()]
              .filter((notePath) => notePath.startsWith(`${path}/`))
              .map((notePath) => ({
                path: notePath,
                file: notePath.split('/').pop().replace(/\.grt$/, ''),
                modified: notes.get(notePath).modified,
              })),
          }));
        return { root: '/archive', notebooks };
      }

      case 'create_folder': folders.add(payload.path); return undefined;
      case 'rename_entry': return undefined;
      case 'delete_entry': notes.delete(payload.path); return undefined;

      case 'read_grt': {
        const held = notes.get(payload.path);
        if (!held) throw new Error(`no note at ${payload.path}`);
        return { parts: held.parts, resources: [] };
      }
      case 'write_grt':
        notes.set(payload.path, { parts: payload.parts, modified: 1 });
        return undefined;

      case 'index_state':
        return [...index.entries()].map(([path, row]) => ({ path, modified: row.modified }));
      case 'index_upsert': index.set(payload.path, payload); return undefined;
      case 'index_remove': index.delete(payload.path); return undefined;
      case 'index_dump':
        return [...index.values()].map((row) => ({
          path: row.path, title: row.title, body: row.body,
        }));
      case 'index_search': return [];
      case 'index_forget': index.clear(); return undefined;

      case 'write_file_atomic': {
        const path = decodeURIComponent(options.headers['x-grt-path']);
        vault.set(path, new TextDecoder().decode(payload));
        writes.push(path);
        return undefined;
      }
      case 'read_file': {
        if (!vault.has(payload.path)) throw new Error(`no file at ${payload.path}`);
        return new TextEncoder().encode(vault.get(payload.path));
      }
      case 'file_exists': return false;
      case 'set_close_guard': case 'close_ack': case 'close_window': return null;
      case 'print_page': return null;
      case 'write_package': packages.set(decodeURIComponent(options.headers['x-grt-path']), payload); return undefined;

      case 'check_vault':
        if (!payload.path.startsWith('/home/me/Documents/')) throw new Error('GRT Notes opens vaults kept in /home/me/Documents or /home/me/Downloads.');
        return payload.path;
      case 'read_vault': {
        const root = payload.root;
        const pagesIn = (folder) => [...vault.keys()]
          .filter((path) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/') && path.endsWith('.md'))
          .map((path) => ({ path, file: path.split('/').pop().replace(/\.md$/, ''), modified: 1 }));
        const top = [...new Set([...vault.keys()].filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1).split('/'))
          .filter((parts) => parts.length > 1).map((parts) => parts[0]))];
        return {
          root,
          vault: true,
          notebooks: [
            { name: root.split('/').pop(), path: root, sections: [], pages: pagesIn(root) },
            ...top.map((name) => ({ name, path: `${root}/${name}`, sections: [], pages: pagesIn(`${root}/${name}`) })),
          ],
        };
      }

      case 'plugin:dialog|open': return window.__PICK__?.open ?? null;
      case 'plugin:dialog|save': return window.__PICK__?.save ?? null;
      case 'plugin:dialog|message':
        if (payload.buttons) return window.__ANSWER__ ?? 'No';
        messages.push(payload.message);
        return 'Ok';

      default:
        if (command.startsWith('plugin:dialog|')) return null;
        throw new Error(`unexpected command ${command}`);
    }
  });

  const listeners = {};
  const listen = vi.fn(async (name, handler) => {
    listeners[name] = handler;
    return () => {};
  });

  return { invoke, listen, listeners, notes, index, calls, folders, vault, writes, packages, messages };
}

/** Puts the caret at an offset inside a block, as clicking would. */
function caretAt(surface, blockId, offset) {
  const host = surface.querySelector(`[data-block="${blockId}"]`);
  const walker = document.createTreeWalker(host, 4 /** SHOW_TEXT. */);
  let node = walker.nextNode();
  let seen = 0;

  while (node) {
    if (seen + node.nodeValue.length >= offset) break;
    seen += node.nodeValue.length;
    node = walker.nextNode();
  }
  if (!node) { node = document.createTextNode(''); host.append(node); seen = offset; }

  const range = document.createRange();
  range.setStart(node, Math.min(offset - seen, node.nodeValue.length));
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Types a character the way the webview does: a beforeinput event. */
function type(surface, text) {
  const event = new window.InputEvent('beforeinput', {
    inputType: 'insertText',
    data: text,
    bubbles: true,
    cancelable: true,
  });
  surface.dispatchEvent(event);
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

let backend;

beforeEach(async () => {
  vi.resetModules();
  installPage();
  backend = fakeBackend();
  window.__TAURI__ = { core: { invoke: backend.invoke }, event: { listen: backend.listen } };

  await import('../src/js/main.js');
  await ready();
});

describe('the program starts', () => {
  it('asks the backend who it is and reads the archive', () => {
    const commands = backend.calls.map((c) => c.command);
    expect(commands).toContain('runtime_info');
    expect(commands).toContain('read_archive');
  });

  it('shows its version', () => {
    expect(document.getElementById('version').textContent).toBe('0.1.0');
  });

  it('creates a first note so there is somewhere to write', () => {
    expect(backend.notes.size).toBeGreaterThan(0);
  });

  it('draws something into the writing surface', () => {
    expect(document.querySelectorAll('#surface [data-block]').length).toBeGreaterThan(0);
  });
});

// The fault that shipped

describe('typing into the note', () => {
  it('puts the character in the document', async () => {
    const surface = document.getElementById('surface');
    const block = surface.querySelector('[data-block]');

    caretAt(surface, block.dataset.block, 0);
    type(surface, 'a');
    await settle();

    expect(surface.textContent).toContain('a');
  });

  it('types a whole word', async () => {
    const surface = document.getElementById('surface');

    for (const character of 'hello') {
      const block = surface.querySelector('[data-block]');
      const length = block.textContent.length;
      caretAt(surface, block.dataset.block, length);
      type(surface, character);
      await settle();
    }

    expect(surface.textContent).toBe('hello');
  });

  it('saves what was typed, without a Save button being pressed', async () => {
    const surface = document.getElementById('surface');
    const block = surface.querySelector('[data-block]');

    caretAt(surface, block.dataset.block, 0);
    type(surface, 'x');

    // Typing is collected briefly before the write.
    await new Promise((resolve) => { setTimeout(resolve, 900); });

    const written = [...backend.notes.values()].pop();
    const document_ = JSON.parse(written.parts['content/main.json']);
    const text = document_.blocks
      .flatMap((b) => (b.runs ?? []).map((r) => r.text))
      .join('');
    expect(text).toContain('x');
  });

  it('CANARY: nothing appears when nothing is typed', async () => {
    // Proof the assertions above are watching the right element.
    const surface = document.getElementById('surface');
    expect(surface.textContent).toBe('');
  });
});

describe('the title and the tags', () => {
  it('records a title, and keeps the note writable afterwards', async () => {
    const title = document.getElementById('note-title');
    title.value = 'Kant';
    title.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();

    const surface = document.getElementById('surface');
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);
    type(surface, 'z');
    await settle();

    expect(surface.textContent).toContain('z');
  });

  it('records tags', async () => {
    const tags = document.getElementById('note-tags');
    tags.value = '#kant, philosophy';
    tags.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    const written = [...backend.notes.values()].pop();
    const document_ = JSON.parse(written.parts['content/main.json']);
    expect(document_.tags).toEqual(['kant', 'philosophy']);
  });
});

describe('the toolbar', () => {
  it('inserts a to-do', async () => {
    const surface = document.getElementById('surface');
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);

    document.getElementById('btn-todo').click();
    await settle();

    expect(surface.querySelector('.todo')).toBeTruthy();
  });

  it('turns bold on and shows it as on', async () => {
    const surface = document.getElementById('surface');
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);

    document.getElementById('btn-bold').click();
    await settle();

    expect(document.getElementById('btn-bold').classList.contains('active')).toBe(true);
  });
});

describe('closing', () => {
  const textOf = (parts) => JSON.parse(parts['content/main.json']).blocks
    .flatMap((b) => (b.runs ?? []).map((r) => r.text)).join('');
  const called = (command) => backend.calls.filter((call) => call.command === command);
  const dialogOpen = () => !document.getElementById('overlay').classList.contains('hidden');

  function typeAtEnd(text) {
    const surface = document.getElementById('surface');
    for (const character of text) {
      const block = surface.querySelector('[data-block]');
      caretAt(surface, block.dataset.block, block.textContent.length);
      type(surface, character);
    }
  }

  it('CANARY: with nothing typed, closes at once and writes nothing', async () => {
    const writes = called('write_grt').length;
    await backend.listeners['grt://close-requested']();
    expect(called('close_window')).toHaveLength(1);
    expect(called('write_grt')).toHaveLength(writes);
  });

  it('holds the window while typing waits to be written', async () => {
    typeAtEnd('held');
    await settle();
    const guards = called('set_close_guard');
    expect(guards.at(-1).payload).toEqual({ held: true });
  });

  it('closing straight after typing writes the note first', async () => {
    typeAtEnd('last words');
    await settle();
    await backend.listeners['grt://close-requested']();
    const order = backend.calls.map((call) => call.command);
    expect(order).toContain('close_window');
    const lastWrite = called('write_grt').at(-1);
    expect(textOf(lastWrite.payload.parts)).toContain('last words');
    expect(order.lastIndexOf('write_grt')).toBeLessThan(order.indexOf('close_window'));
  });

  it('a note that cannot be written asks before closing, and Cancel keeps it open', async () => {
    const original = backend.invoke.getMockImplementation();
    backend.invoke.mockImplementation(async (command, payload, options) => {
      if (command === 'write_grt') throw new Error('disk full');
      return original(command, payload, options);
    });
    typeAtEnd('unsaved');
    await settle();
    const closing = backend.listeners['grt://close-requested']();
    await until(dialogOpen);
    expect(document.getElementById('panel-title').textContent).toBe('Close without saving?');
    document.querySelector('[data-choice="cancel"]').click();
    await closing;
    expect(called('close_window')).toHaveLength(0);
  });

  it('Close anyway closes a note that cannot be written', async () => {
    const original = backend.invoke.getMockImplementation();
    backend.invoke.mockImplementation(async (command, payload, options) => {
      if (command === 'write_grt') throw new Error('disk full');
      return original(command, payload, options);
    });
    typeAtEnd('lost');
    await settle();
    const closing = backend.listeners['grt://close-requested']();
    await until(dialogOpen);
    expect(document.getElementById('panel-body').textContent).toContain('disk full');
    document.querySelector('[data-choice="close"]').click();
    await closing;
    expect(called('close_window')).toHaveLength(1);
  });

  it('typing that arrives while the note is written is saved too', async () => {
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    const original = backend.invoke.getMockImplementation();
    let held = true;
    backend.invoke.mockImplementation(async (command, payload, options) => {
      if (command === 'write_grt' && held) { held = false; await slow; }
      return original(command, payload, options);
    });
    const before = called('write_grt').length;
    typeAtEnd('one');
    await until(() => called('write_grt').length > before, 2000);
    expect(held).toBe(false);
    typeAtEnd(' two');
    release();
    await until(() => [...backend.notes.values()].some((n) => textOf(n.parts).includes('one two')), 3000);
    const texts = [...backend.notes.values()].map((n) => textOf(n.parts));
    expect(texts.some((text) => text.includes('one two'))).toBe(true);
  });
});

describe('an Obsidian vault', () => {
  const DAILY = '---\nstatus: draft\ntags:\n  - Work\n---\n# Today\n\n> [!tip] Remember\n> Water the plants.\n\n- [ ] Call Ada\n- [ ] Read [[Plan|the plan]]\n\nA line\nand the next. %%hidden%%\n';
  const PLAN = 'Steps:\n\n1. Begin\n2. Finish\n';
  const dialogOpen = () => !document.getElementById('overlay').classList.contains('hidden');

  async function openVault() {
    backend.vault.set('/home/me/Documents/Vault/Daily.md', DAILY);
    backend.vault.set('/home/me/Documents/Vault/Projects/Plan.md', PLAN);
    window.__PICK__ = { open: '/home/me/Documents/Vault' };
    document.getElementById('btn-vault').click();
    await until(() => document.getElementById('note-title').value === 'Daily');
  }

  it('opens in place of the archive and writes nothing it was not asked to', async () => {
    await openVault();
    expect(document.getElementById('btn-vault').textContent).toBe('Close vault');
    const surface = document.getElementById('surface');
    expect(surface.querySelector('.callout-title').textContent).toBe('Remember');
    expect(surface.querySelectorAll('.todo')).toHaveLength(2);
    expect(surface.querySelector('.note-link').dataset.title).toBe('Plan');
    expect(surface.querySelector('.note-comment').textContent).toBe('%%hidden%%');
    expect(document.getElementById('note-tags').value).toBe('#work');
    expect(backend.writes).toEqual([]);
  });

  it('writes back only what was changed: a task ticked, a property set', async () => {
    await openVault();
    const box = document.querySelector('#surface [data-action="toggle-todo"]');
    box.click();
    await until(() => backend.writes.includes('/home/me/Documents/Vault/Daily.md'));
    expect(backend.vault.get('/home/me/Documents/Vault/Daily.md')).toBe(DAILY.replace('- [ ] Call Ada', '- [x] Call Ada'));

    document.getElementById('btn-properties').click();
    await until(dialogOpen);
    document.querySelector('[data-field="value_0"]').value = 'final';
    document.getElementById('panel-confirm').click();
    await until(() => backend.vault.get('/home/me/Documents/Vault/Daily.md').includes('status: final'));
    expect(backend.vault.get('/home/me/Documents/Vault/Daily.md'))
      .toBe(DAILY.replace('- [ ] Call Ada', '- [x] Call Ada').replace('status: draft', 'status: final'));
  });

  it('follows a link with an alias to the note it names', async () => {
    await openVault();
    document.querySelector('#surface .note-link').click();
    await until(() => document.getElementById('note-title').value === 'Plan');
    expect(document.querySelectorAll('#surface ol li')).toHaveLength(2);
  });

  it('says plainly that a folder outside Documents and Downloads cannot be opened', async () => {
    window.__PICK__ = { open: '/srv/elsewhere' };
    document.getElementById('btn-vault').click();
    await until(() => backend.messages.length > 0);
    expect(backend.messages[0]).toContain('Documents');
    expect(document.getElementById('btn-vault').textContent).toBe('Open vault');
  });

  it('prints the note open', async () => {
    await openVault();
    document.getElementById('btn-print').click();
    await until(() => document.getElementById('print-view')?.querySelector('.print-page'));
    expect(document.querySelector('#print-view .print-title').textContent).toBe('Daily');
    document.querySelector('#print-view [data-print="go"]').click();
    await until(() => backend.calls.some((c) => c.command === 'print_page'));
    document.querySelector('#print-view [data-print="close"]').click();
    await until(() => !document.getElementById('print-view'));
  });
});
