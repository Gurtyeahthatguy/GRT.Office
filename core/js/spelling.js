/** Spelling: the words of a text, checked against the program's dictionaries, with the words to ignore for the session. */

const { invoke } = window.__TAURI__?.core ?? {};

/** Web and mail addresses, never checked. */
const ADDRESSES = /\b(?:[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/giu;
/** A word: letters, with apostrophes inside or one at the end, as in po’ and dell’. */
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*['’]?/gu;

/**
 * The words of a text to check, with where each is; words beside a digit, an underscore or an @ are left out.
 * @returns {{from: number, to: number, word: string}[]}
 */
export function wordsOf(text) {
  const skip = [];
  for (const match of text.matchAll(ADDRESSES)) skip.push([match.index, match.index + match[0].length]);
  const out = [];
  for (const match of text.matchAll(WORD)) {
    const from = match.index;
    const to = from + match[0].length;
    if (skip.some(([a, b]) => from < b && to > a)) continue;
    const before = text[from - 1] ?? '';
    const after = text[to] ?? '';
    if (/[\d_@]/.test(before) || /[\d_@]/.test(after)) continue;
    // The dictionaries are Italian and English: a word in another script is not theirs to judge.
    if (!/^[\p{Script=Latin}\p{M}'’]+$/u.test(match[0])) continue;
    out.push({ from, to, word: match[0] });
  }
  return out;
}

/** The checker a program keeps: what it has asked, what the person ignores, and the calls to the dictionaries. */
export function createSpellChecker({ call = invoke } = {}) {
  const known = new Map();
  const ignored = new Set();
  let added = null;

  const key = (lang) => String(lang ?? '').split('-')[0].toLowerCase();

  async function addedWords() {
    if (!added) added = new Set(await call('spell_added').catch(() => []));
    return added;
  }

  /** Whether each word is right, asking the dictionaries only for words not seen before. */
  async function check(words, lang) {
    const cache = known.get(key(lang)) ?? new Map();
    known.set(key(lang), cache);
    const asked = [...new Set(words.filter((w) => !cache.has(w)))];
    for (let i = 0; i < asked.length; i += 5000) {
      const part = asked.slice(i, i + 5000);
      const answers = await call('spell_check', { lang, words: part });
      part.forEach((word, j) => cache.set(word, answers[j] !== false));
    }
    if (cache.size > 200_000) cache.clear();
    return words.map((w) => cache.get(w) !== false || ignored.has(w));
  }

  /** The words of a text spelled wrong, with where they are; one ending in an apostrophe is right with it or without, as po’ or a closing quote. */
  async function misspelled(text, lang) {
    const words = wordsOf(text);
    if (words.length === 0) return [];
    const bare = words.map((w) => w.word.replace(/['’]$/, ''));
    const [right, rightBare] = await Promise.all([check(words.map((w) => w.word), lang), check(bare, lang)]);
    return words.filter((_, i) => !right[i] && !rightBare[i]).map((w) => (/['’]$/.test(w.word) ? { ...w, to: w.to - 1, word: w.word.slice(0, -1) } : w));
  }

  return {
    check,
    misspelled,
    suggest: (word, lang) => call('spell_suggest', { lang, word }).catch(() => []),
    ignore: (word) => ignored.add(word),
    async add(word) {
      await call('spell_add', { word });
      (await addedWords()).add(word);
      for (const cache of known.values()) cache.set(word, true);
    },
    async remove(word) {
      await call('spell_remove', { word });
      (await addedWords()).delete(word);
      for (const cache of known.values()) cache.delete(word);
    },
    addedWords,
    languages: () => call('spell_languages').catch(() => []),
  };
}
