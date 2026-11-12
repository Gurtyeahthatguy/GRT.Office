/** Find and replace for every program: a pattern from what is typed, replacing across styled runs, and the find bar. */

/**
 * Whether a regular expression can backtrack for ever: a back-reference, or a repeated group
 * that itself holds a repeat or a choice, such as (a+)+ or (a|aa)*.
 */
export function riskyPattern(pattern) {
  const text = String(pattern ?? '');
  if (/\\[1-9]|\\k</.test(text)) return true;
  const stack = [];
  const repeatAt = (i) => text[i] === '*' || text[i] === '+' || (text[i] === '{' && /^\{\d*,\d*\}|^\{\d{2,}\}/.test(text.slice(i)));
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      for (i += 1; i < text.length && text[i] !== ']'; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (ch === '(') {
      stack.push({ repeats: false, choice: false });
      continue;
    }
    if (ch === ')') {
      const group = stack.pop() ?? { repeats: false, choice: false };
      const repeated = repeatAt(i + 1);
      if (repeated && (group.repeats || group.choice)) return true;
      const top = stack[stack.length - 1];
      if (top) {
        top.repeats ||= group.repeats || repeated;
        top.choice ||= group.choice;
      }
      continue;
    }
    if (ch === '|' && stack.length) stack[stack.length - 1].choice = true;
    else if (repeatAt(i) && stack.length) stack[stack.length - 1].repeats = true;
  }
  return false;
}

/**
 * The expression a search runs, global; it throws a message fit to show when the text cannot be one.
 * @param {{matchCase?: boolean, regex?: boolean, wholeWords?: boolean}} options
 */
export function searchPattern(query, { matchCase = false, regex = false, wholeWords = false } = {}) {
  const text = String(query ?? '');
  if (text === '') throw new Error('Type something to look for');
  if (text.length > 1000) throw new Error('That is too long to look for');
  let source = regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (regex && riskyPattern(text)) throw new Error('That expression could take for ever to run; take out the repeat inside the repeated group');
  if (wholeWords) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `g${matchCase ? '' : 'i'}u`);
  } catch (error) {
    throw new Error(`That is not a valid expression: ${error.message}`);
  }
}

/** Where a pattern matches in a text, empty matches left out; at most `limit` of them. */
export function findAll(text, pattern, limit = 10_000) {
  const out = [];
  pattern.lastIndex = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match[0] === '') continue;
    out.push({ from: match.index, to: match.index + match[0].length, text: match[0] });
    if (out.length >= limit) break;
  }
  return out;
}

/** What a match is replaced with: $1 and $& as JavaScript reads them for an expression, the text as it is otherwise. */
function replacementFor(match, pattern, replacement, regex) {
  if (!regex) return replacement;
  const local = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  return match.text.replace(local, replacement);
}

/**
 * Replaces every match in styled runs; a replacement takes the look of the run its match starts in.
 * @returns {{runs: Object[], count: number}}
 */
export function replaceInRuns(runs, pattern, replacement, { regex = false } = {}) {
  const text = runs.map((r) => r.text).join('');
  const matches = findAll(text, pattern);
  if (matches.length === 0) return { runs, count: 0 };
  // Each run as its stretch of the whole text.
  const spans = [];
  let at = 0;
  for (const run of runs) {
    spans.push({ run, from: at, to: at + run.text.length });
    at += run.text.length;
  }
  const out = [];
  let cursor = 0;
  const copy = (from, to) => {
    for (const span of spans) {
      const a = Math.max(from, span.from);
      const b = Math.min(to, span.to);
      if (a < b) out.push({ ...span.run, text: span.run.text.slice(a - span.from, b - span.from) });
    }
  };
  for (const match of matches) {
    copy(cursor, match.from);
    const owner = spans.find((s) => match.from >= s.from && match.from < s.to)?.run ?? runs[0] ?? {};
    const value = replacementFor(match, pattern, replacement, regex);
    if (value !== '') out.push({ ...owner, text: value });
    cursor = match.to;
  }
  copy(cursor, text.length);
  // Runs of the same look side by side become one.
  const merged = [];
  for (const run of out) {
    const last = merged[merged.length - 1];
    const { text: _a, ...lookA } = last ?? {};
    const { text: _b, ...lookB } = run;
    if (last && JSON.stringify(lookA) === JSON.stringify(lookB)) last.text += run.text;
    else merged.push({ ...run });
  }
  return { runs: merged.length ? merged : [{ ...(runs[0] ?? {}), text: '' }], count: matches.length };
}

