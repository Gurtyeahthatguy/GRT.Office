/** Hyphenation by Liang's method, from the patterns LibreOffice uses: where a word may break, marked with soft hyphens in the text. */

export const SOFT_HYPHEN = '­';

/** A patterns file, read: the patterns by their letters, and how many letters must stay on each side of a break. */
export function parsePatterns(text) {
  const patterns = new Map();
  let left = 2;
  let right = 2;
  const lines = String(text).split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    // The first line names the character set.
    if (index === 0 || !line || line.startsWith('%') || line === 'NEXTLEVEL') continue;
    const setting = /^(LEFTHYPHENMIN|RIGHTHYPHENMIN)\s+(\d+)$/.exec(line);
    if (setting) {
      if (setting[1] === 'LEFTHYPHENMIN') left = Number(setting[2]);
      else right = Number(setting[2]);
      continue;
    }
    // Other settings, and the non-standard breaks a few patterns spell out after a slash, are not used.
    if (/^[A-Z]+HYPHENMIN\b/.test(line) || line.includes('/')) continue;
    const letters = line.replace(/\d/g, '');
    if (!letters) continue;
    const values = new Array(letters.length + 1).fill(0);
    let at = 0;
    for (const char of line) {
      if (/\d/.test(char)) values[at] = Number(char);
      else at += 1;
    }
    patterns.set(letters, values);
  }
  return { patterns, left, right };
}

/** The places inside a word where it may break, as offsets from its start. */
export function breakPoints(word, { patterns, left, right }) {
  const lower = word.toLowerCase().replace(/’/g, "'");
  if ([...lower].length !== lower.length) return [];
  const padded = `.${lower}.`;
  const scores = new Array(padded.length + 1).fill(0);
  for (let start = 0; start < padded.length; start += 1) {
    for (let end = start + 1; end <= padded.length; end += 1) {
      const values = patterns.get(padded.slice(start, end));
      if (!values) continue;
      values.forEach((value, i) => { if (value > scores[start + i]) scores[start + i] = value; });
    }
  }
  const out = [];
  // scores[i + 1] is the break before the word's letter i, the dot taking place 0.
  for (let i = Math.max(1, left); i <= word.length - Math.max(1, right); i += 1) if (scores[i + 1] % 2 === 1) out.push(i);
  return out;
}

/** Where soft hyphens go in a text: inside words of at least `minLength` letters that have none yet. */
export function hyphenPlaces(text, compiled, { minLength = 6 } = {}) {
  const places = [];
  for (const match of text.matchAll(/[\p{L}'’]+/gu)) {
    const word = match[0];
    if (word.length < minLength) continue;
    const next = text[match.index + word.length];
    if (next === SOFT_HYPHEN || text[match.index - 1] === SOFT_HYPHEN) continue;
    for (const at of breakPoints(word, compiled)) places.push(match.index + at);
  }
  return places;
}

/**
 * Soft hyphens put into the text of the blocks given, or taken out, each language with its own patterns.
 * Text with changes not yet settled, code and formulas are left alone.
 * @param {(lang: string) => ?Object} compiledFor the patterns of a language, or null where there are none
 * @returns {{changed: number, hyphens: number, skipped: number}}
 */
export function hyphenateBlocks(model, blocks, compiledFor, fallbackLang, { minLength = 6, remove = false, applyEdits, normaliseRuns, itemIndices }) {
  let changed = 0;
  let hyphens = 0;
  let skipped = 0;
  for (const block of blocks) {
    if (['code', 'raw', 'toc', 'index', 'image', 'chart'].includes(block.kind)) continue;
    for (const itemIndex of itemIndices(block)) {
      const runs = model.runsOf(block.id, itemIndex) ?? [];
      if (runs.some((r) => r.ins || r.del)) { skipped += 1; continue; }
      const edits = [];
      let at = 0;
      for (const run of runs) {
        const lang = run.lang ?? fallbackLang;
        if (remove) {
          for (let i = 0; i < run.text.length; i += 1) if (run.text[i] === SOFT_HYPHEN) edits.push({ from: at + i, to: at + i + 1, text: '' });
        } else if (!run.object && !run.code && !run.math && lang !== 'zxx') {
          const compiled = compiledFor(lang);
          if (compiled) for (const place of hyphenPlaces(run.text, compiled, { minLength })) edits.push({ from: at + place, to: at + place, text: SOFT_HYPHEN });
        }
        at += run.text.length;
      }
      if (edits.length === 0) continue;
      model.setRuns(block.id, normaliseRuns(applyEdits(runs, edits.sort((a, b) => b.from - a.from))), itemIndex);
      changed += 1;
      hyphens += edits.length;
    }
  }
  if (changed) model.dirty = true;
  return { changed, hyphens, skipped };
}
