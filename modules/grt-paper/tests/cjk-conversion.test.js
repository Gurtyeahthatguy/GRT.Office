// @vitest-environment jsdom

/** Chinese conversion with OpenCC's tables, kept to each run's look, and how a Hanja choice is written. */

import { describe, it, expect } from 'vitest';
import { convertRuns, written } from '../src/js/core/cjk-conversion.js';

describe('Chinese conversion', async () => {
  const OpenCC = (await import('../src/vendor/opencc-full.js')).default;

  it('converts simplified to traditional and back, keeping each run its look and objects in place', () => {
    const toTw = OpenCC.Converter({ from: 'cn', to: 'tw' });
    const runs = [{ text: '汉语', bold: true }, { text: '￼', object: { type: 'note', id: 'n1', runs: [] } }, { text: '简体字' }];
    const out = convertRuns(runs, toTw);
    expect(out.map((r) => r.text).join('')).toBe('漢語￼簡體字');
    expect(out[0]).toEqual({ text: '漢語', bold: true });
    expect(out[1].object?.type).toBe('note');
    const back = convertRuns(out, OpenCC.Converter({ from: 'tw', to: 'cn' }));
    expect(back.map((r) => r.text).join('')).toBe('汉语￼简体字');
  });

  it('leaves text with nothing to convert, or with changes not settled', () => {
    const toTw = OpenCC.Converter({ from: 'cn', to: 'tw' });
    expect(convertRuns([{ text: 'plain text' }], toTw)).toBeNull();
    expect(convertRuns([{ text: '汉语', ins: 'i1' }], toTw)).toBeNull();
  });
});

describe('Hanja', () => {
  it('writes the choice alone or with the word in brackets', () => {
    expect(['plain', 'after', 'before'].map((f) => written('한국', '韓國', f))).toEqual(['韓國', '한국(韓國)', '韓國(한국)']);
  });
});
