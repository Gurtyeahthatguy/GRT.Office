/** Application wiring. */

import {
  PaperModel, PAGE_SIZES, SLOT_ALIGNMENTS, pageDimensions, makeBlock, itemIndices,
} from './core/editor/model.js';
import { Renderer, withPara } from './core/editor/render.js';
import { InputCapture } from './core/editor/input.js';
import { EditorController } from './core/editor/controller.js';
import { Measurer, Deferred, paginate, pageHeightPx } from './pagination.js';
import {
  toMarkdown, toHtml, toPlainText, outline,
} from './export.js';
import { point, collapsed, toDom } from './core/editor/selection.js';
import {
  setBlockKind,
  setBlockStyle,
  setAlign,
  insertBlockAt,
  blocksInRange,
  applyFormat,
} from './core/editor/commands.js';
import { MARKS } from './core/editor/model.js';
import { createProperties } from './core/properties.js';
import { showPanel, showChoice, readFields, isDialogOpen, escapeHtml } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { withPassword, passwordFields, wirePasswordFields, passwordFrom, canProtect, PROTECTION } from './core/protection.js';
import { readOdt } from './core/formats/odt-read.js';
import { writeOdt } from './core/formats/odt-write.js';
import { readDocx } from './core/formats/docx-read.js';
import { writeDocx } from './core/formats/docx-write.js';
import { readRtf } from './core/formats/rtf-read.js';
import { readMarkdown } from './core/formats/markdown-read.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme, isTheme } from './core/theme.js';
import { printPreview, isPrintPreviewOpen, exportPdf } from './core/print.js';
import { printablePages } from './printing.js';
import { Keeper, MODES, isMode } from './core/keeper.js';
import { stripMetadata, neutralName } from './core/image-metadata.js';
import {
  pickToOpen, pickToSave, readDocument, readResource, writeDocument, writeText,
  writeBytes, readFileBytes, readText, stagePart, clearStaged, fileExists, runtimeInfo,
  onFilesDropped, baseName, withExtension, toDataUrl, FILTERS,
} from './io.js';
import { isTemplate, baseFormat, asTemplate } from './core/formats/templates.js';
import { createMenubar, paletteEntries } from './core/menubar.js';
import { paperMenus } from './menus.js';
import { longDocument, fillPageNumbers, followLink } from './long.js';
import { paperCharts } from './charts.js';
import { paperStyles, paragraphStyles } from './styles.js';
import { whenMathReady } from './core/math.js';
import {
  tableAt, insertRow, deleteRows, insertColumn, deleteColumns, mergeCells, splitCell, setCells, setHeaderRows, setTable, deleteTable,
  setColumnWidths, setColumnWidth, sortRows, splitTable, mergeTables, textToTable, tableToText,
} from './core/editor/tables.js';
import { aboutDialog, licencesDialog } from './core/about.js';
import { templateManager } from './core/template-manager.js';
import { runListsOf } from './core/editor/fields.js';
import { readFormulaFile, formulaPackage, mathmlWithTex } from './core/formats/math-ml.js';
import { Losses } from './core/losses.js';
import { OBJECT, normaliseStyle } from './core/editor/model.js';

const el = (id) => document.getElementById(id);
const { invoke } = window.__TAURI__.core;

const surface = el('surface');
const sheet = el('sheet');
const renderer = new Renderer(surface);
const measurer = new Measurer();

let model = new PaperModel();
let images = new Map();

/** Formats a document can be saved back into. */
const WRITABLE = new Set(['grt', 'odt', 'fodt', 'docx', 'ott', 'dotx']);
const OPENABLE = /\.(grt|odt|fodt|docx|ott|dotx|rtf|md|markdown|dotm|mml|odf)$/i;

function formatOf(path) {
  const extension = (/\.([^.\\/]+)$/.exec(path ?? '')?.[1] ?? '').toLowerCase();
  return extension === 'markdown' ? 'md' : extension || null;
}

/**
 * What the open file is: its format, what did not come across when it was
 * read, and whether saving over it anyway was agreed to.
 */
let file = { format: 'grt', losses: [], confirmed: false, password: null };

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
  autosave: 'recovery',
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

/** Autosave, recovery copies, and asking before unsaved work is dropped. */
const keeper = new Keeper({
  name: () => baseName(model.path) ?? 'Untitled',
  path: () => model.path ?? null,
  canSaveInPlace: () => !!model.path && WRITABLE.has(file.format)
    && (file.losses.length === 0 || file.confirmed),
  writeCopy: (path) => writeDocument(path, documentParts(), file.password ?? null),
  save: (options) => save(false, options),
  openRecovered: (file, meta) => openRecovered(file, meta),
}, { program: 'GRT Paper', extension: 'grt', toast });

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

// The sidebar, made once the page is ready; refreshes before then pass it by.
let properties = null;

function refresh() {
  properties?.refresh();
  el('btn-undo').disabled = busy || !editor.undo.canUndo;
  el('btn-redo').disabled = busy || !editor.undo.canRedo;

  for (const [id, mark] of [['btn-bold', 'bold'], ['btn-italic', 'italic'],
    ['btn-underline', 'underline'], ['btn-strike', 'strike']]) {
    el(id).setAttribute('aria-pressed', String(editor.markIsOn(mark)));
  }

  const block = model.block(editor.selection.anchor.blockId);
  // The picker lists Paper's styles and the person's own, rebuilt when the list changes.
  const picker = el('style-picker');
  const styles = paragraphStyles(model);
  const signature = styles.map((s) => `${s.key}=${s.label}`).join('|');
  if (picker.dataset.styles !== signature) {
    picker.replaceChildren(...styles.map((s) => Object.assign(document.createElement('option'), { value: s.key, textContent: s.label })));
    picker.dataset.styles = signature;
  }
  if (block) picker.value = block.style ?? 'body';

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

  // The first page each block appears on, for the contents, the index and page references.
  const firstPage = new Map();
  pages.forEach((ids, index) => { for (const id of ids) if (!firstPage.has(id)) firstPage.set(id, index + 1); });
  fillPageNumbers(surface, (id) => firstPage.get(id) ?? null, pages.length);

  refresh();
}, 220);

// Editing

const handlers = editor.handlers;

/** Undo and redo, dropping the cached page measurements. */
function step(direction) {
  measurer.invalidate();
  editor.step(direction);
}

// Blocks and styles

