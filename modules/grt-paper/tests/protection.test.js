// @vitest-environment jsdom

/** Passwords: asking until one opens the file, and the Save as fields. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  withPassword, passwordFields, wirePasswordFields, passwordFrom, canProtect, PROTECTION,
} from '../src/js/core/protection.js';

const NEEDED = new Error('grt:password-needed:grt');
const WRONG = new Error('grt:password-wrong');

beforeEach(() => {
  document.body.innerHTML = `
    <div id="overlay" class="overlay hidden">
      <div class="panel">
        <h2 id="panel-title"></h2>
        <div id="panel-body"></div>
        <button id="panel-cancel">Cancel</button>
        <button id="panel-confirm">OK</button>
      </div>
    </div>`;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const panelText = () => document.getElementById('panel-body').textContent;

async function answer(password) {
  await tick();
  document.querySelector('[data-field="password"]').value = password;
  document.getElementById('panel-confirm').click();
}

describe('withPassword', () => {
  it('opens a file in the clear without asking', async () => {
    const tried = [];
    const opened = await withPassword('a.grt', async (password) => { tried.push(password); return 'doc'; });
    expect(opened).toEqual({ value: 'doc', password: null });
    expect(tried).toEqual([null]);
  });

  it('asks again after a wrong password and keeps the right one', async () => {
    const tried = [];
    const attempt = async (password) => {
      tried.push(password);
      if (password === null) throw NEEDED;
      if (password !== 'right') throw WRONG;
      return 'doc';
    };
    const pending = withPassword('a.odt', attempt);
    await answer('wrong');
    await tick();
    expect(panelText()).toContain('not right');
    await answer('right');
    expect(await pending).toEqual({ value: 'doc', password: 'right' });
    expect(tried).toEqual([null, 'wrong', 'right']);
  });

  it('gives up when the person cancels', async () => {
    const pending = withPassword('a.docx', async () => { throw NEEDED; });
    await tick();
    document.getElementById('panel-cancel').click();
    expect(await pending).toBeNull();
  });

  it('lets other errors through', async () => {
    await expect(withPassword('a.grt', async () => { throw new Error('damaged'); })).rejects.toThrow('damaged');
  });
});

describe('the Save as fields', () => {
  it('knows which formats carry a password', () => {
    expect(['grt', 'odt', 'ods', 'odp', 'odg', 'docx', 'xlsx', 'pptx'].every(canProtect)).toBe(true);
    expect(['fodt', 'csv', 'pdf', 'md', 'toString'].some(canProtect)).toBe(false);
    expect(PROTECTION.docx).toBe('office');
    expect(PROTECTION.odt).toBe('odf');
  });

  it('turns off for a format that cannot carry one', () => {
    document.getElementById('panel-body').innerHTML = `
      <select data-field="format"><option value="grt">GRT</option><option value="fodt">Flat</option></select>
      ${passwordFields('old "one"')}`;
    wirePasswordFields();
    const password = document.querySelector('[data-field="password"]');
    expect(password.value).toBe('old "one"');
    expect(password.disabled).toBe(false);
    const select = document.querySelector('[data-field="format"]');
    select.value = 'fodt';
    select.dispatchEvent(new Event('change'));
    expect(password.disabled).toBe(true);
  });

  it('says what is wrong with what was typed', () => {
    expect(passwordFrom({ protect: false, password: 'x' })).toEqual({ password: null });
    expect(passwordFrom({ protect: true, password: '', passwordAgain: '' }).error).toMatch(/Type a password/);
    expect(passwordFrom({ protect: true, password: 'a', passwordAgain: 'b' }).error).toMatch(/not the same/);
    expect(passwordFrom({ protect: true, password: 'a', passwordAgain: 'a' }, 'fodt')).toEqual({ password: null });
    expect(passwordFrom({ protect: true, password: 'a', passwordAgain: 'a' }, 'docx')).toEqual({ password: 'a' });
  });
});
