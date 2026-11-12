/** AutoCorrect and AutoText for the programs that use the shared editor: the options, the replacement table, applying it to written text. */

import { showPanel, showChoice, readFields, escapeHtml } from './panel.js';
import {
  DEFAULT_REPLACEMENTS, cleanOptions, cleanTable, correctText, editsBetween, applyEdits,
} from './autocorrect.js';
import { diffRuns } from './editor/compare.js';
import { freshId } from './editor/review.js';
import { normaliseRuns, runsText, OBJECT } from './editor/model.js';
import { blocksInRange } from './editor/commands.js';
import { isCollapsed, containersInRange } from './editor/selection.js';

/** What a settings file holds for AutoCorrect, made safe, with the defaults for what it lacks. */
export function autocorrectSettings(stored) {
  return {
    options: cleanOptions(stored?.options),
    table: Array.isArray(stored?.table) ? cleanTable(stored.table) : DEFAULT_REPLACEMENTS.map((pair) => [...pair]),
  };
}

export const AUTOTEXT_LIMITS = { entries: 500, name: 80, text: 20_000 };

/** AutoText entries from a settings file: a name, a short form and plain text. */
export function cleanAutoText(list) {
  const out = [];
  const shorts = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const name = String(entry?.name ?? '').trim().slice(0, AUTOTEXT_LIMITS.name);
    const short = String(entry?.short ?? '').trim().replace(/\s+/g, '').slice(0, 20);
    const text = String(entry?.text ?? '').slice(0, AUTOTEXT_LIMITS.text);
    if (!name || !text || (short && shorts.has(short.toLowerCase()))) continue;
    if (short) shorts.add(short.toLowerCase());
    out.push({ name, short, text });
    if (out.length >= AUTOTEXT_LIMITS.entries) break;
  }
  return out;
}

const OPTION_LABELS = [
  ['whileTyping', 'Correct while typing'],
  ['replace', 'Use the replacement table'],
  ['quotes', 'Replace straight quotes with typographic ones'],
  ['capitalise', 'Capitalise the first letter of every sentence'],
  ['twoCapitals', 'Correct TWo INitial CApitals'],
  ['dashes', 'Replace dashes'],
  ['doubleSpaces', 'Ignore double spaces'],
];

const tableText = (table) => table.map(([from, to]) => `${from} = ${to}`).join('\n');

/** The table as typed, one "from = to" a line; the first " = " parts them, so "<= = ≤" works. */
export function parseTableText(text) {
  const pairs = [];
  for (const line of String(text).split('\n')) {
    const at = line.indexOf(' = ');
    if (at <= 0) continue;
    pairs.push([line.slice(0, at), line.slice(at + 3)]);
  }
  return cleanTable(pairs);
}

/** The AutoCorrect Options dialog; the new settings, or null when cancelled. */
export async function autocorrectOptions(current) {
  const confirmed = await showPanel('AutoCorrect Options', `
    ${OPTION_LABELS.map(([key, label]) => `<label class="inline"><input type="checkbox" data-field="${key}"${current.options[key] ? ' checked' : ''}> ${escapeHtml(label)}</label>`).join('')}
    <label>Replace, one a line as <code>what = with</code>
      <textarea data-field="table" rows="10" spellcheck="false" style="width: 100%; box-sizing: border-box; font-family: monospace">${escapeHtml(tableText(current.table))}</textarea></label>
    <p class="hint">An entry of letters or digits is replaced when it stands as a word; one of signs alone, such as <code>...</code>, also after a word.
      <button type="button" data-ac-reset>Restore the Default Table</button></p>`, 'OK');
  if (!confirmed) return null;
  const fields = readFields();
  const options = {};
  for (const [key] of OPTION_LABELS) options[key] = !!fields[key];
  return { options: cleanOptions(options), table: parseTableText(fields.table ?? '') };
}

// The reset button works while the dialog is open.
globalThis.document?.addEventListener('click', (event) => {
  if (!event.target.closest?.('[data-ac-reset]')) return;
  const area = document.querySelector('#panel-body [data-field="table"]');
  if (area) area.value = tableText(DEFAULT_REPLACEMENTS);
});

/** Every piece of text in the blocks given, each with the way to put it back. */
function* textHolders(blocks) {
  for (const block of blocks) {
    if (block.kind === 'code' || block.kind === 'raw') continue;
    if (block.kind === 'list') for (const item of block.items ?? []) yield item;
    else if (block.kind === 'table') for (const row of block.rows ?? []) for (const cell of row.cells ?? []) { if (!cell.covered) yield cell; }
    else if (Array.isArray(block.runs)) yield block;
  }
}

/**
 * AutoCorrect over written text: the selection's paragraphs, or the whole document.
 * With `track`, the corrections are recorded as changes to accept or reject.
 * @returns {{changed: number, skipped: number}}
 */
