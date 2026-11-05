/** Charts in a document: their own data, typed in or taken from a spreadsheet when asked, never by themselves. */

import { makeBlock } from './core/editor/model.js';
import { insertBlockAt } from './core/editor/commands.js';
import { chartSvg } from './core/charts.js';
import { ownChartSpec, dataFromText, dataToText, normaliseChartData } from './core/formats/chart-object.js';
import { readOds } from './core/formats/ods.js';
import { readXlsx } from './core/formats/xlsx.js';
import { readPackage } from './core/package.js';

const escape = (text) => String(text ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const KINDS = [['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Points (XY)'], ['combo', 'Columns and lines']];
const option = (value, label, chosen) => `<option value="${escape(value)}"${value === chosen ? ' selected' : ''}>${escape(label)}</option>`;

const columnIndex = (letters) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** The data of a block of a sheet: names along its first row, categories down its first column. */
export function dataFromSheet(sheet, range) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/i.exec(String(range ?? '').trim());
  if (!m) throw new Error('Write the range as A1:D9');
  const top = Number(m[2]) - 1;
  const bottom = Math.min(top + 4000, Number(m[4]) - 1);
  const left = columnIndex(m[1]);
  const right = Math.min(left + 64, columnIndex(m[3]));
  const value = (r, c) => sheet.cells?.[`${r},${c}`]?.v ?? null;
  const categories = [];
  for (let r = top + 1; r <= bottom; r += 1) categories.push(value(r, left) === null ? '' : String(value(r, left)));
  const series = [];
  for (let c = left + 1; c <= right; c += 1) {
    const values = [];
    for (let r = top + 1; r <= bottom; r += 1) values.push(typeof value(r, c) === 'number' ? value(r, c) : null);
    series.push({ name: String(value(top, c) ?? `Series ${c - left}`), values });
  }
  return normaliseChartData({ categories, series });
}

