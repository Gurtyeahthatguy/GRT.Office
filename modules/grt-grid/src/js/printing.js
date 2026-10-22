/** Sheets on paper: which cells land on which page, drawn for the printer or as PDF. */

import { formatValue, alignmentFor } from './format.js';
import { parseRef, parseRange, formatRange, a1 } from './references.js';
import { makePage, paperSize } from './core/print.js';

const MM = 96 / 25.4;
const PX_TO_PT = 0.75;

const PAD_X = 5;
const PAD_Y = 2;
const FONT_PX = 13;
const LINE_PX = 20;
const GRID = '#b4b4b4';

/** A print area as typed, `A1:F40`, or null when it is blank or not a range. */
export function parseArea(text) {
  const cleaned = String(text ?? '').replace(/\$/g, '').trim();
  if (cleaned === '') return null;
  const range = parseRange(cleaned) ?? (parseRef(cleaned) ? parseRange(`${cleaned}:${cleaned}`) : null);
  if (!range) return null;
  return {
    top: Math.min(range.from.row, range.to.row),
    left: Math.min(range.from.col, range.to.col),
    bottom: Math.max(range.from.row, range.to.row),
    right: Math.max(range.from.col, range.to.col),
  };
}

export function formatArea(area) {
  if (!area) return '';
  return area.top === area.bottom && area.left === area.right
    ? a1(area.top, area.left)
    : formatRange({ from: { row: area.top, col: area.left }, to: { row: area.bottom, col: area.right } });
}

/** Rows to repeat as typed, `1` or `1:2`, or null. */
export function parseRows(text) {
  const match = /^\s*\$?(\d+)\s*(?::\s*\$?(\d+)\s*)?$/.exec(String(text ?? ''));
  if (!match) return null;
  const a = Number(match[1]) - 1;
  const b = Number(match[2] ?? match[1]) - 1;
  if (a < 0 || b < 0) return null;
  return { top: Math.min(a, b), bottom: Math.max(a, b) };
}

export function formatRows(rows) {
  if (!rows) return '';
  return rows.top === rows.bottom ? String(rows.top + 1) : `${rows.top + 1}:${rows.bottom + 1}`;
}

