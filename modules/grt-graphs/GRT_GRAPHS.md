# GRT_GRAPHS.md

Specification of the **GRT Graphs** module; the suite's editor for diagrams,
graphs and linked nodes.

Design document. It assumes the suite's principles, the `.grt` container
format and the shared core.

Position in the development order: **second module**, after GRT Read.

---

## 1. Why this module comes second

It is neither the most asked for nor the most impressive. It is second for two
concrete reasons:

**It gives something back while it is being built.** Underneath it is a graph
editor with nodes and connectors: the same structure as an editor for branching
dialogue, for state machines, for skill trees, for behaviour trees. Designed
with a generic data backend, it becomes immediately reusable in games work. It
is the only module in the suite with a return outside the suite.

**It is independent.** It depends neither on the text editor (which does not
exist yet) nor on the calculation engine. It needs only the core built in GRT
Read: I/O, atomic saving, undo, the `.grt` container.

**It settles the core around interactive editing.** GRT Read is almost
read-only. Graphs is the first module where the user makes content: it puts
undo and redo, selection and dragging to the test, all infrastructure that
Slides and Paper then reuse.

---

## 2. What it does

A general diagram editor: shapes joined by connectors that stay attached when
the shapes move.

**Intended uses**

- Flow charts
- Concept maps
- Organisation charts
- Network and architecture diagrams
- State machines
- Dialogue trees (games work)
- Skill trees and progression trees (games work)

**Out of scope**

- UML diagrams with semantic validation (that is a different program)
- Free vector drawing (Bézier curves, artistic path work). Inkscape exists
  for that
- Real-time collaboration (incompatible with zero network)
- Complex automatic layout, see §9

---

## 3. A technical choice: SVG, not canvas

| | SVG | Canvas |
|---|---|---|
| Elements as DOM nodes | yes | no |
| Hit testing (clicking a shape) | free | to be implemented |
| Lossless zoom | free | a redraw |
| Export | native | a conversion |
| Accessibility | possible | no |
| Thousands of elements | degrades | copes |

**Decision: SVG.** Free hit testing and scalable rendering are worth more than
raw performance. A typical diagram has tens of elements, not thousands.

**Where it degrades:** past roughly 500 visible nodes the SVG DOM slows down.
If the use case ever demanded it, the answer is virtualisation, drawing only
what is in the viewport, not moving to canvas.

SVG export becomes trivial: the document *is* already SVG. It only has to be
cleaned.

---

## 4. Data model

The model is independent of the rendering. That is what makes the module
reusable outside the suite: a game can read the same JSON knowing nothing about
SVG.

```json
{
  "version": 1,
  "type": "graphs",
  "nodes": [
    {
      "id": "n1",
      "shape": "rect",
      "x": 100, "y": 80,
      "w": 160, "h": 60,
      "text": "Start",
      "style": "default",
      "data": {}
    }
  ],
  "edges": [
    {
      "id": "e1",
      "from": "n1",
      "fromPort": "right",
      "to": "n2",
      "toPort": "left",
      "routing": "orthogonal",
      "label": "yes",
      "style": "arrow",
      "waypoints": []
    }
  ],
  "styles": {
    "default": { "fill": "#ffffff", "stroke": "#333333", "strokeWidth": 2 }
  },
  "meta": { "gridSize": 10, "snapToGrid": true }
}
```

### Decisions about the model

**Ids are generated at random, not sequentially.** A sequential id reveals the
order the elements were made in, information nobody needs and the document
should not keep. Consistent with the suite's principles.

**The `data` field is free and never interpreted by the editor.** It is the
space where a game puts its own information: the conditions of a dialogue, the
costs in a skill tree, the actions of a state. The editor preserves it without
touching it.

It is the choice that makes Graphs a tool for games work rather than only a
tidy diagram.

**Styles are named, not inline.** Changing a style updates every node that uses
it. It also makes the file smaller.

**Connectors reference nodes by id, never by position.** Moving a node does not
touch the connector model: the recalculation is only visual.

**An empty `waypoints` means automatic routing.** If the user drags the
connector, the intermediate points are saved and automatic routing switches off
for that connector. Manual control always beats the automatic behaviour.

