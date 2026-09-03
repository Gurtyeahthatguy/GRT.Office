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

// Libraries every module needs go the same way.
const vendor = join(repo, target, 'src', 'vendor');
mkdirSync(vendor, { recursive: true });
cpSync(join(repo, 'core', 'vendor'), vendor, { recursive: true });
console.log(`vendor → ${target}/src/vendor`);
