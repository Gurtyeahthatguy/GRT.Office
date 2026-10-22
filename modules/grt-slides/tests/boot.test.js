// @vitest-environment jsdom

/** Start the actual program and use it. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '..', 'src', 'index.html'), 'utf8');

function installPage() {
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');
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

async function boot() {
  vi.resetModules();
  installPage();
  await import('../scripts/preview-stub.js');
  await import('../src/js/main.js');
  await ready();
}

const commands = () => (window.__TAURI_CALLS__ ?? []).map((c) => c.command);
const el = (id) => document.getElementById(id);
const thumbs = () => el('thumbnails').querySelectorAll('.thumb');
// Direct children only: the overlay layer's resize handles carry a `data-id`
// too, and they are not elements of the slide.
const elements = () => el('surface').querySelectorAll(':scope > [data-id]');

beforeEach(async () => { await boot(); });

describe('the program starts', () => {
  it('asks the backend who it is', () => {
    expect(commands()).toContain('runtime_info');
  });

  it('draws one slide and one thumbnail', () => {
    expect(thumbs().length).toBe(1);
  });

  it('reports the deck in the status bar', () => {
    expect(el('status').textContent).toMatch(/Slide 1 of 1/);
  });

  it('CANARY: the new deck has nothing on the slide', () => {
    expect(elements().length).toBe(0);
  });
});

describe('slides', () => {
  it('adds one, and moves to it', async () => {
    el('btn-add-slide').click();
    await settle();
    expect(thumbs().length).toBe(2);
    expect(el('status').textContent).toMatch(/Slide 2 of 2/);
  });

  it('duplicates one', async () => {
    el('btn-duplicate').click();
    await settle();
    expect(thumbs().length).toBe(2);
  });

  it('deletes one', async () => {
    el('btn-add-slide').click();
    await settle();
    el('btn-delete-slide').click();
    await settle();
    expect(thumbs().length).toBe(1);
  });

  it('refuses to delete the last slide', () => {
    // Not by ignoring the click but by disabling the button, so the reason is
    // visible rather than the program seeming broken.
    expect(el('btn-delete-slide').disabled).toBe(true);
  });

  it('a duplicate carries the elements of its original', async () => {
    el('btn-add-text').click();
    await settle();
    el('btn-duplicate').click();
    await settle();
    expect(elements().length).toBe(1);
  });
});

describe('elements on a slide', () => {
  it('adds a text box, and it lands on the surface', async () => {
    el('btn-add-text').click();
    await settle();

    const nodes = elements();
    expect(nodes.length).toBe(1);
    expect(nodes[0].textContent).toContain('New text');
  });

  it('adds a shape', async () => {
    el('btn-add-shape').click();
    await settle();
    expect(elements().length).toBe(1);
  });

  it('adds a table with its cells', async () => {
    el('btn-add-table').click();
    await settle();
    expect(el('surface').querySelectorAll('[data-field], td, .cell').length)
      .toBeGreaterThan(0);
  });

  it('selects what it has just added', async () => {
    el('btn-add-text').click();
    await settle();
    expect(el('status').textContent).toMatch(/1 selected/);
    expect(el('btn-delete').disabled).toBe(false);
  });

  it('draws the new element in the thumbnail as well', async () => {
    // The stage and the thumbnails are drawn by the same code at different
    // scales; when they were not, an element could exist on one and not the
    // other.
    el('btn-add-text').click();
    await settle();
    expect(el('thumbnails').querySelector('.thumb .el')).toBeTruthy();
  });

  it('deletes the selection', async () => {
    el('btn-add-text').click();
    await settle();
    el('btn-delete').click();
    await settle();
    expect(elements().length).toBe(0);
  });
});

describe('undo', () => {
  it('is disabled with nothing to undo', () => {
    expect(el('btn-undo').disabled).toBe(true);
    expect(el('btn-redo').disabled).toBe(true);
  });

  it('takes an added slide back', async () => {
    el('btn-add-slide').click();
    await settle();
    expect(thumbs().length).toBe(2);

    el('btn-undo').click();
    await settle();
    expect(thumbs().length).toBe(1);
  });

  it('takes an added element back, and puts it forward again', async () => {
    el('btn-add-text').click();
    await settle();

    el('btn-undo').click();
    await settle();
    expect(elements().length).toBe(0);

    el('btn-redo').click();
    await settle();
    expect(elements().length).toBe(1);
  });
});

describe('speaker notes', () => {
  it('a stretch of typing is its own step to undo, and leaves the slide alone', async () => {
    el('btn-add-text').click();
    await settle();

    const notes = el('notes');
    notes.dispatchEvent(new window.FocusEvent('focus'));
    for (const text of ['S', 'Sa', 'Say it']) {
      notes.value = text;
      notes.dispatchEvent(new window.Event('input'));
    }
    el('btn-undo').click();
    await settle();
    expect(el('notes').value).toBe('');
    expect(elements().length).toBe(1);

    el('btn-redo').click();
    await settle();
    expect(el('notes').value).toBe('Say it');
  });
});

describe('the text box that could not be edited', () => {
  it('becomes editable on a double-click', async () => {
    el('btn-add-text').click();
    await settle();

    const box = elements()[0];
    box.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();

    expect(box.classList.contains('editing')).toBe(true);
    expect(box.contentEditable).toBe('true');
  });

  it('becomes editable when the browser sends only the two presses', async () => {
    // Only the two presses arrive, as in WebKitGTK.
    el('btn-add-text').click();
    await settle();

    const press = (detail) => {
      const box = elements()[0];
      box.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, detail }));
      window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0, detail }));
    };
    press(1);
    await settle();
    press(2);
    await settle();

    expect(elements()[0].classList.contains('editing')).toBe(true);
  });

  it('a double-click on empty space makes one box, even when dblclick follows', async () => {
    const surface = el('surface');
    for (const detail of [1, 2]) {
      surface.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, detail }));
      window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0, detail }));
      await settle();
    }
    surface.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await settle();

    expect(elements().length).toBe(1);
  });

  it('a new box has its placeholder selected, so typing replaces it', async () => {
    el('btn-add-text').click();
    await settle();
    elements()[0].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(window.getSelection().toString()).toBe('New text');
  });

  it('a box with words in it gets the caret at the end', async () => {
    el('btn-add-text').click();
    await settle();
    const box = elements()[0];
    box.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();
    box.innerHTML = 'Typed';
    box.dispatchEvent(new window.FocusEvent('blur'));
    await settle();
    elements()[0].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(window.getSelection().isCollapsed).toBe(true);
  });

  it('keeps what was typed when the box loses the caret', async () => {
    el('btn-add-text').click();
    await settle();

    const box = elements()[0];
    box.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();

    box.innerHTML = 'Rewritten by hand';
    box.dispatchEvent(new window.FocusEvent('blur'));
    await settle();

    expect(el('surface').textContent).toContain('Rewritten by hand');
    expect(el('status').textContent).toMatch(/unsaved changes/);
  });

  it('a click inside the box being edited does not redraw it away', async () => {
    // The redraw would destroy the node the caret is in, mid-sentence.
    el('btn-add-text').click();
    await settle();

    const box = elements()[0];
    box.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();

    box.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await settle();

    expect(box.isConnected).toBe(true);
    expect(box.classList.contains('editing')).toBe(true);
  });
});

describe('presenting', () => {
  it('starts the projection', async () => {
    el('btn-present').click();
    await settle();
    expect(el('present-root').classList.contains('running')).toBe(true);
  });

  it('leaves on Escape', async () => {
    el('btn-present').click();
    await settle();

    document.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    await settle();

    expect(el('present-root').classList.contains('running')).toBe(false);
  });

  it('leaves when fullscreen ends, which is what Escape does in fullscreen', async () => {
    let full = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
    document.documentElement.requestFullscreen = async () => { full = document.documentElement; };
    document.exitFullscreen = async () => { full = null; };
    try {
      el('btn-present').click();
      await settle();
      expect(el('present-root').classList.contains('running')).toBe(true);

      full = null;
      document.dispatchEvent(new window.Event('fullscreenchange'));
      await settle();
      expect(el('present-root').classList.contains('running')).toBe(false);
    } finally {
      delete document.fullscreenElement;
      delete document.documentElement.requestFullscreen;
      delete document.exitFullscreen;
    }
  });
});

describe('saving', () => {
  it('CANARY: nothing is written before anything changes', () => {
    expect(commands()).not.toContain('write_grt');
  });

  it('asks where to put a deck that has never been saved', async () => {
    el('btn-add-text').click();
    await settle();

    el('btn-save').click();
    await until(() => commands().some((c) => c.includes('save') || c === 'write_grt'));

    expect(commands().some((c) => c.includes('save') || c === 'write_grt')).toBe(true);
  });
});

describe('keeping unsaved work', () => {
  const closeRequested = () => window.__TAURI_LISTENERS__['grt://close-requested']();
  const dialogOpen = () => !el('overlay').classList.contains('hidden');
  const choose = (id) => document.querySelector(`[data-choice="${id}"]`).click();
  const called = (command) => window.__TAURI_CALLS__.filter((call) => call.command === command);

  afterEach(() => {
    delete window.__TAURI_ORPHANS__;
    delete window.__TAURI_SEED__;
  });

  it('CANARY: a deck nobody touched closes without asking', async () => {
    await closeRequested();
    expect(commands()).toContain('close_window');
  });

  it('asks before New drops a change, and Cancel keeps it', async () => {
    el('btn-add-slide').click();
    await settle();
    el('btn-new').click();
    await until(dialogOpen);
    expect(el('panel-title').textContent).toBe('Save changes to “Untitled”?');
    choose('cancel');
    await until(() => !dialogOpen());
    expect(thumbs().length).toBe(2);
  });

  it('asks before closing, and Don’t save closes', async () => {
    el('btn-add-slide').click();
    await settle();
    const closing = closeRequested();
    await until(dialogOpen);
    choose('discard');
    await closing;
    expect(commands()).toContain('recovery_discard');
    expect(commands()).toContain('close_window');
  });

  it('writes a recovery copy after a pause', async () => {
    el('btn-add-slide').click();
    await until(() => called('recovery_saved').length > 0, 4000);
    const copy = called('write_grt').find((call) => call.payload.path.startsWith('/recovery/'));
    expect(JSON.parse(copy.payload.parts['content/main.json']).slides).toHaveLength(2);
    expect(called('recovery_saved').at(-1).payload.meta).toEqual({ path: null, name: 'Untitled' });
  }, 15000);

  it('offers back the work of a run that crashed', async () => {
    const { SlidesModel } = await import('../src/js/model.js');
    const deck = new SlidesModel();
    deck.addSlide();
    deck.addSlide();
    const orphan = {
      id: 'fedcba9876543210',
      path: '/recovery/fedcba9876543210.grt',
      meta: { path: '/docs/talk.grt', name: 'talk.grt' },
    };
    window.__TAURI_ORPHANS__ = [orphan];
    window.__TAURI_SEED__ = { [orphan.path]: { 'content/main.json': JSON.stringify(deck.toJSON()) } };

    await boot();
    await until(dialogOpen);
    expect(el('panel-title').textContent).toBe('Recover “talk.grt”?');
    choose('recover');
    await until(() => called('recovery_remove').length > 0);
    expect(thumbs().length).toBe(3);
    expect(el('status').textContent).toMatch(/unsaved changes/);
  });
});

describe('other programs’ presentations', () => {
  const dialogOpen = () => !el('overlay').classList.contains('hidden');

  async function seedPptx(path, build) {
    const { SlidesModel } = await import('../src/js/model.js');
    const { writePptx } = await import('../src/js/core/formats/pptx-write.js');
    const { encodeBlock } = await import('../src/js/core/package.js');
    const deck = new SlidesModel();
    build(deck);
    window.__TAURI_PACKAGES__ = { [path]: encodeBlock(writePptx(deck.toJSON(), new Map()).entries) };
  }

  it('opens a PowerPoint file, saves it as OpenDocument, and reopens what it wrote', async () => {
    await seedPptx('/tmp/talk.pptx', (deck) => {
      deck.addElement(deck.slides[0].id, { kind: 'text', content: [{ text: 'From PowerPoint' }] });
      deck.addSlide();
    });
    window.__TAURI_PICK__ = { open: '/tmp/talk.pptx' };
    el('btn-open').click();
    await until(() => thumbs().length === 2);
    expect(elements()[0].textContent).toContain('From PowerPoint');
    expect(document.title).toContain('talk.pptx');

    window.__TAURI_PICK__ = { save: '/tmp/talk.odp' };
    el('btn-save-as').click();
    await until(dialogOpen);
    document.querySelector('[data-field="format"]').value = 'odp';
    el('panel-confirm').click();
    await until(() => window.__TAURI_WRITTEN__?.['/tmp/talk.odp']);
    const { decodeBlock } = await import('../src/js/core/package.js');
    const { readOdp } = await import('../src/js/core/formats/odp.js');
    const written = readOdp(decodeBlock(window.__TAURI_WRITTEN__['/tmp/talk.odp'])).document;
    expect(written.slides).toHaveLength(2);
    expect(written.slides[0].elements[0].content[0].text).toBe('From PowerPoint');
    expect(document.title).toContain('talk.odp');
  });

  it('asks before saving over a file that lost something when it was opened', async () => {
    await seedPptx('/tmp/lossy.pptx', (deck) => {
      deck.addElement(deck.slides[0].id, { kind: 'image', resource: 'resources/missing.png' });
    });
    const { decodeBlock, encodeBlock } = await import('../src/js/core/package.js');
    const pkg = decodeBlock(window.__TAURI_PACKAGES__['/tmp/lossy.pptx']);
    const entries = [...pkg.entries].map(([name, data]) => ({
      name,
      data: name === 'ppt/slides/slide1.xml' ? new TextDecoder().decode(data).replace('<p:sld ', '<p:sld show="0" ') : data,
    }));
    window.__TAURI_PACKAGES__['/tmp/lossy.pptx'] = encodeBlock(entries);
    window.__TAURI_PICK__ = { open: '/tmp/lossy.pptx' };
    el('btn-open').click();
    await until(dialogOpen);
    expect(el('panel-body').textContent).toContain('Hidden slides, shown');
    el('panel-cancel').click();
    await until(() => !dialogOpen());

    el('btn-add-text').click();
    await settle();
    el('btn-save').click();
    await until(dialogOpen);
    expect(el('panel-title').textContent).toContain('Save over');
    document.querySelector('[data-choice="over"]').click();
    await until(() => window.__TAURI_WRITTEN__?.['/tmp/lossy.pptx']);
    expect(window.__TAURI_WRITTEN__['/tmp/lossy.pptx']).toBeInstanceOf(Uint8Array);
  });
});

describe('printing', () => {
  const preview = () => document.getElementById('print-view');

  it('prints slides, handouts and notes pages, on the paper chosen', async () => {
    for (let i = 0; i < 4; i += 1) {
      el('btn-add-slide').click();
      await settle();
    }
    el('btn-print').click();
    await until(() => preview()?.querySelector('.print-page'));
    expect(preview().querySelectorAll('.print-page')).toHaveLength(5);

    const set = (field, value) => {
      const input = preview().querySelector(`[data-print-field="${field}"]`);
      input.value = value;
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    set('layout', 'handouts-4');
    await until(() => preview().querySelectorAll('.print-page').length === 2);
    expect(preview().querySelectorAll('.print-slide')).toHaveLength(5);
    set('orientation', 'portrait');
    await until(() => preview().querySelector('.print-page').style.width === '210mm');
    set('layout', 'notes');
    await until(() => preview().querySelectorAll('.print-notes').length === 5);

    preview().querySelector('[data-print="go"]').click();
    await until(() => commands().includes('print_page'));
    expect(window.__TAURI_CALLS__.find((c) => c.command === 'print_page').payload).toEqual({ width: 210, height: 297 });
    preview().querySelector('[data-print="close"]').click();
    await until(() => !preview());
  });
});