---

## 5. Connector routing

It is the most interesting technical piece of the module, and the one that
separates a usable diagram editor from a frustrating one.

### Three modes

**`straight`**: a straight line from port to port. Trivial, always available.

**`orthogonal`**: horizontal and vertical segments only. It is the default
mode and the one most used in technical diagrams.

**`curved`**: a Bézier curve. Used in node editors, and good for dialogue
trees.

### The orthogonal algorithm

A pragmatic approach, in increasing order of complexity. Implement in this
order, stopping when the result is good enough:

1. **A Z path**: leave the starting port, go to the midpoint, cross, enter the
   arriving port. It covers 80% of real cases.
2. **An L path**: when the nodes are aligned on one axis.
3. **Avoiding obstacles**: if the path crosses a node, go round it. A
   visibility grid plus A\*, or simply a fixed offset around the rectangle in
   the way.

Point 3 is the rabbit hole: one can spend months chasing perfect routing.
**The rule:** if the automatic routing is unconvincing, the user drags the
connector by hand and the waypoints are saved. A simple automatic behaviour
plus manual control beats an elaborate algorithm that fails unpredictably.

### Ports

Every node has four ports (`top`, `right`, `bottom`, `left`) plus `auto`.

With `auto`, the port is chosen from the relative position of the two nodes and
recomputed when they move. It is the default behaviour: the user should not
have to think about it.

---

## 6. Interaction

### Basic manipulation

- **Create a node**: double-click the canvas, or drag from a palette
- **Move**: dragging, with snapping to the grid (switchable off)
- **Resize**: handles at the corners and the sides
- **Connect**: drag from a port to a destination node
- **Multiple selection**: a rubber band, `Ctrl+click` to add
- **Delete**: `Del`; deleting a node deletes the connectors attached to it
- **Text**: double-clicking a node starts editing

### Navigation

- **Pan**: space bar plus dragging, or the middle button
- **Zoom**: `Ctrl` plus the wheel, centred on the cursor
- **Fit to view**: `Ctrl+0`
- **Zoom to the selection**: `Ctrl+Shift+0`

### Alignment

- Snapping to the grid (10px by default)
- **Alignment guides**: lines that appear when a node lines up with another
  while dragging. Cheap, and it improves the look of a diagram enormously
- Alignment and distribution commands for a multiple selection

### Command palette

`Ctrl+K`, as in every module of the suite. Rare functions live there rather
than in crowded toolbars.

---

## 7. Undo and redo

Reuses the core's command stack, with one specific care.

**A drag is one action, not one per pixel.** A `mousemove` produces dozens of
events: if each one reaches the stack, the user has to press `Ctrl+Z` fifty
times to undo a single move.

The command is recorded on `mouseup`, with the starting and finishing
positions. The same holds for resizing and for typing text, which groups by
pauses rather than by character.

**The commands expected:** `AddNode`, `DeleteNode`, `MoveNodes`, `ResizeNode`,
`EditText`, `AddEdge`, `DeleteEdge`, `RerouteEdge`, `ChangeStyle`,
`PasteNodes`.

Each command implements `do()` and `undo()`; composite commands, delete a node
*and* its connectors, are a list of elementary commands run as one unit.

---

## 8. File format and export

### Native

A `.grt` container with `"type": "graphs"`, in the shape the suite defines.
Deterministic writing: timestamps at the epoch, a fixed order of entries.

### Export

| Format | Notes |
|---|---|
| **SVG** | Native; the document is already SVG. Strip the editing attributes before exporting |
| **PNG** | Rasterising the SVG, at a scale the user chooses |
| **PDF** | Through GRT Read's engine: one place where metadata is cleared |
| **JSON** | The raw model, for games work |

**A no-trace warning about SVG:** an exported SVG can carry embedded fonts with
their own metadata, and some generators insert comments naming the software and
its version. Clean both.

### Import

- **JSON** in the same schema: this is how a game re-imports a graph it has
  changed in code
- **Mermaid** (optional, a later phase): a great many diagrams exist in that
  textual format, and it is a simple parser

---

