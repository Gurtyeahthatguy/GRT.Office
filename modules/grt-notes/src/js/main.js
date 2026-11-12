/** Wiring. */

import * as tools from './notes-tools.js';
import { searchEverywhere } from './core/everywhere.js';
import { autocorrectOptions, applyToDocument } from './core/autocorrect-ui.js';
import { createSpellChecker } from './core/spelling.js';
import { createProofing } from './core/proofing-ui.js';
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
let titleBefore = { title: '', ours: false };
/** Spelling and grammar, with GRT's own dictionaries; made once the editor exists. */
let proofing = null;

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
  editor = new EditorController(surface(), renderer, { onChange: refreshAfterEdit, lineBreaks: true, autocorrect: () => settings.autocorrect });
  proofing = createProofing({
    editor, surface: surface(), toast,
    model: () => note,
    checker: createSpellChecker(),
    language: () => settings.spelling?.language ?? 'en-US',
    settings: () => settings.spelling ?? { auto: false, grammar: false },
  });
  // A right click on a word underlined offers what it could be.
  surface().addEventListener('contextmenu', (event) => { proofing.contextMenu(event); });

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
      // The text and tags the index has, for mentions and previews; protected notes are not in it.
      body: row?.body ?? '',
      tags: String(row?.tags ?? '').split(/\s+/).filter(Boolean),
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
  const path = notePath;
  const password = notePassword;
  const parts = JSON.stringify(toParts(written));
  showSaveState('saving');
  try {
    await io.writeNote(path, written, password);
    keepVersion(written, path, password);
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
    const body = locks.isProtected(archive, notePath) ? '' : note.plainText();
    if (row) Object.assign(row, { title: note.title, links: outgoing, body, tags: [...note.tags] });
    else catalogue.push({ path: notePath, title: note.title, links: outgoing, body, tags: [...note.tags] });
    titleIndex = links.buildTitleIndex(catalogue);
  } catch (error) {
    console.warn(`Cannot index this note: ${error}`);
  }
}

// Drawing

