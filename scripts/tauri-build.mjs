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
if (run.status === 0) {
  repackDebs();
  slimAppImages();
}
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
/**
 * Each AppImage made lighter: it uses the WebKitGTK and GTK the system has, as the packages do, instead of a copy of
 * its own, which weighs some 80 MB. It is packed again with the runtime and the appimagetool the bundler already
 * fetched, so this step uses no network.
 */
function slimAppImages() {
  const folder = resolve(process.cwd(), 'src-tauri/target/release/bundle/appimage');
  if (!existsSync(folder)) return;
  const plugin = resolve(home, '.cache/tauri/linuxdeploy-plugin-appimage.AppImage');
  for (const name of readdirSync(folder).filter((n) => n.endsWith('.AppImage'))) {
    const file = join(folder, name);
    if (statSync(file).mtimeMs < started || !existsSync(plugin)) continue;
    // On disk beside the build, since /tmp may be too small for an unpacked AppImage.
    const work = resolve(process.cwd(), 'src-tauri/target/appimage-slim');
    rmSync(work, { recursive: true, force: true });
    try {
      spawnSync('mkdir', ['-p', work]);
      const run = (command, args, options = {}) => spawnSync(command, args, { cwd: work, stdio: 'ignore', ...options }).status === 0;
      if (!run(file, ['--appimage-extract'])) continue;
      renameSync(join(work, 'squashfs-root'), join(work, 'AppDir'));
      const offset = Number(spawnSync(file, ['--appimage-offset'], { encoding: 'utf8' }).stdout.trim());
      if (!(offset > 0)) continue;
      writeFileSync(join(work, 'runtime'), readFileSync(file).subarray(0, offset));
      cpSync(plugin, join(work, 'plugin.AppImage'));
      spawnSync('chmod', ['+x', join(work, 'plugin.AppImage')]);
      if (!run(join(work, 'plugin.AppImage'), ['--appimage-extract'])) continue;
      renameSync(join(work, 'squashfs-root'), join(work, 'tools'));
      const appdir = join(work, 'AppDir');
      const binary = readdirSync(join(appdir, 'usr/bin'))[0];
      // The libraries, the hooks that point GTK at them, and the launcher that sets them up all go.
      for (const gone of ['usr/lib', 'usr/share/doc', 'usr/share/glib-2.0', 'apprun-hooks', 'AppRun', 'AppRun.wrapped']) rmSync(join(appdir, gone), { recursive: true, force: true });
      writeFileSync(join(appdir, 'AppRun'), appRun(binary, name.replace(/_.*$/, '')), { mode: 0o755 });
      const tool = join(work, 'tools/appimagetool-prefix/usr/bin');
      const packed = `${file}.slim`;
      const ok = spawnSync(join(tool, 'appimagetool'), ['--no-appstream', '--runtime-file', join(work, 'runtime'), appdir, packed], {
        cwd: work, stdio: 'ignore', env: { ...process.env, ARCH: 'x86_64', PATH: `${tool}:${process.env.PATH}` },
      }).status === 0;
      if (ok) renameSync(packed, file);
      else rmSync(packed, { force: true });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/** The AppImage's launcher: the program, with the system's WebKitGTK, and a plain word when there is none. */
function appRun(binary, title) {
  return `#!/bin/sh
# ${title}: runs with the WebKitGTK the system has.
here="$(dirname "$(readlink -f "$0")")"
found=no
for dir in /usr/lib/x86_64-linux-gnu /usr/lib64 /usr/lib /lib/x86_64-linux-gnu; do
  [ -e "$dir/libwebkit2gtk-4.1.so.0" ] && found=yes && break
done
if [ "$found" = no ] && ! /sbin/ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1.so.0'; then
  message="${title} needs WebKitGTK 4.1. On Debian and Ubuntu: sudo apt install libwebkit2gtk-4.1-0. On Fedora: sudo dnf install webkit2gtk4.1."
  echo "$message" >&2
  command -v notify-send >/dev/null 2>&1 && notify-send "${title}" "$message"
  exit 1
fi
exec "$here/usr/bin/${binary}" "$@"
`;
}

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
