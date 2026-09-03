/** Wiring. */

import { makeBlock, runsText } from './core/editor/model.js';
import { InputCapture } from './core/editor/input.js';
import { EditorController } from './core/editor/controller.js';
import { showPanel, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme } from './core/theme.js';

import { NoteDocument, makeTodo, makeCallout, makeEmbed, parseTagInput } from './note.js';
import { NotesRenderer } from './render-notes.js';
import * as tree from './tree.js';
import * as links from './links.js';
import * as search from './search.js';
import { noteToMarkdown, archiveToMarkdown } from './export.js';
import * as io from './io.js';
import * as settingsStore from './settings.js';

const el = (id) => document.getElementById(id);
const surface = () => el('surface');

let settings = { ...settingsStore.DEFAULTS };
let runtime = { ephemeral: false, version: '0.0.0', defaultRoot: null };

let archive = { root: null, notebooks: [] };
let note = new NoteDocument();
let notePath = null;

/** Everything between a keystroke and the model. */
let editor = null;

/**
 * Titles and links for every note, so `[[…]]` can resolve without reading.
 */
let catalogue = [];
let titleIndex = links.buildTitleIndex([]);

let renderer = null;
let saveState = 'idle';

// Startup

async function start() {
  runtime = await io.runtimeInfo();
  settings = await settingsStore.load();

  el('version').textContent = runtime.version;
  el('ephemeral').classList.toggle('hidden', !runtime.ephemeral);

  renderer = new NotesRenderer(surface(), {
    resolveLink: (title) => links.resolve(title, titleIndex),
  });
  editor = new EditorController(surface(), renderer, { onChange: refreshAfterEdit });

  await loadArchive();
  await reindex();

  const first = tree.allNotes(archive)[0];
  if (first) await openNote(first.path);
  else await newNote();

  wire();
  refresh();
}

async function loadArchive() {
  try {
    archive = await io.readArchive(settings.root);
  } catch (error) {
    archive = { root: settings.root ?? runtime.defaultRoot, notebooks: [] };
    console.warn(`Cannot read the archive: ${error}`);
  }

  // A first run has no folders at all.
  if (archive.notebooks.length === 0 && archive.root && !runtime.ephemeral) {
    try {
      await io.createFolder(tree.join(archive.root, 'Notes'));
      archive = await io.readArchive(settings.root);
    } catch { /** read-only location; the program still runs. */ }
  }
}

/** Brings the search index into line with the archive. */
async function reindex() {
  const pages = tree.allNotes(archive);

  const result = await search.refresh(pages, {
    indexState: io.indexState,
    indexUpsert: io.indexUpsert,
    indexRemove: io.indexRemove,
    readNote: io.readNote,
  }).catch((error) => {
    console.warn(`Cannot update the index: ${error}`);
    return { indexed: 0, removed: 0, failed: [] };
  });

  if (result.failed.length > 0) {
    console.warn(`Could not index ${result.failed.length} note(s)`);
  }

  await rebuildCatalogue(pages);
}

/** Titles and outgoing links for every note. */
async function rebuildCatalogue(pages) {
  const bodies = await io.indexDump().catch(() => []);
  const byPath = new Map(bodies.map((row) => [row.path, row]));

  catalogue = pages.map((page) => {
    const row = byPath.get(page.path);
    return {
      path: page.path,
      title: row?.title || search.fallbackTitle(page),
      links: links.linksIn(row?.body ?? ''),
    };
  });

  titleIndex = links.buildTitleIndex(catalogue);
}

// Saving

/** Saving is automatic and immediate. */
let typingSaveTimer = null;

function showSaveState(state) {
  saveState = state;
  const node = el('save-state');
  if (!node) return;
  node.textContent = {
    idle: '', saving: 'Saving…', saved: 'Saved',
    unsaved: 'Not saved', failed: 'Could not save',
  }[state] ?? '';
  node.classList.toggle('failed', state === 'failed');
}

async function saveNow() {
  if (runtime.ephemeral) { showSaveState('unsaved'); return false; }
  if (!notePath || !note.dirty) return true;

  showSaveState('saving');
  try {
    await io.writeNote(notePath, note);
    note.dirty = false;
    showSaveState('saved');
    await indexCurrent();
    return true;
  } catch (error) {
    showSaveState('failed');
    console.warn(`Cannot save: ${error}`);
    return false;
  }
}

