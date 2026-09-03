import { isTheme, applyTheme } from './core/theme.js';
/** Interface preferences. */

/** Reached lazily rather than destructured at module load. */
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

// Themes are the suite's, not this module's: see core/js/theme.js.
export { THEMES, applyTheme } from './core/theme.js';

export const DEFAULTS = {
  theme: 'system',          // one of THEME_IDS.
  showThumbnails: true,
  openZoom: 'fit',          // 'fit' | 'actual'.
  fingerprintBeforeSave: true,
};

let current = { ...DEFAULTS };
let persistable = true;

/** Values currently in effect. */
export function settings() {
  return current;
}

/** False when ephemeral mode is refusing to store anything. */
export function canPersist() {
  return persistable;
}

/** Loads stored preferences over the defaults. */
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
    if (value === undefined) continue;
    if (typeof value !== typeof DEFAULTS[key]) continue;
    current[key] = value;
  }

  if (!isTheme(current.theme)) {
    current.theme = DEFAULTS.theme;
  }
  if (!['fit', 'actual'].includes(current.openZoom)) {
    current.openZoom = DEFAULTS.openZoom;
  }

  applyTheme(current.theme);
  return current;
}

/**
 * Applies a change and stores it.
 * @returns {Promise<boolean>} false if the write was refused
 */
export async function updateSettings(patch) {
  current = { ...current, ...patch };
  if (patch.theme !== undefined) applyTheme(current.theme);

  try {
    return await invoke('write_settings', { settings: current });
  } catch {
    return false;
  }
}

/** Removes the stored file and returns to first-run defaults. */
export async function forgetSettings() {
  try {
    await invoke('forget_settings');
  } catch {
    // Nothing stored, or nothing removable: the outcome is the same.
  }
  current = { ...DEFAULTS };
  applyTheme(current.theme);
}
