/** Application wiring. */

import { SlidesModel, FONTS, PRESETS, TRANSITIONS, ALIGNMENTS } from './model.js';
import { Renderer } from './render.js';
import { Interaction } from './interaction.js';
import { Thumbnails } from './thumbnails.js';
import { Presentation } from './present.js';
import { runsToHtml, htmlToRuns, toggleFormat } from './text.js';
import { editInPlace } from './editing.js';
import { toHtml, slideToSvg, slideToPrintPage } from './export.js';
import { convertPptx } from './pptx.js';
import { describeFont, fontMediaType } from './fonts.js';
import { UndoStack } from './core/undo.js';
import { showPanel, readFields, isDialogOpen, escapeHtml } from './core/panel.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES } from './core/theme.js';
import { renderToPdf } from './core/pdf.js';
import { loadSettings, updateSettings, settings, canPersist } from './settings.js';
import {
  pickToOpen, pickToSave, readDocument, readResource, writeDocument, writeText,
  writeBytes, readFileBytes, readZip, stagePart, clearStaged, fileExists,
  runtimeInfo, onFilesDropped, baseName, withExtension, toDataUrl, FILTERS,
} from './io.js';

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

// Drawing

function draw() {
  renderer.draw(model, currentSlideId, interaction.selection, interaction.extras, images);
  thumbs.draw(model, currentSlideId, images);
  el('notes').value = model.slide(currentSlideId)?.notes ?? '';
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

  const index = model.slides.findIndex((s) => s.id === currentSlideId);
  const parts = [`Slide ${index + 1} of ${model.slides.length}`];
  if (selected > 0) parts.push(`${selected} selected`);
  if (model.dirty) parts.push('unsaved changes');
  el('status').textContent = parts.join(' • ');
}

interaction.onChange = () => draw();
interaction.onSelectionChange = () => refresh();
interaction.onCommit = (before) => {
  undo.past.push(before);
  if (undo.past.length > undo.limit) undo.past.shift();
  undo.future.length = 0;
  refresh();
};
interaction.onEditText = (id, cell) => {
  const element = model.element(currentSlideId, id);
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

function change(mutate) {
  const before = model.snapshot();
  mutate();
  interaction.onCommit(before);
  draw();
}

// Text editing

/** Edits a text box in place. */
function editText(id) {
  const element = model.element(currentSlideId, id);
  if (!element || element.kind !== 'text') return;

  const node = surface.querySelector(`[data-id="${id}"]`);
  if (!node) return;

  const before = model.snapshot();

  editInPlace(node, {
    className: 'editing',
    selectAll: true,
    seed: () => { node.innerHTML = runsToHtml(element.content); },
    read: () => htmlToRuns(node),
    changed: (runs) => JSON.stringify(runs) !== JSON.stringify(element.content),
    commit: (runs) => {
      model.setContent(currentSlideId, id, runs);
      interaction.onCommit(before);
    },
    after: () => draw(),
    keys: (event, finish) => {
      // Enter belongs to the paragraph being typed, so committing needs the
      // modifier; a text box is the one place in the program where a plain
      // Enter has to mean a new line.
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
        return true;
      }
      if ((event.ctrlKey || event.metaKey) && 'biu'.includes(event.key.toLowerCase())) {
        event.preventDefault();
        toggleFormat({ b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()]);
        return true;
      }
      return false;
    },
  });
}

// Editing commands

