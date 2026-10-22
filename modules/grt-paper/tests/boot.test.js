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
      case 'recovery_begin': return { id: '0123456789abcdef', path: '/cache/0123456789abcdef.grt' };
      case 'recovery_list': return [];
      case 'recovery_saved': case 'recovery_discard': case 'recovery_remove':
      case 'set_close_guard': case 'close_ack': case 'close_window': return null;
      case 'print_page': return null;
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

  it('a button pressed with the mouse does not take the caret from the text', () => {
    const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.getElementById('btn-italic').dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    const pick = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.getElementById('style-picker').dispatchEvent(pick);
    expect(pick.defaultPrevented).toBe(false);
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
    // A document that was never saved is asked for a format first.
    await until(() => !document.getElementById('overlay').classList.contains('hidden'));
    expect(document.querySelector('[data-field="format"]').value).toBe('grt');
    document.getElementById('panel-confirm').click();
    await until(() => backend.written.has('/tmp/x.grt'));

    const parts = backend.written.get('/tmp/x.grt');
    expect(parts).toBeTruthy();
    expect(parts['content/main.json']).toContain('saved text');
  });
});

describe('other programs’ formats', () => {
  const dialogOpen = () => !document.getElementById('overlay').classList.contains('hidden');
  const title = () => document.getElementById('panel-title').textContent;
  // The command that showed a panel finishes a few turns after it closes.
  const idle = async () => { for (let i = 0; i < 10; i += 1) await settle(); };

  /** A Word file with a table, which Paper keeps only as text. */
  async function wordFile() {
    const { writeDocx } = await import('../src/js/core/formats/docx-write.js');
    const { encodeBlock } = await import('../src/js/core/package.js');
    const { entries } = writeDocx({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'From Word' }] }],
    });
    const index = entries.findIndex((entry) => entry.name === 'word/document.xml');
    entries[index].data = entries[index].data.replace('<w:sectPr>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr>');
    return encodeBlock(entries);
  }

  function routes(extra) {
    const original = backend.invoke.getMockImplementation();
    backend.invoke.mockImplementation(async (command, payload, options) => {
      const handled = await extra(command, payload, options);
      return handled === undefined ? original(command, payload, options) : handled;
    });
  }

  it('opens a Word document and says what did not come across', async () => {
    const block = await wordFile();
    routes(async (command, payload) => {
      if (command === 'plugin:dialog|open') return '/docs/letter.docx';
      if (command === 'read_package' && payload.path === '/docs/letter.docx') return block;
      return undefined;
    });
    document.getElementById('btn-open').click();
    await until(dialogOpen);
    expect(title()).toBe('Opened letter.docx');
    expect(document.getElementById('panel-body').textContent).toContain('Tables, kept as text');
    document.getElementById('panel-cancel').click();
    await until(() => !dialogOpen());
    expect(surface.textContent).toContain('From Word');
    expect(surface.textContent).toContain('Cell');
  });

  it('asks before saving over a file that lost something, and saves a copy when asked', async () => {
    const block = await wordFile();
    const writes = [];
    routes(async (command, payload, options) => {
      if (command === 'plugin:dialog|open') return '/docs/letter.docx';
      if (command === 'read_package') return block;
      if (command === 'plugin:dialog|save') return '/docs/letter-copy.odt';
      if (command === 'write_package') {
        writes.push(decodeURIComponent(options.headers['x-grt-path']));
        return null;
      }
      return undefined;
    });
    document.getElementById('btn-open').click();
    await until(dialogOpen);
    document.getElementById('panel-cancel').click();
    await until(() => !dialogOpen());
    await idle();

    document.getElementById('btn-save').click();
    await until(dialogOpen);
    expect(title()).toBe('Save over “letter.docx”?');
    document.querySelector('[data-choice="copy"]').click();
    await until(() => document.querySelector('[data-field="format"]'));
    document.querySelector('[data-field="format"]').value = 'odt';
    document.getElementById('panel-confirm').click();
    await until(() => writes.length > 0);
    expect(writes).toEqual(['/docs/letter-copy.odt']);
  });

  it('writes an OpenDocument file with its mimetype first and stored', async () => {
    const { decodeBlock } = await import('../src/js/core/package.js');
    let written = null;
    routes(async (command, payload, options) => {
      if (command === 'plugin:dialog|save') return '/docs/new.odt';
      if (command === 'write_package') {
        written = { path: decodeURIComponent(options.headers['x-grt-path']), block: payload };
        return null;
      }
      return undefined;
    });
    const block = surface.querySelector('[data-block]');
    caretAt(surface, block.dataset.block, 0);
    type(surface, 'odt text');
    await settle();
    document.getElementById('btn-save').click();
    await until(dialogOpen);
    document.querySelector('[data-field="format"]').value = 'odt';
    document.getElementById('panel-confirm').click();
    await until(() => written);
    expect(written.path).toBe('/docs/new.odt');
    const pkg = decodeBlock(written.block);
    expect(pkg.names[0]).toBe('mimetype');
    expect(pkg.text('content.xml')).toContain('odt text');
    expect(document.title).toBe('new.odt - GRT Paper');
  });
});

