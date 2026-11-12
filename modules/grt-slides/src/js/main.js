/** Application wiring. */

import { inspect } from './core/inspector.js';
import { slideFindings, cleanSlidesCopy } from './inspect.js';
import { autoRedactSlides, redactedPresentation, toggleCells, redactedCount } from './redact.js';
import { SENSITIVE_KINDS } from './core/sensitive.js';
import { searchPattern } from './core/find.js';
import { SlidesModel, FONTS, PRESETS, TRANSITIONS, ALIGNMENTS, LAYOUTS as SLIDE_LAYOUTS } from './model.js';
import { createProperties } from './core/properties.js';
import { Renderer } from './render.js';
import { Interaction } from './interaction.js';
import { Thumbnails } from './thumbnails.js';
import { Presentation } from './present.js';
import { editMarkup, readEdit, parasFor } from './paragraphs.js';
import { textTools } from './text-tools.js';
import { tableTools } from './table-tools.js';
import { mergeAt } from './tables.js';
import { findTools } from './find-tools.js';
import { commentTools } from './comment-tools.js';
import { showLink } from './core/honest-links.js';
import { textLook } from './export.js';
import { editInPlace } from './editing.js';
import { toHtml, slideToSvg, slideToPrintPage } from './export.js';
import { describeFont, fontMediaType } from './fonts.js';
import { UndoStack } from './core/undo.js';
import { showPanel, showChoice, readFields, isDialogOpen, escapeHtml } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { withPassword, passwordFields, wirePasswordFields, passwordFrom, canProtect, PROTECTION } from './core/protection.js';
import { readOdp, writeOdp } from './core/formats/odp.js';
import { readPptx } from './core/formats/pptx-read.js';
import { writePptx } from './core/formats/pptx-write.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { createMenubar, paletteEntries } from './core/menubar.js';
import { aboutDialog, licencesDialog } from './core/about.js';
import { templateManager } from './core/template-manager.js';
import { searchEverywhere } from './core/everywhere.js';
import { applyShortcuts, customizeDialog } from './core/customize.js';
import { wireToolbars } from './core/toolbar.js';
import { createStatusBar } from './core/statusbar.js';
import { NAMES as LANGUAGE_NAMES } from './core/language.js';
import { createSpellChecker } from './core/spelling.js';
import { spellingOverItems } from './core/spelling-items.js';
import { applyEdits } from './core/autocorrect.js';
import { slidesMenus } from './menus.js';
import { THEMES } from './core/theme.js';
import { Keeper, MODES } from './core/keeper.js';
import { renderToPdf, mergePdfPages } from './core/pdf.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { printablePages, LAYOUTS } from './printing.js';
import { loadSettings, updateSettings, settings, canPersist } from './settings.js';
import { stripMetadata, neutralName } from './core/image-metadata.js';
import {
  pickToOpen, pickToSave, readDocument, readResource, writeDocument, writeText,
  writeBytes, readFileBytes, readText, stagePart, clearStaged, fileExists,
  runtimeInfo, onFilesDropped, baseName, withExtension, toDataUrl, FILTERS,
} from './io.js';
import { isTemplate, baseFormat, asTemplate } from './core/formats/templates.js';
import { chartDialog, slideFormulaDialog, layoutDialog, mastersDialog } from './extras.js';
import { normaliseChartData } from './core/formats/chart-object.js';
import { whenMathReady } from './core/math.js';

const el = (id) => document.getElementById(id);

const stage = el('stage');
const surface = el('surface');
const renderer = new Renderer(stage, surface);
const interaction = new Interaction(surface, renderer);
const thumbs = new Thumbnails(el('thumbnails'));
const presentation = new Presentation(el('present-root'));

let model = new SlidesModel();
let undo = new UndoStack(model);
let currentSlideId = model.slides[0].id;
let busy = false;

/** Images by resource path, as data URLs. */
let images = new Map();
/** The same pictures as their own bytes, for embedding into a PDF. */
let imageBytes = new Map();

/** Formats a presentation can be saved back into. */
const WRITABLE = new Set(['grt', 'odp', 'fodp', 'pptx', 'otp', 'potx']);
const OPENABLE = /\.(grt|odp|fodp|pptx|otp|potx|potm)$/i;

function formatOf(path) {
  return (/\.([^.\\/]+)$/.exec(path ?? '')?.[1] ?? '').toLowerCase() || null;
}

/**
 * What the open file is: its format, what did not come across when it was
 * read, and whether saving over it anyway was agreed to.
 */
let file = { format: 'grt', losses: [], confirmed: false, password: null };

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
  canSaveInPlace: () => !!model.path && WRITABLE.has(file.format) && (file.losses.length === 0 || file.confirmed),
  writeCopy: (path) => writeDocument(path, documentParts(), file.password),
  save: (options) => save(false, options),
  openRecovered: (file, meta) => openRecovered(file, meta),
  // Leaving a text box or the notes commits what was typed in it.
  settle: () => document.activeElement?.blur?.(),
}, { program: 'GRT Slides', extension: 'grt', toast });

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

// Drawing

let commentsHidden = false;

function draw() {
  renderer.draw(model, currentSlideId, interaction.selection, { ...interaction.extras, hideComments: commentsHidden }, images);
  thumbs.draw(model, currentSlideId, images);
  el('notes').value = model.slide(currentSlideId)?.notes ?? '';
  tables.mark();
  refresh();
}

function refresh() {
  el('btn-undo').disabled = busy || !undo.canUndo;
  el('btn-redo').disabled = busy || !undo.canRedo;
  el('btn-delete-slide').disabled = model.slides.length <= 1;

  const selected = interaction.selection.size;
  for (const id of ['btn-delete', 'btn-front', 'btn-back']) {
    el(id).disabled = selected === 0;
  }

  toolbars?.refresh();
  statusbar?.refresh();
  properties?.refresh();
}

/** The toolbars and the status bar, made once the menus exist. */
let toolbars = null;
let statusbar = null;

// The properties sidebar

let properties = null;

/** What the sidebar shows: the slide when nothing is selected, otherwise the elements chosen. */
function describeSelection() {
  const slide = model.slide(currentSlideId);
  if (!slide) return [];
  const set = (mutate) => (value) => change(() => mutate(value));
  const elements = [...interaction.selection].map((id) => model.element(currentSlideId, id)).filter(Boolean);
  const ids = elements.map((e) => e.id);
  if (!elements.length) {
    return [{ title: editingMaster ? 'Master' : 'Slide', fields: [
      ...(editingMaster ? [] : [{ label: 'Layout', kind: 'buttons', value: slide.layout ?? '', options: [...Object.entries(SLIDE_LAYOUTS).map(([id, l]) => [id, l.label])], apply: set((v) => v && model.setLayout(currentSlideId, v)) }]),
      { label: 'Background', kind: 'color', value: model.slideBackground(currentSlideId) ?? '#ffffff', apply: set((v) => model.setSlideBackground(currentSlideId, v)) },
      ...(editingMaster ? [] : [{ label: 'Transition', kind: 'select', value: slide.transition ?? 'none', options: TRANSITIONS.map((t) => [t, t]), apply: set((v) => model.setTransition(currentSlideId, v)) }]),
    ] }];
  }
  const first = elements[0];
  const texty = elements.some((e) => ['text', 'table'].includes(e.kind));
  const fields = [];
  if (elements.length === 1) {
    const number = (label, key, row) => ({ label, kind: 'number', value: Math.round(first[key]), row, apply: set((v) => { if (Number.isFinite(v)) model.setBounds(currentSlideId, first.id, { ...first, [key]: v }); }) });
    fields.push(number('X', 'x', 'xy'), number('Y', 'y', 'xy'), number('Width', 'w', 'wh'), number('Height', 'h', 'wh'));
    fields.push({ label: 'Rotation', kind: 'number', value: Math.round(first.rotation ?? 0), step: 1, apply: set((v) => model.setRotation(currentSlideId, ids, v ?? 0)) });
  }
  fields.push({ label: 'Fill', kind: 'color', value: first.fill ?? '#ffffff', row: 'colours', apply: set((v) => model.setElementColour(currentSlideId, ids, { fill: v })) });
  fields.push({ label: 'Colour', kind: 'color', value: first.color ?? '#000000', row: 'colours', apply: set((v) => model.setElementColour(currentSlideId, ids, { colour: v })) });
  if (texty) {
    fields.push({ label: 'Text size', kind: 'number', value: first.size ?? '', min: 6, max: 400, row: 'text', apply: set((v) => model.setElementText(currentSlideId, ids, { size: v ?? 0 })) });
    fields.push({ label: 'Align', kind: 'select', value: first.align ?? 'left', options: ALIGNMENTS.map((a) => [a, a]), row: 'text', apply: set((v) => model.setElementText(currentSlideId, ids, { align: v })) });
  }
  return [{ title: elements.length === 1 ? first.kind : `${elements.length} elements`, fields }];
}

