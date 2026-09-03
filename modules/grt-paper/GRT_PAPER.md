# GRT_PAPER.md

Specification of the **GRT Paper** module; the suite's word processor.

Design document. It assumes the suite's principles, the `.grt` container
format and the shared core.

Position in the development order: **fourth module**, after Read, Graphs and
Slides.

---

## 1. Why this module comes fourth

It is the first genuinely difficult module, but difficult in a different way
from Grid. Grid is difficult in its algorithms, the dependency graph, the
formula parser; Paper is difficult in its **interaction**: handling text
selection is notoriously one of the most unpleasant problems in web
development.

**It comes after Slides for a reason.** Slides' text boxes are a reduced
version of the same problem: formatted runs, the Selection API, formatting
commands. Facing them there, on short text with no page flow, means arriving at
Paper having already got the small things wrong once.

**It unlocks two modules.** GRT Notes reuses its editor almost entirely: doing
it well here means having Notes almost free straight afterwards.

---

## 2. What it does

A word processor: documents with formatting, headings, lists, tables, images,
pagination and printing.

**Intended uses**

- Letters, reports, structured documents
- Long notes and study material
- Text to export as PDF or Markdown
- Technical documents with headings and a table of contents

**Out of scope**

- Advanced page layout (complex multiple columns, fine typographic
  positioning). Scribus exists for that
- Real-time collaborative revision
- Full `.docx` compatibility, see §9
- Automatic bibliographies and citations (possibly later)
- Mail merge

---

## 3. The central decision: the DOM is the view, not the model

This is the architectural choice that decides whether this module works or
becomes unmanageable.

**The wrong and widespread approach:** use `contenteditable` and treat the
resulting DOM as the document. It is quick to start and then degenerates, the
browser produces unpredictable markup that differs between engines, and with
two different webviews (WebView2 and WebKitGTK) the behaviours diverge.

**The right approach:** a model of one's own is the truth; the DOM is only how
it is drawn.

```
user input → command → change the model → re-render the view
```

The `contenteditable` stays, but only to **capture** input; every event is
intercepted, turned into a command, applied to the model, and the DOM is
realigned. The browser never decides what happens to the document.

**A corollary:** `document.execCommand` is not used. It is deprecated, it
behaves differently on every engine, and it produces markup the program does
not control.

It costs more work at the start. It is the difference between an editor that
holds up and one that has to be rewritten.

---

## 4. Data model

A tree of blocks; each block holds runs of formatted text.

```json
{
  "version": 1,
  "type": "paper",
  "page": {
    "size": "A4",
    "margins": { "top": 25, "right": 25, "bottom": 25, "left": 25 },
    "orientation": "portrait"
  },
  "styles": {
    "body":  { "font": "serif", "size": 11, "lineHeight": 1.5 },
    "h1":    { "font": "sans", "size": 20, "bold": true, "spaceBefore": 12 },
    "quote": { "font": "serif", "size": 11, "italic": true, "indent": 20 }
  },
  "blocks": [
    {
      "id": "b1",
      "kind": "heading",
      "level": 1,
      "style": "h1",
      "runs": [ { "text": "The chapter's title" } ]
    },
    {
      "id": "b2",
      "kind": "paragraph",
      "style": "body",
      "align": "justify",
      "runs": [
        { "text": "Ordinary text followed by " },
        { "text": "a part in bold", "bold": true },
        { "text": "." }
      ]
    },
    {
      "id": "b3",
      "kind": "list",
      "listType": "bullet",
      "items": [
        { "level": 0, "runs": [ { "text": "First point" } ] },
        { "level": 1, "runs": [ { "text": "A sub-point" } ] }
      ]
    },
    {
      "id": "b4",
      "kind": "image",
      "resource": "resources/img-001.png",
      "w": 400, "h": 260,
      "align": "center",
      "caption": []
    }
  ]
}
```

### Decisions about the model

**Blocks are flat, not nested.** A paragraph does not contain other
paragraphs. Nesting exists only where it is real: list levels and table cells.
A deep tree makes every selection operation a nightmare.

