/** Wiring. */

import { GridModel } from './model.js';
import { SheetController } from './controller.js';
import { GridView } from './grid.js';
import { showPanel, showChoice, readFields, escapeHtml, isDialogOpen } from './core/panel.js';
import { readPackage, writePackage } from './core/package.js';
import { withPassword, passwordFields, wirePasswordFields, passwordFrom, canProtect, PROTECTION } from './core/protection.js';
import { readOds, writeOds } from './core/formats/ods.js';
import { readXlsx, writeXlsx } from './core/formats/xlsx.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import { THEMES, applyTheme, isTheme } from './core/theme.js';
import { Keeper, MODES, isMode } from './core/keeper.js';
import { a1, cycleReference } from './references.js';
import { formatValue } from './format.js';
import { printPreview, pageControls, isPrintPreviewOpen } from './core/print.js';
import { renderToPdf, mergePdfPages } from './core/pdf.js';
import {
  planPages, pageElements, pdfPages, parseArea, formatArea, parseRows, formatRows, printedArea,
} from './printing.js';
import * as io from './io.js';
import { isTemplate, baseFormat, asTemplate } from './core/formats/templates.js';
import { createMenubar, paletteEntries, showContextMenu } from './core/menubar.js';
import * as sheets from './sheets.js';
import { templateManager } from './core/template-manager.js';
import { gridMenus } from './menus.js';
import * as dialogs from './dialogs.js';
import { chartSvg } from './core/charts.js';
import { chartSpec, chartFromArea } from './charts.js';
import { createProperties } from './core/properties.js';
import { aboutDialog, licencesDialog } from './core/about.js';
import { FUNCTIONS } from './functions/index.js';

const el = (id) => document.getElementById(id);

let model = new GridModel();
let sheet = null;
let view = null;
let path = null;
let runtime = { ephemeral: false, version: '0.0.0', initialFile: null };
let settings = { theme: 'system', autosave: 'recovery' };

/** Formats a spreadsheet can be saved back into. */
const WRITABLE = new Set(['grt', 'ods', 'fods', 'xlsx', 'ots', 'xltx']);
const OPENABLE = /\.(grt|ods|fods|xlsx|ots|xltx|xltm)$/i;

function formatOf(file) {
  return (/\.([^.\\/]+)$/.exec(file ?? '')?.[1] ?? '').toLowerCase() || null;
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
  name: () => (path ? io.baseName(path) : 'Untitled'),
  path: () => path,
  canSaveInPlace: () => !!path && WRITABLE.has(file.format) && (file.losses.length === 0 || file.confirmed),
  writeCopy: (target) => io.writeDocument(target, model.toJSON(), file.password),
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
  if (info.edited || info.sheet || info.layout) view?.rebuildOffsets();
  redraw();
  properties?.refresh();
  if (info.refused) refusedValue(info.refused, info.written);
}

/** What a rule on the cell says about a value it does not accept: refuse, ask, or only tell. */
async function refusedValue(error, written) {
  const message = error.message || 'This value is not one the cell accepts.';
  const title = error.title || 'Not accepted';
  if (!written) {
    await showPanel(title, `<p>${escapeHtml(message)}</p>`);
  } else if (error.style === 'warning') {
    const choice = await showChoice(title, `<p>${escapeHtml(message)}</p><p>Keep it anyway?</p>`, [
      { id: 'undo', label: 'Take it back' }, { id: 'keep', label: 'Keep', primary: true },
    ]);
    if (choice !== 'keep') sheet.step(-1);
  } else {
    toast(message);
  }
}

// Drawing

function redraw() {
  view.draw();
  drawFormulaBar();
  drawSheetTabs();
  drawSummary();

  el('btn-undo').disabled = !sheet.undo.canUndo;
  el('btn-redo').disabled = !sheet.undo.canRedo;
  drawStylePicker();
}

/** The toolbar's list of named styles, showing the one under the active cell. */
function drawStylePicker() {
  const picker = el('style-picker');
  const styles = sheet.namedStyles;
  const signature = styles.map((s) => `${s.id}=${s.name}`).join('|');
  if (picker.dataset.styles !== signature) {
    picker.replaceChildren(...styles.map(({ id, name }) => {
      const choice = document.createElement('option');
      choice.value = id;
      choice.textContent = name;
      return choice;
    }));
    picker.dataset.styles = signature;
  }
  picker.value = sheet.namedStyleAt(sheet.active.row, sheet.active.col);
}

