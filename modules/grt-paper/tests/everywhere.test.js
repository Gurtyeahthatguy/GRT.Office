// @vitest-environment jsdom

/** Search everywhere's panel: results drawn as text, the program's own kind opened, a password used once and dropped. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = [];
let answers = {};
window.__TAURI__ = { core: { invoke: async (cmd, args) => {
  calls.push({ cmd, args });
  const answer = answers[cmd];
  return typeof answer === 'function' ? answer(args) : answer;
} } };
const { searchEverywhere, snippetNodes } = await import('../src/js/core/everywhere.js');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (name) => document.querySelector(`[data-ev="${name}"]`);

beforeEach(() => {
  calls.length = 0;
  document.body.innerHTML = `<div id="overlay" class="hidden"><h2 id="panel-title"></h2><div id="panel-body"></div>
    <div><button id="panel-cancel">Close</button><button id="panel-confirm" class="hidden">OK</button></div></div>`;
  answers = {
    everywhere_folder: '/docs',
    everywhere_search: ({ query }) => ({
      summary: { documents: 3, read: 2, locked: 1, failed: 0 },
      locked: ['/docs/sealed.grt'],
      hits: query ? [
        { path: '/docs/report.grt', kind: 'paper', snippet: 'the <<zebra>> <img src=x onerror=alert(1)> crossing' },
        { path: '/docs/budget.grt', kind: 'grid', snippet: '<<zebra>> costs' },
      ] : [],
    }),
    everywhere_search_locked: () => ({ hits: [{ path: '/docs/sealed.grt', kind: 'paper', snippet: 'secret zebra', locked: true }], opened: 1, tried: 1, left: 0 }),
    everywhere_forget: null,
  };
});

describe('search everywhere', () => {
  it('marks the found words and never reads a snippet as markup', () => {
    const holder = document.createElement('div');
    holder.append(...snippetNodes('a <<b>> <i>c</i> <<d>>'));
    expect(holder.querySelectorAll('mark')).toHaveLength(2);
    expect(holder.querySelector('i')).toBeNull();
    expect(holder.textContent).toBe('a b <i>c</i> d');
  });

  it('reads the folder, finds as you type, opens its own kind and names the program of another', async () => {
    const open = vi.fn();
    const done = searchEverywhere({ kind: 'paper', open });
    await tick(10);
    expect(calls.find((c) => c.cmd === 'everywhere_search').args).toEqual({ folder: '/docs', query: '', refreshFirst: true });
    expect(at('state').textContent).toMatch(/3 document\(s\) in the folder, 1 protected/);
    expect(at('locked').classList.contains('hidden')).toBe(false);

    at('query').value = 'zebra';
    at('query').oninput();
    await tick(260);
    const rows = [...document.querySelectorAll('.everywhere-hit')];
    expect(rows.map((r) => r.dataset.path)).toEqual(['/docs/report.grt', '/docs/budget.grt']);
    expect(document.querySelector('.everywhere-hit img')).toBeNull();
    expect(rows[1].textContent).toMatch(/GRT Grid/);

    rows[1].click();
    expect(open).not.toHaveBeenCalled();
    expect(at('state').textContent).toMatch(/GRT Grid/);
    rows[0].click();
    await done;
    expect(open).toHaveBeenCalledWith('/docs/report.grt');
  });

  it('searches the protected ones with a password it does not keep, and deletes the index when asked', async () => {
    const done = searchEverywhere({ kind: 'paper', open: () => {} });
    await tick(10);
    at('query').value = 'zebra';
    at('password').value = 'pw';
    at('unlock').click();
    await tick(10);
    expect(calls.find((c) => c.cmd === 'everywhere_search_locked').args).toEqual({ query: 'zebra', password: 'pw' });
    expect(at('password').value).toBe('');
    expect(document.querySelector('.everywhere-hit').textContent).toMatch(/sealed.*protected/);
    expect(at('state').textContent).toMatch(/opened 1 of 1/);
    // Other words: what the password found goes.
    at('query').value = 'other';
    at('query').oninput();
    await tick(260);
    expect([...document.querySelectorAll('.everywhere-hit')].some((r) => /sealed/.test(r.dataset.path))).toBe(false);

    at('forget').click();
    await tick(10);
    expect(calls.some((c) => c.cmd === 'everywhere_forget')).toBe(true);
    expect(at('query').disabled).toBe(true);
    expect(document.querySelectorAll('.everywhere-hit')).toHaveLength(0);
    document.getElementById('panel-cancel').click();
    await done;
  });
});
