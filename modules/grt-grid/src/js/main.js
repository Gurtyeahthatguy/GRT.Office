/** Wiring. */

import { GridModel } from './model.js';
import { SheetController } from './controller.js';
import { GridView } from './grid.js';
import { showPanel, showChoice, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { readOds, writeOds } from './core/formats/ods.js';
import { readXlsx, writeXlsx } from './core/formats/xlsx.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme, isTheme } from './core/theme.js';
import { Keeper, MODES, isMode } from './core/keeper.js';
import { a1 } from './references.js';
import { formatValue } from './format.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { renderToPdf, mergePdfPages } from './core/pdf.js';
import {
  planPages, pageElements, pdfPages, parseArea, formatArea, parseRows, formatRows, printedArea,
} from './printing.js';
import * as io from './io.js';

const el = (id) => document.getElementById(id);

let model = new GridModel();
let sheet = null;
let view = null;
let path = null;
let runtime = { ephemeral: false, version: '0.0.0', initialFile: null };
let settings = { theme: 'system', autosave: 'recovery' };

/** Formats a spreadsheet can be saved back into. */
const WRITABLE = new Set(['grt', 'ods', 'fods', 'xlsx']);
const OPENABLE = /\.(grt|ods|fods|xlsx)$/i;

function formatOf(file) {
  return (/\.([^.\\/]+)$/.exec(file ?? '')?.[1] ?? '').toLowerCase() || null;
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
  name: () => (path ? io.baseName(path) : 'Untitled'),
  path: () => path,
  canSaveInPlace: () => !!path && WRITABLE.has(file.format) && (file.losses.length === 0 || file.confirmed),
  writeCopy: (target) => io.writeDocument(target, model.toJSON()),
  save: (options) => save(options),
  openRecovered: (file, meta) => openRecovered(file, meta),
  settle: () => {
    sheet.commitEdit();
    el('formula-input').blur();
  },
}, { program: 'GRT Grid', extension: 'grt', toast });

// Startup

async function start() {
  runtime = await io.runtimeInfo();
  settings = normaliseSettings(await io.readSettings());
  applyTheme(settings.theme);

  el('version').textContent = runtime.version;
  el('ephemeral').classList.toggle('hidden', !runtime.ephemeral);

  attach(new GridModel());
  wire();
  redraw();

  const initial = runtime.initialFile && OPENABLE.test(runtime.initialFile) && await io.fileExists(runtime.initialFile)
    ? runtime.initialFile : null;
  const recovered = await keeper.start({
    ephemeral: runtime.ephemeral, mode: settings.autosave, initialFile: initial,
  });
  if (initial && !recovered) await open(initial);
}

function normaliseSettings(raw) {
  return {
    theme: isTheme(raw?.theme) ? raw.theme : 'system',
    autosave: isMode(raw?.autosave) ? raw.autosave : 'recovery',
  };
}

/** Points the program at a document. */
function attach(next) {
  model = next;
  sheet = new SheetController(model, { onChange: onControllerChange });
  view?.dispose();
  view = new GridView(el('grid'), sheet);
  view.rebuildOffsets();
  keeper.watch(model);
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
  const format = formatOf(target);
  let result;
  try {
    if (format === 'ods') result = readOds(await readPackage(target));
    else if (format === 'xlsx') result = readXlsx(await readPackage(target));
    else if (format === 'fods') result = readOds(await io.readText(target));
    else result = { document: await io.readDocument(target), losses: null };
  } catch (error) {
    await io.notify(`Cannot open that file.\n\n${error.message ?? error}`, 'Open failed');
    return;
  }
  attach(new GridModel(result.document));
  path = target;
  file = { format: format ?? 'grt', losses: result.losses?.lines() ?? [], confirmed: false };
  document.title = `${io.baseName(target)} - GRT Grid`;
  redraw();
  if (result.losses && !result.losses.empty) {
    await showPanel(`Opened ${escapeHtml(io.baseName(target))}`, `
      <p class="hint">What follows did not come across, listed rather than dropped quietly.</p>
      ${result.losses.html()}
      <p class="hint">Saving over the file would lose these for good, so it asks
      first; saving as a GRT spreadsheet keeps everything that did come across.</p>`);
  }
}