/** Text edits are collected briefly; everything else writes immediately. */
function autoSave({ typed = false } = {}) {
  if (runtime.ephemeral) { showSaveState('unsaved'); return; }
  clearTimeout(typingSaveTimer);
  if (typed) typingSaveTimer = setTimeout(() => { saveNow(); }, 600);
  else saveNow();
}

async function indexCurrent() {
  if (!notePath || runtime.ephemeral) return;
  try {
    await io.indexUpsert({
      path: notePath,
      title: note.title,
      tags: note.tags.join(' '),
      body: note.plainText(),
      modified: Math.floor(Date.now() / 1000),
    });
    const row = catalogue.find((item) => item.path === notePath);
    const outgoing = links.linksInNote(note);
    if (row) { row.title = note.title; row.links = outgoing; }
    else catalogue.push({ path: notePath, title: note.title, links: outgoing });
    titleIndex = links.buildTitleIndex(catalogue);
  } catch (error) {
    console.warn(`Cannot index this note: ${error}`);
  }
}

// Drawing

function refresh() {
  drawTree();
  drawHeader();
  drawBacklinks();
  updateToolbar();
}

function drawHeader() {
  const title = el('note-title');
  if (title.value !== note.title) title.value = note.title;
  el('note-tags').value = note.tags.map((tag) => `#${tag}`).join(' ');
}

function drawTree() {
  const collapsedSet = new Set(settings.collapsed);
  const rows = tree.flatten(archive, { collapsed: collapsedSet });
  const list = document.createElement('div');
  list.className = 'tree';

  for (const row of rows) {
    const node = document.createElement('button');
    node.className = `tree-row ${row.kind}`;
    node.dataset.path = row.path;
    node.dataset.kind = row.kind;
    node.style.setProperty('--depth', String(row.depth));
    node.classList.toggle('current', row.kind === 'note' && row.path === notePath);

    if (row.kind !== 'note') {
      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = row.collapsed ? '▸' : '▾';
      node.append(twisty);
    }

    const label = document.createElement('span');
    label.className = 'tree-name';
    label.textContent = row.kind === 'note' ? (titleFor(row) || row.name) : row.name;
    node.append(label);

    if (row.kind !== 'note') {
      const count = document.createElement('span');
      count.className = 'tree-count';
      count.textContent = String(row.count);
      node.append(count);
    }

    list.append(node);
  }

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No notebooks yet.';
    list.append(empty);
  }

  el('tree').replaceChildren(list);
}

/** The title from the catalogue, which is what search and links agree on. */
function titleFor(row) {
  return catalogue.find((item) => item.path === row.path)?.title ?? '';
}

function drawBacklinks() {
  const panel = el('backlinks');
  panel.classList.toggle('hidden', !settings.showBacklinks);
  if (!settings.showBacklinks) return;

  const incoming = notePath ? links.backlinksTo(notePath, catalogue, titleIndex) : [];
  const list = document.createElement('div');

  if (incoming.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing links here yet.';
    list.append(empty);
  }

  for (const link of incoming) {
    const row = document.createElement('button');
    row.className = 'backlink';
    row.dataset.path = link.path;
    row.textContent = link.title || tree.baseName(link.path);
    list.append(row);
  }

  el('backlink-list').replaceChildren(list);
}

function updateToolbar() {
  for (const [mark, id] of [['bold', 'btn-bold'], ['italic', 'btn-italic'],
    ['underline', 'btn-underline'], ['strike', 'btn-strike']]) {
    el(id)?.classList.toggle('active', Boolean(editor?.markIsOn(mark)));
  }
}

// Editing

/** All of it is in editing.js. */

function refreshAfterEdit({ typed = false } = {}) {
  updateToolbar();
  maybeComplete();
  autoSave({ typed });
}

// Notes

async function openNote(path) {
  await saveNow();
  try {
    note = await io.readNote(path);
  } catch (error) {
    await io.notify(`Cannot open that note.\n\n${error}`, 'Open failed');
    return;
  }
  notePath = path;
  editor.attach(note);
  showSaveState('idle');
  refresh();
}

/** Where a new note should go: the folder of the note in front of you. */
function currentFolder() {
  if (notePath) return tree.parentOf(notePath);
  const notebook = archive.notebooks[0];
  return notebook?.path ?? archive.root;
}