**Runs do not nest.** Bold plus italic is one run with two attributes set to
`true`, not a run inside another. It is the difference between HTML (nested,
ambiguous) and a flat model (one representation for each state).

**Runs are normalised.** After every change, adjacent runs with identical
formatting are merged. Without this the model fragments into hundreds of
one-character runs and the file grows for no reason.

**Styles are named; direct formatting is the exception.** A paragraph has a
style; local bold and italic are attributes of the run. It is what allows the
whole document's appearance to be changed from one place.

**Random ids**, as in the other modules.

---

## 5. Selection and the caret

The technically most delicate part of the module.

**The model has its own representation of the selection**, independent of the
browser's:

```json
{
  "anchor": { "blockId": "b2", "offset": 12 },
  "focus":  { "blockId": "b4", "offset": 3 }
}
```

The flow runs both ways:
- the browser reports a change of selection → it is translated into the
  model's coordinates
- the model changes → the browser's selection is rewritten

**Known traps, to be faced from the start:**

- **IME composition** (accents, non-Latin keyboards, dictation): the
  `compositionstart` and `compositionend` events have to be handled
  explicitly, or input is corrupted. It is not an edge case: it affects
  anyone writing in a language with composed characters.
- **Pasting**: never accept the clipboard's HTML as it is. It has to be
  converted into the model, discarding everything that cannot be represented.
  Pasting from a web page is the fastest way to inject arbitrary markup into
  the document.
- **A selection across different blocks**: the buggiest operation in every
  editor. It needs a battery of tests of its own.
- **Differences between webviews:** WebView2 and WebKitGTK do not behave the
  same way on selection and composition. Both have to be tried from the start,
  not at the end.

---

## 6. Pagination

A word processor has to show pages. It is what separates it from a note
editor.

### The approach

The text flows in a container; pagination is **calculated**, not imposed by the
DOM. The height of the rendered blocks is measured and the page boundary is
worked out from it.

The breaks are drawn as visual separators, and become real only in the export
and the print preview.

### Typographic rules

- **A manual page break**
- **Keep with next**: a heading does not sit alone at the foot of a page
- **Isolated lines** (widows and orphans): at least two lines of a paragraph on
  each side of a break
- An image that does not fit drops to the following page

### The cost

This is the part that slows the editor down on long documents: measuring
everything on every keystroke is not sustainable.

**Mitigations:** recalculate only from where the document changed onwards;
cache the measurements per block, invalidated only when that block changes;
defer the recalculation while typing quickly.

---

## 7. Functions

### The first version

- Paragraph styles: headings H1–H4, body, quotation, code
- Formatting: bold, italic, underline, strikethrough, superscript, subscript,
  size, colour, highlighting
- Alignment, indents, spacing, line height
- Bulleted and numbered lists, with levels
- Images with a caption and an alignment
- Simple tables: inserting, rows and columns, merged cells
- Find and replace, with regular expressions
- Word and character counts
- A table of contents generated from the headings
- A spelling checker (Hunspell dictionaries, local)

### The second version

- Footnotes
- Headers and footers with a page number
- Section breaks with different page settings
- Bookmarks and cross-references
- Simple multiple columns
- Margin comments

### Command palette

`Ctrl+K`, as everywhere in the suite.

---

## 8. Undo and redo

The core's command stack, with the care that text specifically needs.

**Typing groups.** Each character is not a command: it groups by pauses (about
500 ms) and at word boundaries. `Ctrl+Z` must undo a sentence, not a letter.

**Formatting does not group** with typing: they are distinct actions.

**The commands expected:** `InsertText`, `DeleteRange`, `SplitBlock`,
`MergeBlocks`, `ApplyFormat`, `SetBlockStyle`, `InsertBlock`, `DeleteBlock`,
`MoveBlock`, `InsertTable`, `TableOp`, `Paste`.

Every command also records the selection before and after: undoing must put the
caret back where it was, or undo disorients.

---

## 9. File format and export

### Native

A `.grt` container with `"type": "paper"`. Images in `resources/`.
Deterministic writing.

