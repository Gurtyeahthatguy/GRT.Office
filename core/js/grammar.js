/** Simple grammar checks, our own rules: a word twice, double spaces, a space before a mark, a small letter after a full stop, brackets and quotes left open. */

import { startsSentence } from './autocorrect.js';

/** Languages that put a space before ; : ! and ?, so a space there is right. */
const SPACE_BEFORE = new Set(['fr']);
/** Words a language does repeat on purpose. */
const REPEATS = new Set(['che', 'no', 'sì', 'si', 'via', 'pian', 'piano', 'là', 'qua', 'had', 'that', 'is', 'bye', 'so', 'very', 'tutti', 'uno']);
const PAIRS = [['(', ')'], ['[', ']'], ['{', '}'], ['“', '”'], ['«', '»'], ['‘', '’']];

/**
 * The problems found in a paragraph's text.
 * @returns {{from: number, to: number, kind: string, message: string, replacement: ?string}[]}
 */
export function grammarIssues(text, lang = 'en') {
  const language = String(lang ?? '').split('-')[0].toLowerCase();
  const out = [];
  const add = (from, to, kind, message, replacement = null) => out.push({ from, to, kind, message, replacement });

  for (const match of text.matchAll(/(?<![\p{L}\p{N}'’])(\p{L}+)(\s+)(\p{L}+)(?![\p{L}\p{N}'’])/gu)) {
    const [, first, gap, second] = match;
    if (first.toLowerCase() !== second.toLowerCase() || REPEATS.has(first.toLowerCase()) || first.length < 2) continue;
    add(match.index, match.index + match[0].length, 'repeat', `“${first}” twice`, first);
  }
  for (const match of text.matchAll(/(?<=\S)( {2,})(?=\S)/g)) add(match.index, match.index + match[1].length, 'spaces', 'More than one space', ' ');
  const marks = SPACE_BEFORE.has(language) ? /(?<=\p{L})( +)([,.])/gu : /(?<=[\p{L}\p{N}])( +)([,.;:!?])(?![.\d])/gu;
  for (const match of text.matchAll(marks)) add(match.index, match.index + match[0].length, 'space-before', `No space before “${match[2]}”`, match[2]);
  for (const match of text.matchAll(/(?<=[.!?]["”’»)]?\s+)(\p{Ll}[\p{L}'’]*)/gu)) {
    if (!startsSentence(text.slice(0, match.index))) continue;
    // A word written with a capital inside, such as iPhone, is left as it is.
    if (/\p{Lu}/u.test(match[1].slice(1))) continue;
    add(match.index, match.index + match[1].length, 'capital', 'A sentence starts with a capital', match[1][0].toUpperCase() + match[1].slice(1));
  }
  for (const [open, close] of PAIRS) {
    const stack = [];
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      // A ’ between letters is an apostrophe, not a closing quote.
      if (close === '’' && char === '’' && /\p{L}/u.test(text[i - 1] ?? '') && /\p{L}/u.test(text[i + 1] ?? '')) continue;
      if (char === open) stack.push(i);
      else if (char === close) {
        if (stack.length) stack.pop();
        else if (close !== '’') add(i, i + 1, 'unopened', `“${close}” closes nothing`);
      }
    }
    for (const at of stack) add(at, at + 1, 'unclosed', `“${open}” is not closed`);
  }
  return out.sort((a, b) => a.from - b.from);
}
