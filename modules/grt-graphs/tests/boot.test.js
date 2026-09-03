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

async function boot() {
  vi.resetModules();
  installPage();
  await import('../scripts/preview-stub.js');
  await import('../src/js/main.js');
  await ready();
}

const commands = () => (window.__TAURI_CALLS__ ?? []).map((c) => c.command);
const el = (id) => document.getElementById(id);
const nodes = () => el('canvas').querySelectorAll('g.node');
const edges = () => el('canvas').querySelectorAll('path.edge');

/** A whole drag: press on `target`, move by (dx, dy), release. */
async function drag(target, dx, dy, from = { x: 400, y: 300 }) {
  target.dispatchEvent(new window.MouseEvent('mousedown', {
    bubbles: true, button: 0, clientX: from.x, clientY: from.y,
  }));
  await settle();

  // More than one move, because the model applies each as a delta against
  // what it has already applied, and one move would never exercise that.
  for (const step of [0.5, 1]) {
    window.dispatchEvent(new window.MouseEvent('mousemove', {
      bubbles: true, clientX: from.x + dx * step, clientY: from.y + dy * step,
    }));
  }
  window.dispatchEvent(new window.MouseEvent('mouseup', {
    bubbles: true, clientX: from.x + dx, clientY: from.y + dy,
  }));
  await settle();
}

/** Drags from a port to a node, which is how a link is made. */
async function connect(port, target) {
  port.dispatchEvent(new window.MouseEvent('mousedown', {
    bubbles: true, button: 0, clientX: 100, clientY: 100,
  }));
  window.dispatchEvent(new window.MouseEvent('mousemove', {
    bubbles: true, clientX: 300, clientY: 300,
  }));

  const real = document.elementFromPoint;
  document.elementFromPoint = () => target;
  try {
    window.dispatchEvent(new window.MouseEvent('mouseup', {
      bubbles: true, clientX: 300, clientY: 300,
    }));
    await settle();
  } finally {
    document.elementFromPoint = real;
  }
}

beforeEach(async () => { await boot(); });

describe('the program starts', () => {
  it('asks the backend who it is', () => {
    expect(commands()).toContain('runtime_info');
  });

  it('says the diagram is empty, and says so on the canvas too', () => {
    expect(el('status').textContent).toMatch(/0 nodes • 0 links/);
    expect(el('empty-state').classList.contains('hidden')).toBe(false);
  });

  it('CANARY: an empty diagram draws no nodes', () => {
    expect(nodes().length).toBe(0);
  });
});

describe('nodes', () => {
  it('adds one, and it reaches the canvas', async () => {
    el('btn-add').click();
    await settle();

    expect(nodes().length).toBe(1);
    expect(el('status').textContent).toMatch(/1 node • 0 links/);
    expect(el('empty-state').classList.contains('hidden')).toBe(true);
  });

  it('selects what it has just added', async () => {
    el('btn-add').click();
    await settle();

    expect(el('status').textContent).toMatch(/1 selected/);
    expect(el('btn-delete').disabled).toBe(false);
    expect(nodes()[0].classList.contains('selected')).toBe(true);
  });

  it('deletes the selection', async () => {
    el('btn-add').click();
    await settle();
    el('btn-delete').click();
    await settle();

    expect(nodes().length).toBe(0);
  });

  it('is not deletable with nothing selected', () => {
    expect(el('btn-delete').disabled).toBe(true);
  });
});

