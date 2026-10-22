// @vitest-environment jsdom

/** The shared keeper: autosave, recovery copies and closing, against a fake bridge. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SLOT = { id: '0123456789abcdef', path: '/cache/recovery/0123456789abcdef.grt' };

let calls;
let closeHandler;
let answers;
let Keeper;

function installBridge() {
  calls = [];
  closeHandler = null;
  answers = { recovery_begin: SLOT, recovery_list: [] };
  window.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        calls.push([command, args]);
        const answer = answers[command];
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer(args) : answer;
      },
    },
    event: {
      listen: async (name, handler) => {
        if (name === 'grt://close-requested') closeHandler = handler;
        return () => {};
      },
    },
  };
}

function installPage() {
  document.body.innerHTML = `
    <div id="overlay" class="overlay hidden">
      <div class="panel">
        <h2 id="panel-title"></h2>
        <div id="panel-body"></div>
        <div class="panel-actions">
          <button id="panel-cancel">Cancel</button>
          <button id="panel-confirm" class="primary">OK</button>
        </div>
      </div>
    </div>`;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const commands = () => calls.map(([command]) => command);
const choice = (id) => document.querySelector(`[data-choice="${id}"]`);
const dialogTitle = () => document.getElementById('panel-title').textContent;
const dialogOpen = () => !document.getElementById('overlay').classList.contains('hidden');

/** A host whose document is `doc`, recording what the keeper asks of it. */
function makeHost(doc, overrides = {}) {
  const log = [];
  const host = {
    log,
    name: () => doc.name,
    path: () => doc.path,
    canSaveInPlace: () => !!doc.path,
    writeCopy: async (path) => { log.push(['copy', path]); },
    save: async (options = {}) => {
      log.push(['save', !!options.silent]);
      doc.model.dirty = false;
      return true;
    },
    openRecovered: async (file, meta) => { log.push(['open', file, meta]); },
    ...overrides,
  };
  return host;
}

function makeDoc(path = null, name = 'Untitled') {
  return { path, name, model: { dirty: false } };
}

beforeEach(async () => {
  vi.useFakeTimers();
  installBridge();
  installPage();
  vi.resetModules();
  ({ Keeper } = await import('../src/js/core/keeper.js'));
});
afterEach(() => vi.useRealTimers());

async function started(doc, host, options = {}, keeperOptions = {}) {
  const toasts = [];
  const keeper = new Keeper(host, {
    program: 'GRT Paper', extension: 'grt', toast: (m, e) => toasts.push([m, !!e]), ...keeperOptions,
  });
  const recovered = keeper.start(options);
  await flush();
  keeper.watch(doc.model);
  return { keeper, toasts, recovered: await recovered };
}

describe('starting', () => {
  it('claims a recovery slot for its own extension and listens for closing', async () => {
    const doc = makeDoc();
    await started(doc, makeHost(doc));
    expect(calls[0]).toEqual(['recovery_begin', { extension: 'grt' }]);
    expect(closeHandler).toBeTypeOf('function');
  });

  it('in ephemeral mode claims nothing and offers nothing', async () => {
    answers.recovery_list = [{ id: 'aaaaaaaaaaaaaaaa', path: '/x', meta: { name: 'x' } }];
    const doc = makeDoc();
    await started(doc, makeHost(doc), { ephemeral: true });
    expect(commands()).not.toContain('recovery_begin');
    expect(commands()).not.toContain('recovery_list');
    expect(dialogOpen()).toBe(false);
  });

  it('a slot that cannot be claimed is reported, and the program carries on', async () => {
    answers.recovery_begin = new Error('denied');
    const doc = makeDoc();
    const { toasts } = await started(doc, makeHost(doc));
    expect(toasts).toEqual([['Recovery copies are unavailable: denied', true]]);
  });
  it('a backend that gives no slot offers nothing and does not fail', async () => {
    answers.recovery_begin = null;
    answers.recovery_list = [{ id: 'aaaaaaaaaaaaaaaa', path: '/x', meta: { name: 'x' } }];
    const doc = makeDoc();
    const keeper = new Keeper(makeHost(doc), { program: 'GRT Paper', extension: 'grt' });
    expect(await keeper.start({})).toBe(false);
    expect(dialogOpen()).toBe(false);
  });

  it('a backend that gives no list does not fail', async () => {
    answers.recovery_list = null;
    const doc = makeDoc();
    const keeper = new Keeper(makeHost(doc), { program: 'GRT Paper', extension: 'grt' });
    expect(await keeper.start({})).toBe(false);
  });
});

