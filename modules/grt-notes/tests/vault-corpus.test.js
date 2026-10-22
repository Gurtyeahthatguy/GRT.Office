// @vitest-environment jsdom

/** Real vaults in GRT_VAULTS: every note read and written back unchanged is the same file. */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fromMarkdown, toMarkdown } from '../src/js/note.js';

const root = process.env.GRT_VAULTS;

function notes(folder) {
  const out = [];
  for (const name of readdirSync(folder)) {
    if (name.startsWith('.')) continue;
    const path = join(folder, name);
    if (statSync(path).isDirectory()) out.push(...notes(path));
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

describe.skipIf(!root)('real vaults', () => {
  it('give back every note, character for character', () => {
    const files = notes(root);
    const changed = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (toMarkdown(fromMarkdown(text, 'note')) !== text) changed.push(file);
    }
    console.log(`[vaults] ${files.length} notes, ${changed.length} changed`);
    expect(changed.slice(0, 10)).toEqual([]);
  }, 600000);
});
