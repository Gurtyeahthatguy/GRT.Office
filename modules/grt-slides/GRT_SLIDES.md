# GRT_SLIDES.md

Specification of the **GRT Slides** module; the suite's presentation editor.

Design document. It assumes the suite's principles, the `.grt` container
format and the shared core.

Position in the development order: **third module**, after GRT Read and
GRT Graphs.

---

## 1. Why this module comes third

It is the simplest of the three editors, despite appearances. A presentation is
an array of slides, and each slide an array of elements at absolute positions.
No text flow, no pagination, no dependency recalculation: the three things that
make Paper and Grid difficult.

**It reuses almost everything from Graphs.** Selection, dragging, resizing,
snapping to the grid, alignment guides, undo with grouping: it is the same
infrastructure for manipulating objects on a canvas. If Graphs is done well,
Slides starts half finished.

**It adds one piece that is needed later:** rich text editing inside a box. It
is a reduced version of what Paper will need, a good chance to face the
Selection API and formatting on a smaller problem, before the big module.

**The milestone.** With Read, Graphs and Slides there are three working
programs: the suite stops being a plan and becomes something that gets used.

---

## 2. What it does

A presentation editor: slides with text boxes, images and shapes placed freely,
plus a full-screen projection mode.

**Intended uses**

- Presentations for lectures, meetings, conferences
- Slides to project or to share as a self-contained file
- Single-page posters and notices
- Teaching material

**Out of scope**

- Complex animations between elements (paths, timelines, synchronisation)
- Embedded video with editing
- A collaborative mode (incompatible with zero network)
- Full `.pptx` compatibility, see §9
- Audio recording or narration

---

## 3. A technical choice: positioned DOM, not canvas

Every element of a slide is an HTML element positioned absolutely inside a
container that stands for the slide.

| | Positioned DOM | Canvas |
|---|---|---|
| Text editable in place | native | to be reimplemented |
| Fonts, line height, wrapping | free | by hand |
| Hit testing | free | to be implemented |
| Text selection | native | impossible |
| HTML export | trivial | a conversion |

**Decision: DOM.** The deciding factor is text. On a canvas it would be
necessary to rewrite typographic layout from nothing: wrapping, kerning, line
height,
selection, which the browser already does perfectly.

**Scaling.** A slide has a fixed logical size (1920×1080, say) and is scaled
with a `transform: scale()` on the container. Everything inside works in
logical coordinates: zoom, thumbnails and projection use the same code, and
only the scale factor changes.

Geometric shapes are inline SVG inside the element, reusing GRT Graphs' code.

---

## 4. Data model

```json
{
  "version": 1,
  "type": "slides",
  "canvas": { "w": 1920, "h": 1080 },
  "theme": "default",
  "masters": [
    {
      "id": "m1",
      "name": "Title and content",
      "elements": []
    }
  ],
  "slides": [
    {
      "id": "s1",
      "master": "m1",
      "notes": "",
      "transition": "none",
      "elements": [
        {
          "id": "e1",
          "kind": "text",
          "x": 160, "y": 200, "w": 1600, "h": 300,
          "rotation": 0,
          "z": 1,
          "content": [
            { "text": "The slide's title", "bold": true }
          ],
          "style": "title"
        },
        {
          "id": "e2",
          "kind": "image",
          "x": 200, "y": 600, "w": 500, "h": 340,
          "rotation": 0,
          "z": 2,
          "resource": "resources/img-001.png",
          "fit": "contain"
        }
      ]
    }
  ],
  "styles": {
    "title": { "font": "sans", "size": 72, "color": "#111111" },
    "body":  { "font": "sans", "size": 32, "color": "#333333" }
  }
}
```

### Decisions about the model

**Absolute logical coordinates, never percentages.** With a fixed canvas size,
absolute coordinates are simpler to manipulate and do not accumulate rounding
errors.

**Ids are random, not sequential**: as in Graphs: a sequential id reveals the
order things were made in.

**Text is an array of runs, not a string.** Each run carries its own
formatting. It is the smallest structure that allows bold and italic inside the
same box, and the same one GRT Paper will use in a fuller form.

**Styles are named.** Changing the "title" style updates every slide. It is
what separates a coherent presentation from one assembled slide by slide.

**`z` is explicit, not the array's order.** It makes "bring forward" and "send
back" operations on the data rather than reorderings of the array, which would
break references.

**Images are references to resources in the `.grt` container**, never base64
inline in the JSON. The JSON stays readable and the file does not swell.

---

## 5. Masters and themes

A **master** is a background slide: the elements it holds appear on every slide
that uses it, but cannot be edited from the slide itself.

They are for: a recurring logo, a page number, a background, the standard
position of the title and the body.

**A rule of simplicity:** a master is an ordinary slide with a flag. No
hierarchy of inheritance, no masters of masters. The complexity of PowerPoint's
"layouts" is the main source of its confusion.

The **theme** is the set of named styles plus the colour palette. Changing the
theme updates the whole presentation.

---

## 6. Interaction

Almost entirely shared with GRT Graphs, if that code is in the core, it is
reused here.

### Manipulating elements

- **Insert**: text, image, shape, line, a simple table
- **Move and resize**: dragging and handles, with snapping
- **Rotate**: a dedicated handle, snapping every 15°
- **Multiple selection**: a rubber band, `Ctrl+click`
- **Order**: bring forward, send back
- **Alignment and distribution** for a multiple selection
- **Alignment guides** while dragging, including guides to the centre of the
  slide

### Text

- Double-click to edit
- Formatting: bold, italic, underline, size, colour, alignment, bulleted and
  numbered lists
- **Optional automatic shrinking**: the text reduces if it does not fit the
  box. Useful, but switchable off, text quietly getting smaller is an
  unwelcome surprise in the middle of a presentation

