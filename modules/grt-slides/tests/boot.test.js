// @vitest-environment jsdom

/** Start the actual program and use it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, '..', 'src', 'index.html'), 'utf8');

function installPage() {
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml)[1]
    .replace(/<script[\s\S]*?<\/script>/g, '');
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** Waits for something to happen, rather than for a number of turns. */
async function until(predicate, tries = 400) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await settle();
  }
  return predicate();
}

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
