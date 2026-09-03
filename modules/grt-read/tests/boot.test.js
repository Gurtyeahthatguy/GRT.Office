// @vitest-environment jsdom

/** Start the actual program and use it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '..', 'src', 'index.html'), 'utf8');
const workerPath = resolve(here, '..', 'src', 'vendor', 'pdf.worker.mjs');

function installPage() {
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');
}

function installEnvironment() {
  window.IntersectionObserver = class {
    observe() {}

    unobserve() {}

    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
}

const settle = () => new Promise((resolve_) => { setTimeout(resolve_, 0); });

/**
 * Waits for the program to finish starting.
 *
 * A fixed number of turns is a race: on a cold machine the last await has not
 * resolved when the first assertion runs. This waits for the backend to stop
 * being asked for things, which is what "started" means here.
 */
async function ready(extra = () => true) {
  let seen = -1;
  for (let i = 0; i < 400; i += 1) {
    const calls = window.__TAURI_CALLS__?.length ?? 0;
    if (calls > 0 && calls === seen && extra()) return;
    seen = calls;
    await settle();
  }
}

async function boot() {
  vi.resetModules();
  installPage();
  installEnvironment();

  // Pinned before the viewer is imported, because the viewer sets it from a
  // URL that only means something in a browser.
  const pdfjs = await import('../src/vendor/pdf.mjs');
  Object.defineProperty(pdfjs.GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: () => {},
  });

  await import('../scripts/preview-stub.js');
  await import('../src/js/main.js');
  await ready(() => document.querySelectorAll('#thumbnails .thumb').length > 0);
}

const commands = () => (window.__TAURI_CALLS__ ?? []).map((c) => c.command);
const el = (id) => document.getElementById(id);
const thumbs = () => el('thumbnails').querySelectorAll('.thumb');

/** Waits for a condition, since pdf.js work is asynchronous throughout. */
async function until(predicate, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await settle();
  }
  return predicate();
}

beforeEach(async () => { await boot(); });

describe('the program starts', () => {
  it('asks the backend who it is', () => {
    expect(commands()).toContain('runtime_info');
  });

  it('opens the file the launcher named, without being asked to', () => {
    // The "Open With" path: a file on the command line opens straight away,
    // and the program that ignored it would look broken rather than empty.
    expect(commands()).toContain('read_file');
    expect(el('empty-state').classList.contains('hidden')).toBe(true);
  });

  it('reads the real PDF and finds both pages', () => {
    expect(thumbs().length).toBe(2);
    expect(el('page-indicator').textContent).toBe('Page 1 of 2');
  });

  it('CANARY: an untouched document reports no unsaved changes', () => {
    expect(el('page-indicator').textContent).not.toMatch(/unsaved/);
  });

  it('CANARY: nothing is written to disk on startup', () => {
    expect(commands()).not.toContain('write_file_atomic');
  });
});

describe('rotating a page', () => {
  it('marks the document changed', async () => {
    el('btn-rotate-right').click();
    await until(() => /unsaved changes/.test(el('page-indicator').textContent));

    expect(el('page-indicator').textContent).toMatch(/unsaved changes/);
    expect(el('btn-undo').disabled).toBe(false);
  });

  it('is undone, and redone', async () => {
    el('btn-rotate-right').click();
    await until(() => /unsaved changes/.test(el('page-indicator').textContent));

    el('btn-undo').click();
    await until(() => !/unsaved changes/.test(el('page-indicator').textContent));
    expect(el('page-indicator').textContent).toBe('Page 1 of 2');

    el('btn-redo').click();
    await until(() => /unsaved changes/.test(el('page-indicator').textContent));
    expect(el('page-indicator').textContent).toMatch(/unsaved changes/);
  });
});

describe('deleting a page', () => {
  it('takes it out of both the sidebar and the count', async () => {
    thumbs()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    el('btn-delete').click();
    await until(() => thumbs().length === 1);

    expect(thumbs().length).toBe(1);
    expect(el('page-indicator').textContent).toMatch(/of 1/);
  });

  it('undo brings the page back to both views at once', async () => {
    // The two views are rebuilt from the model rather than patched, which is
    // the whole reason they cannot end up disagreeing after an undo.
    thumbs()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();
    el('btn-delete').click();
    await until(() => thumbs().length === 1);

    el('btn-undo').click();
    await until(() => thumbs().length === 2);

    expect(thumbs().length).toBe(2);
    expect(el('page-indicator').textContent).toMatch(/of 2/);
  });
});

