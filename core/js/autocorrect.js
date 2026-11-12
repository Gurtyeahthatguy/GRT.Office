/** AutoCorrect: what typing puts right by itself, and the same over text already written. All of it is local rules and a table of replacements. */

import { commonPairs } from './editor/compare.js';

export const DEFAULT_OPTIONS = {
  whileTyping: true,
  replace: true,
  quotes: true,
  capitalise: true,
  twoCapitals: true,
  dashes: true,
  doubleSpaces: false,
};

/** What is replaced as it is typed, until the person changes the table. */
export const DEFAULT_REPLACEMENTS = [
  ['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['...', '…'], ['->', '→'], ['<-', '←'], ['<->', '↔'], ['=>', '⇒'],
  ['1/2', '½'], ['1/4', '¼'], ['3/4', '¾'], ['+-', '±'], ['!=', '≠'], ['<=', '≤'], ['>=', '≥'],
  ['perchè', 'perché'], ['poichè', 'poiché'], ['affinchè', 'affinché'], ['nè', 'né'], ['pò', "po'"], ['qual\'è', 'qual è'],
  ['teh', 'the'], ['adn', 'and'], ['recieve', 'receive'],
];

export const LIMITS = { entries: 2000, from: 60, to: 500 };

/** A table as given, made safe: pairs of short strings, the thing replaced never empty or with a space in it. */
export function cleanTable(table) {
  const out = [];
  const seen = new Set();
  for (const pair of Array.isArray(table) ? table : []) {
    if (!Array.isArray(pair)) continue;
    const from = String(pair[0] ?? '').trim().slice(0, LIMITS.from);
    const to = String(pair[1] ?? '').slice(0, LIMITS.to);
    if (!from || !to || /\s/.test(from) || seen.has(from) || from === to) continue;
    seen.add(from);
    out.push([from, to]);
    if (out.length >= LIMITS.entries) break;
  }
  return out;
}

export function cleanOptions(options) {
  const out = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) if (typeof options?.[key] === 'boolean') out[key] = options[key];
  return out;
}

