# GRT_NOTES_DATES.md

Specification of the **GRT Notes** (notes and notebooks) and **GRT Dates**
(calendar and tasks) modules of the GRT suite.

Design document. It assumes the suite's principles, the `.grt` container
format and the shared core, and `GRT_PAPER.md` (the text editor, whose
engine Notes reuses).

Position in the development order: **fifth phase**, after GRT Paper.

---

## 1. Why they are in the same document

They are **two separate programs**; two binaries, two icons, like every module
in the suite. But they should be designed and built together, for three
reasons:

**Notes is nearly free after Paper.** The text editor, the undo commands, the
formatting: it is the same engine. Only the container changes, a tree of
notebooks and pages instead of a single document, and full-text search is
added.

**Dates is small.** A local calendar with no synchronisation is weeks, not
months. On its own it would not justify a phase.

**They touch at one point only.** A note can have a date; an event can have a
note. That point of contact should be designed once, not invented twice in
incompatible ways.

**The milestone for the phase:** with Read, Graphs, Slides, Paper, Notes and
Dates the suite covers real daily use. Only the spreadsheet is left out.

---

# PART I: GRT NOTES

## 2. What it does

A system of local notes: notebooks, sections, pages, with search across the
whole archive.

**Intended uses**

- Study notes organised by subject
- A work diary and project notes
- A collection of references and clippings
- Quick notes to come back to later

**Out of scope**

- Synchronisation between devices (incompatible with zero network)
- Collaboration
- Web page clipping (it would need an embedded browser)
- Handwriting recognition
- An Obsidian-style graph of links with a network view, see §6

---

## 3. The structure of the archive

**The central decision: folders on the filesystem, not a single database.**

```
Archive/
├── University/                 a notebook
│   ├── Philosophy/             a section
│   │   ├── 001-kant.grt        a page
│   │   └── 002-hume.grt
│   └── Computing/
│       └── 001-networks.grt
└── Projects/
    └── GRT/
        └── 001-ideas.grt
```

**Why not a single database**

- Every note is a file of its own: it can be copied, moved, put in a backup,
  versioned in git
- One corrupt file loses one note, not the whole archive
- The archive can be inspected without the program, consistent with the `.grt`
  format's longevity principle
- The tree structure *is* the filesystem: no information duplicated between a
  database and the disk

**The cost:** searching hundreds of files needs an index. See §5.

**A numeric prefix in the file names** for manual ordering, followed by the
normalised title. The order comes from the name, not from a field in a
database.

---

## 4. The model of a page

A `.grt` container with `"type": "notes"`. The content uses **the same model of
blocks and runs as GRT Paper**, with two differences:

```json
{
  "version": 1,
  "type": "notes",
  "title": "Critique of Pure Reason",
  "tags": ["philosophy", "kant"],
  "blocks": [ ... ]
}
```

**No pagination.** A note has no pages, no margins and no breaks: it is text
that scrolls. This removes the whole of `pagination.js`, which is the most
expensive part of Paper.

**Blocks additional to Paper's:**

| Block | Use |
|---|---|
| `todo` | A tick box with text |
| `code` | A code block with highlighting |
| `callout` | A highlighted box (a note, a warning) |
| `embed` | A reference to another `.grt` file in the suite |

**Tags are in the file, not in an external database.** Moving the file
elsewhere does not lose the tags.

---

## 5. Search

It is the function that makes an archive of notes useful. Without it, past
fifty pages the archive is unusable.

### The index

**SQLite with FTS5**, in an index file separate from the archive.

**The rule:** the index is **derived and rebuildable**. If it is deleted, it
regenerates by scanning the archive. It never holds the only copy of anything.

**The consequence for privacy:** the index contains the text of the notes in
searchable form. It must be treated as sensitive as the notes themselves, not
put in `/tmp`, not excluded from the disk encryption, and deleted by ephemeral
mode.

### Updating

- When a note changes, only that file is re-indexed
- At startup, a quick comparison between the files' modification times and the
  index detects changes made outside the program
- An explicit "rebuild the index" command

### What the search does

- Free text across the whole archive
- Filtering by notebook, section, tag
- Searching the title only
- Regular expressions (for those who want them)
- Results with a preview of the context

---

## 6. Links between notes

The syntax `[[note-title]]` inside the text, resolved against the archive.

**What to implement:**
- Completion while typing
- Clicking to open the linked note
- A list of incoming links ("linked from") in a side panel

**What not to implement:** a graph view of the whole archive. It is visually
attractive, expensive to do well, and practically useless past a hundred notes.
If it were ever genuinely wanted, GRT Graphs can read an export.

**Consistency with `.grt`:** a link between notes is the same mechanism as the
links between documents the suite defines. The same reference syntax,
and the same rule: resolved on request, never automatically in the background.

---

## 7. Quick notes

A panel that opens with a global shortcut, is written in, and is closed. The
note lands in an "Inbox" notebook to be filed later.

It is the function that decides whether the program actually gets used: if
writing something down means opening an application, navigating a tree and
choosing a place, it does not get written down.

**A caution:** a global shortcut requires the program to stay in memory. It has
to be optional and switchable off; a process that is always running is in
tension with ephemeral mode.

---

# PART II: GRT DATES

## 8. What it does

A local calendar and task list.

**Intended uses**

- Personal appointments and commitments
- Project deadlines
- Recurring tasks
- Reminders

**Out of scope**

- Synchronisation with online calendars (Google, Outlook, CalDAV)
- Invitations and attendees
- Booking rooms or shared resources
- Notifications over a network