describe('selecting pages in the sidebar', () => {
  it('a plain click selects one', async () => {
    thumbs()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    expect(thumbs()[1].classList.contains('selected')).toBe(true);
    expect(thumbs()[0].classList.contains('selected')).toBe(false);
  });

  it('Ctrl-click adds to the selection', async () => {
    thumbs()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();
    thumbs()[1].dispatchEvent(new window.MouseEvent('click', {
      bubbles: true, ctrlKey: true,
    }));
    await settle();

    expect([...thumbs()].every((t) => t.classList.contains('selected'))).toBe(true);
  });
});

describe('searching the text of the document', () => {
  it('finds a word that is on the second page', async () => {
    el('search-input').value = 'Page two';
    el('btn-search').click();
    await until(() => el('search-status').textContent !== 'Searching…'
      && el('search-status').textContent !== '');

    expect(el('search-status').textContent).not.toBe('No matches');
    expect(el('search-status').textContent).toMatch(/1/);
  });

  it('says so when there is nothing to find', async () => {
    el('search-input').value = 'certainly not in this document';
    el('btn-search').click();
    await until(() => el('search-status').textContent === 'No matches');

    expect(el('search-status').textContent).toBe('No matches');
  });
});

describe('zoom', () => {
  it('reports the level, and changes it', async () => {
    expect(el('zoom-label').textContent).toBe('100%');

    el('btn-zoom-in').click();
    await until(() => el('zoom-label').textContent !== '100%');
    expect(el('zoom-label').textContent).not.toBe('100%');

    el('btn-zoom-out').click();
    await until(() => el('zoom-label').textContent === '100%');
    expect(el('zoom-label').textContent).toBe('100%');
  });
});

describe('the fingerprint', () => {
  it('reports the bytes that would be written, not the ones that were read', async () => {
    // The sample the stub builds carries an author, a creator and a producer.
    el('btn-fingerprint').click();
    await until(() => !el('overlay').classList.contains('hidden'));

    const report = el('panel-body').textContent;
    expect(report).toContain('all cleared');
    expect(report).not.toContain('Someone Else');
    expect(report).not.toContain('Another Program');
  });
});

describe('saving', () => {
  it('shows the fingerprint first, and writes nothing until it is approved', async () => {
    el('btn-rotate-right').click();
    await until(() => /unsaved changes/.test(el('page-indicator').textContent));

    el('btn-save').click();
    await until(() => !el('overlay').classList.contains('hidden'));

    expect(commands()).not.toContain('write_file_atomic');

    el('panel-cancel').click();
    for (let i = 0; i < 20; i += 1) await settle();
    expect(commands()).not.toContain('write_file_atomic');
  });

  it('writes the file once the fingerprint is approved', async () => {
    el('btn-rotate-right').click();
    await until(() => /unsaved changes/.test(el('page-indicator').textContent));

    el('btn-save').click();
    await until(() => !el('overlay').classList.contains('hidden'));
    el('panel-confirm').click();
    await until(() => commands().includes('write_file_atomic'));

    expect(commands()).toContain('write_file_atomic');

    // Saved over the file it was opened from.
    const write = window.__TAURI_CALLS__.find((c) => c.command === 'write_file_atomic');
    const path = decodeURIComponent(write.options.headers['x-grt-path']);
    expect(path).toBe('/preview/sample.pdf');
    expect(String.fromCharCode(...write.payload.slice(0, 5))).toBe('%PDF-');
    await until(() => !/unsaved changes/.test(el('page-indicator').textContent));
    expect(el('page-indicator').textContent).not.toMatch(/unsaved changes/);
  });

  it('"save as" asks where the file should go', async () => {
    el('btn-save-as').click();
    await until(() => commands().includes('plugin:dialog|save'));

    // The stub cancels the dialog, so nothing is written.
    expect(commands()).toContain('plugin:dialog|save');
    expect(commands()).not.toContain('write_file_atomic');
  });
});