describe('autosave into a recovery copy', () => {
  it('a change holds the window and is copied after a pause', async () => {
    const doc = makeDoc('/docs/letter.grt', 'letter.grt');
    const host = makeHost(doc);
    await started(doc, host);
    doc.model.dirty = true;
    await flush();
    expect(calls).toContainEqual(['set_close_guard', { held: true }]);
    expect(host.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.log).toEqual([['copy', SLOT.path]]);
    expect(calls).toContainEqual(['recovery_saved', { meta: { path: '/docs/letter.grt', name: 'letter.grt' } }]);
  });

  it('CANARY: an unchanged document is neither held nor copied', async () => {
    const doc = makeDoc('/docs/letter.grt', 'letter.grt');
    const host = makeHost(doc);
    await started(doc, host);
    await vi.advanceTimersByTimeAsync(60000);
    expect(host.log).toEqual([]);
    expect(commands()).not.toContain('set_close_guard');
  });

  it('an untitled document is copied with no path', async () => {
    const doc = makeDoc();
    const host = makeHost(doc);
    await started(doc, host);
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toContainEqual(['recovery_saved', { meta: { path: null, name: 'Untitled' } }]);
  });

  it('saving lets the window go and throws the copy away', async () => {
    const doc = makeDoc('/docs/letter.grt', 'letter.grt');
    const { keeper } = await started(doc, makeHost(doc));
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(2000);
    calls.length = 0;
    doc.model.dirty = false;
    await keeper.saved();
    expect(calls).toContainEqual(['set_close_guard', { held: false }]);
    expect(calls).toContainEqual(['recovery_discard', undefined]);
  });

  it('a save made before the pause runs out cancels the autosave', async () => {
    const doc = makeDoc('/docs/letter.grt', 'letter.grt');
    const host = makeHost(doc);
    const { keeper } = await started(doc, host);
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(1000);
    doc.model.dirty = false;
    await keeper.saved();
    await vi.advanceTimersByTimeAsync(60000);
    expect(host.log.filter(([kind]) => kind === 'copy')).toEqual([]);
  });

  it('a new document stops the old one being kept', async () => {
    const first = makeDoc('/docs/a.grt', 'a.grt');
    const host = makeHost(first);
    const { keeper } = await started(first, host);
    first.model.dirty = true;
    const second = { dirty: false };
    keeper.watch(second);
    first.model.dirty = true;
    await vi.advanceTimersByTimeAsync(60000);
    expect(host.log).toEqual([]);
  });
  it('changes to a document no longer open do not hold back the autosave', async () => {
    const first = makeDoc('/docs/a.grt', 'a.grt');
    const host = makeHost(first);
    const { keeper } = await started(first, host);
    const second = { dirty: false };
    keeper.watch(second);
    second.dirty = true;
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      first.model.dirty = true;
    }
    expect(host.log).toEqual([['copy', SLOT.path]]);
  });
});

describe('autosave onto the file', () => {
  it('saves the document itself, silently, and keeps no copy', async () => {
    const doc = makeDoc('/docs/letter.grt', 'letter.grt');
    const host = makeHost(doc);
    await started(doc, host, { mode: 'file' });
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.log).toEqual([['save', true]]);
    expect(commands()).toContain('recovery_discard');
    expect(doc.model.dirty).toBe(false);
  });

  it('an untitled document still goes to a copy', async () => {
    const doc = makeDoc();
    const host = makeHost(doc);
    await started(doc, host, { mode: 'file' });
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.log).toEqual([['copy', SLOT.path]]);
  });

  it('when the file cannot be written the work goes to a copy and the user is told', async () => {
    const doc = makeDoc('/docs/letter.grt', 'letter.grt');
    const host = makeHost(doc, { save: async () => { throw new Error('read-only'); } });
    const { toasts } = await started(doc, host, { mode: 'file' });
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.log).toEqual([['copy', SLOT.path]]);
    expect(toasts).toContainEqual(['Autosave failed: read-only', true]);
  });
});