function refresh() {
  drawBookmarks();
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
    // A note is dragged onto a notebook or a section to move it there.
    if (row.kind === 'note' && !row.base && !runtime.ephemeral) node.draggable = true;

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

  // Notes that name this one's title without linking it, each with a button to link it.
  const mentions = notePath && note.title ? tools.unlinkedMentions(note.title, notePath, catalogue) : [];
  if (mentions.length) {
    const heading = document.createElement('h3');
    heading.className = 'mentions-heading';
    heading.textContent = 'Unlinked mentions';
    list.append(heading);
    for (const mention of mentions.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'mention';
      const open = document.createElement('button');
      open.className = 'backlink';
      open.dataset.path = mention.path;
      open.textContent = mention.title || tree.baseName(mention.path);
      const snippet = document.createElement('span');
      snippet.className = 'result-snippet';
      snippet.textContent = mention.snippet;
      const link = document.createElement('button');
      link.className = 'mention-link';
      link.dataset.linkMention = mention.path;
      link.textContent = 'Link';
      row.append(open, snippet, link);
      list.append(row);
    }
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
  proofing?.schedule();
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
  rememberTitle();
  editor.attach(note);
  showSaveState('idle');
  refresh();
}

/** Remembers the title links reach this note by, until it is renamed; links that reached another note are not ours to change. */
function rememberTitle() {
  const title = note?.title ?? '';
  titleBefore = { title, ours: !!title && links.resolve(title, titleIndex) === notePath && !links.isAmbiguous(title, titleIndex) };
}

/** Reads another note, lets `change` alter it and writes it back; false when it is locked, unchanged or unreadable. */
async function editOtherNote(path, change) {
  if (!path || path === notePath) return false;
  const password = keys.get(archive, path) ?? null;
  if (locks.isProtected(archive, path) && !password) return false;
  const other = await io.readNote(path, password);
  if (!change(other)) return false;
  await io.writeNote(path, other, password);
  const isProtected = locks.isProtected(archive, path);
  if (!isProtected) {
    await io.indexUpsert({ path, title: other.title, tags: other.tags.join(' '), body: other.plainText(), modified: Math.floor(Date.now() / 1000) });
  }
  const row = catalogue.find((item) => item.path === path);
  if (row) Object.assign(row, { title: other.title, links: links.linksInNote(other), body: isProtected ? '' : other.plainText(), tags: [...other.tags] });
  return true;
}

/** Every link to an old title made to name a new one, in every note it can open; returns how many notes changed and how many it could not open. */
async function updateLinks(oldTitle, newTitle, { skip = null, inOpenNote = false } = {}) {
  const old = oldTitle.trim().toLowerCase();
  let changed = 0;
  let closed = 0;
  for (const row of [...catalogue]) {
    if (row.path === notePath || row.path === skip) continue;
    // A note in a closed protected notebook cannot be read; it is counted and left.
    if (locks.isProtected(archive, row.path) && !keys.get(archive, row.path)) { closed += 1; continue; }
    if (!(row.links ?? []).some((l) => l.toLowerCase() === old)) continue;
    try {
      if (await editOtherNote(row.path, (other) => tools.renameLinks(other, oldTitle, newTitle) > 0)) changed += 1;
    } catch (error) {
      console.warn(`Cannot update the links in ${row.path}: ${error}`);
    }
  }
  if (inOpenNote && notePath && tools.renameLinks(note, oldTitle, newTitle) > 0) {
    editor.attach(note);
    autoSave();
  }
  titleIndex = links.buildTitleIndex(catalogue);
  return { changed, closed };
}

/** After a rename, the links that reached this note by its old title follow it. */
async function followRename(path, before, now) {
  if (!path || now.trim().toLowerCase() === before.title.trim().toLowerCase()) return;
  if (path === notePath) rememberTitle();
  if (!before.title || !before.ours || !now.trim()) return;
  // Another note that already has the new title would take the links; they are left, and it is said.
  if (catalogue.some((row) => row.path !== path && row.title.trim().toLowerCase() === now.trim().toLowerCase())) {
    toast(`Links were not changed: another note is already called "${now}"`, true);
    return;
  }
  const { changed, closed } = await updateLinks(before.title, now, { skip: path, inOpenNote: path === notePath });
  if (changed || closed) toast(`Links updated in ${changed} note(s)${closed ? `; ${closed} in locked notebooks not checked` : ''}`);
  drawBacklinks();
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

async function newNote({ folder = null, title = '', body = null, markdown = null, blocks = null } = {}) {
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
  if (blocks?.length) fresh.blocks = structuredClone(blocks);
  fresh.dirty = true;

  let path;
  if (inVault()) path = tree.join(target, tree.vaultFileName(title, siblings));
  else if (password) path = tree.join(target, locks.lockedFileName(tree.nextOrder(siblings)));
  else path = tree.join(target, tree.noteFileName(tree.nextOrder(siblings), title || 'note'));
  if (inVault()) fresh.setTitle(tree.baseName(path).replace(/\.md$/i, ''));

  note = fresh;
  notePath = path;
  notePassword = password;
  titleBefore = { title: '', ours: false };
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
    await pathChanged(notePath, wanted);
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
    await pathChanged(path, null);
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

/** Each search counts, so an older one that ends late never covers a newer one's results. */
let searchRound = 0;

async function runSearch() {
  const round = ++searchRound;
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
    // Operators narrow what the index finds by the text: tag:, path:, task:, [property:value].
    const parsed = tools.parseQuery(query);
    hits = parsed.text ? await io.indexSearch(parsed.text).catch(() => []) : catalogue.map((row) => ({ path: row.path, title: row.title, snippet: '' }));
    if (tools.hasOperators(parsed)) {
      const kept = [];
      for (const hit of hits.slice(0, 2000)) {
        const row = catalogue.find((item) => item.path === hit.path);
        // Tags and paths are known from the catalogue; tasks and properties need the note itself.
        const needsNote = parsed.tasks.length || parsed.properties.length;
        const subject = needsNote ? await io.readNote(hit.path).catch(() => null) : { tags: row?.tags ?? [] };
        if (subject && tools.meetsOperators(subject, hit.path, parsed)) kept.push(hit);
        if (kept.length >= 200) break;
      }
      hits = kept;
    }
  }
  if (round !== searchRound) return;

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
  // Versions kept in the clear would outlive the seal.
  await io.historyForget(await io.historyKey('notebook', notebook.path)).catch(() => {});
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
  // Versions sealed with the password taken off could not be read again.
  await io.historyForget(await io.historyKey('notebook', notebook.path)).catch(() => {});
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
  el('note-title').onblur = async () => {
    // Taken now, since a click elsewhere may open another note while this one saves.
    const path = notePath;
    const before = titleBefore;
    const now = note?.title ?? '';
    await saveNow();
    await followRename(path, before, now);
    await syncFileName();
  };

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
  el('bookmark-list').addEventListener('click', onResultClick);
  surface().addEventListener('mouseover', onLinkHover);
  surface().addEventListener('mouseout', (event) => {
    if (event.target.closest?.('[data-action="open-link"]') && !event.relatedTarget?.closest?.('[data-action="open-link"]')) hidePreview();
  });
  surface().addEventListener('keydown', hidePreview);
  surface().addEventListener('scroll', hidePreview, { passive: true });
  el('tree').addEventListener('dragstart', onTreeDragStart);
  el('tree').addEventListener('dragover', onTreeDragOver);
  el('tree').addEventListener('drop', onTreeDrop);
  el('tree').addEventListener('dragend', () => { for (const each of el('tree').querySelectorAll('.drop-target')) each.classList.remove('drop-target'); });
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

const NOTE_DRAG = 'application/x-grt-note';

function onTreeDragStart(event) {
  const row = event.target.closest?.('.tree-row[data-kind="note"]');
  if (!row) return;
  event.dataTransfer.setData(NOTE_DRAG, row.dataset.path);
  event.dataTransfer.effectAllowed = 'move';
}

function onTreeDragOver(event) {
  const row = event.target.closest?.('.tree-row');
  if (!row || row.dataset.kind === 'note' || !event.dataTransfer.types.includes(NOTE_DRAG)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  for (const each of el('tree').querySelectorAll('.drop-target')) if (each !== row) each.classList.remove('drop-target');
  row.classList.add('drop-target');
}

function onTreeDrop(event) {
  const row = event.target.closest?.('.tree-row');
  for (const each of el('tree').querySelectorAll('.drop-target')) each.classList.remove('drop-target');
  const path = event.dataTransfer.getData(NOTE_DRAG);
  if (!row || row.dataset.kind === 'note' || !path) return;
  event.preventDefault();
  moveNote(path, row.dataset.path);
}

/** Moves a note into another notebook or section; text never leaves a protected notebook in the clear. */
async function moveNote(path, folder) {
  if (!path || !folder || tree.parentOf(path) === folder || runtime.ephemeral) return;
  const fromNotebook = locks.notebookOf(archive, path);
  const toNotebook = locks.notebookOf(archive, folder);
  const fromProtected = !!fromNotebook?.protected;
  const toProtected = !!toNotebook?.protected;
  if (fromProtected && fromNotebook !== toNotebook) {
    await io.notify('A note in a protected notebook stays in it. To take it out, remove the notebook\'s password first.', 'Cannot move');
    return;
  }
  if (path === notePath) await saveNow();
  const siblings = tree.allNotes(archive).filter((page) => tree.parentOf(page.path) === folder).map((page) => page.file);
  const row = catalogue.find((item) => item.path === path);
  let wanted;
  try {
    if (inVault()) {
      wanted = tree.join(folder, tree.vaultFileName(tree.baseName(path).replace(/\.md$/i, ''), siblings));
      await io.renameEntry(path, wanted);
    } else if (toProtected && !fromProtected) {
      // Into a protected notebook: written sealed under a name without the title, then the clear file goes.
      const password = await passwordFor(folder);
      if (!password) return;
      const read = await io.readNote(path);
      wanted = tree.join(folder, locks.lockedFileName(tree.nextOrder(siblings)));
      await io.writeNote(wanted, read, password);
      await io.deleteEntry(path);
    } else {
      const stem = tree.baseName(path).replace(/\.grt$/, '');
      const { slug } = tree.parseNoteFile(stem);
      wanted = tree.join(folder, toProtected ? locks.lockedFileName(tree.nextOrder(siblings)) : tree.noteFileName(tree.nextOrder(siblings), row?.title || slug || 'note'));
      await io.renameEntry(path, wanted);
    }
  } catch (error) {
    await io.notify(`Cannot move that note.\n\n${error}`, 'Move failed');
    return;
  }
  await io.indexRemove(path).catch(() => {});
  await pathChanged(path, wanted);
  if (row) row.path = wanted;
  if (path === notePath) {
    notePath = wanted;
    if (toProtected) notePassword = keys.get(archive, folder) ?? notePassword;
  }
  await loadArchive();
  if (!toProtected) {
    const moved = path === notePath ? note : await io.readNote(wanted).catch(() => null);
    if (moved) await io.indexUpsert({ path: wanted, title: moved.title, tags: moved.tags.join(' '), body: moved.plainText(), modified: Math.floor(Date.now() / 1000) }).catch(() => {});
  }
  titleIndex = links.buildTitleIndex(catalogue);
  refresh();
  toast(`Moved to ${tree.baseName(folder)}`);
}

/** The keyboard way to move: the notebooks and sections, chosen from a list. */
async function moveCurrentNote() {
  if (!notePath) return;
  const folders = tree.flatten(archive).filter((row) => row.kind !== 'note' && row.path !== tree.parentOf(notePath));
  if (folders.length === 0) { toast('There is no other notebook to move it to'); return; }
  const confirmed = await showPanel('Move to', `
    <label>Notebook or section<select data-field="folder">${folders.map((f) => `<option value="${escapeHtml(f.path)}">${'  '.repeat(f.depth)}${escapeHtml(f.name)}</option>`).join('')}</select></label>`, 'Move');
  if (!confirmed) return;
  await moveNote(notePath, readFields().folder);
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
  const mention = event.target.closest('[data-link-mention]');
  if (mention) {
    linkMention(mention.dataset.linkMention);
    return;
  }
  const row = event.target.closest('[data-path]');
  if (!row) return;
  openNote(row.dataset.path);
}

// Earlier versions of a note, for notebooks that keep them (decision 11).

const historyOn = (path) => {
  const notebook = locks.notebookOf(archive, path);
  return !!notebook && !runtime.ephemeral && settings.historyNotebooks.includes(notebook.path);
};

async function historyKeys(path) {
  const notebook = locks.notebookOf(archive, path);
  return notebook ? [await io.historyKey('notebook', notebook.path), await io.historyKey('note', path)] : null;
}

async function keepVersion(written, path, password, force = false) {
  if (!path || !historyOn(path)) return false;
  try {
    return await io.historySave(await historyKeys(path), written, password, force);
  } catch (error) {
    console.warn(`Cannot keep a version: ${error}`);
    return false;
  }
}

/** A note's file moved or went: its versions and bookmark follow it, or go with it. */
async function pathChanged(from, to) {
  if (settings.bookmarks.includes(from)) {
    settings.bookmarks = to ? settings.bookmarks.map((p) => (p === from ? to : p)) : settings.bookmarks.filter((p) => p !== from);
    settingsStore.save(settings);
  }
  if (!historyOn(from) || runtime.ephemeral) return;
  try {
    await io.historyMove(await historyKeys(from), to && historyOn(to) ? await historyKeys(to) : null);
  } catch (error) {
    console.warn(`Cannot move the versions: ${error}`);
  }
}

async function toggleHistory() {
  const notebook = locks.notebookOf(archive, notePath ?? currentFolder());
  if (!notebook) { toast('Open a note in a notebook first'); return; }
  if (runtime.ephemeral) { toast('Nothing is kept in ephemeral mode'); return; }
  if (settings.historyNotebooks.includes(notebook.path)) {
    const sure = await io.confirm(`Stop keeping versions of the notes in “${notebook.name}”?\n\nThe versions kept so far are deleted.`, 'Versions');
    if (!sure) return;
    settings.historyNotebooks = settings.historyNotebooks.filter((p) => p !== notebook.path);
    await settingsStore.save(settings);
    await io.historyForget(await io.historyKey('notebook', notebook.path)).catch((error) => toast(`Cannot delete the versions: ${error}`, true));
    toast(`Versions of ${notebook.name} are no longer kept`);
    return;
  }
  settings.historyNotebooks = [...settings.historyNotebooks, notebook.path];
  await settingsStore.save(settings);
  if (notePath) await keepVersion(note, notePath, notePassword, true);
  toast(notebook.protected
    ? `Versions of ${notebook.name} are kept, sealed with its password, at most one every five minutes`
    : `Versions of ${notebook.name} are kept, at most one every five minutes`);
}

/** The versions of the note in front of you, to look at and bring back. */
async function showVersions() {
  if (!notePath) return;
  if (!historyOn(notePath)) {
    toast('This notebook keeps no versions; turn them on with "Keep versions of this notebook"');
    return;
  }
  await saveNow();
  const path = notePath;
  const keysOf = await historyKeys(path);
  const versions = await io.historyList(keysOf).catch(() => []);
  if (versions.length === 0) { toast('No versions kept yet'); return; }
  const when = (id) => new Date(Number(id)).toLocaleString();
  const chosen = await showPanel('Versions of this note', `
    <label>Version<select data-field="id">${versions.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(when(v.id))} · ${Math.max(1, Math.round(v.size / 1024))} KB</option>`).join('')}</select></label>
    <p class="hint">A version is kept at most every five minutes while you write. Bringing one back keeps the text of now as a version first.</p>`, 'Show');
  if (!chosen) return;
  const { id } = readFields();
  let version;
  try {
    version = await io.historyRead(keysOf, id, notePassword);
  } catch (error) {
    await io.notify(`Cannot read that version.\n\n${error}`, 'Versions');
    return;
  }
  const text = version.plainText();
  const restore = await showPanel(`Version of ${when(id)}`, `
    <p><strong>${escapeHtml(version.title || 'Untitled')}</strong></p>
    <div class="version-text">${escapeHtml(text.slice(0, 20000))}${text.length > 20000 ? '…' : ''}</div>`, 'Bring back');
  if (!restore || path !== notePath) return;
  await keepVersion(note, notePath, notePassword, true);
  note.title = version.title;
  note.tags = [...version.tags];
  note.properties = structuredClone(version.properties);
  note.blocks = version.blocks;
  note.dirty = true;
  editor.attach(note);
  await saveNow();
  refresh();
  toast(`Brought back the version of ${when(id)}`);
}

async function forgetAllVersions() {
  const sure = await io.confirm('Delete every version kept of every note?\n\nThe notes themselves stay as they are.', 'Versions');
  if (!sure) return;
  try {
    await io.historyForget();
    toast('Every version kept was deleted');
  } catch (error) {
    toast(`Cannot delete the versions: ${error}`, true);
  }
}

// Bookmarks.

function drawBookmarks() {
  const known = settings.bookmarks.filter((path) => catalogue.some((row) => row.path === path));
  el('bookmarks').classList.toggle('hidden', known.length === 0);
  const list = document.createElement('div');
  for (const path of known) {
    const row = document.createElement('button');
    row.className = 'backlink';
    row.dataset.path = path;
    row.textContent = catalogue.find((item) => item.path === path)?.title || tree.baseName(path);
    list.append(row);
  }
  el('bookmark-list').replaceChildren(list);
}

function toggleBookmark() {
  if (!notePath) return;
  const marked = settings.bookmarks.includes(notePath);
  settings.bookmarks = marked ? settings.bookmarks.filter((p) => p !== notePath) : [...settings.bookmarks, notePath];
  settingsStore.save(settings);
  drawBookmarks();
  toast(marked ? 'Bookmark removed' : 'Bookmarked');
}

// A link's note, shown while the pointer rests on it.

let previewTimer = null;
let previewFor = null;

function hidePreview() {
  clearTimeout(previewTimer);
  previewFor = null;
  el('link-preview').classList.add('hidden');
}

function onLinkHover(event) {
  const link = event.target.closest?.('[data-action="open-link"]');
  if (!link || link === previewFor) return;
  hidePreview();
  previewFor = link;
  previewTimer = setTimeout(() => showPreview(link), 400);
}

async function showPreview(link) {
  const title = link.dataset.title;
  const path = links.resolve(title, titleIndex);
  const row = path ? catalogue.find((item) => item.path === path) : null;
  let text = row?.body ?? '';
  // A note in an open protected notebook is read for the moment; one in a closed notebook shows nothing.
  if (path && !text && locks.isProtected(archive, path) && keys.get(archive, path)) {
    text = await io.readNote(path, keys.get(archive, path)).then((n) => n.plainText()).catch(() => '');
  }
  if (previewFor !== link) return;
  const box = el('link-preview');
  const heading = document.createElement('strong');
  heading.textContent = row?.title || title;
  const body = document.createElement('p');
  body.textContent = path
    ? (locks.isProtected(archive, path) && !keys.get(archive, path) ? 'In a locked notebook.' : (text.slice(0, 600) + (text.length > 600 ? '…' : '')) || 'Empty note.')
    : 'No note with this title yet.';
  box.replaceChildren(heading, body);
  const at = link.getBoundingClientRect();
  box.classList.remove('hidden');
  const width = box.offsetWidth;
  box.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - width - 8))}px`;
  box.style.top = at.bottom + box.offsetHeight + 12 < window.innerHeight ? `${at.bottom + 6}px` : `${Math.max(8, at.top - box.offsetHeight - 6)}px`;
}

/** Turns the first mention of this note's title in another note into a link. */
async function linkMention(path) {
  try {
    const done = await editOtherNote(path, (other) => tools.linkFirstMention(other, note.title));
    toast(done ? 'Linked' : 'That mention is no longer there');
  } catch (error) {
    toast(`Cannot link that mention: ${error}`, true);
  }
  titleIndex = links.buildTitleIndex(catalogue);
  drawBacklinks();
}

/** Puts this note at the end of another, makes links to it point there, and removes it. */
async function mergeNote() {
  if (!notePath) return;
  await saveNow();
  // Text never leaves a protected notebook for another place, nor comes in from outside it.
  const home = locks.notebookOf(archive, notePath);
  const sameShelter = (path) => locks.isProtected(archive, path)
    ? locks.isProtected(archive, notePath) && locks.notebookOf(archive, path) === home && !!keys.get(archive, path)
    : !locks.isProtected(archive, notePath);
  const others = catalogue.filter((row) => row.path !== notePath && sameShelter(row.path))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (others.length === 0) { toast('There is no other note to merge into'); return; }
  const confirmed = await showPanel('Merge into another note', `
    <label>Merge "${escapeHtml(note.title || 'this note')}" into<select data-field="path">${others.slice(0, 5000).map((row) => `<option value="${escapeHtml(row.path)}">${escapeHtml(row.title || tree.baseName(row.path))}</option>`).join('')}</select></label>
    <p class="hint">This note's text goes at the end of the other under a heading with its title, links to it are made to point there, and this note's file is deleted.</p>`, 'Merge');
  if (!confirmed) return;
  const { path: target } = readFields();
  if (!target || target === notePath) return;
  const source = note;
  const sourcePath = notePath;
  try {
    if (!(await editOtherNote(target, (other) => { tools.mergeInto(other, source); return true; }))) throw new Error('the note could not be opened');
  } catch (error) {
    await io.notify(`Cannot merge these notes.\n\n${error}`, 'Merge failed');
    return;
  }
  const targetTitle = catalogue.find((row) => row.path === target)?.title ?? '';
  if (source.title && targetTitle) await updateLinks(source.title, targetTitle, { skip: sourcePath });
  try {
    await io.deleteEntry(sourcePath);
    await io.indexRemove(sourcePath);
    await pathChanged(sourcePath, null);
  } catch (error) {
    toast(`Merged, but this note's file could not be deleted: ${error}`, true);
  }
  catalogue = catalogue.filter((row) => row.path !== sourcePath);
  titleIndex = links.buildTitleIndex(catalogue);
  note.dirty = false;
  notePath = null;
  await loadArchive();
  await openNote(target);
  toast(`Merged into ${targetTitle || tree.baseName(target)}`);
}

/** Moves everything from the paragraph with the caret on into a new note, and leaves a link to it here. */
async function splitNote() {
  if (!notePath) return;
  editor.readSelection();
  const at = note.blocks.findIndex((block) => block.id === editor.selection?.anchor?.blockId);
  if (at <= 0) { toast('Put the caret in the paragraph the new note should start with, below the first'); return; }
  const first = note.blocks[at];
  const firstText = runsText(first.runs ?? []).trim();
  const title = (first.kind === 'heading' && firstText) ? firstText.slice(0, 200) : `${note.title || 'Note'} (part 2)`;
  const moved = tools.splitAt(note, at);
  if (!moved) return;
  // The heading that named the part becomes the new note's title rather than its first line.
  const blocks = first.kind === 'heading' && firstText && moved.length > 1 ? moved.slice(1) : moved;
  const link = makeBlock('paragraph');
  link.runs = [{ text: `[[${title}]]` }];
  note.blocks.push(link);
  editor.attach(note);
  await saveNow();
  await newNote({ folder: tree.parentOf(notePath), title, blocks });
  toast(`Split into ${title}`);
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
  if (event.key === 'F7' && !event.ctrlKey && !event.altKey && !event.shiftKey) { event.preventDefault(); proofing?.spellingDialog(); return; }
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
    { ...entry(settings.autocorrect?.options.whileTyping ? 'AutoCorrect while typing: turn off' : 'AutoCorrect while typing: turn on', '', async () => {
      settings.autocorrect.options.whileTyping = !settings.autocorrect.options.whileTyping;
      await settingsStore.save(settings);
      toast(settings.autocorrect.options.whileTyping ? 'AutoCorrect while typing is on' : 'AutoCorrect while typing is off');
    }), aliases: ['AutoCorrect', 'Smart quotes'] },
    { ...entry('AutoCorrect options…', '', async () => {
      const next = await autocorrectOptions(settings.autocorrect);
      if (!next) return;
      settings.autocorrect = next;
      await settingsStore.save(settings);
    }), aliases: ['Replacement table'] },
    { ...entry('Apply AutoCorrect to this note', '', () => {
      if (!notePath) return;
      editor.readSelection();
      let result = { changed: 0 };
      editor.edit(() => {
        result = applyToDocument(note, editor.selection, settings.autocorrect);
        return editor.selection;
      });
      toast(result.changed ? `${result.changed} paragraph(s) corrected` : 'Nothing to correct');
    }), aliases: ['Apply AutoCorrect'] },
    { ...entry('Spelling…', 'F7', () => proofing?.spellingDialog()), aliases: ['Spellcheck', 'Check spelling', 'Grammar'] },
    { ...entry(settings.spelling?.auto ? 'Automatic spell checking: turn off' : 'Automatic spell checking: turn on', '', async () => {
      settings.spelling = { ...settings.spelling, auto: !settings.spelling.auto };
      await settingsStore.save(settings);
      proofing?.schedule(0);
    }), aliases: ['Spell check as you type'] },
    { ...entry(settings.spelling?.grammar ? 'Grammar checking: turn off' : 'Grammar checking: turn on', '', async () => {
      settings.spelling = { ...settings.spelling, grammar: !settings.spelling.grammar };
      await settingsStore.save(settings);
      proofing?.schedule(0);
    }), aliases: ['Check grammar'] },
    { ...entry(settings.spelling?.language === 'it-IT' ? 'Spelling language: switch to English' : 'Spelling language: switch to Italian', '', async () => {
      settings.spelling = { ...settings.spelling, language: settings.spelling.language === 'it-IT' ? 'en-US' : 'it-IT' };
      await settingsStore.save(settings);
      proofing?.schedule(0);
    }), aliases: ['Language', 'Dictionary language'] },
    { ...entry('Search Everywhere…', '', () => searchEverywhere({
      kind: 'notes',
      // A note opens here when it belongs to the archive in front of you.
      open: (path) => (catalogue.some((row) => row.path === path) ? openNote(path) : toast('That note is not in the archive open here')),
      toast,
    })), aliases: ['Search in files', 'Find in folder', 'Search all documents'] },
    entry('Delete this note', '', () => notePath && deleteNote(notePath)),
    { ...entry(settings.bookmarks.includes(notePath) ? 'Remove the bookmark of this note' : 'Bookmark this note', '', () => toggleBookmark()), aliases: ['Bookmark', 'Bookmarks'] },
    { ...entry('Versions of this note…', '', () => showVersions()), aliases: ['Version history', 'File recovery', 'History'] },
    { ...entry(settings.historyNotebooks.includes(locks.notebookOf(archive, notePath ?? '')?.path) ? 'Stop keeping versions of this notebook' : 'Keep versions of this notebook', '', () => toggleHistory()), aliases: ['Version history'] },
    entry('Delete the versions of every note…', '', () => forgetAllVersions()),
    { ...entry('Move this note to…', '', () => moveCurrentNote()), aliases: ['Move note', 'Move file to another folder'] },
    { ...entry('Merge this note into another…', '', () => mergeNote()), aliases: ['Merge notes', 'Note composer'] },
    { ...entry('Split this note from the caret on', '', () => splitNote()), aliases: ['Split note', 'Extract to a new note'] },
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