/** New and Open drop the current document: ask first if it has unsaved work. */
async function newConfirmed() {
  if (!await keeper.confirmLeave()) return;
  attach(new GridModel());
  path = null;
  file = { format: 'grt', losses: [], confirmed: false };
  document.title = 'GRT Grid';
  redraw();
}

async function openConfirmed(target) {
  if (await keeper.confirmLeave()) await open(target);
}

/** Opens a recovery copy as the document it was, with its changes unsaved. */
async function openRecovered(copy, meta) {
  attach(new GridModel(await io.readDocument(copy)));
  path = meta.path ?? null;
  const format = formatOf(path) ?? 'grt';
  file = {
    format,
    losses: format === 'grt' ? [] : ['Anything the program could not read when the file was first opened'],
    confirmed: false,
  };
  model.dirty = true;
  redraw();
  toast(`Recovered ${meta.name || 'Untitled'}: save it to keep the changes`);
}

/** Saves the spreadsheet; silent, it asks and reports nothing. Resolves false when nothing was saved. */
const FORMAT_NAMES = {
  grt: 'GRT spreadsheet (.grt)',
  ods: 'OpenDocument spreadsheet (.ods)',
  xlsx: 'Excel workbook (.xlsx)',
  fods: 'Flat OpenDocument spreadsheet (.fods)',
};

/** Asks which format to save in, then where. */
async function chooseSaveTarget() {
  const current = WRITABLE.has(file.format) ? file.format : 'grt';
  const confirmed = await showPanel('Save as', `
    <label>Format<select data-field="format">
      ${Object.entries(FORMAT_NAMES).map(([id, label]) =>
    `<option value="${id}"${id === current ? ' selected' : ''}>${label}</option>`).join('')}
    </select></label>
    <p class="hint">A GRT spreadsheet keeps everything this program can do. The
    others open in LibreOffice and Excel, formulas included.</p>`, 'Choose file');
  if (!confirmed) return null;
  const { format } = readFields();
  const base = (path ?? 'spreadsheet').replace(/\.[^.\\/]*$/, '');
  const chosen = await io.pickToSave(io.baseName(`${base}.${format}`), io.FILTERS[format]);
  return chosen ? { destination: io.withExtension(chosen, format), format } : null;
}

async function writeAs(destination, format) {
  const json = model.toJSON();
  if (format === 'grt') return io.writeDocument(destination, json);
  if (format === 'fods') return io.writeText(destination, writeOds(json, { flat: true }).text);
  const { entries } = format === 'ods' ? writeOds(json) : writeXlsx(json);
  return writePackage(destination, entries);
}

