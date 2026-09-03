/** Wiring. */

import { GridModel } from './model.js';
import { SheetController } from './controller.js';
import { GridView } from './grid.js';
import { showPanel, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme, isTheme } from './core/theme.js';
import { a1 } from './references.js';
import { formatValue } from './format.js';
import * as io from './io.js';

const el = (id) => document.getElementById(id);

let model = new GridModel();
let sheet = null;
let view = null;
let path = null;
let runtime = { ephemeral: false, version: '0.0.0', initialFile: null };
let settings = { theme: 'system' };

// Startup

async function start() {
  runtime = await io.runtimeInfo();
  settings = normaliseSettings(await io.readSettings());
  applyTheme(settings.theme);

  el('version').textContent = runtime.version;
  el('ephemeral').classList.toggle('hidden', !runtime.ephemeral);

  attach(new GridModel());

  if (runtime.initialFile && await io.fileExists(runtime.initialFile)) {
    await open(runtime.initialFile);
  }

  wire();
  redraw();
}

function normaliseSettings(raw) {
  return { theme: isTheme(raw?.theme) ? raw.theme : 'system' };
}

/** Points the program at a document. */
function attach(next) {
  model = next;
  sheet = new SheetController(model, { onChange: onControllerChange });
  view = new GridView(el('grid'), sheet);
  view.rebuildOffsets();
}

function onControllerChange(info) {
  if (info.edited || info.sheet) view?.rebuildOffsets();
  redraw();
}

// Drawing

function redraw() {
  view.draw();
  drawFormulaBar();
  drawSheetTabs();
  drawSummary();

  el('btn-undo').disabled = !sheet.undo.canUndo;
  el('btn-redo').disabled = !sheet.undo.canRedo;
}

function drawFormulaBar() {
  el('name-box').textContent = sheet.selectionLabel;
  const input = el('formula-input');
  if (document.activeElement !== input) input.value = sheet.activeText;
}

function drawSheetTabs() {
  const tabs = el('sheet-tabs');
  tabs.replaceChildren(...model.sheets.map((each) => {
    const button = document.createElement('button');
    button.className = 'sheet-tab';
    button.textContent = each.name;
    button.dataset.sheet = each.id;
    button.classList.toggle('active', each.id === model.activeSheetId);
    return button;
  }));
}

/** What the status bar says about the selection. */
function drawSummary() {
  const { top, bottom, left, right } = sheet.selection;
  const numbers = [];

  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      const value = sheet.sheet.valueAt(row, col);
      if (typeof value === 'number') numbers.push(value);
    }
  }

  if (numbers.length === 0) { el('summary').textContent = ''; return; }

  const total = numbers.reduce((a, b) => a + b, 0);
  el('summary').textContent =
    `Count ${numbers.length} · Sum ${formatValue(total)} · Average ${formatValue(total / numbers.length)}`;
}

// Files

async function open(target) {
  try {
    attach(new GridModel(await io.readDocument(target)));
    path = target;
    redraw();
  } catch (error) {
    await io.notify(`Cannot open that file.\n\n${error}`, 'Open failed');
  }
}

async function save({ as = false } = {}) {
  sheet.commitEdit();

  let destination = path;
  if (as || !destination) {
    destination = await io.pickToSave(io.baseName(path ?? 'spreadsheet.grt'));
    if (!destination) return false;
    destination = io.withExtension(destination, 'grt');
  }

  try {
    await io.writeDocument(destination, model.toJSON());
    path = destination;
    model.dirty = false;
    redraw();
    return true;
  } catch (error) {
    await io.notify(`Cannot save.\n\n${error}`, 'Save failed');
    return false;
  }
}

