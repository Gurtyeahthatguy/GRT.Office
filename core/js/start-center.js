/** The Start Center: a new document, one opened, or one from the templates of this computer, as LibreOffice's begins. */

import { showChoice, escapeHtml } from './panel.js';

const invoke = (...args) => window.__TAURI__.core.invoke(...args);

/**
 * @param {{kind: string, extensions: string[], newDocument: Function, openFile: Function, open: (path: string) => any, templates: Function}} options
 *   `open` starts a template as a new document, `templates` shows the Template Manager
 */
export async function startCenter({ kind, extensions, newDocument, openFile, open, templates }) {
  let items = [];
  try { items = (await invoke('list_templates', { extensions })).items ?? []; } catch { items = []; }
  const shown = items.slice(0, 12);
  let chosen = null;
  const body = `<p class="fp-note" style="margin-top:0">Begin a new ${escapeHtml(kind)}, open one, or start from a template on this computer.</p>
    ${shown.length ? `<div class="start-templates" role="list">${shown.map((item, i) => `<button type="button" role="listitem" class="start-template" data-start-template="${i}">
      <span class="start-template-name">${escapeHtml(item.name.replace(/\.[^.]+$/, ''))}</span>${item.category ? `<span class="hint">${escapeHtml(item.category)}</span>` : ''}</button>`).join('')}</div>`
      : '<p class="hint">No templates yet: a document saved as a template into Documents/Templates shows here.</p>'}`;
  const answer = showChoice('Start Center', body, [
    { id: 'new', label: `New ${kind}`, primary: true },
    { id: 'open', label: 'Open…' },
    { id: 'templates', label: 'Templates…' },
    { id: 'close', label: 'Close' },
  ]);
  document.getElementById('panel-body').addEventListener('click', (event) => {
    const card = event.target.closest('[data-start-template]');
    if (!card) return;
    chosen = shown[Number(card.dataset.startTemplate)];
    document.querySelector('[data-choice="close"]')?.click();
  });
  const result = await answer;
  if (chosen) return open(chosen.path);
  if (result === 'new') return newDocument();
  if (result === 'open') return openFile();
  if (result === 'templates') return templates();
  return null;
}
