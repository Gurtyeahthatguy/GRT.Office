/** Interface preferences, and nothing else. */

import { isTheme, applyTheme } from './core/theme.js';
import { readSettings, writeSettings } from './io.js';
import { autocorrectSettings } from './core/autocorrect-ui.js';

export const DEFAULTS = {
  theme: 'system',
  root: null,
  // An Obsidian vault open in place of the archive, or null.
  vault: null,
  collapsed: [],
  showBacklinks: true,
  quickNoteNotebook: 'Inbox',
  // Notes marked to find again quickly, by path.
  bookmarks: [],
  // The notebooks whose notes keep earlier versions; none unless asked.
  historyNotebooks: [],
  // AutoCorrect, off while typing until asked for: a vault's Markdown is kept as typed.
  autocorrect: null,
  // Spelling as you type with GRT's own dictionaries, grammar with it, and the language of text that names none.
  spelling: { auto: true, grammar: false, language: /^it\b/i.test(globalThis.navigator?.language ?? '') ? 'it-IT' : 'en-US' },
};

export function normalise(raw = {}) {
  const settings = { ...DEFAULTS };

  if (isTheme(raw.theme)) settings.theme = raw.theme;
  if (typeof raw.root === 'string' && raw.root) settings.root = raw.root;
  if (typeof raw.vault === 'string' && raw.vault) settings.vault = raw.vault;
  if (Array.isArray(raw.collapsed)) {
    settings.collapsed = raw.collapsed.filter((p) => typeof p === 'string');
  }
  if (typeof raw.showBacklinks === 'boolean') settings.showBacklinks = raw.showBacklinks;
  if (typeof raw.quickNoteNotebook === 'string' && raw.quickNoteNotebook) {
    settings.quickNoteNotebook = raw.quickNoteNotebook;
  }

  const autocorrect = autocorrectSettings(raw.autocorrect);
  if (!raw.autocorrect?.options || typeof raw.autocorrect.options.whileTyping !== 'boolean') autocorrect.options.whileTyping = false;
  settings.autocorrect = autocorrect;
  const spelling = raw.spelling && typeof raw.spelling === 'object' ? raw.spelling : {};
  settings.spelling = {
    auto: typeof spelling.auto === 'boolean' ? spelling.auto : DEFAULTS.spelling.auto,
    grammar: typeof spelling.grammar === 'boolean' ? spelling.grammar : DEFAULTS.spelling.grammar,
    language: /^(it|en)-[A-Z]{2}$/.test(spelling.language ?? '') ? spelling.language : DEFAULTS.spelling.language,
  };

  for (const key of ['bookmarks', 'historyNotebooks']) {
    if (Array.isArray(raw[key])) settings[key] = [...new Set(raw[key].filter((p) => typeof p === 'string' && p))].slice(0, 1000);
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