**Why synchronisation is out of scope:** a synchronised calendar is by
definition a network application, and calendar data is among the most revealing
there is: it says where a person is, with whom, and when. It is the same
reasoning that put GRT Sender outside the suite.

---

## 9. The format: iCalendar

**The decision: standard `.ics`, not a format of its own.**

It is the only module in the suite whose native format is not `.grt`, and the
reason is a good one: iCalendar (RFC 5545) is a mature standard, readable, and
supported everywhere. Anyone who wants to take their data elsewhere can, with
no conversion.

```
Calendar/
├── personal.ics
├── work.ics
└── tasks.ics
```

One file per calendar, as most clients do. The same principle as Notes:
self-contained files on the filesystem, not an opaque database.

**No-trace warnings for iCalendar:**

| Field | The problem |
|---|---|
| `PRODID` | Identifies the software that produced the file |
| `UID` | Some generators put the hostname and the user name in it |
| `DTSTAMP` | When the entry was created |
| `CREATED` / `LAST-MODIFIED` | The history of the changes |
| `TZID` | The timezone reveals the location |

`UID` must be generated at random. `PRODID` must be set to a neutral value. The
others must be handled deliberately: removing them entirely breaks some
readers, so the reasonable choice is to keep them minimal and to document the
behaviour.

---

## 10. Functions

### The first version

- Views: month, week, day, agenda
- Creating and deleting events
- All-day events
- Recurrences: daily, weekly, monthly, yearly, with exceptions
- Several calendars with distinct colours, switchable on and off
- A task list with a due date, a priority and a state
- Searching

### The second version

- `.ics` import and export
- Local reminders (a system notification, no network)
- Recurring tasks
- A year view

### Recurrences: the only difficult part

iCalendar's `RRULE` is more complex than it looks: "every second Tuesday of the
month except in August" is expressible, and has to be worked out correctly.

**The approach:** implement the subset that covers real use (`FREQ`,
`INTERVAL`, `BYDAY`, `BYMONTHDAY`, `UNTIL`, `COUNT`, `EXDATE`) and **preserve
intact** what cannot be interpreted, rather than discarding it silently. An
event imported with an exotic rule must survive being saved even if the program
cannot display it perfectly.

**Timezones:** use the system's library, never hand-written calculations.
Daylight saving is an inexhaustible source of bugs.

---

## 11. The point of contact between Notes and Dates

One mechanism, designed once.

- A note can have an **associated date** → it appears in the calendar as a
  linked entry
- An event can have a **linked note** → it opens in Notes

Built on the `grt://` references the suite already defines: the `.ics`
event holds the note's URI in an `X-GRT-NOTE` field, and the note holds the
date in its own manifest.

**The rule:** if the other program is not installed, the reference stays in the
file and causes no error. The two modules do not require each other.

---

## 12. Implementation order

### GRT Notes

1. The tree of notebooks, sections and pages on the filesystem
2. The editor, reusing GRT Paper's engine, without pagination
3. Creating, renaming, moving and deleting notes
4. `.grt` saving and loading
5. The additional blocks: `todo`, `code`, `callout`
6. Tags
7. **The SQLite FTS5 index and search**
8. Quick notes with a global shortcut
9. `[[note]]` links and the incoming-links panel
10. Markdown export of the whole archive
11. The `embed` block, pointing at other files in the suite

**The useful milestone:** after point 7 the program does what it is for.

### GRT Dates

1. The event model and reading and writing `.ics`
2. The month view
3. Creating and changing events
4. The week, day and agenda views
5. Several calendars with colours
6. **Recurrences**
7. The task list
8. Searching
9. `.ics` import and export
10. Local reminders
11. The link with Notes

**The useful milestone:** after point 6.

---

## 13. File structure

```
grt-notes/
├── GRT_NOTES_DATES.md
├── src/js/
│   ├── tree.js          the tree of notebooks, sections and pages
│   ├── editor.js        reusing Paper's engine
│   ├── index.js         the SQLite FTS5 index
│   ├── search.js
│   ├── links.js         [[note]] links
│   └── quicknote.js
└── src-tauri/

grt-dates/
├── src/js/
│   ├── model.js         events and tasks
│   ├── ical.js          reading and writing .ics
│   ├── recurrence.js    expanding RRULE
│   ├── views/           month, week, day, agenda
│   └── tasks.js
└── src-tauri/
```

Both share `core/` with the other modules.

---

## 14. The main tests

**Notes**
- A note moved by hand in the filesystem is found again at startup
- A deleted index rebuilds with nothing lost
- Search finds text inside `code` and `callout` blocks
- A `[[note]]` link pointing at a note that does not exist does not break
  loading
- Two saves of the same note produce identical bytes
- The Markdown export of the archive keeps the tree structure

**Dates**
- An exported `.ics` contains no hostname and no user name in the `UID`
- The `PRODID` is a neutral value
- A recurrence with an unsupported rule survives import and saving intact
- The change to summer time does not move any event
- A recurring event with exceptions expands correctly across a year

---

## 15. Open decisions

- **Notes: encrypting the archive.** As for the `.grt` format, the current
  position is to delegate to LUKS or VeraCrypt rather than implementing it in
  the program. To be reconfirmed, because notes are the most personal content
  in the suite
- **Notes: attachments.** Arbitrary files inside a note, or only references to
  files outside it?
- **Notes: version history** per note, useful, and in tension with ephemeral
  mode
- **Dates: reminders.** They require a process running in the background, which
  is in tension with the suite's principles. Optional and switchable off
- **Dates: read-only CalDAV import**: one-off and manual, it is network, but
  one-directional and on an explicit request. To be decided
- **Whether Notes and Dates should be a single binary** after all: the boundary
  is clear in the data, less so in daily use
