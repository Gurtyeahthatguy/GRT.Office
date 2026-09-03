# GRT_GRID.md

Specification of the **GRT Grid** module, the suite's spreadsheet.

Design document. It assumes the suite's principles, the `.grt` container
format and the shared core.

Position in the development order: **sixth module**, last of the editors.

---

## 1. Why this module comes last

It is the hardest in the suite, and on its own it doubles the project's total
time. The temptation to do it first is strong; it is the most impressive, and
it is the mistake that kills projects like this one.

**The reasons to postpone it:**

**It is the only module with real algorithmic difficulty.** The others are
problems of interaction: selection, dragging, rendering. Here it needs a
parser, a directed graph, a topological sort and an incremental recalculation
engine. Those are different problems, and getting them wrong does not show up
at once: it shows up on a large sheet, after months of use.

**It shares almost nothing with the others.** No text editor, no canvas with
draggable objects. It needs the core only for I/O, undo and the container.

**Facing it with five working programs already built** means having a stable
core and not fighting the infrastructure while wrestling with the dependency
graph.

**A realistic estimate:** four to six months part-time. All the other modules
added together are of a similar order.

---

## 2. What it does

A spreadsheet: a grid of cells with values and formulas, automatic
recalculation, charts.

**Intended uses**

- Personal calculations and budgets
- Tables of data with totals and statistics
- Registers and lists with sorting and filters
- Small models with linked formulas

**Out of scope**

- Feature parity with Excel, see §7
- Complex pivot tables
- Macros and a scripting language (attack surface, and macro viruses are the
  historical infection vector for spreadsheets)
- Connections to external databases or network queries
- A solver, scenario analysis, advanced statistical tools

---

## 3. The four subsystems

The module divides into four largely independent parts. They should be built in
this order, and each tested before the next.

```
1. A virtualised grid   → making a large sheet usable
2. A formula parser     → text → a syntax tree
3. A dependency graph   → what to recalculate, and in what order
4. A function library   → SUM, IF, VLOOKUP...
```

Point 3 is the conceptual heart. Points 1 and 2 are known work. Point 4 is long
but easy.

---

## 4. Subsystem 1, the virtualised grid

**The problem:** a sheet declares 10,000 rows by 100 columns, a million cells.
Generating a complete DOM is impossible.

**The solution:** render only the cells in the viewport, plus a margin.
Typically 40 rows by 20 columns, so 800 elements instead of a million.

### Implementation

- A container with a computed total size (rows × height), so the scroll bar is
  correct
- On a scroll event, work out the visible range and render that
- **Reuse the DOM elements** rather than recreating them: a pool of cells that
  change their content and their position
- Fixed row and column headers, kept in step with the scroll
- Frozen panes as a special case of the same mechanism

### A sparse data model

**A sheet "of 10,000 rows" with 200 filled cells must occupy as much as 200
cells.**

```js
// NO; a million elements in memory
const cells = Array(10000).fill().map(() => Array(100));

// YES, only what exists
const cells = new Map();   // the key "r,c" → the cell
```

It is the decision that determines whether the program opens a large sheet in a
second or in thirty.

### Performance

The rendering has to hold sixty frames a second while scrolling continuously.
When it slows down, the usual causes are: recalculating layout for every cell
(use `transform`, not `top`/`left`), reading properties that force a reflow
inside the rendering loop, formatting recomputed rather than cached.

---

## 5. Subsystem 2, the formula parser

Turns `=SUM(A1:B10)*2+IF(C1>0,"yes","no")` into a syntax tree.

### The structure

**A tokenizer** → numbers, strings, operators, references, function names,
brackets, separators.

**A recursive-descent parser** with operator precedence. The alternative is the
shunting-yard algorithm; recursive descent is more readable and easier to
extend.

### What it has to handle

| Construct | Example |
|---|---|
| A single reference | `A1` |
| A range | `A1:B10` |
| An absolute reference | `$A$1`, `A$1`, `$A1` |
| Arithmetic operators | `+ - * / ^ %` |
| Comparisons | `= <> < > <= >=` |
| Concatenation | `&` |
| Nested functions | `IF(SUM(A1:A5)>10, ...)` |
| String literals | `"text with ""quotes"""` |
| Booleans and errors | `TRUE`, `#DIV/0!` |

### Errors

A syntax error must not crash anything: the cell shows `#NAME?` or `#VALUE!`
and the sheet carries on working. Errors travel along the dependencies as
values, not as exceptions.

### Relative references and copying

Copying `=A1+B1` from `C1` to `C2` must produce `=A2+B2`. The translation of
relative references happens on the syntax tree, not on the text, manipulating
the string with regular expressions appears to work until it meets a string
literal containing something that looks like a reference.

---

## 6. Subsystem 3, the dependency graph

**It is the conceptually hardest part of the whole suite.**

### The problem

If `C1 = A1 + B1`, then changing `A1` means `C1` has to be recalculated. And
everything that depends on `C1`. And so on.