describe('a change that arrives while a save is writing', () => {
  it('counts every change to the open document, and none to an old one', async () => {
    const first = makeDoc('/docs/a.grt', 'a.grt');
    const { keeper } = await started(first, makeHost(first));
    const start = keeper.revision;
    first.model.dirty = true;
    first.model.dirty = true;
    first.model.dirty = false;
    expect(keeper.revision).toBe(start + 2);
    const second = { dirty: false };
    keeper.watch(second);
    first.model.dirty = true;
    expect(keeper.revision).toBe(start + 2);
  });

  it('a save that ends with the document still changed keeps it held and its copy kept', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    const { keeper } = await started(doc, makeHost(doc));
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(2000);
    await keeper.saved();
    expect(commands()).not.toContain('recovery_discard');
    const guards = calls.filter(([command]) => command === 'set_close_guard');
    expect(guards.at(-1)[1]).toEqual({ held: true });
  });

  it('onto the file, the change is saved by the next autosave, and no copy is dropped meanwhile', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    let saves = 0;
    const host = makeHost(doc, {
      save: async () => {
        saves += 1;
        doc.model.dirty = saves === 1;
        return true;
      },
    });
    await started(doc, host, { mode: 'file' });
    doc.model.dirty = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toBe(1);
    expect(commands()).not.toContain('recovery_discard');
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toBe(2);
    expect(commands()).toContain('recovery_discard');
  });

  it('onto the file, closing still asks when the save was overtaken', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    const host = makeHost(doc, { save: async () => { doc.model.dirty = true; return true; } });
    await started(doc, host, { mode: 'file' });
    doc.model.dirty = true;
    const closing = closeHandler();
    await flush();
    expect(dialogOpen()).toBe(true);
    choice('cancel').click();
    await closing;
    expect(commands()).not.toContain('close_window');
  });
});

describe('closing', () => {
  it('a clean document closes at once', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    await started(doc, makeHost(doc));
    await closeHandler();
    expect(commands()).toContain('close_ack');
    expect(commands()).toContain('close_window');
    expect(dialogOpen()).toBe(false);
  });

  it('a changed document asks, and Cancel keeps it open', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    await started(doc, makeHost(doc));
    doc.model.dirty = true;
    const closing = closeHandler();
    await flush();
    expect(dialogOpen()).toBe(true);
    expect(dialogTitle()).toBe('Save changes to “a.grt”?');
    choice('cancel').click();
    await closing;
    expect(commands()).not.toContain('close_window');
    expect(doc.model.dirty).toBe(true);
  });

  it('Escape is Cancel', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    await started(doc, makeHost(doc));
    doc.model.dirty = true;
    const closing = closeHandler();
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await closing;
    expect(commands()).not.toContain('close_window');
  });

  it('Don’t save throws the copy away and closes', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    const host = makeHost(doc);
    await started(doc, host);
    doc.model.dirty = true;
    const closing = closeHandler();
    await flush();
    choice('discard').click();
    await closing;
    expect(host.log.filter(([kind]) => kind === 'save')).toEqual([]);
    const order = commands();
    expect(order).toContain('recovery_discard');
    expect(order).toContain('close_window');
    expect(order.indexOf('recovery_discard')).toBeLessThan(order.indexOf('close_window'));
  });

  it('Save saves and then closes', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    const host = makeHost(doc);
    await started(doc, host);
    doc.model.dirty = true;
    const closing = closeHandler();
    await flush();
    choice('save').click();
    await closing;
    expect(host.log).toEqual([['save', false]]);
    expect(commands()).toContain('close_window');
  });

  it('a Save that is cancelled at the file dialog keeps the window open', async () => {
    const doc = makeDoc();
    const host = makeHost(doc, { save: async () => false });
    await started(doc, host);
    doc.model.dirty = true;
    const closing = closeHandler();
    await flush();
    choice('save').click();
    await closing;
    expect(commands()).not.toContain('close_window');
  });

  it('onto the file, closing saves without asking', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    const host = makeHost(doc);
    await started(doc, host, { mode: 'file' });
    doc.model.dirty = true;
    await closeHandler();
    expect(dialogOpen()).toBe(false);
    expect(host.log).toEqual([['save', true]]);
    expect(commands()).toContain('close_window');
  });

  it('an edit still being typed is settled before deciding', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    const host = makeHost(doc, { settle: () => { doc.model.dirty = true; } });
    await started(doc, host);
    const closing = closeHandler();
    await flush();
    expect(dialogOpen()).toBe(true);
    choice('cancel').click();
    await closing;
    expect(commands()).not.toContain('close_window');
  });

  it('a second request while asking does not open a second dialog', async () => {
    const doc = makeDoc('/docs/a.grt', 'a.grt');
    await started(doc, makeHost(doc));
    doc.model.dirty = true;
    const closing = closeHandler();
    await flush();
    await closeHandler();
    expect(document.querySelectorAll('[data-choice="save"]').length).toBe(1);
    expect(commands().filter((c) => c === 'close_ack').length).toBe(2);
    choice('cancel').click();
    await closing;
  });
});