async function newNote({ folder = null, title = '', body = null } = {}) {
  const target = folder ?? currentFolder();
  if (!target) return;

  await saveNow();

  const siblings = tree.allNotes(archive)
    .filter((page) => tree.parentOf(page.path) === target)
    .map((page) => page.file);

  const fresh = new NoteDocument();
  fresh.setTitle(title);
  if (body) {
    fresh.blocks = [makeBlock('paragraph')];
    fresh.setRuns(fresh.blocks[0].id, [{ text: body }]);
  }
  fresh.dirty = true;

  const path = tree.join(target, tree.noteFileName(tree.nextOrder(siblings), title || 'note'));

  note = fresh;
  notePath = path;
  editor.attach(note);

  await saveNow();
  await loadArchive();
  await rebuildCatalogue(tree.allNotes(archive));

  refresh();
  el('note-title').focus();
}

/** Renames the file to match the title. */
async function syncFileName() {
  if (!notePath || runtime.ephemeral) return;

  const folder = tree.parentOf(notePath);
  const { order } = tree.parseNoteFile(tree.baseName(notePath).replace(/\.grt$/, ''));
  const wanted = tree.join(folder, tree.noteFileName(
    Number.isFinite(order) && order < Number.MAX_SAFE_INTEGER ? order : 1,
    note.title || 'note',
  ));

  if (wanted === notePath) return;

  try {
    await io.renameEntry(notePath, wanted);
    await io.indexRemove(notePath);
    const row = catalogue.find((item) => item.path === notePath);
    if (row) row.path = wanted;
    notePath = wanted;
    await indexCurrent();
    await loadArchive();
    refresh();
  } catch {
    // A name already in use, or a locked file.
  }
}

async function deleteNote(path) {
  const row = catalogue.find((item) => item.path === path);
  const name = row?.title || tree.baseName(path);
  const sure = await io.confirm(
    `Delete "${name}"?\n\nThe file is removed from the disk and this cannot be undone.`,
    'Delete note',
  );
  if (!sure) return;

  try {
    await io.deleteEntry(path);
    await io.indexRemove(path);
  } catch (error) {
    await io.notify(`Cannot delete that note.\n\n${error}`, 'Delete failed');
    return;
  }

  catalogue = catalogue.filter((item) => item.path !== path);
  titleIndex = links.buildTitleIndex(catalogue);
  await loadArchive();

  if (path === notePath) {
    notePath = null;
    const next = tree.allNotes(archive)[0];
    if (next) await openNote(next.path);
    else await newNote();
  }
  refresh();
}

// Notebooks and sections

async function newFolder(parentPath = null) {
  const inside = parentPath ?? archive.root;
  const isSection = Boolean(parentPath);

  const confirmed = await showPanel(isSection ? 'New section' : 'New notebook', `
    <label>Name<input data-field="name" placeholder="${isSection ? 'Philosophy' : 'University'}"></label>
  `, 'Create');
  if (!confirmed) return;

  const name = tree.folderName(readFields().name);
  try {
    await io.createFolder(tree.join(inside, name));
  } catch (error) {
    await io.notify(`Cannot create that folder.\n\n${error}`, 'Failed');
    return;
  }

  await loadArchive();
  refresh();
}

async function deleteFolder(path) {
  try {
    await io.deleteEntry(path);
  } catch (error) {
    await io.notify(String(error).replace(/^.*?: /, ''), 'Cannot remove it');
    return;
  }
  await loadArchive();
  refresh();
}

// Search

let searchMode = 'text';