Recalculating the whole sheet on every change is simple and unsustainable: on a
sheet with thousands of formulas every keystroke becomes a wait.

### The structure

For every cell holding a formula, record:
- its **precedents**: the cells it depends on
- its **dependents**: the cells that depend on it

Both directions are needed: the first to evaluate it, the second to know what
to invalidate.

### Incremental recalculation

```
1. Cell X changes
2. Collect the set of X's dependents, transitively
3. Sort that set topologically
4. Evaluate it in the order that comes out
```

Only the subgraph downstream is touched. The rest of the sheet does not move.

### Cycles

`A1 = B1` and `B1 = A1` is a cycle. **Detecting it is compulsory**: without
that, the recalculation recurses for ever and the program hangs.

The topological sort detects the cycle naturally: if nodes are left with
unresolved dependencies, there is a cycle. The cells involved show `#REF!` and
the rest of the sheet carries on working.

**A note:** Excel supports iterative calculation for deliberate cycles. It is
an advanced and rare feature: defer it, but do not design in a way that makes
adding it impossible.

### Ranges

`SUM(A1:A1000)` depends on a thousand cells. Recording them one by one swells
the graph.

**An optimisation:** the graph records the dependency on the *range*, and a
separate structure maps which ranges contain a given cell. Defer it until it is
needed, but choose the data structure so that it can be added.

### Inserting and deleting rows

Inserting a row in the middle shifts the references of every formula below it.
It is the operation that most easily introduces subtle bugs: it needs testing
heavily, including the cases of references that cross the insertion point.

---

## 7. Subsystem 4, the function library

**The target: about 50 functions, not Excel's 500.**

The long tail of Excel's functions is used by very few people; 80% of real
sheets use a dozen.

### The starting set

| Category | Functions |
|---|---|
| Maths | `SUM ABS ROUND ROUNDUP ROUNDDOWN INT MOD SQRT POWER RAND` |
| Statistics | `AVERAGE COUNT COUNTA COUNTIF MIN MAX MEDIAN STDEV SUMIF` |
| Logic | `IF AND OR NOT IFERROR TRUE FALSE` |
| Text | `CONCAT LEFT RIGHT MID LEN UPPER LOWER TRIM SUBSTITUTE FIND TEXT` |
| Dates | `TODAY NOW DATE YEAR MONTH DAY WEEKDAY DATEDIF` |
| Lookup | `VLOOKUP HLOOKUP INDEX MATCH` |

### Rules for implementing them

**Every function is pure**: it receives values that have already been evaluated
and returns a value. It does not reach into the sheet and it has no side
effects. That makes the whole library testable in isolation.

**No volatile function that touches a network.** `RAND` and `NOW` are volatile:
they recalculate every time, but they are local. Functions like Excel's
`WEBSERVICE` do not exist here, on principle.

**The behaviour on types is documented.** What does `SUM` do with a cell
containing text? Excel and LibreOffice do not always agree. Choose a
convention, write it down, test it.

**Floating-point numbers:** `0.1 + 0.2 ≠ 0.3` surprises users in spreadsheets
more than anywhere else. A sensible display rounding is needed, and a decimal
library is worth considering for money.

---

## 8. The data model and the file format

```json
{
  "version": 1,
  "type": "grid",
  "sheets": [
    {
      "id": "sh1",
      "name": "Sheet1",
      "cells": {
        "0,0": { "v": 10 },
        "0,1": { "v": 20 },
        "0,2": { "f": "=A1+B1", "v": 30 },
        "1,0": { "v": "Text", "s": "header" }
      },
      "cols": { "0": { "w": 120 } },
      "rows": { "5": { "h": 40 } },
      "frozen": { "rows": 1, "cols": 0 }
    }
  ],
  "styles": {
    "header": { "bold": true, "bg": "#eeeeee" },
    "currency": { "format": "#,##0.00" }
  },
  "charts": []
}
```

### Decisions

**Cells as a map, not a matrix**: consistent with the sparse model.

**`f` is the formula, `v` the calculated value.** Saving both allows a file to
be opened and its numbers shown without recalculating everything. On the first
recalculation the values are updated.

**Styles are named**, as in the other modules.

**The display format is separate from the value:** a cell holds the number, not
the formatted string. `#,##0.00` is a property of the style.

A `.grt` container with `"type": "grid"`, written deterministically.

---

## 9. The interface

### Navigation and selection

- Arrows, `Tab`, `Enter`; `Ctrl` plus arrows to jump to the edges of the data
- Selecting ranges with the mouse and with `Shift` plus arrows
- Selecting whole rows and columns from the headers
- Automatic filling by dragging the corner (numeric series, dates, copying
  formulas with translation)

### Editing

- Typing directly overwrites; `F2` enters the cell
- A formula bar with the references highlighted
- **Coloured highlighting of the references** in the formula being edited, with
  the matching rectangles on the sheet: it is what makes complex formulas
  comprehensible
- Completion of function names

### Sheet functions

