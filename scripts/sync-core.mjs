/** Copies the shared frontend core into a module. */

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];

if (!target) {
  console.error('Usage: node scripts/sync-core.mjs <module-directory>');
  process.exit(2);
}
// Only a module of this repository takes the copy, wherever the script is run from.
if (!/^modules\/grt-[a-z]+\/?$/.test(target)) {
  console.error(`Not a module of the suite: ${target}`);
  process.exit(2);
}

const destination = join(repo, target, 'src', 'js', 'core');

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(join(repo, 'core', 'js'), destination, { recursive: true });
console.log(`core → ${target}/src/js/core`);

// The design system's sheet, which each page loads before its own.
cpSync(join(repo, 'core', 'css', 'design.css'), join(repo, target, 'src', 'css', 'design.css'));
console.log(`design → ${target}/src/css/design.css`);

// Libraries every module needs go the same way.
const vendor = join(repo, target, 'src', 'vendor');
mkdirSync(vendor, { recursive: true });
cpSync(join(repo, 'core', 'vendor'), vendor, {
  recursive: true,
  filter: (source) => !source.endsWith('VERSIONS.txt'),
});
console.log(`vendor → ${target}/src/vendor`);

// MathJax goes only where formulas are shown, so the other programs do not carry its weight.
if (['modules/grt-paper', 'modules/grt-slides', 'modules/grt-notes'].includes(target.replace(/\/$/, ''))) {
  cpSync(join(repo, 'core', 'vendor-math'), vendor, { recursive: true, filter: (source) => !source.endsWith('VERSIONS.txt') });
  console.log(`vendor-math → ${target}/src/vendor`);
}

// The Chinese conversion tables go only to Paper, the program with Tools > Language.
if (target.replace(/\/$/, '') === 'modules/grt-paper') {
  cpSync(join(repo, 'core', 'vendor-lang'), vendor, { recursive: true, filter: (source) => !source.endsWith('VERSIONS.txt') });
  console.log(`vendor-lang → ${target}/src/vendor`);
}

// Graphs' test mode works out its conditions with Grid's formulas, so Grid's engine goes there too, at the same depth.
if (target.replace(/\/$/, '') === 'modules/grt-graphs') {
  const grid = join(repo, 'modules', 'grt-grid', 'src', 'js');
  const js = join(repo, target, 'src', 'js');
  for (const part of ['parser', 'functions', 'format.js', 'references.js']) {
    rmSync(join(js, part), { recursive: true, force: true });
    cpSync(join(grid, part), join(js, part), { recursive: true });
  }
  rmSync(join(js, 'engine'), { recursive: true, force: true });
  mkdirSync(join(js, 'engine'), { recursive: true });
  for (const file of ['evaluate.js', 'values.js']) cpSync(join(grid, 'engine', file), join(js, 'engine', file));
  console.log(`grid formulas → ${target}/src/js`);
}