async function save({ as = false, silent = false } = {}) {
  if (!silent) sheet.commitEdit();

  let destination = path;
  let format = file.format;
  if (as || !destination || !WRITABLE.has(format)) {
    if (silent) return false;
    const chosen = await chooseSaveTarget();
    if (!chosen) return false;
    ({ destination, format } = chosen);
  } else if (file.losses.length > 0 && !file.confirmed) {
    if (silent) return false;
    const choice = await showChoice(`Save over “${io.baseName(destination)}”?`, `
      <p>When it was opened, these did not come across. Saving over the file
      drops them from it for good:</p>
      <ul class="problem-list">${file.losses.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`, [
      { id: 'cancel', label: 'Cancel' },
      { id: 'copy', label: 'Save a copy…', primary: true },
      { id: 'over', label: 'Save over it' },
    ]);
    if (choice === 'copy') return save({ as: true });
    if (choice !== 'over') return false;
    file.confirmed = true;
  }

  const revision = keeper.revision;
  try {
    await writeAs(destination, format);
  } catch (error) {
    if (silent) throw error;
    await io.notify(`Cannot save.\n\n${error.message ?? error}`, 'Save failed');
    return false;
  }
  if (destination !== path || format !== file.format) file = { format, losses: [], confirmed: false };
  path = destination;
  document.title = `${io.baseName(destination)} - GRT Grid`;
  model.dirty = keeper.revision !== revision;
  sheet.undo.markSaved();
  redraw();
  await keeper.saved();
  return true;
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
      <option value="."${guess.decimal === '.' ? ' selected' : ''}>Full stop, 1.5</option>
      <option value=","${guess.decimal === ',' ? ' selected' : ''}>Comma, 1,5</option>
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

// Printing

function printControls(s) {
  const option = (value, label) => `<option value="${value}"${s.what === value ? ' selected' : ''}>${label}</option>`;
  const check = (field, label) => `<label><input type="checkbox" data-print-field="${field}"${s[field] ? ' checked' : ''} />${label}</label>`;
  return `
    <label>Print<select data-print-field="what">
      ${option('sheet', 'This sheet')}${option('all', 'All sheets')}${option('selection', 'The selection')}
    </select></label>
    ${pageControls(s, { margins: true })}
    ${check('fitWidth', 'Fit to width')}
    ${check('gridlines', 'Gridlines')}
    ${check('labels', 'Sheet name and page numbers')}
    <label>Print area<input type="text" data-print-field="area" value="${escapeHtml(s.area)}" placeholder="Everything" size="9" /></label>
    <label>Rows to repeat<input type="text" data-print-field="repeat" value="${escapeHtml(s.repeat)}" placeholder="None" size="5" /></label>`;
}

/** The active sheet's print settings as the preview's fields, and back. */
function fieldsFromPrint(print) {
  return { ...print, what: 'sheet', area: formatArea(print.area), repeat: formatRows(print.repeatRows) };
}

function printFromFields(s, before) {
  const area = s.area.trim() === '' ? null : parseArea(s.area) ?? before.area;
  const repeatRows = s.repeat.trim() === '' ? null : parseRows(s.repeat) ?? before.repeatRows;
  return {
    size: s.size, width: s.width, height: s.height, orientation: s.orientation, margin: s.margin,
    fitWidth: s.fitWidth, gridlines: s.gridlines, labels: s.labels, area, repeatRows,
  };
}

function printJobs(s) {
  const active = sheet.sheet;
  const own = { ...active.print, ...printFromFields(s, active.print) };
  const paper = { size: own.size, width: own.width, height: own.height, orientation: own.orientation, margin: own.margin };
  if (s.what === 'selection') return [{ sheet: active, setup: own, area: sheet.selection }];
  if (s.what === 'all') {
    return model.sheets.map((each) => (each === active
      ? { sheet: active, setup: own, area: own.area ?? active.usedBounds() }
      : { sheet: each, setup: { ...each.print, ...paper }, area: printedArea(each) }));
  }
  return [{ sheet: active, setup: own, area: own.area ?? active.usedBounds() }];
}

async function printSheets() {
  sheet.commitEdit();
  const active = sheet.sheet;
  const before = active.print;
  const final = await printPreview({
    title: 'Print',
    setup: fieldsFromPrint(before),
    controls: printControls,
    build: (s) => {
      const planned = planPages(printJobs(s));
      const { paper } = planned[0].layout;
      return { width: paper.width, height: paper.height, pages: pageElements(planned, model.styles) };
    },
  });
  // What was chosen for the sheet stays with it, and is saved with the file.
  sheet.setPrint(active.id, printFromFields(final, before));
}

async function exportPdf() {
  sheet.commitEdit();
  const destination = await io.pickToSave(io.withExtension(path ?? 'spreadsheet.grt', 'pdf'), io.FILTERS.pdf, 'Export PDF');
  if (!destination) return;
  // Every sheet, each on its own paper as its print settings say.
  const planned = planPages(model.sheets.map((each) => ({ sheet: each, setup: each.print, area: printedArea(each) })));
  const report = { replaced: 0 };
  const rendered = [];
  for (const page of pdfPages(planned, model.styles)) rendered.push(await renderToPdf(page, { audit: false, report }));
  await io.writeBytes(io.withExtension(destination, 'pdf'), await mergePdfPages(rendered));
  toast(report.replaced > 0
    ? `Exported ${planned.length} page(s), ${report.replaced} character(s) the PDF font cannot draw, replaced; printing to PDF keeps them`
    : `Exported ${planned.length} page(s)`, report.replaced > 0);
}

// Settings

async function openSettings() {
  const themes = THEMES.map((theme) => (
    `<option value="${theme.id}"${theme.id === settings.theme ? ' selected' : ''}>${theme.label}</option>`
  )).join('');

  const modes = MODES.map((mode) => (
    `<option value="${mode.id}"${mode.id === settings.autosave ? ' selected' : ''}>${mode.label}</option>`
  )).join('');

  const confirmed = await showPanel('Settings', `
    <label>Theme<select data-field="theme">${themes}</select></label>
    <label>Keep unsaved work<select data-field="autosave">${modes}</select></label>
    <p class="hint">Every couple of seconds of quiet. A recovery copy is offered
    back if the program closes unexpectedly; onto the file saves the
    spreadsheet itself, once it has a name.</p>
    <p class="hint">There is no scripting engine in this program and there will
    not be one. Macros are the historical infection vector for spreadsheets, and
    a spreadsheet that cannot run code cannot carry one.</p>
  `, 'Apply');

  if (!confirmed) return;
  settings = normaliseSettings({ ...settings, ...readFields() });
  applyTheme(settings.theme);
  keeper.setMode(settings.autosave);
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

  el('btn-new').onclick = () => newConfirmed();
  el('btn-open').onclick = async () => {
    const chosen = await io.pickToOpen(io.FILTERS.spreadsheets, 'Open spreadsheet');
    if (chosen) await openConfirmed(chosen);
  };
  el('btn-save').onclick = () => save();
  el('btn-undo').onclick = () => sheet.step(-1);
  el('btn-redo').onclick = () => sheet.step(1);
  el('btn-settings').onclick = () => openSettings();
  el('btn-import-csv').onclick = () => importCsv();
  el('btn-export-csv').onclick = () => exportCsv();
  el('btn-print').onclick = () => printSheets();

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
  if (event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    sheet.updateEdit(event.target.value);
    sheet.commitEdit();
    sheet.move(0, event.shiftKey ? -1 : 1);
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
  if (isDialogOpen() || isPaletteOpen() || isPrintPreviewOpen()) return;
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
      case 'p': event.preventDefault(); printSheets(); return;
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
    entry('Export PDF…', '', () => exportPdf()),
    entry('Print…', 'Ctrl+P', () => printSheets()),
    entry('Set the print area to the selection', '', () => {
      const { top, left, bottom, right } = sheet.selection;
      sheet.setPrint(sheet.sheetId, { area: { top, left, bottom, right } });
    }),
    entry('Clear the print area', '', () => sheet.setPrint(sheet.sheetId, { area: null })),
    entry('Repeat the selected rows on every page', '', () => {
      const { top, bottom } = sheet.selection;
      sheet.setPrint(sheet.sheetId, { repeatRows: { top, bottom } });
    }),
    entry('Page break above this row', '', () => sheet.toggleRowBreak()),
    entry('Page break left of this column', '', () => sheet.toggleColumnBreak()),
    entry('Remove page breaks', '', () => sheet.setPrint(sheet.sheetId, { rowBreaks: [], colBreaks: [] })),
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