interaction.onChange = () => draw();
// Formulas shown as their TeX before the engine loaded are drawn again once it has.
whenMathReady(() => draw());
el('btn-master-done').onclick = () => doneEditingMaster();
interaction.onSelectionChange = () => refresh();
interaction.onCommit = (before) => {
  undo.past.push(before);
  if (undo.past.length > undo.limit) undo.past.shift();
  undo.future.length = 0;
  refresh();
};
interaction.onEditText = (id, cell) => {
  const element = model.element(currentSlideId, id);
  if (element?.kind === 'chart' || element?.kind === 'formula') {
    editObject(element);
    return;
  }
  if (element?.kind === 'table' && cell) editCell(id, cell.row, cell.col);
  else editText(id);
};

thumbs.onSelect = (id) => selectSlide(id);
thumbs.onReorder = (from, to) => change(() => model.moveSlide(from, to));

function selectSlide(id) {
  currentSlideId = id;
  interaction.attach(model, id);
  renderer.fit(model);
  draw();
  broadcastIndex();
}

/** A change as one step to undo; a change that says false made none, and leaves no step. */
function change(mutate) {
  const before = model.snapshot();
  if (mutate() === false) {
    model.restore(before);
    return;
  }
  interaction.onCommit(before);
  draw();
}

// Text editing

const NEW_TEXT = 'New text';

/** Edits a text box in place. */
function editText(id) {
  const element = model.element(currentSlideId, id);
  if (!element || element.kind !== 'text') return;

  const node = surface.querySelector(`[data-id="${id}"]`);
  if (!node) return;

  const before = model.snapshot();

  const finish = editInPlace(node, {
    className: 'editing',
    selectAll: true,
    // A box nobody has typed in yet is replaced by what is typed.
    replace: element.content.map((run) => run.text).join('') === NEW_TEXT,
    seed: () => { node.innerHTML = editMarkup(element); },
    read: () => readEdit(node),
    changed: (value) => JSON.stringify(value.content) !== JSON.stringify(element.content)
      || JSON.stringify(value.paras) !== JSON.stringify(parasFor(element)),
    commit: (value) => {
      model.setContent(currentSlideId, id, value.content, value.paras);
      interaction.onCommit(before);
    },
    after: () => { activeEdit = null; draw(); },
    keys: (event, finish) => {
      // Enter belongs to the paragraph being typed, so committing needs the
      // modifier; a text box is the one place in the program where a plain
      // Enter has to mean a new line.
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
        return true;
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && 'biu'.includes(event.key.toLowerCase())) {
        event.preventDefault();
        text.mark({ b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()]);
        return true;
      }
      // The shortcuts of the Format menu work inside the box too; the others wait until the edit is done.
      return menubar.shortcut(event, (item) => formatItems.has(item));
    },
  });
  activeEdit = { node, id, finish };
}

/** The text box being edited, if one is. */
let activeEdit = null;

// The buttons follow the caret in the box being edited, and the keys that format it.
for (const kind of ['selectionchange', 'keyup']) document.addEventListener(kind, () => { if (activeEdit) toolbars?.refresh(); });

const text = textTools({
  model: () => model,
  slideId: () => currentSlideId,
  editing: () => activeEdit,
  chosen: () => [...interaction.selection].map((id) => model.element(currentSlideId, id)).filter(Boolean),
  change: (mutate) => change(mutate),
  toast: (message) => toast(message),
  baseSize: (element) => textLook(element, model).size,
});

const tables = tableTools({
  model: () => model,
  slideId: () => currentSlideId,
  chosen: () => [...interaction.selection].map((id) => model.element(currentSlideId, id)).filter(Boolean),
  change: (mutate) => change(mutate),
  toast: (message) => toast(message),
  surface,
  select: (ids) => { interaction.selection = new Set(ids); draw(); },
  size: (element) => textLook(element, model).size,
});
/** Spelling with GRT's own dictionaries. */
const spellChecker = createSpellChecker();

const finder = findTools({
  model: () => model,
  slideId: () => currentSlideId,
  goTo: (id) => selectSlide(id),
  select: (ids) => { interaction.selection = new Set(ids); draw(); },
  surface,
  change: (mutate) => change(mutate),
  toast: (message) => toast(message),
  chooseCell: (id, row, col) => tables.choose(id, row, col),
});

const notesOnSlides = commentTools({
  model: () => model,
  slideId: () => currentSlideId,
  chosen: () => [...interaction.selection].map((id) => model.element(currentSlideId, id)).filter(Boolean),
  change: (mutate) => change(mutate),
  file: () => ({
    name: model.path ? baseName(model.path) : 'Untitled',
    location: model.path ? model.path.replace(/[/\\][^/\\]*$/, '') : 'Not saved yet',
    format: file.format,
  }),
});

// A comment's mark opens it, before the press can select or move anything.
surface.addEventListener('mousedown', (event) => {
  const mark = event.target.closest?.('.comment-mark');
  if (!mark) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  guard('Comment', () => notesOnSlides.open(mark.dataset.comment));
}, true);

/** Tools, Redact: selected text in a box being edited, or the chosen cells of a table, are marked to be covered. */
function redactChosen() {
  if (activeEdit) return text.mark('redact');
  const table = [...interaction.selection].map((id) => model.element(currentSlideId, id)).find((e) => e?.kind === 'table');
  if (table && tables.cells?.id === table.id) {
    const { anchor, focus } = tables.cells;
    const area = { top: Math.min(anchor.row, focus.row), bottom: Math.max(anchor.row, focus.row), left: Math.min(anchor.col, focus.col), right: Math.max(anchor.col, focus.col) };
    change(() => model.changeTable(currentSlideId, table.id, (live) => toggleCells(live, area)));
    return;
  }
  toast('Select text in a box, or cells of a table, to cover');
}

async function autoRedactDialog() {
  const checks = Object.entries(SENSITIVE_KINDS).map(([key, label]) => `<div class="setting"><span class="label">${escapeHtml(label)}</span><input type="checkbox" data-field="k-${key}" checked /></div>`).join('');
  const confirmed = await showPanel('Auto-Redact', `${checks}
    <div class="form-grid"><label for="ar-words">Words of your own, one a line</label><textarea id="ar-words" data-field="words" rows="3"></textarea></div>
    <p class="fp-note">The finder runs here, on this computer, over every slide. Speaker notes never go into the redacted copy.</p>`, 'Mark');
  if (!confirmed) return;
  const f = readFields();
  const kinds = Object.keys(SENSITIVE_KINDS).filter((key) => f[`k-${key}`]);
  const words = String(f.words ?? '').split('\n').map((w) => w.trim()).filter(Boolean).slice(0, 200);
  const extra = words.length ? [searchPattern(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), { regex: true })] : [];
  let count = 0;
  change(() => {
    count = autoRedactSlides(model, kinds, extra);
    return count > 0;
  });
  toast(count ? `${count} stretch(es) or cell(s) marked; File, Redacted Export makes the copy to share` : 'Nothing found to cover');
}

/** File, Inspect Document: what the presentation carries, and a clean copy without what is ticked. */
async function inspectPresentation() {
  if (activeEdit) activeEdit.finish(true);
  const out = await inspect(slideFindings(model), { toast });
  if (!out) return;
  const confirmed = await showPanel('Clean copy', `
    <div class="form-grid"><label for="ic-format">Format</label>
    <select id="ic-format" data-field="format"><option value="odp">OpenDocument presentation (.odp)</option><option value="pptx">PowerPoint (.pptx)</option><option value="pdf">PDF</option></select></div>`, 'Choose file');
  if (!confirmed) return;
  const { format } = readFields();
  const base = model.path ? model.path.replace(/(\.[^./\\]+)?$/, '-clean') : 'presentation-clean';
  const path = await pickToSave(withExtension(base, format), FILTERS[format], 'Write the clean copy to');
  if (!path) return;
  const copy = cleanSlidesCopy(model, out);
  if (format === 'pdf') {
    const shared = new SlidesModel(copy);
    const pages = await Promise.all(shared.slides.map((slide) => renderToPdf(slideToPrintPage(shared, slide.id, imageBytes), { audit: false, report: { replaced: 0 } })));
    await writeBytes(path, await mergePdfPages(pages));
  } else {
    const { entries } = format === 'odp' ? writeOdp(copy, imageBytes) : writePptx(copy, imageBytes);
    await writePackage(path, entries, {});
  }
  toast(`Wrote the clean copy as ${baseName(path)}`);
}

