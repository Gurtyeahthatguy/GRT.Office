/** Wiring. */

import {
  createModel, createEvent, createTask, addCalendar, addEntry, updateEntry,
  removeEntry, findEntry, excludeOccurrence, calendarById, removeCalendar,
  fileNameFor,
} from './model.js';
import { draw, drawCalendars, drawTasks, viewTitle, entryAt, dateAt } from './render.js';
import { describe } from './recurrence.js';
import {
  today, addDays, addMonths, longDate, addMinutes, minutesBetween,
} from './time.js';
import { allDayEndFor, allDayLastDay } from './ical.js';
import * as io from './io.js';
import * as settingsStore from './settings.js';
import { showPanel, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme } from './core/theme.js';

const el = (id) => document.getElementById(id);

const model = createModel();
let settings = { ...settingsStore.DEFAULTS };
let runtime = { ephemeral: false, version: '0.0.0', defaultDirectory: null };

/** Which entry the open panel is editing. */
let editing = null;

// Startup

async function start() {
  runtime = await io.runtimeInfo();
  settings = await settingsStore.load();
  model.view = settings.view;

  el('version').textContent = runtime.version;
  el('ephemeral').classList.toggle('hidden', !runtime.ephemeral);

  await loadCalendars();

  if (runtime.initialFile) await openCalendarFile(runtime.initialFile);

  wire();
  wireSafetyNet();
  refresh();
  showSaveState(runtime.ephemeral ? 'unsaved' : 'idle');
}

/** Loads whatever calendars are in the folder. */
async function loadCalendars() {
  const directory = settings.directory ?? runtime.defaultDirectory;

  let listing = { directory, calendars: [] };
  try {
    listing = await io.listCalendars(directory);
  } catch {
    // A folder that cannot be read leaves the program usable and empty.
  }

  model.directory = listing.directory ?? directory;

  for (const found of listing.calendars) {
    try {
      const parsed = await io.readCalendar(found.path);
      const calendar = addCalendar(model, {
        name: parsed.name || found.name,
        path: found.path,
        entries: parsed.entries,
      });
      calendar.visible = !settings.hiddenCalendars.includes(calendar.name);
      if (parsed.unsupported.length > 0) {
        console.info(`${found.name}: components kept but not shown — ${parsed.unsupported.join(', ')}`);
      }
    } catch (error) {
      console.warn(`Cannot read ${found.path}: ${error}`);
    }
  }

  if (model.calendars.length === 0) {
    // The first run creates a calendar and immediately gives it a file, so
    // that everything typed into it from then on is saved without anyone
    // being asked anything.
    const first = addCalendar(model, { name: 'Personal', path: null, entries: [] });
    await giveItAFile(first);
  }
}

async function openCalendarFile(path) {
  try {
    const parsed = await io.readCalendar(path);
    const name = parsed.name || path.split(/[/\\]/).pop().replace(/\.ics$/i, '');
    addCalendar(model, { name, path, entries: parsed.entries });
    if (parsed.unsupported.length > 0) {
      await io.notify(
        `Opened. These parts were kept in the file but are not shown: ${parsed.unsupported.join(', ')}.`,
        'Calendar opened',
      );
    }
  } catch (error) {
    await io.notify(`Cannot open that calendar.\n\n${error}`, 'Open failed');
  }
}

// Saving

/** Saving is automatic. */

/** What the status bar is currently reporting. */
let saveState = 'idle';

function showSaveState(state) {
  saveState = state;
  const node = el('save-state');
  if (!node) return;

  const text = {
    idle: '',
    saving: 'Saving…',
    saved: 'Saved',
    unsaved: 'Not saved yet',
    failed: 'Could not save',
  }[state] ?? '';

  node.textContent = text;
  node.classList.toggle('failed', state === 'failed');
  node.classList.toggle('unsaved', state === 'unsaved');
}

/**
 * Writes every calendar that has changed, now.
 * @param {{silent?: boolean}} options `silent` false reports failures in a
 */
async function saveDirty({ silent = true } = {}) {
  const pending = model.calendars.filter((calendar) => calendar.dirty && calendar.path);

  if (pending.length === 0) {
    const homeless = model.calendars.some((calendar) => calendar.dirty && !calendar.path);
    showSaveState(homeless ? 'unsaved' : saveState === 'failed' ? 'idle' : saveState);
    return true;
  }

  showSaveState('saving');

  for (const calendar of pending) {
    try {
      await io.writeCalendar(calendar.path, calendar);
      calendar.dirty = false;
    } catch (error) {
      showSaveState('failed');
      if (!silent) await io.notify(`Cannot save ${calendar.name}.\n\n${error}`, 'Save failed');
      return false;
    }
  }

  showSaveState('saved');
  drawCalendars(model, el('calendars'));
  return true;
}

