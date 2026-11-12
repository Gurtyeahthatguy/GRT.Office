/**
 * Spelling, grammar and synonyms in the shared editor: wavy lines under what is wrong, the suggestions on a right click,
 * the Spelling dialog that goes through the text, and the Thesaurus.
 */

import { showChoice, escapeHtml } from './panel.js';
import { showContextMenu } from './menubar.js';
import { grammarIssues } from './grammar.js';
import { runsText, itemIndices, OBJECT } from './editor/model.js';
import { domPositionFor, point, isCollapsed } from './editor/selection.js';
import { insertText } from './editor/commands.js';
import { trackedInsert } from './editor/review.js';

const SOFT_HYPHEN = '­';
const { invoke } = window.__TAURI__?.core ?? {};

/** Kinds of block whose text is never checked. */
const NOT_CHECKED = new Set(['code', 'raw', 'toc', 'index', 'image', 'chart']);

/** A note's mark, a formula, or text marked as no language is not checked; it reads as a space. */
function checkedText(runs, fallbackLang) {
  const stretches = [];
  let at = 0;
  for (const run of runs) {
    const lang = run.lang ?? fallbackLang;
    const skip = run.object || run.code || run.math || run.del || lang === 'zxx';
    const text = skip ? ' '.repeat(run.text.length) : run.text.replaceAll(OBJECT, ' ').replaceAll(SOFT_HYPHEN, '⁠');
    const last = stretches[stretches.length - 1];
    if (last && last.lang === lang && !skip) last.text += text;
    else stretches.push({ from: at, lang: skip ? null : lang, text });
    at += run.text.length;
  }
  return stretches;
}

/**
 * @param {{editor: Object, model: () => Object, surface: HTMLElement, checker: Object, toast: Function,
 *   language: () => string, settings: () => {auto: boolean, grammar: boolean}}} host
 */
