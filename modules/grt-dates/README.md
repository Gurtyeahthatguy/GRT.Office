# GRT Dates

A calendar and task list that never leaves your machine.

Part of [GRT Suite](../../README.md). Design document:
[docs/GRT_NOTES_DATES.md](../../docs/GRT_NOTES_DATES.md), Part II.

## What it does

- Month, week, day and agenda views
- Events, all-day events, and repeating events with exceptions
- Several calendars at once, each with its own colour, shown or hidden
- Tasks with a due date, a priority and a done state
- Search across titles, places and notes
- Five themes, shared with the rest of the suite, and the `Ctrl+K` palette

## Where your calendars live

Ordinary `.ics` files in an ordinary folder, by default `GRT Calendar` in your
documents directory. One file per calendar.

This is the only module in the suite whose native format is not `.grt`. The
reason is that iCalendar (RFC 5545) is a mature, readable, portable standard:
every other calendar program can already open these files, and if you ever
stop using this one you take your data with you and convert nothing.

## What it does not do, and will not

- **No synchronisation.** Not with Google, not with Outlook, not over CalDAV.
  Calendar data is among the most revealing there is, it says where you are,
  who you are with, and when, and a synchronised calendar is by definition a
  network application. That is the same reasoning that keeps a mail client out
  of the suite entirely.
- **No invitations, no attendees, no shared resources.** Those are all forms of
  the same thing.
- **No network notifications.** Reminders, when they arrive, will be local.

## What it will not write into your files

Every calendar file carries fields that identify the machine and the person who
made it. Each is handled on purpose:

| Field | What it usually leaks | What this writes |
|---|---|---|
| `PRODID` | the software and its version | a fixed neutral string |
| `UID` | very often the hostname and user name | random, nothing else |
| `DTSTAMP` | when you wrote the entry | a constant |
| `CREATED`, `LAST-MODIFIED` | your editing history | nothing at all |
| `TZID` | which part of the world you are in | nothing at all |

Times are written as **floating local time**, `20260901T100000`, with no zone
and no `Z`. RFC 5545 defines that as local time wherever the file is read,
which is what a personal calendar wants: ten o'clock is ten o'clock. It also
means the file does not announce where you were, and it makes the
daylight-saving problem disappear instead of having to be handled.

Timestamps that arrive from another program are read and discarded rather than
carried forward.

## What it keeps even though it does not understand it

A recurrence rule using parts this program cannot expand, `BYSETPOS`,
`BYWEEKNO`, is preserved character for character and written back unchanged.
So are properties it has never heard of. Opening a calendar and saving it never
silently loses what another program put there.

Where a rule cannot be fully expanded, the occurrences shown are marked
approximate rather than drawn with false confidence.

## Building

```bash
npm install
npm run build
./scripts/install-local.sh
```

`--remove` undoes the install completely.

## Testing

```bash
npm test
```

145 tests. The ones worth knowing about:

- a written file carries no hostname or user name, **with canary tests proving
  the search would find one if it were there**; an absence test that cannot
  fail is worse than no test, and this project has been caught by that twice
- two saves of the same calendar produce byte-identical files
- an unsupported recurrence rule survives import and save unchanged
- a repeating event with exceptions expands correctly across a whole year
- the clocks changing does not move anything
- clicking an event resolves to that event, from the innermost element the
  click actually lands on; the test that would have caught the broken
  dragging in GRT Graphs

## Looking at it

```bash
./scripts/preview.sh
```

Serves the real interface on `http://localhost:8725` with the backend stubbed,
so the window can be looked at in a browser. jsdom has no layout engine, so no
test can see that something is in the wrong place, and running this found
nothing yet, which is worth knowing too.

The stub that answers the backend is `scripts/preview-stub.js`. Stylesheets and
scripts are served through links, so a reload picks up an edit.

## Keyboard

| Key | Does |
|---|---|
| `M` `W` `D` `A` | month, week, day, agenda |
| `T` | today |
| `←` `→` | back, forward |
| `Ctrl+N` | new event |
| `Ctrl+S` | save |
| `Ctrl+F` | search |
| `Ctrl+K` | command palette |