async function redactedExport() {
  const count = redactedCount(model);
  if (count === 0) return toast('Nothing is marked to be covered: use Tools, Redact or Auto-Redact first');
  const confirmed = await showPanel('Redacted export', `
    <div class="form-grid"><label for="rx-format">Format</label>
    <select id="rx-format" data-field="format"><option value="pdf">PDF</option><option value="odp">OpenDocument presentation (.odp)</option><option value="pptx">PowerPoint (.pptx)</option></select></div>
    <p class="fp-note">Covered text and cells become black blocks of the same length every time. Speaker notes and comments are left out of the copy. This presentation is not changed.</p>`, 'Choose file');
  if (!confirmed) return;
  const { format } = readFields();
  const base = model.path ? model.path.replace(/(\.[^./\\]+)?$/, '-redacted') : 'presentation-redacted';
  const path = await pickToSave(withExtension(base, format), FILTERS[format], 'Export the redacted copy to');
  if (!path) return;
  const copy = redactedPresentation(model.toJSON());
  if (format === 'pdf') {
    const shared = new SlidesModel(copy);
    const pages = await Promise.all(shared.slides.map((slide) => renderToPdf(slideToPrintPage(shared, slide.id, imageBytes), { audit: false, report: { replaced: 0 } })));
    await writeBytes(path, await mergePdfPages(pages));
  } else {
    const { entries } = format === 'odp' ? writeOdp(copy, imageBytes) : writePptx(copy, imageBytes);
    await writePackage(path, entries, {});
  }
  toast(`Exported the redacted copy as ${baseName(path)}`);
}

// Ctrl and a click on a link shows where it goes; nothing on a slide is followed by itself.
surface.addEventListener('click', (event) => {
  const link = event.target.closest?.('.text-link');
  if (!link || !(event.ctrlKey || event.metaKey) || event.target.closest('.editing')) return;
  event.preventDefault();
  showLink(link.dataset.href ?? '', link.textContent, { toast });
});

// After the selection has taken the table, a press on one of its cells chooses that cell.
surface.addEventListener('mousedown', (event) => setTimeout(() => tables.press(event), 0));

// Editing commands

function addSlide() {
  change(() => {
    const index = model.slides.findIndex((s) => s.id === currentSlideId);
    const slide = model.addSlide(index + 1, model.slides.length > 0 ? 'titleContent' : 'title');
    currentSlideId = slide.id;
    interaction.attach(model, slide.id);
  });
}

function duplicateSlide() {
  change(() => {
    const copy = model.duplicateSlide(currentSlideId);
    if (copy) {
      currentSlideId = copy.id;
      interaction.attach(model, copy.id);
    }
  });
}

function deleteSlide() {
  const index = model.slides.findIndex((s) => s.id === currentSlideId);
  change(() => {
    model.deleteSlide(currentSlideId);
    const next = model.slides[Math.min(index, model.slides.length - 1)];
    currentSlideId = next.id;
    interaction.attach(model, next.id);
  });
}

function addText() {
  change(() => {
    const created = model.addElement(currentSlideId, {
      kind: 'text', x: 200, y: 200, w: 900, h: 200, content: [{ text: NEW_TEXT }],
    });
    interaction.selection = new Set([created.id]);
  });
}

function addShape() {
  change(() => {
    const created = model.addElement(currentSlideId, {
      kind: 'shape', shape: 'rect', x: 300, y: 300, w: 500, h: 300,
    });
    interaction.selection = new Set([created.id]);
  });
}

function addImage() {
  return guard('Insert image', async () => {
    const path = await pickToOpen(FILTERS.image, 'Choose an image');
    if (!path) return;

    const bytes = stripMetadata(await readFileBytes(path));
    const name = await neutralName(bytes, path);

    // Staged on the Rust side now, written into the container at save time.
    await stagePart(name, bytes);
    images.set(name, toDataUrl(bytes, name));
    imageBytes.set(name, bytes);

    change(() => {
      const created = model.addElement(currentSlideId, {
        kind: 'image', resource: name, x: 300, y: 250, w: 800, h: 500, fit: 'contain',
      });
      interaction.selection = new Set([created.id]);
    });
    toast(`Inserted ${baseName(path)}`);
  });
}

// Charts, formulas, layouts, masters

async function addChart() {
  const chart = await chartDialog();
  if (!chart) return;
  change(() => {
    const created = model.addElement(currentSlideId, { kind: 'chart', x: 360, y: 240, w: 1200, h: 680, ...chart });
    interaction.selection = new Set([created.id]);
  });
}

async function addFormula() {
  const formula = await slideFormulaDialog();
  if (!formula) return;
  change(() => {
    const created = model.addElement(currentSlideId, { kind: 'formula', x: 460, y: 390, w: 1000, h: 300, ...formula });
    interaction.selection = new Set([created.id]);
  });
}

/** Opens the dialog of a chart or formula, asked for by a double click. */
async function editObject(element) {
  const next = element.kind === 'chart' ? await chartDialog(element) : await slideFormulaDialog(element);
  if (!next) return;
  change(() => {
    const target = model.element(currentSlideId, element.id);
    if (!target) return;
    if (element.kind === 'formula') delete target.mathml;
    Object.assign(target, element.kind === 'chart' ? { ...next, data: normaliseChartData(next.data) } : next);
  });
}

async function chooseLayout() {
  const layout = await layoutDialog(model.slide(currentSlideId)?.layout ?? 'titleContent');
  if (layout) change(() => model.setLayout(currentSlideId, layout));
}

/** The slide in view, or the master being edited in its place. */
let editingMaster = null;

async function masters() {
  const { choice, master, name } = await mastersDialog(model, editingMaster ? editingMaster.returnTo : currentSlideId);
  const slideId = editingMaster ? editingMaster.returnTo : currentSlideId;
  if (choice === 'new') {
    let made = null;
    change(() => { made = model.addMaster(name || `Master ${model.masters.length + 1}`); model.assignMaster(slideId, made.id); });
    editMaster(made.id);
  } else if (choice === 'edit' && master) editMaster(master);
  else if (choice === 'rename' && master && name) change(() => model.renameMaster(master, name));
  else if (choice === 'delete' && master) {
    if (editingMaster?.id === master) doneEditingMaster();
    change(() => model.deleteMaster(master));
  } else if (choice === 'assign' && master) change(() => model.assignMaster(slideId, master));
  else if (choice === 'all' && master) change(() => { for (const s of model.slides) model.assignMaster(s.id, master); });
}

/** Shows a master in the slide's place, to edit what every slide using it shows underneath. */
function editMaster(id) {
  const returnTo = editingMaster?.returnTo ?? currentSlideId;
  editingMaster = { id, returnTo };
  currentSlideId = id;
  interaction.attach(model, id);
  el('master-banner').classList.remove('hidden');
  el('master-banner-name').textContent = model.master(id)?.name ?? 'Master';
  draw();
}

function doneEditingMaster() {
  if (!editingMaster) return;
  currentSlideId = model.slide(editingMaster.returnTo) ? editingMaster.returnTo : model.slides[0].id;
  editingMaster = null;
  interaction.attach(model, currentSlideId);
  el('master-banner').classList.add('hidden');
  draw();
}

function addTable() {
  change(() => {
    const created = model.addElement(currentSlideId, {
      kind: 'table', x: 240, y: 300, w: 1400, h: 500, rows: 3, cols: 3, header: true,
    });
    interaction.selection = new Set([created.id]);
  });
  toast('Double-click a cell to type in it');
}

/** Edits one table cell in place. */
function editCell(elementId, row, col) {
  const element = model.element(currentSlideId, elementId);
  if (!element || element.kind !== 'table') return;

  // A cell under a merge is edited in the block's first cell, which holds the text.
  const merge = mergeAt(element, row, col);
  if (merge) [row, col] = [merge.top, merge.left];
  const cell = surface.querySelector(`[data-id="${CSS.escape(elementId)}"] td[data-row="${row}"][data-col="${col}"]`);
  if (!cell) return;

  const before = model.snapshot();

  editInPlace(cell, {
    className: 'editing-cell',
    seed: () => { cell.textContent = element.cells[row][col]; },
    read: () => cell.textContent,
    changed: (text) => text !== element.cells[row][col],
    commit: (text) => {
      model.setCell(currentSlideId, elementId, row, col, text);
      interaction.onCommit(before);
    },
    after: () => draw(),
    keys: (event, finish) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finish(true);
        return true;
      }
      if (event.key === 'Tab') {
        // Tab moves to the next cell, wrapping onto the next row, because a
        // table needing a click per cell is a table nobody fills in.
        event.preventDefault();
        finish(true);
        const next = col + 1 < element.cols
          ? { r: row, c: col + 1 }
          : { r: row + 1 < element.rows ? row + 1 : 0, c: 0 };
        setTimeout(() => editCell(elementId, next.r, next.c), 0);
        return true;
      }
      return false;
    },
  });
}

