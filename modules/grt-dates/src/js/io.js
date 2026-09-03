/** The only bridge between the interface and the filesystem. */

import { parse, serialise } from './ical.js';

const { invoke } = window.__TAURI__.core;

export const FILTERS = {
  ics: [{ name: 'Calendar', extensions: ['ics', 'ical', 'ifb'] }],
};

function toPath(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return toPath(result[0]);
  if (typeof result === 'object' && typeof result.path === 'string') return result.path;
  return null;
}

export async function pickToOpen(title = 'Open calendar') {
  return toPath(await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: false, filters: FILTERS.ics },
  }));
}

export async function pickToSave(defaultPath, title = 'Save calendar') {
  return toPath(await invoke('plugin:dialog|save', {
    options: { title, defaultPath, filters: FILTERS.ics },
  }));
}

export async function pickDirectory(title = 'Choose calendar folder') {
  return toPath(await invoke('plugin:dialog|open', {
    options: { title, multiple: false, directory: true },
  }));
}

export async function confirm(message, title = 'GRT Dates') {
  try {
    return await invoke('plugin:dialog|ask', {
      options: { message, title, kind: 'warning' },
    });
  } catch {
    return false;
  }
}

export async function notify(message, title = 'GRT Dates') {
  try {
    await invoke('plugin:dialog|message', { options: { message, title } });
  } catch {
    // A dialog that will not open must not stop the program.
  }
}

// Calendars

export async function listCalendars(directory = null) {
  return invoke('list_calendars', { directory });
}

/** Reads and parses one calendar file. */
export async function readCalendar(path) {
  const bytes = new Uint8Array(await invoke('read_file', { path }));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return parse(text);
}

/** Writes a calendar back, whole. */
export async function writeCalendar(path, calendar) {
  const text = serialise({ name: calendar.name, entries: calendar.entries });
  await invoke('write_file_atomic', new TextEncoder().encode(text), {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

export async function removeCalendarFile(path) {
  return invoke('remove_calendar', { path });
}

export async function fileExists(path) {
  return invoke('file_exists', { path });
}

// Settings and startup

export async function runtimeInfo() {
  try {
    return await invoke('runtime_info');
  } catch {
    return { ephemeral: false, version: '0.0.0', defaultDirectory: null };
  }
}

export async function readSettings() {
  try {
    return await invoke('read_settings');
  } catch {
    return {};
  }
}

export async function writeSettings(settings) {
  try {
    return await invoke('write_settings', { settings });
  } catch {
    return false;
  }
}

export async function forgetSettings() {
  try {
    await invoke('forget_settings');
    return true;
  } catch {
    return false;
  }
}
