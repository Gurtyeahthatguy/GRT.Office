#!/usr/bin/env node
/** Runs `tauri build` with every build path rewritten so that it names no one. */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir();
const cargo = process.env.CARGO_HOME ? resolve(process.env.CARGO_HOME) : resolve(home, '.cargo');

// Later rules win, so the most specific come last.
const remaps = [
  ['/home', '/redacted'],
  ['/Users', '/redacted'],
  [home, '/redacted/home'],
  [cargo, '/redacted/cargo'],
  [root, '/redacted/grt'],
];

const flags = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
const args = process.argv.slice(2);
const env = { ...process.env };
let extra = [];
if (args.includes('cargo-xwin')) {
  // cargo-xwin reads RUSTFLAGS and joins flags with spaces, so a flag with a space in it cannot pass.
  env.RUSTFLAGS = [env.RUSTFLAGS ?? '', ...flags.filter((flag) => !/\s/.test(flag))].join(' ').trim();
} else {
  // As configuration, a path with spaces stays whole and adds to the flags in .cargo/config.toml.
  extra = [...(args.includes('--') ? [] : ['--']), '--config', `build.rustflags=[${flags.map((f) => JSON.stringify(f)).join(',')}]`];
}

// The CLI is started through Node itself, so no shell splits the arguments.
const cli = resolve(process.cwd(), 'node_modules/@tauri-apps/cli/tauri.js');
const started = Date.now();
const staged = stageFrontend();
// Tauri's own configuration goes before the `--` that hands the rest to cargo.
// Relative to tauri.conf.json, as Tauri embeds the value and an absolute path would carry the user's name.
const frontend = staged ? ['--config', JSON.stringify({ build: { frontendDist: relative(resolve(process.cwd(), 'src-tauri'), staged) } })] : [];
const run = spawnSync(process.execPath, [cli, 'build', ...frontend, ...args, ...extra], { stdio: 'inherit', env });
if (run.status === 0) repackDebs();
process.exit(run.status ?? 1);

/**
 * The page as it ships: a copy of src with our scripts and sheets minified, names kept, the vendored libraries as they are.
 * The source stays readable; only what goes into the program is smaller.
 */
function stageFrontend() {
  let esbuild;
  try {
    esbuild = createRequire(resolve(process.cwd(), 'package.json'))('esbuild');
  } catch {
    return null;
  }
  const source = resolve(process.cwd(), 'src');
  const target = resolve(process.cwd(), 'src-tauri/target/frontend');
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const file = join(folder, name);
      if (statSync(file).isDirectory()) {
        if (name !== 'vendor') walk(file);
        continue;
      }
      const loader = name.endsWith('.js') ? 'js' : name.endsWith('.css') ? 'css' : null;
      if (!loader) continue;
      const code = readFileSync(file, 'utf8');
      const out = esbuild.transformSync(code, { loader, minify: true, keepNames: true, legalComments: 'inline', charset: 'utf8', target: 'es2022' });
      writeFileSync(file, out.code);
    }
  };
  walk(target);
  return target;
}

/** The .deb packages just made, packed again with xz: a fifth smaller than the gzip Tauri uses, and dpkg reads both. */
function repackDebs() {
  const folder = resolve(process.cwd(), 'src-tauri/target/release/bundle/deb');
  if (!existsSync(folder) || spawnSync('dpkg-deb', ['--version']).status !== 0) return;
  for (const name of readdirSync(folder).filter((n) => n.endsWith('.deb'))) {
    const file = join(folder, name);
    if (statSync(file).mtimeMs < started) continue;
    const work = mkdtempSync(join(tmpdir(), 'grt-deb-'));
    try {
      const tree = join(work, 'tree');
      if (spawnSync('dpkg-deb', ['-R', file, tree]).status !== 0) continue;
      // Beside the original, so the rename stays on one file system.
      const packed = `${file}.repacked`;
      if (spawnSync('dpkg-deb', ['-Zxz', '-z9', '--root-owner-group', '-b', tree, packed], { stdio: 'ignore' }).status !== 0) {
        rmSync(packed, { force: true });
        continue;
      }
      renameSync(packed, file);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
