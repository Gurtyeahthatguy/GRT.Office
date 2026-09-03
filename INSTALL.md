# Installing the GRT suite

The suite is **eight separate programs**, not one package. Each builds,
installs and uninstalls on its own, and none of them needs any of the others.
Install the ones that are wanted and ignore the rest.

All eight are at version **0.1.0**.

| Program | Binary | What it is | Opens |
|---|---|---|---|
| GRT Read | `grt-read` | PDF reader and editor | `.pdf` |
| GRT Graphs | `grt-graphs` | Diagrams and node graphs | `.grt` |
| GRT Slides | `grt-slides` | Presentations | `.grt`, imports `.pptx` |
| GRT Paper | `grt-paper` | Word processor | `.grt` |
| GRT Dates | `grt-dates` | Calendar and tasks | `.ics` |
| GRT Notes | `grt-notes` | Notebooks and notes | `.grt` |
| GRT Grid | `grt-grid` | Spreadsheet | `.grt`, imports `.csv` |
| GRT Tables | `grt-tables` | Database | `.grt`, `.sqlite` |

Everywhere below, replace `grt-read` with whichever program is wanted.

---

## The short way: download one

Every release carries a ready-made file for each of the eight programs, on both
platforms. Nothing else has to be installed to use them.

**Linux.** Take the `.AppImage`. It is one file, it needs no installation and no
administrator rights, and it runs from anywhere, including a USB stick:

```bash
chmod +x grt-read-0.1.0-linux-x86_64.AppImage
./grt-read-0.1.0-linux-x86_64.AppImage
```

The `.deb` and `.rpm` beside it are for installing through the package manager
instead, which puts the program in the application menu:

```bash
sudo apt install ./grt-read-0.1.0-linux-x86_64.deb     # Debian, Ubuntu
sudo dnf install ./grt-read-0.1.0-linux-x86_64.rpm     # Fedora
```

The AppImage is about 78 MB against 1 to 3 MB for the packages, because it
carries its own copy of WebKitGTK instead of using the one the system has.

**Windows.** Take `grt-read-0.1.0-windows-x86_64-setup.exe` and run it. The
plain `grt-read-0.1.0-windows-x86_64.exe` beside it is the same program with no
installer, for a portable copy.

**Checking the download.** Every release includes `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS
```

Every Linux binary in a release passed `scripts/check-build.sh` before it was
uploaded. See *Checking what was installed* below for running that, and the
socket trace, yourself.

The rest of this file is for building from source.

---

## Linux

### Requirements

Building needs Node, Rust, and the WebKitGTK development libraries. On Debian
and Ubuntu:

```bash
sudo apt install build-essential curl file pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Then Node 22 or later, and Rust from [rustup.rs](https://rustup.rs):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

The package names differ elsewhere. On Fedora the equivalents are
`webkit2gtk4.1-devel`, `gtk3-devel`, `libappindicator-gtk3-devel`,
`librsvg2-devel`, `openssl-devel`, `patchelf` and the `@development-tools`
group. On Arch they are `webkit2gtk-4.1`, `gtk3`, `libayatana-appindicator`,
`librsvg`, `openssl`, `patchelf` and `base-devel`. Those two lists are the
standard prerequisites for this kind of application, but the suite has only
ever been built on Debian-family systems, so treat them as a starting point.

`patchelf` is only needed to produce an AppImage. Leave it out otherwise.

### Building

```bash
git clone <the repository URL>
cd "GRT Suite/modules/grt-read"
npm ci
npm run build
```

The first build of any module compiles the whole Rust dependency tree and
takes several minutes. Later builds are much faster. Every module after the
first is quicker still, because Cargo reuses what it has already compiled.

`npm run build` runs `sync-core.mjs` first, which copies the shared frontend
core into the module. That is why `src/js/core/` is missing from a fresh clone
and appears during the build.

The result is a binary at `src-tauri/target/release/grt-read`, plus the
packages described below.

Every command in this section was run from a fresh clone before this file was
written, on Ubuntu 26.04.

### Running the tests

```bash
npm test
```

Use `npm test`, not `npx vitest`. The `pretest` hook is what copies the shared
core into place, and without it the imports do not resolve.

### Three ways to install

**Into the home directory, without administrator rights.** This is the simplest
one and the easiest to undo.

```bash
npm run build
./scripts/install-local.sh
```

It copies the binary to `~/.local/bin`, installs the icons, and writes a
launcher so the program appears in the application menu. It lists itself as
*an* option for its file types without making itself the default: which program
opens a file stays the user's choice.

**As a `.deb` or `.rpm` package**, which needs `sudo`:

```bash
npm run tauri build -- --bundles deb
sudo apt install "./src-tauri/target/release/bundle/deb/GRT Read_0.1.0_amd64.deb"

