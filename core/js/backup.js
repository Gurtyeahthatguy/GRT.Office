/** Encrypted backups, as every program that keeps a folder of its own offers them: the folder sealed into one file, and back. */

import { showPanel, readFields, escapeHtml } from './panel.js';

const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const FILTERS = [{ name: 'GRT backup', extensions: ['grtbackup'] }];
const MIN_LENGTH = 8;

const toPath = (result) => (Array.isArray(result) ? toPath(result[0]) : typeof result === 'string' ? result : result?.path ?? null);
const today = () => new Date().toISOString().slice(0, 10);

/** The password twice, until both agree and it is long enough. */
async function askPassword(title, intro, twice) {
  let problem = '';
  for (;;) {
    const ok = await showPanel(title, `<p class="fp-note" style="margin-top:0">${intro}</p>
      <label>Password<input type="password" data-field="password" autocomplete="new-password"></label>
      ${twice ? '<label>Again<input type="password" data-field="again" autocomplete="new-password"></label>' : ''}
      ${problem ? `<p class="problem">${escapeHtml(problem)}</p>` : ''}`, twice ? 'Back up' : 'Restore');
    if (!ok) return null;
    const { password, again } = readFields();
    if (twice && (password ?? '').length < MIN_LENGTH) problem = `The password needs at least ${MIN_LENGTH} characters`;
    else if (twice && password !== again) problem = 'The two passwords are not the same';
    else if (!password) problem = 'The password is needed';
    else return password;
  }
}

const sizeText = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Seals a folder into a backup file wherever the person puts it, such as a disk of their own.
 * @param {{folder: string, what: string, name: string, toast: (text: string) => void}} options
 */
export async function backUp({ folder, what, name, toast }) {
  if (!folder) { toast('There is no folder to back up'); return; }
  const password = await askPassword(`Back up ${what}`, `Everything in ${escapeHtml(what)} is sealed into one file with this
    password, and cannot be read without it: keep it somewhere safe. Nothing goes over the network.`, true);
  if (!password) return;
  const target = toPath(await invoke('plugin:dialog|save', { options: { title: 'Where the backup goes', defaultPath: `${name} ${today()}.grtbackup`, filters: FILTERS } }));
  if (!target) return;
  const path = /\.grtbackup$/i.test(target) ? target : `${target}.grtbackup`;
  const made = await invoke('backup_create', { source: folder, target: path, password });
  toast(`Backed up ${made.files} file(s), ${sizeText(made.size)}`);
}

/** Restores a backup into an empty folder of the person's choosing, so nothing is overwritten. */
export async function restoreBackup({ toast }) {
  const source = toPath(await invoke('plugin:dialog|open', { options: { title: 'The backup to restore', multiple: false, directory: false, filters: FILTERS } }));
  if (!source) return null;
  const target = toPath(await invoke('plugin:dialog|open', { options: { title: 'An empty folder to restore it into', multiple: false, directory: true } }));
  if (!target) return null;
  const password = await askPassword('Restore a backup', 'The password the backup was made with.', false);
  if (!password) return null;
  const done = await invoke('backup_restore', { source, target, password });
  toast(`Restored ${done.files} file(s) into ${target.split(/[\\/]/).pop()}`);
  return target;
}