/** The sheets of a spreadsheet file, read without running anything in it. */
async function readSpreadsheet(path, readText) {
  const extension = (/\.([^.]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  if (extension === 'fods') return readOds(await readText(path)).document;
  if (extension === 'ods' || extension === 'xlsx') {
    const pkg = await readPackage(path);
    return (extension === 'ods' ? readOds(pkg) : readXlsx(pkg)).document;
  }
  throw new Error('Charts take their data from .ods, .fods or .xlsx files');
}

/**
 * @param {{model: () => object, editor: object, edit: Function, showPanel: Function, showChoice: Function, readFields: Function,
 *   toast: Function, done: Function, pickToOpen: Function, readText: Function, baseName: Function}} app
 */
export function paperCharts(app) {
  /** The dialog for a new chart, or for one already in the text; the preview follows every field. */
  async function chartDialog(existing = null) {
    let chart = existing ? structuredClone(existing) : makeBlock('chart');
    for (;;) {
      const answer = app.showChoice(existing ? 'Chart' : 'Insert chart', `
        <div class="chart-preview" id="chart-preview"></div>
        <div class="form-grid">
          <label>Kind</label><select data-field="type">${KINDS.map(([v, l]) => option(v, l, chart.type)).join('')}</select>
          <label>Stacking</label><select data-field="stacked">${[['', 'Side by side'], ['stacked', 'Stacked'], ['percent', 'Stacked to 100%']].map(([v, l]) => option(v, l, chart.stacked || '')).join('')}</select>
          <label>Title</label><input data-field="title" value="${escape(chart.title ?? '')}">
          <label>Across axis</label><input data-field="xTitle" value="${escape(chart.xTitle ?? '')}">
          <label>Up axis</label><input data-field="yTitle" value="${escape(chart.yTitle ?? '')}">
          <label>Legend</label><select data-field="legend">${[['right', 'Right'], ['bottom', 'Below'], ['top', 'Above'], ['none', 'None']].map(([v, l]) => option(v, l, chart.legend ?? 'right')).join('')}</select>
        </div>
        <label class="stacked">Data: series names on the first line, then a line per category, values apart with tabs or semicolons
          <textarea data-field="data" rows="6" spellcheck="false">${escape(dataToText(chart.data))}</textarea></label>
        ${chart.link ? `<p class="fp-note">Taken from ${escape(app.baseName(chart.link.path))}, ${escape(chart.link.sheet)}!${escape(chart.link.range)}; updated only when asked.</p>` : ''}`, [
        { id: 'sheet', label: 'From a spreadsheet…' }, ...(chart.link ? [{ id: 'unlink', label: 'Keep the data, drop the link' }] : []),
        { id: 'cancel', label: 'Cancel' }, { id: 'ok', label: existing ? 'Apply' : 'Insert', primary: true },
      ]);
      const body = document.getElementById('panel-body');
      const read = () => {
        const f = app.readFields();
        return { ...chart, type: f.type, stacked: f.stacked || false, title: f.title, xTitle: f.xTitle, yTitle: f.yTitle, legend: f.legend, data: dataFromText(f.data) };
      };
      const preview = () => {
        const node = document.getElementById('chart-preview');
        if (node) node.innerHTML = chartSvg(ownChartSpec(read()), { width: 440, height: 220, background: '#ffffff', text: '#222222' });
      };
      body.addEventListener('input', preview);
      preview();
      const choice = await answer;
      body.removeEventListener('input', preview);
      if (choice === null || choice === 'cancel') return;
      chart = read();
      if (choice === 'unlink') {
        delete chart.link;
        continue;
      }
      if (choice === 'sheet') {
        const linked = await fromSpreadsheet(chart);
        if (linked) chart = linked;
        continue;
      }
      if (existing) {
        app.edit(() => {
          const block = app.model().block(existing.id);
          if (block) Object.assign(block, chart);
          return app.editor.selection;
        });
      } else {
        app.editor.readSelection();
        app.edit(() => insertBlockAt(app.model(), app.editor.selection, chart));
      }
      app.done();
      return;
    }
  }

  /** Copies a block of a spreadsheet into the chart, remembering where it came from. */
  async function fromSpreadsheet(chart) {
    const path = await app.pickToOpen([{ name: 'Spreadsheets', extensions: ['ods', 'fods', 'xlsx'] }], 'Take the data from');
    if (!path) return null;
    let document;
    try {
      document = await readSpreadsheet(path, app.readText);
    } catch (error) {
      app.toast(`Cannot read that spreadsheet: ${error.message ?? error}`);
      return null;
    }
    const confirmed = await app.showPanel('Data from a spreadsheet', `
      <div class="form-grid">
        <label>Sheet</label><select data-field="sheet">${document.sheets.map((s) => option(s.name, s.name, chart.link?.sheet)).join('')}</select>
        <label>Range</label><input data-field="range" value="${escape(chart.link?.range ?? 'A1:B5')}" placeholder="A1:D9">
      </div>
      <p class="fp-note">The values are copied into the document. They change again only with Update chart data, never by themselves.</p>`, 'Take');
    if (!confirmed) return null;
    const f = app.readFields();
    try {
      const sheet = document.sheets.find((s) => s.name === f.sheet) ?? document.sheets[0];
      return { ...chart, data: dataFromSheet(sheet, f.range), link: { path, sheet: sheet.name, range: f.range.trim() } };
    } catch (error) {
      app.toast(error.message ?? String(error));
      return null;
    }
  }

  /** Reads every linked chart's data again from its spreadsheet. */
  async function updateLinked() {
    const linked = app.model().blocks.filter((b) => b.kind === 'chart' && b.link);
    if (linked.length === 0) {
      app.toast('No chart takes its data from a spreadsheet');
      return;
    }
    const fresh = new Map();
    for (const block of linked) {
      try {
        const document = await readSpreadsheet(block.link.path, app.readText);
        const sheet = document.sheets.find((s) => s.name === block.link.sheet);
        if (sheet) fresh.set(block.id, dataFromSheet(sheet, block.link.range));
      } catch {
        // A spreadsheet that moved or went is reported below; the chart keeps its data.
      }
    }
    app.edit(() => {
      for (const block of linked) if (fresh.has(block.id)) block.data = fresh.get(block.id);
      return app.editor.selection;
    });
    app.done();
    app.toast(`${fresh.size} of ${linked.length} chart(s) updated`);
  }

  return { chartDialog, updateLinked };
}
