/** The shared autosave timer, driven by a fake clock. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoSave } from '../src/js/core/autosave.js';

/** A save that takes `ms` and records when it started and finished. */
function recorder(ms = 0, { fail = () => false } = {}) {
  const log = [];
  let active = 0;
  let overlap = false;
  const save = async () => {
    active += 1;
    if (active > 1) overlap = true;
    log.push(['start', Date.now()]);
    if (ms) await new Promise((resolve) => { setTimeout(resolve, ms); });
    active -= 1;
    if (fail()) throw new Error('disk full');
    log.push(['end', Date.now()]);
  };
  return { save, log, overlapped: () => overlap, starts: () => log.filter((e) => e[0] === 'start').map((e) => e[1]) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('pauses', () => {
  it('saves once, after the pause, not before', async () => {
    const r = recorder();
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 30000 });
    auto.touch();
    await vi.advanceTimersByTimeAsync(1999);
    expect(r.starts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.starts()).toEqual([2000]);
    expect(auto.pending).toBe(false);
  });

  it('waits while changes keep coming faster than the pause', async () => {
    const r = recorder();
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 30000 });
    for (let i = 0; i < 5; i += 1) {
      auto.touch();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(r.starts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.starts()).toEqual([6000]);
  });

  it('saves at the ceiling while changes never pause', async () => {
    const r = recorder();
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 10000 });
    for (let t = 0; t < 25000; t += 500) {
      auto.touch();
      await vi.advanceTimersByTimeAsync(500);
    }
    // Typing for 25 seconds without a pause still saves every 10.
    expect(r.starts()).toEqual([10000, 20000]);
  });

  it('CANARY: nothing changed, nothing saved', async () => {
    const r = recorder();
    new AutoSave(r.save, { pause: 2000, ceiling: 30000 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(r.starts()).toEqual([]);
  });
});

describe('one save at a time', () => {
  it('a change made during a save is saved by a later one', async () => {
    const r = recorder(3000);
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 30000 });
    auto.touch();
    await vi.advanceTimersByTimeAsync(2000);         // first save starts, runs until 5000
    auto.touch();                                     // during it
    await vi.advanceTimersByTimeAsync(3000);          // first save ends at 5000
    await vi.advanceTimersByTimeAsync(2000);          // a pause after it ends
    expect(r.starts()).toEqual([2000, 7000]);
    expect(r.overlapped()).toBe(false);
    expect(auto.pending).toBe(false);
  });

  it('a ceiling that falls during a save is armed again afterwards', async () => {
    const r = recorder(8000);
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 5000 });
    auto.touch();
    await vi.advanceTimersByTimeAsync(2500);          // save 1 runs 2000 to 10000
    for (let t = 2500; t < 31000; t += 500) {
      auto.touch();                                   // changes never pause
      await vi.advanceTimersByTimeAsync(500);
    }
    // Saves keep coming while typing never pauses.
    expect(r.starts()).toEqual([2000, 12500, 22500]);
    expect(r.overlapped()).toBe(false);
  });
});

describe('flush', () => {
  it('saves at once, and resolves when the save is done', async () => {
    const r = recorder(1000);
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 30000 });
    auto.touch();
    const done = auto.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(r.starts()).toEqual([0]);
    expect(auto.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.starts()).toEqual([0]);
  });

  it('waits for a running save, then saves what changed during it', async () => {
    const r = recorder(1000);
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 30000 });
    auto.touch();
    await vi.advanceTimersByTimeAsync(2000);          // save 1: 2000 to 3000
    auto.touch();
    const done = auto.flush();
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(r.starts()).toEqual([2000, 3000]);
    expect(auto.pending).toBe(false);
  });

  it('with nothing waiting, does nothing', async () => {
    const r = recorder();
    const auto = new AutoSave(r.save);
    await auto.flush();
    expect(r.starts()).toEqual([]);
  });
});

describe('failure', () => {
  it('keeps the change pending, reports it, and tries again after a pause', async () => {
    let failing = true;
    const errors = [];
    const r = recorder(0, { fail: () => failing });
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 30000, onError: (e) => errors.push(e.message) });
    auto.touch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toEqual(['disk full']);
    expect(auto.pending).toBe(true);
    failing = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.starts()).toEqual([2000, 4000]);
    expect(auto.pending).toBe(false);
  });

  it('a flush that fails leaves the change pending for the caller to see', async () => {
    const r = recorder(0, { fail: () => true });
    const auto = new AutoSave(r.save, { onError: () => {} });
    auto.touch();
    await auto.flush();
    expect(auto.pending).toBe(true);
  });
});

describe('cancel', () => {
  it('forgets what was waiting', async () => {
    const r = recorder();
    const auto = new AutoSave(r.save, { pause: 2000, ceiling: 30000 });
    auto.touch();
    auto.cancel();
    await vi.advanceTimersByTimeAsync(60000);
    expect(r.starts()).toEqual([]);
    expect(auto.pending).toBe(false);
  });
});
