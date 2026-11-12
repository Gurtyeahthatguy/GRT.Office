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