describe('the page', () => {
  const dialogOpen = () => !document.getElementById('overlay').classList.contains('hidden');
  const field = (name) => document.querySelector(`[data-field="${name}"]`);

  it('takes a size of its own, headers, footers and a different first page', async () => {
    document.getElementById('btn-page-setup').click();
    await until(dialogOpen);
    field('size').value = 'custom';
    field('width').value = '120';
    field('height').value = '180';
    field('header-default').value = 'Report';
    field('footer-default').value = 'Page {page} of {pages}';
    field('footer-default-align').value = 'right';
    field('firstDifferent').checked = true;
    field('footer-first').value = 'Cover';
    document.getElementById('panel-confirm').click();
    await until(() => !dialogOpen());

    const sheet = document.getElementById('sheet');
    expect(sheet.style.getPropertyValue('--page-w')).toBe('120mm');
    expect(sheet.style.getPropertyValue('--page-h')).toBe('180mm');

    document.getElementById('btn-page-setup').click();
    await until(dialogOpen);
    expect(field('size').value).toBe('custom');
    expect(field('footer-default').value).toBe('Page {page} of {pages}');
    expect(field('footer-default-align').value).toBe('right');
    expect(field('firstDifferent').checked).toBe(true);
    expect(field('header-first').value).toBe('');
    expect(field('footer-first').value).toBe('Cover');
    document.getElementById('panel-cancel').click();
  });
});

describe('printing', () => {
  const preview = () => document.getElementById('print-view');

  it('shows the pages with their headers and footers, then prints them on their own paper', async () => {
    surface.focus();
    caretAt(surface, surface.querySelector('[data-block]').dataset.block, 0);
    type(surface, 'Printed words');
    document.getElementById('btn-page-setup').click();
    await until(() => !document.getElementById('overlay').classList.contains('hidden'));
    document.querySelector('[data-field="size"]').value = 'A5';
    document.querySelector('[data-field="size"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('[data-field="footer-default"]').value = 'Page {page} of {pages}';
    document.getElementById('panel-confirm').click();
    await until(() => document.getElementById('sheet').style.getPropertyValue('--page-w') === '148mm');
    await tick();

    document.getElementById('btn-print').click();
    await until(() => preview()?.querySelector('.print-page'));
    const page = preview().querySelector('.print-page');
    expect(page.style.width).toBe('148mm');
    expect(page.style.height).toBe('210mm');
    expect(page.querySelector('.print-body').textContent).toContain('Printed words');
    expect(page.querySelector('.print-footer').textContent).toBe('Page 1 of 1');
    expect(document.getElementById('grt-print-page').textContent).toContain('size: 148mm 210mm');

    preview().querySelector('[data-print="go"]').click();
    await until(() => backend.calls.some((c) => c.command === 'print_page'));
    expect(backend.calls.find((c) => c.command === 'print_page').payload).toEqual({ width: 148, height: 210 });

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !preview());
    expect(preview()).toBeNull();
    expect(surface.textContent).toContain('Printed words');
  });
});
