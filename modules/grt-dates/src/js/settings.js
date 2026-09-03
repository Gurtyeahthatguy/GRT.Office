/** Interface preferences, and nothing else. */

import { isTheme, applyTheme } from './core/theme.js';
import { readSettings, writeSettings } from './io.js';

export const DEFAULTS = {
  theme: 'system',
  view: 'month',
  weekStart: 1,
  directory: null,
  hiddenCalendars: [],
  showCompletedTasks: true,
};

const VIEWS = ['month', 'week', 'day', 'agenda'];

export function normalise(raw = {}) {
  const settings = { ...DEFAULTS };

  if (isTheme(raw.theme)) settings.theme = raw.theme;
  if (VIEWS.includes(raw.view)) settings.view = raw.view;
  if (raw.weekStart === 0 || raw.weekStart === 1) settings.weekStart = raw.weekStart;
  if (typeof raw.directory === 'string' && raw.directory) settings.directory = raw.directory;
  if (Array.isArray(raw.hiddenCalendars)) {
    settings.hiddenCalendars = raw.hiddenCalendars.filter((n) => typeof n === 'string');
  }
  if (typeof raw.showCompletedTasks === 'boolean') {
    settings.showCompletedTasks = raw.showCompletedTasks;
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
