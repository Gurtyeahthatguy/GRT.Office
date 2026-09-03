# GRT Read

Reads and edits PDF files. Runs entirely on your machine, never opens a
network connection, and rebuilds every file it saves from scratch so that
what you removed is actually gone.

Part of the [GRT Suite](../../README.md).

## What it does

- View, scroll and zoom PDF documents
- Rotate, delete, reorder, crop and extract pages
- Append one PDF to another, or split one into several
- Add a watermark or page numbers
- Highlight regions, or **redact** them, see below
- Search the text of a document
- Undo and redo every structural change
- Strip metadata from anything it writes, or set it deliberately
- Show you what a file will contain, before it is written
- Five themes: follow the desktop, light, dark, gold, purple

### Redaction

Press `R`, drag a rectangle, save. The text under it is **deleted from the
page's content stream** before the file is written; the black box is drawn
afterwards and is only decoration.

This is the difference that matters. Drawing a black rectangle over text, what
most tools do, and what every leaked "redacted" document did, leaves the words
in the file for anyone with a parser. `tests/redaction.test.js` asserts that
redacted text cannot be recovered from the output, with every stream inflated
and every hex string decoded, and it carries a canary proving the check can
still fail.

Two things are deliberately conservative. Where the geometry is uncertain the
program removes more rather than less: losing a word that sat just outside the
box is visible and annoying, while keeping one inside it is the failure the
feature exists to prevent. And after rewriting, the stream is searched for the
text that was supposed to be gone, if anything survives, the save is refused
rather than completed quietly.

Highlight (`H`) is the opposite and says so in the fingerprint panel: it draws
over the page and removes nothing.

Not implemented: password protection. It is listed as a cheap feature in the
design document, on the assumption that pdf-lib could do it. pdf-lib has no
encryption support at all; it can only report that a file is encrypted. Doing
it would mean a new dependency or an implementation in Rust, and neither is a
decision to make silently.

## The two claims, and how to check them

Software that asks to be trusted with private documents should be checkable.
Both of the claims below can be verified with commands in this repository,
you are not asked to take either on faith.

### "It never uses the network"

```
npm run build
./scripts/check-network.sh src-tauri/target/release/grt-read
```

Runs the program under `strace` and reports every socket it opens. Use it
normally: open a file, edit, save, then close it. Anything other than local
sockets between the window and its own webview would show up.

Statically, on the built binary:

```
../../scripts/check-build.sh src-tauri/target/release/grt-read
```

This looks for absolute build paths, URLs, telemetry library names and debug
symbols. No updater, crash reporter or analytics library is compiled in, and
neither the HTTP nor the shell plugin is part of the build at all.

### "It removes metadata"

```
node scripts/show-metadata.mjs before.pdf
node scripts/show-metadata.mjs after.pdf
```

Prints the `/Info` dictionary, XMP presence, trailer count, known generator
strings, and any embedded images still carrying EXIF. Run it on a file you
own, then on the copy GRT Read saved.

The same guarantee is enforced by the test suite:

```
npm test
```

`tests/regeneration.test.js` is the one that matters. It expands every
compressed stream and decodes every hex string in the output before searching
it, because a naive byte search is not capable of failing, see the comment
at the top of `tests/helpers.js`.

## Building

Requirements: Node, Rust, and the WebKitGTK development libraries.

```
npm install
npm run vendor      # copies PDF.js and pdf-lib into src/vendor
npm run dev         # development window
npm run build       # release binary
```

`npm run vendor` only needs re-running when the pinned library versions in
`package.json` change. The vendored copies are committed: the program loads
them from `src/vendor`, never from `node_modules` and never from a CDN.

If the window comes up blank on Linux, it is the WebKitGTK DMA-BUF renderer,
not the program:

```
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run dev
```

## Looking at it

```bash
./scripts/preview.sh
```

Serves the real interface on `http://localhost:8721` with the backend stubbed,
so the window can be looked at in a browser. jsdom has no layout engine, so no
test can see that something is in the wrong place, and running this found
the toolbar scrolling off the top of a narrow window,
with no way to scroll back to it.

The stub that answers the backend is `scripts/preview-stub.js`. Stylesheets and
scripts are served through links, so a reload picks up an edit.

## Keyboard

| | |
|---|---|
| `Ctrl+O` | open |
| `Ctrl+S` / `Ctrl+Shift+S` | save / save as |
| `Ctrl+F` | search |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `Del` | delete the selected pages |
| `Ctrl+K` | command palette: every command, with fuzzy search |
| `Ctrl+,` | settings |
| `Esc` | clear the selection |

Click a thumbnail to select a page, `Ctrl+click` to add to the selection,
`Shift+click` for a range, and drag one to reorder.

## Installing

Two ways, neither of which needs the other.

**Without administrator rights**, into your own home directory:

```
npm run build
./scripts/install-local.sh
```

That copies the binary to `~/.local/bin`, installs an icon, and writes a
launcher, so the program appears in the application menu and can open PDFs
through "Open With". It does not make itself the default PDF handler, which
program opens your files is your decision. `./scripts/install-local.sh --remove`
undoes all of it.

**As a package**, which does need `sudo` to install:

```
npm run tauri build -- --bundles deb
sudo dpkg -i src-tauri/target/release/bundle/deb/*.deb
```

**As a single portable file**, which needs nothing installed at all:

```
sudo apt install patchelf          # build-time only, once
npm run tauri build -- --bundles appimage
```

The AppImage runs from wherever you put it; a USB stick, another machine,
with no installation. It is about 80 MB, against 3.4 MB for the `.deb`,
because it carries its own copy of WebKitGTK (90 MB uncompressed on its own).
That is the price of not depending on what the host has installed. Prefer the
`.deb` or the local install on a machine you control; keep the AppImage for
machines you do not.

## Settings

`Ctrl+,` opens them: theme, thumbnail sidebar, zoom on opening, and whether the
fingerprint panel appears before each save.

Themes are **System**, **Light**, **Dark**, **Gold**, a warm low-contrast
light palette, easier on the eyes beside a page of white paper, and
**Purple**, a deeper dark for a dim room. Only System follows the desktop; the
rest stay put whatever the desktop does.

They are stored as a single `settings.json` in the platform's configuration
directory, holding those four values and nothing else. There is no recent-files
list and no session history, so the file describes the window and not the
person using it.

Started with `--ephemeral`, the program reads no settings and writes none. That
refusal lives in the Rust backend rather than the interface: a promise the UI
has to remember to keep is not a promise.

## Third-party code

`src/vendor/` holds PDF.js (Apache-2.0) and pdf-lib (MIT), copied verbatim
from the releases listed in `src/vendor/VERSIONS.txt`. Low-level PDF parsing
uses them; the interface, the document model, the save pipeline and
everything touching metadata is this project's own code.

## Licence

MIT. See [LICENSE](../../LICENSE).
