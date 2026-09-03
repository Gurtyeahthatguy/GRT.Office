/** Interface preferences. */

import { isTheme, applyTheme } from './core/theme.js';

export { THEMES, applyTheme } from './core/theme.js';

const invoke = (...args) => window.__TAURI__.core.invoke(...args);

export const DEFAULTS = {
  theme: 'system',
  snapToGrid: true,
  showNotes: true,
  autoShrinkText: false,
};

let current = { ...DEFAULTS };
let persistable = true;

export function settings() { return current; }
export function canPersist() { return persistable; }

export async function loadSettings(ephemeral) {
  persistable = !ephemeral;

  let stored = {};
  try {
    stored = (await invoke('read_settings')) ?? {};
  } catch {
    stored = {};
  }

  current = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = stored[key];
    if (value === undefined || typeof value !== typeof DEFAULTS[key]) continue;
    current[key] = value;
  }
  if (!isTheme(current.theme)) current.theme = DEFAULTS.theme;

  applyTheme(current.theme);
  return current;
}

export async function updateSettings(patch) {
  current = { ...current, ...patch };
  if (patch.theme !== undefined) applyTheme(current.theme);
  try {
    return await invoke('write_settings', { settings: current });
  } catch {
    return false;
  }
}