/** Imports a CSV file, having asked how it is punctuated. */
async function importCsv() {
  const source = await io.pickToOpen(io.FILTERS.csv, 'Import CSV');
  if (!source) return;

  const text = await io.readText(source);
  const guess = SheetController.inspectCsv(text);

  const confirmed = await showPanel('Import CSV', `
    <p class="hint">${escapeHtml(guess.reason)}</p>
    <label>Separator<select data-field="separator">
      <option value=","${guess.separator === ',' ? ' selected' : ''}>Comma</option>
      <option value=";"${guess.separator === ';' ? ' selected' : ''}>Semicolon</option>
      <option value="&#9;"${guess.separator === '\t' ? ' selected' : ''}>Tab</option>
    </select></label>
    <label>Decimal point<select data-field="decimal">
      <option value="."${guess.decimal === '.' ? ' selected' : ''}>Full stop — 1.5</option>
      <option value=","${guess.decimal === ',' ? ' selected' : ''}>Comma — 1,5</option>
    </select></label>
    <p class="hint">This replaces everything on the current sheet.</p>
  `, 'Import');

  if (!confirmed) return;

  const fields = readFields();
  const result = sheet.importCsv(text, { separator: fields.separator, decimal: fields.decimal });
  redraw();
  await io.notify(`${result.rows} row(s), ${result.columns} column(s).`, 'Imported');
}

async function exportCsv() {
  const destination = await io.pickToSave('sheet.csv', io.FILTERS.csv, 'Export CSV');
  if (!destination) return;
  await io.writeText(io.withExtension(destination, 'csv'), sheet.exportCsv());
  await io.notify('Saved. Formulas were exported as their calculated values.', 'Exported');
}

// Settings

async function openSettings() {
  const themes = THEMES.map((theme) => (
    `<option value="${theme.id}"${theme.id === settings.theme ? ' selected' : ''}>${theme.label}</option>`
  )).join('');

  const confirmed = await showPanel('Settings', `
    <label>Theme<select data-field="theme">${themes}</select></label>
    <p class="hint">There is no scripting engine in this program and there will
    not be one. Macros are the historical infection vector for spreadsheets, and
    a spreadsheet that cannot run code cannot carry one.</p>
  `, 'Apply');

  if (!confirmed) return;
  settings.theme = readFields().theme;
  applyTheme(settings.theme);
  io.writeSettings(settings);
}

// Wiring

function wire() {
  el('grid').addEventListener('scroll', () => view.draw(), { passive: true });
  el('grid').addEventListener('mousedown', onGridMouseDown);
  el('grid').addEventListener('dblclick', onGridDoubleClick);

  el('formula-input').addEventListener('focus', () => sheet.beginEdit());
  el('formula-input').addEventListener('input', (event) => sheet.updateEdit(event.target.value));
  el('formula-input').addEventListener('keydown', onFormulaKey);

  el('btn-new').onclick = () => { attach(new GridModel()); path = null; redraw(); };
  el('btn-open').onclick = async () => {
    const chosen = await io.pickToOpen();
    if (chosen) await open(chosen);
  };
  el('btn-save').onclick = () => save();
  el('btn-undo').onclick = () => sheet.step(-1);
  el('btn-redo').onclick = () => sheet.step(1);
  el('btn-settings').onclick = () => openSettings();
  el('btn-import-csv').onclick = () => importCsv();
  el('btn-export-csv').onclick = () => exportCsv();

  el('style-picker').onchange = (event) => {
    sheet.applyStyle(event.target.value);
  };

  el('btn-insert-row').onclick = () => sheet.insertRows(sheet.selection.top, rowsSelected());
  el('btn-insert-col').onclick = () => sheet.insertColumns(sheet.selection.left, colsSelected());
  el('btn-delete-row').onclick = () => sheet.deleteRows(sheet.selection.top, rowsSelected());
  el('btn-delete-col').onclick = () => sheet.deleteColumns(sheet.selection.left, colsSelected());

  el('btn-add-sheet').onclick = () => sheet.addSheet();
  el('sheet-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-sheet]');
    if (tab) sheet.switchSheet(tab.dataset.sheet);
  });

  document.addEventListener('keydown', onKey);
  document.addEventListener('copy', onCopy);
  document.addEventListener('paste', onPaste);
  document.addEventListener('cut', onCut);
}

const rowsSelected = () => sheet.selection.bottom - sheet.selection.top + 1;
const colsSelected = () => sheet.selection.right - sheet.selection.left + 1;

function onGridMouseDown(event) {
  const head = event.target.closest('.column-head, .row-head');
  if (head) {
    if (head.dataset.col !== undefined) sheet.selectColumn(Number(head.dataset.col));
    else sheet.selectRow(Number(head.dataset.row));
    return;
  }

  const cell = event.target.closest('.cell');
  if (!cell) return;
  sheet.select(Number(cell.dataset.row), Number(cell.dataset.col), { extend: event.shiftKey });
}

