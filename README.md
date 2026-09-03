# GRT Suite

A personal productivity suite that runs entirely on the local machine.

- **Local.** No cloud, no account, no network. Ever.
- **Light.** Binaries measured in megabytes, not gigabytes.
- **Traceless.** Nothing identifying is added to the software or to the files
  it produces.
- **Open.** A privacy tool nobody can inspect does not deserve trust.

It is not an Office clone. It is the subset that covers real use, without
chasing feature parity. The measure of each module is not how closely it
resembles Office, but whether it gets used instead of the alternative.

Ready-made programs for Linux and Windows are attached to each release.
Building and installing: [INSTALL.md](INSTALL.md).
Each module carries its own design document beside its source.

## Modules

| Module | Purpose | State |
|---|---|---|
| [GRT Read](modules/grt-read) | PDF reading and editing | **working** |
| [GRT Graphs](modules/grt-graphs) | Diagrams, graphs, nodes | **working** |
| [GRT Slides](modules/grt-slides) | Presentations | **working** |
| [GRT Paper](modules/grt-paper) | Word processing | **working** |
| [GRT Dates](modules/grt-dates) | Calendar and tasks | **working** |
| [GRT Notes](modules/grt-notes) | Notes and notebooks | **working** |
| [GRT Grid](modules/grt-grid) | Spreadsheets | **working** |
| [GRT Tables](modules/grt-tables) | Databases | **working** |

## Checking the claims

Every claim above is meant to be verifiable, not taken on trust.

```bash
./scripts/check-build.sh modules/grt-read/src-tauri/target/release/grt-read
```

Scans a release binary for absolute build paths, contactable addresses,
telemetry libraries and debug symbols. The list of strings it tolerates is
[scripts/allowed-strings.txt](scripts/allowed-strings.txt), plain text, with a
written reason beside each one.

```bash
cd modules/grt-read
./scripts/check-network.sh src-tauri/target/release/grt-read
node scripts/show-metadata.mjs before.pdf
node scripts/show-metadata.mjs after.pdf
npm test
```

The first traces the running program and reports every socket it opens. The
next two print everything identifying a PDF carries, so a file can be compared
before and after the program touched it. The last runs the test suite, whose
central case is that content removed from a document cannot be recovered from
the bytes that get written.

## Looking at it

```bash
./scripts/preview.sh grt-read
```

Serves a module's real interface in a browser with the backend stubbed, so the
window can be looked at without building anything. jsdom has no layout engine,
so no test can see that something is in the wrong place: this is how that gets
checked. It has already found four faults that passing test suites had missed.

## Building

Requires Node, Rust and the WebKitGTK development libraries. Per-module
instructions are in each module's README.

## Licence

MIT. See [LICENSE](LICENSE).
