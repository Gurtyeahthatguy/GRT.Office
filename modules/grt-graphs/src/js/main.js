/** Application wiring. */

import { toMermaid, applyMermaid } from './diagram-text.js';
import { compareDiagrams, isSame } from './compare.js';
import { inspect } from './core/inspector.js';
import { graphFindings, cleanGraphCopy } from './inspect.js';
import { createMenubar, paletteEntries } from './core/menubar.js';
import { graphsMenus } from './menus.js';
import { drawTools } from './draw-tools.js';
import { GraphModel } from './model.js';
import { Renderer } from './render.js';
import { Interaction } from './interaction.js';
import { treeLayout } from './layout.js';
import { createProperties } from './core/properties.js';
import { aboutDialog, licencesDialog } from './core/about.js';
import { templateManager } from './core/template-manager.js';
import { searchEverywhere } from './core/everywhere.js';
import { applyShortcuts, customizeDialog } from './core/customize.js';
import { wireToolbars } from './core/toolbar.js';
import { NAMES as LANGUAGE_NAMES } from './core/language.js';
import { createSpellChecker } from './core/spelling.js';
import { spellingOverItems } from './core/spelling-items.js';
import { SHAPES, ROUTINGS, PORTS } from './model.js';
import { toSvg, toJson, toPng, toPrintPage } from './export.js';
import { renderToPdf } from './core/pdf.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { printablePages } from './printing.js';
import { UndoStack } from './core/undo.js';
import { showPanel, showChoice, readFields, isDialogOpen, escapeHtml } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { withPassword, passwordFields, wirePasswordFields, passwordFrom, canProtect, PROTECTION } from './core/protection.js';
import { readOdg, writeOdg } from './core/formats/odg.js';
import { readCanvas, writeCanvas } from './core/formats/canvas.js';
import { THEMES } from './core/theme.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { Keeper, MODES } from './core/keeper.js';
import { parseMermaid } from './mermaid.js';
import { loadSettings, updateSettings, settings, canPersist } from './settings.js';
import {
  pickToOpen, pickToSave, readDocument, writeDocument, writeText, writeBytes,
  readText, readBytes, fileExists, runtimeInfo, onFilesDropped, baseName, withExtension, FILTERS,
} from './io.js';
import {
  SOURCE_FILTERS, readSource, liveValue, liveText, liveForm, treeFromTable, planPanel, deadlinesIcs, criticalPath,
  dataTableHtml, dataFromTable,
} from './tools.js';
import { isTemplate, baseFormat, asTemplate } from './core/formats/templates.js';

const el = (id) => document.getElementById(id);

const canvas = el('canvas');
const renderer = new Renderer(canvas);
const interaction = new Interaction(canvas, renderer);

let model = new GraphModel();
let undo = new UndoStack(model);
let busy = false;

/** Formats a diagram can be saved back into. */
const WRITABLE = new Set(['grt', 'odg', 'fodg', 'canvas', 'otg']);
const OPENABLE = /\.(grt|odg|fodg|otg|canvas|json)$/i;

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

let commentsHidden = false;
/** The comparison shown, if one is. */
let comparison = null;

function draw() {
  renderer.draw(model, interaction.selection, { ...interaction.extras, hideComments: commentsHidden, diff: comparison });
  syncText();
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
  el('status-language').textContent = LANGUAGE_NAMES.get(settings().spellLanguage) ?? settings().spellLanguage ?? '';
  toolbars?.refresh();
  properties?.refresh();
}

/** The toolbars, wired once the menus exist. */
let toolbars = null;

// The properties sidebar

let properties = null;