/** Called after every change that touched the model. */
function autoSave() {
  if (runtime.ephemeral) {
    showSaveState('unsaved');
    return;
  }
  saveDirty();
}


async function giveItAFile(calendar) {
  if (runtime.ephemeral || calendar.path || !model.directory) return false;
  calendar.path = `${model.directory}/${fileNameFor(model, calendar.name)}`;
  return saveDirty();
}

async function saveCalendarAs(calendar) {
  const path = await io.pickToSave(fileNameFor(model, calendar.name));
  if (!path) return;
  calendar.path = path.endsWith('.ics') ? path : `${path}.ics`;
  calendar.dirty = true;
  await saveDirty({ silent: false });
  refresh();
}

/** A last chance to write anything outstanding. */
function wireSafetyNet() {
  const flush = () => { if (!runtime.ephemeral) saveDirty(); };
  window.addEventListener('pagehide', flush);
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

// Drawing

function refresh() {
  el('view-title').textContent = viewTitle(model, settings.weekStart);
  draw(model, el('surface'), { weekStart: settings.weekStart });
  drawCalendars(model, el('calendars'));
  drawTasks(model, el('tasks'), { includeCompleted: settings.showCompletedTasks });

  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === model.view);
  }
}

function persist() {
  settings.view = model.view;
  settings.hiddenCalendars = model.calendars
    .filter((calendar) => !calendar.visible)
    .map((calendar) => calendar.name);
  settingsStore.save(settings);
}

// Navigation

function step(direction) {
  if (model.view === 'month') model.cursor = addMonths(model.cursor, direction);
  else if (model.view === 'week') model.cursor = addDays(model.cursor, 7 * direction);
  else if (model.view === 'day') model.cursor = addDays(model.cursor, direction);
  else model.cursor = addDays(model.cursor, 30 * direction);
  refresh();
}

function setView(view) {
  model.view = view;
  refresh();
  persist();
}

// Event editing

const REPEATS = [
  ['', 'Does not repeat'],
  ['FREQ=DAILY', 'Every day'],
  ['FREQ=WEEKLY', 'Every week'],
  ['FREQ=WEEKLY;INTERVAL=2', 'Every two weeks'],
  ['FREQ=MONTHLY', 'Every month'],
  ['FREQ=YEARLY', 'Every year'],
];

function eventForm(entry, calendarId) {
  const start = entry.start ?? { date: today(), time: '09:00' };
  const end = entry.end ?? { date: start.date, time: '10:00' };
  const lastDay = entry.allDay ? allDayLastDay(end.date) : end.date;

  const calendars = model.calendars.map((calendar) => (
    `<option value="${calendar.id}"${calendar.id === calendarId ? ' selected' : ''}>${escapeHtml(calendar.name)}</option>`
  )).join('');

  // A rule this program did not write is offered back as it stands, so
  // choosing something else is a deliberate act rather than an accident of
  // opening the dialog.
  const known = REPEATS.some(([value]) => value === (entry.rrule ?? ''));
  const custom = !known && entry.rrule
    ? `<option value="${escapeHtml(entry.rrule)}" selected>${escapeHtml(describe(entry.rrule) ?? entry.rrule)}</option>`
    : '';

  const repeats = REPEATS.map(([value, label]) => (
    `<option value="${value}"${known && value === (entry.rrule ?? '') ? ' selected' : ''}>${label}</option>`
  )).join('');

  return `
    <label>Title<input data-field="summary" value="${escapeHtml(entry.summary)}" placeholder="What is it?"></label>
    <label class="inline"><input type="checkbox" data-field="allDay"${entry.allDay ? ' checked' : ''}> All day</label>
    <div class="row">
      <label>Starts<input type="date" data-field="startDate" value="${start.date}"></label>
      <label>at<input type="time" data-field="startTime" value="${start.time ?? '09:00'}"></label>
    </div>
    <div class="row">
      <label>Ends<input type="date" data-field="endDate" value="${lastDay}"></label>
      <label>at<input type="time" data-field="endTime" value="${end.time ?? '10:00'}"></label>
    </div>
    <label>Repeat<select data-field="rrule">${repeats}${custom}</select></label>
    <label>Calendar<select data-field="calendar">${calendars}</select></label>
    <label>Location<input data-field="location" value="${escapeHtml(entry.location)}"></label>
    <label>Notes<textarea data-field="description" rows="3">${escapeHtml(entry.description)}</textarea></label>
  `;
}

