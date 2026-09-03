/** Application wiring. */

import { PaperModel, PAGE_SIZES } from './core/editor/model.js';
import { Renderer } from './core/editor/render.js';
import { InputCapture } from './core/editor/input.js';
import { EditorController } from './core/editor/controller.js';
import { Measurer, Deferred, paginate, pageHeightPx } from './pagination.js';
import {
  toMarkdown, toHtml, toPlainText, toPrintPages, outline,
} from './export.js';
import { point, collapsed, toDom } from './core/editor/selection.js';
import {
  hasFormat,
  setBlockKind,
  setBlockStyle,
  setAlign,
  insertBlockAt,
  blocksInRange,
} from './core/editor/commands.js';
import { showPanel, readFields, isDialogOpen, escapeHtml } from './core/panel.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme, isTheme } from './core/theme.js';
import { renderToPdf } from './core/pdf.js';
import {
  pickToOpen, pickToSave, readDocument, readResource, writeDocument, writeText,
  writeBytes, readFileBytes, stagePart, clearStaged, fileExists, runtimeInfo,
  onFilesDropped, baseName, withExtension, toDataUrl, FILTERS,
} from './io.js';

const el = (id) => document.getElementById(id);
const { invoke } = window.__TAURI__.core;

const surface = el('surface');
const sheet = el('sheet');
const renderer = new Renderer(surface);
const measurer = new Measurer();

let model = new PaperModel();
let images = new Map();

/** Everything between a keystroke and the model. */
const editor = new EditorController(surface, renderer, {
  images: () => images,
  serialiseCopy: (blocks) => ({
    text: toPlainText({ blocks }),
    html: toHtml({ ...model, blocks }),
  }),
  onChange: () => { repaginate.schedule(); refresh(); },
});
/** The same pictures as their own bytes. */
let imageBytes = new Map();
let busy = false;

let settings = {
  theme: 'system', showOutline: false, spellcheck: false, showMargins: true,
};

// Notifications

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3400);
}

async function guard(label, action) {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (err) {
    console.error(`[GRT] ${label} failed`, err);
    toast(`${label} failed: ${err.message ?? err}`, true);
  } finally {
    busy = false;
    refresh();
  }
}

// The loop

/**
 * Editing, drawing and the editor.selection all live in the shared controller
 * now.
 */

const draw = () => editor.draw();
const readSelection = () => editor.readSelection();
const edit = (mutate, options) => editor.edit(mutate, options);

function refresh() {
  el('btn-undo').disabled = busy || !editor.undo.canUndo;
  el('btn-redo').disabled = busy || !editor.undo.canRedo;

  for (const [id, mark] of [['btn-bold', 'bold'], ['btn-italic', 'italic'],
    ['btn-underline', 'underline'], ['btn-strike', 'strike']]) {
    el(id).setAttribute('aria-pressed', String(hasFormat(model, editor.selection, mark)));
  }

  const block = model.block(editor.selection.anchor.blockId);
  if (block) el('style-picker').value = block.style ?? 'body';

  const counts = model.counts();
  const parts = [`${counts.words} words`, `${pageCount} page${pageCount === 1 ? '' : 's'}`];
  if (model.dirty) parts.push('unsaved changes');
  el('status').textContent = parts.join(' • ');
}

// Pagination

let pageCount = 1;

/** Recalculates the page breaks, after a lull. */
const repaginate = new Deferred(() => {
  for (const marker of surface.querySelectorAll('.page-break')) marker.remove();

  const measured = measurer.measure(model, surface);
  const { pages, breakAfter } = paginate(measured, pageHeightPx(model));
  pageCount = pages.length;

  let number = 1;
  for (const id of breakAfter) {
    const element = surface.querySelector(
      `[data-block="${id}"], [data-block-container="${id}"]`,
    );
    if (!element) continue;
    const marker = document.createElement('div');
    marker.className = 'page-break';
    marker.contentEditable = 'false';
    number += 1;
    marker.dataset.label = `page ${number}`;
    element.after(marker);
  }

  refresh();
}, 220);