### Export

| Format | Notes |
|---|---|
| **PDF** | Through GRT Read's engine. It is the main export |
| **Markdown** | Natural for headings, lists and bold. It loses complex tables and pagination: say so |
| **HTML** | Self-contained, images in base64 |
| **Plain text** | Trivial, and useful |
| **`.docx`** | See below |

### The `.docx` question

The same position as `.pptx` in Slides.

**Partial import:** the format is zipped XML; reading text, basic styles,
lists, tables and images is feasible. Reproducing fields, tracked changes,
embedded objects and complex layout is not.

The import states explicitly what it did not convert.

**Export:** possible for simple documents, with an honest warning about the
limits.

**A metadata warning:** a `.docx` contains `dc:creator`, `cp:lastModifiedBy`,
`dcterms:created`, `cp:revision` and sometimes a company name by default. They
have to be cleared explicitly on every export; the same requirement as PDFs.

**The recommended exchange format:** PDF, which loses nothing because it does
not try to stay editable.

---

## 10. Implementation order

1. The data model and rendering blocks and runs
2. Capturing input and turning it into commands
3. Selection: model ↔ browser, with tests on the cross-block cases
4. Inserting and deleting text, splitting and merging paragraphs
5. Undo and redo with typing grouped
6. Run formatting and normalisation
7. Named paragraph styles
8. Lists with levels
9. `.grt` saving and loading
10. Pagination and showing the pages
11. PDF export through GRT Read
12. Images
13. Find and replace
14. Tables
15. Markdown and HTML export
16. An automatic table of contents
17. The spelling checker
18. Headers, footers, footnotes

**The useful milestone:** after point 11 the program does what it is for, a
formatted document can be written and exported as PDF.

**A warning:** points 3, 4 and 5 are the heart of the module. If they are
fragile, everything after them rests on nothing. It is worth slowing down there
and not going on until the battery of selection tests is green.

---

## 11. File structure

```
grt-paper/
├── GRT_PAPER.md
├── src/
│   ├── index.html
│   ├── css/
│   └── js/
│       ├── model.js         the tree of blocks and runs
│       ├── selection.js     translation, model ↔ browser
│       ├── input.js         capturing events, IME, pasting
│       ├── render.js        model → DOM
│       ├── commands.js      commands for undo and redo
│       ├── pagination.js    working out the breaks
│       ├── styles.js        named styles
│       ├── tables.js
│       └── export.js        PDF, Markdown, HTML, docx
├── src-tauri/
├── scripts/
│   └── check-build.sh
└── tests/
    ├── model.test.js
    ├── selection.test.js    the most important one
    ├── commands.test.js
    └── export.test.js
```

The same constraint as the other modules: `model.js` imports nothing from
`render.js`.

---

## 12. The main tests

- A selection crossing three blocks, deleted and then undone, restores exactly
  the content and the position of the caret
- Adjacent runs with the same formatting are always merged
- Pasting HTML from a web page introduces nothing into the model that the model
  does not provide for
- Typing a sentence produces one entry in the undo stack
- Composed input (IME) does not corrupt the text
- Two saves of the same document produce identical bytes
- The exported PDF has its metadata cleared (checked against the bytes)
- The exported `.docx` contains no `dc:creator` and no user name
- The pagination of a hundred-page document recalculates in an acceptable time
  after a change in the middle
- Selection behaves identically on WebView2 and WebKitGTK

---

## 13. Open decisions

- **A page-free mode** (continuous writing, in the style of a modern editor) as
  an alternative to the paginated view: useful for drafting, but it doubles the
  rendering paths
- **The spelling checker**: Hunspell dictionaries included in the binary (they
  are heavy) or optional packages per language
- **Tables**: how far to go before they become a module of their own
- **Footnotes**: they complicate pagination considerably; weigh whether they
  are worth the cost
- **Embedded fonts** in the export: they make the file self-sufficient but have
  to be cleaned of their own metadata
- **Markdown as an alternative native format**: some users would prefer it to
  the `.grt`, but it cannot represent the whole model
