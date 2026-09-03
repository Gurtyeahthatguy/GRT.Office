# GRT Notes

Notebooks of notes, kept on your own disk, searchable across the whole archive.

Part of [GRT Suite](../../README.md). Design document:
[docs/GRT_NOTES_DATES.md](../../docs/GRT_NOTES_DATES.md), Part I.

## What it does

- Notebooks, sections and notes, as folders and files
- The same editor as GRT Paper, formatting, undo, paste handling
- Three blocks a document does not have: a checkable **to-do**, a **callout**,
  and an **embed** pointing at another document in the suite
- **Tags**, stored in the note itself
- **Search across everything**, by words or by regular expression
- **`[[links]]` between notes**, with completion while typing and a panel
  showing what points here
- **Quick note** for writing something down without deciding where it goes
- Markdown export, of one note or of the whole archive
- Five themes, shared with the rest of the suite, and the `Ctrl+K` palette

Saving is automatic. There is no Save button.

## Where your notes live

Ordinary folders and files, by default under `GRT Notes` in your documents
directory:

```
GRT Notes/
├── University/              a notebook
│   ├── Philosophy/          a section
│   │   ├── 001-kant.grt
│   │   └── 002-hume.grt
│   └── Informatica/
│       └── 001-reti.grt
└── Projects/
    └── 001-ideas.grt
```

**The archive is the filesystem.** There is no database of what exists, because
the directory listing *is* what exists. A note can be copied, moved, backed up,
put in version control, or opened by something else. A corrupted file loses one
note rather than everything. Nothing has to be kept in step, because there is
only one copy of the structure.

The number in each file name is what orders the notes. It is in the name rather
than in a hidden field so that it survives being copied somewhere else and is
visible in any file manager.

## The editor is GRT Paper's

Not a copy of it; the same files. `core/js/editor/` holds the model, the
selection, the commands and the renderer, and both modules import them. That is
why Notes came after Paper: a note and a page are the same thing underneath,
and two copies of two thousand lines of selection handling would have drifted
apart within a month.

What a note drops is the expensive part: **there is no pagination.** A note is
text that scrolls.

## Search

A SQLite FTS5 index, because opening several hundred containers to answer a
search is the difference between instant and unusable.

**The index is derived and disposable.** It never holds the only copy of
anything; deleting it costs a rescan and nothing else. There is a command in
the palette that does exactly that.

**It is as sensitive as the notes.** It contains their text in searchable form,
so it lives in this program's own data directory, never in a temporary folder,
where it would sit outside whatever disk encryption you have arranged, and
never beside the archive, where a backup meant to be portable would carry it
along. In ephemeral mode there is no file at all: the index is held in memory
and goes when the program does. "Forget settings" deletes it too.

Notes changed by another program are noticed, because the comparison is against
the file's modification time rather than against anything this program
remembers doing.

## What it does not do, and will not

- **No synchronisation between devices.** Incompatible with zero network.
- **No collaboration.**
- **No web clipping**, which would need a browser inside the program.
- **No handwriting recognition.**
- **No graph view of the archive.** It is attractive in a screenshot, expensive
  to do well, and past a hundred notes it is a hairball that answers no
  question anyone actually has. If it is ever genuinely wanted, GRT Graphs can
  read an export, which is why the two modules share a container format.
- **No global keyboard shortcut** for the quick note. That needs a process
  resident in memory whether or not you are using the program, which is in
  tension with ephemeral mode and with a program that promises to stay out of
  the way. Inside the window, `Ctrl+Shift+N` does it.

## Building

```bash
npm install
npm run build
./scripts/install-local.sh
```

`--remove` undoes the install completely. SQLite is compiled in, so there is no
system library to install and nothing to find at runtime.

## Testing

```bash
npm test
```

173 tests. The ones worth knowing about:

- **the program boots and a character is typed into it**: `boot.test.js`
  starts `main.js` against this module's real `index.html` with a faked
  backend. It exists because Notes shipped unable to type at all: the editing
  logic was in `main.js`, which calls `start()` at module level, so importing
  it runs the program and nothing could test it

- a deleted index rebuilds from the archive with nothing lost, **with a canary
  proving the comparison could fail** if it did lose something
- a note moved by hand in a file manager is found again, and forgotten at its
  old path, including when the move preserved its timestamp
- search reaches inside code blocks and callouts
- a `[[link]]` to a note that does not exist resolves to nothing rather than
  breaking anything
- two saves of the same note serialise identically
- exporting the archive keeps the notebook and section folders
- clicking a link or a to-do resolves from the innermost element the click
  actually lands on; the test that would have caught the broken dragging in
  GRT Graphs and the uneditable text in GRT Slides

## Looking at it

```bash
./scripts/preview.sh
```

Serves the real interface on `http://localhost:8726` with the backend stubbed,
so the window can be looked at in a browser. jsdom has no layout engine, so no
test can see that something is in the wrong place, and running this found
the title and the tag line drawn as form fields
instead of as a heading, because a generic `input` rule outranked them.

The stub that answers the backend is `scripts/preview-stub.js`. Stylesheets and
scripts are served through links, so a reload picks up an edit.

## Keyboard

| Key | Does |
|---|---|
| `Ctrl+N` | new note |
| `Ctrl+Shift+N` | quick note |
| `Ctrl+F` | search |
| `Ctrl+B` `Ctrl+I` `Ctrl+U` | bold, italic, underline |
| `Ctrl+Z` `Ctrl+Y` | undo, redo |
| `Ctrl+K` | command palette |
| `[[` | start a link, and complete it as you type |