async function editTable() {
  const id = [...interaction.selection].find(
    (candidate) => model.element(currentSlideId, candidate)?.kind === 'table',
  );
  if (!id) {
    toast('Select a table first');
    return;
  }

  const element = model.element(currentSlideId, id);
  const confirmed = await showPanel('Table', `
    <div class="form-grid">
      <label for="t-rows">Rows</label>
      <input id="t-rows" type="number" data-field="rows" min="1" max="30" value="${element.rows}" />
      <label for="t-cols">Columns</label>
      <input id="t-cols" type="number" data-field="cols" min="1" max="12" value="${element.cols}" />
    </div>
    <div class="setting">
      <span class="label">First row is a heading</span>
      <input type="checkbox" data-field="header" ${element.header ? 'checked' : ''} />
    </div>
    <p class="fp-note">Rows and columns come and go at the end. Format, Table puts them in where the chosen cells are, merges cells and fits sizes to the text.</p>`, 'Apply');
  if (!confirmed) return;

  const fields = readFields();
  change(() => {
    model.resizeTable(currentSlideId, id, { rows: fields.rows, cols: fields.cols });
    model.setTableHeader(currentSlideId, id, fields.header);
  });
}

// Sections

async function editSection() {
  const slide = model.slide(currentSlideId);
  if (!slide) return;

  const confirmed = await showPanel('Section', `
    <div class="form-grid">
      <label for="s-title">Starts a section called</label>
      <input id="s-title" type="text" data-field="title"
             value="${escapeHtml(slide.section ?? '')}" placeholder="leave empty for none" />
    </div>
    <p class="fp-note">
      A section is a heading on the slide that begins it, not a container
      holding slides. Reordering therefore stays exactly what it was, and a
      deck without sections looks exactly as it did before they existed.
    </p>`, 'Apply');
  if (!confirmed) return;

  change(() => model.setSection(currentSlideId, readFields().title));
}

// Fonts