export function createProofing(host) {
  let issues = [];
  let timer = null;
  let round = 0;
  // The document the issues were found in; another one opened is looked at afresh.
  let checked = null;
  const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  /** Every container of text: blocks, list items and table cells, in reading order. */
  function* containers() {
    for (const block of host.model().blocks) {
      if (NOT_CHECKED.has(block.kind)) continue;
      for (const itemIndex of itemIndices(block)) {
        const runs = host.model().runsOf(block.id, itemIndex) ?? [];
        yield { blockId: block.id, itemIndex, runs };
      }
    }
  }

  /** What is wrong in the whole text: words not in the dictionary, and with grammar on, the rules' finds. */
  async function find() {
    const out = [];
    const lang = host.language();
    for (const container of containers()) {
      for (const stretch of checkedText(container.runs, lang)) {
        if (!stretch.lang || !stretch.text.trim()) continue;
        const words = await host.checker.misspelled(stretch.text.replaceAll('⁠', ''), stretch.lang).catch(() => []);
        // Soft hyphens were taken out to check the words; the places are put back on the text as it is.
        const map = [];
        for (let i = 0; i < stretch.text.length; i += 1) if (stretch.text[i] !== '⁠') map.push(i);
        map.push(stretch.text.length);
        for (const w of words) {
          out.push({ ...container, kind: 'spelling', from: stretch.from + map[w.from], to: stretch.from + map[w.to], word: stretch.text.slice(map[w.from], map[w.to]).replaceAll('⁠', ''), lang: stretch.lang });
        }
        if (host.settings().grammar) {
          for (const issue of grammarIssues(stretch.text, stretch.lang)) out.push({ ...container, ...issue, kind: `grammar:${issue.kind}`, from: stretch.from + issue.from, to: stretch.from + issue.to, lang: stretch.lang, word: stretch.text.slice(issue.from, issue.to) });
        }
      }
    }
    return out;
  }

  function draw() {
    if (!supported) return;
    const spelling = new Highlight();
    const grammar = new Highlight();
    if (host.settings().auto) {
      for (const issue of issues) {
        const start = domPositionFor(host.surface, point(issue.blockId, issue.from, issue.itemIndex));
        const end = domPositionFor(host.surface, point(issue.blockId, issue.to, issue.itemIndex));
        if (!start || !end) continue;
        const range = new Range();
        try {
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
        } catch { continue; }
        (issue.kind === 'spelling' ? spelling : grammar).add(range);
      }
    }
    CSS.highlights.set('grt-spelling', spelling);
    CSS.highlights.set('grt-grammar', grammar);
  }

  /** Looks again, a moment after the text stops changing; a newer look wins over an older one. */
  function schedule(delay = 400) {
    clearTimeout(timer);
    if (!host.settings().auto) {
      issues = [];
      draw();
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++round;
      const model = host.model();
      const found = await find();
      if (mine !== round) return;
      issues = found;
      checked = model;
      draw();
    }, delay);
  }

  // The page is drawn again after edits and as pages fill; the lines are put back on the new text each time.
  let frame = 0;
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (checked !== host.model()) {
          issues = [];
          draw();
          schedule(0);
        } else draw();
      });
    }).observe(host.surface, { childList: true, subtree: true, characterData: true });
  }

  /** Replaces a stretch of a container's text, as a change of its own that Ctrl+Z takes back. */
  function replace(issue, text) {
    const { editor } = host;
    const range = { anchor: point(issue.blockId, issue.from, issue.itemIndex), focus: point(issue.blockId, issue.to, issue.itemIndex) };
    editor.typing?.end();
    editor.selection = range;
    const marks = editor.activeMarks();
    editor.edit(() => (editor.recording ? trackedInsert(host.model(), range, text, marks) : insertText(host.model(), range, text, marks)), { read: false });
  }

  const issueAt = (at) => issues.find((i) => i.blockId === at.blockId && (i.itemIndex ?? null) === (at.itemIndex ?? null) && at.offset >= i.from && at.offset <= i.to);

  /** The suggestions on a right click over a word underlined. */
  async function contextMenu(event) {
    if (!host.settings().auto) return false;
    const doc = host.surface.ownerDocument;
    const caret = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (!caret || !host.surface.contains(caret.startContainer)) return false;
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(caret);
    host.editor.readSelection();
    const at = host.editor.selection?.anchor;
    const issue = at && issueAt(at);
    if (!issue) return false;
    event.preventDefault();
    const items = [];
    if (issue.kind === 'spelling') {
      const suggestions = await host.checker.suggest(issue.word, issue.lang);
      for (const s of suggestions.slice(0, 7)) items.push({ label: s, run: () => replace(issue, s) });
      if (suggestions.length === 0) items.push({ label: '(no suggestions)', enabled: false, run: () => {} });
      items.push('separator',
        { label: 'Ignore All', run: () => { host.checker.ignore(issue.word); schedule(0); } },
        { label: 'Add to Dictionary', run: async () => { await host.checker.add(issue.word); schedule(0); } });
    } else {
      items.push({ label: issue.message, enabled: false, run: () => {} });
      if (issue.replacement !== null && issue.replacement !== undefined) items.push({ label: `Change to “${issue.replacement}”`, run: () => replace(issue, issue.replacement) });
      items.push({ label: 'Ignore', run: () => { issues = issues.filter((i) => i !== issue); draw(); } });
    }
    items.push('separator', { label: 'Spelling…', run: () => spellingDialog() });
    showContextMenu(event, items);
    return true;
  }

  /** Where the text after the caret begins, to go through issues from there and then from the top. */
  function order(list) {
    const blocks = host.model().blocks.map((b) => b.id);
    const rank = (i) => [blocks.indexOf(i.blockId), i.itemIndex ?? -1, i.from];
    const at = host.editor.selection?.anchor;
    const caret = at ? [blocks.indexOf(at.blockId), at.itemIndex ?? -1, at.offset] : [-1, -1, -1];
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const sorted = [...list].sort((a, b) => cmp(rank(a), rank(b)));
    const after = sorted.findIndex((i) => cmp(rank(i), caret) >= 0);
    return after <= 0 ? sorted : [...sorted.slice(after), ...sorted.slice(0, after)];
  }

  const sentenceOf = (issue) => {
    const text = runsText(host.model().runsOf(issue.blockId, issue.itemIndex) ?? []).replaceAll(OBJECT, ' ');
    const start = Math.max(0, issue.from - 60);
    const end = Math.min(text.length, issue.to + 60);
    return `${start > 0 ? '…' : ''}${escapeHtml(text.slice(start, issue.from))}<mark>${escapeHtml(text.slice(issue.from, issue.to))}</mark>${escapeHtml(text.slice(issue.to, end))}${end < text.length ? '…' : ''}`;
  };

  /** Tools › Spelling: each word not in the dictionary, and each grammar find, one at a time. */
  async function spellingDialog() {
    const skipped = new Set();
    const keyOf = (i) => `${i.blockId}:${i.itemIndex}:${i.word}:${i.kind}`;
    let done = 0;
    for (;;) {
      const found = order(await find()).filter((i) => !skipped.has(keyOf(i)));
      const issue = found[0];
      if (!issue) {
        host.toast(done ? `The spelling check is complete: ${done} change(s)` : 'The spelling check is complete');
        schedule(0);
        return;
      }
      const spelling = issue.kind === 'spelling';
      const suggestions = spelling ? await host.checker.suggest(issue.word, issue.lang) : (issue.replacement !== null && issue.replacement !== undefined ? [issue.replacement] : []);
      const answer = showChoice('Spelling', `
        <p class="hint">${spelling ? `Not in the ${escapeHtml(issue.lang)} dictionary` : escapeHtml(issue.message)}</p>
        <p class="spelling-context">${sentenceOf(issue)}</p>
        <label>Change to<input data-sp-to value="${escapeHtml(suggestions[0] ?? issue.word)}" maxlength="200"></label>
        ${suggestions.length ? `<div class="template-list" role="listbox" aria-label="Suggestions">${suggestions.map((s) => `<button type="button" class="customize-row" data-sp-pick="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>` : '<p class="hint">No suggestions.</p>'}`,
      [
        { id: 'close', label: 'Close' },
        { id: 'ignore', label: 'Ignore Once' },
        ...(spelling ? [{ id: 'ignoreAll', label: 'Ignore All' }, { id: 'add', label: 'Add to Dictionary' }, { id: 'all', label: 'Correct All' }] : []),
        { id: 'correct', label: 'Correct', primary: true },
      ]);
      const body = document.getElementById('panel-body');
      body.querySelector('[data-sp-to]')?.focus();
      body.addEventListener('click', (event) => {
        const pick = event.target.closest('[data-sp-pick]');
        if (pick) body.querySelector('[data-sp-to]').value = pick.dataset.spPick;
      });
      const choice = await answer;
      const to = body.querySelector('[data-sp-to]')?.value ?? '';
      if (choice === 'close' || choice === null) { schedule(0); return; }
      if (choice === 'ignore') skipped.add(keyOf(issue));
      else if (choice === 'ignoreAll') host.checker.ignore(issue.word);
      else if (choice === 'add') await host.checker.add(issue.word);
      else if (choice === 'correct') { replace(issue, to); done += 1; }
      else if (choice === 'all') {
        // Every place the word is wrong, from the last, so the places before stay where they were.
        const same = (await find()).filter((i) => i.kind === 'spelling' && i.word === issue.word).reverse();
        for (const each of same) replace(each, to);
        done += same.length;
      }
    }
  }

  /** The word at the caret, or the one selected, with where it is. */
  function wordAtCaret() {
    const sel = host.editor.readSelection?.() ?? host.editor.selection;
    if (!sel) return null;
    const at = sel.anchor;
    const text = runsText(host.model().runsOf(at.blockId, at.itemIndex) ?? []);
    if (!isCollapsed(sel) && sel.focus.blockId === at.blockId) {
      const [from, to] = [Math.min(at.offset, sel.focus.offset), Math.max(at.offset, sel.focus.offset)];
      return { blockId: at.blockId, itemIndex: at.itemIndex, from, to, word: text.slice(from, to).trim() };
    }
    let from = at.offset;
    let to = at.offset;
    while (from > 0 && /[\p{L}\p{M}'’-]/u.test(text[from - 1])) from -= 1;
    while (to < text.length && /[\p{L}\p{M}'’-]/u.test(text[to])) to += 1;
    return from === to ? null : { blockId: at.blockId, itemIndex: at.itemIndex, from, to, word: text.slice(from, to) };
  }

  /** Tools › Thesaurus: the meanings of the word at the caret, and a word chosen put in its place. */
  async function thesaurusDialog() {
    const target = wordAtCaret();
    if (!target?.word) { host.toast('Put the cursor in a word first'); return; }
    const runs = host.model().runsOf(target.blockId, target.itemIndex) ?? [];
    let seen = 0;
    const lang = runs.find((r) => { seen += r.text.length; return seen > target.from; })?.lang ?? host.language();
    let meanings = await invoke('thesaurus_lookup', { lang, word: target.word }).catch(() => []);
    // A word not found as written is looked up without a capital or an elision in front.
    if (meanings.length === 0) {
      const bare = target.word.replace(/^\p{L}+['’]/u, '').toLowerCase();
      if (bare !== target.word) meanings = await invoke('thesaurus_lookup', { lang, word: bare }).catch(() => []);
    }
    const clean = (word) => word.replace(/\s*\([^)]*\)\s*$/, '');
    const answer = showChoice('Thesaurus', `
      <p>Synonyms of <strong>${escapeHtml(target.word)}</strong> <span class="hint">${escapeHtml(lang)}</span></p>
      ${meanings.length ? `<div class="template-list" role="listbox" aria-label="Synonyms">${meanings.map((m) => `<fieldset><legend>${escapeHtml(m.pos || 'meaning')}</legend>
        ${m.words.map((w) => `<button type="button" class="customize-row" data-th-pick="${escapeHtml(clean(w))}">${escapeHtml(w)}</button>`).join('')}</fieldset>`).join('')}</div>`
        : '<p class="hint">No synonyms for this word in the dictionary.</p>'}
      <label>Replace with<input data-th-to value="${escapeHtml(target.word)}" maxlength="200"></label>`,
    [{ id: 'close', label: 'Close' }, { id: 'replace', label: 'Replace', primary: true }]);
    const body = document.getElementById('panel-body');
    body.addEventListener('click', (event) => {
      const pick = event.target.closest('[data-th-pick]');
      if (pick) body.querySelector('[data-th-to]').value = pick.dataset.thPick;
    });
    const choice = await answer;
    const to = body.querySelector('[data-th-to]').value.trim();
    if (choice !== 'replace' || !to || to === target.word) return;
    // A word that began with a capital keeps it.
    replace(target, /^\p{Lu}/u.test(target.word) ? to[0].toUpperCase() + to.slice(1) : to);
  }

  return { schedule, draw, contextMenu, spellingDialog, thesaurusDialog, find, replace, get issues() { return issues; }, supported };
}