function applyStyle(style) {
  editor.typing.end();
  readSelection();
  const kind = /^h[1-4]$/.test(style) ? 'heading'
    : style === 'quote' ? 'quote'
      : style === 'code' ? 'code' : 'paragraph';

  edit(() => {
    setBlockKind(model, editor.selection, kind, { level: Number(style[1]) || 1, style });
    setBlockStyle(model, editor.selection, style);
    // LibreOffice centres a title and a subtitle.
    if (style === 'title' || style === 'subtitle') setAlign(model, editor.selection, 'center');
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

/** Changes the chosen paragraphs' own spacing; `change` turns a paragraph's look into a patch. */
function applyPara(change) {
  readSelection();
  edit(() => {
    for (const id of blocksInRange(model, editor.selection)) {
      const block = model.block(id);
      if (block) model.setPara(id, change(withPara(model.styles[block.style] ?? {}, block.para)));
    }
    return editor.selection;
  });
  measurer.invalidate();
}

/** LibreOffice's single spacing is our 1.15, its steps 0.1 cm of spacing and 1.25 cm of indent. */
const SINGLE = 1.15;
const SPACING_STEP = 2.83;
const INDENT_STEP = 35.43;

const paraCommands = {
  lineSpacing: (times) => applyPara(() => ({ lineHeight: times * SINGLE })),
  spacing: (sign) => applyPara((look) => ({
    spaceBefore: Math.max(0, (look.spaceBefore ?? 0) + sign * SPACING_STEP),
    spaceAfter: Math.max(0, (look.spaceAfter ?? 0) + sign * SPACING_STEP),
  })),
  indent: (sign) => applyPara((look) => ({ indent: Math.max(0, (look.indent ?? 0) + sign * INDENT_STEP) })),
};

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

    const bytes = stripMetadata(await readFileBytes(path));
    const name = await neutralName(bytes, path);
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
  const running = page.running;
  const custom = pageDimensions(page);
  const sizes = [
    ...Object.entries(PAGE_SIZES).map(([id, s]) => [id, `${s.label}, ${s.w}×${s.h} mm`]),
    ['custom', 'Its own size'],
  ];
  const slot = (part, which, label) => {
    const value = running[part][which];
    return `
      <label for="r-${part}-${which}">${label}</label>
      <div class="inline-fields">
        <input id="r-${part}-${which}" type="text" data-field="${part}-${which}"
               value="${escapeHtml(value?.text ?? '')}" />
        <select data-field="${part}-${which}-align" aria-label="${label} alignment">
          ${SLOT_ALIGNMENTS.map((a) => `<option value="${a}"${(value?.align ?? 'center') === a ? ' selected' : ''}>${a}</option>`).join('')}
        </select>
      </div>`;
  };
  const confirmed = await showPanel('Page', `
    <div class="form-grid">
      <label for="p-size">Size</label>
      <select id="p-size" data-field="size">
        ${sizes.map(([id, label]) => `<option value="${id}"${page.size === id ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <label for="p-width">Own size (mm)</label>
      <div class="inline-fields">
        <input id="p-width" type="number" data-field="width" min="25" max="1200" step="0.1" value="${custom.w}" aria-label="Width" />
        <input id="p-height" type="number" data-field="height" min="25" max="1200" step="0.1" value="${custom.h}" aria-label="Height" />
      </div>
      <label for="p-orientation">Orientation</label>
      <select id="p-orientation" data-field="orientation">
        <option value="portrait"${page.orientation === 'portrait' ? ' selected' : ''}>Portrait</option>
        <option value="landscape"${page.orientation === 'landscape' ? ' selected' : ''}>Landscape</option>
      </select>
      <label for="p-top">Margins (mm), top</label>
      <input id="p-top" type="number" data-field="top" min="5" max="60" value="${page.margins.top}" />
      <label for="p-right">Right</label>
      <input id="p-right" type="number" data-field="right" min="5" max="60" value="${page.margins.right}" />
      <label for="p-bottom">Bottom</label>
      <input id="p-bottom" type="number" data-field="bottom" min="5" max="60" value="${page.margins.bottom}" />
      <label for="p-left">Left</label>
      <input id="p-left" type="number" data-field="left" min="5" max="60" value="${page.margins.left}" />
      ${slot('header', 'default', 'Header')}
      ${slot('footer', 'default', 'Footer')}
    </div>
    <div class="setting">
      <span class="label">A different first page</span>
      <input type="checkbox" data-field="firstDifferent" ${running.firstDifferent ? 'checked' : ''} />
    </div>
    <div class="form-grid">
      ${slot('header', 'first', 'First header')}
      ${slot('footer', 'first', 'First footer')}
    </div>
    <div class="setting">
      <span class="label">Different even pages</span>
      <input type="checkbox" data-field="evenDifferent" ${running.evenDifferent ? 'checked' : ''} />
    </div>
    <div class="form-grid">
      ${slot('header', 'even', 'Even header')}
      ${slot('footer', 'even', 'Even footer')}
    </div>
    <p class="fp-note">{page} and {pages} in a header or footer become the page
    number and the number of pages. They show on paper and in the PDF.</p>`, 'Apply');
  if (!confirmed) return;

  const f = readFields();
  const slotFrom = (part, which) => ({ text: f[`${part}-${which}`] ?? '', align: f[`${part}-${which}-align`] });
  edit(() => {
    model.setPage({
      size: f.size,
      width: f.width,
      height: f.height,
      orientation: f.orientation,
      margins: { top: f.top, right: f.right, bottom: f.bottom, left: f.left },
      running: {
        firstDifferent: f.firstDifferent,
        evenDifferent: f.evenDifferent,
        header: { default: slotFrom('header', 'default'), first: slotFrom('header', 'first'), even: slotFrom('header', 'even') },
        footer: { default: slotFrom('footer', 'default'), first: slotFrom('footer', 'first'), even: slotFrom('footer', 'even') },
      },
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
  file = { format: 'grt', losses: [], confirmed: false, password: null };
  images = new Map();
  editor.attach(model);
  keeper.watch(model);
  imageBytes = new Map();
  measurer.invalidate();
  clearStaged().catch(() => {});
  document.title = 'GRT Paper';
  applyPageToSheet();
  draw();
}

/** New and Open drop the current document: ask first if it has unsaved work. */
async function newDocumentConfirmed() {
  if (await keeper.confirmLeave()) newDocument();
}

async function openConfirmed(path) {
  if (await keeper.confirmLeave()) await openPath(path);
}

/** Reads a document into the editor, without naming it. */
async function loadDocument(path, password = null) {
  const { parts, resources } = await readDocument(path, password);
  const raw = parts['content/main.json'];
  if (!raw) throw new Error('This document has no text content');

  model = new PaperModel(JSON.parse(raw));
  editor.attach(model);
  keeper.watch(model);
  measurer.invalidate();

  images = new Map();
  imageBytes = new Map();
  await clearStaged();
  for (const name of resources ?? []) {
    const bytes = await readResource(path, name, password);
    images.set(name, toDataUrl(bytes, name));
    imageBytes.set(name, bytes);
    await stagePart(name, bytes);
  }

  applyPageToSheet();
  // Point the controller at the document before anything is drawn.
  editor.attach(model);
  drawOutline();
}

async function openPath(path) {
  const format = formatOf(path);
  if (format !== 'grt') {
    await importDocument(path, format);
    return;
  }
  const opened = await withPassword(baseName(path), (password) => loadDocument(path, password));
  if (!opened) return;
  model.path = path;
  file = { format: 'grt', losses: [], confirmed: false, password: opened.password };
  document.title = `${baseName(path)} - GRT Paper`;
  toast(`Opened ${baseName(path)}: ${model.counts().words} words`);
}

/** Reads a document in another program's format, and says what did not come across. */
async function importDocument(path, given) {
  const template = isTemplate(given);
  const format = baseFormat(given);
  let result;
  let password = null;
  const unlocked = async () => {
    const opened = await withPassword(baseName(path), (given) => readPackage(path, { password: given }));
    password = opened?.password ?? null;
    return opened?.value ?? null;
  };
  if (format === 'odt' || format === 'docx') {
    const pkg = await unlocked();
    if (!pkg) return;
    result = format === 'odt' ? readOdt(pkg) : readDocx(pkg);
  }
  else if (format === 'fodt') result = readOdt(await readText(path));
  else if (format === 'mml' || format === 'odf') {
    // A formula file opens as a document holding the formula, on a line of its own.
    const text = format === 'mml' ? await readText(path) : (await unlocked())?.text('content.xml');
    const object = readFormulaFile(text);
    if (!object) throw new Error('There is no formula in that file');
    const fresh = new PaperModel();
    fresh.blocks[0].runs = [{ text: OBJECT, object }];
    result = { document: fresh.toJSON(), images: new Map(), losses: new Losses() };
  }
  else if (format === 'rtf') result = readRtf(await readFileBytes(path));
  else if (format === 'md') {
    const folder = path.replace(/[^\\/]*$/, '');
    result = await readMarkdown(await readText(path), (src) => (/^([a-z]:)?[\\/]/i.test(src)
      ? readFileBytes(src) : readFileBytes(`${folder}${src}`)).catch(() => null));
  } else {
    throw new Error(`GRT Paper does not open .${format} files`);
  }

  model = new PaperModel(result.document);
  editor.attach(model);
  keeper.watch(model);
  measurer.invalidate();
  images = new Map();
  imageBytes = new Map();
  await clearStaged();
  for (const [name, original] of result.images) {
    // A picture that arrived inside a document loses its metadata too, unless it cannot be read well enough.
    let bytes = original;
    try {
      bytes = stripMetadata(original);
    } catch { /* kept as it came */ }
    images.set(name, toDataUrl(bytes, name));
    imageBytes.set(name, bytes);
    await stagePart(name, bytes);
  }
  // A template starts a new document: nothing is saved back into it unless asked.
  model.path = template ? null : path;
  file = template ? { format: 'grt', losses: [], confirmed: false, password: null } : { format, losses: result.losses.lines(), confirmed: false, password };
  applyPageToSheet();
  editor.attach(model);
  drawOutline();
  document.title = template ? `Untitled, from ${baseName(path)} - GRT Paper` : `${baseName(path)} - GRT Paper`;

  if (result.losses.empty) {
    toast(`Opened ${baseName(path)}: ${model.counts().words} words`);
    return;
  }
  await showPanel(`Opened ${escapeHtml(baseName(path))}`, `
    <p class="fp-note" style="margin-top:0">${model.counts().words} words. What follows did
    not come across, listed rather than dropped quietly.</p>
    ${result.losses.html()}
    <p class="fp-note">Saving over the file would lose these for good, so it
    asks first; saving as a GRT document keeps everything that did come across.</p>`);
}

/** Opens a recovery copy as the document it was, with its changes unsaved. */
async function openRecovered(copy, meta) {
  const opened = await withPassword(meta.name || 'Untitled', (password) => loadDocument(copy, password));
  // Without its password the copy stays where it is, offered again next time.
  if (!opened) throw new Error('the copy is kept for next time');
  model.path = meta.path ?? null;
  const format = formatOf(meta.path) ?? 'grt';
  file = {
    format,
    losses: format === 'grt' ? [] : ['Anything the program could not read when the file was first opened'],
    confirmed: false,
    password: opened.password,
  };
  model.dirty = true;
  const name = meta.name || 'Untitled';
  document.title = `${name} (recovered) - GRT Paper`;
  refresh();
  toast(`Recovered ${name}: save it to keep the changes`);
}

/** The text parts of a saved document; images travel as staged parts. */
function documentParts() {
  const manifest = {
    kind: 'paper',
    format_version: 1,
    parts: [{ path: 'content/main.json', media_type: 'application/json' }],
    links: [],
  };
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'content/main.json': `${JSON.stringify(model.toJSON(), null, 2)}\n`,
  };
}

const FORMAT_NAMES = {
  grt: 'GRT document (.grt)',
  odt: 'OpenDocument text (.odt)',
  docx: 'Word document (.docx)',
  fodt: 'Flat OpenDocument text (.fodt)',
  ott: 'OpenDocument template (.ott)',
  dotx: 'Word template (.dotx)',
};

/** Asks which format to save in, with or without a password, then where. */
async function chooseSaveTarget(preferred = null) {
  let current = preferred ?? (WRITABLE.has(file.format) ? file.format : 'grt');
  let problem = '';
  for (;;) {
    const answer = showPanel('Save as', `
      <div class="form-grid">
        <label for="s-format">Format</label>
        <select id="s-format" data-field="format">
          ${Object.entries(FORMAT_NAMES).map(([id, label]) =>
    `<option value="${id}"${id === current ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      ${passwordFields(file.password ?? null, problem)}
      <p class="fp-note">A GRT document keeps everything this program can do.
      The others open in LibreOffice and Word; what they cannot hold is said
      before anything is written. A flat .fodt cannot carry a password.</p>`, 'Choose file');
    wirePasswordFields();
    if (!await answer) return null;
    const fields = readFields();
    const protection = passwordFrom(fields, fields.format);
    if (protection.error) {
      problem = protection.error;
      current = fields.format;
      continue;
    }
    const chosen = await pickToSave(withExtension(model.path ?? 'document', fields.format), FILTERS[fields.format], 'Save document');
    return chosen ? { path: withExtension(chosen, fields.format), format: fields.format, password: protection.password } : null;
  }
}

/** Writes the document in a format, and says what that format could not hold. */
async function writeAs(path, format, password = null) {
  if (format === 'grt') {
    await writeDocument(path, documentParts(), password);
    return [];
  }
  const json = model.toJSON();
  if (format === 'fodt') {
    const { text, losses } = writeOdt(json, imageBytes, { flat: true });
    await writeText(path, text);
    return losses.lines();
  }
  const { entries, losses } = baseFormat(format) === 'odt' ? writeOdt(json, imageBytes) : writeDocx(json, imageBytes);
  await writePackage(path, isTemplate(format) ? asTemplate(entries, format) : entries, { protection: PROTECTION[format], password });
  return losses.lines();
}

/**
 * Saves the document, in its own format when it can be written back. Silent,
 * it asks nothing and reports nothing, which is how autosave writes onto the
 * file. Resolves false when nothing was saved.
 */
async function save(forceDialog, { silent = false } = {}) {
  let path = forceDialog ? null : model.path;
  let format = file.format;
  let password = file.password ?? null;
  if (path && !WRITABLE.has(format)) {
    if (silent) return false;
    path = null;
  }
  if (!path) {
    if (silent) return false;
    const chosen = await chooseSaveTarget();
    if (!chosen) return false;
    ({ path, format, password } = chosen);
  } else if (file.losses.length > 0 && !file.confirmed) {
    if (silent) return false;
    const choice = await showChoice(`Save over “${baseName(path)}”?`, `
      <p>When it was opened, these did not come across. Saving over the file
      drops them from it for good:</p>
      <ul class="problem-list">${file.losses.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`, [
      { id: 'cancel', label: 'Cancel' },
      { id: 'copy', label: 'Save a copy…', primary: true },
      { id: 'over', label: 'Save over it' },
    ]);
    if (choice === 'copy') return save(true);
    if (choice !== 'over') return false;
    file.confirmed = true;
  }

  const revision = keeper.revision;
  if (!canProtect(format)) password = null;
  const lost = await writeAs(path, format, password);

  const sameFile = path === model.path && format === file.format;
  model.path = path;
  file = sameFile ? { ...file, password } : { format, losses: [], confirmed: false, password };
  model.dirty = keeper.revision !== revision;
  editor.undo.markSaved();
  document.title = `${baseName(path)} - GRT Paper`;
  refresh();
  if (!silent) toast(lost.length > 0 ? `Saved ${baseName(path)}, without: ${lost.join('; ')}` : `Saved ${baseName(path)}`);
  await keeper.saved();
  return true;
}

/** A copy written elsewhere, the document open staying as it is; a template is one such copy. */
async function saveCopy(preferred = null) {
  const chosen = await chooseSaveTarget(preferred);
  if (!chosen) return;
  const lost = await writeAs(chosen.path, chosen.format, canProtect(chosen.format) ? chosen.password : null);
  toast(lost.length > 0 ? `Saved a copy as ${baseName(chosen.path)}, without: ${lost.join('; ')}` : `Saved a copy as ${baseName(chosen.path)}`);
}

async function printDocument() {
  await printPreview({ title: 'Print', setup: {}, build: () => printablePages(model, images), pdfTo: pickPdfPath });
  surface.focus();
}

const pickPdfPath = () => pickToSave(withExtension(model.path ?? 'document', 'pdf'), FILTERS.pdf, 'Export as PDF')
  .then((path) => (path ? withExtension(path, 'pdf') : null));

/** The pages as a PDF straight away, exactly as they print: tables, charts, notes and formulas included. */
async function exportDirectPdf() {
  const path = await pickPdfPath();
  if (!path) return;
  const pages = await exportPdf({ setup: {}, build: () => printablePages(model, images), path });
  toast(`Exported ${pages} page(s) as ${baseName(path)}`);
}

async function exportDocument() {
  const confirmed = await showPanel('Export', `
    <div class="form-grid">
      <label for="e-format">Format</label>
      <select id="e-format" data-field="format">
        <option value="pdf">PDF: what the pages look like</option>
        <option value="html">HTML: one file, images inlined</option>
        <option value="md">Markdown</option>
        <option value="txt">Plain text</option>
      </select>
    </div>
    <p class="fp-note">
      The PDF goes through the suite's shared print engine, the same code that
      clears metadata in GRT Read. Markdown will say what it could not carry:
      it has no pages, no margins and no alignment.
    </p>`, 'Choose file');
  if (!confirmed) return;

  const { format } = readFields();
  const path = await pickToSave(withExtension(model.path, format), FILTERS[format], 'Export to');
  if (!path) return;

  if (format === 'pdf') {
    const pages = await exportPdf({ setup: {}, build: () => printablePages(model, images), path });
    toast(`Exported ${pages} page(s)`);
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
        Written. What follows is what Markdown cannot represent, listed rather
        than dropped quietly, because a conversion that loses things silently is
        discovered at the worst moment.
      </p>
      <ul class="problem-list">${lost.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      <p class="fp-note">For a document that must not change, export PDF.</p>`);
    return;
  }

  toast(`Exported ${baseName(path)}`);
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
  if (!isMode(settings.autosave)) settings.autosave = 'recovery';
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
        because that is what it will be on paper; only Sepia tints it, and
        only on screen.</span>
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
    </div>
    <div class="setting">
      <span class="label">Keep unsaved work
        <span class="hint">Every couple of seconds of quiet. A recovery copy
        is offered back if the program closes unexpectedly; onto the file
        saves the document itself, once it has a name.</span>
      </span>
      <select data-field="autosave">
        ${MODES.map((m) =>
    `<option value="${m.id}"${settings.autosave === m.id ? ' selected' : ''}>${m.label}</option>`)
    .join('')}
      </select>
    </div>`, 'Apply');
  if (!confirmed) return;

  settings = { ...settings, ...readFields() };
  applyTheme(settings.theme);
  keeper.setMode(settings.autosave);
  applyPageToSheet();
  el('outline-panel').classList.toggle('hidden', !settings.showOutline);
  surface.spellcheck = !!settings.spellcheck;
  drawOutline();
  await saveSettings();
  toast('Settings saved');
}

// Tables

/** Back to the text after a dialog: the focus to the page, the caret where the edit left it. */
function backToText() {
  surface.focus({ preventScroll: true });
  editor.draw();
}

const inTable = () => {
  readSelection();
  return !!editor.selection && !!tableAt(model, editor.selection);
};

async function insertTable() {
  const confirmed = await showPanel('Insert table', `
    <div class="form-grid">
      <label for="t-cols">Columns</label><input id="t-cols" type="number" min="1" max="64" value="3" data-field="cols" />
      <label for="t-rows">Rows</label><input id="t-rows" type="number" min="1" max="2000" value="3" data-field="rows" />
    </div>
    <div class="setting"><span class="label">The first row is a heading, repeated on every page</span><input type="checkbox" data-field="header" checked /></div>`, 'Insert');
  if (!confirmed) return;
  const f = readFields();
  readSelection();
  edit(() => insertBlockAt(model, editor.selection, makeBlock('table', {
    rows: Math.max(1, Math.min(2000, f.rows || 3)), cols: Math.max(1, Math.min(64, f.cols || 3)), header: f.header,
  }), { enter: true }));
  measurer.invalidate();
  backToText();
}

async function tableProperties() {
  const at = tableAt(model, editor.selection);
  if (!at) return;
  const cell = at.block.rows[at.row].cells[at.col];
  const confirmed = await showPanel('Table properties', `
    <div class="form-grid">
      <label for="t-borders">Borders</label>
      <select id="t-borders" data-field="borders">${[['all', 'Every line'], ['outer', 'Around the table'], ['rows', 'Between rows'], ['none', 'None']].map(([v, l]) => `<option value="${v}"${(at.block.borders ?? 'all') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label for="t-bg">Background of the selected cells</label>
      <input id="t-bg" type="color" data-field="bg" value="${cell.bg ?? '#ffffff'}" />
      <label for="t-align">Text in the selected cells</label>
      <select id="t-align" data-field="align">${[['', 'As the paragraph'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right']].map(([v, l]) => `<option value="${v}"${(cell.align ?? '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label for="t-widths">Column widths, in parts</label>
      <input id="t-widths" type="text" data-field="widths" value="${at.block.widths.join(' ')}" />
    </div>
    <div class="setting"><span class="label">No background</span><input type="checkbox" data-field="clear"${cell.bg ? '' : ' checked'} /></div>`, 'Apply');
  if (!confirmed) return;
  const f = readFields();
  const widths = f.widths.split(/[\s,;]+/).map(Number).filter((n) => n > 0);
  edit(() => {
    setCells(model, editor.selection, { bg: f.clear ? null : f.bg, align: f.align || null });
    return setTable(model, editor.selection, { borders: f.borders, ...(widths.length === at.cols ? { widths } : {}) });
  });
  backToText();
}

// Cells chosen together: WebKit cannot stretch a text selection across cells, so Shift+click marks a range of them.

let cellRange = null;

function paintCellRange() {
  for (const cell of surface.querySelectorAll('.cell-chosen')) cell.classList.remove('cell-chosen');
  if (!cellRange) return;
  const block = model.block(cellRange.blockId);
  if (!block) return;
  const cols = block.rows[0].cells.length;
  const [a, b] = [cellRange.from, cellRange.to].map((i) => ({ row: Math.floor(i / cols), col: i % cols }));
  for (const td of surface.querySelectorAll(`[data-block="${cellRange.blockId}"][data-item]`)) {
    const i = Number(td.dataset.item);
    const row = Math.floor(i / cols);
    const col = i % cols;
    if (row >= Math.min(a.row, b.row) && row <= Math.max(a.row, b.row) && col >= Math.min(a.col, b.col) && col <= Math.max(a.col, b.col)) td.classList.add('cell-chosen');
  }
}

surface.addEventListener('mousedown', (event) => {
  const cell = event.target.closest?.('td[data-item], th[data-item]');
  const anchor = editor.selection?.anchor;
  if (event.shiftKey && cell && anchor && anchor.blockId === cell.dataset.block && anchor.itemIndex !== null && anchor.itemIndex !== undefined) {
    event.preventDefault();
    cellRange = { blockId: cell.dataset.block, from: anchor.itemIndex, to: Number(cell.dataset.item) };
    editor.selection = { anchor: point(cellRange.blockId, 0, cellRange.from), focus: point(cellRange.blockId, 0, cellRange.to) };
    paintCellRange();
    return;
  }
  cellRange = null;
  paintCellRange();
  dragFrom = cell ? { blockId: cell.dataset.block, item: Number(cell.dataset.item) } : null;
}, true);

// Dragging from one cell into another chooses the cells between, as in LibreOffice.
let dragFrom = null;
surface.addEventListener('mousemove', (event) => {
  if (!dragFrom || !(event.buttons & 1)) return;
  const cell = event.target.closest?.('td[data-item], th[data-item]');
  if (!cell || cell.dataset.block !== dragFrom.blockId) return;
  const to = Number(cell.dataset.item);
  if (to === dragFrom.item && !cellRange) return;
  event.preventDefault();
  getSelection().collapseToStart?.();
  cellRange = { blockId: dragFrom.blockId, from: dragFrom.item, to };
  editor.selection = { anchor: point(cellRange.blockId, 0, cellRange.from), focus: point(cellRange.blockId, 0, cellRange.to) };
  paintCellRange();
});
document.addEventListener('mouseup', () => { dragFrom = null; });

/** Bold, italic and the other marks taken off the selected text, which keeps its styles. */
function clearDirect() {
  readSelection();
  edit(() => {
    for (const mark of MARKS) applyFormat(model, editor.selection, mark, false);
    for (const id of blocksInRange(model, editor.selection)) model.setPara(id, { lineHeight: null, spaceBefore: null, spaceAfter: null, indent: null });
    return editor.selection;
  });
}

/** The marks where the cursor is, given to the text chosen next with the mouse. */
function cloneFormatting() {
  readSelection();
  const marks = Object.fromEntries(MARKS.map((mark) => [mark, editor.markIsOn(mark)]));
  toast('Choose the text to give these marks');
  const apply = () => {
    surface.removeEventListener('mouseup', apply);
    setTimeout(() => {
      readSelection();
      edit(() => {
        for (const [mark, on] of Object.entries(marks)) applyFormat(model, editor.selection, mark, on);
        return editor.selection;
      });
    }, 0);
  };
  setTimeout(() => surface.addEventListener('mouseup', apply), 0);
}

// The properties sidebar: the paragraph and the text where the cursor is, changed without a dialog.

properties = createProperties(el('properties'), () => {
  const block = editor.selection ? model.block(editor.selection.anchor.blockId) : null;
  if (!block) return [];
  const styles = paragraphStyles(model).map((st) => [st.key, st.label]);
  return [
    { title: 'Paragraph', fields: [
      { label: 'Style', kind: 'select', value: block.style ?? 'body', options: styles, apply: (v) => applyStyle(v) },
      { label: 'Alignment', kind: 'buttons', value: block.align ?? 'left', options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['justify', 'Justify']], apply: (v) => applyAlign(v) },
    ] },
    { title: 'Spacing', fields: [
      { label: 'Line spacing', kind: 'buttons', value: String(Math.round((withPara(model.styles[block.style] ?? {}, block.para).lineHeight ?? 1.5) / SINGLE * 100) / 100),
        options: [['1', '1'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', '2']], apply: (v) => paraCommands.lineSpacing(Number(v)) },
      ...[['spaceBefore', 'Above, pt'], ['spaceAfter', 'Below, pt'], ['indent', 'Indent, pt']].map(([field, label]) => ({
        label, kind: 'number', row: 'spacing', min: 0, max: field === 'indent' ? 400 : 200, step: 1,
        value: Math.round((withPara(model.styles[block.style] ?? {}, block.para)[field] ?? 0) * 10) / 10,
        apply: (v) => applyPara(() => ({ [field]: v })),
      })),
    ] },
    { title: 'Text', fields: ['bold', 'italic', 'underline', 'strike'].map((mark) => ({
      label: { bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough' }[mark], kind: 'checkbox', row: 'marks',
      value: editor.markIsOn(mark), apply: () => handlers.toggleMark(mark),
    })) },
  ];
});

/** The styles of another document or template, read without opening it. */
async function stylesOf(path) {
  const format = baseFormat(formatOf(path));
  if (format === 'grt') {
    const { parts } = await readDocument(path, null);
    return JSON.parse(parts['content/main.json'] ?? '{}');
  }
  if (format === 'fodt') return readOdt(await readText(path)).document;
  if (format !== 'odt' && format !== 'docx') throw new Error(`Styles are read from documents and templates, not .${format} files`);
  const opened = await withPassword(baseName(path), (password) => readPackage(path, { password }));
  if (!opened) return null;
  return (format === 'odt' ? readOdt(opened.value) : readDocx(opened.value)).document;
}

/** Takes the paragraph and character styles of another document or template, as LibreOffice's Load Styles does. */
async function loadStyles() {
  const path = await pickToOpen([{ name: 'Documents and templates', extensions: ['grt', 'odt', 'fodt', 'ott', 'docx', 'dotx', 'dotm'] }], 'Load styles from');
  if (!path) return;
  let source;
  try {
    source = await stylesOf(path);
  } catch (error) {
    toast(`Cannot read the styles: ${error.message ?? error}`, true);
    return;
  }
  if (!source) return;
  const confirmed = await showPanel('Load styles', `
    <p>From <strong>${escapeHtml(baseName(path))}</strong>:</p>
    <label class="inline"><input type="checkbox" data-field="paragraph" checked> Paragraph styles</label>
    <label class="inline"><input type="checkbox" data-field="character" checked> Character styles</label>
    <label class="inline"><input type="checkbox" data-field="overwrite" checked> Replace styles of the same name</label>`, 'Load');
  if (!confirmed) return;
  const { paragraph, character, overwrite } = readFields();
  let count = 0;
  edit(() => {
    const take = (from, into) => {
      for (const [key, style] of Object.entries(from ?? {}).slice(0, 500)) {
        if (!overwrite && into[key]) continue;
        into[key] = normaliseStyle({ ...(into[key] ?? {}), ...style });
        count += 1;
      }
    };
    if (paragraph) take(source.styles, model.styles);
    if (character) {
      model.charStyles ??= {};
      take(source.charStyles, model.charStyles);
    }
    model.dirty = true;
    return editor.selection;
  });
  measurer.invalidate();
  toast(`${count} style(s) loaded`);
}

/** The formula at the cursor written on its own, as LibreOffice Math's .odf or as MathML. */
async function exportFormula() {
  readSelection();
  const at = editor.selection?.focus;
  const runs = at ? model.runsOf(at.blockId, at.itemIndex) : [];
  let offset = 0;
  let object = null;
  for (const run of runs) {
    if (run.object?.type === 'math' && (offset === at.offset || offset + 1 === at.offset)) object = run.object;
    offset += run.text.length;
  }
  if (!object) {
    toast('Put the cursor beside a formula first');
    return;
  }
  const path = await pickToSave('formula.odf', [{ name: 'LibreOffice Math formula', extensions: ['odf'] }, { name: 'MathML', extensions: ['mml'] }], 'Export formula');
  if (!path) return;
  if (/\.mml$/i.test(path)) await writeText(path, `<?xml version="1.0" encoding="UTF-8"?>\n${mathmlWithTex(object)}\n`);
  else await writePackage(withExtension(path, 'odf'), formulaPackage(object));
  toast(`Exported ${baseName(path)}`);
}

/** Cells chosen by a menu: the one the cursor is in, its row, its column or the whole table. */
function chooseCells(name) {
  readSelection();
  const at = tableAt(model, editor.selection);
  if (!at) return null;
  const last = at.block.rows.length - 1;
  const [r0, c0, r1, c1] = { selectCell: [at.row, at.col, at.row, at.col], selectRow: [at.row, 0, at.row, at.cols - 1], selectColumn: [0, at.col, last, at.col], selectTable: [0, 0, last, at.cols - 1] }[name];
  cellRange = { blockId: at.block.id, from: r0 * at.cols + c0, to: r1 * at.cols + c1 };
  editor.selection = { anchor: point(at.block.id, 0, cellRange.from), focus: point(at.block.id, 0, cellRange.to) };
  paintCellRange();
  return null;
}

async function sortTableRows() {
  readSelection();
  const at = tableAt(model, editor.selection);
  if (!at) return;
  const header = at.block.rows[0];
  const names = header.cells.map((cell, i) => (header.header ? (cell.runs ?? []).map((r) => r.text).join('') : '') || `Column ${i + 1}`);
  const confirmed = await showPanel('Sort rows', `
    <label>By<select data-field="column">${names.map((n, i) => `<option value="${i}"${i === at.col ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></label>
    <label class="inline"><input type="checkbox" data-field="descending"> Highest first</label>
    <p class="hint">Heading rows stay at the top. Numbers are sorted as numbers.</p>`, 'Sort');
  if (!confirmed) return;
  const f = readFields();
  edit(() => sortRows(model, editor.selection, { column: Number(f.column), descending: f.descending }));
  measurer.invalidate();
}

async function askColumnWidth() {
  readSelection();
  const at = tableAt(model, editor.selection);
  if (!at) return;
  const total = at.block.widths.reduce((a, b) => a + b, 0);
  const share = Math.round((at.block.widths[at.col] / total) * 100);
  const confirmed = await showPanel('Column width', `<label>Share of the table's width, in per cent<input type="number" data-field="share" min="2" max="98" value="${share}"></label>`, 'Apply');
  if (!confirmed) return;
  const wanted = Number(readFields().share) / 100;
  if (!(wanted > 0 && wanted < 1)) return;
  // The others keep their proportions in what is left.
  const rest = total - at.block.widths[at.col];
  edit(() => setColumnWidth(model, editor.selection, (wanted * rest) / (1 - wanted)));
  measurer.invalidate();
}

/** The selected paragraphs, or the text to its next table, made into a table, cells cut at the separator chosen. */
async function convertTextToTable() {
  readSelection();
  const blocks = blocksInRange(model, editor.selection).map((id) => model.block(id)).filter((b) => b && (b.kind === 'paragraph' || b.kind === 'heading'));
  if (!blocks.length) return;
  const confirmed = await showPanel('Text to table', `
    <label>Cells are cut at<select data-field="separator"><option value="tab">Tabs</option><option value=";">Semicolons</option><option value=",">Commas</option></select></label>
    <p class="hint">${blocks.length} paragraph(s) become as many rows.</p>`, 'Convert');
  if (!confirmed) return;
  const value = readFields().separator;
  edit(() => textToTable(model, blocks, value === 'tab' ? '\t' : value) ?? editor.selection);
  measurer.invalidate();
}

/** Fields that show a page, a date or a time become the text they show now. */
function fieldsToText() {
  readSelection();
  const ids = new Set(blocksInRange(model, editor.selection));
  edit(() => {
    for (const block of model.blocks) {
      if (!ids.has(block.id)) continue;
      const shown = [...(surface.querySelector(`[data-block="${block.id}"]`)?.querySelectorAll('[class^="field-"]') ?? [])].map((e) => e.textContent);
      for (const { runs } of runListsOf(block)) {
        for (const run of runs) {
          if (run.object?.type !== 'field') continue;
          const field = run.object.field;
          const text = field === 'date' ? new Date().toISOString().slice(0, 10) : field === 'time' ? new Date().toTimeString().slice(0, 5) : shown.shift() ?? '';
          delete run.object;
          run.text = text;
        }
      }
    }
    model.dirty = true;
    return editor.selection;
  });
}

/** The selected paragraphs in alphabetical order. */
async function sortParagraphs() {
  readSelection();
  const ids = blocksInRange(model, editor.selection);
  const blocks = ids.map((id) => model.block(id)).filter((b) => b?.kind === 'paragraph');
  if (blocks.length < 2) return;
  const confirmed = await showPanel('Sort paragraphs', '<label class="inline"><input type="checkbox" data-field="descending"> From Z to A</label>', 'Sort');
  if (!confirmed) return;
  const descending = readFields().descending;
  edit(() => {
    const text = (b) => (b.runs ?? []).map((r) => r.text).join('');
    const sorted = [...blocks].sort((a, b) => text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' }) * (descending ? -1 : 1));
    const positions = blocks.map((b) => model.indexOf(b.id)).sort((a, b) => a - b);
    positions.forEach((at, i) => { model.blocks[at] = sorted[i]; });
    model.dirty = true;
    return editor.selection;
  });
}

function tableCommand(name) {
  // A range of cells chosen with Shift+click stands, the text selection inside one cell does not.
  if (cellRange) editor.selection = { anchor: point(cellRange.blockId, 0, cellRange.from), focus: point(cellRange.blockId, 0, cellRange.to) };
  else readSelection();
  cellRange = null;
  paintCellRange();
  const run = {
    rowAbove: () => insertRow(model, editor.selection, false),
    rowBelow: () => insertRow(model, editor.selection, true),
    colBefore: () => insertColumn(model, editor.selection, false),
    colAfter: () => insertColumn(model, editor.selection, true),
    deleteRows: () => deleteRows(model, editor.selection),
    deleteColumns: () => deleteColumns(model, editor.selection),
    deleteTable: () => deleteTable(model, editor.selection),
    merge: () => mergeCells(model, editor.selection),
    split: () => splitCell(model, editor.selection),
    splitTable: () => splitTable(model, editor.selection),
    mergeTables: () => mergeTables(model, editor.selection),
    widthsEven: () => setColumnWidths(model, editor.selection, 'even'),
    widthsOptimal: () => setColumnWidths(model, editor.selection, 'optimal'),
    widthsMinimal: () => setColumnWidths(model, editor.selection, 'minimal'),
    toText: () => tableToText(model, editor.selection, '\t'),
    header: () => {
      const at = tableAt(model, editor.selection);
      return setHeaderRows(model, editor.selection, !at?.block.rows[at.top]?.header);
    },
  }[name];
  if (name === 'properties') return guard('Table', tableProperties);
  if (['selectCell', 'selectRow', 'selectColumn', 'selectTable'].includes(name)) return chooseCells(name);
  if (name === 'sort') return guard('Sort', sortTableRows);
  if (name === 'columnWidth') return guard('Table', askColumnWidth);
  if (run && tableAt(model, editor.selection)) edit(run);
  measurer.invalidate();
  return null;
}

/** Text from here on in columns, until the next mark; one column goes back to the page's width. */
async function insertColumns() {
  const confirmed = await showPanel('Columns', `
    <div class="form-grid">
      <label for="c-n">Columns from here on</label>
      <select id="c-n" data-field="columns"><option value="1">One</option><option value="2" selected>Two</option><option value="3">Three</option><option value="4">Four</option></select>
      <label for="c-gap">Space between, mm</label><input id="c-gap" type="number" min="0" max="30" value="6" data-field="gap" />
    </div>`, 'Insert');
  if (!confirmed) return;
  const f = readFields();
  readSelection();
  edit(() => insertBlockAt(model, editor.selection, makeBlock('section', { columns: Number(f.columns), gap: Number(f.gap) || 6 })));
  measurer.invalidate();
  backToText();
}

// Menus and the command palette

function wordCount() {
  const c = model.counts();
  showPanel('Count', `
    <table class="fp-table"><tbody>
      <tr><th>Words</th><td>${c.words}</td></tr>
      <tr><th>Characters</th><td>${c.characters}</td></tr>
      <tr><th>Characters without spaces</th><td>${c.charactersNoSpaces}</td></tr>
      <tr><th>Paragraphs</th><td>${c.blocks}</td></tr>
      <tr><th>Pages</th><td>${pageCount}</td></tr>
    </tbody></table>`);
}

const long = longDocument({
  model: () => model, editor, edit, showPanel, readFields, toast,
  done: () => {
    measurer.invalidate();
    backToText();
  },
});

const charts = paperCharts({
  model: () => model, editor, edit, showPanel, showChoice, readFields, toast, pickToOpen, readText, baseName,
  done: () => {
    measurer.invalidate();
    backToText();
  },
});

const styleTools = paperStyles({
  model: () => model, editor, edit, showPanel, showChoice, readFields, applyStyle,
  done: () => {
    measurer.invalidate();
    backToText();
  },
});

// Formulas drawn as their source before the engine loaded are drawn again once it has.
whenMathReady(() => {
  editor.draw();
  measurer.invalidate();
});

const menus = paperMenus({
  inTable,
  actions: {
    newFile: () => el('btn-new').click(),
    open: () => el('btn-open').click(),
    save: () => guard('Save', () => save(false)),
    saveAs: () => guard('Save', () => save(true)),
    exportDocument: () => guard('Export', exportDocument),
    exportPdf: () => guard('Export', exportDirectPdf),
    print: () => guard('Print', printDocument),
    pageSetup: () => guard('Page', pageSetup),
    settings: () => guard('Settings', openSettings),
    undo: () => step(-1),
    redo: () => step(1),
    find: () => guard('Find', findReplace),
    outline: () => toggleOutline(),
    wordCount,
    insertImage: () => insertImage(),
    insertTable: () => guard('Table', insertTable),
    pageBreak: () => insertPageBreak(),
    mark: (mark) => handlers.toggleMark(mark),
    align: (align) => applyAlign(align),
    list: (type) => applyList(type),
    style: (style) => applyStyle(style),
    styles: [['body', 'Body text'], ['title', 'Title'], ['subtitle', 'Subtitle'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['quote', 'Quotations'], ['code', 'Preformatted text'], ['hr', 'Horizontal line']],
    table: tableCommand,
    columns: () => guard('Columns', insertColumns),
    long,
    textToTable: () => guard('Table', convertTextToTable),
    clearDirect: () => clearDirect(),
    loadStyles: () => guard('Load styles', loadStyles),
    para: paraCommands,
    saveCopy: () => guard('Save', () => saveCopy()),
    saveTemplate: () => guard('Save', () => saveCopy('ott')),
    templates: () => templateManager({ extensions: ['ott', 'dotx', 'dotm'], open: openConfirmed, toast }),
    reload: () => { if (model.path) guard('Reload', () => openConfirmed(model.path)); else toast('This document has not been saved yet'); },
    cloneFormatting: () => cloneFormatting(),
    toggleSidebar: () => { el('properties').classList.toggle('hidden'); properties.refresh(); },
    updateAll: () => { measurer.invalidate(); editor.draw(); repaginate.schedule(); repaginate.flush(); toast('Fields, contents and indexes brought up to date'); },
    fieldsToText,
    sortParagraphs: () => guard('Sort', sortParagraphs),
    exportFormula: () => guard('Export', exportFormula),
    about: async () => aboutDialog({ name: 'GRT Paper', version: (await runtimeInfo()).version }),
    licences: () => licencesDialog({ name: 'GRT Paper' }),
    charts,
    styleTools,
    palette: () => openPalette(commands()),
  },
});
createMenubar(el('menubar'), menus);

function commands() {
  return paletteEntries(menus).filter((entry) => entry.enabled());
}

// Events

new InputCapture(surface, handlers);

document.addEventListener('selectionchange', () => {
  if (document.activeElement === surface) {
    readSelection();
    refresh();
  }
});

// Toolbar buttons leave the caret in the text.
// A note's number opens its text; a line of the contents or the index, and a link with Ctrl, go where they point.
surface.addEventListener('click', (event) => {
  const formula = event.target.closest('[data-math]');
  if (formula) {
    event.preventDefault();
    long.editFormula(formula);
    return;
  }
  const note = event.target.closest('[data-note]');
  if (note) {
    event.preventDefault();
    long.editNote(note);
    return;
  }
  const line = event.target.closest('.generated-line');
  if (line) {
    event.preventDefault();
    followLink(surface, line);
    return;
  }
  const link = event.target.closest('.text-link');
  if (link && (event.ctrlKey || event.metaKey)) followLink(surface, link);
});

// A chart opens its dialog when double-clicked.
surface.addEventListener('dblclick', (event) => {
  const figure = event.target.closest('.block.chart');
  const block = figure ? model.block(figure.dataset.block) : null;
  if (block) guard('Chart', () => charts.chartDialog(block));
});

document.querySelector('.toolbar').addEventListener('mousedown', (event) => {
  if (event.target.closest('button')) event.preventDefault();
});
el('btn-new').onclick = () => guard('New', newDocumentConfirmed);
el('btn-open').onclick = () => guard('Open', async () => {
  const path = await pickToOpen(FILTERS.documents, 'Open document');
  if (path) await openConfirmed(path);
});
el('btn-save').onclick = () => guard('Save', () => save(false));
el('btn-save-as').onclick = () => guard('Save', () => save(true));
el('btn-export').onclick = () => guard('Export', exportDocument);
el('btn-pdf').onclick = () => guard('Export', exportDirectPdf);
el('btn-print').onclick = () => guard('Print', printDocument);
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
  if (isDialogOpen() || isPaletteOpen() || isPrintPreviewOpen()) return;

  if (event.key === 'F11') {
    event.preventDefault();
    guard('Styles', () => styleTools.stylesDialog());
    return;
  }
  const ctrl = event.ctrlKey || event.metaKey;
  // Ctrl with Alt is a different shortcut, such as Ctrl+Alt+F for a footnote, answered by the menu.
  if (!ctrl || event.altKey) return;

  const key = event.key.toLowerCase();
  // Ctrl+1 to Ctrl+3 make headings and Ctrl+0 body text, as in LibreOffice and Word.
  if (!event.shiftKey && !event.altKey && /^[0-3]$/.test(event.key)) {
    event.preventDefault();
    applyStyle(event.key === '0' ? 'body' : `h${event.key}`);
    return;
  }
  if (key === 'k') {
    event.preventDefault();
    openPalette(commands());
  } else if (key === 's') {
    event.preventDefault();
    guard('Save', () => save(event.shiftKey));
  } else if (key === 'o') {
    event.preventDefault();
    el('btn-open').click();
  } else if (key === 'n' && !event.shiftKey) {
    event.preventDefault();
    el('btn-new').click();
  } else if (key === 'f') {
    event.preventDefault();
    guard('Find', findReplace);
  } else if (key === 'p') {
    event.preventDefault();
    guard('Print', printDocument);
  } else if (event.key === ',') {
    event.preventDefault();
    guard('Settings', openSettings);
  }
});

onFilesDropped((paths) => guard('Open', async () => {
  const found = paths.find((p) => OPENABLE.test(p));
  if (found) await openConfirmed(found);
}));

// Startup

(async function start() {
  const info = await runtimeInfo();
  await loadSettings(info.ephemeral);
  if (info.ephemeral) el('ephemeral-note').classList.remove('hidden');

  applyPageToSheet();
  // Point the controller at the document before anything is drawn.
  editor.attach(model);
  keeper.watch(model);
  drawOutline();
  surface.focus();

  const initial = info.initialFile && OPENABLE.test(info.initialFile) && await fileExists(info.initialFile)
    ? info.initialFile : null;
  const recovered = await keeper.start({
    ephemeral: info.ephemeral, mode: settings.autosave, initialFile: initial,
  });
  if (initial && !recovered) {
    await guard('Open', () => openPath(initial));
  }
}());
