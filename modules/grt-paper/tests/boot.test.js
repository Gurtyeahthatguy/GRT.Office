// @vitest-environment jsdom

/** Start the actual program and type into it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '..', 'src', 'index.html'), 'utf8');

function installPage() {
  const body = /<body>([\s\S]*)<\/body>/.exec(indexHtml)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
}

function fakeBackend() {
  const written = new Map();
  const calls = [];

  const invoke = vi.fn(async (command, payload) => {
    calls.push({ command, payload });
    switch (command) {
      case 'runtime_info':
        return { ephemeral: false, version: '0.1.0', initialFile: null };
      case 'read_settings': return {};
      case 'write_settings': return true;
      case 'forget_settings': return undefined;
      case 'write_grt': written.set(payload.path, payload.parts); return undefined;
      case 'read_grt': return { parts: written.get(payload.path) ?? {}, resources: [] };
      case 'read_resource': return new Uint8Array();
      case 'stage_part': case 'clear_staged': return undefined;
      case 'read_zip': return { parts: {}, binaries: [] };
      case 'read_file': return new Uint8Array();
      case 'write_file_atomic': return undefined;
      case 'file_exists': return false;
      default:
        if (command.startsWith('plugin:dialog|')) return null;
        throw new Error(`unexpected command ${command}`);
    }
  });

  // The drag-and-drop listener is a Tauri event, not a command.
  const listen = vi.fn(async () => () => {});

  return { invoke, listen, written, calls };
}

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

function type(surface, text) {
  surface.dispatchEvent(new window.InputEvent('beforeinput', {
    inputType: 'insertText', data: text, bubbles: true, cancelable: true,
  }));
}

function press(surface, inputType) {
  surface.dispatchEvent(new window.InputEvent('beforeinput', {
    inputType, bubbles: true, cancelable: true,
  }));
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
let surface;

beforeEach(async () => {
  vi.resetModules();
  installPage();
  backend = fakeBackend();
  window.__TAURI__ = { core: { invoke: backend.invoke }, event: { listen: backend.listen } };

  await import('../src/js/main.js');
  await ready();
  surface = document.getElementById('surface');
});

describe('the program starts', () => {
  it('asks the backend who it is', () => {
    expect(backend.calls.map((c) => c.command)).toContain('runtime_info');
  });

  it('draws an empty document with somewhere to type', () => {
    expect(surface.querySelectorAll('[data-block]').length).toBeGreaterThan(0);
  });
});

describe('typing', () => {
  it('puts characters in the document', async () => {
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);
    type(surface, 'a');
    await settle();
    expect(surface.textContent).toContain('a');
  });

  it('types a word', async () => {
    for (const character of 'hello') {
      const block = surface.querySelector('[data-block]');
      caretAt(surface, block.dataset.block, block.textContent.length);
      type(surface, character);
      await settle();
    }
    expect(surface.textContent).toBe('hello');
  });

  it('CANARY: the surface starts empty, so the assertions above mean something', () => {
    expect(surface.textContent).toBe('');
  });
});

describe('the keys that are not characters', () => {
  beforeEach(async () => {
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);
    type(surface, 'hello');
    await settle();
  });

  it('splits a paragraph on Enter', async () => {
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 2);
    press(surface, 'insertParagraph');
    await settle();
    expect(surface.querySelectorAll('[data-block]')).toHaveLength(2);
  });

  it('deletes backwards on Backspace', async () => {
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 5);
    press(surface, 'deleteContentBackward');
    await settle();
    expect(surface.textContent).toBe('hell');
  });

  it('deletes a whole word on Ctrl+Backspace', async () => {
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 5);
    press(surface, 'deleteWordBackward');
    await settle();
    expect(surface.textContent).toBe('');
  });
});

describe('the toolbar', () => {
  beforeEach(async () => {
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);
    type(surface, 'hello');
    await settle();
  });

  it('makes a heading', async () => {
    const picker = document.getElementById('style-picker');
    picker.value = 'h1';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
    expect(surface.querySelector('h1')).toBeTruthy();
  });

  it('makes a bulleted list', async () => {
    // No optional chaining on purpose.
    document.getElementById('btn-bullets').click();
    await settle();
    expect(surface.querySelector('ul, ol')).toBeTruthy();
  });

  it('makes a numbered list', async () => {
    document.getElementById('btn-numbers').click();
    await settle();
    expect(surface.querySelector('ol')).toBeTruthy();
  });

  it('applies bold to a selection', async () => {
    const block = surface.querySelector('[data-block]');
    const host = block.firstChild;
    const range = document.createRange();
    range.setStart(host, 0);
    range.setEnd(host, 5);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    document.getElementById('btn-bold').click();
    await settle();
    expect(surface.querySelector('strong')).toBeTruthy();
  });

  it('undoes and redoes', async () => {
    document.getElementById('btn-undo').click();
    await settle();
    expect(surface.textContent).toBe('');

    document.getElementById('btn-redo').click();
    await settle();
    expect(surface.textContent).toBe('hello');
  });
});

describe('saving', () => {
  it('writes what was typed into the container', async () => {
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);
    type(surface, 'saved text');
    await settle();

    // Save-as asks for a path; the dialog stub returns null, so drive the
    // write through the command the palette uses instead.
    backend.invoke.mockImplementation(async (command, payload) => {
      if (command.startsWith('plugin:dialog|save')) return '/tmp/x.grt';
      if (command === 'write_grt') { backend.written.set(payload.path, payload.parts); return undefined; }
      if (command === 'runtime_info') return { ephemeral: false, version: '0.1.0', initialFile: null };
      if (command === 'file_exists') return false;
      if (command === 'read_settings') return {};
      if (command === 'write_settings') return true;
      return null;
    });

    document.getElementById('btn-save').click();
    await until(() => backend.written.has('/tmp/x.grt'));

    const parts = backend.written.get('/tmp/x.grt');
    expect(parts).toBeTruthy();
    expect(parts['content/main.json']).toContain('saved text');
  });
});