/** What the sidebar shows: the node, the nodes, the connector or, with nothing selected, the diagram. */
function describeSelection() {
  const nodes = [...interaction.selection].map((id) => model.node(id)).filter(Boolean);
  const edges = [...interaction.selection].map((id) => model.edge(id)).filter(Boolean);
  const styles = Object.keys(model.styles).map((k) => [k, k]);
  const set = (mutate) => (value) => change(() => mutate(value));
  if (nodes.length === 1) {
    const node = nodes[0];
    const number = (label, key, row) => ({ label, kind: 'number', value: Math.round(node[key]), row, apply: set((v) => { if (Number.isFinite(v)) model.setNodeBounds(node.id, { ...node, [key]: v }); }) });
    return [
      { title: 'Node', fields: [
        { label: 'Text', kind: 'textarea', value: node.text, apply: set((v) => model.setText(node.id, v)) },
        { label: 'Shape', kind: 'select', value: node.shape, options: SHAPES.map((x) => [x, x]), apply: set((v) => model.setShape([node.id], v)) },
        { label: 'Style', kind: 'select', value: node.style, options: styles, apply: set((v) => model.setStyle([node.id], v)) },
      ] },
      { title: 'Place and size', fields: [number('X', 'x', 'xy'), number('Y', 'y', 'xy'), number('Width', 'w', 'wh'), number('Height', 'h', 'wh')] },
      { title: 'Data', fields: [
        ...Object.entries(node.data ?? {}).slice(0, 30).map(([key, value]) => ({ label: key, value: String(value), apply: set((v) => { node.data = { ...node.data, [key]: v }; model.dirty = true; }) })),
        { label: 'Duration in days', kind: 'number', value: node.data?.duration ?? '', min: 0, step: 0.5, apply: set((v) => { node.data = { ...node.data }; if (v === null) delete node.data.duration; else node.data.duration = String(v); model.dirty = true; }) },
      ] },
    ];
  }
  if (nodes.length > 1) {
    const ids = nodes.map((n) => n.id);
    const same = (key) => (nodes.every((n) => n[key] === nodes[0][key]) ? nodes[0][key] : '');
    return [{ title: `${nodes.length} nodes`, fields: [
      { label: 'Shape', kind: 'select', value: same('shape'), options: [['', '(mixed)'], ...SHAPES.map((x) => [x, x])], apply: set((v) => v && model.setShape(ids, v)) },
      { label: 'Style', kind: 'select', value: same('style'), options: [['', '(mixed)'], ...styles], apply: set((v) => v && model.setStyle(ids, v)) },
    ] }];
  }
  if (edges.length) {
    const edge = edges[0];
    const ports = PORTS.map((p) => [p, p]);
    return [{ title: edges.length === 1 ? 'Connector' : `${edges.length} connectors`, fields: [
      ...(edges.length === 1 ? [{ label: 'Label', value: edge.label, apply: set((v) => model.setEdgeLabel(edge.id, v)) }] : []),
      { label: 'Routing', kind: 'select', value: edge.routing, options: ROUTINGS.map((r) => [r, r]), apply: set((v) => model.setEdgeRouting(edges.map((e) => e.id), v)) },
      ...(edges.length === 1 ? [
        { label: 'Leaves from', kind: 'select', value: edge.fromPort, options: ports, row: 'ports', apply: set((v) => { edge.fromPort = v; model.dirty = true; }) },
        { label: 'Arrives at', kind: 'select', value: edge.toPort, options: ports, row: 'ports', apply: set((v) => { edge.toPort = v; model.dirty = true; }) },
      ] : []),
    ] }];
  }
  return [{ title: 'Diagram', fields: [
    { label: 'Grid size', kind: 'number', value: model.meta.gridSize, min: 2, max: 100, apply: set((v) => { if (v >= 2) model.meta.gridSize = v; }) },
    { label: 'Snap to the grid', kind: 'checkbox', value: model.meta.snapToGrid, apply: set((v) => { model.meta.snapToGrid = v; }) },
    { label: 'Project starts', value: model.meta.start ?? '', apply: set((v) => { model.meta.start = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; }) },
  ] }];
}