### Navigation

- A side thumbnail panel, reorderable by dragging
- Duplicate a slide, delete, move
- **Sections** (optional, a later phase): grouping slides

### Command palette

`Ctrl+K`, as everywhere in the suite.

---

## 7. Presentation mode

This is the function the module must do well above every other: it is the
moment the software is used in front of people, and it cannot fail.

### Requirements

- **The Fullscreen API**, leaving on `Esc`
- Navigation: arrows, space, `PageUp`/`PageDown`, clicking
- **A black screen** on `B`, a white screen on `W`; the de facto standard, for
  taking attention away from the screen
- Go to slide N by typing the number
- **No interface element visible** during projection
- **The screensaver held off** during the presentation (the Wake Lock API, with
  a fallback on the Rust side)

### Presenter view

A second window on a second screen: the current slide, the next slide, the
notes, a clock.

It needs Tauri's multi-monitor handling. It is the most asked-for function
after basic projection, worth doing, but after everything else works.

### Transitions

Few and sober: none, fade, slide. Implemented with CSS transitions.

**Do not implement** the catalogue of elaborate transitions: they cost work,
they distract the audience, and nobody uses one twice.

---

## 8. File format and export

### Native

A `.grt` container with `"type": "slides"`. Images live in `resources/`.
Deterministic writing.

### Self-contained HTML export

**The module's distinctive function.** A single `.html` file, images in base64,
keyboard navigation included: it opens on any device with nothing installed, it
can be emailed, it can be archived.

It is more portable than a `.pptx` and cheap to implement, because the
rendering is already HTML.

The exported file must be traceless too: no comment carrying the software's
name and version, no timestamp.

### The other exports

| Format | Notes |
|---|---|
| **PDF** | Through GRT Read's engine. One slide per page; a handout option with several slides per sheet |
| **PNG / JPG** | One image per slide, at a chosen scale |
| **SVG** | For a single slide, reusing Graphs' code |

### Import

**`.pptx` for reading, partially.** The format is zipped XML: reading text,
positions and images is feasible. Reproducing effects, SmartArt, animations and
themes faithfully is not.

**The rule:** the import states openly what it did not convert, rather than
quietly producing a wrong presentation. A list of warnings when the import
finishes.

**`.pptx` export: not in the first version.** See §9.

---

## 9. The `.pptx` question

Worth being explicit about, because it is the first request that will arrive.

**The format is enormous.** OOXML for presentations is thousands of pages of
specification, and what PowerPoint actually produces does not match the
specification. Every independent implementation chases a moving target.

**A conversion always loses something.** LibreOffice has worked on it for
twenty years with a team and still gets complex layouts wrong.

**Decision:**
- **Partial import with explicit warnings**: feasible, useful
- **`.pptx` export**: deferred, and if it is implemented, with the same
  honesty, state what does not survive the conversion
- **The recommended exchange format is PDF or self-contained HTML**, neither of
  which loses anything, because neither tries to stay editable

Metadata counts here too: a `.pptx` export contains `dc:creator`,
`cp:lastModifiedBy` and `dcterms:created` by default. They have to be cleared
explicitly, as for PDFs.

---

## 10. Implementation order

1. A canvas with a fixed logical size and a scale
2. The data model and rendering the elements
3. Inserting, moving, resizing
4. Single and multiple selection, snapping and guides
5. Text boxes with basic formatting
6. The thumbnail panel, adding and reordering slides
7. Undo and redo with dragging grouped
8. Images: inserting, fitting, cropping
9. Named styles and themes
10. `.grt` saving and loading
11. **Full-screen presentation mode**
12. Self-contained HTML export
13. Masters
14. PDF export through GRT Read
15. Presenter view on a second screen
16. Partial `.pptx` import
17. Shapes and lines (reused from Graphs)

**The useful milestone:** after point 12 the program does what it is for, a
presentation can be made, projected and shared.

---

## 11. File structure

```
grt-slides/
├── GRT_SLIDES.md
├── src/
│   ├── index.html
│   ├── present.html        the projection window, separate
│   ├── css/
│   └── js/
│       ├── model.js        the data model, independent of rendering
│       ├── render.js       model → DOM
│       ├── interaction.js  mouse, keyboard, selection
│       ├── text.js         rich text editing inside the boxes
│       ├── thumbnails.js   the thumbnail panel
│       ├── present.js      presentation mode and presenter view
│       ├── commands.js     commands for undo and redo
│       └── export.js       HTML, PNG, SVG, PDF
├── src-tauri/
├── scripts/
│   └── check-build.sh
└── tests/
    ├── model.test.js
    ├── export.test.js
    └── determinism.test.js
```

The same constraint as Graphs: `model.js` imports nothing from `render.js`.

---

## 12. The main tests

- Two saves of the same document produce identical bytes
- The exported HTML contains no metadata and no identifying comment
- The exported PDF has its metadata cleared (checked against the bytes)
- Deleting a slide and undoing restores it with all its elements, in their
  original positions
- A drag produces one entry in the undo stack, not many
- Embedded images survive save → close → reopen
- An imported `.pptx` produces the expected list of warnings rather than
  failing silently
- Presentation mode leaves no interface element visible in full screen

---

## 13. Open decisions

- **Tables in slides**: how simple? Is a static grid enough, or is per-cell
  editing needed?
- **Charts**: defer to when GRT Grid exists, and reuse its code
- **Sections** for grouping slides: useful past about thirty slides, and they
  complicate the thumbnail panel
- **Automatic text shrinking**: on or off by default?
- **Embedded fonts** in the HTML export: they make the file self-sufficient but
  swell it, and fonts carry metadata of their own to clean
- **Canvas size**: only 16:9, or 4:3 and free sizes as well?