/** Replaces every match in plain text. */
export function replaceInText(text, pattern, replacement, { regex = false } = {}) {
  const matches = findAll(text, pattern);
  if (matches.length === 0) return { text, count: 0 };
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.from) + replacementFor(match, pattern, replacement, regex);
    cursor = match.to;
  }
  return { text: out + text.slice(cursor), count: matches.length };
}

/**
 * The find bar at the foot of the window: typing searches, Enter goes to the next match and Shift+Enter back.
 * @param {{matches: (pattern: RegExp) => Object[], show: (place: Object) => void, toast?: Function}} program
 */
export function createFindBar(program) {
  let bar = null;
  let places = [];
  let index = -1;

  function build() {
    bar = document.createElement('div');
    bar.className = 'grt-findbar';
    bar.setAttribute('role', 'search');
    bar.innerHTML = `
      <input type="search" class="find-text" placeholder="Find" aria-label="Find" maxlength="1000" />
      <button type="button" class="find-previous" title="Find previous (Shift+Enter)" aria-label="Find previous">↑</button>
      <button type="button" class="find-next" title="Find next (Enter)" aria-label="Find next">↓</button>
      <label class="find-case"><input type="checkbox" class="find-match-case" /> Match case</label>
      <label class="find-words"><input type="checkbox" class="find-whole-words" /> Whole words</label>
      <span class="find-count" aria-live="polite"></span>
      <button type="button" class="find-close" title="Close (Escape)" aria-label="Close the find bar">×</button>`;
    document.body.append(bar);
    const input = bar.querySelector('.find-text');
    input.addEventListener('input', () => search(true));
    for (const box of bar.querySelectorAll('input[type=checkbox]')) box.addEventListener('change', () => search(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    bar.querySelector('.find-next').addEventListener('click', () => step(1));
    bar.querySelector('.find-previous').addEventListener('click', () => step(-1));
    bar.querySelector('.find-close').addEventListener('click', close);
  }

  const options = () => ({
    matchCase: bar.querySelector('.find-match-case').checked,
    wholeWords: bar.querySelector('.find-whole-words').checked,
  });

  function search(fromStart = false) {
    const query = bar.querySelector('.find-text').value;
    const count = bar.querySelector('.find-count');
    places = [];
    index = -1;
    if (query === '') {
      count.textContent = '';
      return;
    }
    try {
      places = program.matches(searchPattern(query, options()));
    } catch (error) {
      count.textContent = error.message;
      return;
    }
    count.textContent = places.length ? `${places.length} found` : 'Not found';
    if (fromStart && places.length) step(1);
  }

  function step(direction) {
    if (!places.length) search(false);
    if (!places.length) return;
    index = (index + direction + places.length) % places.length;
    bar.querySelector('.find-count').textContent = `${index + 1} of ${places.length}`;
    program.show(places[index]);
  }

  function open(query = null) {
    if (!bar) build();
    bar.hidden = false;
    const input = bar.querySelector('.find-text');
    if (query !== null) input.value = query;
    input.focus();
    input.select();
    if (input.value) search(false);
  }

  function close() {
    if (bar) bar.hidden = true;
    places = [];
    index = -1;
  }

  return { open, close, step, get isOpen() { return Boolean(bar && !bar.hidden); } };
}
