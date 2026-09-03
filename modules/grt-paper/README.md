# GRT Paper

A word processor. Runs entirely on your machine, never opens a network
connection, and exports a PDF with no metadata in it.

Part of the [GRT Suite](../../README.md). Design document:
[GRT_PAPER.md](GRT_PAPER.md).

## The decision this module is built on

The document is a data model. The DOM is only how it is drawn:

    input → command → model → render

The tempting alternative, let `contenteditable` own the document and read the
HTML back, starts faster and then falls apart, because every engine produces
different markup and the two webviews this suite targets disagree about what
they just built. `document.execCommand` is not used anywhere here, for the same
reason: it is deprecated, behaves differently on each engine, and produces
markup nobody controls.

That costs more work up front. It is the difference between an editor that
holds together and one that has to be rewritten.

## What it does

- Paragraph styles: body, four heading levels, quote, code
- Bold, italic, underline, strikethrough, superscript, subscript
- Alignment, bulleted and numbered lists with levels, images
- Pages, with real margins and page breaks that fall where a typesetter would
  put them; a heading is never left alone at the foot of a page, and a
  paragraph is only split when at least two lines land on each side
- Find and replace, with regular expressions
- Table of contents built from the headings
- Word and character count
- Export to PDF, HTML, Markdown and plain text
- The same five themes and the same `Ctrl+K` palette as the rest of the suite

## Checking the claims

```bash
npm test
../../scripts/check-build.sh src-tauri/target/release/grt-paper
```

`tests/selection.test.js` is the important one. §10 of the design document says
steps 3 to 5 are the heart of the module and that nothing should proceed until
that battery is green, so the file goes after the cases that break editors: a
selection spanning three blocks deleted and undone, a selection dragged
backwards, Backspace at the start of a paragraph, Enter inside a list item.

`tests/paste.test.js` covers the other rule that matters: pasting HTML from a
web page must introduce nothing into the model that the model does not define.
Scripts, styles, iframes, inline handlers and remote image addresses are all
dropped, and the check that proves it is itself tested for being able to fail.

## Installing

```bash
npm install
npm run build
./scripts/install-local.sh
```

No root needed. `./scripts/install-local.sh --remove` undoes it.

## Licence

MIT. See [LICENSE](../../LICENSE).

## Looking at it

```bash
./scripts/preview.sh
```

Serves the real interface on `http://localhost:8724` with the backend stubbed,
so the window can be looked at in a browser. jsdom has no layout engine, so no
test can see that something is in the wrong place, and running this found
the toolbar scrolling off the top of a narrow window,
with no way to scroll back to it.

The stub that answers the backend is `scripts/preview-stub.js`. Stylesheets and
scripts are served through links, so a reload picks up an edit.
