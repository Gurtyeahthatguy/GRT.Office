/** Application wiring. */

import { GraphModel } from './model.js';
import { Renderer } from './render.js';
import { Interaction } from './interaction.js';
import { treeLayout } from './layout.js';
import { toSvg, toJson, toPng, toPrintPage } from './export.js';
import { renderToPdf } from './core/pdf.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { printablePages } from './printing.js';
import { UndoStack } from './core/undo.js';
import { showPanel, showChoice, readFields, isDialogOpen, escapeHtml } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { readOdg, writeOdg } from './core/formats/odg.js';
import { readCanvas, writeCanvas } from './core/formats/canvas.js';
import { THEMES } from './core/theme.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { Keeper, MODES } from './core/keeper.js';
import { parseMermaid } from './mermaid.js';
import { loadSettings, updateSettings, settings, canPersist } from './settings.js';
import {
  pickToOpen, pickToSave, readDocument, writeDocument, writeText, writeBytes,
  readText, fileExists, runtimeInfo, onFilesDropped, baseName, withExtension, FILTERS,
} from './io.js';

const el = (id) => document.getElementById(id);

const canvas = el('canvas');
const renderer = new Renderer(canvas);
const interaction = new Interaction(canvas, renderer);

let model = new GraphModel();
let undo = new UndoStack(model);
let busy = false;

/** Formats a diagram can be saved back into. */
const WRITABLE = new Set(['grt', 'odg', 'fodg', 'canvas']);
const OPENABLE = /\.(grt|odg|fodg|canvas|json)$/i;

function formatOf(path) {
  return (/\.([^.\\/]+)$/.exec(path ?? '')?.[1] ?? '').toLowerCase() || null;
}

/**
 * What the open file is: its format, what did not come across when it was
 * read, and whether saving over it anyway was agreed to.
 */
let file = { format: 'grt', losses: [], confirmed: false };

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
  writeCopy: (path) => writeDocument(path, documentParts()),
  save: (options) => save(false, options),
  openRecovered: (file, meta) => openRecovered(file, meta),
  // Leaving the label being typed commits it.
  settle: () => document.activeElement?.blur?.(),
}, { program: 'GRT Graphs', extension: 'grt', toast });

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
  renderer.draw(model, interaction.selection, interaction.extras);
  el('empty-state').classList.toggle('hidden', model.nodes.length > 0);
  refresh();
}

function refresh() {
  el('btn-undo').disabled = busy || !undo.canUndo;
  el('btn-redo').disabled = busy || !undo.canRedo;
  el('zoom-label').textContent = `${Math.round(renderer.view.scale * 100)}%`;

  const selected = interaction.selection.size;
  el('btn-delete').disabled = selected === 0;

  const parts = [];
  parts.push(`${model.nodes.length} node${model.nodes.length === 1 ? '' : 's'}`);
  parts.push(`${model.edges.length} link${model.edges.length === 1 ? '' : 's'}`);
  if (selected > 0) parts.push(`${selected} selected`);
  if (model.dirty) parts.push('unsaved changes');
  el('status').textContent = parts.join(' • ');
}

interaction.onChange = () => draw();
interaction.onSelectionChange = () => refresh();

/** One undo entry per gesture. */
interaction.onCommit = (before) => {
  undo.past.push(before);
  if (undo.past.length > undo.limit) undo.past.shift();
  undo.future.length = 0;
  refresh();
};

interaction.onEditText = (id) => editText(id);

// Text editing

function editText(id) {
  const node = model.node(id);
  if (!node) return;

  const input = el('text-editor');
  const scale = renderer.view.scale;

  // Positioned inside .workspace, which the canvas fills exactly.
  input.value = node.text;
  input.style.left = `${(node.x - renderer.view.x) * scale}px`;
  input.style.top = `${(node.y + node.h / 2 - 14 - renderer.view.y) * scale}px`;
  input.style.width = `${node.w * scale}px`;
  input.classList.remove('hidden');
  input.focus();
  input.select();

  const before = model.snapshot();

  const finish = (keep) => {
    input.classList.add('hidden');
    input.onblur = null;
    input.onkeydown = null;
    if (keep && input.value !== node.text) {
      model.setText(id, input.value);
      interaction.onCommit(before);
    }
    draw();
  };

  input.onblur = () => finish(true);
  input.onkeydown = (event) => {
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
    event.stopPropagation();
  };
}

// Editing commands

