# GRT Tables

A local database that never leaves your machine, and cannot run macros.

Part of [GRT Suite](../../README.md). Design document:
[docs/GRT_TABLES.md](../../docs/GRT_TABLES.md).

## What it does

- Tables with types, constraints, foreign keys and indexes
- A **designer that shows the `CREATE TABLE` it is about to run**, before it
  runs it
- A data grid, paginated in the engine rather than in the window
- Sorting, filtering and search by column
- A SQL editor, with a warning before anything that would change every row
- Undo, as a rollback to a savepoint
- CSV import with proposed column types, and CSV export
- A readable `.grt` archive of schema and data
- "Prepare for sharing", which compacts the file so deleted rows are gone

## What makes this module different

**The hard part is not written here.** Every other module in the suite
implements its own difficult thing; a formula parser, pagination, connector
routing. Here the transactions, indexes, referential integrity and query
planner are SQLite's. What this program builds is the interface above them.

**It is the only module whose working file is not `.grt`.** A database is
written continuously, a cell at a time, and rewriting a ZIP on every operation
is not a trade-off but an impossibility. So the working file is a plain
`.sqlite`, and because a `.sqlite` is opaque, the archive format is a `.grt`
containing **text**: the schema as `CREATE TABLE`s and the data as `INSERT`s,
readable in any editor and diffable in version control.

Two exports of the same database produce byte-identical files: tables come out
alphabetically, rows in primary-key order.

## Two rules the whole module rests on

**No SQL is ever built by pasting values into a string.** Every value reaches
the engine as a bound parameter. Names of tables and columns cannot be bound,
so they go through one quoting function, and that is the only place a name is
interpolated. This is not theory for a local program: a value with an
apostrophe breaks a concatenated query, and a database file received from
someone else can hold hostile data.

**A database opened from disk is read-only until you say otherwise.** Opening
someone else's file is the riskiest thing this program does.

The design document asks for read-only on a database "not created by this
program", which implies a marker in the file saying it was. §5 of the same
document lists exactly that, an application id in the header, as a no-trace
problem, and it is right: a file that announces which software made it is a
trace. So nothing is written, and the question is answered the other way
round: a database **created** here is writable, one **opened** starts locked.
Coarser than the document imagines, and it errs towards asking.

## Traces, and where SQLite leaves them

| What | What is done about it |
|---|---|
| `-wal` and `-shm` files holding recent rows | journalling set to `DELETE`, and the files removed on close |
| deleted rows left in free pages | `secure_delete` on, and `VACUUM` from "Prepare for sharing" |
| an application id in the header | never written: see above |

## What it will not do

- **No macros and no scripting engine**, for the same reason as GRT Grid.
- **No server, no replication, no network.** SQLite is local, and so is this.
- **No connections to MySQL or PostgreSQL.**

## Not yet

Forms, reports, PDF export and the visual query builder, §7 steps 11, 12, 15
and 16. Steps 1 to 10 are done, plus 13 and 14, which is past the milestone the
document names.

## Building

```bash
npm install
npm run build          # runs the Rust tests as part of the build
./scripts/install-local.sh
```

## Testing

```bash
npm test                      # 89 tests, the interface and the designer
cd src-tauri && cargo test    # 27 tests, the engine
```

The split is deliberate. What the engine actually did to a file can only be
checked against the file, so the Rust tests own:

- a value full of apostrophes, quotes and semicolons is stored and read back
  identical, and the table it tried to drop is still there
- a table of 100,000 rows is read a page at a time
- after `VACUUM`, a deleted record is no longer in the bytes, **with a canary
  asserting it was findable before the delete**, so the check cannot pass
  vacuously
- a rollback restores the previous state, schema included
- an opened database refuses every write until unlocked
- a clean close leaves no `-wal` or `-shm`
- two archives of the same database are identical

The JavaScript tests own everything above the engine, driven against a fake
backend: paging, sorting, filtering, the designer's SQL, and the CSV import
proposing types rather than applying them.

## Looking at it

```bash
./scripts/preview.sh
```

Serves the real interface on `http://localhost:8732` with the backend stubbed.
In GRT Grid this found a layout fault that 250 passing tests had missed, so it
is here from the start.

## Keyboard

| Key | Does |
|---|---|
| `Ctrl+Enter` | run the query in the editor |
| `Ctrl+Z` | undo |
| `Ctrl+K` | command palette |
| double-click a row | edit it |
