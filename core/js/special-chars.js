/** Insert, Special Character: characters by block, found by their code or by themselves; nothing is remembered. */

import { showPanel, readFields, escapeHtml } from './panel.js';

/** The blocks offered, with the ranges of code points they show. */
export const BLOCKS = [
  { name: 'Latin-1 Supplement', from: 0xa1, to: 0xff },
  { name: 'Latin Extended-A', from: 0x100, to: 0x17f },
  { name: 'Greek', from: 0x391, to: 0x3c9 },
  { name: 'Cyrillic', from: 0x410, to: 0x44f },
  { name: 'General Punctuation', from: 0x2010, to: 0x2044 },
  { name: 'Currency Symbols', from: 0x20a0, to: 0x20c0 },
  { name: 'Letterlike Symbols', from: 0x2100, to: 0x214f },
  { name: 'Arrows', from: 0x2190, to: 0x21ff },
  { name: 'Mathematical Operators', from: 0x2200, to: 0x22ff },
  { name: 'Box Drawing', from: 0x2500, to: 0x257f },
  { name: 'Geometric Shapes', from: 0x25a0, to: 0x25ff },
  { name: 'Miscellaneous Symbols', from: 0x2600, to: 0x26ff },
  { name: 'Dingbats', from: 0x2700, to: 0x27bf },
];

/** Code points that are not characters to place, such as unassigned ones in a block. */
const usable = (code) => {
  const ch = String.fromCodePoint(code);
  return /\P{C}/u.test(ch) && !/\p{Cn}/u.test(ch);
};

/** The characters a search names: a code such as U+20AC or 20AC, or the characters typed. */
export function searchCharacters(query) {
  const q = query.trim();
  const code = /^(?:u\+|0x)?([0-9a-f]{2,6})$/i.exec(q);
  if (code) {
    const n = Number.parseInt(code[1], 16);
    return n <= 0x10ffff && usable(n) ? [String.fromCodePoint(n)] : [];
  }
  return [...new Set([...q])].filter((ch) => usable(ch.codePointAt(0)));
}

export function charactersOf(block) {
  const out = [];
  for (let code = block.from; code <= block.to; code += 1) if (usable(code)) out.push(String.fromCodePoint(code));
  return out;
}

const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Asks for characters and gives them back as text, or null when cancelled. */
export async function specialCharacter() {
  const grid = (chars) => chars.map((ch) => `<button type="button" class="char-cell" data-char="${escapeHtml(ch)}" title="${hex(ch)}">${escapeHtml(ch)}</button>`).join('');
  const html = `
    <div class="form-grid">
      <label for="sc-block">Subset</label>
      <select id="sc-block" data-field="block">${BLOCKS.map((b, i) => `<option value="${i}">${b.name}</option>`).join('')}</select>
      <label for="sc-search">Search</label>
      <input id="sc-search" type="text" data-field="search" placeholder="U+20AC, or the character" />
      <label for="sc-chosen">Characters</label>
      <input id="sc-chosen" type="text" data-field="chosen" />
    </div>
    <div class="char-grid" id="sc-grid">${grid(charactersOf(BLOCKS[0]))}</div>`;
  const answer = showPanel('Special characters', html, 'Insert');
  const body = document.getElementById('panel-body');
  const draw = () => {
    const query = body.querySelector('#sc-search').value;
    const chars = query.trim() ? searchCharacters(query) : charactersOf(BLOCKS[Number(body.querySelector('#sc-block').value)]);
    body.querySelector('#sc-grid').innerHTML = grid(chars);
  };
  const onInput = (event) => { if (event.target.id === 'sc-search' || event.target.id === 'sc-block') draw(); };
  const onClick = (event) => {
    const cell = event.target.closest?.('.char-cell');
    if (!cell) return;
    const chosen = body.querySelector('#sc-chosen');
    chosen.value += cell.dataset.char;
  };
  body.addEventListener('input', onInput);
  body.addEventListener('change', onInput);
  body.addEventListener('click', onClick);
  const confirmed = await answer;
  body.removeEventListener('input', onInput);
  body.removeEventListener('change', onInput);
  body.removeEventListener('click', onClick);
  if (!confirmed) return null;
  const text = readFields().chosen ?? '';
  return text === '' ? null : text;
}
