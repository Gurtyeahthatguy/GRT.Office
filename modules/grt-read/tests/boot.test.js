// @vitest-environment jsdom

/** Start the actual program and use it. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const settle = () => new Promise((resolve_) => { setImmediate(resolve_); });
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

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

/** Waits for a condition, bounded by the clock. */
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (let i = 0; Date.now() < deadline; i += 1) {
    if (predicate()) return true;
    await (i % 20 === 19 ? tick() : settle());
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

describe('keeping unsaved work', () => {
  const closeRequested = () => window.__TAURI_LISTENERS__['grt://close-requested']();
  const dialogOpen = () => !el('overlay').classList.contains('hidden');
  const choose = (id) => document.querySelector(`[data-choice="${id}"]`).click();
  const called = (command) => window.__TAURI_CALLS__.filter((call) => call.command === command);
  const writtenTo = (prefix) => called('write_file_atomic').filter((call) =>
    decodeURIComponent(call.options.headers['x-grt-path']).startsWith(prefix));

  afterEach(() => {
    delete window.__TAURI_ORPHANS__;
    delete window.__TAURI_SEED__;
  });

  it('CANARY: a document nobody touched closes without asking', async () => {
    await closeRequested();
    expect(commands()).toContain('close_window');
  });

  it('asks before closing, and Cancel keeps it open', async () => {
    el('btn-delete').click();
    await until(() => thumbs().length === 1);
    const closing = closeRequested();
    await until(dialogOpen);
    expect(el('panel-title').textContent).toBe('Save changes to “sample.pdf”?');
    choose('cancel');
    await closing;
    expect(commands()).not.toContain('close_window');
    expect(thumbs().length).toBe(1);
  });

  it('a watermark is a change too', async () => {
    el('btn-stamp').click();
    await until(dialogOpen);
    document.querySelector('[data-field="watermarkText"]').value = 'DRAFT';
    el('panel-confirm').click();
    await until(() => /unsaved changes/.test(el('page-indicator').textContent));
    const closing = closeRequested();
    await until(dialogOpen);
    choose('cancel');
    await closing;
    expect(commands()).not.toContain('close_window');
  });

  it('writes a recovery copy after a pause, and leaves the PDF alone', async () => {
    el('btn-rotate-right').click();
    await until(() => called('recovery_saved').length > 0, 4000);
    expect(writtenTo('/recovery/')).toHaveLength(1);
    expect(writtenTo('/preview/')).toHaveLength(0);
    expect(called('recovery_saved').at(-1).payload.meta)
      .toEqual({ path: '/preview/sample.pdf', name: 'sample.pdf' });
  }, 15000);

  it('onto the file, waits for the fingerprint to be turned off before touching the PDF', async () => {
    const settingsTo = async (fields) => {
      el('btn-settings').click();
      await until(dialogOpen);
      for (const [field, value] of Object.entries(fields)) {
        const input = document.querySelector(`[data-field="${field}"]`);
        if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
      }
      const stored = called('write_settings').length;
      el('panel-confirm').click();
      await until(() => called('write_settings').length > stored);
      for (let i = 0; i < 5; i += 1) await settle();
    };

    await settingsTo({ autosave: 'file' });
    el('btn-rotate-right').click();
    await until(() => called('recovery_saved').length > 0, 4000);
    expect(writtenTo('/preview/')).toHaveLength(0);

    await settingsTo({ fingerprintBeforeSave: false });
    el('btn-rotate-right').click();
    await until(() => writtenTo('/preview/').length > 0, 4000);
    expect(String.fromCharCode(...writtenTo('/preview/')[0].payload.slice(0, 5))).toBe('%PDF-');
    await until(() => !/unsaved changes/.test(el('page-indicator').textContent));
    expect(commands()).toContain('recovery_discard');
  }, 15000);

  it('offers back the work of a run that crashed, as it was', async () => {
    thumbs()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();
    el('btn-delete').click();
    await until(() => thumbs().length === 1);
    await until(() => called('recovery_saved').length > 0, 4000);
    const copy = writtenTo('/recovery/').at(-1);

    const orphan = {
      id: 'fedcba9876543210',
      path: '/recovery/fedcba9876543210.session',
      meta: { path: '/preview/sample.pdf', name: 'sample.pdf' },
    };
    window.__TAURI_ORPHANS__ = [orphan];
    window.__TAURI_SEED__ = { [orphan.path]: copy.payload };

    vi.resetModules();
    installPage();
    installEnvironment();
    await import('../scripts/preview-stub.js');
    await import('../src/js/main.js');
    await until(dialogOpen);
    expect(el('panel-title').textContent).toBe('Recover “sample.pdf”?');
    choose('recover');
    await until(() => called('recovery_remove').length > 0);
    await until(() => thumbs().length === 1);
    expect(el('page-indicator').textContent).toMatch(/of 1 .*unsaved changes/);
    expect(called('read_file').map((call) => call.payload.path)).toEqual([orphan.path]);
  }, 15000);
});