- Sorting by column
- Filters
- Conditional formatting (the basics: colour scales, bars, simple rules)
- Frozen panes
- Find and replace
- Several sheets with references between them (`Sheet2!A1`)

### Charts

Canvas and code written here, as settled for the suite. Types: bars, lines, pie,
scatter.

A chart is an object laid over the sheet that references a range of data and
updates on recalculation.

**Do not** implement Excel's entire catalogue of chart types.

---

## 10. Import and export

| Format | Notes |
|---|---|
| **CSV** | Full import and export. It is the most reliable exchange format |
| **`.xlsx`** | Partial import with warnings; export for simple sheets |
| **PDF** | Through GRT Read |
| **HTML** | A static table |

### CSV: the traps

The "simple format" is full of ambiguity: the separator (comma or semicolon,
depending on the locale), the decimal separator, the encoding, line breaks
inside cells, a byte order mark at the front.

The import must **detect and ask**, not guess in silence.

### `.xlsx`

The same position as `.docx` and `.pptx`: partial import with an explicit list
of what was not converted; export for simple cases, with an honest warning.

**Metadata:** an `.xlsx` contains `dc:creator`, `cp:lastModifiedBy`,
`dcterms:created` and sometimes a company name. Cleared on every export.

---

## 11. Implementation order

1. A virtualised grid with smooth scrolling
2. The sparse data model, entering values
3. Selection and keyboard navigation
4. Basic cell formatting and named styles
5. **The tokenizer and the formula parser**
6. An evaluator for a minimal set: arithmetic, `SUM`, `AVERAGE`
7. **The dependency graph and incremental recalculation**
8. **Cycle detection**
9. Relative and absolute references, copying with translation
10. The complete function library
11. Undo and redo
12. `.grt` saving and loading
13. Inserting and deleting rows and columns, with the references updated
14. Several sheets and references between them
15. Sorting and filters
16. CSV import and export
17. Conditional formatting
18. Charts
19. PDF export
20. Partial `.xlsx` import

**The useful milestone:** after point 12 the program is a working spreadsheet.

**A warning:** points 5 to 9 are the heart. If the dependency graph is wrong,
everything after it rests on nothing, and the defect only shows up on large
sheets, months later. It is worth slowing down there and building a serious
battery of tests before going on.

---

## 12. File structure

```
grt-grid/
├── GRT_GRID.md
├── src/js/
│   ├── model.js         the sparse model, independent of rendering
│   ├── grid.js          the virtualised grid
│   ├── parser/
│   │   ├── tokenizer.js
│   │   ├── parser.js
│   │   └── ast.js
│   ├── engine/
│   │   ├── graph.js     the dependency graph
│   │   ├── evaluate.js  the evaluator
│   │   └── recalc.js    incremental recalculation
│   ├── functions/       one function per file, or per category
│   ├── format.js        display formats
│   ├── charts.js
│   ├── commands.js
│   └── io.js            CSV, xlsx, .grt
├── src-tauri/
└── tests/
    ├── parser.test.js
    ├── graph.test.js    the most important one
    ├── functions.test.js
    └── io.test.js
```

The same constraint as the other modules: `model.js` and the engine import
nothing from the rendering. The calculation engine has to work with no
interface; that is what allows it to be tested seriously.

---

## 13. The main tests

**The engine**
- A direct cycle (`A1=B1`, `B1=A1`) and an indirect one across three cells are
  both detected, and the rest of the sheet keeps calculating
- Changing a cell recalculates **only** its transitive dependents, verified by
  counting the evaluations
- An error in one cell travels to its dependents as a value, with no exceptions
- Inserting a row in the middle correctly updates the references of the
  formulas above and below, including those that cross the point
- Copying a formula translates the relative references and leaves the absolute
  ones alone
- A string literal containing something that looks like a reference is not
  translated

**The parser**
- Functions nested several levels deep
- Double quotes inside strings
- A syntactically wrong formula produces a cell error, not a crash

**Files**
- Two saves of the same sheet produce identical bytes
- An exported `.xlsx` contains no `dc:creator` and no user name
- A CSV with an unusual separator and encoding is detected or asked about,
  never guessed in silence

**Performance**
- A sheet with 50,000 filled cells opens in an acceptable time
- Scrolling stays smooth on a large sheet
- Recalculation after a change on a sheet with 10,000 formulas stays below the
  threshold of perception

---

## 14. Open decisions

- **A decimal library** for money, or floating point with display rounding?
- **Iterative calculation** for deliberate cycles: deferred, but the
  architecture must not rule it out
- **The range optimisation** in the graph: from the start, or when it is
  needed?
- **Pivot tables**: out of scope, or a minimal version?
- **Array formulas** (`{=...}`, dynamic spill): powerful, and they complicate
  the cell model considerably
- **Defined names** (giving a name to a range): useful, cheap, perhaps worth
  including in the first version
- **How many functions really** in the first release: 50 is a target, but 30
  might be enough for the useful milestone
