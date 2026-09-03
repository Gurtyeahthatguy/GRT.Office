# GRT_TABLES.md

Specification of the **GRT Tables** module; the suite's local database.

Design document. It assumes the suite's principles, the `.grt` container
format and the shared core.

Position in the development order: **seventh and last module of the suite**.
Independent of the others: it can be moved to any point after GRT Read.

---

## 1. What sets this module apart from the others

**The engine is not written here.** The other modules implement their own logic
from nothing: formula parsers, pagination, connector routing. Here the hard
part; the SQL engine, with transactions, indexes, referential integrity and a
query planner, is SQLite, available in Rust through `rusqlite`.

What is built is **the interface above the engine**: a table designer, a query
editor, forms, reports.

**The consequence:** it is less difficult than Grid despite appearances, and
that is why it can be moved freely in the order.

**The other difference:** it is the only module whose working file is not
`.grt`. A database is written continuously, a cell at a time; a ZIP has to be
rewritten whole on every save. See §5.

---

## 2. What it does

A local database with a graphical interface: tables, relations, queries, entry
forms, reports.

**Intended uses**

- Personal catalogues and inventories (books, films, collections)
- Structured registers (contacts, spending, reading)
- Small personal record-keeping across several linked tables
- Data too structured for a spreadsheet and too small for a real database

**Out of scope**

- Multi-user or server databases (SQLite is local by design)
- Replication, synchronisation, access over a network
- A scripting language or macros; the same reason as Grid: attack surface
- Connections to external databases (MySQL, PostgreSQL)
- Complex automatic schema migrations

**The boundary with GRT Grid**

Worth writing down, because users always get it wrong:

| Use Grid | Use Tables |
|---|---|
| Calculations and formulas | Structured data and relations |
| A single table | Several linked tables |
| Data that changes shape often | A stable schema |
| A few hundred rows | Thousands of records |
| Ad hoc analysis | Repeated entry and searching |

---

## 3. Architecture

```
Frontend (HTML/JS)          Backend (Rust)
─────────────────           ──────────────
table designer      ──────► rusqlite
query editor        ──────► parameterised execution
data grid           ──────► result pagination
forms and reports   ──────► reading and writing
```

**The frontend never builds SQL by concatenating strings.** The user's queries
go to the backend as text alongside the parameters, kept separate; everything
the interface generates itself (inserts, updates, filters) uses
**parameterised queries**.

This is not theory: a value typed into a field containing an apostrophe would
break a query built by concatenation, and in a program that promises safety a
local SQL injection is still a real defect; a database file opened from
elsewhere can contain hostile data.

**Read-only mode** when opening a database the program did not create, until
the user confirms. Opening someone else's file is the riskiest thing the module
does.

---

## 4. Functions

### Table designer

- Creating and changing tables through a graphical interface
- Types: text, integer, decimal, boolean, date, time, BLOB
- Constraints: primary key, not null, unique, default value, CHECK
- Foreign keys with actions on delete and update
- Indexes
- **The SQL view is always available:** the designer shows the `CREATE TABLE`
  it is about to run. The user always sees what actually happens, the same
  principle as GRT Read's fingerprint panel

### Data grid

- Viewing and editing records in a grid
- **Pagination in the backend:** never load a whole table into memory. The
  `LIMIT`/`OFFSET` belongs in the query, not in the frontend
- Sorting and filtering by column
- Searching
- Navigating to linked tables through a foreign key

### Query editor

- A SQL editor with syntax highlighting
- Execution with the results in a grid
- Queries saved in the project
- **A visual builder** (optional, a later phase): choosing tables, fields,
  conditions, joins; it produces SQL that stays visible and editable by hand

### Forms

An interface for entering and changing the records of one table, generated
automatically from the schema and adjustable: the order of the fields, their
labels, the controls (text, list, date, tick box), lookup fields onto linked
tables.

It is what makes a database usable by someone who does not write SQL.

### Reports

Printable output built from a query: a heading, the rows, groupings with
totals, a footer.

PDF export **through GRT Read's engine**; one place where metadata is cleared.

---

## 5. File format

**Working file: a native `.sqlite`.** A database is changed continuously;
rewriting a ZIP archive on every operation is not sustainable.

**The `.grt` container as the export and archive format:**

```
project.grt
├── README.txt
├── manifest.json          "type": "tables"
├── content/
│   ├── schema.sql         the full DDL
│   ├── data.sql           INSERTs, or
│   └── data/*.csv         one table per file, for large volumes
├── forms/
│   └── contacts.json      form definitions
└── reports/
    └── list.json
```

**Why two formats and not one**

A `.sqlite` is opaque: opening it without tools is impossible. The exported
`.grt` is **readable text**; the schema and the data can be inspected in any
editor, which is what the suite's longevity principle asks for.

The intended flow: work on the `.sqlite`, export to `.grt` to archive, share or
version in git.

**Deterministic writing** here too: in the export, tables in alphabetical
order, records in primary-key order, ZIP timestamps at the epoch. Two exports
of the same database produce identical bytes.

### No-trace requirements specific to this module

