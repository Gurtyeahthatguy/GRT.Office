/** Interface preferences, and nothing else. */

import { isTheme, applyTheme } from './core/theme.js';
import { readSettings, writeSettings } from './io.js';

export const DEFAULTS = {
  theme: 'system',
  root: null,
  collapsed: [],
  showBacklinks: true,
  quickNoteNotebook: 'Inbox',
};

export function normalise(raw = {}) {
  const settings = { ...DEFAULTS };

  if (isTheme(raw.theme)) settings.theme = raw.theme;
  if (typeof raw.root === 'string' && raw.root) settings.root = raw.root;
  if (Array.isArray(raw.collapsed)) {
    settings.collapsed = raw.collapsed.filter((p) => typeof p === 'string');
  }
  if (typeof raw.showBacklinks === 'boolean') settings.showBacklinks = raw.showBacklinks;
  if (typeof raw.quickNoteNotebook === 'string' && raw.quickNoteNotebook) {
    settings.quickNoteNotebook = raw.quickNoteNotebook;
  }

  return settings;
}

export async function load() {
  const settings = normalise(await readSettings());
  applyTheme(settings.theme);
  return settings;
}

export async function save(settings) {
  return writeSettings(normalise(settings));
}