async function runSearch() {
  const query = el('search').value.trim();
  const panel = el('results');

  if (!query) {
    panel.classList.add('hidden');
    return;
  }

  let hits = [];
  let error = null;

  if (searchMode === 'regex') {
    const rows = await io.indexDump().catch(() => []);
    ({ hits, error } = search.searchByPattern(rows, query));
  } else {
    hits = await io.indexSearch(query).catch(() => []);
  }

  const list = document.createElement('div');
  list.className = 'result-list';

  if (error) {
    const problem = document.createElement('p');
    problem.className = 'empty';
    problem.textContent = error;
    list.append(problem);
  } else if (hits.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing found.';
    list.append(empty);
  }

  for (const hit of hits) {
    const row = document.createElement('button');
    row.className = 'result';
    row.dataset.path = hit.path;

    const title = document.createElement('span');
    title.className = 'result-title';
    title.textContent = hit.title || tree.baseName(hit.path);

    const snippet = document.createElement('span');
    snippet.className = 'result-snippet';
    // The snippet arrives with the match wrapped in << >> by SQLite.
    for (const [i, piece] of String(hit.snippet ?? '').split(/<<|>>/).entries()) {
      if (i % 2 === 1) {
        const mark = document.createElement('mark');
        mark.textContent = piece;
        snippet.append(mark);
      } else if (piece) {
        snippet.append(document.createTextNode(piece));
      }
    }

    row.append(title, snippet);
    list.append(row);
  }

  panel.replaceChildren(list);
  panel.classList.remove('hidden');
}

// Link completion

function maybeComplete() {
  const box = el('completions');
  const at = editor?.selection?.anchor;
  const block = at ? note.block(at.blockId) : null;

  if (!block || block.kind === 'list') { box.classList.add('hidden'); return; }

  const text = runsText(block.runs ?? []);
  const pendingBrackets = links.pendingLink(text, at.offset);
  if (!pendingBrackets) { box.classList.add('hidden'); return; }

  const titles = catalogue.map((item) => item.title).filter(Boolean);
  const matches = links.complete(pendingBrackets.query, titles);
  if (matches.length === 0) { box.classList.add('hidden'); return; }

  const list = document.createElement('div');
  for (const title of matches) {
    const row = document.createElement('button');
    row.className = 'completion';
    row.dataset.title = title;
    row.dataset.from = String(pendingBrackets.from);
    row.textContent = title;
    list.append(row);
  }
  box.replaceChildren(list);
  box.classList.remove('hidden');
}

function acceptCompletion(title, from) {
  const at = editor?.selection?.anchor;
  const block = at ? note.block(at.blockId) : null;
  if (!block) return;

  const text = runsText(block.runs ?? []);
  const after = `${text.slice(0, from)}[[${title}]]${text.slice(at.offset)}`;

  el('completions').classList.add('hidden');
  editor.replaceBlockText(block.id, after, from + title.length + 4);
  refresh();
}

// Quick note

/** A note written without choosing where it goes. */
async function quickNote() {
  const confirmed = await showPanel('Quick note', `
    <label>Write it down<textarea data-field="text" rows="5" placeholder="Anything. File it later."></textarea></label>
    <p class="hint">Goes to the "${escapeHtml(settings.quickNoteNotebook)}" notebook.</p>
  `, 'Keep');
  if (!confirmed) return;

  const text = String(readFields().text ?? '').trim();
  if (!text) return;

  const folder = tree.join(archive.root, tree.folderName(settings.quickNoteNotebook));
  try {
    await io.createFolder(folder);
  } catch { /** it may already exist. */ }
  await loadArchive();

  const [firstLine] = text.split('\n');
  await newNote({
    folder,
    title: firstLine.slice(0, 60),
    body: text,
  });
}

// Export

async function exportNote() {
  const { text, lost } = noteToMarkdown(note);
  const path = await io.pickToSave(`${tree.slugify(note.title || 'note')}.md`);
  if (!path) return;
  await io.writeText(path, text);
  if (lost.length > 0) {
    await io.notify(`Saved.\n\nMarkdown cannot carry: ${lost.join(', ')}.`, 'Exported');
  }
}

async function exportArchive() {
  const target = await io.pickDirectory('Choose where to put the Markdown');
  if (!target) return;

  const pages = tree.allNotes(archive);
  const entries = [];
  for (const page of pages) {
    try {
      entries.push({
        note: await io.readNote(page.path),
        notebook: page.notebook,
        section: page.section,
        file: page.file,
      });
    } catch { /** one unreadable note must not stop the export. */ }
  }

  const { files, lost } = archiveToMarkdown(entries);
  for (const file of files) {
    await io.writeText(tree.join(target, file.path), file.text);
  }

  await io.notify(
    `${files.length} note(s) written, keeping the notebook and section folders.`
    + (lost.length > 0 ? `\n\nMarkdown cannot carry: ${lost.join(', ')}.` : ''),
    'Archive exported',
  );
}

// Settings