interaction.onChange = () => draw();
interaction.onSelectionChange = () => refresh();
interaction.newRouting = () => settings().defaultRouting;

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
  input.dataset.node = id;
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
  file = { format: 'grt', losses: [], confirmed: false, password: null };
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
async function loadGraph(path, password = null) {
  const parts = await readDocument(path, password);
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

  const opened = await withPassword(baseName(path), (password) => loadGraph(path, password));
  if (!opened) return;
  model.path = path;
  file = { format: 'grt', losses: [], confirmed: false, password: opened.password };
  document.title = `${baseName(path)} - GRT Graphs`;
  toast(`Opened ${baseName(path)}`);
}

/** Reads a drawing in another program's format, and says what did not come across. */
async function importDocument(path, given) {
  const template = isTemplate(given);
  const format = baseFormat(given);
  if (!['odg', 'fodg', 'canvas'].includes(format)) throw new Error(`GRT Graphs does not open .${format} files`);
  const opened = await withPassword(baseName(path), async (password) => {
    if (format === 'odg') return readOdg(await readPackage(path, { password }));
    if (format === 'fodg') return readOdg(await readText(path));
    return readCanvas(await readText(path));
  });
  if (!opened) return;
  const result = opened.value;

  model = new GraphModel(result.document);
  // A template starts a new drawing: nothing is saved back into it unless asked.
  model.path = template ? null : path;
  file = template ? { format: 'grt', losses: [], confirmed: false, password: null } : { format, losses: result.losses.lines(), confirmed: false, password: opened.password };
  undo = new UndoStack(model);
  keeper.watch(model);
  interaction.attach(model);
  renderer.fit(model);
  draw();
  document.title = template ? `Untitled, from ${baseName(path)} - GRT Graphs` : `${baseName(path)} - GRT Graphs`;

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
  const opened = await withPassword(meta.name || 'Untitled', (password) => loadGraph(copy, password));
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
  otg: 'OpenDocument drawing template (.otg)',
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
      OpenDocument drawings open in LibreOffice Draw, canvases in Obsidian; what
      they cannot hold is said before anything is written. Canvases and flat
      .fodg files cannot carry a password.</p>`, 'Choose file');
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
    const chosen = await pickToSave(withExtension(model.path ?? 'diagram', format), FILTERS[format], 'Save diagram');
    return chosen ? { path: withExtension(chosen, format), format, password: protection.password } : null;
  }
}

/** Writes the diagram in a format, and says what that format could not hold. */
async function writeAs(path, format, password = null) {
  if (format === 'grt') {
    await writeDocument(path, documentParts(), password);
    return [];
  }
  const json = model.toJSON();
  if (format === 'odg' || format === 'otg') {
    const { entries, losses } = writeOdg(json);
    await writePackage(path, format === 'otg' ? asTemplate(entries, format) : entries, { protection: PROTECTION[format], password });
    return losses.lines();
  }
  const { text, losses } = format === 'fodg' ? writeOdg(json, { flat: true }) : writeCanvas(json);
  await writeText(path, text);
  return losses.lines();
}

// The diagram as text, kept in step with the drawing both ways.

let textTimer = null;
function syncText() {
  const panel = el('diagram-text');
  const area = el('diagram-source');
  if (panel.hidden || document.activeElement === area) return;
  const text = toMermaid(model);
  if (area.value !== text) area.value = text;
}

function toggleDiagramText() {
  const panel = el('diagram-text');
  panel.hidden = !panel.hidden;
  syncText();
  if (!panel.hidden) el('diagram-source').focus();
}

el('diagram-source').addEventListener('input', () => {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    try {
      const before = model.snapshot();
      const { added, removed } = applyMermaid(model, el('diagram-source').value);
      interaction.onCommit(before);
      renderer.draw(model, interaction.selection, { ...interaction.extras, hideComments: commentsHidden, diff: comparison });
      refresh();
      el('diagram-status').textContent = `${model.nodes.length} node(s), ${model.edges.length} line(s)${added ? `; ${added} new` : ''}${removed ? `; ${removed} taken out` : ''}`;
    } catch (error) {
      el('diagram-status').textContent = error.message;
    }
  }, 500);
});
el('diagram-source').addEventListener('blur', () => syncText());

/** Tools, Compare Diagram: what changed from an older version, marked on the drawing until cleared. */
async function compareDiagram() {
  const path = await pickToOpen(FILTERS.diagrams, 'Compare with an older version');
  if (!path) return;
  const format = formatOf(path);
  let other;
  if (format === 'grt') {
    const opened = await withPassword(baseName(path), (password) => readDocument(path, password));
    if (!opened) return;
    other = JSON.parse(opened.value['content/main.json'] ?? '{}');
  } else if (format === 'fodg') other = readOdg(await readText(path)).document;
  else if (format === 'odg' || format === 'otg') other = readOdg(await readPackage(path)).document;
  else throw new Error(`Diagrams are compared with .grt or .odg files, not .${format}`);
  comparison = compareDiagrams(model, other);
  draw();
  if (isSame(comparison)) {
    comparison = null;
    draw();
    toast('No differences: the two diagrams are the same');
    return;
  }
  const c = comparison;
  toast(`${c.added.size} added, ${c.changed.size} changed, ${c.moved.size} moved, ${c.removed.length} taken away; ${c.addedEdges.size + c.changedEdges.size + c.removedEdges.length} line(s) differ. Tools, Clear Comparison removes the marks.`);
}

/** File, Inspect Document: what the diagram carries, and a clean copy without what is ticked. */
async function inspectDiagram() {
  const out = await inspect(graphFindings(model), { toast });
  if (!out) return;
  const confirmed = await showPanel('Clean copy', `
    <div class="form-grid"><label for="ic-format">Format</label>
    <select id="ic-format" data-field="format"><option value="odg">OpenDocument drawing (.odg)</option><option value="grt">GRT diagram (.grt)</option></select></div>`, 'Choose file');
  if (!confirmed) return;
  const { format } = readFields();
  const base = model.path ? model.path.replace(/(\.[^./\\]+)?$/, '-clean') : 'diagram-clean';
  const path = await pickToSave(withExtension(base, format), FILTERS[format], 'Write the clean copy to');
  if (!path) return;
  const copy = cleanGraphCopy(model, out);
  if (format === 'grt') {
    const parts = documentParts();
    parts['content/main.json'] = `${JSON.stringify(copy, null, 2)}\n`;
    await writeDocument(path, parts, null);
  } else await writePackage(path, writeOdg(copy).entries, {});
  toast(`Wrote the clean copy as ${baseName(path)}`);
}

/** Saves the diagram; silent, it asks and reports nothing. Resolves false when nothing was saved. */
/** A copy written elsewhere, the diagram open staying as it is; a template is one such copy. */
async function saveCopy(preferred = null) {
  const chosen = await chooseSaveTarget(preferred);
  if (!chosen) return;
  const lost = await writeAs(chosen.path, chosen.format, canProtect(chosen.format) ? chosen.password : null);
  toast(lost.length > 0 ? `Saved a copy as ${baseName(chosen.path)}, without: ${lost.join('; ')}` : `Saved a copy as ${baseName(chosen.path)}`);
}

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
  document.title = `${baseName(path)} - GRT Graphs`;
  refresh();
  if (!silent) toast(lost.length > 0 ? `Saved ${baseName(path)}, without: ${lost.join('; ')}` : `Saved ${baseName(path)}`);
  await keeper.saved();
  return true;
}

/**
 * Replaces the open document, laying it out when it arrives without
 * positions.
 */
function loadDocument(imported, path) {
  const positionless = imported.nodes.every((n) => n.x === undefined);

  model = new GraphModel(imported);
  model.path = path;
  file = { format: 'grt', losses: [], confirmed: false, password: null };
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
  return paletteEntries(menus).filter((entry) => entry.enabled());
}

// Live values, diagrams from tables, plans, data

const sourceIo = { readBytes, readText };

/** Sets the value the selected node shows, from a spreadsheet's cell or a value out of a table. */
async function liveValueDialog() {
  const id = [...interaction.selection].find((s) => model.node(s));
  if (!id) {
    toast('Select a node first');
    return;
  }
  const node = model.node(id);
  const path = node.live?.path ?? await pickToOpen(SOURCE_FILTERS, 'Where the value is');
  if (!path) return;
  const source = await readSource(path, sourceIo);
  if (!source.tables.length) {
    toast('There is no table in that file', true);
    return;
  }
  if (!await showPanel('Live value', liveForm(source, node.live ?? {}), 'Show it')) return;
  const fields = readFields();
  const live = { path, cell: fields.cell?.trim() || null, table: fields.table, column: fields.column, aggregate: fields.aggregate, where: fields.where, equals: fields.equals ?? '', template: fields.template || '{value}' };
  change(() => {
    node.live = live;
    model.setText(id, liveText(live, liveValue(source, live)));
  });
}

/** Reads every live node's value again, each source once. */
async function refreshValues() {
  const live = model.nodes.filter((n) => n.live?.path);
  if (!live.length) {
    toast('No node shows a live value');
    return;
  }
  const sources = new Map();
  const failed = [];
  for (const node of live) {
    if (!sources.has(node.live.path)) {
      sources.set(node.live.path, await readSource(node.live.path, sourceIo).catch(() => null));
    }
  }
  change(() => {
    for (const node of live) {
      const source = sources.get(node.live.path);
      if (!source) failed.push(baseName(node.live.path));
      else model.setText(node.id, liveText(node.live, liveValue(source, node.live)));
    }
  });
  toast(failed.length ? `Could not read ${[...new Set(failed)].join(', ')}` : `${live.length} value(s) read again`, failed.length > 0);
}

/** A tree of nodes from a table whose rows name their parent, laid out on arrival. */
async function diagramFromTable() {
  const path = await pickToOpen(SOURCE_FILTERS, 'The table to draw');
  if (!path) return;
  const source = await readSource(path, sourceIo);
  const tables = source.tables.filter((t) => t.columns.length);
  if (!tables.length) {
    toast('There is no table in that file', true);
    return;
  }
  if (!await showPanel('Diagram from a table', `<label>Table<select data-field="table">${tables.map((t) => `<option>${escapeHtml(t.name)}</option>`).join('')}</select></label>`, 'Next')) return;
  const table = tables.find((t) => t.name === readFields().table) ?? tables[0];
  const options = (chosen) => table.columns.map((c, i) => `<option${i === chosen ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  if (!await showPanel('Diagram from a table', `
    <p class="fp-note" style="margin-top:0">Each row becomes a node, joined to the row its parent column names.</p>
    <label>Each row's own key<select data-field="id">${options(0)}</select></label>
    <label>The key of its parent<select data-field="parent">${options(Math.min(2, table.columns.length - 1))}</select></label>
    <label>The text shown<select data-field="label">${options(Math.min(1, table.columns.length - 1))}</select></label>`, 'Draw')) return;
  const tree = treeFromTable(table, readFields());
  if (!tree.nodes.length) {
    toast('No rows to draw', true);
    return;
  }
  change(() => {
    const made = new Map();
    for (const item of tree.nodes) made.set(item.key, model.addNode({ x: 0, y: 0, text: item.text, data: item.data }));
    for (const [from, to] of tree.links) model.addEdge({ from: made.get(from).id, to: made.get(to).id, fromPort: 'bottom', toPort: 'top' });
    for (const [nodeId, point] of treeLayout(model)) {
      const node = model.node(nodeId);
      if (node && [...made.values()].includes(node)) { node.x = point.x; node.y = point.y; }
    }
  });
  renderer.fit(model);
  draw();
  toast(`${tree.nodes.length} node(s) drawn`);
}

/** Every node's data in one editable grid. */
async function dataTable() {
  if (!model.nodes.length) {
    toast('There are no nodes yet');
    return;
  }
  const { keys, html } = dataTableHtml(model);
  if (!await showPanel('Data table', html, 'Apply')) return;
  const updated = dataFromTable(model, keys, readFields());
  change(() => {
    for (const [nodeId, data] of updated) {
      const node = model.node(nodeId);
      if (node) node.data = data;
    }
  });
}

/** The critical path, highlighted on the diagram, and the Gantt chart beside the dates. */
async function showPlan() {
  const { plan, html } = planPanel(model);
  if (!plan.cycle) {
    interaction.selection = new Set([...plan.tasks.filter((t) => t.critical).map((t) => t.id), ...plan.edges]);
    draw();
  }
  const confirmed = await showPanel('Plan', html, plan.tasks.length ? 'Apply' : null);
  if (!confirmed) return;
  const start = readFields().start || null;
  if (start !== (model.meta.start ?? null)) change(() => { model.meta.start = start; });
}

/** The tasks' deadlines as a calendar file of to-dos, which Dates opens. */
async function sendDeadlines() {
  const plan = criticalPath(model, { start: model.meta.start ?? null });
  if (plan.cycle || !plan.tasks.length) {
    await showPlan();
    return;
  }
  if (!model.meta.start) {
    toast('Choose when the project starts, in Plan', true);
    await showPlan();
    return;
  }
  const name = baseName(model.path)?.replace(/\.[^.]+$/, '') ?? 'Project';
  const path = await pickToSave(`${name} deadlines.ics`, [{ name: 'Calendar', extensions: ['ics'] }], 'Deadlines for Dates');
  if (!path) return;
  await writeText(withExtension(path, 'ics'), deadlinesIcs(plan, { title: name }));
  toast('Saved. Open it in GRT Dates, or put it in the Dates folder.');
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

properties = createProperties(el('properties'), describeSelection);

/** Spelling with GRT's own dictionaries. */
const spellChecker = createSpellChecker();

const tools = drawTools({
  model: () => model,
  selected: () => [...interaction.selection].filter((id) => model.node(id) || model.edges.some((e) => e.id === id)),
  select: (ids) => { interaction.selection = new Set(ids); draw(); },
  change: (mutate) => change(mutate),
  toast: (message) => toast(message),
  reveal: (box) => {
    const area = canvas.getBoundingClientRect();
    renderer.view.x = box.x + box.w / 2 - area.width / renderer.view.scale / 2;
    renderer.view.y = box.y + box.h / 2 - area.height / renderer.view.scale / 2;
    renderer.applyView();
    draw();
  },
  centre: () => {
    const area = canvas.getBoundingClientRect();
    return renderer.toDiagram(area.left + area.width / 2, area.top + area.height / 2);
  },
  editText: (id) => editText(id),
  file: () => ({
    name: model.path ? baseName(model.path) : 'Untitled',
    location: model.path ? model.path.replace(/[/\\][^/\\]*$/, '') : 'Not saved yet',
    format: file.format,
  }),
  draw: () => draw(),
});

const menus = graphsMenus({
  tools,
  newFile: () => el('btn-new').click(),
  open: () => el('btn-open').click(),
  templates: () => templateManager({ extensions: ['otg'], open: openConfirmed, toast }),
  everywhere: () => searchEverywhere({ kind: 'graphs', open: openConfirmed, toast }),
  // The text of nodes and the labels of lines, as Find goes through them.
  spelling: () => spellingOverItems({
    checker: spellChecker,
    toast,
    language: () => settings().spellLanguage,
    setLanguage: (tag) => updateSettings({ spellLanguage: tag }),
    grammar: () => false,
    items: () => [
      ...model.nodes.map((n) => ({ key: `node|${n.id}`, label: 'Shape', text: n.text ?? '' })),
      ...model.edges.map((e) => ({ key: `edge|${e.id}`, label: 'Line', text: e.label ?? '' })),
    ],
    show: (issue) => { const [kind, id] = issue.item.key.split('|'); tools.show({ kind, id }); },
    replace: (key, from, to, text) => {
      const [kind, id] = key.split('|');
      change(() => {
        if (kind === 'node') { const node = model.node(id); if (node) model.setText(id, node.text.slice(0, from) + text + node.text.slice(to)); }
        else { const edge = model.edges.find((e) => e.id === id); if (edge) model.setEdgeLabel(id, edge.label.slice(0, from) + text + edge.label.slice(to)); }
      });
    },
  }),
  customize: async () => {
    const next = await customizeDialog(menus, settings().keyboard);
    if (!next) return;
    const stored = await updateSettings({ keyboard: applyShortcuts(menus, next) });
    toast(stored ? 'Shortcuts saved' : 'Shortcuts changed for this session only');
  },
  saveTemplate: () => guard('Save', () => saveCopy('otg')),
  reload: () => (model.path ? guard('Reload', () => openConfirmed(model.path)) : toast('This diagram has not been saved yet')),
  save: () => guard('Save', () => save(false)),
  saveAs: () => guard('Save', () => save(true)),
  saveCopy: () => guard('Save', () => saveCopy()),
  importJson: () => el('btn-import').click(),
  importMermaid: () => guard('Import', () => importMermaid()),
  exportDocument: () => guard('Export', exportDocument),
  print: () => guard('Print', printDiagram),
  undo: () => step(-1),
  redo: () => step(1),
  selectAll: () => { interaction.selection = new Set(model.nodes.map((n) => n.id)); draw(); },
  deleteSelection: () => deleteSelection(),
  toggleComments: () => { commentsHidden = !commentsHidden; draw(); },
  commentsShown: () => !commentsHidden,
  zoomIn: () => { renderer.zoomCentre(1.25); draw(); },
  zoomOut: () => { renderer.zoomCentre(1 / 1.25); draw(); },
  fit: () => { renderer.fit(model); draw(); },
  addNode: () => addNode(),
  diagramFromTable: () => guard('Diagram from a table', diagramFromTable),
  liveValue: () => guard('Live value', liveValueDialog),
  apply: (kind, value) => applyToSelection(kind, value),
  align: (how) => align(how),
  distribute: (axis) => distribute(axis),
  layout: () => runLayout(),
  validate: () => guard('Check', runValidation),
  plan: () => guard('Plan', showPlan),
  deadlines: () => guard('Deadlines', sendDeadlines),
  dataTable: () => guard('Data table', dataTable),
  refreshValues: () => guard('Refresh', refreshValues),
  settings: () => guard('Settings', openSettings),
  about: async () => aboutDialog({ name: 'GRT Graphs', version: (await runtimeInfo()).version }),
  licences: () => licencesDialog({ name: 'GRT Graphs' }),
  inspect: () => guard('Inspect', inspectDiagram),
  compare: () => guard('Compare', compareDiagram),
  clearComparison: () => { comparison = null; draw(); },
  comparing: () => Boolean(comparison),
  diagramText: () => toggleDiagramText(),
  diagramTextShown: () => !el('diagram-text').hidden,
});
createMenubar(el('menubar'), menus);
toolbars = wireToolbars(document.querySelector('.toolbars'), menus);

// A comment's mark opens it; Ctrl and a click on a linked node shows where the link goes.
canvas.addEventListener('mousedown', (event) => {
  const mark = event.target.closest?.('.comment-mark');
  if (mark) {
    event.preventDefault();
    event.stopImmediatePropagation();
    guard('Comment', () => tools.openComment(mark.dataset.comment));
    return;
  }
  const linked = event.target.closest?.('.node[data-href]');
  if (linked && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    tools.followLink(linked.dataset.id);
  }
}, true);
el('btn-align-left').onclick = () => align('left');
el('btn-align-centre').onclick = () => align('centre-x');
el('btn-align-top').onclick = () => align('top');
el('btn-distribute').onclick = () => distribute('horizontal');

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
  } else if (ctrl && event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    templateManager({ extensions: ['otg'], open: openConfirmed, toast });
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
  applyShortcuts(menus, settings().keyboard);

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