function readEventForm(fields) {
  const allDay = Boolean(fields.allDay);
  const start = { date: fields.startDate, time: allDay ? null : fields.startTime, zone: null };

  let end;
  if (allDay) {
    // DTEND is exclusive: an event covering only today ends tomorrow.
    end = { date: allDayEndFor(fields.endDate || fields.startDate), time: null, zone: null };
  } else {
    end = { date: fields.endDate || fields.startDate, time: fields.endTime, zone: null };
    // An end before the start is a typo, not an instruction.
    if (minutesBetween(start, end) <= 0) {
      end = { ...addMinutes({ date: start.date, time: start.time }, 60), zone: null };
    }
  }

  return {
    summary: fields.summary ?? '',
    location: fields.location ?? '',
    description: fields.description ?? '',
    allDay,
    start,
    end,
    rrule: fields.rrule || null,
  };
}

async function newEvent(date = model.cursor, time = null) {
  const target = model.calendars.find((calendar) => calendar.visible) ?? model.calendars[0];
  if (!target) return;

  const draft = createEvent({ date, time: time ?? '09:00', allDay: time === null && model.view === 'month' });
  const confirmed = await showPanel('New event', eventForm(draft, target.id), 'Add');
  if (!confirmed) return;

  const fields = readFields();
  const changes = readEventForm(fields);
  if (!changes.summary.trim()) changes.summary = '(no title)';

  Object.assign(draft, changes);
  addEntry(model, fields.calendar || target.id, draft);
  refresh();
  autoSave();
}

async function editEvent(uid, occurrenceDate) {
  const found = findEntry(model, uid);
  if (!found) return;

  const { entry, calendar } = found;
  const repeating = Boolean(entry.rrule);
  editing = { uid, date: occurrenceDate };

  const confirmed = await showPanel(
    repeating ? `Event — ${longDate(occurrenceDate)}` : 'Event',
    eventForm(entry, calendar.id)
      + (repeating ? '<p class="hint">Changes apply to the whole series. Use Delete to remove just this one.</p>' : '')
      + '<button type="button" id="panel-delete" class="danger">Delete</button>',
    'Save',
  );

  editing = null;
  if (!confirmed) return;

  const fields = readFields();
  updateEntry(model, uid, readEventForm(fields));

  // Moving an entry to another calendar is a remove and an add.
  if (fields.calendar && fields.calendar !== calendar.id) {
    const moved = removeEntry(model, uid);
    if (moved) addEntry(model, fields.calendar, moved);
  }

  refresh();
  autoSave();
}

async function deleteOccurrence(uid, date) {
  const found = findEntry(model, uid);
  if (!found) return;

  if (!found.entry.rrule) {
    removeEntry(model, uid);
  } else {
    const whole = await showPanel(
      'Delete repeating event',
      `<p>${escapeHtml(found.entry.summary)} repeats.</p>
       <label class="inline"><input type="radio" name="scope" data-field="scope" value="one" checked> Just ${escapeHtml(longDate(date))}</label>
       <label class="inline"><input type="radio" name="scope" value="all"> The whole series</label>`,
      'Delete',
    );
    if (!whole) return;
    const chosen = document.querySelector('input[name="scope"]:checked')?.value ?? 'one';
    if (chosen === 'all') removeEntry(model, uid);
    else excludeOccurrence(model, uid, date);
  }

  refresh();
  autoSave();
}

// Tasks

async function newTask() {
  const target = model.calendars.find((calendar) => calendar.visible) ?? model.calendars[0];
  if (!target) return;

  const confirmed = await showPanel('New task', `
    <label>Task<input data-field="summary" placeholder="What has to be done?"></label>
    <label>Due<input type="date" data-field="due" value="${today()}"></label>
    <label>Priority<select data-field="priority">
      <option value="0">None</option>
      <option value="1">High</option>
      <option value="5">Medium</option>
      <option value="9">Low</option>
    </select></label>
  `, 'Add');
  if (!confirmed) return;

  const fields = readFields();
  const task = createTask({
    summary: fields.summary || '(no title)',
    due: fields.due || null,
    priority: Number(fields.priority) || 0,
  });
  addEntry(model, target.id, task);
  refresh();
  autoSave();
}