async function openSettings() {
  const themes = THEMES.map((theme) => (
    `<option value="${theme.id}"${theme.id === settings.theme ? ' selected' : ''}>${theme.label}</option>`
  )).join('');

  const confirmed = await showPanel('Settings', `
    <label>Theme<select data-field="theme">${themes}</select></label>
    <label class="inline"><input type="checkbox" data-field="showBacklinks"${settings.showBacklinks ? ' checked' : ''}> Show what links here</label>
    <label>Quick notes go to<input data-field="quickNoteNotebook" value="${escapeHtml(settings.quickNoteNotebook)}"></label>
    <p class="hint">The archive is<br><code>${escapeHtml(archive.root ?? 'nowhere yet')}</code></p>
    <p class="hint"><strong>The search index holds the text of every note.</strong>
    It lives in this program's own data folder — never in a temporary directory —
    and it is derived: deleting it loses nothing, and it rebuilds by reading the
    archive.</p>
    <button type="button" id="btn-forget" class="danger">Forget settings and index</button>
  `, 'Apply');

  if (!confirmed) return;

  const fields = readFields();
  settings.theme = fields.theme;
  settings.showBacklinks = Boolean(fields.showBacklinks);
  settings.quickNoteNotebook = String(fields.quickNoteNotebook || 'Inbox');
  applyTheme(settings.theme);
  refresh();
  settingsStore.save(settings);
}

// Wiring

function wire() {
  new InputCapture(surface(), editor.handlers);

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === surface()) {
      editor.readSelection();
      updateToolbar();
      maybeComplete();
    }
  });

  el('note-title').oninput = (event) => {
    note.setTitle(event.target.value);
    autoSave({ typed: true });
    refresh();
  };
  el('note-title').onblur = () => { syncFileName(); };

  el('note-tags').onchange = (event) => {
    note.setTags(parseTagInput(event.target.value));
    drawHeader();
    autoSave();
  };

  el('btn-new-note').onclick = () => newNote();
  el('btn-new-notebook').onclick = () => newFolder(null);
  el('btn-quick').onclick = () => quickNote();
  el('btn-settings').onclick = () => openSettings();

  el('btn-bold').onclick = () => editor.handlers.toggleMark('bold');
  el('btn-italic').onclick = () => editor.handlers.toggleMark('italic');
  el('btn-underline').onclick = () => editor.handlers.toggleMark('underline');
  el('btn-strike').onclick = () => editor.handlers.toggleMark('strike');
  el('btn-todo').onclick = () => insertBlock(makeTodo());
  el('btn-callout').onclick = () => insertBlock(makeCallout('note'));
  el('btn-code').onclick = () => insertBlock(makeBlock('code'));

  el('style-picker').onchange = (event) => {
    const kind = event.target.value;
    if (!kind) return;
    editor.edit(() => {
      note.setBlockKind(editor.selection.anchor.blockId,
        kind.startsWith('h') ? 'heading' : kind,
        kind.startsWith('h') ? { level: Number(kind.slice(1)) } : {});
      return editor.selection;
    });
    event.target.value = '';
    refresh();
  };

  el('search').oninput = () => runSearch();
  el('search-mode').onchange = (event) => { searchMode = event.target.value; runSearch(); };

  el('tree').addEventListener('click', onTreeClick);
  el('results').addEventListener('click', onResultClick);
  el('backlink-list').addEventListener('click', onResultClick);
  el('completions').addEventListener('mousedown', onCompletionClick);
  surface().addEventListener('click', onSurfaceClick);

  document.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', () => { saveNow(); });
  window.addEventListener('blur', () => { saveNow(); });
}

function insertBlock(block) {
  editor.handlers.insertBlock(block);
  refresh();
}

function onTreeClick(event) {
  const row = event.target.closest('.tree-row');
  if (!row) return;

  if (row.dataset.kind === 'note') {
    if (event.detail === 2) return;
    openNote(row.dataset.path);
    return;
  }

  // A folder: the twisty collapses it, the name adds a note inside it.
  if (event.target.closest('.twisty')) {
    const path = row.dataset.path;
    const set = new Set(settings.collapsed);
    if (set.has(path)) set.delete(path); else set.add(path);
    settings.collapsed = [...set];
    settingsStore.save(settings);
    drawTree();
    return;
  }

  showFolderMenu(row.dataset.path, row.dataset.kind);
}

