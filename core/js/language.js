/** Tools › Language: which language a stretch of text is in, for the spelling, hyphenation and quotes that follow it. */

import { showPanel, readFields, escapeHtml } from './panel.js';
import { applyFormat } from './editor/commands.js';
import { point, isCollapsed, containersInRange } from './editor/selection.js';
import { runsLength, itemIndices } from './editor/model.js';

/** The languages offered by name; any other tag a file carries is kept as it is. */
export const LANGUAGES = [
  ['it-IT', 'Italian (Italy)'], ['it-CH', 'Italian (Switzerland)'], ['en-US', 'English (USA)'], ['en-GB', 'English (UK)'],
  ['fr-FR', 'French (France)'], ['de-DE', 'German (Germany)'], ['es-ES', 'Spanish (Spain)'], ['pt-PT', 'Portuguese (Portugal)'],
  ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch'], ['ca-ES', 'Catalan'], ['ro-RO', 'Romanian'], ['pl-PL', 'Polish'],
  ['sv-SE', 'Swedish'], ['el-GR', 'Greek'], ['ru-RU', 'Russian'], ['la', 'Latin'], ['zh-CN', 'Chinese (simplified)'],
  ['zh-TW', 'Chinese (traditional)'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'],
];

export const NAMES = new Map([...LANGUAGES, ['zxx', 'None (Do not check spelling)']]);

/** The selection made to cover what `scope` names: the selection itself, its paragraphs, or all the text. */
export function scopeSelection(model, selection, scope) {
  if (scope === 'selection') return selection;
  const blocks = model.blocks;
  if (blocks.length === 0) return null;
  const endOf = (block) => {
    const index = itemIndices(block).at(-1);
    return point(block.id, runsLength(model.runsOf(block.id, index) ?? []), index);
  };
  if (scope === 'all') return { anchor: point(blocks[0].id, 0, itemIndices(blocks[0])[0]), focus: endOf(blocks.at(-1)) };
  if (!selection) return null;
  const parts = containersInRange(selection, model);
  if (parts.length === 0) return null;
  const first = parts[0];
  const last = parts.at(-1);
  const lastRuns = model.runsOf(last.blockId, last.itemIndex) ?? [];
  return { anchor: point(first.blockId, 0, first.itemIndex), focus: point(last.blockId, runsLength(lastRuns), last.itemIndex) };
}

/** Marks the text `scope` names as being in a language, or as not to be checked, or takes the mark away. */
export function setLanguage(model, selection, scope, lang) {
  const range = scopeSelection(model, selection, scope);
  if (!range || isCollapsed(range)) return false;
  applyFormat(model, range, 'lang', lang || '');
  return true;
}

/** The dialog that asks which language; the tag, '' for the program's default, or null when cancelled. */
export async function askLanguage(scope, current = '') {
  const what = { selection: 'the selected text', paragraph: 'this paragraph', all: 'all the text' }[scope] ?? 'the text';
  const known = NAMES.has(current) || !current ? '' : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`;
  const confirmed = await showPanel('Language', `
    <label>Language of ${escapeHtml(what)}<select data-field="lang">
      ${known}
      ${LANGUAGES.map(([tag, name]) => `<option value="${tag}"${tag === current ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
      <option value="zxx"${current === 'zxx' ? ' selected' : ''}>None (Do not check spelling)</option>
      <option value=""${current === '' ? ' selected' : ''}>Reset to Default Language</option>
    </select></label>
    <p class="hint">The language goes into the file, so LibreOffice and Word check the text the same way.</p>`, 'OK');
  if (!confirmed) return null;
  return String(readFields().lang ?? '');
}