function change(mutate) {
  const before = model.snapshot();
  mutate();
  interaction.onCommit(before);
  draw();
}

function addNode() {
  change(() => {
    let x = Math.round(renderer.view.x + 80);
    let y = Math.round(renderer.view.y + 80);
    // A node already there would hide the new one.
    while (model.nodes.some((n) => n.x === x && n.y === y)) {
      x += 24;
      y += 24;
    }
    const node = model.addNode({ x, y });
    interaction.selection = new Set([node.id]);
  });
}

function deleteSelection() {
  const ids = [...interaction.selection];
  if (ids.length === 0) return;

  change(() => {
    const nodeIds = ids.filter((id) => model.node(id));
    const edgeIds = ids.filter((id) => model.edge(id));
    if (nodeIds.length > 0) model.deleteNodes(nodeIds);
    if (edgeIds.length > 0) model.deleteEdges(edgeIds);
    interaction.selection.clear();
  });
}

function step(direction) {
  if (direction > 0 ? undo.redo() : undo.undo()) {
    interaction.selection.clear();
    draw();
  }
}

function applyToSelection(kind, value) {
  if (!value) return;
  const ids = [...interaction.selection];
  if (ids.length === 0) {
    toast('Select something first');
    return;
  }

  change(() => {
    if (kind === 'shape') model.setShape(ids, value);
    else if (kind === 'style') model.setStyle(ids, value);
    else if (kind === 'routing') model.setEdgeRouting(ids, value);
  });
}

function runLayout() {
  change(() => {
    for (const [id, point] of treeLayout(model)) {
      const node = model.node(id);
      if (node) { node.x = point.x; node.y = point.y; }
    }
  });
  renderer.fit(model);
  draw();
  toast('Arranged as a tree');
}

function runValidation() {
  const { dangling, unreachable, cyclic } = model.validate();
  const problems = [];

  if (dangling.length > 0) {
    problems.push(`${dangling.length} connector(s) point at a node that no longer exists`);
  }
  if (unreachable.length > 0) {
    problems.push(`${unreachable.length} node(s) cannot be reached from any starting point`);
  }
  if (cyclic) {
    problems.push('Every node is part of a cycle; normal for a state machine, '
      + 'unusual for a flowchart');
  }

  showPanel('Check', problems.length === 0
    ? '<p class="fp-note" style="margin-top:0">Nothing to report.</p>'
    : `<ul class="problem-list">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
       <p class="fp-note">Reported, not enforced: a half-built diagram is a normal
       thing to have.</p>`);
}

// Files

function newDocument() {
  model = new GraphModel();
  file = { format: 'grt', losses: [], confirmed: false };
  undo = new UndoStack(model);
  keeper.watch(model);
  interaction.attach(model);
  renderer.view = { x: 0, y: 0, scale: 1 };
  renderer.applyView();
  document.title = 'GRT Graphs';
  draw();
}

/** New and Open drop the current document: ask first if it has unsaved work. */
async function newDocumentConfirmed() {
  if (await keeper.confirmLeave()) newDocument();
}

async function openConfirmed(path) {
  if (await keeper.confirmLeave()) await openPath(path);
}

/** Reads a diagram into the program, without naming it. */
async function loadGraph(path) {
  const parts = await readDocument(path);
  const raw = parts['content/main.json'];
  if (!raw) throw new Error('This document has no graph content');

  model = new GraphModel(JSON.parse(raw));
  undo = new UndoStack(model);
  keeper.watch(model);
  interaction.attach(model);
  renderer.fit(model);
  draw();
}

async function openPath(path) {
  const format = formatOf(path);
  // A graph generated or transformed by a script comes back in as JSON.
  if (format === 'json') {
    await importJsonFrom(path);
    return;
  }
  if (format !== 'grt') {
    await importDocument(path, format);
    return;
  }

  await loadGraph(path);
  model.path = path;
  file = { format: 'grt', losses: [], confirmed: false };
  document.title = `${baseName(path)} - GRT Graphs`;
  toast(`Opened ${baseName(path)}`);
}

