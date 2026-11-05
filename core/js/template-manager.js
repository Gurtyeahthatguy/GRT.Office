/** The templates in Documents/Templates, grouped by subfolder and found by typing; one opens as a new document. */

import { showChoice, escapeHtml } from './panel.js';

const { invoke } = window.__TAURI__?.core ?? {};

const when = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleDateString() : '');

/**
 * @param {{extensions: string[], open: (path: string) => any, toast?: (text: string) => void}} options
 *   `open` is the program's own opening, which starts a template as a new document
 */
export async function templateManager({ extensions, open, toast = () => {} }) {
  let listing;
  try {
    listing = await invoke('list_templates', { extensions });
  } catch (error) {
    toast(`Cannot read the templates folder: ${error}`);
    return;
  }
  const { folder, items } = listing;
  const groups = new Map();
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  let index = 0;
  const body = items.length === 0
    ? `<p>No templates yet in <code>${escapeHtml(folder)}</code>.</p>
       <p class="hint">Save a document as a template into that folder, or into a folder inside it for a category, and it shows here.</p>`
    : `<label>Find<input data-template-filter placeholder="Part of a name"></label>
       <div class="template-list" role="radiogroup" aria-label="Templates">
       ${[...groups].map(([category, list]) => `<fieldset><legend>${escapeHtml(category || 'Templates')}</legend>
         ${list.map((item) => `<label class="inline" data-template-name="${escapeHtml(item.name.toLowerCase())}">
           <input type="radio" name="template" value="${index++}"${index === 1 ? ' checked' : ''}>
           ${escapeHtml(item.name.replace(/\.[^.]+$/, ''))} <span class="hint">${escapeHtml(when(item.modified))}</span></label>`).join('')}
       </fieldset>`).join('')}
       </div>
       <p class="hint">From <code>${escapeHtml(folder)}</code>. A template opens as a new document; it is not changed.</p>`;
  const choices = items.length === 0
    ? [{ id: 'folder', label: 'Make the folder', primary: true }, { id: 'close', label: 'Close' }]
    : [{ id: 'open', label: 'Open', primary: true }, { id: 'close', label: 'Close' }];
  const answer = showChoice('Templates', body, choices);

  const panel = document.getElementById('panel-body');
  const filter = panel.querySelector('[data-template-filter]');
  filter?.addEventListener('input', () => {
    const text = filter.value.trim().toLowerCase();
    for (const row of panel.querySelectorAll('[data-template-name]')) row.hidden = Boolean(text) && !row.dataset.templateName.includes(text);
    for (const set of panel.querySelectorAll('.template-list fieldset')) set.hidden = ![...set.querySelectorAll('[data-template-name]')].some((r) => !r.hidden);
  });
  filter?.focus();
  // A double click opens at once.
  let chosenByDoubleClick = null;
  panel.querySelector('.template-list')?.addEventListener('dblclick', (event) => {
    const radio = event.target.closest('label')?.querySelector('input[type="radio"]');
    if (!radio) return;
    chosenByDoubleClick = Number(radio.value);
    document.querySelector('[data-choice="open"]')?.click();
  });
  // The panel keeps its form after it closes, so the choice is read then.
  const picked = () => {
    if (chosenByDoubleClick !== null) return chosenByDoubleClick;
    const radio = panel.querySelector('input[name="template"]:checked');
    return radio && !radio.closest('label').hidden ? Number(radio.value) : null;
  };

  const result = await answer;
  if (result === 'folder') {
    try {
      const made = await invoke('templates_folder');
      toast(`Templates go in ${made}`);
    } catch (error) {
      toast(String(error));
    }
    return;
  }
  if (result !== 'open') return;
  const item = items[picked() ?? -1];
  if (item) await open(item.path);
}
