/** The fuzzy matcher behind Ctrl+K. */

import { describe, it, expect } from 'vitest';
import { fuzzyScore, rankCommands } from '../src/js/core/palette.js';

const commands = [
  'Save', 'Save as…', 'Select all', 'Settings…', 'Tree layout',
  'Align left', 'Align right', 'Distribute horizontally', 'Import Mermaid…',
].map((label) => ({ id: label, label, run: () => {} }));

const labels = (query) => rankCommands(commands, query).map((c) => c.label);

describe('Matching', () => {
  it('finds letters that appear in order, not just substrings', () => {
    expect(fuzzyScore('dh', 'Distribute horizontally')).not.toBeNull();
  });

  it('rejects letters that appear out of order', () => {
    expect(fuzzyScore('hd', 'Distribute horizontally')).toBeNull();
  });

  it('rejects a letter that is not there at all', () => {
    expect(fuzzyScore('zz', 'Save as…')).toBeNull();
  });

  it('an empty query matches everything', () => {
    expect(labels('')).toHaveLength(commands.length);
  });

  it('ignores case', () => {
    expect(labels('SAVE')).toContain('Save');
  });
});

describe('Ranking', () => {
  it('prefers the shorter label when both match equally', () => {
    expect(labels('save')[0]).toBe('Save');
  });

  it('prefers matches at the start of words', () => {
    // "al" should reach "Align left" before "Select all".
    const ranked = labels('al');
    expect(ranked.indexOf('Align left')).toBeLessThan(ranked.indexOf('Select all'));
  });

  it('finds a command from its initials', () => {
    expect(labels('dh')[0]).toBe('Distribute horizontally');
  });

  it('narrows as more is typed', () => {
    expect(labels('se').length).toBeGreaterThan(labels('sett').length);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(labels('qqqq')).toEqual([]);
  });
});
