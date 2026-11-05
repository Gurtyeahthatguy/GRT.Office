/** The note of the day, templates, unique names and notes shown inside notes. */

import { describe, it, expect, vi } from 'vitest';
import { formatDate, fillTemplate, sectionBlocks, uniqueName, embedLoader } from '../src/js/extras.js';

const at = new Date(2026, 10, 2, 9, 5, 7);
const heading = (level, text) => ({ kind: 'heading', level, runs: [{ text }] });
const para = (text) => ({ kind: 'paragraph', runs: [{ text }] });

describe('the helpers Obsidian has', () => {
  it('write dates with its tokens', () => {
    expect(formatDate(at, 'YYYY-MM-DD')).toBe('2026-11-02');
    expect(formatDate(at, 'dddd D MMMM YYYY [at] HH:mm')).toBe('Monday 2 November 2026 at 09:05');
    expect(uniqueName(at)).toBe('202611020905');
  });

  it('fill a template in', () => {
    expect(fillTemplate('# {{title}}\nMade {{date}} {{time}}, {{date:dddd}}', { title: 'Plan', now: at })).toBe('# Plan\nMade 2026-11-02 09:05, Monday');
  });

  it('take one part of a note, to the next heading as high', () => {
    const blocks = [heading(1, 'A'), para('a'), heading(2, 'B'), para('b'), heading(3, 'C'), para('c'), heading(2, 'D'), para('d')];
    expect(sectionBlocks(blocks, 'b').map((b) => b.runs[0].text)).toEqual(['B', 'b', 'C', 'c']);
    expect(sectionBlocks(blocks, 'missing')).toBeNull();
  });

  it('read a note shown inside another once, and draw again when it is read', async () => {
    const redraw = vi.fn();
    const read = vi.fn(async () => ({ blocks: [heading(1, 'Top'), para('x')] }));
    const loader = embedLoader({ resolve: (t) => (t === 'Other' ? '/v/Other.md' : null), read, redraw });
    expect(loader.content('Nope')).toBe('missing');
    expect(loader.content('Other')).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(redraw).toHaveBeenCalled();
    expect(loader.content('Other').length).toBe(2);
    expect(loader.content('Other#Top').length).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