/** What to do with a notebook or a section. */
async function showFolderMenu(path, kind) {
  const confirmed = await showPanel(tree.baseName(path), `
    <p class="hint">${kind === 'notebook' ? 'Notebook' : 'Section'}</p>
    <label>Do what<select data-field="action">
      <option value="note">Add a note here</option>
      ${kind === 'notebook' ? '<option value="section">Add a section</option>' : ''}
      <option value="rename">Rename it</option>
      <option value="delete">Delete it — only if it is empty</option>
    </select></label>
    <label>New name<input data-field="name" value="${escapeHtml(tree.baseName(path))}"></label>
  `, 'Go');
  if (!confirmed) return;

  const fields = readFields();

  if (fields.action === 'note') { await newNote({ folder: path }); return; }
  if (fields.action === 'section') { await newFolder(path); return; }
  if (fields.action === 'delete') { await deleteFolder(path); return; }

  const wanted = tree.folderName(fields.name);
  if (!wanted || wanted === tree.baseName(path)) return;

  try {
    await io.renameEntry(path, tree.join(tree.parentOf(path), wanted));
  } catch (error) {
    await io.notify(`Cannot rename it.\n\n${error}`, 'Failed');
    return;
  }

  // Every note under it just moved, so the index now points at paths that no
  // longer exist.
  await loadArchive();
  await reindex();
  if (notePath && notePath.startsWith(path)) {
    const again = tree.allNotes(archive)[0];
    notePath = null;
    if (again) await openNote(again.path);
  }
  refresh();
}

function onResultClick(event) {
  const row = event.target.closest('[data-path]');
  if (!row) return;
  openNote(row.dataset.path);
}

function onCompletionClick(event) {
  // mousedown, not click: a click would first blur the editor and lose the
  // selection this needs.
  const row = event.target.closest('.completion');
  if (!row) return;
  event.preventDefault();
  acceptCompletion(row.dataset.title, Number(row.dataset.from));
}

function onSurfaceClick(event) {
  const box = event.target.closest('[data-action="toggle-todo"]');
  if (box) {
    editor.toggleTodo(box.dataset.block);
    return;
  }

  const link = event.target.closest('[data-action="open-link"]');
  if (link) {
    const target = links.resolve(link.dataset.title, titleIndex);
    if (target) openNote(target);
    else newNote({ title: link.dataset.title });
  }
}

function onKey(event) {
  if (isDialogOpen() || isPaletteOpen()) return;
  const control = event.ctrlKey || event.metaKey;
  if (!control) return;

  if (event.key === 'k') { event.preventDefault(); openPalette(commands()); return; }
  if (event.key === 'f') { event.preventDefault(); el('search').focus(); return; }
  if (event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault(); quickNote(); return;
  }
  if (event.key === 'n') { event.preventDefault(); newNote(); }
}

function commands() {
  const entry = (label, hint, run) => ({ id: label, label, hint, run });
  return [
    entry('New note', 'Ctrl+N', () => newNote()),
    entry('Quick note', 'Ctrl+Shift+N', () => quickNote()),
    entry('New notebook', '', () => newFolder(null)),
    entry('Search', 'Ctrl+F', () => el('search').focus()),
    entry('Delete this note', '', () => notePath && deleteNote(notePath)),
    entry('Export this note as Markdown', '', () => exportNote()),
    entry('Export the whole archive as Markdown', '', () => exportArchive()),
    entry('Rebuild the search index', '', async () => {
      await io.indexForget();
      await reindex();
      refresh();
    }),
    entry('Insert a to-do', '', () => insertBlock(makeTodo())),
    entry('Insert a callout', '', () => insertBlock(makeCallout('note'))),
    entry('Insert a code block', '', () => insertBlock(makeBlock('code'))),
    entry('Insert a link to a document', '', async () => {
      const path = await io.pickToOpen('Choose a document');
      if (path) insertBlock(makeEmbed(path));
    }),
    entry('Bold', 'Ctrl+B', () => editor.handlers.toggleMark('bold')),
    entry('Italic', 'Ctrl+I', () => editor.handlers.toggleMark('italic')),
    entry('Undo', 'Ctrl+Z', () => editor.step(-1)),
    entry('Redo', 'Ctrl+Y', () => editor.step(1)),
    entry('Settings', '', () => openSettings()),
  ];
}

start();

export { note, catalogue };