function toggleTask(uid) {
  const found = findEntry(model, uid);
  if (!found) return;
  updateEntry(model, uid, {
    completed: !found.entry.completed,
    status: found.entry.completed ? 'NEEDS-ACTION' : 'COMPLETED',
  });
  refresh();
  autoSave();
}

// Calendars

async function newCalendar() {
  const confirmed = await showPanel('New calendar', `
    <label>Name<input data-field="name" placeholder="Work"></label>
  `, 'Create');
  if (!confirmed) return;

  const fields = readFields();
  const name = (fields.name || '').trim();
  if (!name) return;

  const calendar = addCalendar(model, { name, path: null, entries: [] });
  await giveItAFile(calendar);
  refresh();
}

async function forgetCalendar(id) {
  const calendar = calendarById(model, id);
  if (!calendar) return;

  const alsoDelete = calendar.path
    ? await io.confirm(
      `Remove "${calendar.name}" from the list, and delete ${calendar.path}?\n\nThis cannot be undone.`,
      'Delete calendar',
    )
    : false;

  if (calendar.path && alsoDelete) {
    try {
      await io.removeCalendarFile(calendar.path);
    } catch (error) {
      await io.notify(`Cannot delete the file.\n\n${error}`, 'Delete failed');
      return;
    }
  } else if (calendar.path && !alsoDelete) {
    return;
  }

  removeCalendar(model, id);
  refresh();
}

// Settings

async function openSettings() {
  const themes = THEMES.map((theme) => (
    `<option value="${theme.id}"${theme.id === settings.theme ? ' selected' : ''}>${theme.label}</option>`
  )).join('');

  const confirmed = await showPanel('Settings', `
    <label>Theme<select data-field="theme">${themes}</select></label>
    <label>Week starts on<select data-field="weekStart">
      <option value="1"${settings.weekStart === 1 ? ' selected' : ''}>Monday</option>
      <option value="0"${settings.weekStart === 0 ? ' selected' : ''}>Sunday</option>
    </select></label>
    <label class="inline"><input type="checkbox" data-field="showCompletedTasks"${settings.showCompletedTasks ? ' checked' : ''}> Show completed tasks</label>
    <p class="hint">Calendars are read from<br><code>${escapeHtml(model.directory ?? 'nowhere yet')}</code></p>
    <p class="hint">Files are written as plain iCalendar, with no software name,
    no timestamps and no timezone in them. Any other calendar program can read
    them; none of them can tell where they came from.</p>
  `, 'Apply');

  if (!confirmed) return;

  const fields = readFields();
  settings.theme = fields.theme;
  settings.weekStart = Number(fields.weekStart);
  settings.showCompletedTasks = Boolean(fields.showCompletedTasks);
  applyTheme(settings.theme);
  refresh();
  persist();
}

// Wiring

function wire() {
  el('btn-prev').onclick = () => step(-1);
  el('btn-next').onclick = () => step(1);
  el('btn-today').onclick = () => { model.cursor = today(); refresh(); };
  el('btn-new-event').onclick = () => newEvent();
  el('btn-new-task').onclick = () => newTask();
  el('btn-new-calendar').onclick = () => newCalendar();
  el('btn-open').onclick = async () => {
    const path = await io.pickToOpen();
    if (path) { await openCalendarFile(path); refresh(); }
  };
  // Saving is automatic, so this button exists for the two cases automation
  // does not cover.
  el('btn-save').onclick = async () => {
    for (const calendar of model.calendars) {
      if (calendar.dirty && !calendar.path) await saveCalendarAs(calendar);
    }
    await saveDirty({ silent: false });
    refresh();
  };
  el('btn-settings').onclick = () => openSettings();

  for (const button of document.querySelectorAll('[data-view]')) {
    button.onclick = () => setView(button.dataset.view);
  }

  el('search').oninput = (event) => {
    model.search = event.target.value;
    refresh();
  };

  el('surface').addEventListener('click', onSurfaceClick);
  el('calendars').addEventListener('click', onCalendarsClick);
  el('tasks').addEventListener('click', onTasksClick);
  document.addEventListener('keydown', onKey);
}