function onGridDoubleClick(event) {
  const cell = event.target.closest('.cell');
  if (!cell) return;
  sheet.select(Number(cell.dataset.row), Number(cell.dataset.col));
  el('formula-input').focus();
}

/** Keys pressed in the formula bar. */
function onFormulaKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    sheet.updateEdit(event.target.value);
    sheet.commitEdit();
    sheet.move(1, 0);
    view.revealActive();
    el('formula-input').blur();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    sheet.cancelEdit();
    el('formula-input').value = sheet.activeText;
    el('formula-input').blur();
  }
}

function onKey(event) {
  if (isDialogOpen() || isPaletteOpen()) return;
  if (document.activeElement === el('formula-input')) return;

  const control = event.ctrlKey || event.metaKey;

  if (control) {
    switch (event.key.toLowerCase()) {
      case 'z': event.preventDefault(); sheet.step(-1); return;
      case 'y': event.preventDefault(); sheet.step(1); return;
      case 's': event.preventDefault(); save({ as: event.shiftKey }); return;
      case 'o': event.preventDefault(); el('btn-open').click(); return;
      case 'n': event.preventDefault(); el('btn-new').click(); return;
      case 'd': event.preventDefault(); sheet.fillDown(); return;
      case 'k': event.preventDefault(); openPalette(commands()); return;
      default: break;
    }
  }

  const moves = {
    ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  };

  if (moves[event.key]) {
    event.preventDefault();
    const [rowDelta, colDelta] = moves[event.key];
    sheet.move(rowDelta, colDelta, { extend: event.shiftKey, jump: control });
    view.revealActive();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    sheet.move(event.shiftKey ? -1 : 1, 0);
    view.revealActive();
    return;
  }

  if (event.key === 'Tab') {
    event.preventDefault();
    sheet.move(0, event.shiftKey ? -1 : 1);
    view.revealActive();
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    sheet.clearSelection();
    return;
  }

  if (event.key === 'F2') {
    event.preventDefault();
    el('formula-input').focus();
    return;
  }

  // A printable character starts an edit, replacing what was there.
  if (event.key.length === 1 && !control && !event.altKey) {
    event.preventDefault();
    sheet.beginEdit(event.key);
    const input = el('formula-input');
    input.value = event.key;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// Clipboard

let held = null;

function onCopy(event) {
  if (document.activeElement === el('formula-input')) return;
  held = sheet.copy();
  event.clipboardData?.setData('text/plain', held.text);
  event.preventDefault();
}

function onCut(event) {
  if (document.activeElement === el('formula-input')) return;
  onCopy(event);
  sheet.clearSelection();
}

function onPaste(event) {
  if (document.activeElement === el('formula-input')) return;
  event.preventDefault();

  const text = event.clipboardData?.getData('text/plain') ?? '';

  // Something copied inside this program keeps its formulas, which then
  // translate.
  if (held && held.text === text) sheet.paste(held);
  else sheet.paste({ text });
}

function commands() {
  const entry = (label, hint, run) => ({ id: label, label, hint, run });
  return [
    entry('New spreadsheet', 'Ctrl+N', () => el('btn-new').click()),
    entry('Open…', 'Ctrl+O', () => el('btn-open').click()),
    entry('Save', 'Ctrl+S', () => save()),
    entry('Save as…', 'Ctrl+Shift+S', () => save({ as: true })),
    entry('Import CSV…', '', () => importCsv()),
    entry('Export CSV…', '', () => exportCsv()),
    entry('Fill down', 'Ctrl+D', () => sheet.fillDown()),
    entry('Insert row', '', () => sheet.insertRows(sheet.selection.top, rowsSelected())),
    entry('Insert column', '', () => sheet.insertColumns(sheet.selection.left, colsSelected())),
    entry('Delete row', '', () => sheet.deleteRows(sheet.selection.top, rowsSelected())),
    entry('Delete column', '', () => sheet.deleteColumns(sheet.selection.left, colsSelected())),
    entry('Add sheet', '', () => sheet.addSheet()),
    entry('Undo', 'Ctrl+Z', () => sheet.step(-1)),
    entry('Redo', 'Ctrl+Y', () => sheet.step(1)),
    entry('Settings…', '', () => openSettings()),
  ];
}

export { a1 };

start();