export function applyToDocument(model, selection, settings, { track = false } = {}) {
  const ids = selection && !isCollapsed(selection) ? new Set(blocksInRange(model, selection)) : null;
  const blocks = ids ? model.blocks.filter((b) => ids.has(b.id)) : model.blocks;
  const changeIds = track ? { ins: freshId('i'), del: freshId('d') } : null;
  let changed = 0;
  let skipped = 0;
  for (const holder of textHolders(blocks)) {
    const runs = holder.runs ?? [];
    // Text with changes not yet settled is left alone, so no change is made over another.
    if (runs.some((r) => r.del || r.ins || r.code || r.math)) { skipped += 1; continue; }
    const old = runsText(runs);
    const next = correctText(old, settings.options, settings.table);
    if (next === old) continue;
    const corrected = normaliseRuns(applyEdits(runs, editsBetween(old, next)));
    holder.runs = track ? diffRuns(runs, corrected, changeIds) : corrected;
    changed += 1;
  }
  if (changed) model.dirty = true;
  return { changed, skipped };
}

/**
 * The AutoText dialog: insert an entry, add the selected text as one, or delete one.
 * @param {{entries: Object[], selectedText: string}} state
 * @returns {Promise<?{insert?: Object, entries?: Object[]}>}
 */
export async function autoTextDialog({ entries, selectedText }) {
  const list = entries.length
    ? `<label>Find<input data-at-filter placeholder="Part of a name or short form"></label>
       <div class="template-list" role="radiogroup" aria-label="AutoText">${entries.map((entry, i) => `<label class="inline" data-at-name="${escapeHtml(`${entry.name} ${entry.short}`.toLowerCase())}">
         <input type="radio" name="autotext" value="${i}"${i === 0 ? ' checked' : ''}> ${escapeHtml(entry.name)}${entry.short ? ` <code>${escapeHtml(entry.short)}</code>` : ''}
         <span class="hint">${escapeHtml(entry.text.slice(0, 80))}</span></label>`).join('')}</div>`
    : '<p>No AutoText yet.</p>';
  const adding = selectedText.trim()
    ? `<fieldset><legend>New from the selection</legend>
         <label>Name<input data-field="name" maxlength="${AUTOTEXT_LIMITS.name}"></label>
         <label>Short form<input data-field="short" maxlength="20" placeholder="Typed, then F3"></label></fieldset>`
    : '<p class="hint">Select text to keep it as AutoText.</p>';
  const choices = [{ id: 'close', label: 'Close' }];
  if (selectedText.trim()) choices.unshift({ id: 'add', label: 'Add' });
  if (entries.length) choices.unshift({ id: 'delete', label: 'Delete' }, { id: 'insert', label: 'Insert', primary: true });
  const answer = showChoice('AutoText', `${list}${adding}
    <p class="hint">AutoText keeps the words, not their formatting. Type a short form and press F3 to put its text there.</p>`, choices);
  const panel = document.getElementById('panel-body');
  const filter = panel.querySelector('[data-at-filter]');
  filter?.addEventListener('input', () => {
    const text = filter.value.trim().toLowerCase();
    for (const row of panel.querySelectorAll('[data-at-name]')) row.hidden = Boolean(text) && !row.dataset.atName.includes(text);
  });
  const picked = () => {
    const radio = panel.querySelector('input[name="autotext"]:checked');
    return radio && !radio.closest('label').hidden ? Number(radio.value) : null;
  };
  const result = await answer;
  if (result === 'insert' && picked() !== null) return { insert: entries[picked()] };
  if (result === 'delete' && picked() !== null) return { entries: entries.filter((_, i) => i !== picked()) };
  if (result === 'add') {
    const fields = readFields();
    const name = String(fields.name ?? '').trim() || selectedText.trim().slice(0, 40);
    const next = cleanAutoText([...entries, { name, short: fields.short, text: selectedText }]);
    return { entries: next, added: next.length > entries.length };
  }
  return null;
}

/** The words of a selection, a line for each paragraph or cell it touches; objects such as note marks are left out. */
export function selectedText(model, selection) {
  if (!selection || isCollapsed(selection)) return '';
  return containersInRange(selection, model)
    .map((part) => runsText(model.runsOf(part.blockId, part.itemIndex)).slice(part.from, part.to).replaceAll(OBJECT, ''))
    .join('\n')
    .slice(0, AUTOTEXT_LIMITS.text);
}

/** The AutoText whose short form ends the text before the caret, if any. */
export function autoTextBefore(before, entries) {
  const word = /(\S+)$/u.exec(before)?.[1];
  if (!word) return null;
  return entries.find((entry) => entry.short && entry.short.toLowerCase() === word.toLowerCase()) ?? null;
}
