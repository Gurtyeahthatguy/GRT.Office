/** The suite's palettes. */

export const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'gold', label: 'Gold' },
  { id: 'purple', label: 'Purple' },
];

export const THEME_IDS = THEMES.map((theme) => theme.id);

export function isTheme(value) {
  return THEME_IDS.includes(value);
}

export function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