function onSurfaceClick(event) {
  const more = event.target.closest('[data-action="show-day"]');
  if (more) {
    model.cursor = more.dataset.date;
    setView('day');
    return;
  }

  const entry = entryAt(event.target);
  if (entry) {
    editEvent(entry.uid, entry.date);
    return;
  }

  const where = dateAt(event.target);
  if (!where) return;
  newEvent(where.date, where.hour === null
    ? null
    : `${String(where.hour).padStart(2, '0')}:00`);
}

function onCalendarsClick(event) {
  const toggle = event.target.closest('[data-action="toggle-calendar"]');
  if (toggle) {
    const calendar = calendarById(model, toggle.dataset.calendar);
    if (calendar) calendar.visible = toggle.checked;
    refresh();
    persist();
    return;
  }

  const row = event.target.closest('[data-calendar]');
  if (row && event.detail === 2) forgetCalendar(row.dataset.calendar);
}

function onTasksClick(event) {
  const box = event.target.closest('[data-action="toggle-task"]');
  if (box) { toggleTask(box.dataset.uid); return; }

  const text = event.target.closest('.task-text');
  if (text) editTask(text.dataset.uid);
}

async function editTask(uid) {
  const found = findEntry(model, uid);
  if (!found) return;
  const task = found.entry;

  const confirmed = await showPanel('Task', `
    <label>Task<input data-field="summary" value="${escapeHtml(task.summary)}"></label>
    <label>Due<input type="date" data-field="due" value="${task.due?.date ?? ''}"></label>
    <label>Priority<select data-field="priority">
      <option value="0"${task.priority === 0 ? ' selected' : ''}>None</option>
      <option value="1"${task.priority > 0 && task.priority <= 4 ? ' selected' : ''}>High</option>
      <option value="5"${task.priority === 5 ? ' selected' : ''}>Medium</option>
      <option value="9"${task.priority > 5 ? ' selected' : ''}>Low</option>
    </select></label>
    <label class="inline"><input type="checkbox" data-field="completed"${task.completed ? ' checked' : ''}> Done</label>
  `, 'Save');

  if (!confirmed) return;

  const fields = readFields();
  updateEntry(model, uid, {
    summary: fields.summary || '(no title)',
    due: fields.due ? { date: fields.due, time: null, zone: null } : null,
    priority: Number(fields.priority) || 0,
    completed: Boolean(fields.completed),
    status: fields.completed ? 'COMPLETED' : 'NEEDS-ACTION',
  });
  refresh();
  autoSave();
}

function onKey(event) {
  if (isDialogOpen() || isPaletteOpen()) return;
  if (event.target instanceof HTMLInputElement
    || event.target instanceof HTMLTextAreaElement) return;

  const control = event.ctrlKey || event.metaKey;

  if (control && event.key === 'k') { event.preventDefault(); openPalette(commands()); return; }
  if (control && event.key === 'n') { event.preventDefault(); newEvent(); return; }
  if (control && event.key === 's') { event.preventDefault(); el('btn-save').click(); return; }
  if (control && event.key === 'f') { event.preventDefault(); el('search').focus(); return; }
  if (control) return;

  const keys = {
    ArrowLeft: () => step(-1),
    ArrowRight: () => step(1),
    t: () => { model.cursor = today(); refresh(); },
    m: () => setView('month'),
    w: () => setView('week'),
    d: () => setView('day'),
    a: () => setView('agenda'),
  };

  const action = keys[event.key];
  if (action) { event.preventDefault(); action(); }
}

function commands() {
  return [
    { label: 'New event', run: () => newEvent() },
    { label: 'New task', run: () => newTask() },
    { label: 'New calendar', run: () => newCalendar() },
    { label: 'Open calendar', run: () => el('btn-open').click() },
    { label: 'Save', run: () => el('btn-save').click() },
    { label: 'Go to today', run: () => { model.cursor = today(); refresh(); } },
    { label: 'Month view', run: () => setView('month') },
    { label: 'Week view', run: () => setView('week') },
    { label: 'Day view', run: () => setView('day') },
    { label: 'Agenda view', run: () => setView('agenda') },
    { label: 'Settings', run: () => openSettings() },
  ];
}

/** Delete button inside the event panel. */
document.addEventListener('click', (event) => {
  if (event.target?.id !== 'panel-delete') return;
  const target = editing;
  editing = null;
  el('panel-cancel').click();
  if (target) deleteOccurrence(target.uid, target.date);
});

start();

export { model, readEventForm };
