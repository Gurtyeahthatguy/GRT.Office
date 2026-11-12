/** The Spelling dialog for programs whose text is in many small pieces: slides' boxes and notes, cells, a diagram's labels. */

import { showChoice, escapeHtml } from './panel.js';
import { grammarIssues } from './grammar.js';
import { LANGUAGES } from './language.js';

const DICTIONARIES = LANGUAGES.filter(([tag]) => /^(it|en)-/.test(tag));

/** What is wrong in each piece of text, in their order; the words a piece is wrong about, and with grammar on, the rules' finds. */
export async function issuesIn(items, checker, lang, grammar) {
  const out = [];
  for (const item of items) {
    if (!item.text?.trim()) continue;
    const language = item.lang ?? lang;
    if (language === 'zxx') continue;
    for (const w of await checker.misspelled(item.text, language).catch(() => [])) out.push({ item, kind: 'spelling', from: w.from, to: w.to, word: w.word, lang: language });
    if (grammar) for (const g of grammarIssues(item.text, language)) out.push({ item, kind: `grammar:${g.kind}`, from: g.from, to: g.to, word: item.text.slice(g.from, g.to), message: g.message, replacement: g.replacement, lang: language });
  }
  return out;
}

/**
 * Goes through every word not in the dictionary, one at a time, as Tools › Spelling does.
 * @param {{items: () => {key: string, text: string, lang?: string}[], replace: (key: string, from: number, to: number, text: string) => void,
 *   show?: (issue: Object) => void, checker: Object, language: () => string, setLanguage?: (tag: string) => void,
 *   grammar?: () => boolean, toast: Function}} host
 */
export async function spellingOverItems(host) {
  const skipped = new Set();
  let done = 0;
  for (;;) {
    const lang = host.language();
    const found = (await issuesIn(host.items(), host.checker, lang, host.grammar?.() ?? false))
      .filter((i) => !skipped.has(`${i.item.key}:${i.from}:${i.word}`));
    const issue = found[0];
    if (!issue) {
      host.toast(done ? `The spelling check is complete: ${done} change(s)` : 'The spelling check is complete');
      return done;
    }
    host.show?.(issue);
    const spelling = issue.kind === 'spelling';
    const suggestions = spelling ? await host.checker.suggest(issue.word, issue.lang) : (issue.replacement !== null && issue.replacement !== undefined ? [issue.replacement] : []);
    const text = issue.item.text;
    const start = Math.max(0, issue.from - 60);
    const end = Math.min(text.length, issue.to + 60);
    const answer = showChoice('Spelling', `
      ${host.setLanguage ? `<label>Dictionary<select data-sp-lang>${DICTIONARIES.map(([tag, name]) => `<option value="${tag}"${tag === lang ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>` : ''}
      <p class="hint">${escapeHtml(issue.item.label ?? '')}${issue.item.label ? ': ' : ''}${spelling ? `not in the ${escapeHtml(issue.lang)} dictionary` : escapeHtml(issue.message)}</p>
      <p class="spelling-context">${start > 0 ? '…' : ''}${escapeHtml(text.slice(start, issue.from))}<mark>${escapeHtml(text.slice(issue.from, issue.to))}</mark>${escapeHtml(text.slice(issue.to, end))}${end < text.length ? '…' : ''}</p>
      <label>Change to<input data-sp-to value="${escapeHtml(suggestions[0] ?? issue.word)}" maxlength="200"></label>
      ${suggestions.length ? `<div class="template-list" role="listbox" aria-label="Suggestions">${suggestions.map((s) => `<button type="button" class="customize-row" data-sp-pick="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>` : '<p class="hint">No suggestions.</p>'}`,
    [
      { id: 'close', label: 'Close' },
      { id: 'ignore', label: 'Ignore Once' },
      ...(spelling ? [{ id: 'ignoreAll', label: 'Ignore All' }, { id: 'add', label: 'Add to Dictionary' }, { id: 'all', label: 'Correct All' }] : []),
      { id: 'correct', label: 'Correct', primary: true },
    ]);
    const body = document.getElementById('panel-body');
    body.addEventListener('click', (event) => {
      const pick = event.target.closest('[data-sp-pick]');
      if (pick) body.querySelector('[data-sp-to]').value = pick.dataset.spPick;
    });
    // Another dictionary looks again from the start, with what was ignored kept.
    let relook = false;
    body.querySelector('[data-sp-lang]')?.addEventListener('change', (event) => {
      host.setLanguage(event.target.value);
      relook = true;
      document.querySelector('[data-choice="ignore"]')?.click();
    });
    const choice = await answer;
    const to = body.querySelector('[data-sp-to]')?.value ?? '';
    if (relook) continue;
    if (choice === 'close' || choice === null) return done;
    if (choice === 'ignore') skipped.add(`${issue.item.key}:${issue.from}:${issue.word}`);
    else if (choice === 'ignoreAll') host.checker.ignore(issue.word);
    else if (choice === 'add') await host.checker.add(issue.word);
    else if (choice === 'correct') {
      host.replace(issue.item.key, issue.from, issue.to, to);
      done += 1;
    } else if (choice === 'all') {
      const same = (await issuesIn(host.items(), host.checker, lang, false)).filter((i) => i.word === issue.word);
      // From the last in each piece, so the places before stay where they were.
      for (const each of same.sort((a, b) => b.from - a.from)) host.replace(each.item.key, each.from, each.to, to);
      done += same.length;
    }
  }
}
