/** Passwords: asking for the one a file needs, and setting one when saving. */

import { showPanel, readFields, escapeHtml } from './panel.js';

const NEEDED = 'grt:password-needed:';
const WRONG = 'grt:password-wrong';

const textOf = (err) => String(err?.message ?? err ?? '');

/** Whether an error says the file needs a password. */
export const passwordNeeded = (err) => textOf(err).startsWith(NEEDED);

/** Whether an error says the password given does not open the file. */
export const passwordWrong = (err) => textOf(err) === WRONG;

/** How each format is sealed when it has a password. */
export const PROTECTION = {
  grt: 'grt', odt: 'odf', ods: 'odf', odp: 'odf', odg: 'odf', docx: 'office', xlsx: 'office', pptx: 'office',
  ott: 'odf', ots: 'odf', otp: 'odf', otg: 'odf', dotx: 'office', xltx: 'office', potx: 'office',
};

/** Whether a format can carry a password. */
export const canProtect = (format) => Object.prototype.hasOwnProperty.call(PROTECTION, format);

/** Asks for the password of a file; null when the person cancels. */
export async function askPassword(name, { wrong = false } = {}) {
  const confirmed = await showPanel('Password', `
    <p>${wrong ? '<strong>That password is not right.</strong> ' : ''}“${escapeHtml(name)}” is protected with a password.</p>
    <label>Password<input type="password" data-field="password" autocomplete="off" /></label>`, 'Open');
  if (!confirmed) return null;
  return readFields().password ?? '';
}

/**
 * Runs `attempt` without a password, then with each one the person gives, until it works or they cancel.
 * @template T
 * @param {string} name what the file is called, for the question
 * @param {(password: ?string) => Promise<T>} attempt
 * @returns {Promise<?{value: T, password: ?string}>} null when the person cancels
 */
export async function withPassword(name, attempt) {
  let password = null;
  let wrong = false;
  for (;;) {
    try {
      return { value: await attempt(password), password };
    } catch (err) {
      if (passwordWrong(err) || (password !== null && passwordNeeded(err))) wrong = true;
      else if (!passwordNeeded(err)) throw err;
    }
    password = await askPassword(name, { wrong });
    if (password === null) return null;
  }
}

/** The part of a Save as panel that sets a password, filled with the one the file has. */
export function passwordFields(current = null, error = '') {
  const value = escapeHtml(current ?? '');
  const problem = error ? `<p class="hint" style="color: var(--danger, #b3261e)"><strong>${escapeHtml(error)}</strong></p>` : '';
  return `${problem}
    <div class="grt-protect">
      <label class="inline"><input type="checkbox" data-field="protect"${current ? ' checked' : ''} /> Protect with a password</label>
      <label>Password <input type="password" data-field="password" value="${value}" autocomplete="new-password" /></label>
      <label>Repeat it <input type="password" data-field="passwordAgain" value="${value}" autocomplete="new-password" /></label>
      <p class="hint">Without the password nobody can open the file, and there is no way to recover it.</p>
    </div>`;
}

/** Turns the password fields on and off with the format chosen, in the panel on screen. */
export function wirePasswordFields(formatField = '[data-field="format"]') {
  const body = document.getElementById('panel-body');
  const select = body?.querySelector(formatField);
  const box = body?.querySelector('.grt-protect');
  if (!box) return;
  const update = () => {
    const allowed = !select || canProtect(select.value);
    for (const input of box.querySelectorAll('input')) input.disabled = !allowed;
    box.style.opacity = allowed ? '' : '0.5';
  };
  select?.addEventListener('change', update);
  update();
}

/**
 * The password the fields ask for.
 * @returns {{password: ?string}|{error: string}}
 */
export function passwordFrom(fields, format = null) {
  if (!fields.protect) return { password: null };
  if (format && !canProtect(format)) return { password: null };
  if (!fields.password) return { error: 'Type a password, or untick “Protect with a password”.' };
  if (fields.password !== fields.passwordAgain) return { error: 'The two passwords are not the same.' };
  return { password: fields.password };
}
