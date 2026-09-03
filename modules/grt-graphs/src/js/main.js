/** Application wiring. */

import { GraphModel } from './model.js';
import { Renderer } from './render.js';
import { Interaction } from './interaction.js';
import { treeLayout } from './layout.js';
import { toSvg, toJson, toPng, toPrintPage } from './export.js';
import { renderToPdf } from './core/pdf.js';
import { UndoStack } from './core/undo.js';
import { showPanel, readFields, isDialogOpen, escapeHtml } from './core/panel.js';
import { THEMES } from './core/theme.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
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
    const node = model.addNode({
      x: Math.round(renderer.view.x + 80),
      y: Math.round(renderer.view.y + 80),
    });
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
  undo = new UndoStack(model);
  interaction.attach(model);
  renderer.view = { x: 0, y: 0, scale: 1 };
  renderer.applyView();
  document.title = 'GRT Graphs';
  draw();
}

async function openPath(path) {
  // A graph generated or transformed by a script comes back in as JSON.
  if (/\.json$/i.test(path)) {
    await importJsonFrom(path);
    return;
  }

  const parts = await readDocument(path);
  const raw = parts['content/main.json'];
  if (!raw) throw new Error('This document has no graph content');

  model = new GraphModel(JSON.parse(raw));
  model.path = path;
  undo = new UndoStack(model);
  interaction.attach(model);
  renderer.fit(model);
  draw();

  document.title = `${baseName(path)} — GRT Graphs`;
  toast(`Opened ${baseName(path)}`);
}

async function save(forceDialog) {
  let path = forceDialog ? null : model.path;
  if (!path) {
    path = await pickToSave(model.path ?? 'diagram.grt', FILTERS.grt, 'Save diagram');
    if (!path) return;
  }

  const manifest = {
    kind: 'graphs',
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
  document.title = `${baseName(path)} — GRT Graphs`;
  refresh();
  toast(`Saved ${baseName(path)}`);
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
  undo = new UndoStack(model);
  interaction.attach(model);

  if (positionless) {
    for (const [id, point] of treeLayout(model)) {
      const node = model.node(id);
      if (node) { node.x = point.x; node.y = point.y; }
    }
    model.dirty = true;
  }

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

  document.title = `${baseName(path)} — GRT Graphs`;
  toast(positionless
    ? `Imported ${imported.nodes.length} node(s) and arranged them`
    : `Imported ${baseName(path)}`);
}

async function exportDocument() {
  const confirmed = await showPanel('Export', `
    <div class="form-grid">
      <label for="ex-format">Format</label>
      <select id="ex-format" data-field="format">
        <option value="svg">SVG — vector, opens anywhere</option>
        <option value="png">PNG — image</option>
        <option value="pdf">PDF — vector, for printing</option>
        <option value="json">JSON — the full document</option>
        <option value="json-logic">JSON — logic only, for a game</option>
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
    await writeBytes(path, await renderToPdf(toPrintPage(model)));
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

  loadDocument(parseMermaid(source), null);
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
    <p class="fp-note">${canPersist()
    ? 'Stored as a settings.json holding these four values. No record of which documents were opened.'
    : '<strong>Ephemeral mode:</strong> changes apply now but are not written to disk.'}</p>`,
  'Apply');
  if (!confirmed) return;

  const fields = readFields();
  const stored = await updateSettings(fields);

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
    withSelection('New diagram', 'Ctrl+N', () => newDocument()),
    withSelection('Open…', 'Ctrl+O', () => el('btn-open').click()),
    withSelection('Save', 'Ctrl+S', () => guard('Save', () => save(false))),
    withSelection('Save as…', 'Ctrl+Shift+S', () => guard('Save', () => save(true))),
    withSelection('Export…', '', () => guard('Export', exportDocument)),
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

el('btn-new').onclick = () => newDocument();
el('btn-open').onclick = () => guard('Open', async () => {
  const path = await pickToOpen(
    [...FILTERS.grt, ...FILTERS.json], 'Open diagram or import JSON',
  );
  if (path) await openPath(path);
});
el('btn-import').onclick = () => guard('Import', async () => {
  const path = await pickToOpen(FILTERS.json, 'Import JSON');
  if (path) await importJsonFrom(path);
});
el('btn-commands').onclick = () => openPalette(commands());
el('btn-save').onclick = () => guard('Save', () => save(false));
el('btn-save-as').onclick = () => guard('Save', () => save(true));
el('btn-export').onclick = () => guard('Export', exportDocument);
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
  if (isDialogOpen() || isPaletteOpen()) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;

  const ctrl = event.ctrlKey || event.metaKey;

  if (ctrl && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette(commands());
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

onFilesDropped((paths) => guard('Open', () => openPath(paths[0])));

window.addEventListener('resize', () => draw());

// Startup

(async function start() {
  const info = await runtimeInfo();
  const prefs = await loadSettings(info.ephemeral);

  if (info.ephemeral) el('ephemeral-note').classList.remove('hidden');
  model.meta.snapToGrid = prefs.snapToGrid;
  renderer.layers.grid.style.display = prefs.showGrid ? '' : 'none';

  interaction.attach(model);
  draw();

  const initial = info.initialFile;
  if (initial && await fileExists(initial)) {
    await guard('Open', () => openPath(initial));
  }
}());
