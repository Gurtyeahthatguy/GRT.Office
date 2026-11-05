/** Wiring. */

import { makeBlock, runsText } from './core/editor/model.js';
import { InputCapture } from './core/editor/input.js';
import { EditorController } from './core/editor/controller.js';
import { showPanel, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme } from './core/theme.js';
import { SaveBeforeClose } from './core/closing.js';

import {
  NoteDocument, makeTodo, makeCallout, makeEmbed, parseTagInput, toParts, fromMarkdown, toMarkdown,
} from './note.js';

/** Markdown as the blocks of a note, without ids that would clash with the note they go into. */
const fromMarkdownBlocks = (markdown) => fromMarkdown(markdown, '').blocks.map(({ id, md, ...block }) => block);
const toMarkdownText = (document) => toMarkdown(document);
import { NotesRenderer } from './render-notes.js';
import * as tree from './tree.js';
import * as links from './links.js';
import * as search from './search.js';
import { noteToMarkdown, archiveToMarkdown, noteToDocument } from './export.js';
import { writePackage } from './core/package.js';
import { passwordFields, wirePasswordFields, passwordFrom, withPassword, PROTECTION } from './core/protection.js';
import { writeOdt } from './core/formats/odt-write.js';
import { writeDocx } from './core/formats/docx-write.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { printablePages } from './printing.js';
import * as io from './io.js';
import * as locks from './locks.js';
import * as settingsStore from './settings.js';
import { insertFormula, editFormula } from './formulas.js';
import { embedLoader, formatDate, fillTemplate, uniqueName, vaultSettings } from './extras.js';
import { parseYaml, runBase, noteFacts, cellText } from './bases.js';
import { whenMathReady } from './core/math.js';

const el = (id) => document.getElementById(id);
const surface = () => el('surface');

let settings = { ...settingsStore.DEFAULTS };
let runtime = { ephemeral: false, version: '0.0.0', defaultRoot: null };

let archive = { root: null, notebooks: [] };
let note = new NoteDocument();
let notePath = null;
/** The password of the protected notebook the open note lies in, or null. */
let notePassword = null;
const keys = new locks.Keys();

/** Everything between a keystroke and the model. */
let editor = null;

/**
 * Titles and links for every note, so `[[…]]` can resolve without reading.
 */
let catalogue = [];
let titleIndex = links.buildTitleIndex([]);

let renderer = null;
let saveState = 'idle';

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3400);
}

/** Why the last save failed, for the question asked when closing. */
let saveProblem = null;

/** Closing waits for the note being typed to reach its file. */
const closing = new SaveBeforeClose({
  pending: () => !runtime.ephemeral && !!notePath && note.dirty,
  flush: async () => {
    clearTimeout(typingSaveTimer);
    if (await saveNow()) return true;
    throw new Error(saveProblem ?? 'the note was not written');
  },
  toast,
});

// Startup

async function start() {
  runtime = await io.runtimeInfo();
  settings = await settingsStore.load();

  el('version').textContent = runtime.version;
  el('ephemeral').classList.toggle('hidden', !runtime.ephemeral);

  embeds = embedLoader({
    resolve: (title) => links.resolve(title, titleIndex),
    read: async (path) => {
      // A note in a protected notebook shows only while its notebook is open.
      if (locks.isProtected(archive, path) && !keys.get(archive, path)) return null;
      return io.readNote(path, keys.get(archive, path) ?? null);
    },
    redraw: () => editor?.draw(),
  });
  renderer = new NotesRenderer(surface(), {
    resolveLink: (title) => links.resolve(title, titleIndex),
    embedContent: (target) => embeds.content(target),
  });
  editor = new EditorController(surface(), renderer, { onChange: refreshAfterEdit, lineBreaks: true });

  await loadArchive();
  await reindex();

  await openFirst();

  wire();
  await closing.start();
  refresh();
}

/** Whether the notes are an Obsidian vault rather than the GRT archive. */
const inVault = () => Boolean(archive.vault);