/** Reads a drawing in another program's format, and says what did not come across. */
async function importDocument(path, format) {
  let result;
  if (format === 'odg') result = readOdg(await readPackage(path));
  else if (format === 'fodg') result = readOdg(await readText(path));
  else if (format === 'canvas') result = readCanvas(await readText(path));
  else throw new Error(`GRT Graphs does not open .${format} files`);

  model = new GraphModel(result.document);
  model.path = path;
  file = { format, losses: result.losses.lines(), confirmed: false };
  undo = new UndoStack(model);
  keeper.watch(model);
  interaction.attach(model);
  renderer.fit(model);
  draw();
  document.title = `${baseName(path)} - GRT Graphs`;

  if (result.losses.empty) {
    toast(`Opened ${baseName(path)}`);
    return;
  }
  await showPanel(`Opened ${escapeHtml(baseName(path))}`, `
    <p class="fp-note" style="margin-top:0">${model.nodes.length} node(s), ${model.edges.length} connector(s).
    What follows did not come across, listed rather than dropped quietly.</p>
    ${result.losses.html()}
    <p class="fp-note">Saving over the file would lose these for good, so it
    asks first; saving as a GRT document keeps everything that did come across.</p>`);
}

/** Opens a recovery copy as the document it was, with its changes unsaved. */
async function openRecovered(copy, meta) {
  await loadGraph(copy);
  model.path = meta.path ?? null;
  const format = formatOf(meta.path) ?? 'grt';
  file = {
    format,
    losses: format === 'grt' ? [] : ['Anything the program could not read when the file was first opened'],
    confirmed: false,
  };
  model.dirty = true;
  const name = meta.name || 'Untitled';
  document.title = `${name} (recovered) - GRT Graphs`;
  refresh();
  toast(`Recovered ${name}: save it to keep the changes`);
}