// Editing

const handlers = editor.handlers;

/**
 * Undo and redo. The controller restores the model and the editor.selection;
 * the measurements cached for pagination belong to this module, so they are
 * dropped here.
 */
function step(direction) {
  measurer.invalidate();
  editor.step(direction);
}

// Blocks and styles

function applyStyle(style) {
  editor.typing.end();
  readSelection();
  const kind = style.startsWith('h') ? 'heading'
    : style === 'quote' ? 'quote'
      : style === 'code' ? 'code' : 'paragraph';

  edit(() => {
    setBlockKind(model, editor.selection, kind, { level: Number(style[1]) || 1, style });
    setBlockStyle(model, editor.selection, style);
    return editor.selection;
  });
  measurer.invalidate();
}

function applyList(listType) {
  editor.typing.end();
  readSelection();
  const block = model.block(editor.selection.anchor.blockId);

  edit(() => (block?.kind === 'list' && block.listType === listType
    ? setBlockKind(model, editor.selection, 'paragraph')
    : setBlockKind(model, editor.selection, 'list', { listType })));
  measurer.invalidate();
}

function applyAlign(align) {
  readSelection();
  edit(() => setAlign(model, editor.selection, align));
}

function insertPageBreak() {
  readSelection();
  edit(() => {
    for (const id of blocksInRange(model, editor.selection)) {
      const block = model.block(id);
      if (block) block.breakBefore = true;
    }
    model.dirty = true;
    return editor.selection;
  });
  measurer.invalidate();
  toast('Page break added before this paragraph');
}

function insertImage() {
  return guard('Insert image', async () => {
    const path = await pickToOpen(FILTERS.image, 'Choose an image');
    if (!path) return;

    const bytes = await readFileBytes(path);
    const name = `resources/${baseName(path)}`;
    await stagePart(name, bytes);
    images.set(name, toDataUrl(bytes, name));
    imageBytes.set(name, bytes);

    readSelection();
    edit(() => insertBlockAt(model, editor.selection, {
      kind: 'image', resource: name, w: 400, h: 260, align: 'center',
    }));
    measurer.invalidate();
    toast(`Inserted ${baseName(path)}`);
  });
}

// Find and replace

async function findReplace() {
  const confirmed = await showPanel('Find and replace', `
    <div class="form-grid">
      <label for="f-find">Find</label>
      <input id="f-find" type="text" data-field="find" />
      <label for="f-replace">Replace with</label>
      <input id="f-replace" type="text" data-field="replace" />
    </div>
    <div class="setting">
      <span class="label">Treat the search as a regular expression</span>
      <input type="checkbox" data-field="regex" />
    </div>
    <div class="setting">
      <span class="label">Match case</span>
      <input type="checkbox" data-field="matchCase" />
    </div>
    <p class="fp-note">
      Replacing changes the document in one undoable step, so Ctrl+Z takes back
      the whole operation rather than one occurrence at a time.
    </p>`, 'Replace all');
  if (!confirmed) return;

  const fields = readFields();
  if (!fields.find) return;

  let pattern;
  try {
    pattern = fields.regex
      ? new RegExp(fields.find, fields.matchCase ? 'g' : 'gi')
      : new RegExp(fields.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        fields.matchCase ? 'g' : 'gi');
  } catch (err) {
    toast(`That is not a valid expression: ${err.message}`, true);
    return;
  }

  let count = 0;
  edit(() => {
    for (const block of model.blocks) {
      const lists = block.kind === 'list' ? block.items : [block];
      for (const holder of lists) {
        if (!holder.runs) continue;
        holder.runs = holder.runs.map((run) => {
          const replaced = run.text.replace(pattern, (match) => {
            count += 1;
            return fields.replace ?? '';
          });
          return { ...run, text: replaced };
        }).filter((run) => run.text !== '');
        if (holder.runs.length === 0) holder.runs = [{ text: '' }];
      }
    }
    model.dirty = true;
    return editor.selection;
  });

  measurer.invalidate();
  toast(count > 0 ? `Replaced ${count} occurrence(s)` : 'Nothing matched');
}