| Element | The problem |
|---|---|
| WAL and journal temporary files | SQLite creates `-wal` and `-shm` beside the database: they stay on disk and hold recent data |
| Internal free space | Deleted records remain physically in the file until `VACUUM` runs |
| Application `PRAGMA` | Some tools write identifiers into the header |

**Rules:**
- An explicit `VACUUM` before sharing a database, offered as a "prepare for
  sharing" command
- WAL files removed on a clean close
- In ephemeral mode, a database in memory (`:memory:`) with an explicit export,
  or a temporary directory deleted on exit
- No automatic creation or modification timestamp written by the program into
  the file's metadata

---

## 6. Data import and export

| Format | Direction | Notes |
|---|---|---|
| **CSV** | both | With separator and encoding detection, as in Grid |
| **`.grt`** | both | The archive format described above |
| **SQL** | both | A standard textual dump |
| **JSON** | both | One table = an array of objects |
| **PDF** | export | Reports, through GRT Read |

**CSV import with schema inference:** analysing the first rows proposes the
types of the columns. The user confirms or corrects, never silent inference.

**The link with GRT Grid:** the CSV export of a query opens directly in Grid.
It is the natural bridge between the two modules, and it needs no shared code.

---

## 7. Implementation order

1. Opening and creating `.sqlite` files through `rusqlite`
2. Listing tables and showing a schema
3. A data grid with pagination in the backend
4. Editing records with parameterised queries
5. A table designer with the SQL view
6. Constraints and foreign keys
7. A query editor with execution
8. Sorting, filtering, searching
9. Undo and redo (see §8)
10. CSV import and export
11. Forms generated from the schema
12. Reports and PDF export
13. `.grt` export and import
14. The "prepare for sharing" command (`VACUUM`, removing WAL)
15. A visual query builder
16. Customising the forms

**The useful milestone:** after point 10 the program does what it is for.

---

## 8. Undo and redo, the special case

In the other modules undo works on a model held in memory. Here the changes
are already written into the database.

**The approach: transactions with savepoints.** Every operation the user
performs is a SQLite transaction; undo rolls back to the previous savepoint.

**Limits to accept and to document:**
- Undo does not survive closing the program
- Schema operations (`DROP TABLE`) can be undone within the session, but they
  need an explicit warning first
- A SQL query written by hand can do anything: run it in a transaction,
  showing how many rows it would touch before confirming

**Confirmation before destructive operations:** a `DELETE` with no `WHERE` must
be pointed out, not simply executed.

---

## 9. File structure

```
grt-tables/
├── GRT_TABLES.md
├── src/js/
│   ├── schema.js        table designer
│   ├── grid.js          paginated data grid
│   ├── query.js         SQL editor
│   ├── builder.js       visual builder
│   ├── forms.js         forms
│   ├── reports.js
│   └── io.js            CSV, JSON, .grt
├── src-tauri/src/
│   ├── db.rs            rusqlite, parameterised queries
│   ├── export.rs        deterministic .grt generation
│   └── main.rs
└── tests/
    ├── db.test.rs
    ├── export.test.js
    └── injection.test.rs
```

---

## 10. The main tests

- A value containing apostrophes, quotes and semicolons is stored and read back
  identical (the injection test)
- A table of 100,000 records opens and scrolls without loading everything into
  memory
- Two `.grt` exports of the same database produce identical bytes
- After `VACUUM`, a deleted record is no longer present in the file's bytes
- A `.sqlite` from elsewhere opens read-only until the user confirms
- Rolling back a transaction restores exactly the previous state, schema
  included
- A CSV import with ambiguous types asks rather than guessing
- The PDF of a report has its metadata cleared
- A clean close leaves no `-wal` or `-shm` files on disk

---

## 11. Open decisions

- **The FTS5 extension** for full-text search: useful, and already used in GRT
  Notes. Include it, or leave the search as `LIKE`?
- **Encrypting the database:** SQLCipher exists, but the suite's position
  holds, delegate to LUKS or VeraCrypt rather than implementing it. To be
  reconfirmed
- **Charts in reports:** reuse GRT Grid's code, or defer?
- **Many-to-many relations** in the designer: manage the bridge table
  automatically or by hand?
- **Schema migrations:** what happens when a table with data in it is changed?
  SQLite's `ALTER TABLE` is limited and the table has to be rebuilt
- **How much SQL to expose:** the balance between a guided interface and direct
  access to the engine

---

## 12. Closing note for the suite

With this module the GRT suite is specified in full:

| Module | Document |
|---|---|
| GRT Read | specified with the suite itself |
| GRT Graphs | `GRT_GRAPHS.md` |
| GRT Slides | `GRT_SLIDES.md` |
| GRT Paper | `GRT_PAPER.md` |
| GRT Notes / Dates | `GRT_NOTES_DATES.md` |
| GRT Grid | `GRT_GRID.md` |
| GRT Tables | this document |

Outside the suite, as separate projects: **GRT Assistant** (which exists, and
is to be ported to Tauri) and **GRT Text** (decentralised messaging).

The design is complete. What is missing is the code, and the measure remains
the one the suite set at the start: the goal is not to finish the suite, but
to finish GRT Read and actually use it.