function documentParts() {
  const manifest = {
    kind: 'graphs',
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
  odg: 'OpenDocument drawing (.odg)',
  canvas: 'JSON Canvas (.canvas)',
  fodg: 'Flat OpenDocument drawing (.fodg)',
};

/** Asks which format to save in, then where. */
async function chooseSaveTarget() {
  const current = WRITABLE.has(file.format) ? file.format : 'grt';
  const confirmed = await showPanel('Save as', `
    <div class="form-grid">
      <label for="s-format">Format</label>
      <select id="s-format" data-field="format">
        ${Object.entries(FORMAT_NAMES).map(([id, label]) =>
    `<option value="${id}"${id === current ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <p class="fp-note">A GRT document keeps everything this program can do.
    OpenDocument drawings open in LibreOffice Draw, canvases in Obsidian; what
    they cannot hold is said before anything is written.</p>`, 'Choose file');
  if (!confirmed) return null;
  const { format } = readFields();
  const chosen = await pickToSave(withExtension(model.path ?? 'diagram', format), FILTERS[format], 'Save diagram');
  return chosen ? { path: withExtension(chosen, format), format } : null;
}

/** Writes the diagram in a format, and says what that format could not hold. */
async function writeAs(path, format) {
  if (format === 'grt') {
    await writeDocument(path, documentParts());
    return [];
  }
  const json = model.toJSON();
  if (format === 'odg') {
    const { entries, losses } = writeOdg(json);
    await writePackage(path, entries);
    return losses.lines();
  }
  const { text, losses } = format === 'fodg' ? writeOdg(json, { flat: true }) : writeCanvas(json);
  await writeText(path, text);
  return losses.lines();
}

/** Saves the diagram; silent, it asks and reports nothing. Resolves false when nothing was saved. */
async function save(forceDialog, { silent = false } = {}) {
  let path = forceDialog ? null : model.path;
  let format = file.format;
  if (!path) {
    if (silent) return false;
    const chosen = await chooseSaveTarget();
    if (!chosen) return false;
    ({ path, format } = chosen);
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
  const lost = await writeAs(path, format);

  const sameFile = path === model.path && format === file.format;
  model.path = path;
  file = sameFile ? file : { format, losses: [], confirmed: false };
  model.dirty = keeper.revision !== revision;
  undo.markSaved();
  document.title = `${baseName(path)} - GRT Graphs`;
  refresh();
  if (!silent) toast(lost.length > 0 ? `Saved ${baseName(path)}, without: ${lost.join('; ')}` : `Saved ${baseName(path)}`);
  await keeper.saved();
  return true;
}

/** Loads a graph from JSON. */
/**
 * Replaces the open document, laying it out when it arrives without
 * positions.
 */
function loadDocument(imported, path) {
  const positionless = imported.nodes.every((n) => n.x === undefined);

  model = new GraphModel(imported);
  model.path = path;
  file = { format: 'grt', losses: [], confirmed: false };
  undo = new UndoStack(model);
  interaction.attach(model);

  if (positionless) {
    for (const [id, point] of treeLayout(model)) {
      const node = model.node(id);
      if (node) { node.x = point.x; node.y = point.y; }
    }
  }
  model.dirty = true;
  keeper.watch(model);

  renderer.fit(model);
  draw();
  return positionless;
}

async function importJsonFrom(path) {
  // Not named `document`: that would shadow the page's own document object,
  // and the title assignment below would land on the parsed JSON instead.
  const imported = JSON.parse(await readText(path));
  if (!imported || !Array.isArray(imported.nodes)) {
    throw new Error('That JSON does not describe a graph');
  }

  // Imported, not opened: Save asks where to put it.
  const positionless = loadDocument(imported, null);

  document.title = `${baseName(path)} - GRT Graphs`;
  toast(positionless
    ? `Imported ${imported.nodes.length} node(s) and arranged them`
    : `Imported ${baseName(path)}`);
}

/** How the diagram was last printed, kept while the program runs. */
let printSetup = { mode: 'fit', size: 'A4', orientation: 'landscape', margin: 10 };

async function printDiagram() {
  document.activeElement?.blur?.();
  printSetup = await printPreview({
    title: 'Print',
    setup: printSetup,
    controls: (s) => `
      <label>Print<select data-print-field="mode">
        <option value="fit"${s.mode !== 'tiled' ? ' selected' : ''}>On one page</option>
        <option value="tiled"${s.mode === 'tiled' ? ' selected' : ''}>At full size, across pages</option>
      </select></label>
      ${pageControls(s, { margins: true })}`,
    build: (s) => printablePages(model, s),
  });
}

async function exportDocument() {
  const confirmed = await showPanel('Export', `
    <div class="form-grid">
      <label for="ex-format">Format</label>
      <select id="ex-format" data-field="format">
        <option value="svg">SVG: vector, opens anywhere</option>
        <option value="png">PNG: image</option>
        <option value="pdf">PDF: vector, for printing</option>
        <option value="json">JSON: the full document</option>
        <option value="json-logic">JSON: logic only, for a game</option>
      </select>
      <label for="ex-scale">PNG scale</label>
      <input id="ex-scale" type="number" data-field="scale" min="1" max="8" step="1" value="2" />
    </div>
    <p class="fp-note">
      The SVG is built from the document rather than from what is on screen, so
      it carries no selection state, no editing attributes, no software name and
      no date. The PDF goes through the suite's shared print engine, which is
      the same code that clears metadata in GRT Read. Logic-only JSON drops
      coordinates and colours, so a game does not have to read presentation to
      find the data on a node.
    </p>`, 'Choose file');
  if (!confirmed) return;

  const { format, scale } = readFields();
  const extension = format.startsWith('json') ? 'json' : format;
  const path = await pickToSave(
    withExtension(model.path, extension), FILTERS[extension], 'Export to',
  );
  if (!path) return;

  if (format === 'svg') {
    await writeText(path, toSvg(model));
  } else if (format === 'pdf') {
    // Through the shared engine, so the metadata clearing is the same code
    // GRT Read uses.
    const report = { replaced: 0 };
    await writeBytes(path, await renderToPdf(toPrintPage(model), { report }));
    if (report.replaced > 0) {
      toast(`Exported ${baseName(path)}, ${report.replaced} character(s) the PDF font cannot draw, replaced; printing to PDF keeps them`, true);
      return;
    }
  } else if (format === 'png') {
    await writeBytes(path, await toPng(toSvg(model), Math.max(1, scale || 2)));
  } else {
    await writeText(path, toJson(model, { logicOnly: format === 'json-logic' }));
  }

  toast(`Exported ${baseName(path)}`);
}

// Import from Mermaid

/** Mermaid arrives as text far more often than as a file. */
async function importMermaid(initialText = '') {
  const confirmed = await showPanel('Import Mermaid', `
    <p class="fp-note" style="margin-top:0">
      Paste a <code>graph</code> or <code>flowchart</code> diagram. Mermaid text
      carries no positions, so the result is arranged with the tree layout on
      arrival.
    </p>
    <textarea data-field="source" rows="10" spellcheck="false"
      style="width:100%;font:12px ui-monospace,monospace;background:var(--bg-sunken);
             color:var(--text);border:1px solid var(--border);border-radius:5px;padding:8px"
      placeholder="graph TD&#10;  A[Start] --> B{Choice}&#10;  B --&gt;|yes| C[Done]"
    >${escapeHtml(initialText)}</textarea>
    <p class="fp-note">
      Subgraphs come in as ordinary nodes: container nodes are deferred by
      design, so the grouping is lost but nothing else is.
    </p>`, 'Import');
  if (!confirmed) return;

  const { source } = readFields();
  if (!source?.trim()) return;

  const parsed = parseMermaid(source);
  if (!await keeper.confirmLeave()) return;
  loadDocument(parsed, null);
  toast(`Imported ${model.nodes.length} node(s) from Mermaid`);
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
      <span class="label">Snap to grid</span>
      <input type="checkbox" data-field="snapToGrid" ${current.snapToGrid ? 'checked' : ''} />
    </div>
    <div class="setting">
      <span class="label">Show the grid</span>
      <input type="checkbox" data-field="showGrid" ${current.showGrid ? 'checked' : ''} />
    </div>
    <div class="setting">
      <span class="label">Routing for new connectors</span>
      <select data-field="defaultRouting">
        ${option('orthogonal', 'Orthogonal', current.defaultRouting)}
        ${option('straight', 'Straight', current.defaultRouting)}
        ${option('curved', 'Curved', current.defaultRouting)}
      </select>
    </div>
    <div class="setting">
      <span class="label">Keep unsaved work
        <span class="hint">Every couple of seconds of quiet. A recovery copy
        is offered back if the program closes unexpectedly; onto the file
        saves the diagram itself, once it has a name.</span>
      </span>
      <select data-field="autosave">
        ${MODES.map((m) => option(m.id, m.label, current.autosave)).join('')}
      </select>
    </div>
    <p class="fp-note">${canPersist()
    ? 'Stored as a settings.json holding these five values. No record of which documents were opened.'
    : '<strong>Ephemeral mode:</strong> changes apply now but are not written to disk.'}</p>`,
  'Apply');
  if (!confirmed) return;

  const fields = readFields();
  const stored = await updateSettings(fields);
  keeper.setMode(settings().autosave);

  model.meta.snapToGrid = fields.snapToGrid;
  canvas.style.setProperty('--grid-visible', fields.showGrid ? '1' : '0');
  renderer.layers.grid.style.display = fields.showGrid ? '' : 'none';
  draw();

  toast(stored ? 'Settings saved' : 'Settings applied for this session only');
}

// Command palette

/** Every command the program has, in one list. */
function commands() {
  const selected = () => [...interaction.selection].filter((id) => model.node(id));
  const withSelection = (label, hint, run) => ({ id: label, label, hint, run });

  return [
    withSelection('New diagram', 'Ctrl+N', () => el('btn-new').click()),
    withSelection('Open…', 'Ctrl+O', () => el('btn-open').click()),
    withSelection('Save', 'Ctrl+S', () => guard('Save', () => save(false))),
    withSelection('Save as…', 'Ctrl+Shift+S', () => guard('Save', () => save(true))),
    withSelection('Export…', '', () => guard('Export', exportDocument)),
    withSelection('Print…', 'Ctrl+P', () => guard('Print', printDiagram)),
    withSelection('Import JSON…', '', () => el('btn-import').click()),
    withSelection('Import Mermaid…', '', () => guard('Import', () => importMermaid())),

    withSelection('Add node', 'Insert', () => addNode()),
    withSelection('Delete selection', 'Del', () => deleteSelection()),
    withSelection('Select all', 'Ctrl+A', () => {
      interaction.selection = new Set(model.nodes.map((n) => n.id));
      draw();
    }),

    withSelection('Align left', '', () => align('left')),
    withSelection('Align right', '', () => align('right')),
    withSelection('Align top', '', () => align('top')),
    withSelection('Align bottom', '', () => align('bottom')),
    withSelection('Align centres horizontally', '', () => align('centre-x')),
    withSelection('Align centres vertically', '', () => align('centre-y')),
    withSelection('Distribute horizontally', '', () => distribute('horizontal')),
    withSelection('Distribute vertically', '', () => distribute('vertical')),

    withSelection('Tree layout', '', () => runLayout()),
    withSelection('Check for problems', '', () => guard('Check', runValidation)),
    withSelection('Fit to view', 'Ctrl+0', () => { renderer.fit(model); draw(); }),
    withSelection('Undo', 'Ctrl+Z', () => step(-1)),
    withSelection('Redo', 'Ctrl+Y', () => step(1)),
    withSelection('Settings…', 'Ctrl+,', () => guard('Settings', openSettings)),

    ...['rect', 'rounded', 'ellipse', 'diamond', 'parallelogram', 'hexagon', 'triangle']
      .map((shape) => withSelection(
        `Shape: ${shape}`, `${selected().length} selected`,
        () => applyToSelection('shape', shape),
      )),
    ...['orthogonal', 'straight', 'curved'].map((routing) => withSelection(
      `Routing: ${routing}`, '', () => applyToSelection('routing', routing),
    )),
  ];
}

function align(how) {
  const ids = [...interaction.selection].filter((id) => model.node(id));
  if (ids.length < 2) {
    toast('Select two or more nodes first');
    return;
  }
  change(() => model.alignNodes(ids, how));
}

function distribute(axis) {
  const ids = [...interaction.selection].filter((id) => model.node(id));
  if (ids.length < 3) {
    toast('Select three or more nodes first');
    return;
  }
  change(() => model.distributeNodes(ids, axis));
}

// Events

el('btn-new').onclick = () => guard('New', newDocumentConfirmed);
el('btn-open').onclick = () => guard('Open', async () => {
  const path = await pickToOpen(FILTERS.diagrams, 'Open diagram');
  if (path) await openConfirmed(path);
});
el('btn-import').onclick = () => guard('Import', async () => {
  const path = await pickToOpen(FILTERS.json, 'Import JSON');
  if (path && await keeper.confirmLeave()) await importJsonFrom(path);
});
el('btn-commands').onclick = () => openPalette(commands());
el('btn-save').onclick = () => guard('Save', () => save(false));
el('btn-save-as').onclick = () => guard('Save', () => save(true));
el('btn-export').onclick = () => guard('Export', exportDocument);
el('btn-print').onclick = () => guard('Print', printDiagram);
el('btn-settings').onclick = () => guard('Settings', openSettings);
el('btn-undo').onclick = () => step(-1);
el('btn-redo').onclick = () => step(1);
el('btn-add').onclick = () => addNode();
el('btn-delete').onclick = () => deleteSelection();
el('btn-layout').onclick = () => runLayout();
el('btn-validate').onclick = () => guard('Check', runValidation);
el('btn-fit').onclick = () => { renderer.fit(model); draw(); };
el('btn-zoom-in').onclick = () => { renderer.zoomCentre(1.25); draw(); };
el('btn-zoom-out').onclick = () => { renderer.zoomCentre(1 / 1.25); draw(); };

for (const [id, kind] of [['shape-picker', 'shape'], ['style-picker', 'style'], ['routing-picker', 'routing']]) {
  el(id).onchange = (event) => {
    applyToSelection(kind, event.target.value);
    event.target.value = '';
  };
}

document.addEventListener('keydown', (event) => {
  if (isDialogOpen() || isPaletteOpen() || isPrintPreviewOpen()) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;

  const ctrl = event.ctrlKey || event.metaKey;

  if (ctrl && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette(commands());
  } else if (ctrl && event.key.toLowerCase() === 'n') {
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
    guard('Print', printDiagram);
  } else if (ctrl && event.key === ',') {
    event.preventDefault();
    guard('Settings', openSettings);
  } else if (ctrl && event.key === '0') {
    event.preventDefault();
    renderer.fit(model);
    draw();
  } else if (ctrl && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    interaction.selection = new Set(model.nodes.map((n) => n.id));
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
  } else if (event.key === 'Insert') {
    addNode();
  } else if (event.key === 'Escape') {
    interaction.selection.clear();
    draw();
  } else if (event.key === 'F2' && interaction.selection.size === 1) {
    editText([...interaction.selection][0]);
  }
});

onFilesDropped((paths) => guard('Open', async () => {
  const found = paths.find((p) => OPENABLE.test(p));
  if (found) await openConfirmed(found);
}));

window.addEventListener('resize', () => draw());

// Startup

(async function start() {
  const info = await runtimeInfo();
  const prefs = await loadSettings(info.ephemeral);

  if (info.ephemeral) el('ephemeral-note').classList.remove('hidden');
  model.meta.snapToGrid = prefs.snapToGrid;
  renderer.layers.grid.style.display = prefs.showGrid ? '' : 'none';

  interaction.attach(model);
  keeper.watch(model);
  draw();

  const initial = info.initialFile && OPENABLE.test(info.initialFile) && await fileExists(info.initialFile)
    ? info.initialFile : null;
  const recovered = await keeper.start({
    ephemeral: info.ephemeral, mode: prefs.autosave, initialFile: initial,
  });
  if (initial && !recovered) {
    await guard('Open', () => openPath(initial));
  }
}());