npm run tauri build -- --bundles rpm
sudo dnf install "./src-tauri/target/release/bundle/rpm/GRT Read-0.1.0-1.x86_64.rpm"
```

The packages are between 1 MB and 3 MB. They depend on the WebKitGTK runtime
being installed, which it is on any desktop system that has a browser
component, and the package manager will pull it in if not.

**As an AppImage**, a single file that needs nothing installed:

```bash
npm run tauri build -- --bundles appimage
chmod +x "src-tauri/target/release/bundle/appimage/GRT Read_0.1.0_amd64.AppImage"
```

It runs from anywhere, including a USB stick and a machine that is not yours.
The cost is size: about 78 MB against 1 to 3 MB for the `.deb`, because it
carries its own copy of WebKitGTK.

Two things worth knowing about the AppImage. The bundler downloads its own
tooling (`linuxdeploy` and friends) into `~/.cache/tauri/` the first time it
runs, so **that one build step uses the network** even though nothing in the
finished program ever does. And running an AppImage needs FUSE; on systems
without it, `./GRT\ Read_0.1.0_amd64.AppImage --appimage-extract-and-run`
works instead.

Running `npm run build` with no arguments produces all three together.

### Removing

```bash
./scripts/install-local.sh --remove     # the home-directory install
sudo apt remove grt-read                # the .deb
sudo dnf remove grt-read                # the .rpm
rm grt-read-0.1.0-linux-x86_64.AppImage # the AppImage
```

None of those touch the settings. To remove those as well, see
*Where each program keeps its settings* below.

---

## Windows

**Not yet verified by a person.** The suite has been built and run on Linux
only. Windows binaries are produced by the release workflow, but nobody has
opened one. Expect to have to solve something, and say so if you do.

### Requirements

1. **Visual Studio Build Tools** with the *Desktop development with C++*
   workload. Two of the programs (GRT Notes and GRT Tables) compile SQLite from
   source, so a C compiler is not optional.
2. **Rust**, from [rustup.rs](https://rustup.rs), using the default
   `x86_64-pc-windows-msvc` toolchain.
3. **Node 22** or later, from [nodejs.org](https://nodejs.org).
4. **WebView2**, which is part of Windows 11 and of any updated Windows 10. If
   it is missing, Microsoft's Evergreen Bootstrapper installs it.

### Building

The commands are the same as on Linux. In PowerShell:

```powershell
git clone <the repository URL>
cd "GRT Suite\modules\grt-read"
npm ci
npm run build
```

### Installing

The build produces an installer under
`src-tauri\target\release\bundle\nsis\`, named something like
`GRT Read_0.1.0_x64-setup.exe`. Run it and the program installs for the current
user, with a Start menu entry.

The plain executable at `src-tauri\target\release\grt-read.exe` also runs on
its own, with no installation, if a portable copy is preferred.

Windows will warn that the program is from an unknown publisher, because it is
not code-signed. Signing needs a certificate bought from a certificate
authority, which is a decision that has not been taken.

### Removing

Through *Settings, Apps, Installed apps*, or by deleting the portable
executable.

---

## Where each program keeps its settings

One small `settings.json` per program, and nothing else.

| System | Path |
|---|---|
| Linux | `~/.config/org.grt.<name>/settings.json` |
| Windows | `%APPDATA%\org.grt.<name>\settings.json` |

`<name>` is the program's own: `org.grt.read`, `org.grt.graphs`, and so on.
Deleting the file returns the program to how it was on first run. Each program
also offers this from its settings panel.

Documents are wherever they were saved. No program keeps a library, an index of
recent files, or a database of its own outside these paths, with two
exceptions that are documented in their own READMEs: GRT Notes keeps a search
index beside its archive, and GRT Dates keeps its calendars as ordinary `.ics`
files in a folder.

### Ephemeral mode

Started with `--ephemeral`, a program reads no settings and writes none:

```bash
grt-read --ephemeral
```

Nothing at all is left behind on the machine.

---

## Checking what was installed

The suite's central claim is that it does not talk to the network and does not
write identifying information into files. Both are checkable, and the scripts
to do it are in the repository rather than in a document.

```bash
./scripts/check-build.sh modules/grt-read/src-tauri/target/release/grt-read
```

That reads the finished binary and reports on four things: absolute build paths
that would name the machine that compiled it, references to network hosts,
telemetry libraries, and debug symbols.

```bash
cd modules/grt-read
./scripts/check-network.sh src-tauri/target/release/grt-read
```

That runs the program under `strace` and reports every socket it opens. It
exists only in GRT Read for now.

```bash
node modules/grt-read/scripts/show-metadata.mjs file.pdf
```

That prints a PDF's metadata, so a file can be compared before and after the
program has touched it.

---

## Troubleshooting

**The window comes up blank on Linux.** This is the WebKitGTK DMA-BUF
renderer, not the program. Start it with:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 grt-read
```

**`npm run build` fails on a missing `webkit2gtk-4.1`.** The development
libraries are missing; see *Requirements* above. Note the `4.1`: the older
`4.0` packages will not do.

**The build fails on Windows with a linker error.** The Visual Studio Build
Tools are missing the C++ workload, or Rust installed the GNU toolchain
instead of MSVC. `rustup default stable-x86_64-pc-windows-msvc` fixes the
second.

**The AppImage will not start.** FUSE is missing. Either install it, or run
the file with `--appimage-extract-and-run`.

**The program does not appear in the application menu after
`install-local.sh`.** Some desktops cache the menu. Logging out and back in
rebuilds it.

**`grt-read` is not found in a terminal** after a home-directory install.
`~/.local/bin` is not on the `PATH`. The menu entry works regardless; to fix
the terminal, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc`.

---

## Building all eight at once

There is no top-level build, on purpose: the programs are separate. This does
the lot on Linux:

```bash
for m in read graphs slides paper dates notes grid tables; do
  ( cd "modules/grt-$m" && npm ci && npm run build ) || echo "FAILED: $m"
done
```

Expect it to take a while on a first run. The eight `.deb` packages then sit
under each module's `src-tauri/target/release/bundle/deb/`.