describe('recovery after a crash', () => {
  const ORPHAN = {
    id: 'aaaaaaaaaaaaaaaa',
    path: '/cache/recovery/aaaaaaaaaaaaaaaa.grt',
    meta: { path: '/docs/report.grt', name: 'report.grt' },
  };

  it('offers the orphan, and Recover opens it, keeps it, and lets the old copy go', async () => {
    answers.recovery_list = [ORPHAN];
    const doc = makeDoc('/docs/report.grt', 'report.grt');
    const host = makeHost(doc, {
      openRecovered: async (file, meta) => {
        host.log.push(['open', file, meta]);
        doc.model.dirty = true;
      },
    });
    const keeper = new Keeper(host, { program: 'GRT Paper', extension: 'grt' });
    keeper.watch(doc.model);
    const recovered = keeper.start({});
    await flush();
    expect(dialogTitle()).toBe('Recover “report.grt”?');
    choice('recover').click();
    expect(await recovered).toBe(true);
    expect(host.log[0]).toEqual(['open', ORPHAN.path, ORPHAN.meta]);
    expect(host.log).toContainEqual(['copy', SLOT.path]);
    const order = commands();
    expect(order).toContain('recovery_saved');
    expect(order.indexOf('recovery_saved')).toBeLessThan(order.indexOf('recovery_remove'));
    expect(calls).toContainEqual(['recovery_remove', { id: ORPHAN.id }]);
  });

  it('Discard deletes the orphan and opens nothing', async () => {
    answers.recovery_list = [ORPHAN];
    const doc = makeDoc();
    const host = makeHost(doc);
    const keeper = new Keeper(host, { program: 'GRT Paper', extension: 'grt' });
    const recovered = keeper.start({});
    await flush();
    choice('discard').click();
    expect(await recovered).toBe(false);
    expect(calls).toContainEqual(['recovery_remove', { id: ORPHAN.id }]);
    expect(host.log).toEqual([]);
  });

  it('Later leaves the orphan for next time', async () => {
    answers.recovery_list = [ORPHAN];
    const doc = makeDoc();
    const keeper = new Keeper(makeHost(doc), { program: 'GRT Paper', extension: 'grt' });
    const recovered = keeper.start({});
    await flush();
    choice('later').click();
    expect(await recovered).toBe(false);
    expect(commands()).not.toContain('recovery_remove');
  });

  it('opened on another file, it does not offer an unrelated orphan', async () => {
    answers.recovery_list = [ORPHAN];
    const doc = makeDoc();
    const keeper = new Keeper(makeHost(doc), { program: 'GRT Paper', extension: 'grt' });
    expect(await keeper.start({ initialFile: '/docs/other.grt' })).toBe(false);
    expect(dialogOpen()).toBe(false);
  });

  it('opened on the same file, it offers that file’s changes', async () => {
    answers.recovery_list = [ORPHAN];
    const doc = makeDoc();
    const keeper = new Keeper(makeHost(doc), { program: 'GRT Paper', extension: 'grt' });
    keeper.start({ initialFile: '/docs/report.grt' });
    await flush();
    expect(dialogTitle()).toBe('Recover “report.grt”?');
    choice('later').click();
  });

  it('a copy that cannot be opened is reported and kept', async () => {
    answers.recovery_list = [ORPHAN];
    const doc = makeDoc();
    const host = makeHost(doc, { openRecovered: async () => { throw new Error('damaged'); } });
    const toasts = [];
    const keeper = new Keeper(host, { program: 'GRT Paper', extension: 'grt', toast: (m, e) => toasts.push([m, !!e]) });
    const recovered = keeper.start({});
    await flush();
    choice('recover').click();
    expect(await recovered).toBe(false);
    expect(toasts).toEqual([['Could not recover report.grt: damaged', true]]);
    expect(commands()).not.toContain('recovery_remove');
  });

  it('says how many more wait for next time', async () => {
    answers.recovery_list = [ORPHAN, { ...ORPHAN, id: 'bbbbbbbbbbbbbbbb' }, { ...ORPHAN, id: 'cccccccccccccccc' }];
    const doc = makeDoc();
    const host = makeHost(doc, { openRecovered: async () => { doc.model.dirty = true; } });
    const toasts = [];
    const keeper = new Keeper(host, { program: 'GRT Paper', extension: 'grt', toast: (m) => toasts.push(m) });
    keeper.watch(doc.model);
    const recovered = keeper.start({});
    await flush();
    choice('recover').click();
    await recovered;
    expect(toasts).toContain('2 more unsaved documents will be offered next time');
  });
});
