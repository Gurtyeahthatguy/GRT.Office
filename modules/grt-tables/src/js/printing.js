/** A table, or a query's result, on paper: rows cut into pages, the column names on each. */

import { makePage, paperSize, measuringColumn } from './core/print.js';

const MM = 96 / 25.4;
const TITLE = 9;

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '(file)';
  return String(value);
}

function tableElement(columns, rows, widths = null) {
  const table = document.createElement('table');
  table.className = 'print-table';
  if (widths) {
    const group = document.createElement('colgroup');
    for (const width of widths) {
      const col = document.createElement('col');
      col.style.width = `${width}%`;
      group.append(col);
    }
    table.append(group);
  }
  const head = table.createTHead().insertRow();
  for (const name of columns) {
    const cell = document.createElement('th');
    cell.textContent = name;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((value) => {
      const cell = tr.insertCell();
      cell.textContent = text(value);
      if (typeof value === 'number') cell.className = 'number';
    });
  }
  return table;
}

/**
 * @param {{name: string, columns: string[], rows: any[][]}} data
 * @param {{size: string, orientation: string, margin: number}} setup
 * @returns {{width: number, height: number, pages: HTMLElement[]}}
 */
export function printablePages(data, setup) {
  const paper = paperSize(setup);
  const margin = Math.max(0, setup.margin ?? 12);
  const innerW = paper.width - 2 * margin;
  const innerH = paper.height - 2 * margin - TITLE - 6;

  const column = measuringColumn(innerW, 'print-measure');
  let widths;
  let heights;
  let headHeight;
  try {
    const whole = tableElement(data.columns, data.rows);
    column.append(whole);
    const head = whole.tHead.rows[0];
    const total = whole.getBoundingClientRect().width || 1;
    widths = [...head.cells].map((cell) => (cell.getBoundingClientRect().width / total) * 100);
    if (widths.some((w) => !Number.isFinite(w) || w <= 0)) widths = null;
    headHeight = head.getBoundingClientRect().height;
    heights = [...whole.tBodies[0].rows].map((row) => row.getBoundingClientRect().height);
  } finally {
    column.remove();
  }

  const room = innerH * MM - headHeight;
  const slices = [];
  let start = 0;
  let used = 0;
  heights.forEach((height, i) => {
    if (i > start && used + height > room) {
      slices.push([start, i]);
      start = i;
      used = 0;
    }
    used += height;
  });
  slices.push([start, data.rows.length]);

  const pages = slices.map(([from, to], index) => {
    const page = makePage(paper.width, paper.height);
    const title = document.createElement('div');
    title.className = 'print-header';
    title.textContent = data.name;
    Object.assign(title.style, {
      position: 'absolute', left: `${margin}mm`, top: `${margin}mm`, width: `${innerW}mm`,
      font: '600 11pt system-ui, sans-serif', color: '#111',
    });
    const body = document.createElement('div');
    Object.assign(body.style, {
      position: 'absolute', left: `${margin}mm`, top: `${margin + TITLE}mm`, width: `${innerW}mm`,
      height: `${innerH}mm`, overflow: 'hidden',
    });
    body.append(tableElement(data.columns, data.rows.slice(from, to), widths));
    const footer = document.createElement('div');
    footer.className = 'print-footer';
    footer.textContent = `Rows ${data.rows.length === 0 ? 0 : from + 1} to ${to} of ${data.rows.length} · page ${index + 1} of ${slices.length}`;
    Object.assign(footer.style, {
      position: 'absolute', left: `${margin}mm`, width: `${innerW}mm`, bottom: `${margin / 2}mm`,
      textAlign: 'center', font: '8pt system-ui, sans-serif', color: '#555',
    });
    page.append(title, body, footer);
    return page;
  });
  return { width: paper.width, height: paper.height, pages };
}