async function loadArchive() {
  if (settings.vault) {
    try {
      archive = await io.readVault(settings.vault);
      return;
    } catch (error) {
      await io.notify(`Cannot open the vault.\n\n${error}`, 'Vault');
      settings.vault = null;
      settingsStore.save(settings);
    }
  }
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
    skip: (page) => locks.isProtected(archive, page.path),
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

  const written = note;
  const parts = JSON.stringify(toParts(written));
  showSaveState('saving');
  try {
    await io.writeNote(notePath, written, notePassword);
    if (JSON.stringify(toParts(written)) === parts) written.dirty = false;
    showSaveState('saved');
    await indexCurrent();
    return true;
  } catch (error) {
    saveProblem = String(error?.message ?? error);
    showSaveState('failed');
    console.warn(`Cannot save: ${error}`);
    return false;
  } finally {
    closing.update();
  }
}

/** Text edits are collected briefly; everything else writes immediately. */
function autoSave({ typed = false } = {}) {
  if (runtime.ephemeral) { showSaveState('unsaved'); return; }
  closing.update();
  clearTimeout(typingSaveTimer);
  if (typed) typingSaveTimer = setTimeout(() => { saveNow(); }, 600);
  else saveNow();
}

async function indexCurrent() {
  if (!notePath || runtime.ephemeral) return;
  try {
    if (!locks.isProtected(archive, notePath)) {
      await io.indexUpsert({
        path: notePath,
        title: note.title,
        tags: note.tags.join(' '),
        body: note.plainText(),
        modified: Math.floor(Date.now() / 1000),
      });
    }
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
  el('btn-vault').textContent = inVault() ? 'Close vault' : 'Open vault';
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
    node.classList.toggle('current', row.kind === 'note' && (row.path === notePath || row.path === basePath));
    if (row.base) node.classList.add('base');

    if (row.kind !== 'note') {
      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = row.collapsed ? '▸' : '▾';
      node.append(twisty);
    }

    const label = document.createElement('span');
    label.className = 'tree-name';
    label.textContent = row.base ? `▦ ${row.file}` : row.kind === 'note' ? (titleFor(row) || row.name) : row.name;
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

// Views over the notes

let basePath = null;
let baseView = 0;
const facts = new Map();

/** What every note of the vault is to a view, read again only when the file changed. */
async function vaultFacts() {
  const out = [];
  for (const page of tree.allNotes(archive)) {
    if (locks.isProtected(archive, page.path)) continue;
    const cached = facts.get(page.path);
    if (cached && cached.modified === page.modified) {
      out.push(cached.facts);
      continue;
    }
    try {
      const text = await io.readText(page.path);
      const made = noteFacts(page.path, archive.root, text, { modified: page.modified });
      facts.set(page.path, { modified: page.modified, facts: made });
      out.push(made);
    } catch {
      // A note that cannot be read is left out of every view.
    }
  }
  return out;
}

/** Shows a view in place of the editor: its tabs, then a table or cards of the notes it picks. */
async function openBase(path, view = 0) {
  await saveNow();
  let base;
  try {
    base = parseYaml(await io.readText(path));
  } catch (error) {
    await io.notify(`Cannot read that view.\n\n${error.message ?? error}`, 'View');
    return;
  }
  basePath = path;
  baseView = view;
  const result = runBase(base, await vaultFacts(), view);
  const panel = el('base-view');
  const tabs = result.views.map((v, i) => `<button class="base-tab${i === result.view.index ? ' current' : ''}" data-view="${i}">${escapeHtml(v.name)}</button>`).join('');
  const cell = (value) => escapeHtml(cellText(value));
  const body = result.error ? `<p class="hint">${escapeHtml(result.error)}</p>` : result.groups.map((group) => {
    const title = group.key !== null ? `<h3 class="base-group">${escapeHtml(group.key)}</h3>` : '';
    if (result.view.type === 'cards') {
      return `${title}<div class="base-cards">${group.rows.map((row) => `<button class="base-card" data-path="${escapeHtml(row.file.path)}">
        <strong>${escapeHtml(row.file.basename)}</strong>
        ${result.columns.filter((c) => c.key !== 'file.name').map((c) => `<span><em>${escapeHtml(c.label)}</em> ${cell(row.values[c.key])}</span>`).join('')}</button>`).join('')}</div>`;
    }
    return `${title}<table class="base-table"><thead><tr>${result.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${group.rows.map((row) => `<tr data-path="${escapeHtml(row.file.path)}">${result.columns.map((c) => `<td>${cell(row.values[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }).join('');
  const count = result.groups.reduce((n, g) => n + g.rows.length, 0);
  panel.innerHTML = `<div class="base-head"><h2>${escapeHtml(tree.baseName(path).replace(/\.base$/, ''))}</h2><div class="base-tabs">${tabs}</div><span class="hint">${count} note(s)</span></div>${body}`;
  document.querySelector('.editor').classList.add('hidden');
  panel.classList.remove('hidden');
  drawTree();
}

function closeBase() {
  if (!basePath) return;
  basePath = null;
  el('base-view').classList.add('hidden');
  document.querySelector('.editor').classList.remove('hidden');
}

async function openNote(path) {
  closeBase();
  await saveNow();
  const password = await passwordFor(path);
  if (password === undefined) return;
  try {
    note = await io.readNote(path, password);
  } catch (error) {
    await io.notify(`Cannot open that note.\n\n${error}`, 'Open failed');
    return;
  }
  notePath = path;
  notePassword = password;
  editor.attach(note);
  showSaveState('idle');
  refresh();
}

/**
 * Opens the first note that needs no password. A protected notebook is opened only when asked for,
 * so the program never starts on a password question.
 */
async function openFirst({ folder = null, create = true } = {}) {
  const pages = tree.allNotes(archive);
  const first = pages.find((page) => !locks.isProtected(archive, page.path) || keys.get(archive, page.path));
  if (first) {
    await openNote(first.path);
  } else if (pages.length === 0 && create) {
    await newNote(folder ? { folder } : {});
  } else {
    note = new NoteDocument();
    notePath = null;
    notePassword = null;
    editor.attach(note);
    refresh();
  }
}

/** Where a new note should go: the folder of the note in front of you. */
function currentFolder() {
  if (notePath) return tree.parentOf(notePath);
  const notebook = archive.notebooks[0];
  return notebook?.path ?? archive.root;
}

let embeds = null;

/** The settings of the vault for daily notes and templates, or the archive's own. */
async function helperSettings() {
  if (inVault()) return vaultSettings(archive.root, io.readText);
  return { daily: { folder: 'Daily', format: 'YYYY-MM-DD', template: '' }, templates: { folder: 'Templates', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' }, unique: { folder: '', format: 'YYYYMMDDHHmm' } };
}

/** The folder of the vault or archive with a path inside it, made when missing. */
async function folderAt(relative) {
  const base = inVault() ? archive.root : archive.notebooks[0]?.path ?? archive.root;
  if (!relative) return currentFolder();
  const path = tree.join(base, relative);
  try { await io.createFolder(path); } catch { /* It is there already. */ }
  return path;
}

/** Today's note: opened when it exists, made from the daily template when it does not. */
async function dailyNote() {
  const conf = await helperSettings();
  const name = formatDate(new Date(), conf.daily.format);
  const title = name.split('/').pop();
  const existing = links.resolve(title, titleIndex);
  if (existing) {
    await openNote(existing);
    return;
  }
  const folder = await folderAt([conf.daily.folder, ...name.split('/').slice(0, -1)].filter(Boolean).join('/'));
  let markdown = null;
  if (conf.daily.template) {
    try {
      markdown = fillTemplate(await io.readText(tree.join(inVault() ? archive.root : archive.notebooks[0]?.path ?? archive.root, `${conf.daily.template}.md`)), { title, ...conf.templates });
    } catch {
      toast(`The daily template ${conf.daily.template} could not be read`, true);
    }
  }
  await newNote({ folder, title, markdown });
}

/** A template of the templates folder, its placeholders filled in, put where the cursor is. */
async function insertTemplate() {
  if (!editor) return;
  const conf = await helperSettings();
  const base = inVault() ? archive.root : archive.notebooks[0]?.path ?? archive.root;
  const folder = tree.join(base, conf.templates.folder);
  const templates = tree.allNotes(archive).filter((page) => page.path.startsWith(`${folder}/`));
  if (templates.length === 0) {
    await io.notify(`No templates yet: notes in the folder ${conf.templates.folder} are the templates.`, 'Templates');
    return;
  }
  editor.readSelection();
  const at = editor.selection;
  const confirmed = await showPanel('Insert template', `
    <label>Template<select data-field="path">${templates.map((t) => `<option value="${escapeHtml(t.path)}">${escapeHtml(t.title ?? tree.baseName(t.path))}</option>`).join('')}</select></label>
    <p class="hint">{{title}}, {{date}} and {{time}} are filled in as it goes in.</p>`, 'Insert');
  if (!confirmed) return;
  const { path } = readFields();
  const text = path.endsWith('.md') ? await io.readText(path) : null;
  const source = text ?? (await io.readNote(path, keys.get(archive, path) ?? null).then((n) => toMarkdownText(n)));
  const filled = fillTemplate(source, { title: note?.title ?? '', ...conf.templates });
  const blocks = fromMarkdownBlocks(filled);
  editor.selection = at;
  editor.handlers.insertBlocks(blocks);
}

async function newNote({ folder = null, title = '', body = null, markdown = null } = {}) {
  const target = folder ?? currentFolder();
  if (!target) return;

  await saveNow();
  const password = await passwordFor(target);
  if (password === undefined) return;

  const siblings = tree.allNotes(archive)
    .filter((page) => tree.parentOf(page.path) === target)
    .map((page) => page.file);

  const fresh = new NoteDocument();
  fresh.setTitle(title);
  if (body) {
    fresh.blocks = [makeBlock('paragraph')];
    fresh.setRuns(fresh.blocks[0].id, [{ text: body }]);
  }
  if (markdown) fresh.blocks = fromMarkdownBlocks(markdown);
  fresh.dirty = true;

  let path;
  if (inVault()) path = tree.join(target, tree.vaultFileName(title, siblings));
  else if (password) path = tree.join(target, locks.lockedFileName(tree.nextOrder(siblings)));
  else path = tree.join(target, tree.noteFileName(tree.nextOrder(siblings), title || 'note'));
  if (inVault()) fresh.setTitle(tree.baseName(path).replace(/\.md$/i, ''));

  note = fresh;
  notePath = path;
  notePassword = password;
  editor.attach(note);

  await saveNow();
  await loadArchive();
  await rebuildCatalogue(tree.allNotes(archive));

  refresh();
  el('note-title').focus();
}

/** Renames the file to match the title. */
async function syncFileName() {
  // In a protected notebook a file name never carries the title.
  if (!notePath || runtime.ephemeral || locks.isProtected(archive, notePath)) return;

  const folder = tree.parentOf(notePath);
  let wanted;
  if (inVault()) {
    const others = tree.allNotes(archive)
      .filter((page) => tree.parentOf(page.path) === folder && page.path !== notePath)
      .map((page) => page.file);
    wanted = tree.join(folder, tree.vaultFileName(note.title, others));
  } else {
    const { order } = tree.parseNoteFile(tree.baseName(notePath).replace(/\.grt$/, ''));
    wanted = tree.join(folder, tree.noteFileName(
      Number.isFinite(order) && order < Number.MAX_SAFE_INTEGER ? order : 1,
      note.title || 'note',
    ));
  }

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
    await openFirst();
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
  list.firstChild.classList.add('active');
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
  let format = 'md';
  let problem = '';
  let password;
  for (;;) {
    const answer = showPanel('Export this note', `
      <label>As<select data-field="format">
        <option value="md"${format === 'md' ? ' selected' : ''}>Markdown (.md)</option>
        <option value="odt"${format === 'odt' ? ' selected' : ''}>OpenDocument text (.odt)</option>
        <option value="docx"${format === 'docx' ? ' selected' : ''}>Word document (.docx)</option>
      </select></label>
      ${passwordFields(null, problem)}
      <p class="hint">OpenDocument and Word files open in GRT Paper, LibreOffice and Word.
      Markdown cannot carry a password.</p>
    `, 'Choose file');
    wirePasswordFields();
    if (!await answer) return;
    const fields = readFields();
    ({ format } = fields);
    const protection = passwordFrom(fields, format);
    if (!protection.error) {
      ({ password } = protection);
      break;
    }
    problem = protection.error;
  }
  const filters = { md: io.FILTERS.md, odt: [{ name: 'OpenDocument text', extensions: ['odt'] }], docx: [{ name: 'Word document', extensions: ['docx'] }] };
  const chosen = await io.pickToSave(`${tree.slugify(note.title || 'note')}.${format}`, filters[format]);
  if (!chosen) return;
  const path = /\.[^./\\]+$/.test(chosen) ? chosen.replace(/\.[^./\\]+$/, `.${format}`) : `${chosen}.${format}`;
  let lost;
  if (format === 'md') {
    const result = noteToMarkdown(note);
    await io.writeText(path, result.text);
    lost = result.lost;
  } else {
    const { document, lost: dropped } = noteToDocument(note);
    const { entries, losses } = format === 'odt' ? writeOdt(document, new Map()) : writeDocx(document, new Map());
    await writePackage(path, entries, { protection: PROTECTION[format], password });
    lost = [...dropped, ...losses.lines()];
  }
  if (lost.length > 0) await io.notify(`Saved.\n\nIt cannot carry: ${lost.join(', ')}.`, 'Exported');
  else toast(`Exported ${tree.baseName(path)}`);
}

// Printing

let printSetup = { size: 'A4', orientation: 'portrait', margin: 20 };

async function printNote() {
  await saveNow();
  printSetup = await printPreview({
    title: 'Print',
    setup: printSetup,
    controls: (s) => pageControls(s, { margins: true }),
    build: (s) => printablePages(note, renderer, s),
  });
}

// An Obsidian vault

async function openVault() {
  const folder = await io.pickDirectory('Choose an Obsidian vault');
  if (!folder) return;
  let checked;
  try {
    checked = await io.checkVault(folder);
  } catch (error) {
    await io.notify(String(error), 'That folder cannot be opened');
    return;
  }
  await saveNow();
  settings.vault = checked;
  settingsStore.save(settings);
  notePath = null;
  await loadArchive();
  await reindex();
  await openFirst({ folder: archive.root });
  refresh();
  toast(`Opened the vault ${tree.baseName(checked)}`);
}

async function closeVault() {
  await saveNow();
  settings.vault = null;
  settingsStore.save(settings);
  notePath = null;
  await loadArchive();
  await reindex();
  await openFirst();
  refresh();
}

const PROPERTY_TYPES = [['text', 'Text'], ['number', 'Number'], ['checkbox', 'Checkbox'], ['date', 'Date'], ['datetime', 'Date and time'], ['list', 'List']];

/** The note's properties, typed as Obsidian types them. */
async function editProperties() {
  const editable = note.properties.filter((p) => p.type !== 'raw');
  const kept = note.properties.filter((p) => p.type === 'raw');
  const valueField = (p, i) => {
    if (p.type === 'checkbox') return `<input type="checkbox" data-field="value_${i}"${p.value ? ' checked' : ''}>`;
    if (p.type === 'list') return `<input data-field="value_${i}" value="${escapeHtml((p.value ?? []).join(', '))}" placeholder="one, two">`;
    const type = { number: 'number', date: 'date', datetime: 'datetime-local' }[p.type] ?? 'text';
    return `<input type="${type}" data-field="value_${i}" value="${escapeHtml(p.value ?? '')}">`;
  };
  const rows = [...editable, { key: '', type: 'text', value: '' }].map((p, i) => `
    <tr>
      <td><input data-field="key_${i}" value="${escapeHtml(p.key ?? '')}" placeholder="${i === editable.length ? 'new property' : ''}"></td>
      <td><select data-field="type_${i}">${PROPERTY_TYPES.map(([id, label]) => `<option value="${id}"${p.type === id ? ' selected' : ''}>${label}</option>`).join('')}</select></td>
      <td>${valueField(p, i)}</td>
    </tr>`).join('');
  const confirmed = await showPanel('Properties', `
    <table class="properties-table"><tr><th>Name</th><th>Type</th><th>Value</th></tr>${rows}</table>
    <p class="hint">An empty name removes the property.${kept.length > 0 ? ` ${kept.length} part(s) of the properties GRT does not edit are kept as they are.` : ''}</p>
  `, 'Apply');
  if (!confirmed) return;
  const fields = readFields();
  const next = [];
  for (let i = 0; i <= editable.length; i += 1) {
    const key = String(fields[`key_${i}`] ?? '').trim();
    if (!key) continue;
    const type = fields[`type_${i}`] ?? 'text';
    const before = editable[i];
    let value = fields[`value_${i}`];
    if (type === 'checkbox') value = Boolean(value);
    else if (type === 'number') value = value === '' || value === null ? null : Number(value);
    else if (type === 'list') value = String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    else value = value === '' ? null : String(value);
    // A value left as it was keeps the type and form it came with.
    if (before && before.key === key && before.type === type && JSON.stringify(before.value) === JSON.stringify(value)) next.push(before);
    else next.push({ key, type, value });
  }
  note.setProperties([...next, ...kept]);
  const tags = next.find((p) => p.key === 'tags');
  if (tags) note.tags = parseTagInput((tags.value ?? []).join(' '));
  drawHeader();
  autoSave();
}

async function exportArchive() {
  const target = await io.pickDirectory('Choose where to put the Markdown');
  if (!target) return;

  const pages = tree.allNotes(archive);
  const entries = [];
  for (const page of pages) {
    try {
      entries.push({
        note: await io.readNote(page.path, keys.get(archive, page.path)),
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

// Protected notebooks

/** The password of the notebook a path lies in, asked once while the program runs; undefined when refused. */
async function passwordFor(path) {
  const notebook = locks.notebookOf(archive, path);
  if (!notebook?.protected) return null;
  const known = keys.get(archive, path);
  if (known) return known;
  const marker = tree.join(notebook.path, locks.MARKER);
  const opened = await withPassword(notebook.name, (password) => io.readMarker(marker, password));
  if (!opened) return undefined;
  keys.set(notebook.path, opened.password);
  await catalogueNotebook(notebook, opened.password);
  return opened.password;
}

/** Titles and links of an opened protected notebook, kept in memory only. */
async function catalogueNotebook(notebook, password) {
  for (const page of tree.allNotes(archive).filter((each) => locks.notebookOf(archive, each.path) === notebook)) {
    try {
      const read = await io.readNote(page.path, password);
      const row = { path: page.path, title: read.title || search.fallbackTitle(page), links: links.linksInNote(read) };
      catalogue = catalogue.filter((item) => item.path !== page.path).concat(row);
    } catch { /** a note that will not open stays nameless. */ }
  }
  titleIndex = links.buildTitleIndex(catalogue);
  drawTree();
}

/** Asks for a new password twice; null when the person cancels. */
async function askNewPassword(title, hint) {
  let problem = '';
  for (;;) {
    const confirmed = await showPanel(title, `
      ${problem ? `<p class="hint"><strong>${escapeHtml(problem)}</strong></p>` : ''}
      <label>Password <input type="password" data-field="password" autocomplete="new-password" /></label>
      <label>Repeat it <input type="password" data-field="passwordAgain" autocomplete="new-password" /></label>
      <p class="hint">${hint}</p>`, 'Protect');
    if (!confirmed) return null;
    const chosen = passwordFrom({ ...readFields(), protect: true });
    if (!chosen.error) return chosen.password;
    problem = chosen.error;
  }
}

/** Seals every note of the notebook in front of you with a password. */
async function protectNotebook() {
  if (inVault()) {
    await io.notify('A vault is Markdown that Obsidian reads as it is, so its notes cannot carry a password.', 'Protect notebook');
    return;
  }
  const notebook = locks.notebookOf(archive, notePath ?? currentFolder());
  if (!notebook) return;
  if (notebook.protected) {
    toast(`${notebook.name} is protected already`);
    return;
  }
  const password = await askNewPassword(`Protect “${notebook.name}”`,
    'Every note in it is sealed with this password, and its titles leave the file names and the search index. '
    + 'The names of the notebook and of its sections stay visible. Without the password nobody can open it, '
    + 'and there is no way to recover it. Copies written in the clear before may stay on the disk until it reuses that space.');
  if (!password) return;
  await saveNow();

  // The marker goes first: a notebook left half sealed by a crash still asks for its password.
  await io.writeMarker(tree.join(notebook.path, locks.MARKER), locks.MARKER_PARTS, password);
  const pages = tree.allNotes(archive).filter((page) => locks.notebookOf(archive, page.path) === notebook);
  let current = notePath;
  for (const page of pages) {
    const read = await io.readNote(page.path);
    await io.writeNote(page.path, read, password);
    await io.indexRemove(page.path).catch(() => {});
    const folder = tree.parentOf(page.path);
    const { order } = tree.parseNoteFile(tree.baseName(page.path).replace(/\.grt$/, ''));
    const taken = tree.allNotes(archive).filter((each) => tree.parentOf(each.path) === folder).map((each) => each.file);
    const wanted = tree.join(folder, locks.lockedFileName(Number.isFinite(order) && order < Number.MAX_SAFE_INTEGER ? order : tree.nextOrder(taken)));
    if (wanted !== page.path) {
      try {
        await io.renameEntry(page.path, wanted);
        if (current === page.path) current = wanted;
      } catch { /** the old name stays when the new one is taken. */ }
    }
  }
  keys.set(notebook.path, password);
  await loadArchive();
  await reindex();
  await io.indexPurge().catch((error) => console.warn(`Cannot compact the index: ${error}`));
  await catalogueNotebook(locks.notebookOf(archive, notebook.path), password);
  if (current && current !== notePath) {
    notePath = current;
  }
  if (notePath && locks.isProtected(archive, notePath)) notePassword = password;
  refresh();
  toast(`${notebook.name} is protected: ${pages.length} note(s) sealed`);
}

/** Takes the password off the notebook in front of you. */
async function unprotectNotebook() {
  const notebook = locks.notebookOf(archive, notePath ?? currentFolder());
  if (!notebook?.protected) return;
  const password = await passwordFor(notebook.path);
  if (!password) return;
  const sure = await io.confirm(`Take the password off “${notebook.name}”?\n\nIts notes are written in the clear and searched again.`, 'Remove protection');
  if (!sure) return;
  await saveNow();
  const pages = tree.allNotes(archive).filter((page) => locks.notebookOf(archive, page.path) === notebook);
  for (const page of pages) {
    const read = await io.readNote(page.path, password);
    await io.writeNote(page.path, read, null);
  }
  await io.deleteEntry(tree.join(notebook.path, locks.MARKER));
  keys.drop(notebook.path);
  if (notePath && locks.notebookOf(archive, notePath) === notebook) notePassword = null;
  await loadArchive();
  await reindex();
  refresh();
  toast(`${notebook.name} is no longer protected`);
}

/** Forgets every password given, and closes a protected note that is open. */
async function lockNotebooks() {
  await saveNow();
  keys.forget();
  if (notePath && locks.isProtected(archive, notePath)) {
    note = new NoteDocument();
    notePath = null;
    notePassword = null;
    editor.attach(note);
  }
  await rebuildCatalogue(tree.allNotes(archive));
  refresh();
  toast('Protected notebooks locked');
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
    <p class="hint">${inVault() ? 'The Obsidian vault open is' : 'The archive is'}<br><code>${escapeHtml(archive.root ?? 'nowhere yet')}</code></p>
    <p class="hint">A vault opens from Documents or Downloads, file by file as Obsidian keeps it; a note
    saved without changes stays the same file.</p>
    <p class="hint"><strong>The search index holds the text of every note.</strong>
    It lives in this program's own data folder, never in a temporary directory,
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
  el('btn-properties').onclick = () => editProperties();
  el('btn-print').onclick = () => printNote();
  el('btn-vault').onclick = () => (inVault() ? closeVault() : openVault());

  el('btn-bold').onclick = () => editor.handlers.toggleMark('bold');
  el('btn-italic').onclick = () => editor.handlers.toggleMark('italic');
  el('btn-underline').onclick = () => editor.handlers.toggleMark('underline');
  el('btn-strike').onclick = () => editor.handlers.toggleMark('strike');
  // Toolbar buttons leave the caret in the text.
  document.querySelector('.toolbar').addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });
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
  document.addEventListener('keydown', onCompletionKey, true);
  surface().addEventListener('click', onSurfaceClick);
  el('base-view').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-view]');
    if (tab) {
      openBase(basePath, Number(tab.dataset.view));
      return;
    }
    const row = event.target.closest('[data-path]');
    if (row) openNote(row.dataset.path);
  });
  // Formulas shown as their TeX before the engine loaded are drawn again once it has.
  whenMathReady(() => editor?.draw());

  document.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', () => { saveNow(); });
  window.addEventListener('blur', () => { saveNow(); });
}

/** Inserts a block; one that holds text takes the caret. */
function insertBlock(block, { enter = true } = {}) {
  editor.handlers.insertBlock(block, { enter });
  refresh();
}

function onTreeClick(event) {
  const row = event.target.closest('.tree-row');
  if (!row) return;

  if (row.dataset.kind === 'note') {
    if (event.detail === 2) return;
    if (row.dataset.path.endsWith('.base')) openBase(row.dataset.path);
    else openNote(row.dataset.path);
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
      <option value="delete">Delete it, only if it is empty</option>
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
    notePath = null;
    await openFirst({ create: false });
  }
  refresh();
}

function onResultClick(event) {
  const row = event.target.closest('[data-path]');
  if (!row) return;
  openNote(row.dataset.path);
}

/** The open list of link completions answers the arrows, Enter, Tab and Escape before the text does. */
function onCompletionKey(event) {
  const box = el('completions');
  if (box.classList.contains('hidden') || !surface().contains(event.target)) return;
  const rows = [...box.querySelectorAll('.completion')];
  if (rows.length === 0) return;
  const at = Math.max(0, rows.findIndex((row) => row.classList.contains('active')));

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((row, index) => row.classList.toggle('active', index === next));
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    acceptCompletion(rows[at].dataset.title, Number(rows[at].dataset.from));
  } else if (event.key === 'Escape') {
    box.classList.add('hidden');
  } else {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
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
  const formula = event.target.closest('[data-math]');
  if (formula && editor) {
    event.preventDefault();
    editFormula(editor, formula);
    return;
  }
  const box = event.target.closest('[data-action="toggle-todo"]');
  if (box) {
    editor.toggleTodo(box.dataset.block);
    return;
  }

  const embed = event.target.closest('[data-action="open-embed"]');
  const embedded = embed ? note?.block(embed.dataset.block) : null;
  if (embedded?.wiki) {
    const target = links.resolve(String(embedded.target).split('#')[0].trim(), titleIndex);
    if (target) openNote(target);
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
  if (isDialogOpen() || isPaletteOpen() || isPrintPreviewOpen()) return;
  const control = event.ctrlKey || event.metaKey;
  if (!control) return;

  if (event.key === 'k') { event.preventDefault(); openPalette(commands()); return; }
  if (event.key === 'f') { event.preventDefault(); el('search').focus(); return; }
  if (event.key === 'p') { event.preventDefault(); printNote(); return; }
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
    entry('Export this note…', '', () => exportNote()),
    entry('Print this note…', 'Ctrl+P', () => printNote()),
    entry('Properties of this note…', '', () => editProperties()),
    inVault()
      ? entry('Close the vault and go back to the GRT archive', '', () => closeVault())
      : entry('Open an Obsidian vault…', '', () => openVault()),
    entry('Export the whole archive as Markdown', '', () => exportArchive()),
    entry('Protect this notebook with a password…', '', () => protectNotebook()),
    entry('Remove the password from this notebook…', '', () => unprotectNotebook()),
    entry('Lock protected notebooks', '', () => lockNotebooks()),
    entry('Rebuild the search index', '', async () => {
      await io.indexForget();
      await reindex();
      refresh();
    }),
    entry('Insert a to-do', '', () => insertBlock(makeTodo())),
    entry('Insert a callout', '', () => insertBlock(makeCallout('note'))),
    entry('Insert a code block', '', () => insertBlock(makeBlock('code'))),
    { ...entry("Today's note", 'Ctrl+Shift+D', () => dailyNote()), aliases: ['Daily note', 'Open today’s daily note'] },
    { ...entry('New note with a unique name', '', async () => {
      const conf = await helperSettings();
      await newNote({ folder: conf.unique.folder ? await folderAt(conf.unique.folder) : null, title: formatDate(new Date(), conf.unique.format) || uniqueName() });
    }), aliases: ['Unique note creator', 'Zettelkasten', 'Create new unique note'] },
    { ...entry('Insert template…', '', () => insertTemplate()), aliases: ['Templates', 'Insert template'] },
    { ...entry('Insert a table', '', () => insertBlock(makeBlock('table', { rows: 3, cols: 3, header: true }))), aliases: ['Table', 'Insert Table'] },
    { ...entry('Insert a formula…', '', () => editor && insertFormula(editor)), aliases: ['Formula', 'Equation', 'Math', 'LaTeX'] },
    entry('Insert a link to a document', '', async () => {
      const path = await io.pickToOpen('Choose a document');
      if (path) insertBlock(makeEmbed(path), { enter: false });
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
