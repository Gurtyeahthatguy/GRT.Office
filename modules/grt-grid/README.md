# GRT Grid

A spreadsheet that never leaves your machine, and cannot run macros.

Part of [GRT Suite](../../README.md). Design document:
[docs/GRT_GRID.md](../../docs/GRT_GRID.md).

## What it does

- A grid of cells with values and formulas, recalculated as you type
- **72 functions**: maths, statistics, logic, text, dates, lookup
- Several sheets, with references between them (`Data!A1`)
- Named cell styles, number and date formats
- Insert and delete rows and columns, with every formula rewritten
- Copy and paste with formulas translated, fill down with series
- Undo and redo
- CSV import and export
- Five themes, shared with the rest of the suite, and the `Ctrl+K` palette

## The four parts

§3 of the design document divides the module into four, and they were built in
that order with each tested before the next.

**A virtualised grid.** A sheet of ten thousand rows by a hundred columns is a
million cells, and building a million elements is not slow but impossible. About
forty rows by twenty columns exist at any moment; the scroll bar's length is a
spacer. Elements are reused rather than recreated, position comes from
`transform` rather than `top`, and nothing is measured inside the drawing loop,
the three things §4 names as the usual causes of a grid that stutters.

**A formula parser.** A tokenizer and a recursive-descent parser with the usual
precedence. Recursive descent rather than shunting-yard because it reads like
the grammar. A formula that will not parse becomes a cell error; it does not
take anything down with it.

**A dependency graph.** §6 calls this the hardest part of the whole suite, and
the reason is that getting it wrong is invisible: the sheet still calculates,
just the wrong cells or in the wrong order, and the symptom is a stale number
months later. Changing a cell collects its dependents transitively, orders that
set topologically, and evaluates only that. Circular references fall out of the
ordering and are marked `#REF!` while the rest of the sheet keeps working.

A range is recorded **as a range**, not as one edge per cell: `SUM(A1:A1000)` is
one entry, not a thousand.

**A function library.** About seventy, not Excel's five hundred. §7 makes the
argument: the long tail is used by almost nobody. Every function is pure, it
receives evaluated values and returns one, cannot read the sheet, and has no
effects, which is what makes the library testable in isolation.

## What it will not do

- **No macros, and no scripting engine of any kind.** Not a limitation, a
  decision: macro viruses are the historical infection vector for spreadsheets
  specifically, and a program that cannot run code cannot carry one. There is
  nothing in the binary to exploit.
- **No network functions.** Excel's `WEBSERVICE` has no equivalent here. A test
  asserts that no function name contains `WEB`, `HTTP`, `URL` or `FETCH`.
- **No parity with Excel**, no pivot tables, no solver, no real-time
  collaboration.

## Not yet

Charts, conditional formatting, sorting, filters, frozen panes, `.xlsx` import
and PDF export are in §11 and are not built. Steps 1 to 12 and 16 are, which is
past the milestone the document names, "a working spreadsheet".

## Building

```bash
npm install
npm run build
./scripts/install-local.sh
```

## Testing

```bash
npm test
```

256 tests. The ones worth knowing about:

- **`graph.test.js` is the important one**, and §12 says so. Several of its
  tests count evaluations rather than checking answers: "the right result" and
  "only the right cells were recalculated" are different claims, and only the
  second is about the graph
- a direct cycle, an indirect one, a self-reference and a range containing its
  own cell are all detected, and the rest of the sheet keeps calculating
- inserting a row rewrites references above, below and *across* the insertion
  point, the case §6 warns about
- copying a formula translates relative references, leaves absolute ones, and
  **does not touch something that looks like a reference inside a string**
- an error propagates to dependents as a value, never as an exception
- two saves of the same sheet produce identical text, and the file records
  nothing about who made it, with a canary proving that search could fail
- a CSV file's separator and decimal point are **detected and asked about**,
  never guessed silently
- `boot.test.js` starts the real program against the real `index.html` and
  types into it

## Looking at it

```bash
./scripts/preview.sh
```

Serves the real interface on `http://localhost:8731` with the backend stubbed,
so the window can be looked at in a browser. jsdom has no layout engine, so no
test can see that something is in the wrong place, and the first version drew
its row numbers forty-eight pixels below the cells they named, with every test
passing. This is what found it.

## Keyboard

| Key | Does |
|---|---|
| arrows | move · with `Shift` extend · with `Ctrl` jump to the edge of the data |
| `Enter` `Tab` | move down, move right |
| `F2` | edit the cell |
| any character | start typing over the cell |
| `Delete` | empty the selection |
| `Ctrl+D` | fill down |
| `Ctrl+Z` `Ctrl+Y` | undo, redo |
| `Ctrl+S` `Ctrl+O` `Ctrl+N` | save, open, new |
| `Ctrl+K` | command palette |