## 9. Automatic layout

Useful, but it is a research problem: there are decades of literature on graph
drawing.

**To implement:** tree layout (Reingold–Tilford) for hierarchical graphs,
dialogue, organisation charts, skill trees. A known algorithm, a few hundred
lines, and it covers the cases that matter.

**Not to implement:** general force-directed layout, crossing minimisation,
Sugiyama-style hierarchical layout. They are months of work for results the
user rearranges by hand anyway.

**The rule:** automatic layout is a command the user runs, never an active
behaviour. A diagram that rearranges itself while it is being edited is the
most irritating thing an editor can do.

---

## 10. Games work

The reason this module comes second. It has to be designed so that these cases
work, not adapted to them afterwards.

### Dialogue trees

A node is a line of dialogue. A connector is a player's choice. The `data`
field holds conditions, required flags, consequences.

The game loads the JSON and walks it. The editor knows nothing about the
meaning, and that is right: it means it works with any engine.

### State machines

A node is a state. A connector is a transition. `data` holds the condition.

Useful for enemy behaviour, for AI, for interface flows.

### Skill trees

A node is an ability. A connector is a prerequisite. `data` holds the cost, the
effects, the icon.

### What it takes for that to work

- **The `data` field must survive intact** through saving, loading, copying and
  pasting, and exporting. Never normalised, never reordered, never emptied.
- **A clean JSON export**, with no presentation information mixed into the
  logical data. A game should not have to read coordinates and colours to find
  the condition on a transition.
- **Import of the same schema**, because the real flow is: edit by hand in the
  editor → the game generates variants by script → re-import to inspect them.
- **Optional validation**: a command that reports unreachable nodes, cycles,
  dangling connectors. It blocks nothing; it only says so.

---

## 11. Implementation order

1. An SVG canvas with pan and zoom
2. The data model and rendering the nodes
3. Creating, moving and resizing nodes
4. Single and multiple selection
5. Connectors with straight routing
6. Orthogonal routing (the Z path)
7. Undo and redo with dragging grouped
8. Text in the nodes
9. Named styles and a shape palette
10. `.grt` saving and loading
11. SVG and PNG export
12. Snapping to the grid and alignment guides
13. JSON export and import for games work
14. Tree layout
15. PDF export through GRT Read

Do not move to the next point until the previous one is tested.

**The useful milestone:** after point 11 the program is already usable for
making real diagrams.

---

## 12. File structure

```
grt-graphs/
├── GRT_GRAPHS.md
├── src/
│   ├── index.html
│   ├── css/
│   └── js/
│       ├── model.js        the data model, independent of rendering
│       ├── render.js       model → SVG
│       ├── interaction.js  mouse, keyboard, selection
│       ├── routing.js      the connector algorithms
│       ├── commands.js     commands for undo and redo
│       ├── layout.js       automatic tree layout
│       └── export.js       SVG, PNG, JSON
├── src-tauri/
├── scripts/
│   └── check-build.sh      shared with the other modules
└── tests/
    ├── model.test.js
    ├── routing.test.js
    └── export.test.js
```

**An architectural constraint:** `model.js` must import nothing from
`render.js`. The model lives without an interface, which is what lets a script
generate or transform graphs without opening the program.

---

## 13. The main tests

- The `data` field survives intact through save → load → export
- Deleting a node deletes its connectors, and undo restores them all
- A drag produces **one** entry in the undo stack, not one per event
- Orthogonal routing produces no segment that crosses the starting node
- The exported SVG contains no software metadata and no identifying comment
- Two saves of the same document produce identical bytes (deterministic
  writing)
- A graph with a dangling connector loads without errors, and validation
  reports it

---

## 14. Open decisions

- **The shape palette**: how many basic shapes? The useful minimum is
  rectangle, ellipse, diamond, parallelogram. The rest can be added later
- **Container nodes** (grouping, subgraphs), useful, but they complicate
  selection, moving and routing considerably. Defer
- **Connectors with more than two ends** (hyperedges), probably to be ruled
  out
- **Mermaid import**: useful, or a distraction?
- **Themes**: how much to allow customising without turning it into a style
  editor