function addSlide() {
  change(() => {
    const index = model.slides.findIndex((s) => s.id === currentSlideId);
    const slide = model.addSlide(index + 1);
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
      kind: 'text', x: 200, y: 200, w: 900, h: 200, content: [{ text: 'New text' }],
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

    const bytes = await readFileBytes(path);
    const name = `resources/${baseName(path)}`;

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

  const cell = surface.querySelector(
    `[data-id="${elementId}"] tr:nth-child(${row + 1}) td:nth-child(${col + 1})`,
  );
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
    <p class="fp-note">
      A static grid: rows, columns and text. Merged cells and per-cell
      formatting are deliberately absent — tables in slides are almost always
      three rows by two columns, and the full version costs a second model and
      a second way of editing for a case that rarely arrives.
    </p>`, 'Apply');
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
  toast(`${family} added — choose it in Design or for the selection`);
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
  undo = new UndoStack(model);
  images = new Map();
  imageBytes = new Map();
  clearStaged().catch(() => {});
  currentSlideId = model.slides[0].id;
  interaction.attach(model, currentSlideId);
  renderer.fit(model);
  document.title = 'GRT Slides';
  draw();
}

async function openPath(path) {
  const { parts, resources } = await readDocument(path);
  const raw = parts['content/main.json'];
  if (!raw) throw new Error('This document has no presentation content');

  model = new SlidesModel(JSON.parse(raw));
  model.path = path;
  undo = new UndoStack(model);

  // Images are read back and staged again, so a save after opening writes
  // them out unchanged rather than losing them.
  images = new Map();
  imageBytes = new Map();
  await clearStaged();
  for (const name of resources ?? []) {
    const bytes = await readResource(path, name);
    images.set(name, toDataUrl(bytes, name));
    imageBytes.set(name, bytes);
    await stagePart(name, bytes);
  }

  currentSlideId = model.slides[0].id;
  interaction.attach(model, currentSlideId);
  renderer.fit(model);
  draw();

  document.title = `${baseName(path)} — GRT Slides`;
  toast(`Opened ${baseName(path)} — ${model.slides.length} slide(s)`);
}

async function save(forceDialog) {
  let path = forceDialog ? null : model.path;
  if (!path) {
    path = await pickToSave(model.path ?? 'presentation.grt', FILTERS.grt, 'Save presentation');
    if (!path) return;
  }

  const manifest = {
    kind: 'slides',
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
  document.title = `${baseName(path)} — GRT Slides`;
  refresh();
  toast(`Saved ${baseName(path)}`);
}

async function exportDocument() {
  const confirmed = await showPanel('Export', `
    <div class="form-grid">
      <label for="ex-format">Format</label>
      <select id="ex-format" data-field="format">
        <option value="html">HTML — one file, opens anywhere</option>
        <option value="pdf">PDF — one page per slide</option>
        <option value="svg">SVG — the current slide</option>
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
    const pages = await Promise.all(
      model.slides.map((slide) =>
        renderToPdf(slideToPrintPage(model, slide.id, imageBytes), { audit: false })),
    );
    await writeBytes(path, await mergePdfPages(pages));
  }

  toast(`Exported ${baseName(path)}`);
}

/** Joins single-page PDFs into one document. */
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

// Importing a PowerPoint file

/** Imports a .pptx, then says plainly what it could not convert. */
async function importPptx(path) {
  const archive = await readZip(path);

  // Images are staged as they are found, so a save straight after an import
  // writes them into the container rather than losing them.
  const staged = new Map();
  for (const name of archive.binaries ?? []) {
    if (!name.startsWith('ppt/media/')) continue;
    try {
      const bytes = await readResource(path, name);
      const target = `resources/${name.split('/').pop()}`;
      await stagePart(target, bytes);
      staged.set(name, { target, url: toDataUrl(bytes, target) });
    } catch {
      // Recorded by the converter as a missing image rather than thrown here.
    }
  }

  const { document: imported, warnings } = convertPptx(archive, (name) => staged.get(name)?.url);

  // Point the elements at the resource names this program uses.
  for (const slide of imported.slides) {
    for (const element of slide.elements) {
      if (element.kind === 'image' && element.resource) {
        element.resource = staged.get(element.resource)?.target ?? null;
      }
    }
  }

  model = new SlidesModel(imported);
  model.path = null;                 // imported, not opened: Save asks where.
  undo = new UndoStack(model);
  images = new Map([...staged.values()].map((s) => [s.target, s.url]));

  currentSlideId = model.slides[0].id;
  interaction.attach(model, currentSlideId);
  renderer.fit(model);
  draw();
  document.title = `${baseName(path)} — GRT Slides`;

  await showPanel(`Imported ${escapeHtml(baseName(path))}`, `
    <p class="fp-note" style="margin-top:0">
      ${model.slides.length} slide(s) imported. What follows is what did
      <strong>not</strong> come across — listed rather than hidden, because a
      conversion that quietly drops things is discovered at the worst possible
      moment.
    </p>
    <ul class="problem-list">
      ${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
    </ul>
    <p class="fp-note">
      For exchanging a finished presentation, PDF or the self-contained HTML
      export lose nothing, because neither tries to stay editable.
    </p>`);
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
      <span class="label">Shrink text that does not fit
        <span class="hint">Off by default: text quietly getting smaller is an
        unwelcome surprise in front of an audience.</span>
      </span>
      <input type="checkbox" data-field="autoShrinkText" ${current.autoShrinkText ? 'checked' : ''} />
    </div>
    <p class="fp-note">${canPersist()
    ? 'Stored as a settings.json holding these four values. No record of which documents were opened.'
    : '<strong>Ephemeral mode:</strong> changes apply now but are not written to disk.'}</p>`,
  'Apply');
  if (!confirmed) return;

  const fields = readFields();
  const stored = await updateSettings(fields);
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
      own background keep it — an explicit choice on one slide should survive a
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
      inflate every export — that trade is still an open question.
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
    + `${p.label} — ${p.w}×${p.h}</option>`).join('')}
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
  });
  toast(`Updated ${ids.length} element(s)`);
}

// Command palette

function commands() {
  const entry = (label, hint, run) => ({ id: label, label, hint, run });

  return [
    entry('New presentation', 'Ctrl+N', () => newDocument()),
    entry('Open…', 'Ctrl+O', () => el('btn-open').click()),
    entry('Save', 'Ctrl+S', () => guard('Save', () => save(false))),
    entry('Save as…', 'Ctrl+Shift+S', () => guard('Save', () => save(true))),
    entry('Export…', '', () => guard('Export', exportDocument)),
    entry('Import PowerPoint…', '', () => el('btn-import-pptx').click()),
    entry('Slide size…', '', () => guard('Slide size', openCanvasSetup)),

    entry('Present from the first slide', 'F5', () => present(0)),
    entry('Present from this slide', 'Shift+F5', () => present()),
    entry('Open the presenter view', '', () => guard('Presenter', openPresenter)),

    entry('Add slide', 'Ctrl+M', () => addSlide()),
    entry('Duplicate slide', '', () => duplicateSlide()),
    entry('Delete slide', '', () => deleteSlide()),
    entry('Next slide', 'PageDown', () => stepSlide(1)),
    entry('Previous slide', 'PageUp', () => stepSlide(-1)),

    entry('Insert text box', '', () => addText()),
    entry('Insert image…', '', () => addImage()),
    entry('Insert shape', '', () => addShape()),
    entry('Insert table', '', () => addTable()),
    entry('Table rows and columns…', '', () => guard('Table', editTable)),
    entry('Section starting here…', '', () => guard('Section', editSection)),
    entry('Add a font…', '', () => guard('Font', addFont)),
    entry('Bring to front', '', () => reorder('front')),
    entry('Send to back', '', () => reorder('back')),
    entry('Delete selection', 'Del', () => deleteSelection()),

    ...['title', 'body', 'caption'].map((style) => entry(
      `Style: ${style}`, '', () => applyStyle(style),
    )),

    entry('Design: colours and fonts…', '', () => guard('Design', openDesign)),
    entry('This slide: background and transition…', '', () => guard('Slide', openSlideSetup)),
    entry('Colour of the selection…', '', () => guard('Look', openElementLook)),
    ...Object.entries(PRESETS).map(([id, preset]) => entry(
      `Look: ${preset.label}`, '', () => change(() => model.applyPreset(id)),
    )),
    ...TRANSITIONS.map((t) => entry(
      `Transition: ${t} (all slides)`, '', () => change(() => model.setAllTransitions(t)),
    )),

    entry('Undo', 'Ctrl+Z', () => step(-1)),
    entry('Redo', 'Ctrl+Y', () => step(1)),
    entry('Settings…', 'Ctrl+,', () => guard('Settings', openSettings)),
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
  const index = fromIndex ?? model.slides.findIndex((s) => s.id === currentSlideId);
  presentation.images = images;
  presentation.start(model, Math.max(0, index));
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

el('btn-new').onclick = () => newDocument();
el('btn-open').onclick = () => guard('Open', async () => {
  const path = await pickToOpen(
    [...FILTERS.grt, ...FILTERS.pptx], 'Open presentation or import PowerPoint',
  );
  if (!path) return;
  if (/\.pptx$/i.test(path)) await importPptx(path);
  else await openPath(path);
});
el('btn-import-pptx').onclick = () => guard('Import', async () => {
  const path = await pickToOpen(FILTERS.pptx, 'Import PowerPoint');
  if (path) await importPptx(path);
});
el('btn-save').onclick = () => guard('Save', () => save(false));
el('btn-save-as').onclick = () => guard('Save', () => save(true));
el('btn-export').onclick = () => guard('Export', exportDocument);
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

el('notes').oninput = (event) => {
  model.setNotes(currentSlideId, event.target.value);
  refresh();
};

document.addEventListener('keydown', (event) => {
  if (presentation.running || isDialogOpen() || isPaletteOpen()) return;

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
  } else if (ctrl && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    newDocument();
  } else if (ctrl && event.key.toLowerCase() === 's') {
    event.preventDefault();
    guard('Save', () => save(event.shiftKey));
  } else if (ctrl && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    el('btn-open').click();
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
  const deck = paths.find((p) => /\.grt$/i.test(p));
  if (deck) await openPath(deck);
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

  if (info.ephemeral) el('ephemeral-note').classList.remove('hidden');

  interaction.attach(model, currentSlideId);
  renderer.fit(model);
  draw();

  if (info.initialFile && await fileExists(info.initialFile)) {
    await guard('Open', () => openPath(info.initialFile));
  }
}());