/** After these a quote opens; after anything else it closes. */
const OPENS_AFTER = /(^|[\s([{«“‘—–￼])$/u;
/** What ends a word; an object in the text, such as a note mark, ends one too. */
const ENDS_WORD = /^[\s.,;:!?)\]}»”\uFFFC]$/u;
/** Short forms whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(['e.g.', 'i.e.', 'etc.', 'ecc.', 'es.', 'p.es.', 'sig.', 'sigg.', 'dott.', 'prof.', 'ing.', 'avv.', 'vs.', 'n.', 'nr.', 'pag.', 'pagg.', 'art.', 'cfr.', 'fig.', 'tel.', 'mr.', 'mrs.', 'dr.', 'st.', 'no.', 'approx.', 'ca.']);

const upperFirst = (word) => word.replace(/^\p{Ll}/u, (c) => c.toUpperCase());

/** Whether the text before a word ends a sentence, or is the start of the paragraph. */
export function startsSentence(before) {
  if (before.trim() === '') return true;
  const end = /(\S+)\s+$/u.exec(before);
  if (!end) return false;
  const last = end[1].replace(/["”’)\]»]+$/u, '');
  if (!/[.!?]$/.test(last) || last.endsWith('..')) return false;
  if (last.endsWith('.')) {
    const lower = last.toLowerCase();
    // A short form, a single letter, or letters with full stops between them.
    if (ABBREVIATIONS.has(lower) || /^\p{L}\.$/u.test(last) || /^(\p{L}\.){2,}$/u.test(last) || /^\d+\.$/.test(last)) return false;
  }
  return true;
}

/**
 * The end of the text put right, given that a word has just ended with `ender`; null when nothing is to change.
 * A capital waits for a space, so www.example.org is left as typed.
 */
function fixTail(before, options, table, ender = ' ') {
  const token = /([^\s\uFFFC]+)$/u.exec(before);
  if (!token) return null;
  let start = token.index;
  let word = token[1];

  if (options.replace) {
    // The longest entry the text ends with, standing by itself or after an opening mark.
    // An entry of signs alone may follow a word, as in "Well..."; one with letters or digits stands by itself.
    // A word typed with a capital finds the entry written in lower case, and keeps its capital.
    let best = null;
    for (const [from, to] of table) {
      const capital = upperFirst(from);
      const found = word.endsWith(from) ? to : capital !== from && word.endsWith(capital) ? upperFirst(to) : null;
      if (found === null || (best && best[0].length >= from.length)) continue;
      const lead = word.slice(0, word.length - from.length);
      if (lead === '' || /^[([{«“‘"']+$/u.test(lead) || !/[\p{L}\p{N}]/u.test(from)) best = [from, found];
    }
    if (best) word = word.slice(0, word.length - best[0].length) + best[1];
  }

  const lead = /^[([{«“‘"']*/u.exec(word)[0];
  const trail = /[.,;:!?)\]}»”…]*$/u.exec(word.slice(lead.length))[0];
  let core = word.slice(lead.length, word.length - trail.length);
  const plain = /^[\p{L}'’]+$/u.test(core);
  if (options.twoCapitals && plain) core = core.replace(/^(\p{Lu})(\p{Lu})(\p{Ll}{2,})$/u, (_, a, b, rest) => a + b.toLowerCase() + rest);
  // A word with a capital inside, such as iPhone, is written that way on purpose.
  if (options.capitalise && plain && /^[\s\uFFFC]$/u.test(ender) && /^\p{Ll}[\p{Ll}'’]*$/u.test(core) && startsSentence(before.slice(0, start))) core = upperFirst(core);
  if (options.dashes) core = core.replace(/(?<=[\p{L}\p{N}])--(?=[\p{L}\p{N}])/gu, '—');
  word = lead + core + trail;

  // A hyphen standing alone between two words is a dash.
  if (options.dashes && /\S - $/u.test(before.slice(0, start))) {
    start -= 2;
    word = `– ${word}`;
  }
  const tail = before.slice(start);
  return word === tail ? null : { remove: tail.length, insert: word };
}

/**
 * What one typed character becomes, given the paragraph's text before it.
 * @returns {?{remove: number, insert: string}} how many characters before the caret go, and what is put there with the character typed
 */
export function correctOnType(before, typed, options = DEFAULT_OPTIONS, table = DEFAULT_REPLACEMENTS) {
  if (typeof typed !== 'string' || [...typed].length !== 1) return null;
  if (options.quotes && (typed === '"' || typed === "'")) {
    const opens = OPENS_AFTER.test(before);
    return { remove: 0, insert: typed === '"' ? (opens ? '“' : '”') : (opens ? '‘' : '’') };
  }
  if (options.doubleSpaces && typed === ' ' && before.endsWith(' ')) return { remove: 0, insert: '' };
  if (!ENDS_WORD.test(typed)) return null;
  const fixed = fixTail(before, options, table, typed);
  return fixed ? { remove: fixed.remove, insert: fixed.insert + typed } : null;
}

/** A whole paragraph put right, as if it were typed again. */
export function correctText(text, options = DEFAULT_OPTIONS, table = DEFAULT_REPLACEMENTS) {
  let out = '';
  for (const char of text) {
    const fix = correctOnType(out, char, options, table);
    out = fix ? out.slice(0, out.length - fix.remove) + fix.insert : out + char;
  }
  const last = fixTail(out, options, table);
  return last ? out.slice(0, out.length - last.remove) + last.insert : out;
}

/** The smallest changes that turn one text into another, in the first one's offsets, last first. */
export function editsBetween(a, b) {
  if (a === b) return [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const pairs = commonPairs([...midA].length === midA.length ? midA.split('') : [], midB.split(''), undefined, 4_000_000);
  const edits = [];
  let i = 0;
  let j = 0;
  const gap = (toI, toJ) => {
    if (toI > i || toJ > j) edits.push({ from: head + i, to: head + toI, text: midB.slice(j, toJ) });
  };
  for (const [pi, pj] of pairs) {
    gap(pi, pj);
    i = pi + 1;
    j = pj + 1;
  }
  gap(midA.length, midB.length);
  return edits.reverse();
}

/** Runs with changes made in their text, each new piece taking the look of what it replaces or follows. */
export function applyEdits(runs, edits) {
  let out = runs.map((run) => ({ ...run }));
  for (const edit of edits) {
    const next = [];
    let at = 0;
    let placed = false;
    for (const run of out) {
      const from = at;
      const to = at + run.text.length;
      at = to;
      if (to < edit.from || from > edit.to || (to === edit.from && edit.from !== edit.to && to !== from)) { next.push(run); continue; }
      const keepBefore = run.text.slice(0, Math.max(0, edit.from - from));
      const keepAfter = run.text.slice(Math.max(0, Math.min(run.text.length, edit.to - from)));
      // The text put in goes once, with the look of the first run the change touches.
      const text = keepBefore + (placed ? '' : edit.text) + keepAfter;
      if (!placed && (edit.from < to || edit.from === edit.to)) placed = true;
      else if (!placed) { next.push(run); continue; }
      if (text !== '' || run.object) next.push({ ...run, text });
    }
    if (!placed && edit.text) next.push({ ...(out[out.length - 1] ?? {}), text: edit.text });
    out = next;
  }
  return out.length ? out : [{ text: '' }];
}
