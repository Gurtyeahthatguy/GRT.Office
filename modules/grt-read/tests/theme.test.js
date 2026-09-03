/** Every offered theme must actually be a theme. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { THEMES } from '../src/js/core/theme.js';
import { DEFAULTS } from '../src/js/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'css', 'app.css'), 'utf8');

/** The custom properties declared inside one selector's block. */
function variablesIn(selector) {
  const start = css.indexOf(selector);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  return new Set([...body.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]));
}

// The bare :root block is the reference.
const baseline = variablesIn(':root {');

describe('Theme definitions', () => {
  it('the baseline palette is found and is not empty', () => {
    expect(baseline).not.toBeNull();
    expect(baseline.size).toBeGreaterThan(5);
  });

  it('the default theme is one of the offered ones', () => {
    expect(THEMES.map((t) => t.id)).toContain(DEFAULTS.theme);
  });

  it('every theme has a label and a distinct id', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of THEMES) {
      expect(theme.label.trim()).not.toBe('');
    }
  });

  // 'system' has no palette of its own, and 'light' IS the baseline palette
  // on bare :root.
  const withOwnBlock = THEMES.filter((t) => t.id !== 'system' && t.id !== 'light');

  it('choosing Light is honoured even on a dark desktop', () => {
    // The whole mechanism for the light choice is this guard.
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).not.toContain(':root[data-theme="light"]');
  });

  for (const theme of withOwnBlock) {
    it(`"${theme.id}" has a stylesheet block`, () => {
      expect(variablesIn(`:root[data-theme="${theme.id}"] {`)).not.toBeNull();
    });

    it(`"${theme.id}" defines every colour the baseline does`, () => {
      // A theme that redefines only some variables inherits the rest from the
      // light baseline.
      const declared = variablesIn(`:root[data-theme="${theme.id}"] {`);
      const missing = [...baseline].filter((name) => !declared.has(name));
      expect(missing).toEqual([]);
    });
  }

  it('no theme is defined only inside a media query', () => {
    for (const theme of withOwnBlock) {
      const selector = `:root[data-theme="${theme.id}"] {`;
      const index = css.indexOf(selector);
      const before = css.slice(0, index);
      // Balanced braces before the selector means it sits at the top level.
      const depth = (before.match(/{/g) ?? []).length - (before.match(/}/g) ?? []).length;
      expect(depth).toBe(0);
    }
  });
});
