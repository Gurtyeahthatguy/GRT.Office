/** Tools › Language: Chinese between simplified and traditional characters, and Korean between Hangul and Hanja. */

import { showPanel, showChoice, readFields, escapeHtml } from './panel.js';
import { editsBetween, applyEdits } from './autocorrect.js';
import { normaliseRuns, runsText, itemIndices, OBJECT } from './editor/model.js';
import { blocksInRange } from './editor/commands.js';
import { isCollapsed } from './editor/selection.js';

const { invoke } = window.__TAURI__?.core ?? {};

/** The conversions offered, as OpenCC names its locales. */
export const CHINESE = [
  ['cn:t', 'Simplified to traditional'],
  ['cn:tw', 'Simplified to traditional, Taiwan characters'],
  ['cn:twp', 'Simplified to traditional, Taiwan characters and common terms'],
  ['cn:hk', 'Simplified to traditional, Hong Kong characters'],
  ['t:cn', 'Traditional to simplified'],
  ['tw:cn', 'Traditional (Taiwan) to simplified'],
  ['twp:cn', 'Traditional (Taiwan) to simplified, with common terms'],
  ['hk:cn', 'Traditional (Hong Kong) to simplified'],
];

let opencc = null;
async function converterFor(code) {
  opencc ??= (await import('../../vendor/opencc-full.js')).default;
  const [from, to] = code.split(':');
  return opencc.Converter({ from, to });
}

/** Every container of text the selection touches, or all of them, skipping code. */
function* containersOf(model, selection) {
  const ids = selection && !isCollapsed(selection) ? new Set(blocksInRange(model, selection)) : null;
  for (const block of model.blocks) {
    if ((ids && !ids.has(block.id)) || ['code', 'raw', 'toc', 'index', 'image', 'chart'].includes(block.kind)) continue;
    for (const itemIndex of itemIndices(block)) yield { blockId: block.id, itemIndex, runs: model.runsOf(block.id, itemIndex) ?? [] };
  }
}

/** Text changed piece by piece, each run keeping its look; objects and text with changes not settled stay as they are. */
export function convertRuns(runs, convert) {
  if (runs.some((r) => r.ins || r.del)) return null;
  const old = runsText(runs);
  // Objects are kept apart so the conversion cannot move them.
  const next = old.split(OBJECT).map(convert).join(OBJECT);
  if (next === old) return null;
  return normaliseRuns(applyEdits(runs, editsBetween(old, next)));
}

/** Chinese conversion over the selection or the whole text, as one step Ctrl+Z takes back. */
export async function chineseConversion({ editor, model, toast }) {
  const confirmed = await showPanel('Chinese Conversion', `
    <label>Conversion<select data-field="code">${CHINESE.map(([code, name]) => `<option value="${code}">${escapeHtml(name)}</option>`).join('')}</select></label>
    <p class="hint">${editor.selection && !isCollapsed(editor.selection) ? 'The selected paragraphs are converted.' : 'All the text is converted.'} The tables are OpenCC's, inside the program.</p>`, 'OK');
  if (!confirmed) return;
  const convert = await converterFor(readFields().code);
  let changed = 0;
  editor.edit(() => {
    for (const c of [...containersOf(model(), editor.selection)]) {
      const runs = convertRuns(c.runs, convert);
      if (!runs) continue;
      model().setRuns(c.blockId, runs, c.itemIndex);
      changed += 1;
    }
    return editor.selection;
  }, { read: false });
  toast(changed ? `${changed} paragraph(s) converted` : 'Nothing to convert');
}

const FORMATS = [
  ['plain', 'Only the new script'],
  ['after', 'The word, then the new script in brackets'],
  ['before', 'The new script, then the word in brackets'],
];

/** How a converted word is written, by the format chosen. */
export function written(word, choice, format) {
  if (format === 'after') return `${word}(${choice})`;
  if (format === 'before') return `${choice}(${word})`;
  return choice;
}

/** Hangul/Hanja conversion: each word the list knows, one at a time, with the ways it may be written. */
export async function hangulHanjaConversion({ editor, model, toast }) {
  const confirmed = await showPanel('Hangul/Hanja Conversion', `
    <label>Direction<select data-field="direction"><option value="hanja">Hangul to Hanja</option><option value="hangul">Hanja to Hangul</option></select></label>
    <label>Write it as<select data-field="format">${FORMATS.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('')}</select></label>`, 'Start');
  if (!confirmed) return;
  const { direction, format } = readFields();
  const toHanja = direction === 'hanja';
  const skipped = new Set();
  const always = new Map();
  let done = 0;
  for (const c of [...containersOf(model(), editor.selection)]) {
    // The words are found again after each change, since a change moves the ones after it.
    for (let guard = 0; guard < 2000; guard += 1) {
      const runs = model().runsOf(c.blockId, c.itemIndex) ?? [];
      if (runs.some((r) => r.ins || r.del)) break;
      const text = runsText(runs);
      const words = (await invoke('hanja_words', { text, toHanja }).catch(() => [])).filter((w) => w.choices.length && !skipped.has(`${w.from}:${w.word}`));
      const word = words[0];
      if (!word) break;
      let choice = always.get(word.word);
      if (choice === undefined) {
        const answer = showChoice('Hangul/Hanja Conversion', `
          <p class="spelling-context">${escapeHtml(text.slice(Math.max(0, word.from - 30), word.from))}<mark>${escapeHtml(word.word)}</mark>${escapeHtml(text.slice(word.to, word.to + 30))}</p>
          <div class="template-list" role="radiogroup" aria-label="Ways to write it">${word.choices.map((x, i) => `<label class="inline"><input type="radio" name="hanja" value="${i}"${i === 0 ? ' checked' : ''}> ${escapeHtml(x.text)} <span class="hint">${escapeHtml(x.meaning)}</span></label>`).join('')}</div>`,
        [{ id: 'close', label: 'Close' }, { id: 'ignore', label: 'Ignore' }, { id: 'all', label: 'Replace All' }, { id: 'replace', label: 'Replace', primary: true }]);
        const panel = document.getElementById('panel-body');
        const result = await answer;
        const picked = word.choices[Number(panel.querySelector('input[name="hanja"]:checked')?.value ?? 0)]?.text;
        if (result === 'close' || result === null) { toast(done ? `${done} word(s) converted` : 'Nothing converted'); return; }
        if (result === 'ignore' || !picked) { skipped.add(`${word.from}:${word.word}`); continue; }
        choice = picked;
        if (result === 'all') always.set(word.word, picked);
      }
      const next = text.slice(0, word.from) + written(word.word, choice, format) + text.slice(word.to);
      editor.edit(() => {
        model().setRuns(c.blockId, normaliseRuns(applyEdits(runs, editsBetween(text, next))), c.itemIndex);
        return editor.selection;
      }, { read: false });
      done += 1;
      // The word kept in brackets is not looked at again.
      if (format !== 'plain') for (let i = word.from; i < word.from + written(word.word, choice, format).length; i += 1) skipped.add(`${i}:${word.word}`);
    }
  }
  toast(done ? `${done} word(s) converted` : 'No word to convert');
}
