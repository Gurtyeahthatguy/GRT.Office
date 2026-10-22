/** Questions and notices go to the dialog plugin in the shape it reads. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let invoke;

beforeEach(() => {
  vi.resetModules();
  invoke = vi.fn(async () => 'Yes');
  globalThis.window = globalThis.window ?? globalThis;
  window.__TAURI__ = { core: { invoke } };
});

describe('the native dialogs', () => {
  it('a question is a Yes or No message, and Yes is a yes', async () => {
    const io = await import('../src/js/io.js');
    expect(await io.confirm('Delete it?', 'Delete')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:dialog|message', {
      message: 'Delete it?', title: 'Delete', kind: 'warning', buttons: 'YesNo',
    });
  });

  it('No, or a dialog that fails, is a no', async () => {
    const io = await import('../src/js/io.js');
    invoke.mockResolvedValueOnce('No');
    expect(await io.confirm('Delete it?')).toBe(false);
    invoke.mockRejectedValueOnce(new Error('no display'));
    expect(await io.confirm('Delete it?')).toBe(false);
  });

  it('a notice carries its message and title', async () => {
    const io = await import('../src/js/io.js');
    await io.notify('Saved.', 'Exported');
    expect(invoke).toHaveBeenCalledWith('plugin:dialog|message', { message: 'Saved.', title: 'Exported' });
  });
});
