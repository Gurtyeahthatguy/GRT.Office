/** The case changes LibreOffice's Format, Text menu offers, for any program that edits text. */

const letter = /\p{L}/u;

/** Each word with a capital, the rest small. */
const title = (text) => text.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, before, c) => before + c.toUpperCase());

/** A capital at the start of each sentence, the rest small. */
const sentence = (text, startsSentence = true) => {
  let out = '';
  let capital = startsSentence;
  for (const ch of text.toLowerCase()) {
    if (capital && letter.test(ch)) {
      out += ch.toUpperCase();
      capital = false;
    } else out += ch;
    if (/[.!?]/.test(ch)) capital = true;
  }
  return out;
};

const toggle = (text) => [...text].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('');

/** What Cycle Case gives next: small, then sentence, then each word, then capitals, then small again. */
function cycle(text) {
  if (text === text.toLowerCase()) return sentence(text);
  if (text === sentence(text)) return title(text);
  if (text === title(text)) return text.toUpperCase();
  return text.toLowerCase();
}

/** Latin letters, digits and signs to the full-width forms East Asian text sets them in, and back. */
const fullwidth = (text) => text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/ /g, '\u3000');
const halfwidth = (text) => text.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  .replace(/[\u30A1-\u30F6\u30FC\u3001\u3002\u300C\u300D\u30FB]/g, (c) => HALF_KANA[c] ?? c);

/** Katakana as their half-width forms, voiced ones as a letter and its mark. */
const HALF_KANA = (() => {
  const full = 'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロワヲンヴー、。「」・';
  const half = ['ｧ', 'ｱ', 'ｨ', 'ｲ', 'ｩ', 'ｳ', 'ｪ', 'ｴ', 'ｫ', 'ｵ', 'ｶ', 'ｶﾞ', 'ｷ', 'ｷﾞ', 'ｸ', 'ｸﾞ', 'ｹ', 'ｹﾞ', 'ｺ', 'ｺﾞ', 'ｻ', 'ｻﾞ', 'ｼ', 'ｼﾞ', 'ｽ', 'ｽﾞ', 'ｾ', 'ｾﾞ', 'ｿ', 'ｿﾞ', 'ﾀ', 'ﾀﾞ', 'ﾁ', 'ﾁﾞ', 'ｯ', 'ﾂ', 'ﾂﾞ', 'ﾃ', 'ﾃﾞ', 'ﾄ', 'ﾄﾞ', 'ﾅ', 'ﾆ', 'ﾇ', 'ﾈ', 'ﾉ', 'ﾊ', 'ﾊﾞ', 'ﾊﾟ', 'ﾋ', 'ﾋﾞ', 'ﾋﾟ', 'ﾌ', 'ﾌﾞ', 'ﾌﾟ', 'ﾍ', 'ﾍﾞ', 'ﾍﾟ', 'ﾎ', 'ﾎﾞ', 'ﾎﾟ', 'ﾏ', 'ﾐ', 'ﾑ', 'ﾒ', 'ﾓ', 'ｬ', 'ﾔ', 'ｭ', 'ﾕ', 'ｮ', 'ﾖ', 'ﾗ', 'ﾘ', 'ﾙ', 'ﾚ', 'ﾛ', 'ﾜ', 'ｦ', 'ﾝ', 'ｳﾞ', 'ｰ', '､', '｡', '｢', '｣', '･'];
  return Object.fromEntries([...full].map((c, i) => [c, half[i]]));
})();

/** Hiragana and katakana are the same syllables 96 code points apart. */
const katakana = (text) => text.replace(/[\u3041-\u3096\u309D\u309E]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const hiragana = (text) => text.replace(/[\u30A1-\u30F6\u30FD\u30FE]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

export const CASES = {
  upper: (text) => text.toUpperCase(),
  fullwidth,
  halfwidth,
  hiragana,
  katakana,
  lower: (text) => text.toLowerCase(),
  sentence,
  title,
  toggle,
  cycle,
};

/** A text in a case, by its name; an unknown name leaves it as it is. */
export function changeCase(text, mode) {
  return (CASES[mode] ?? ((t) => t))(text);
}

/** The font sizes Increase Size and Decrease Size step through, as LibreOffice's. */
export const FONT_SIZES = [6, 7, 8, 9, 10, 10.5, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];

/** The next size up (direction 1) or down (-1) from a size. */
export function stepSize(size, direction) {
  if (direction > 0) return FONT_SIZES.find((s) => s > size) ?? Math.min(999, size + 10);
  return [...FONT_SIZES].reverse().find((s) => s < size) ?? Math.max(2, size - 1);
}

/** The formatting marks of Insert, Formatting Mark, by the names LibreOffice gives them. */
export const FORMATTING_MARKS = [
  { label: 'No-break space', char: ' ', shortcut: 'Ctrl+Shift+Space' },
  { label: 'Non-breaking hyphen', char: '‑', shortcut: 'Ctrl+Shift+-' },
  { label: 'Soft hyphen', char: '­', shortcut: 'Ctrl+-' },
  { label: 'Narrow no-break space', char: ' ' },
  { label: 'Zero-width space', char: '​' },
  { label: 'Word joiner', char: '⁠' },
  { label: 'Left-to-right mark', char: '‎' },
  { label: 'Right-to-left mark', char: '‏' },
];