// Contents

function toggleOutline() {
  settings.showOutline = !settings.showOutline;
  el('outline-panel').classList.toggle('hidden', !settings.showOutline);
  drawOutline();
  saveSettings();
}

function drawOutline() {
  if (!settings.showOutline) return;
  const headings = outline(model);

  const panel = el('outline-panel');
  panel.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Contents';
  panel.append(title);

  if (headings.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'Headings appear here as you write them.';
    panel.append(empty);
    return;
  }

  for (const heading of headings) {
    const link = document.createElement('a');
    link.dataset.level = String(heading.level);
    link.textContent = heading.text || '(untitled)';
    link.onclick = () => {
      editor.selection = collapsed(point(heading.id, 0));
      toDom(surface, editor.selection);
      surface.querySelector(`[data-block="${heading.id}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    panel.append(link);
  }
}

// Page setup

async function pageSetup() {
  const page = model.page;
  const confirmed = await showPanel('Page', `
    <div class="form-grid">
      <label for="p-size">Size</label>
      <select id="p-size" data-field="size">
        ${Object.entries(PAGE_SIZES).map(([id, s]) =>
    `<option value="${id}"${page.size === id ? ' selected' : ''}>`
    + `${s.label} — ${s.w}×${s.h} mm</option>`).join('')}
      </select>
      <label for="p-orientation">Orientation</label>
      <select id="p-orientation" data-field="orientation">
        <option value="portrait"${page.orientation === 'portrait' ? ' selected' : ''}>Portrait</option>
        <option value="landscape"${page.orientation === 'landscape' ? ' selected' : ''}>Landscape</option>
      </select>
      <label for="p-top">Margins (mm)</label>
      <input id="p-top" type="number" data-field="top" min="5" max="60" value="${page.margins.top}" />
      <label for="p-right">Right</label>
      <input id="p-right" type="number" data-field="right" min="5" max="60" value="${page.margins.right}" />
      <label for="p-bottom">Bottom</label>
      <input id="p-bottom" type="number" data-field="bottom" min="5" max="60" value="${page.margins.bottom}" />
      <label for="p-left">Left</label>
      <input id="p-left" type="number" data-field="left" min="5" max="60" value="${page.margins.left}" />
    </div>`, 'Apply');
  if (!confirmed) return;

  const f = readFields();
  edit(() => {
    model.setPage({
      size: f.size,
      orientation: f.orientation,
      margins: { top: f.top, right: f.right, bottom: f.bottom, left: f.left },
    });
    return editor.selection;
  });

  applyPageToSheet();
  measurer.invalidate();
  repaginate.schedule();
}

/** Publishes the page metrics as custom properties. */
function applyPageToSheet() {
  const box = model.pageBox();
  const m = model.page.margins;

  sheet.style.setProperty('--page-w', `${box.width}mm`);
  sheet.style.setProperty('--page-h', `${box.height}mm`);
  sheet.style.setProperty('--mt', `${m.top}mm`);
  sheet.style.setProperty('--mr', `${m.right}mm`);
  sheet.style.setProperty('--mb', `${m.bottom}mm`);
  sheet.style.setProperty('--ml', `${m.left}mm`);
  sheet.classList.toggle('show-margins', !!settings.showMargins);
}

// Files

function newDocument() {
  model = new PaperModel();
  images = new Map();
  editor.attach(model);
  imageBytes = new Map();
  measurer.invalidate();
  clearStaged().catch(() => {});
  document.title = 'GRT Paper';
  applyPageToSheet();
  draw();
}

async function openPath(path) {
  const { parts, resources } = await readDocument(path);
  const raw = parts['content/main.json'];
  if (!raw) throw new Error('This document has no text content');

  model = new PaperModel(JSON.parse(raw));
  model.path = path;
  editor.attach(model);
  measurer.invalidate();

  images = new Map();
  imageBytes = new Map();
  await clearStaged();
  for (const name of resources ?? []) {
    const bytes = await readResource(path, name);
    images.set(name, toDataUrl(bytes, name));
    imageBytes.set(name, bytes);
    await stagePart(name, bytes);
  }

  applyPageToSheet();
  // Point the controller at the document before anything is drawn.
  editor.attach(model);
  drawOutline();

  document.title = `${baseName(path)} — GRT Paper`;
  toast(`Opened ${baseName(path)} — ${model.counts().words} words`);
}

async function save(forceDialog) {
  let path = forceDialog ? null : model.path;
  if (!path) {
    path = await pickToSave(model.path ?? 'document.grt', FILTERS.grt, 'Save document');
    if (!path) return;
  }

  const manifest = {
    kind: 'paper',
    format_version: 1,
    parts: [{ path: 'content/main.json', media_type: 'application/json' }],
    links: [],
  };

  await writeDocument(path, {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'content/main.json': `${JSON.stringify(model.toJSON(), null, 2)}\n`,
  });

  model.path = path;
  model.dirty = false;
  document.title = `${baseName(path)} — GRT Paper`;
  refresh();
  toast(`Saved ${baseName(path)}`);
}

async function exportDocument() {
  const confirmed = await showPanel('Export', `
    <div class="form-grid">
      <label for="e-format">Format</label>
      <select id="e-format" data-field="format">
        <option value="pdf">PDF — what the pages look like</option>
        <option value="html">HTML — one file, images inlined</option>
        <option value="md">Markdown</option>
        <option value="txt">Plain text</option>
      </select>
    </div>
    <p class="fp-note">
      The PDF goes through the suite's shared print engine, the same code that
      clears metadata in GRT Read. Markdown will say what it could not carry —
      it has no pages, no margins and no alignment.
    </p>`, 'Choose file');
  if (!confirmed) return;

  const { format } = readFields();
  const path = await pickToSave(withExtension(model.path, format), FILTERS[format], 'Export to');
  if (!path) return;

  if (format === 'pdf') {
    const pages = toPrintPages(model, imageBytes);
    const rendered = await Promise.all(pages.map((page) => renderToPdf(page, { audit: false })));
    await writeBytes(path, await mergePdfPages(rendered));
    toast(`Exported ${pages.length} page(s)`);
    return;
  }

  if (format === 'html') {
    await writeText(path, toHtml(model, images));
  } else if (format === 'txt') {
    await writeText(path, toPlainText(model));
  } else {
    const { text, lost } = toMarkdown(model);
    await writeText(path, text);
    await showPanel('Exported as Markdown', `
      <p class="fp-note" style="margin-top:0">
        Written. What follows is what Markdown cannot represent — listed rather
        than dropped quietly, because a conversion that loses things silently is
        discovered at the worst moment.
      </p>
      <ul class="problem-list">${lost.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      <p class="fp-note">For a document that must not change, export PDF.</p>`);
    return;
  }

  toast(`Exported ${baseName(path)}`);
}

/** Joins single-page PDFs, keeping the regeneration guarantee. */
async function mergePdfPages(pages) {
  const { PDFDocument } = await import('../vendor/pdf-lib.esm.js');
  const { stripMetadata } = await import('./core/metadata.js');

  const output = await PDFDocument.create({ updateMetadata: false });
  for (const bytes of pages) {
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const copied = await output.copyPages(source, source.getPageIndices());
    for (const page of copied) output.addPage(page);
  }

  stripMetadata(output);
  return output.save({ useObjectStreams: true, addDefaultPage: false });
}

// Settings

async function loadSettings(ephemeral) {
  if (!ephemeral) {
    try {
      const stored = (await invoke('read_settings')) ?? {};
      settings = { ...settings, ...stored };
    } catch { /** first run. */ }
  }
  if (!isTheme(settings.theme)) settings.theme = 'system';
  applyTheme(settings.theme);
  el('outline-panel').classList.toggle('hidden', !settings.showOutline);
  surface.spellcheck = !!settings.spellcheck;
}

async function saveSettings() {
  try {
    await invoke('write_settings', { settings });
  } catch { /** ephemeral, or nowhere to write. */ }
}

async function openSettings() {
  const confirmed = await showPanel('Settings', `
    <div class="setting">
      <span class="label">Theme
        <span class="hint">The window's own colours. The page stays white,
        because that is what it will be on paper.</span>
      </span>
      <select data-field="theme">
        ${THEMES.map((t) =>
    `<option value="${t.id}"${settings.theme === t.id ? ' selected' : ''}>${t.label}</option>`)
    .join('')}
      </select>
    </div>
    <div class="setting">
      <span class="label">Show the contents panel</span>
      <input type="checkbox" data-field="showOutline" ${settings.showOutline ? 'checked' : ''} />
    </div>
    <div class="setting">
      <span class="label">Show the margins
        <span class="hint">A faint line where the text column ends.</span>
      </span>
      <input type="checkbox" data-field="showMargins" ${settings.showMargins ? 'checked' : ''} />
    </div>
    <div class="setting">
      <span class="label">Spell checking
        <span class="hint">Uses the system's own dictionaries through the
        webview. Nothing is sent anywhere.</span>
      </span>
      <input type="checkbox" data-field="spellcheck" ${settings.spellcheck ? 'checked' : ''} />
    </div>`, 'Apply');
  if (!confirmed) return;

  settings = { ...settings, ...readFields() };
  applyTheme(settings.theme);
  applyPageToSheet();
  el('outline-panel').classList.toggle('hidden', !settings.showOutline);
  surface.spellcheck = !!settings.spellcheck;
  drawOutline();
  await saveSettings();
  toast('Settings saved');
}

// Command palette

function commands() {
  const entry = (label, hint, run) => ({ id: label, label, hint, run });

  return [
    entry('New document', 'Ctrl+N', () => newDocument()),
    entry('Open…', 'Ctrl+O', () => el('btn-open').click()),
    entry('Save', 'Ctrl+S', () => guard('Save', () => save(false))),
    entry('Save as…', 'Ctrl+Shift+S', () => guard('Save', () => save(true))),
    entry('Export…', '', () => guard('Export', exportDocument)),

    ...['body', 'h1', 'h2', 'h3', 'h4', 'quote', 'code'].map((style) =>
      entry(`Style: ${style}`, '', () => applyStyle(style))),

    entry('Bold', 'Ctrl+B', () => handlers.toggleMark('bold')),
    entry('Italic', 'Ctrl+I', () => handlers.toggleMark('italic')),
    entry('Underline', 'Ctrl+U', () => handlers.toggleMark('underline')),
    entry('Strikethrough', '', () => handlers.toggleMark('strike')),
    entry('Superscript', '', () => handlers.toggleMark('sup')),
    entry('Subscript', '', () => handlers.toggleMark('sub')),

    ...['left', 'center', 'right', 'justify'].map((align) =>
      entry(`Align ${align}`, '', () => applyAlign(align))),

    entry('Bulleted list', '', () => applyList('bullet')),
    entry('Numbered list', '', () => applyList('number')),
    entry('Insert image…', '', () => insertImage()),
    entry('Insert page break', '', () => insertPageBreak()),

    entry('Find and replace…', 'Ctrl+F', () => guard('Find', findReplace)),
    entry('Table of contents', '', () => toggleOutline()),
    entry('Page setup…', '', () => guard('Page', pageSetup)),
    entry('Word count', '', () => {
      const c = model.counts();
      showPanel('Count', `
        <table class="fp-table"><tbody>
          <tr><th>Words</th><td>${c.words}</td></tr>
          <tr><th>Characters</th><td>${c.characters}</td></tr>
          <tr><th>Characters without spaces</th><td>${c.charactersNoSpaces}</td></tr>
          <tr><th>Paragraphs</th><td>${c.blocks}</td></tr>
          <tr><th>Pages</th><td>${pageCount}</td></tr>
        </tbody></table>`);
    }),

    entry('Undo', 'Ctrl+Z', () => step(-1)),
    entry('Redo', 'Ctrl+Y', () => step(1)),
    entry('Settings…', 'Ctrl+,', () => guard('Settings', openSettings)),
  ];
}

// Events

new InputCapture(surface, handlers);

document.addEventListener('selectionchange', () => {
  if (document.activeElement === surface) {
    readSelection();
    refresh();
  }
});

el('btn-new').onclick = () => newDocument();
el('btn-open').onclick = () => guard('Open', async () => {
  const path = await pickToOpen(FILTERS.grt, 'Open document');
  if (path) await openPath(path);
});
el('btn-save').onclick = () => guard('Save', () => save(false));
el('btn-save-as').onclick = () => guard('Save', () => save(true));
el('btn-export').onclick = () => guard('Export', exportDocument);
el('btn-undo').onclick = () => step(-1);
el('btn-redo').onclick = () => step(1);
el('btn-bold').onclick = () => handlers.toggleMark('bold');
el('btn-italic').onclick = () => handlers.toggleMark('italic');
el('btn-underline').onclick = () => handlers.toggleMark('underline');
el('btn-strike').onclick = () => handlers.toggleMark('strike');
el('btn-align-left').onclick = () => applyAlign('left');
el('btn-align-center').onclick = () => applyAlign('center');
el('btn-align-right').onclick = () => applyAlign('right');
el('btn-align-justify').onclick = () => applyAlign('justify');
el('btn-bullets').onclick = () => applyList('bullet');
el('btn-numbers').onclick = () => applyList('number');
el('btn-image').onclick = () => insertImage();
el('btn-break').onclick = () => insertPageBreak();
el('btn-find').onclick = () => guard('Find', findReplace);
el('btn-outline').onclick = () => toggleOutline();
el('btn-page-setup').onclick = () => guard('Page', pageSetup);
el('btn-settings').onclick = () => guard('Settings', openSettings);
el('btn-commands').onclick = () => openPalette(commands());
el('style-picker').onchange = (event) => applyStyle(event.target.value);

document.addEventListener('keydown', (event) => {
  if (isDialogOpen() || isPaletteOpen()) return;

  const ctrl = event.ctrlKey || event.metaKey;
  if (!ctrl) return;

  const key = event.key.toLowerCase();
  if (key === 'k') {
    event.preventDefault();
    openPalette(commands());
  } else if (key === 's') {
    event.preventDefault();
    guard('Save', () => save(event.shiftKey));
  } else if (key === 'o') {
    event.preventDefault();
    el('btn-open').click();
  } else if (key === 'n') {
    event.preventDefault();
    newDocument();
  } else if (key === 'f') {
    event.preventDefault();
    guard('Find', findReplace);
  } else if (event.key === ',') {
    event.preventDefault();
    guard('Settings', openSettings);
  }
});

onFilesDropped((paths) => guard('Open', async () => {
  const found = paths.find((p) => /\.grt$/i.test(p));
  if (found) await openPath(found);
}));

// Startup

(async function start() {
  const info = await runtimeInfo();
  await loadSettings(info.ephemeral);
  if (info.ephemeral) el('ephemeral-note').classList.remove('hidden');

  applyPageToSheet();
  // Point the controller at the document before anything is drawn.
  editor.attach(model);
  drawOutline();
  surface.focus();

  if (info.initialFile && await fileExists(info.initialFile)) {
    await guard('Open', () => openPath(info.initialFile));
  }
}());
