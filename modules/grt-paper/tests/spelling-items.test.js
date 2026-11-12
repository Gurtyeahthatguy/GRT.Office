// @vitest-environment jsdom

/** The Spelling dialog over pieces of text: what it finds, and the changes it makes through the program. */

import { describe, it, expect, beforeEach } from 'vitest';
import { issuesIn, spellingOverItems } from '../src/js/core/spelling-items.js';
import { createSpellChecker } from '../src/js/core/spelling.js';

const dictionary = new Set(['un', 'testo', 'giusto', 'con', 'errore', 'e', 'altro']);
const checker = () => createSpellChecker({
  call: async (cmd, args) => (cmd === 'spell_check' ? args.words.map((w) => dictionary.has(w.toLowerCase())) : cmd === 'spell_suggest' ? ['errore'] : []),
});

beforeEach(() => {
  document.body.innerHTML = `<div id="overlay" class="hidden"><h2 id="panel-title"></h2><div id="panel-body"></div>
    <div class="panel-actions"><button id="panel-cancel">Close</button><button id="panel-confirm" class="hidden">OK</button></div></div>`;
});

const until = async (test) => { for (let i = 0; i < 100 && !test(); i += 1) await new Promise((r) => setTimeout(r, 5)); };

describe('spelling over pieces of text', () => {
  it('finds the words each piece is wrong about, skipping text marked as no language', async () => {
    const found = await issuesIn([{ key: 'a', text: 'Un testo giusto' }, { key: 'b', text: 'con erore' }, { key: 'c', text: 'erore', lang: 'zxx' }], checker(), 'it-IT', false);
    expect(found.map((i) => [i.item.key, i.word, i.from])).toEqual([['b', 'erore', 4]]);
  });

  it('corrects one place, then every place of a word, through the program\'s own change', async () => {
    const texts = { a: 'un erore', b: 'altro erore e erore' };
    const changes = [];
    const done = spellingOverItems({
      checker: checker(), toast: () => {}, language: () => 'it-IT',
      items: () => Object.entries(texts).map(([key, text]) => ({ key, text })),
      replace: (key, from, to, text) => { changes.push(key); texts[key] = texts[key].slice(0, from) + text + texts[key].slice(to); },
    });
    await until(() => document.querySelector('[data-choice="correct"]'));
    document.querySelector('[data-choice="correct"]').click();
    await until(() => texts.a === 'un errore' && document.querySelector('[data-choice="all"]'));
    document.querySelector('[data-choice="all"]').click();
    expect(await done).toBe(3);
    expect(texts).toEqual({ a: 'un errore', b: 'altro errore e errore' });
  });
});
