# GRT Graphs

Draws diagrams, graphs and node networks. Runs entirely on your machine, never
opens a network connection, and saves into a container you can open with any
archiving tool.

Part of the [GRT Suite](../../README.md). Design document:
[GRT_GRAPHS.md](GRT_GRAPHS.md).

## What it does

- Nodes in seven shapes, connected by connectors that stay attached when things
  move
- Orthogonal, straight or curved routing, and if the automatic result is
  wrong, drag the connector to bend it; double-click it to hand it back to the
  router
- Multiple selection, alignment guides, snap to grid, align and distribute
- `Ctrl+K` opens the command palette; the same one in every GRT program
- Imports Mermaid `graph` and `flowchart` text, pasted or from a file
- Tree layout, as a command you run rather than a behaviour that fires
- Undo and redo, where one drag is one entry
- Export to SVG, PNG, PDF and JSON, and import JSON back
- PDF goes through the suite's shared print engine, the same code that clears
  metadata in GRT Read, so there is one place to audit rather than two
- The same five themes as the rest of the suite

## The `data` field

Every node and connector carries a `data` object that the editor stores and
never looks inside. It is where a game keeps what it needs: the condition on a
dialogue choice, the cost of a skill, the guard on a state transition.

It survives saving, loading, exporting and reimporting untouched, never
normalised, never reordered, never emptied. That is what makes this an editor
you can point a game at rather than a diagram tool that happens to draw boxes:

```
Export → JSON (logic only)
```

drops every coordinate and colour, so a game reads `{id, text, data}` and
`{from, to, label, data}` and nothing else.

## Checking the claims

```bash
npm test
node ../../scripts/sync-core.mjs modules/grt-graphs
../../scripts/check-build.sh src-tauri/target/release/grt-graphs
```

The tests cover what the design document asks for: `data` survives a round
trip, deleting a node deletes its connectors and undo restores both, a drag
produces one undo entry, orthogonal routing never runs back through the node it
left, and the exported SVG names no software and carries no date.

## Using it

Double-click the canvas to add a node, double-click a node to rename it. Select
a node to reveal its four ports, then drag from a port onto another node to
connect them. Drag a connector to bend it by hand.

`Del` removes the selection, `Ctrl+Z` undoes, `Ctrl+A` selects everything,
`Ctrl+0` fits the drawing to the window, `Ctrl+,` opens the settings.

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

Serves the real interface on `http://localhost:8722` with the backend stubbed,
so the window can be looked at in a browser. jsdom has no layout engine, so no
test can see that something is in the wrong place, and running this found
the toolbar scrolling off the top of a narrow window,
with no way to scroll back to it.

The stub that answers the backend is `scripts/preview-stub.js`. Stylesheets and
scripts are served through links, so a reload picks up an edit.
