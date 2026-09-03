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

      case 'write_file_atomic': return undefined;
      case 'read_file': return new Uint8Array();
      case 'file_exists': return false;

      default:
        if (command.startsWith('plugin:dialog|')) return null;
        throw new Error(`unexpected command ${command}`);
    }
  });

  return { invoke, notes, index, calls, folders };
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