/** Adds a font file to the document. */
async function addFont() {
  const path = await pickToOpen(FILTERS.font, 'Choose a font file');
  if (!path) return;

  const bytes = await readFileBytes(path);
  const file = baseName(path);
  const described = describeFont(bytes);

  const rows = Object.entries(described.names)
    .map(([label, value]) => `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('');

  const confirmed = await showPanel('Add this font?', `
    <table class="fp-table"><tbody>
      <tr><th>File</th><td>${escapeHtml(file)}</td></tr>
      <tr><th>Format</th><td>${escapeHtml(described.format)}</td></tr>
      <tr><th>Size</th><td>${Math.round(bytes.length / 1024)} kB</td></tr>
      ${rows}
    </tbody></table>
    <p class="fp-note">
      ${described.readable
    ? `This is what the font says about itself. It is reported rather than
       removed: the name table carries the licence, and many font licences
       require that notice to be kept. Nothing here identifies you.`
    : `A ${escapeHtml(described.format)} file is compressed and its metadata was
       not read. It will be embedded as it is.`}
    </p>
    <p class="fp-note">
      The font travels inside the document and can be embedded into the HTML
      export, which adds roughly ${Math.round(bytes.length / 1024)} kB to it.
      Check that its licence allows that.
    </p>`, 'Add font');
  if (!confirmed) return;

  const resource = `resources/fonts/${file}`;
  await stagePart(resource, bytes);
  images.set(resource, `data:${fontMediaType(file)};base64,${toDataUrl(bytes, file).split(',')[1]}`);

  const family = file.replace(/\.[^.]+$/, '');
  change(() => model.addFont(family, resource));
  toast(`${family} added: choose it in Design or for the selection`);
}

function deleteSelection() {
  const ids = [...interaction.selection];
  if (ids.length === 0) return;
  change(() => {
    model.deleteElements(currentSlideId, ids);
    interaction.selection.clear();
  });
}

function reorder(direction) {
  const ids = [...interaction.selection];
  if (ids.length === 0) return;
  change(() => model.reorder(currentSlideId, ids, direction));
}

function applyStyle(style) {
  const ids = [...interaction.selection];
  if (ids.length === 0) {
    toast('Select something first');
    return;
  }
  change(() => model.setElementStyle(currentSlideId, ids, style));
}

function step(direction) {
  if (direction > 0 ? undo.redo() : undo.undo()) {
    interaction.selection.clear();
    // The slide the user was on may not exist any more after an undo.
    if (!model.slide(currentSlideId)) currentSlideId = model.slides[0].id;
    interaction.attach(model, currentSlideId);
    draw();
  }
}

// Files

function newDocument() {
  model = new SlidesModel();
  file = { format: 'grt', losses: [], confirmed: false, password: null };
  undo = new UndoStack(model);
  keeper.watch(model);
  images = new Map();
  imageBytes = new Map();
  clearStaged().catch(() => {});
  currentSlideId = model.slides[0].id;
  interaction.attach(model, currentSlideId);
  renderer.fit(model);
  document.title = 'GRT Slides';
  draw();
}

/** New and Open drop the current document: ask first if it has unsaved work. */
async function newDocumentConfirmed() {
  if (await keeper.confirmLeave()) newDocument();
}

async function openConfirmed(path) {
  if (!await keeper.confirmLeave()) return;
  await openPath(path);
}

/** Reads a document into the program, without naming it. */
async function loadDocument(path, password = null) {
  const { parts, resources } = await readDocument(path, password);
  const raw = parts['content/main.json'];
  if (!raw) throw new Error('This document has no presentation content');

  model = new SlidesModel(JSON.parse(raw));
  undo = new UndoStack(model);
  keeper.watch(model);

  // Images are read back and staged again, so a save after opening writes
  // them out unchanged rather than losing them.
  images = new Map();
  imageBytes = new Map();
  await clearStaged();
  for (const name of resources ?? []) {
    const bytes = await readResource(path, name, password);
    images.set(name, toDataUrl(bytes, name));
    imageBytes.set(name, bytes);
    await stagePart(name, bytes);
  }

  currentSlideId = model.slides[0].id;
  interaction.attach(model, currentSlideId);
  renderer.fit(model);
  draw();
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
  document.title = `${baseName(path)} - GRT Slides`;
  toast(`Opened ${baseName(path)}: ${model.slides.length} slide(s)`);
}

/** Reads a presentation in another program's format, and says what did not come across. */
async function importDocument(path, given) {
  const template = isTemplate(given);
  const format = baseFormat(given);
  if (!['odp', 'fodp', 'pptx'].includes(format)) throw new Error(`GRT Slides does not open .${format} files`);
  const opened = await withPassword(baseName(path), async (password) => {
    if (format === 'fodp') return readOdp(await readText(path));
    const pkg = await readPackage(path, { password });
    return format === 'odp' ? readOdp(pkg) : readPptx(pkg);
  });
  if (!opened) return;
  const result = opened.value;

  await clearStaged();
  images = new Map();
  imageBytes = new Map();
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
  model = new SlidesModel(result.document);
  // A template starts a new presentation: nothing is saved back into it unless asked.
  model.path = template ? null : path;
  file = template ? { format: 'grt', losses: [], confirmed: false, password: null } : { format, losses: result.losses.lines(), confirmed: false, password: opened.password };
  undo = new UndoStack(model);
  keeper.watch(model);
  currentSlideId = model.slides[0].id;
  interaction.attach(model, currentSlideId);
  renderer.fit(model);
  draw();
  document.title = template ? `Untitled, from ${baseName(path)} - GRT Slides` : `${baseName(path)} - GRT Slides`;

  if (result.losses.empty) {
    toast(`Opened ${baseName(path)}: ${model.slides.length} slide(s)`);
    return;
  }
  await showPanel(`Opened ${escapeHtml(baseName(path))}`, `
    <p class="fp-note" style="margin-top:0">${model.slides.length} slide(s). What follows did
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
  document.title = `${name} (recovered) - GRT Slides`;
  refresh();
  toast(`Recovered ${name}: save it to keep the changes`);
}

/** The text parts of a saved document; images and fonts travel as staged parts. */
function documentParts() {
  const manifest = {
    kind: 'slides',
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
  odp: 'OpenDocument presentation (.odp)',
  pptx: 'PowerPoint presentation (.pptx)',
  fodp: 'Flat OpenDocument presentation (.fodp)',
  otp: 'OpenDocument template (.otp)',
  potx: 'PowerPoint template (.potx)',
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
      ${passwordFields(file.password, problem)}
      <p class="fp-note">A GRT document keeps everything this program can do.
      The others open in LibreOffice and PowerPoint; what they cannot hold is said
      before anything is written. A flat .fodp cannot carry a password.</p>`, 'Choose file');
    wirePasswordFields();
    if (!await answer) return null;
    const fields = readFields();
    const protection = passwordFrom(fields, fields.format);
    if (protection.error) {
      problem = protection.error;
      current = fields.format;
      continue;
    }
    const { format } = fields;
    const chosen = await pickToSave(withExtension(model.path ?? 'presentation', format), FILTERS[format], 'Save presentation');
    return chosen ? { path: withExtension(chosen, format), format, password: protection.password } : null;
  }
}

/** A copy written elsewhere, the presentation open staying as it is; a template is one such copy. */
async function saveCopy(preferred = null) {
  const chosen = await chooseSaveTarget(preferred);
  if (!chosen) return;
  const lost = await writeAs(chosen.path, chosen.format, canProtect(chosen.format) ? chosen.password : null);
  toast(lost.length > 0 ? `Saved a copy as ${baseName(chosen.path)}, without: ${lost.join('; ')}` : `Saved a copy as ${baseName(chosen.path)}`);
}

/** Writes the presentation in a format, and says what that format could not hold. */
async function writeAs(path, format, password = null) {
  if (format === 'grt') {
    await writeDocument(path, documentParts(), password);
    return [];
  }
  const json = model.toJSON();
  if (format === 'fodp') {
    const { text, losses } = writeOdp(json, imageBytes, { flat: true });
    await writeText(path, text);
    return losses.lines();
  }
  const { entries, losses } = baseFormat(format) === 'odp' ? writeOdp(json, imageBytes) : writePptx(json, imageBytes);
  await writePackage(path, isTemplate(format) ? asTemplate(entries, format) : entries, { protection: PROTECTION[format], password });
  return losses.lines();
}

/**
 * Saves the presentation, in its own format when it can be written back.
 * Silent, it asks nothing and reports nothing, which is how autosave writes
 * onto the file. Resolves false when nothing was saved.
 */
async function save(forceDialog, { silent = false } = {}) {
  let path = forceDialog ? null : model.path;
  let format = file.format;
  let password = file.password;
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
  undo.markSaved();
  document.title = `${baseName(path)} - GRT Slides`;
  refresh();
  if (!silent) toast(lost.length > 0 ? `Saved ${baseName(path)}, without: ${lost.join('; ')}` : `Saved ${baseName(path)}`);
  await keeper.saved();
  return true;
}

/** How the deck was last printed, kept while the program runs. */
let printSetup = { layout: 'slides', size: 'A4', orientation: 'landscape', frame: false };

async function printDeck() {
  document.activeElement?.blur?.();
  printSetup = await printPreview({
    title: 'Print',
    setup: printSetup,
    controls: (s) => `
      <label>Print<select data-print-field="layout">
        ${Object.entries(LAYOUTS).map(([id, layout]) => `<option value="${id}"${s.layout === id ? ' selected' : ''}>${layout.label}</option>`).join('')}
      </select></label>
      ${pageControls(s)}
      <label><input type="checkbox" data-print-field="frame"${s.frame ? ' checked' : ''} />Frame slides</label>`,
    build: (s) => printablePages(model, images, s),
  });
}

async function exportDocument() {
  const confirmed = await showPanel('Export', `
    <div class="form-grid">
      <label for="ex-format">Format</label>
      <select id="ex-format" data-field="format">
        <option value="html">HTML: one file, opens anywhere</option>
        <option value="pdf">PDF: one page per slide</option>
        <option value="svg">SVG: the current slide</option>
      </select>
    </div>
    <div class="setting">
      <span class="label">Embed the document's fonts (HTML only)
        <span class="hint">Makes the file look the same anywhere, and adds
        a few hundred kilobytes per font family.</span>
      </span>
      <input type="checkbox" data-field="embedFonts"
             ${model.fonts.length > 0 ? 'checked' : ''} />
    </div>
    <p class="fp-note">
      The HTML is a single file with the images inlined and keyboard navigation
      included: it opens on any device with nothing installed, and it carries
      no software name and no date. The PDF goes through the suite's shared
      print engine, the same code that clears metadata in GRT Read.
    </p>`, 'Choose file');
  if (!confirmed) return;

  const fields = readFields();
  const { format } = fields;
  const path = await pickToSave(
    withExtension(model.path, format), FILTERS[format], 'Export to',
  );
  if (!path) return;

  if (format === 'html') {
    await writeText(path, toHtml(model, images, { embedFonts: !!fields.embedFonts }));
  } else if (format === 'svg') {
    await writeText(path, slideToSvg(model, currentSlideId, images));
  } else {
    // One page per slide, each through the shared engine.
    const report = { replaced: 0 };
    const pages = await Promise.all(
      model.slides.map((slide) =>
        renderToPdf(slideToPrintPage(model, slide.id, imageBytes), { audit: false, report })),
    );
    await writeBytes(path, await mergePdfPages(pages));
    if (report.replaced > 0) {
      toast(`Exported ${baseName(path)}, ${report.replaced} character(s) the PDF font cannot draw, replaced; printing to PDF keeps them`, true);
      return;
    }
  }

  toast(`Exported ${baseName(path)}`);
}

// Settings

async function openSettings() {
  const current = settings();
  const option = (value, label, selected) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;

  const confirmed = await showPanel('Settings', `
    <div class="setting">
      <span class="label">Theme
        <span class="hint">System follows the desktop, live.</span>
      </span>
      <select data-field="theme">
        ${THEMES.map((t) => option(t.id, t.label, current.theme)).join('')}
      </select>
    </div>
    <div class="setting">
      <span class="label">Snap while dragging</span>
      <input type="checkbox" data-field="snapToGrid" ${current.snapToGrid ? 'checked' : ''} />
    </div>
    <div class="setting">
      <span class="label">Show the notes panel</span>
      <input type="checkbox" data-field="showNotes" ${current.showNotes ? 'checked' : ''} />
    </div>
    <div class="setting">
      <span class="label">Keep unsaved work
        <span class="hint">Every couple of seconds of quiet. A recovery copy
        is offered back if the program closes unexpectedly; onto the file
        saves the presentation itself, once it has a name.</span>
      </span>
      <select data-field="autosave">
        ${MODES.map((m) => option(m.id, m.label, current.autosave)).join('')}
      </select>
    </div>
    <div class="setting">
      <span class="label">Shrink text that does not fit
        <span class="hint">Off by default: text quietly getting smaller is an
        unwelcome surprise in front of an audience.</span>
      </span>
      <input type="checkbox" data-field="autoShrinkText" ${current.autoShrinkText ? 'checked' : ''} />
    </div>
    <p class="fp-note">${canPersist()
    ? 'Stored as a settings.json holding these five values. No record of which documents were opened.'
    : '<strong>Ephemeral mode:</strong> changes apply now but are not written to disk.'}</p>`,
  'Apply');
  if (!confirmed) return;

  const fields = readFields();
  const stored = await updateSettings(fields);
  keeper.setMode(settings().autosave);
  applySettings();
  draw();
  toast(stored ? 'Settings saved' : 'Settings applied for this session only');
}

function applySettings() {
  interaction.snapEnabled = settings().snapToGrid;
  el('notes-panel').classList.toggle('hidden', !settings().showNotes);
}

// Design

const colourField = (label, key, value, hint = '') => `
  <div class="setting">
    <span class="label">${label}${hint ? `<span class="hint">${hint}</span>` : ''}</span>
    <input type="color" data-field="${key}" value="${escapeHtml(value)}" />
  </div>`;

/** The look of the whole deck: colours, fonts, and the named styles. */
async function openDesign() {
  const styleFields = ['title', 'body', 'caption'].map((name) => {
    const style = model.styles[name];
    return `
      <h3 class="form-heading">${name}</h3>
      <div class="form-grid">
        <label for="d-${name}-size">Size</label>
        <input id="d-${name}-size" type="number" data-field="${name}.size"
               min="8" max="200" step="1" value="${style.size ?? 32}" />
        <label for="d-${name}-color">Colour</label>
        <input id="d-${name}-color" type="color" data-field="${name}.color"
               value="${escapeHtml(style.color ?? '#333333')}" />
        <label for="d-${name}-font">Font</label>
        <select id="d-${name}-font" data-field="${name}.font">
          ${Object.entries(FONTS).map(([id, f]) =>
    `<option value="${id}"${style.font === id ? ' selected' : ''}>${f.label}</option>`).join('')}
          ${model.fonts.map((f) =>
    `<option value="${f.id}"${style.font === f.id ? ' selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
        </select>
        <label for="d-${name}-align">Alignment</label>
        <select id="d-${name}-align" data-field="${name}.align">
          ${ALIGNMENTS.map((a) =>
    `<option value="${a}"${(style.align ?? 'left') === a ? ' selected' : ''}>${a}</option>`).join('')}
        </select>
        <label for="d-${name}-bold">Bold</label>
        <input id="d-${name}-bold" type="checkbox" data-field="${name}.bold"
               ${style.bold ? 'checked' : ''} />
      </div>`;
  }).join('');

  const confirmed = await showPanel('Design', `
    <div class="form-grid">
      <label for="d-preset">Start from</label>
      <select id="d-preset" data-field="preset">
        <option value="">Keep what is there</option>
        ${Object.entries(PRESETS).map(([id, p]) =>
    `<option value="${id}">${p.label}</option>`).join('')}
      </select>
    </div>
    <p class="fp-note" style="margin-top:8px">
      A preset sets the colours and fonts below in one go. Slides given their
      own background keep it: an explicit choice on one slide should survive a
      change of theme.
    </p>

    <h3 class="form-heading">Deck colours</h3>
    ${colourField('Background', 'theme.background', model.theme.background ?? '#ffffff')}
    ${colourField('Accent', 'theme.accent', model.theme.accent ?? '#1f6feb',
    'Used for shapes that have no colour of their own.')}

    ${styleFields}

    <p class="fp-note">
      Fonts are the system's own. Embedding one would make an exported file
      self-sufficient, but font files carry metadata of their own and would
      inflate every export, and that trade is still an open question.
    </p>`, 'Apply');
  if (!confirmed) return;

  const fields = readFields();

  change(() => {
    if (fields.preset) model.applyPreset(fields.preset);

    model.setTheme({
      background: fields['theme.background'],
      accent: fields['theme.accent'],
    });

    for (const name of ['title', 'body', 'caption']) {
      model.setStyle(name, {
        size: Math.max(8, Math.min(fields[`${name}.size`] || 32, 200)),
        color: fields[`${name}.color`],
        font: fields[`${name}.font`],
        align: fields[`${name}.align`],
        bold: !!fields[`${name}.bold`],
      });
    }
  });

  toast(fields.preset ? `Applied the ${PRESETS[fields.preset].label} look` : 'Design updated');
}

/** The slide size. */
async function openCanvasSetup() {
  const { CANVAS_PRESETS } = await import('./model.js');
  const current = `${model.canvas.w}x${model.canvas.h}`;

  const confirmed = await showPanel('Slide size', `
    <div class="form-grid">
      <label for="c-preset">Size</label>
      <select id="c-preset" data-field="preset">
        ${Object.entries(CANVAS_PRESETS).map(([id, p]) =>
    `<option value="${id}"${current === `${p.w}x${p.h}` ? ' selected' : ''}>`
    + `${p.label}, ${p.w}×${p.h}</option>`).join('')}
        <option value="custom">Something else…</option>
      </select>
      <label for="c-w">Width</label>
      <input id="c-w" type="number" data-field="w" min="200" max="10000"
             value="${model.canvas.w}" />
      <label for="c-h">Height</label>
      <input id="c-h" type="number" data-field="h" min="200" max="10000"
             value="${model.canvas.h}" />
    </div>
    <div class="setting">
      <span class="label">Scale what is already on the slides
        <span class="hint">Off leaves everything where it is, which will push
        content off the edge if the slide gets smaller.</span>
      </span>
      <input type="checkbox" data-field="scale" checked />
    </div>`, 'Apply');
  if (!confirmed) return;

  const fields = readFields();
  const preset = CANVAS_PRESETS[fields.preset];
  const size = preset ? { w: preset.w, h: preset.h } : { w: fields.w, h: fields.h };

  change(() => model.setCanvas(size, { scaleElements: !!fields.scale }));
  renderer.fit(model);
  draw();
  toast(`Slides are now ${model.canvas.w}×${model.canvas.h}`);
}

/** Background and transition for the slide being edited. */
async function openSlideSetup() {
  const slide = model.slide(currentSlideId);
  if (!slide) return;

  const confirmed = await showPanel('This slide', `
    <div class="setting">
      <span class="label">Background
        <span class="hint">Overrides the deck's own background for this slide only.</span>
      </span>
      <input type="color" data-field="background"
             value="${escapeHtml(model.slideBackground(currentSlideId))}" />
    </div>
    <div class="setting">
      <span class="label">Follow the deck instead</span>
      <input type="checkbox" data-field="inherit" ${slide.background ? '' : 'checked'} />
    </div>
    <div class="setting">
      <span class="label">Transition
        <span class="hint">Played when this slide appears.</span>
      </span>
      <select data-field="transition">
        ${TRANSITIONS.map((t) =>
    `<option value="${t}"${slide.transition === t ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
    </div>
    <div class="setting">
      <span class="label">Apply the transition to every slide</span>
      <input type="checkbox" data-field="applyAll" />
    </div>
    <p class="fp-note">
      Three transitions, and no more: an elaborate catalogue costs work,
      distracts the room, and nobody uses one twice.
    </p>`, 'Apply');
  if (!confirmed) return;

  const fields = readFields();
  change(() => {
    model.setSlideBackground(currentSlideId, fields.inherit ? null : fields.background);
    if (fields.applyAll) model.setAllTransitions(fields.transition);
    else model.setTransition(currentSlideId, fields.transition);
  });
  toast('Slide updated');
}

/** Colour and font for whatever is selected right now. */
async function openElementLook() {
  const ids = [...interaction.selection];
  if (ids.length === 0) {
    toast('Select something first');
    return;
  }

  const first = model.element(currentSlideId, ids[0]) ?? {};
  const style = model.styles[first.style ?? 'body'] ?? {};

  const confirmed = await showPanel('Selected elements', `
    ${colourField('Text colour', 'colour', first.color ?? style.color ?? '#333333')}
    <div class="setting">
      <span class="label">Use the style's colour instead</span>
      <input type="checkbox" data-field="inheritColour" ${first.color ? '' : 'checked'} />
    </div>
    ${colourField('Shape fill', 'fill', first.fill ?? model.theme.accent ?? '#1f6feb',
    'Only affects shapes.')}
    <div class="setting">
      <span class="label">Use the accent colour instead</span>
      <input type="checkbox" data-field="inheritFill" ${first.fill ? '' : 'checked'} />
    </div>
    <div class="setting">
      <span class="label">Font</span>
      <select data-field="font">
        <option value="">Follow the style</option>
        ${Object.entries(FONTS).map(([id, f]) =>
    `<option value="${id}"${first.font === id ? ' selected' : ''}>${f.label}</option>`).join('')}
      </select>
    </div>
    <div class="setting">
      <span class="label">Text size
        <span class="hint">In pixels of the slide; empty follows the style (${style.size ?? 32}).</span>
      </span>
      <input type="number" data-field="size" min="4" max="400" value="${first.size ?? ''}" />
    </div>
    <div class="setting">
      <span class="label">Alignment</span>
      <select data-field="align">
        <option value="">Follow the style</option>
        ${['left', 'center', 'right'].map((a) => `<option value="${a}"${first.align === a ? ' selected' : ''}>${a[0].toUpperCase()}${a.slice(1)}</option>`).join('')}
      </select>
    </div>
    <div class="setting">
      <span class="label">Text sits at the</span>
      <select data-field="valign">
        ${[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']].map(([v, label]) =>
    `<option value="${v}"${(first.valign ?? 'top') === v ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <p class="fp-note">
      A named style changes every title at once; these override the one element
      that has to be different. Both exist because presentations are made of
      both.
    </p>`, 'Apply');
  if (!confirmed) return;

  const fields = readFields();
  change(() => {
    model.setElementColour(currentSlideId, ids, {
      colour: fields.inheritColour ? '' : fields.colour,
      fill: fields.inheritFill ? '' : fields.fill,
    });
    if (fields.font) model.setElementFont(currentSlideId, ids, fields.font);
    model.setElementText(currentSlideId, ids, {
      size: Number(fields.size) || null, align: fields.align || null, valign: fields.valign,
    });
  });
  toast(`Updated ${ids.length} element(s)`);
}

/** The footer, number and date of this slide or of all, as Impress's Header and Footer. */
async function footerDialog() {
  const now = model.slide(currentSlideId)?.footer ?? { text: '', number: false, date: null, dateText: '' };
  const confirmed = await showPanel('Header and footer', `
    <label class="inline"><input type="checkbox" data-field="showDate"${now.date ? ' checked' : ''}> Date</label>
    <label class="inline"><input type="radio" name="footer-date" data-field="date" value="auto"${now.date !== 'fixed' ? ' checked' : ''}> Today's, changing each day</label>
    <label class="inline"><input type="radio" name="footer-date" data-field="date" value="fixed"${now.date === 'fixed' ? ' checked' : ''}> Fixed</label>
    <input data-field="dateText" maxlength="60" value="${escapeHtml(now.dateText || new Date().toLocaleDateString())}" aria-label="Fixed date">
    <label class="inline"><input type="checkbox" data-field="showText"${now.text ? ' checked' : ''}> Footer</label>
    <input data-field="text" maxlength="200" value="${escapeHtml(now.text)}" aria-label="Footer text">
    <label class="inline"><input type="checkbox" data-field="number"${now.number ? ' checked' : ''}> Slide number</label>
    <label class="inline"><input type="checkbox" data-field="notFirst"> Not on the first slide</label>
    <fieldset><legend>Apply to</legend>
      <label class="inline"><input type="radio" name="footer-scope" data-field="scope" value="all" checked> Every slide</label>
      <label class="inline"><input type="radio" name="footer-scope" data-field="scope" value="this"> This slide</label>
    </fieldset>`, 'Apply');
  if (!confirmed) return;
  const f = readFields();
  const footer = { text: f.showText ? f.text : '', number: f.number, date: f.showDate ? f.date : null, dateText: f.dateText };
  const ids = f.scope === 'this' ? [currentSlideId] : model.slides.map((s) => s.id);
  change(() => {
    model.setFooter(ids, footer);
    if (f.notFirst && f.scope !== 'this') model.setFooter([model.slides[0].id], null);
  });
}

// Command palette

// The menu bar, the same in every program, with Impress's names as aliases.

const menus = slidesMenus({
  has: {
    sorter: () => el('workspace').classList.contains('sorter'),
    hidden: () => Boolean(model.slide(currentSlideId)?.hidden),
    masterObjects: () => !model.slide(currentSlideId)?.hideMaster,
  },
  a: {
    text,
    palette: () => openPalette(commands()),
    newFile: () => guard('New', newDocumentConfirmed),
    open: () => el('btn-open').click(),
    save: () => guard('Save', () => save(false)),
    saveAs: () => guard('Save', () => save(true)),
    saveCopy: () => guard('Save', () => saveCopy()),
    saveTemplate: () => guard('Save', () => saveCopy('otp')),
    templates: () => templateManager({ extensions: ['otp', 'potx', 'potm'], open: openConfirmed, toast }),
    everywhere: () => searchEverywhere({ kind: 'slides', open: openConfirmed, toast }),
    spelling: () => spellingOverItems({
      checker: spellChecker,
      toast,
      language: () => settings().spellLanguage,
      setLanguage: (tag) => updateSettings({ spellLanguage: tag }),
      grammar: () => true,
      // Boxes, table cells and notes, slide after slide, as Find goes through them.
      items: () => model.slides.flatMap((slide, n) => [
        ...(slide.elements ?? []).flatMap((element) => (element.kind === 'text'
          ? [{ key: `t|${slide.id}|${element.id}`, label: `Slide ${n + 1}`, text: (element.content ?? []).map((r) => r.text).join('') }]
          : element.kind === 'table'
            ? element.cells.flatMap((row, r) => row.map((cell, c) => ({ key: `c|${slide.id}|${element.id}|${r}|${c}`, label: `Slide ${n + 1}, table`, text: String(cell ?? '') })))
            : [])),
        { key: `n|${slide.id}`, label: `Slide ${n + 1}, notes`, text: slide.notes ?? '' },
      ]),
      show: (issue) => {
        const [kind, slideId, id, row, col] = issue.item.key.split('|');
        finder.show({ kind: { t: 'text', c: 'cell', n: 'notes' }[kind], slideId, id, row: Number(row), col: Number(col), from: issue.from, to: issue.to });
      },
      replace: (key, from, to, text) => {
        const [kind, slideId, id, row, col] = key.split('|');
        change(() => {
          const slide = model.slides.find((s) => s.id === slideId);
          if (kind === 'n') model.setNotes(slideId, (slide.notes ?? '').slice(0, from) + text + (slide.notes ?? '').slice(to));
          const element = slide?.elements?.find((e) => e.id === id);
          if (kind === 't' && element) model.setContent(slideId, id, applyEdits(element.content ?? [], [{ from, to, text }]), element.paras ?? null);
          if (kind === 'c' && element) {
            const cell = String(element.cells[Number(row)][Number(col)] ?? '');
            model.setCell(slideId, id, Number(row), Number(col), cell.slice(0, from) + text + cell.slice(to));
          }
        });
      },
    }),
    customize: async () => {
      const next = await customizeDialog(menus, settings().keyboard);
      if (!next) return;
      const stored = await updateSettings({ keyboard: applyShortcuts(menus, next) });
      toast(stored ? 'Shortcuts saved' : 'Shortcuts changed for this session only');
    },
    reload: () => { if (model.path) guard('Reload', () => openConfirmed(model.path)); else toast('This presentation has not been saved yet'); },
    exportDocument: () => guard('Export', exportDocument),
    print: () => guard('Print', printDeck),
    settings: () => guard('Settings', openSettings),
    undo: () => step(-1),
    redo: () => step(1),
    deleteSelection: () => deleteSelection(),
    front: () => reorder('front'),
    back: () => reorder('back'),
    normalView: () => { el('workspace').classList.remove('sorter'); draw(); },
    sorterView: () => { el('workspace').classList.add('sorter'); draw(); },
    masters: () => masters(),
    toggleSidebar: () => { el('notes-panel').classList.toggle('hidden'); },
    addText: () => addText(),
    addImage: () => addImage(),
    addShape: () => addShape(),
    addTable: () => addTable(),
    addChart: () => addChart(),
    addFormula: () => addFormula(),
    design: () => guard('Design', openDesign),
    elementLook: () => guard('Look', openElementLook),
    editTable: () => guard('Table', editTable),
    table: tables,
    finder,
    comments: notesOnSlides,
    redact: () => redactChosen(),
    inspect: () => guard('Inspect', inspectPresentation),
    autoRedact: () => guard('Auto-Redact', autoRedactDialog),
    redactedExport: () => guard('Export', redactedExport),
    toggleComments: () => { commentsHidden = !commentsHidden; draw(); },
    commentsShown: () => !commentsHidden,
    addFont: () => guard('Font', addFont),
    addSlide: () => addSlide(),
    duplicateSlide: () => duplicateSlide(),
    deleteSlide: () => deleteSlide(),
    chooseLayout: () => chooseLayout(),
    slideSetup: () => guard('Slide', openSlideSetup),
    slideSize: () => guard('Slide size', openCanvasSetup),
    section: () => guard('Section', editSection),
    hideSlide: (hidden) => change(() => model.setHidden(currentSlideId, hidden)),
    footer: () => footerDialog(),
    masterObjects: () => change(() => model.setMasterObjects(currentSlideId, Boolean(model.slide(currentSlideId)?.hideMaster))),
    stepSlide: (by) => stepSlide(by),
    present: (from) => present(from),
    presenter: () => guard('Presenter', openPresenter),
    about: async () => aboutDialog({ name: 'GRT Slides', version: (await runtimeInfo()).version }),
    licences: () => licencesDialog({ name: 'GRT Slides' }),
  },
});
const menubar = createMenubar(el('menubar'), menus);
toolbars = wireToolbars(document.querySelector('.toolbars'), menus);
statusbar = createStatusBar(el('statusbar'), [
  { key: 'slide', title: 'The slide in front of you', text: () => `Slide ${Math.max(1, model.slides.findIndex((x) => x.id === currentSlideId) + 1)} of ${model.slides.length}` },
  { key: 'selected', title: 'What is selected', text: () => (interaction.selection?.size ? `${interaction.selection.size} selected` : '') },
  { key: 'master', title: 'The slide master', text: () => { const id = model.slide(currentSlideId)?.master; return (id && model.master(id)?.name) || 'Default'; } },
  { key: 'language', title: 'The language Spelling starts with', text: () => LANGUAGE_NAMES.get(settings().spellLanguage) ?? settings().spellLanguage ?? '' },
  { key: 'modified', title: 'The presentation has changes not yet saved', text: () => (model.dirty ? 'Unsaved changes' : ''), grow: true },
]);
// A click on the menus may collapse the selection in the box being edited, so it is taken first.
el('menubar').addEventListener('mousedown', () => text.remember(), true);

/** The items of the Format menu, inside its submenus too. */
const formatItems = new Set();
(function collect(items) {
  for (const item of items) {
    if (item === 'separator') continue;
    if (item.items) collect(item.items);
    else formatItems.add(item);
  }
}(menus.find((m) => m.label === 'Format').items));

function commands() {
  const entry = (label, hint, run) => ({ id: label, label, hint, run });

  // Everything in the menus, then the looks and transitions that are quicker to type than to find.
  return [
    ...paletteEntries(menus).filter((e) => e.enabled()),
    ...['title', 'body', 'caption'].map((style) => entry(`Style: ${style}`, '', () => applyStyle(style))),
    ...Object.entries(PRESETS).map(([id, preset]) => entry(`Look: ${preset.label}`, '', () => change(() => model.applyPreset(id)))),
    ...TRANSITIONS.map((t) => entry(`Transition: ${t} (all slides)`, '', () => change(() => model.setAllTransitions(t)))),
  ];
}

// Presenter view

const { listen, emit } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

let presenterOpen = false;

/** Sends the deck to the presenter window. */
async function broadcastDeck() {
  if (!presenterOpen) return;
  await emit('grt://deck', {
    document: model.toJSON(),
    images: Object.fromEntries(images),
    index: model.slides.findIndex((s) => s.id === currentSlideId),
    theme: settings().theme,
  });
}

async function broadcastIndex() {
  if (!presenterOpen) return;
  await emit('grt://index', {
    index: model.slides.findIndex((s) => s.id === currentSlideId),
  });
}

async function openPresenter() {
  await invoke('open_presenter');
  presenterOpen = true;
  toast('Presenter view opened. Move it to the second screen, then press F5');
}

listen('grt://presenter-ready', () => {
  presenterOpen = true;
  broadcastDeck();
});

listen('grt://presenter-goto', (event) => {
  const at = event.payload?.index ?? 0;
  if (presentation.running) {
    presentation.go(at);
  } else {
    const slide = model.slides[Math.max(0, Math.min(at, model.slides.length - 1))];
    if (slide) selectSlide(slide.id);
  }
  broadcastIndex();
});

listen('grt://presenter-exit', () => {
  if (presentation.running) presentation.stop();
});

// Presentation

function present(fromIndex = null) {
  // Hidden slides stay in the file and out of the show.
  const shown = Object.create(model);
  shown.slides = model.slides.filter((s) => !s.hidden);
  if (!shown.slides.length) {
    toast('Every slide is hidden');
    return;
  }
  const from = fromIndex === null ? model.slides.findIndex((s) => s.id === currentSlideId) : fromIndex;
  const index = Math.max(0, shown.slides.findIndex((s) => model.slides.indexOf(s) >= from));
  presentation.images = images;
  presentation.start(shown, index);
  broadcastDeck();
}

// The projector tells the second screen where it is, so the two never drift.
presentation.onMove = (at) => {
  if (presenterOpen) emit('grt://index', { index: at });
};

presentation.onExit = () => {
  // Coming back from fullscreen changes the available space, so the slide has
  // to be refitted or it stays at the size it had before.
  renderer.fit(model);
  draw();
};

function stepSlide(delta) {
  const index = model.slides.findIndex((s) => s.id === currentSlideId);
  const next = model.slides[Math.max(0, Math.min(index + delta, model.slides.length - 1))];
  if (next) selectSlide(next.id);
}

// Events

properties = createProperties(el('properties'), describeSelection);

el('btn-new').onclick = () => guard('New', newDocumentConfirmed);
el('btn-open').onclick = () => guard('Open', async () => {
  const path = await pickToOpen(FILTERS.presentations, 'Open presentation');
  if (path) await openConfirmed(path);
});
el('btn-save').onclick = () => guard('Save', () => save(false));
el('btn-save-as').onclick = () => guard('Save', () => save(true));
el('btn-export').onclick = () => guard('Export', exportDocument);
el('btn-print').onclick = () => guard('Print', printDeck);
el('btn-present').onclick = () => present();
el('btn-presenter').onclick = () => guard('Presenter', openPresenter);
el('btn-settings').onclick = () => guard('Settings', openSettings);
el('btn-commands').onclick = () => openPalette(commands());
el('btn-undo').onclick = () => step(-1);
el('btn-redo').onclick = () => step(1);
el('btn-add-slide').onclick = () => addSlide();
el('btn-duplicate').onclick = () => duplicateSlide();
el('btn-delete-slide').onclick = () => deleteSlide();
el('btn-add-text').onclick = () => addText();
el('btn-add-image').onclick = () => addImage();
el('btn-add-shape').onclick = () => addShape();
el('btn-add-table').onclick = () => addTable();
el('btn-design').onclick = () => guard('Design', openDesign);
el('btn-slide-setup').onclick = () => guard('Slide', openSlideSetup);
el('btn-front').onclick = () => reorder('front');
el('btn-back').onclick = () => reorder('back');
el('btn-delete').onclick = () => deleteSelection();

el('style-picker').onchange = (event) => {
  applyStyle(event.target.value);
  event.target.value = '';
};

// Each stretch of typing in the notes is one step to undo.
let notesTyping = false;
el('notes').onfocus = () => { notesTyping = false; };
el('notes').oninput = (event) => {
  if (!notesTyping) {
    notesTyping = true;
    interaction.onCommit(model.snapshot());
  }
  model.setNotes(currentSlideId, event.target.value);
  refresh();
};

document.addEventListener('keydown', (event) => {
  if (presentation.running || isDialogOpen() || isPaletteOpen() || isPrintPreviewOpen()) return;

  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || target?.isContentEditable) return;

  const ctrl = event.ctrlKey || event.metaKey;

  if (event.key === 'F5') {
    event.preventDefault();
    present(event.shiftKey ? null : 0);
  } else if (ctrl && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette(commands());
  } else if (ctrl && event.key.toLowerCase() === 'm') {
    event.preventDefault();
    addSlide();
  } else if (ctrl && event.key.toLowerCase() === 'n' && !event.shiftKey) {
    event.preventDefault();
    el('btn-new').click();
  } else if (ctrl && event.key.toLowerCase() === 's') {
    event.preventDefault();
    guard('Save', () => save(event.shiftKey));
  } else if (ctrl && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    el('btn-open').click();
  } else if (ctrl && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    guard('Print', printDeck);
  } else if (ctrl && event.key === ',') {
    event.preventDefault();
    guard('Settings', openSettings);
  } else if (ctrl && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    interaction.selection = new Set(
      (model.slide(currentSlideId)?.elements ?? []).map((e) => e.id),
    );
    draw();
  } else if (ctrl && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    step(event.shiftKey ? 1 : -1);
  } else if (ctrl && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    step(1);
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelection();
  } else if (event.key === 'PageDown') {
    event.preventDefault();
    stepSlide(1);
  } else if (event.key === 'PageUp') {
    event.preventDefault();
    stepSlide(-1);
  } else if (event.key === 'Escape') {
    interaction.selection.clear();
    draw();
  }
});

onFilesDropped((paths) => guard('Open', async () => {
  const deck = paths.find((p) => OPENABLE.test(p));
  if (deck) await openConfirmed(deck);
}));

window.addEventListener('resize', () => {
  if (!presentation.running) {
    renderer.fit(model);
    draw();
  }
});

// Startup

(async function start() {
  const info = await runtimeInfo();
  await loadSettings(info.ephemeral);
  applySettings();
  applyShortcuts(menus, settings().keyboard);

  if (info.ephemeral) el('ephemeral-note').classList.remove('hidden');

  interaction.attach(model, currentSlideId);
  keeper.watch(model);
  renderer.fit(model);
  draw();

  const initial = info.initialFile && OPENABLE.test(info.initialFile) && await fileExists(info.initialFile)
    ? info.initialFile : null;
  const recovered = await keeper.start({
    ephemeral: info.ephemeral, mode: settings().autosave, initialFile: initial,
  });
  if (initial && !recovered) {
    await guard('Open', () => openPath(initial));
  }
}());
