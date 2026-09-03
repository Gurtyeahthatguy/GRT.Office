# GRT Slides

Makes and projects presentations. Runs entirely on your machine, never opens a
network connection, and exports a single HTML file that opens anywhere with
nothing installed.

Part of the [GRT Suite](../../README.md). Design document:
[GRT_SLIDES.md](GRT_SLIDES.md).

## What it does

- Slides with text boxes, images and shapes placed freely
- Rich text in place: bold, italic, underline, named styles
- Colours and fonts you control: deck background and accent, per-style size,
  colour, font and alignment, per-slide background, per-element overrides
- Four ready-made looks. Paper, Ink, Parchment, Terminal
- Transitions: none, fade or slide, per slide or across the deck
- Multiple selection, resize handles, rotation snapped to 15°, alignment
  guides including the slide's own centre lines
- Thumbnail panel with drag reordering, duplicate and delete
- Speaker notes per slide
- Masters: a background slide whose elements appear on every slide that uses it
- Undo and redo, where one drag is one entry
- Seven shapes and lines, the same vocabulary as GRT Graphs
- Tables: a static grid, edited cell by cell, Tab to move along
- Sections to group slides in the panel, useful past about thirty of them
- Fonts of your own, carried inside the document and optionally embedded in
  the HTML export
- Slide sizes: 16:9, 4:3, A4 either way, or anything you type
- **Projection mode**: `F5`, and a **presenter view** for a second screen
- Reads PowerPoint files, and tells you what it could not convert
- Export to a self-contained HTML file, to PDF, or to SVG
- The same five themes and the same `Ctrl+K` palette as the rest of the suite

## Making it look like yours

**Design** sets the whole deck: background, accent, and for each of the three
named styles the size, colour, font and alignment. Changing the "title" style
changes every title; that is what keeps a deck coherent rather than
hand-assembled.

**Slide** overrides the background and the transition for the slide you are on.
Selecting elements and choosing *Colour of the selection* from `Ctrl+K`
overrides the text colour, shape fill or font for those alone.

Fonts are the system's own three families. Embedding one would make an export
self-sufficient, but font files carry metadata of their own and inflate every
file; an open question rather than a silent decision.

## Projecting

`F5` presents from the first slide, `Shift+F5` from the current one. In
projection there is no interface on screen at all:

| | |
|---|---|
| `→` `↓` `Space` `PageDown` | next |
| `←` `↑` `PageUp` | previous |
| `Home` `End` | first, last |
| a number | jump to that slide |
| `B` / `W` | black screen / white screen |
| `Esc` | leave |

`B` and `W` are standard practice: they move the room's attention off the
screen without stopping the presentation. The screensaver is held off while
you present.

## The presenter view

Opens as a second window: the current slide, the next one, the notes, and a
clock you can pause and reset. Its arrow keys move both screens. Put it on your
laptop and the projection on the projector.

The two windows share no state; they talk over events, so closing the
presenter view in the middle of a talk leaves the projection exactly where it
was.

## Fonts of your own

*Add a font…* from `Ctrl+K` takes a `.ttf`, `.otf`, `.woff` or `.woff2` file
and carries it inside the document, so the deck looks the same on a machine
that has never seen that font.

Before accepting it, the program shows what the font says about itself,
foundry, designer, version, licence. That is **reported rather than removed**:
the name table carries the licence, and many font licences require the notice
to be kept. Nothing in it identifies you, so stripping it would trade a problem
you do not have for one you would not know about.

Embedding into the HTML export is a checkbox, because it adds a few hundred
kilobytes per family.

## Reading PowerPoint files

Partial, and honest about it. Open a `.pptx` and the import reports, in a list,
everything it could not bring across: grouped shapes, tables, charts, SmartArt,
transitions, the theme. An import that silently drops half a deck is worse than
one that refuses, because the loss is discovered in front of an audience.

There is no `.pptx` export, deliberately. For sending a finished presentation,
PDF and the self-contained HTML lose nothing, because neither tries to stay
editable.

## The HTML export

One file. Images inlined, keyboard navigation included, no network resource of
any kind, so it opens on a phone, on someone else's laptop, on a machine with
nothing installed. More portable than a `.pptx`, and it costs almost nothing
to produce because the editor already renders in HTML.

It carries no software name, no comment and no date, and it is built from the
document rather than from what is on screen, so there are no editing artefacts
to leak. `tests/export.test.js` checks all of that.

## Checking the claims

```bash
npm test
../../scripts/check-build.sh src-tauri/target/release/grt-slides
```

The tests cover what the design document asks for: two saves produce identical
bytes, the exported HTML carries no identifying metadata, the exported PDF has
its metadata cleared, deleting a slide and undoing it restores everything, and
a drag produces one undo entry.

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

Serves the real interface on `http://localhost:8723` with the backend stubbed,
so the window can be looked at in a browser. jsdom has no layout engine, so no
test can see that something is in the wrong place, and running this found
the toolbar scrolling off the top of a narrow window,
with no way to scroll back to it.

The stub that answers the backend is `scripts/preview-stub.js`. Stylesheets and
scripts are served through links, so a reload picks up an edit.