/** What a sheet prints when nothing narrower is asked for. */
export function printedArea(sheet) {
  return sheet.print.area ?? sheet.usedBounds();
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

/** Runs of rows or columns that fit across or down a page, cut where a break is set. */
function bands(indices, size, room, breaks, reserve = () => 0) {
  const out = [];
  let current = [];
  let used = 0;
  for (const index of indices) {
    const needed = size(index);
    const forced = breaks.has(index) && current.length > 0;
    if (forced || (current.length > 0 && used + needed > room - reserve(current[0]))) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(index);
    used += needed;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Where a sheet's cells fall on pages.
 * @param {import('./model.js').Sheet} sheet
 * @param {object} setup the sheet's print settings
 * @param {?{top: number, left: number, bottom: number, right: number}} area
 * @returns {{paper: {width: number, height: number}, scale: number,
 *   pages: {rows: number[], cols: number[], repeat: number[]}[]}}
 */
export function layoutSheet(sheet, setup, area) {
  const paper = paperSize(setup);
  const contentWidth = Math.max(10, paper.width - 2 * setup.margin) * MM;
  const contentHeight = Math.max(10, paper.height - 2 * setup.margin) * MM;
  if (!area) return { paper, scale: 1, pages: [] };

  const cols = range(area.left, area.right);
  const rows = range(area.top, area.bottom);
  const width = cols.reduce((sum, col) => sum + sheet.columnWidth(col), 0);
  const scale = setup.fitWidth ? Math.min(1, contentWidth / width) : 1;
  const room = { across: contentWidth / scale, down: contentHeight / scale };

  const repeat = setup.repeatRows;
  // Rows repeated at the top of a page are those above where its own rows begin.
  const repeatFor = (first) => (repeat ? range(repeat.top, Math.min(repeat.bottom, first - 1)) : []);
  const height = (list) => list.reduce((sum, row) => sum + sheet.rowHeight(row), 0);

  const across = bands(cols, (c) => sheet.columnWidth(c), room.across, new Set(setup.colBreaks));
  const down = bands(rows, (r) => sheet.rowHeight(r), room.down, new Set(setup.rowBreaks), (first) => height(repeatFor(first)));

  const pages = [];
  for (const columnBand of across) {
    for (const rowBand of down) pages.push({ rows: rowBand, cols: columnBand, repeat: repeatFor(rowBand[0]) });
  }
  return { paper, scale, pages };
}

/** The cells of one page, in pixels from its top left corner, before scaling. */
function pageCells(sheet, styles, page) {
  const rows = [...page.repeat, ...page.rows];
  const ys = [0];
  for (const row of rows) ys.push(ys[ys.length - 1] + sheet.rowHeight(row));
  const xs = [0];
  for (const col of page.cols) xs.push(xs[xs.length - 1] + sheet.columnWidth(col));

  const cells = [];
  rows.forEach((row, r) => {
    page.cols.forEach((col, c) => {
      const cell = sheet.cell(row, col);
      if (!cell) return;
      const style = cell.s ? styles[cell.s] ?? {} : {};
      const value = cell.v ?? null;
      const text = formatValue(value, style.format);
      if (text === '' && !style.bg) return;
      cells.push({
        x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r],
        text, align: style.align ?? alignmentFor(value),
        bold: !!style.bold, italic: !!style.italic, color: style.color ?? null, bg: style.bg ?? null,
      });
    });
  });
  return { xs, ys, cells };
}

/** One printed page, drawn in the page's own DOM. */
function pageElement(sheet, styles, page, layout, setup, running) {
  const { paper, scale } = layout;
  const element = makePage(paper.width, paper.height);
  const body = document.createElement('div');
  Object.assign(body.style, {
    position: 'absolute', top: `${setup.margin}mm`, left: `${setup.margin}mm`,
    width: `${paper.width - 2 * setup.margin}mm`, height: `${paper.height - 2 * setup.margin}mm`, overflow: 'hidden',
  });
  const canvas = document.createElement('div');
  canvas.className = 'print-sheet';
  Object.assign(canvas.style, { position: 'absolute', top: '0', left: '0', transformOrigin: '0 0' });
  if (scale !== 1) canvas.style.transform = `scale(${scale})`;

  const { xs, ys, cells } = pageCells(sheet, styles, page);
  const width = xs[xs.length - 1];
  const height = ys[ys.length - 1];
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  for (const cell of cells) {
    const div = document.createElement('div');
    div.className = 'print-cell';
    div.textContent = cell.text;
    Object.assign(div.style, {
      left: `${cell.x}px`, top: `${cell.y}px`, width: `${cell.w}px`, height: `${cell.h}px`, textAlign: cell.align,
    });
    if (cell.bold) div.style.fontWeight = '700';
    if (cell.italic) div.style.fontStyle = 'italic';
    if (cell.color) div.style.color = cell.color;
    if (cell.bg) div.style.background = cell.bg;
    canvas.append(div);
  }

  if (setup.gridlines) {
    for (const x of xs) canvas.append(rule({ left: `${x}px`, top: '0', width: '1px', height: `${height}px` }));
    for (const y of ys) canvas.append(rule({ left: '0', top: `${y}px`, width: `${width + 1}px`, height: '1px' }));
  }

  body.append(canvas);
  element.append(body);
  for (const [part, text] of Object.entries(running)) {
    if (!text) continue;
    const line = document.createElement('div');
    line.className = `print-${part}`;
    line.textContent = text;
    Object.assign(line.style, {
      position: 'absolute', left: `${setup.margin}mm`, right: `${setup.margin}mm`, textAlign: 'center',
      fontSize: '9pt', color: '#333', whiteSpace: 'pre', overflow: 'hidden',
      [part === 'header' ? 'top' : 'bottom']: `${setup.margin * 0.35}mm`,
    });
    element.append(line);
  }
  return element;
}

function rule(position) {
  const div = document.createElement('div');
  div.className = 'print-rule';
  Object.assign(div.style, position, { background: GRID });
  return div;
}

/**
 * Lays out the sheets asked for, page by page, numbered through.
 * @param {Array<{sheet: object, setup: object, area: ?object}>} jobs
 * @returns {{sheet: object, setup: object, layout: object, page: object}[]}
 */
export function planPages(jobs) {
  const out = [];
  for (const job of jobs) {
    const layout = layoutSheet(job.sheet, job.setup, job.area);
    const pages = layout.pages.length > 0 ? layout.pages : [{ rows: [], cols: [], repeat: [] }];
    for (const page of pages) out.push({ ...job, layout, page });
  }
  return out;
}

function runningText(plan, index, total) {
  if (!plan.setup.labels) return {};
  return { header: plan.sheet.name, footer: `Page ${index + 1} of ${total}` };
}

/** The planned pages as elements for the print preview. */
export function pageElements(planned, styles) {
  return planned.map((plan, index) =>
    pageElement(plan.sheet, styles, plan.page, plan.layout, plan.setup, runningText(plan, index, planned.length)));
}

/** The planned pages as primitives for the PDF engine, each on its own sheet's paper. */
export function pdfPages(planned, styles) {
  return planned.map((plan, index) => {
    const { paper, scale } = plan.layout;
    const width = paper.width * MM * PX_TO_PT;
    const height = paper.height * MM * PX_TO_PT;
    const margin = plan.setup.margin * MM * PX_TO_PT;
    const k = scale * PX_TO_PT;
    const at = (x, y) => [margin + x * k, margin + y * k];
    const primitives = [];
    const { xs, ys, cells } = pageCells(plan.sheet, styles, plan.page);
    const bottom = height - margin;
    const right = width - margin;

    for (const cell of cells) {
      const [x, y] = at(cell.x, cell.y);
      if (y >= bottom || x >= right) continue;
      const w = Math.min(cell.w * k, right - x);
      const h = Math.min(cell.h * k, bottom - y);
      if (cell.bg) primitives.push({ type: 'rect', x, y, w, h, fill: cell.bg });
      if (cell.text === '') continue;
      const size = FONT_PX * k;
      const tx = cell.align === 'right' ? x + w - PAD_X * k
        : cell.align === 'center' ? x + w / 2
          : x + PAD_X * k;
      primitives.push({
        type: 'text', x: tx, y: y + (PAD_Y + (LINE_PX - FONT_PX) / 2) * k, text: cell.text, size,
        align: cell.align === 'right' || cell.align === 'center' ? cell.align : 'left',
        bold: cell.bold, italic: cell.italic, fill: cell.color ?? '#111111',
        maxWidth: Math.max(0, w - 2 * PAD_X * k),
      });
    }

    if (plan.setup.gridlines && xs.length > 1 && ys.length > 1) {
      const [x0, y0] = at(0, 0);
      const x1 = Math.min(at(xs[xs.length - 1], 0)[0], right);
      const y1 = Math.min(at(0, ys[ys.length - 1])[1], bottom);
      for (const x of xs) {
        const [px] = at(x, 0);
        if (px <= right) primitives.push({ type: 'polyline', points: [[px, y0], [px, y1]], stroke: GRID, strokeWidth: 0.5 });
      }
      for (const y of ys) {
        const [, py] = at(0, y);
        if (py <= bottom) primitives.push({ type: 'polyline', points: [[x0, py], [x1, py]], stroke: GRID, strokeWidth: 0.5 });
      }
    }

    const running = runningText(plan, index, planned.length);
    if (running.header) {
      primitives.push({ type: 'text', x: width / 2, y: margin * 0.35, text: running.header, size: 9, align: 'center', fill: '#333333' });
    }
    if (running.footer) {
      primitives.push({ type: 'text', x: width / 2, y: height - margin * 0.35 - 9, text: running.footer, size: 9, align: 'center', fill: '#333333' });
    }
    return { width, height, primitives };
  });
}