function drawFormulaBar() {
  el('name-box').textContent = sheet.selectionLabel;
  el('cell-help').textContent = sheet.validationAt(sheet.active.row, sheet.active.col)?.input?.message ?? '';
  const input = el('formula-input');
  if (document.activeElement !== input) input.value = sheet.activeText;
}

function drawSheetTabs() {
  const tabs = el('sheet-tabs');
  tabs.replaceChildren(...model.sheets.filter((each) => !each.hidden).map((each) => {
    const button = document.createElement('button');
    button.className = 'sheet-tab';
    button.textContent = each.name;
    button.dataset.sheet = each.id;
    button.classList.toggle('active', each.id === model.activeSheetId);
    button.classList.toggle('coloured', Boolean(each.tab));
    if (each.tab) button.style.setProperty('--tab', each.tab);
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
  const format = baseFormat(formatOf(target));
  const template = isTemplate(formatOf(target));
  let opened;
  try {
    opened = await withPassword(io.baseName(target), async (password) => {
      if (format === 'ods') return readOds(await readPackage(target, { password }));
      if (format === 'xlsx') return readXlsx(await readPackage(target, { password }));
      if (format === 'fods') return readOds(await io.readText(target));
      return { document: await io.readDocument(target, password), losses: null };
    });
  } catch (error) {
    await io.notify(`Cannot open that file.\n\n${error.message ?? error}`, 'Open failed');
    return;
  }
  if (!opened) return;
  const result = opened.value;
  attach(new GridModel(result.document));
  // A template starts a new document: nothing is saved back into it unless asked.
  path = template ? null : target;
  file = template ? { format: 'grt', losses: [], confirmed: false, password: null }
    : { format: format ?? 'grt', losses: result.losses?.lines() ?? [], confirmed: false, password: opened.password };
  document.title = template ? `Untitled, from ${io.baseName(target)} - GRT Grid` : `${io.baseName(target)} - GRT Grid`;
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
  file = { format: 'grt', losses: [], confirmed: false, password: null };
  document.title = 'GRT Grid';
  redraw();
}

async function openConfirmed(target) {
  if (await keeper.confirmLeave()) await open(target);
}

/** Opens a recovery copy as the document it was, with its changes unsaved. */
async function openRecovered(copy, meta) {
  const opened = await withPassword(meta.name || 'Untitled', (password) => io.readDocument(copy, password));
  // Without its password the copy stays where it is, offered again next time.
  if (!opened) throw new Error('the copy is kept for next time');
  attach(new GridModel(opened.value));
  path = meta.path ?? null;
  const format = formatOf(path) ?? 'grt';
  file = {
    format,
    losses: format === 'grt' ? [] : ['Anything the program could not read when the file was first opened'],
    confirmed: false,
    password: opened.password,
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
  ots: 'OpenDocument template (.ots)',
  xltx: 'Excel template (.xltx)',
};

/** Asks which format to save in, with or without a password, then where. */
async function chooseSaveTarget(preferred = null) {
  let current = preferred ?? (WRITABLE.has(file.format) ? file.format : 'grt');
  let problem = '';
  for (;;) {
    const answer = showPanel('Save as', `
      <label>Format<select data-field="format">
        ${Object.entries(FORMAT_NAMES).map(([id, label]) =>
    `<option value="${id}"${id === current ? ' selected' : ''}>${label}</option>`).join('')}
      </select></label>
      ${passwordFields(file.password, problem)}
      <p class="hint">A GRT spreadsheet keeps everything this program can do. The
      others open in LibreOffice and Excel, formulas included. A flat .fods cannot
      carry a password.</p>`, 'Choose file');
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
    const base = (path ?? 'spreadsheet').replace(/\.[^.\\/]*$/, '');
    const chosen = await io.pickToSave(io.baseName(`${base}.${format}`), io.FILTERS[format]);
    return chosen ? { destination: io.withExtension(chosen, format), format, password: protection.password } : null;
  }
}

async function writeAs(destination, format, password = null) {
  const json = format === 'grt' ? model.toJSON() : model.exportJSON();
  if (format === 'grt') return io.writeDocument(destination, json, password);
  if (format === 'fods') return io.writeText(destination, writeOds(json, { flat: true }).text);
  const base = baseFormat(format);
  const { entries } = base === 'ods' ? writeOds(json) : writeXlsx(json);
  return writePackage(destination, isTemplate(format) ? asTemplate(entries, format) : entries, { protection: PROTECTION[format], password });
}

async function save({ as = false, silent = false } = {}) {
  if (!silent) sheet.commitEdit();

  let destination = path;
  let format = file.format;
  let password = file.password;
  if (as || !destination || !WRITABLE.has(format)) {
    if (silent) return false;
    const chosen = await chooseSaveTarget();
    if (!chosen) return false;
    ({ destination, format, password } = chosen);
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
  if (!canProtect(format)) password = null;
  try {
    await writeAs(destination, format, password);
  } catch (error) {
    if (silent) throw error;
    await io.notify(`Cannot save.\n\n${error.message ?? error}`, 'Save failed');
    return false;
  }
  if (destination !== path || format !== file.format) file = { format, losses: [], confirmed: false, password };
  else file.password = password;
  path = destination;
  document.title = `${io.baseName(destination)} - GRT Grid`;
  model.dirty = keeper.revision !== revision;
  sheet.undo.markSaved();
  redraw();
  await keeper.saved();
  return true;
}

/** A copy written elsewhere, in any format, the spreadsheet open staying as it is; a template is one such copy. */
async function saveCopy(preferred = null) {
  sheet.commitEdit();
  const chosen = await chooseSaveTarget(preferred);
  if (!chosen) return;
  try {
    await writeAs(chosen.destination, chosen.format, canProtect(chosen.format) ? chosen.password : null);
    toast(`Saved a copy as ${io.baseName(chosen.destination)}`);
  } catch (error) {
    await io.notify(`Cannot save.\n\n${error.message ?? error}`, 'Save failed');
  }
}

/** The chosen chart as an SVG picture, as it is drawn on the sheet. */
async function exportChart() {
  const chart = model.charts.find((c) => c.id === sheet.chosenChart);
  if (!chart) return;
  const target = await io.pickToSave(`${chart.title || 'chart'}.svg`, [{ name: 'SVG picture', extensions: ['svg'] }], 'Export chart as image');
  if (!target) return;
  const svg = chartSvg(chartSpec(chart, sheet.engine, model), { width: chart.width ?? 480, height: chart.height ?? 300, background: '#ffffff' });
  await io.writeText(io.withExtension(target, 'svg'), `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
  toast(`Saved ${io.baseName(target)}`);
}

/** Every function Grid knows, found by typing part of its name; choosing one starts it in the formula bar. */
async function functionList() {
  const names = Object.keys(FUNCTIONS).sort();
  const answer = showPanel('Function', `
    <label>Find<input data-field="find" placeholder="SUM, VLOOKUP, DATE…" autocomplete="off"></label>
    <div class="function-list" id="function-list" role="listbox">${names.map((n) => `<button type="button" data-function="${n}">${n}</button>`).join('')}</div>
    <p class="hint">${names.length} functions. The one chosen goes into the formula bar with its bracket open.</p>`);
  const host = document.getElementById('function-list');
  const find = document.querySelector('#panel-body [data-field="find"]');
  find.addEventListener('input', () => {
    const wanted = find.value.trim().toUpperCase();
    for (const button of host.children) button.hidden = !button.dataset.function.includes(wanted);
  });
  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-function]');
    if (!button) return;
    document.getElementById('panel-cancel')?.click();
    const input = el('formula-input');
    input.focus();
    input.value = `=${button.dataset.function}(`;
    sheet.updateEdit(input.value);
  });
  await answer;
}

/** Today's date, or the time now, in the active cell, as a value that stays put. */
function insertNow(kind) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const text = kind === 'date'
    ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    : `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  sheet.setCell(sheet.active.row, sheet.active.col, text);
}

/** The look of the active cell, given to the cells chosen next with the mouse. */
function cloneFormatting() {
  const look = { ...sheet.styleAt(sheet.active.row, sheet.active.col) };
  toast('Choose the cells to give this look');
  document.body.classList.add('cloning');
  const apply = () => {
    document.removeEventListener('mouseup', apply, true);
    document.body.classList.remove('cloning');
    // After the grid has taken the new selection.
    setTimeout(() => sheet.formatCells(() => ({ ...look })), 0);
  };
  setTimeout(() => document.addEventListener('mouseup', apply, true), 0);
}

async function askSize(axis) {
  const current = axis === 'row' ? sheet.sheet.rowHeight(sheet.active.row) : sheet.sheet.columnWidth(sheet.active.col);
  const confirmed = await showPanel(axis === 'row' ? 'Row height' : 'Column width', `
    <label>${axis === 'row' ? 'Height' : 'Width'} in pixels<input type="number" data-field="size" min="${axis === 'row' ? 14 : 24}" max="1000" value="${Math.round(current)}"></label>`, 'Apply');
  if (!confirmed) return;
  const size = Number(readFields().size);
  if (Number.isFinite(size) && size > 0) sheet.setSize(axis, size);
}

/** Each row or column as large as what it holds needs. */
function bestSize(axis) {
  const measure = document.createElement('canvas').getContext('2d');
  const shownText = (row, col) => document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`)?.textContent ?? '';
  sheet.setSize(axis, null, (index) => {
    if (axis === 'row') {
      let lines = 1;
      let size = 13;
      for (let col = 0; col < 60; col += 1) {
        const look = sheet.styleAt(index, col);
        size = Math.max(size, look.size ? look.size * 96 / 72 : 13);
        lines = Math.max(lines, String(sheet.sheet.cell(index, col)?.v ?? '').split('\n').length);
      }
      return Math.round(lines * size * 1.45 + 6);
    }
    let widest = 24;
    for (let row = 0; row < 2000; row += 1) {
      const text = shownText(row, index) || String(sheet.sheet.cell(row, index)?.v ?? '');
      if (!text) continue;
      const look = sheet.styleAt(row, index);
      measure.font = `${look.bold ? 'bold ' : ''}${look.size ? look.size * 96 / 72 : 13}px system-ui, sans-serif`;
      widest = Math.max(widest, measure.measureText(text).width + 12);
    }
    return Math.min(800, Math.round(widest));
  });
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
    ${check('labels', 'Header and footer')}
    <label>Header<input type="text" data-print-field="header" value="${escapeHtml(s.header ?? '&A')}" size="12" title="&amp;A the sheet, &amp;P the page, &amp;N the pages, &amp;F the file, &amp;D the date" /></label>
    <label>Footer<input type="text" data-print-field="footer" value="${escapeHtml(s.footer ?? 'Page &P of &N')}" size="14" title="&amp;A the sheet, &amp;P the page, &amp;N the pages, &amp;F the file, &amp;D the date" /></label>
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
    fitWidth: s.fitWidth, gridlines: s.gridlines, labels: s.labels, header: String(s.header ?? '').slice(0, 200), footer: String(s.footer ?? '').slice(0, 200), area, repeatRows,
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
      return { width: paper.width, height: paper.height, pages: pageElements(planned, model.styles, printedCharts()) };
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
  for (const page of pdfPages(planned, model.styles, printedCharts())) rendered.push(await renderToPdf(page, { audit: false, report }));
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
  el('formula-input').addEventListener('input', (event) => {
    autoInput(event);
    sheet.updateEdit(event.target.value);
  });
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
  el('sheet-tabs').addEventListener('dblclick', (event) => {
    const tab = event.target.closest('[data-sheet]');
    if (tab) sheets.renameSheetDialog(sheet, tab.dataset.sheet, toast);
  });
  el('sheet-tabs').addEventListener('contextmenu', (event) => {
    const tab = event.target.closest('[data-sheet]');
    if (!tab) return;
    sheet.switchSheet(tab.dataset.sheet);
    showContextMenu(event, sheets.tabMenuItems(sheet, tab.dataset.sheet, toast));
  });

  menus = gridMenus({
    sheet: () => sheet,
    toast,
    actions: {
      newFile: () => el('btn-new').click(),
      open: () => el('btn-open').click(),
      save: () => save(),
      saveAs: () => save({ as: true }),
      importCsv: () => importCsv(),
      exportCsv: () => exportCsv(),
      exportPdf: () => exportPdf(),
      print: () => printSheets(),
      settings: () => openSettings(),
      setPrintArea: () => {
        const { top, left, bottom, right } = sheet.selection;
        sheet.setPrint(sheet.sheetId, { area: { top, left, bottom, right } });
      },
      clearPrintArea: () => sheet.setPrint(sheet.sheetId, { area: null }),
      repeatRows: () => {
        const { top, bottom } = sheet.selection;
        sheet.setPrint(sheet.sheetId, { repeatRows: { top, bottom } });
      },
      removeBreaks: () => sheet.setPrint(sheet.sheetId, { rowBreaks: [], colBreaks: [] }),
      saveCopy: () => saveCopy(),
      saveTemplate: () => saveCopy('ots'),
      templates: () => templateManager({ extensions: ['ots', 'xltx', 'xltm'], open: openConfirmed, toast }),
      reload: () => { if (path) openConfirmed(path); else toast('This spreadsheet has not been saved yet'); },
      toggleSidebar: () => el('properties').classList.toggle('hidden'),
      functionList: () => functionList(),
      insertDate: () => insertNow('date'),
      insertTime: () => insertNow('time'),
      cloneFormatting: () => cloneFormatting(),
      pasteSome: (options) => pasteSome(options),
      pasteUnformatted: () => pasteUnformatted(),
      pasteSpecial: () => pasteSpecialDialog(),
      exportChart: () => exportChart(),
      askSize: (axis) => askSize(axis),
      bestSize: (axis) => bestSize(axis),
      about: () => aboutDialog({ name: 'GRT Grid', version: runtime.version }),
      toggleAutoInput: () => { autoInputOn = !autoInputOn; toast(autoInputOn ? 'AutoInput on' : 'AutoInput off'); },
      autoInputOn: () => autoInputOn,
      cycleReference: () => {
        const input = el('formula-input');
        if (!String(sheet.sheet.cell(sheet.active.row, sheet.active.col)?.f ?? '').length) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        const cycled = cycleReference(input.value, input.value.length);
        if (cycled) { input.value = cycled.text; sheet.updateEdit(cycled.text); }
      },
      licences: () => licencesDialog({ name: 'GRT Grid' }),
    },
  });
  createMenubar(el('menubar'), menus);
  wireFormatBar();

  document.addEventListener('keydown', onKey);
  document.addEventListener('copy', onCopy);
  document.addEventListener('paste', onPaste);
  document.addEventListener('cut', onCut);
}

const rowsSelected = () => sheet.selection.bottom - sheet.selection.top + 1;
const colsSelected = () => sheet.selection.right - sheet.selection.left + 1;

function onGridMouseDown(event) {
  const frame = event.target.closest('.chart-frame');
  if (frame) {
    event.preventDefault();
    dragChart(event, frame);
    return;
  }
  if (sheet.chosenChart) sheet.chooseChart(null);
  const button = event.target.closest('.filter-button, .list-button');
  if (button) {
    event.preventDefault();
    if (button.classList.contains('filter-button')) dialogs.filterValuesDialog(sheet, Number(button.dataset.col));
    else dropChoices();
    return;
  }
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
  const frame = event.target.closest('.chart-frame');
  if (frame) {
    const chart = model.charts.find((c) => c.id === frame.dataset.chart);
    if (chart) dialogs.chartDialog(sheet, chart);
    return;
  }
  const cell = event.target.closest('.cell');
  if (!cell) return;
  sheet.select(Number(cell.dataset.row), Number(cell.dataset.col));
  el('formula-input').focus();
}

/** Moves a chart, or resizes it from its corner; the change is one step to undo, made when the mouse is let go. */
function dragChart(event, frame) {
  const id = frame.dataset.chart;
  const chart = model.charts.find((c) => c.id === id);
  if (!chart) return;
  if (sheet.chosenChart !== id) sheet.chooseChart(id);
  const resizing = event.target.classList.contains('chart-handle');
  const start = { x: event.clientX, y: event.clientY, box: view.chartBox(chart) };
  let moved = false;
  const onMove = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    const node = view.chartNodes.get(id);
    if (resizing) {
      node.style.width = `${Math.max(120, start.box.width + dx)}px`;
      node.style.height = `${Math.max(90, start.box.height + dy)}px`;
    } else {
      node.style.transform = `translate(${Math.max(0, start.box.x + dx)}px, ${Math.max(0, start.box.y + dy)}px)`;
    }
  };
  const onUp = (e) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (resizing) sheet.updateChart(id, { width: Math.round(Math.max(120, start.box.width + dx)), height: Math.round(Math.max(90, start.box.height + dy)) });
    else sheet.updateChart(id, { anchor: view.anchorAt(start.box.x + dx, start.box.y + dy) });
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/**
 * AutoInput, as in LibreOffice: text typed in a cell is completed from what the column above and below already holds,
 * the completion selected so typing on replaces it and Enter takes it.
 */
let autoInputOn = true;

function autoInput(event) {
  const input = event.target;
  if (!autoInputOn) return;
  if (!event.inputType?.startsWith('insert') || input.selectionStart !== input.value.length) return;
  const typed = input.value;
  if (!typed || typed.startsWith('=') || /^[-+\d.,\s%€$]*$/.test(typed)) return;
  const { row, col } = sheet.active;
  const lower = typed.toLowerCase();
  const found = new Set();
  for (let r = Math.max(0, row - 2000); r < row + 2000; r += 1) {
    if (r === row) continue;
    const value = sheet.sheet.cell(r, col)?.v;
    if (typeof value === 'string' && value.length > typed.length && value.toLowerCase().startsWith(lower)) found.add(value);
    if (found.size > 1) break;
  }
  if (found.size !== 1) return;
  const [whole] = found;
  input.value = typed + whole.slice(typed.length);
  input.setSelectionRange(typed.length, input.value.length);
}

/** Keys pressed in the formula bar. */
function onFormulaKey(event) {
  if (event.key === 'F4' && event.target.value.startsWith('=')) {
    event.preventDefault();
    const cycled = cycleReference(event.target.value, event.target.selectionStart);
    if (cycled) {
      event.target.value = cycled.text;
      event.target.setSelectionRange(cycled.caret, cycled.caret);
      sheet.updateEdit(cycled.text);
    }
    return;
  }
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

// The currency of the place the machine is set to; the euro where it cannot tell.
const CURRENCIES = { GB: '£', US: '$', CA: '$', AU: '$', NZ: '$', CH: 'CHF', JP: '¥', CN: '¥', IN: '₹', SE: 'kr', NO: 'kr', DK: 'kr', PL: 'zł' };
function currencyFormat() {
  const region = (navigator.language ?? '').split('-')[1]?.toUpperCase() ?? '';
  const symbol = CURRENCIES[region] ?? '€';
  return symbol === '$' || symbol === '£' ? `"${symbol}"#,##0.00` : `#,##0.00 "${symbol}"`;
}

// The properties sidebar: how the selected cells look, changed without a dialog.

let properties = null;

const FORMATS = [['', 'General'], ['0', 'Number, no decimals'], ['#,##0.00', 'Number, two decimals'], ['0.00%', 'Percent'], ['yyyy-mm-dd', 'Date'], ['hh:mm', 'Time'], ['@', 'Text']];

function describeCells() {
  if (!sheet) return [];
  const look = sheet.styleAt(sheet.active.row, sheet.active.col);
  const set = (field) => (value) => sheet.formatCells((l) => ({ ...l, [field]: value === '' ? undefined : value }));
  const currency = currencyFormat();
  const formats = [...FORMATS, [currency, 'Currency'], ...(look.format && ![...FORMATS.map(([f]) => f), currency].includes(look.format) ? [[look.format, look.format]] : [])];
  const { top, bottom, left, right } = sheet.selection;
  const title = top === bottom && left === right ? `Cell ${a1(top, left)}` : `Cells ${a1(top, left)}:${a1(bottom, right)}`;
  return [
    { title, fields: [
      { label: 'Number format', kind: 'select', value: look.format ?? '', options: formats, apply: (v) => sheet.setNumberFormat(v || null) },
    ] },
    { title: 'Text', fields: [
      { label: 'Bold', kind: 'checkbox', value: Boolean(look.bold), apply: set('bold'), row: 'marks' },
      { label: 'Italic', kind: 'checkbox', value: Boolean(look.italic), apply: set('italic'), row: 'marks' },
      { label: 'Size', kind: 'number', value: look.size ?? '', min: 6, max: 96, apply: (v) => sheet.formatCells((l) => ({ ...l, size: v || undefined })), row: 'font' },
      { label: 'Colour', kind: 'color', value: look.color ?? '#000000', apply: set('color'), row: 'font' },
      { label: 'Fill', kind: 'color', value: look.bg ?? '#ffffff', apply: set('bg') },
    ] },
    { title: 'Alignment', fields: [
      { label: 'Across', kind: 'select', value: look.align ?? '', options: [['', 'Automatic'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], apply: set('align'), row: 'align' },
      { label: 'Up and down', kind: 'select', value: look.valign ?? '', options: [['', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']], apply: set('valign'), row: 'align' },
      { label: 'Wrap text', kind: 'checkbox', value: Boolean(look.wrap), apply: set('wrap') },
    ] },
  ];
}

function wireFormatBar() {
  properties = createProperties(el('properties'), describeCells);
  const on = (id, run) => { el(id).onclick = () => { run(); el('grid').focus(); }; };
  on('btn-bold', () => sheet.toggleLook('bold'));
  on('btn-italic', () => sheet.toggleLook('italic'));
  on('btn-underline', () => sheet.toggleLook('underline'));
  for (const align of ['left', 'center', 'right']) on(`btn-align-${align}`, () => sheet.formatCells((look) => ({ ...look, align })));
  on('btn-merge', () => dialogs.mergeCells(sheet));
  on('btn-wrap', () => sheet.toggleLook('wrap'));
  on('btn-currency', () => sheet.setNumberFormat(currencyFormat()));
  on('btn-percent', () => sheet.setNumberFormat('0.00%'));
  on('btn-sort-up', () => sortAscending(1));
  on('btn-sort-down', () => sortAscending(-1));
  on('btn-filter', () => dialogs.toggleAutoFilter(sheet));
  on('btn-sum', () => { if (!sheet.autoSum()) toast('No numbers above or to the left to sum'); });
  on('btn-chart', () => {
    const area = sheet.dataArea();
    sheet.insertChart(chartFromArea(sheet.sheet, area));
    toast('Chart added; its menu changes the kind and the titles');
  });
}

/** Sorts the data around the active cell by its column. */
function sortAscending(order) {
  const area = sheet.dataArea();
  sheet.sort({ area, keys: [{ index: sheet.active.col - area.left, order }] });
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
      case 'n': if (event.shiftKey) break; event.preventDefault(); el('btn-new').click(); return;
      case 'd': event.preventDefault(); sheet.fillDown(); return;
      case 'k': event.preventDefault(); openPalette(commands()); return;
      case 'p': event.preventDefault(); printSheets(); return;
      case 'h': case 'f': event.preventDefault(); dialogs.findReplaceDialog(sheet, toast); return;
      case 'b': event.preventDefault(); sheet.toggleLook('bold'); return;
      case 'i': event.preventDefault(); sheet.toggleLook('italic'); return;
      case 'u': event.preventDefault(); sheet.toggleLook('underline'); return;
      case 'm': event.preventDefault(); sheet.clearDirectFormatting(); return;
      case '1': event.preventDefault(); dialogs.formatCellsDialog(sheet); return;
      case 'l': if (event.shiftKey) { event.preventDefault(); dialogs.toggleAutoFilter(sheet); return; } break;
      default: break;
    }
    // Ctrl+Shift+4, 5 and 6: currency, percent and the general format, as in LibreOffice; read by key position.
    if (event.shiftKey && ['Digit4', 'Digit5', 'Digit6'].includes(event.code)) {
      event.preventDefault();
      sheet.setNumberFormat({ Digit4: currencyFormat(), Digit5: '0.00%', Digit6: null }[event.code]);
      return;
    }
    switch (event.key.toLowerCase()) {
      case '+': case '=': if (event.key === '+' || event.shiftKey) { event.preventDefault(); dialogs.insertCellsDialog(sheet); return; } break;
      case '-': event.preventDefault(); dialogs.deleteCellsDialog(sheet); return;
      case 'f3': event.preventDefault(); dialogs.namesDialog(sheet); return;
      default: break;
    }
  }

  if (event.key === 'F11') {
    event.preventDefault();
    dialogs.stylesDialog(sheet);
    return;
  }

  if (event.altKey && (event.key === '=' || event.code === 'Equal')) {
    event.preventDefault();
    if (!sheet.autoSum()) toast('No numbers above or to the left to sum');
    return;
  }

  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    dropChoices();
    return;
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

  if (sheet.chosenChart && (event.key === 'Delete' || event.key === 'Backspace')) {
    event.preventDefault();
    sheet.deleteChart(sheet.chosenChart);
    return;
  }

  if (sheet.chosenChart && event.key === 'Escape') {
    sheet.chooseChart(null);
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

/** Pastes part of what was last copied in Grid, as the options say. */
function pasteSome(options) {
  if (!held) {
    toast('Copy cells in Grid first');
    return;
  }
  sheet.pasteSpecial(held, options);
}

/** The clipboard's text, as plain values without formats or formulas carried over. */
async function pasteUnformatted() {
  let text = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = held?.text ?? null;
  }
  if (text) sheet.paste({ text });
  else toast('The clipboard holds no text');
}

async function pasteSpecialDialog() {
  if (!held) {
    toast('Copy cells in Grid first');
    return;
  }
  const confirmed = await showPanel('Paste special', `
    <fieldset><legend>Paste</legend>
      <label class="inline"><input type="checkbox" data-field="text" checked> Text</label>
      <label class="inline"><input type="checkbox" data-field="numbers" checked> Numbers</label>
      <label class="inline"><input type="checkbox" data-field="formulas" checked> Formulas</label>
      <label class="inline"><input type="checkbox" data-field="formats" checked> Formats</label>
    </fieldset>
    <label>Operation with what is there<select data-field="operation">
      <option value="">None</option><option value="add">Add</option><option value="subtract">Subtract</option>
      <option value="multiply">Multiply</option><option value="divide">Divide</option>
    </select></label>
    <label class="inline"><input type="checkbox" data-field="skipEmpty"> Skip empty cells</label>
    <label class="inline"><input type="checkbox" data-field="transpose"> Transpose</label>`, 'Paste');
  if (!confirmed) return;
  const fields = readFields();
  sheet.pasteSpecial(held, { ...fields, operation: fields.operation || null });
}

/** Every chart of the document as print draws it: in its sheet's pixels, on white paper. */
function printedCharts() {
  return model.charts.map((chart) => {
    const owner = model.sheetById(chart.sheet) ?? model.sheets[0];
    const at = { x: 0, y: 0 };
    for (let c = 0; c < (chart.anchor?.col ?? 0); c += 1) at.x += owner.columnWidth(c);
    for (let r = 0; r < (chart.anchor?.row ?? 0); r += 1) at.y += owner.rowHeight(r);
    const width = chart.width ?? 480;
    const height = chart.height ?? 300;
    return {
      sheetId: owner.id, x: at.x + (chart.anchor?.dx ?? 0), y: at.y + (chart.anchor?.dy ?? 0), width, height,
      svg: chartSvg(chartSpec(chart, sheet.engine, model), { width, height, background: '#ffffff' }),
    };
  });
}

/** Drops down the choices of the active cell's list rule, and writes the one picked. */
async function dropChoices() {
  const { row, col } = sheet.active;
  const choices = sheet.choicesAt(row, col);
  const node = el('grid').querySelector(`.cell.active`);
  if (!choices?.length || !node) return;
  const picked = await dialogs.chooseFromList(node, choices);
  if (picked !== null) sheet.setCell(row, col, String(picked));
}

let menus = [];

function commands() {
  return paletteEntries(menus).filter((entry) => entry.enabled());
}

export { a1 };

start();