describe('the drag that did nothing', () => {
  it('moves a node, and the node ends up somewhere else', async () => {
    el('btn-add').click();
    await settle();

    const before = nodes()[0].querySelector('rect, ellipse, polygon, path');
    const x = before.getAttribute('x') ?? before.getAttribute('cx');

    await drag(nodes()[0], 120, 90);

    const after = nodes()[0].querySelector('rect, ellipse, polygon, path');
    const moved = after.getAttribute('x') ?? after.getAttribute('cx');
    expect(moved).not.toBe(x);
    expect(el('status').textContent).toMatch(/unsaved changes/);
  });

  it('is ONE entry in the undo stack, not one per mouse event', async () => {
    el('btn-add').click();
    await settle();

    const before = nodes()[0].querySelector('rect, ellipse, polygon, path');
    const start = before.getAttribute('x') ?? before.getAttribute('cx');

    await drag(nodes()[0], 120, 90);
    el('btn-undo').click();
    await settle();

    const back = nodes()[0].querySelector('rect, ellipse, polygon, path');
    expect(back.getAttribute('x') ?? back.getAttribute('cx')).toBe(start);
  });

  it('a click that does not move the node records nothing', async () => {
    el('btn-add').click();
    await settle();
    el('btn-undo').click();      // undo the node itself.
    await settle();
    el('btn-redo').click();
    await settle();

    const node = nodes()[0];
    node.dispatchEvent(new window.MouseEvent('mousedown', {
      bubbles: true, button: 0, clientX: 400, clientY: 300,
    }));
    window.dispatchEvent(new window.MouseEvent('mouseup', {
      bubbles: true, clientX: 400, clientY: 300,
    }));
    await settle();

    // Nothing was moved, so redo must still be spent and undo must still hold
    // only the node's creation.
    el('btn-undo').click();
    await settle();
    expect(nodes().length).toBe(0);
  });
});

describe('connecting two nodes', () => {
  it('drags from a port to another node and makes a link', async () => {
    el('btn-add').click();
    await settle();
    el('btn-add').click();
    await settle();
    expect(nodes().length).toBe(2);

    const port = el('canvas').querySelector('.port');
    expect(port).toBeTruthy();

    await connect(port, nodes()[0]);

    expect(el('status').textContent).toMatch(/1 link/);
    expect(edges().length).toBe(1);
  });

  it('deleting a node takes its links with it, and undo brings both back', async () => {
    el('btn-add').click();
    await settle();
    el('btn-add').click();
    await settle();

    await connect(el('canvas').querySelector('.port'), nodes()[0]);
    expect(edges().length).toBe(1);

    nodes()[0].dispatchEvent(new window.MouseEvent('mousedown', {
      bubbles: true, button: 0, clientX: 300, clientY: 300,
    }));
    window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
    await settle();
    el('btn-delete').click();
    await settle();

    expect(nodes().length).toBe(1);
    expect(edges().length).toBe(0);

    el('btn-undo').click();
    await settle();
    expect(nodes().length).toBe(2);
    expect(edges().length).toBe(1);
  });
});

describe('text in a node', () => {
  it('a double-click opens the editor over the node', async () => {
    el('btn-add').click();
    await settle();

    nodes()[0].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();

    expect(el('text-editor').classList.contains('hidden')).toBe(false);
  });

  it('Enter keeps what was typed and closes the editor', async () => {
    el('btn-add').click();
    await settle();

    nodes()[0].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();

    const input = el('text-editor');
    input.value = 'Decision';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(input.classList.contains('hidden')).toBe(true);
    expect(el('canvas').textContent).toContain('Decision');
  });

  it('Escape throws it away', async () => {
    el('btn-add').click();
    await settle();

    nodes()[0].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle();

    const input = el('text-editor');
    input.value = 'Never typed';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    expect(input.classList.contains('hidden')).toBe(true);
    expect(el('canvas').textContent).not.toContain('Never typed');
  });
});

describe('zoom', () => {
  it('reports the level, and changes it', async () => {
    expect(el('zoom-label').textContent).toBe('100%');

    el('btn-zoom-in').click();
    await settle();
    expect(el('zoom-label').textContent).not.toBe('100%');

    el('btn-zoom-out').click();
    await settle();
    expect(el('zoom-label').textContent).toBe('100%');
  });
});

describe('undo', () => {
  it('is disabled with nothing to undo', () => {
    expect(el('btn-undo').disabled).toBe(true);
    expect(el('btn-redo').disabled).toBe(true);
  });

  it('takes an added node back, and puts it forward again', async () => {
    el('btn-add').click();
    await settle();

    el('btn-undo').click();
    await settle();
    expect(nodes().length).toBe(0);

    el('btn-redo').click();
    await settle();
    expect(nodes().length).toBe(1);
  });
});

describe('saving', () => {
  it('CANARY: nothing is written before anything changes', () => {
    expect(commands()).not.toContain('write_grt');
  });

  it('asks where to put a diagram that has never been saved', async () => {
    el('btn-add').click();
    await settle();

    el('btn-save').click();
    await until(() => commands().some((c) => c.includes('save') || c === 'write_grt'));

    expect(commands().some((c) => c.includes('save') || c === 'write_grt')).toBe(true);
  });
});
