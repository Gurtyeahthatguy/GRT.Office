// @vitest-environment jsdom

/** Sheets on paper. */

import { describe, it, expect } from 'vitest';
import { Sheet, GridModel, normalisePrint, PRINT_DEFAULTS } from '../src/js/model.js';
import { Engine } from '../src/js/engine/recalc.js';
import {
  layoutSheet, planPages, pageElements, pdfPages, parseArea, formatArea, parseRows, formatRows,
} from '../src/js/printing.js';
import { renderToPdf, mergePdfPages } from '../src/js/core/pdf.js';
import { PDFDocument } from '../src/vendor/pdf-lib.esm.js';

/** A sheet `rows` high and `cols` wide, every cell holding its own address. */
function filled(rows, cols) {
  const sheet = new Sheet();
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) sheet.set(r, c, { v: `${r}:${c}` });
  }
  return sheet;
}

const setup = (changes = {}) => normalisePrint({ ...PRINT_DEFAULTS, ...changes });
const all = (sheet) => sheet.usedBounds();

describe('reading what is typed', () => {
  it('reads print areas and rows to repeat', () => {
    expect(parseArea('B2:D10')).toEqual({ top: 1, left: 1, bottom: 9, right: 3 });
    expect(parseArea('$D$10:$B$2')).toEqual({ top: 1, left: 1, bottom: 9, right: 3 });
    expect(parseArea('C3')).toEqual({ top: 2, left: 2, bottom: 2, right: 2 });
    expect(parseArea('')).toBeNull();
    expect(parseArea('nonsense')).toBeNull();
    expect(formatArea({ top: 1, left: 1, bottom: 9, right: 3 })).toBe('B2:D10');
    expect(parseRows('1')).toEqual({ top: 0, bottom: 0 });
    expect(parseRows('$3:$1')).toEqual({ top: 0, bottom: 2 });
    expect(parseRows('0')).toBeNull();
    expect(parseRows('A')).toBeNull();
    expect(formatRows({ top: 0, bottom: 2 })).toBe('1:3');
  });
});

describe('cutting a sheet into pages', () => {
  it('fills a page down, then starts the next', () => {
    const sheet = filled(100, 3);
    const { pages, scale } = layoutSheet(sheet, setup(), all(sheet));
    expect(scale).toBe(1);
    expect(pages.map((p) => p.rows.length)).toEqual([42, 42, 16]);
    expect(pages.flatMap((p) => p.rows)).toEqual([...Array(100).keys()]);
  });

  it('prints down, then across, when the columns do not fit', () => {
    const sheet = filled(60, 10);
    const { pages } = layoutSheet(sheet, setup(), all(sheet));
    expect(pages.map((p) => [p.rows[0], p.cols[0], p.cols.length])).toEqual([[0, 0, 7], [42, 0, 7], [0, 7, 3], [42, 7, 3]]);
  });

  it('shrinks to the page width when asked, and then fits more rows', () => {
    // 59 rows of 24 px shrunk to 71% fit in 1009 px.
    const sheet = filled(59, 10);
    const { pages, scale } = layoutSheet(sheet, setup({ fitWidth: true }), all(sheet));
    expect(scale).toBeCloseTo(680.3 / 960, 2);
    expect(pages).toHaveLength(1);
    expect(pages[0].cols).toHaveLength(10);
  });

  it('starts pages where breaks are set', () => {
    const sheet = filled(30, 3);
    const { pages } = layoutSheet(sheet, setup({ rowBreaks: [10, 20], colBreaks: [2] }), all(sheet));
    expect(pages.map((p) => [p.rows[0], p.rows.length, p.cols[0]])).toEqual([[0, 10, 0], [10, 10, 0], [20, 10, 0], [0, 10, 2], [10, 10, 2], [20, 10, 2]]);
  });

  it('repeats the header rows on every page after the first, in the room they take', () => {
    const sheet = filled(100, 2);
    const { pages } = layoutSheet(sheet, setup({ repeatRows: { top: 0, bottom: 1 } }), all(sheet));
    expect(pages[0].repeat).toEqual([]);
    expect(pages[0].rows.length).toBe(42);
    expect(pages[1].repeat).toEqual([0, 1]);
    expect(pages[1].rows.length).toBe(40);
    expect(pages.flatMap((p) => p.rows)).toEqual([...Array(100).keys()]);
  });

  it('repeats rows above a print area on its first page too', () => {
    const sheet = filled(20, 2);
    const area = { top: 5, left: 0, bottom: 19, right: 1 };
    const { pages } = layoutSheet(sheet, setup({ repeatRows: { top: 0, bottom: 0 } }), area);
    expect(pages).toHaveLength(1);
    expect(pages[0].repeat).toEqual([0]);
    expect(pages[0].rows[0]).toBe(5);
  });

  it('gives a row taller than the page a page of its own', () => {
    const sheet = filled(3, 1);
    sheet.setRowHeight(1, 2000);
    const { pages } = layoutSheet(sheet, setup(), all(sheet));
    expect(pages.map((p) => p.rows)).toEqual([[0], [1], [2]]);
  });

  it('prints an empty sheet as one blank page', () => {
    const planned = planPages([{ sheet: new Sheet(), setup: setup(), area: null }]);
    expect(planned).toHaveLength(1);
    expect(planned[0].page.rows).toEqual([]);
  });

  it('lays the paper on its side', () => {
    const sheet = filled(1, 1);
    expect(layoutSheet(sheet, setup({ orientation: 'landscape', size: 'A5' }), all(sheet)).paper).toEqual({ width: 210, height: 148 });
  });
});

describe('the printed page', () => {
  it('draws the cells with their look, headers, footers and gridlines', () => {
    const model = new GridModel();
    const sheet = model.sheet;
    sheet.set(0, 0, { v: 'Total', s: 'header' });
    sheet.set(0, 1, { v: 1234.5, s: 'currency' });
    const planned = planPages([{ sheet, setup: setup({ gridlines: true }), area: sheet.usedBounds() }]);
    const [page] = pageElements(planned, model.styles);
    const cells = [...page.querySelectorAll('.print-cell')];
    expect(cells.map((c) => c.textContent)).toEqual(['Total', '1,234.50']);
    expect(cells[0].style.fontWeight).toBe('700');
    expect(cells[1].style.textAlign).toBe('right');
    expect(cells[1].style.left).toBe('96px');
    expect(page.querySelector('.print-header').textContent).toBe('Sheet1');
    expect(page.querySelector('.print-footer').textContent).toBe('Page 1 of 1');
    // Three column edges and two row edges.
    expect(page.querySelectorAll('.print-rule')).toHaveLength(5);
  });

  it('numbers pages through every sheet printed', () => {
    const one = filled(50, 1);
    one.name = 'One';
    const two = filled(1, 1);
    two.name = 'Two';
    const planned = planPages([{ sheet: one, setup: setup(), area: all(one) }, { sheet: two, setup: setup(), area: all(two) }]);
    const pages = pageElements(planned, {});
    expect(pages.map((p) => [p.querySelector('.print-header').textContent, p.querySelector('.print-footer').textContent]))
      .toEqual([['One', 'Page 1 of 3'], ['One', 'Page 2 of 3'], ['Two', 'Page 3 of 3']]);
  });
});

describe('PDF', () => {
  it('writes every page on its sheet’s own paper, with the text in it', async () => {
    const model = new GridModel();
    const sheet = model.sheet;
    sheet.set(0, 0, { v: 'Quarterly figures', s: 'header' });
    sheet.set(1, 0, { v: 42 });
    sheet.print = setup({ size: 'A5', orientation: 'landscape', gridlines: true });
    const planned = planPages([{ sheet, setup: sheet.print, area: sheet.usedBounds() }]);
    const pages = pdfPages(planned, model.styles);
    expect(pages[0].width).toBeCloseTo(595.3, 0);
    expect(pages[0].height).toBeCloseTo(419.5, 0);
    const texts = pages[0].primitives.filter((p) => p.type === 'text').map((p) => p.text);
    expect(texts).toEqual(['Quarterly figures', '42', 'Sheet1', 'Page 1 of 1']);
    const bytes = await mergePdfPages([await renderToPdf(pages[0], { audit: false })]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize().width).toBeCloseTo(595.3, 0);
  });

  it('keeps text inside its cell', async () => {
    const model = new GridModel();
    model.sheet.set(0, 0, { v: 'A long sentence that does not fit in one narrow column at all' });
    const planned = planPages([{ sheet: model.sheet, setup: setup({ labels: false }), area: model.sheet.usedBounds() }]);
    const [page] = pdfPages(planned, model.styles);
    const [text] = page.primitives;
    expect(text.maxWidth).toBeCloseTo((96 - 10) * 0.75, 3);
    await expect(renderToPdf(page, { audit: false })).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('print settings follow the rows and columns', () => {
  function engineFor(sheet) {
    const model = new GridModel();
    model.sheets = [sheet];
    model.activeSheetId = sheet.id;
    return new Engine(model);
  }

  it('moves the print area, repeated rows, breaks and row heights when rows are inserted', () => {
    const sheet = filled(20, 4);
    sheet.setRowHeight(5, 40);
    sheet.print = setup({ area: { top: 2, left: 0, bottom: 10, right: 3 }, repeatRows: { top: 0, bottom: 1 }, rowBreaks: [8] });
    engineFor(sheet).applyStructuralChange(sheet.id, { axis: 'row', at: 1, count: 2 });
    expect(sheet.print.area).toEqual({ top: 4, left: 0, bottom: 12, right: 3 });
    expect(sheet.print.repeatRows).toEqual({ top: 0, bottom: 3 });
    expect(sheet.print.rowBreaks).toEqual([10]);
    expect(sheet.rowHeight(7)).toBe(40);
    expect(sheet.rowHeight(5)).toBe(24);
  });

  it('shrinks them when rows go, and drops what went entirely', () => {
    const sheet = filled(20, 4);
    sheet.setColumnWidth(3, 200);
    sheet.frozen = { rows: 0, cols: 2 };
    sheet.print = setup({ area: { top: 0, left: 1, bottom: 5, right: 3 }, colBreaks: [1, 3] });
    engineFor(sheet).applyStructuralChange(sheet.id, { axis: 'col', at: 1, count: -1 });
    expect(sheet.print.area).toEqual({ top: 0, left: 1, bottom: 5, right: 2 });
    expect(sheet.print.colBreaks).toEqual([2]);
    expect(sheet.columnWidth(2)).toBe(200);
    expect(sheet.frozen.cols).toBe(1);
    engineFor(sheet).applyStructuralChange(sheet.id, { axis: 'col', at: 1, count: -5 });
    expect(sheet.print.area).toBeNull();
  });

  it('saves nothing for a sheet that prints as it always did', () => {
    expect(new Sheet().toJSON()).not.toHaveProperty('print');
    const sheet = new Sheet({ print: { gridlines: true, area: { top: 0, left: 0, bottom: 1, right: 1 } } });
    expect(sheet.toJSON().print).toEqual({ gridlines: true, area: { top: 0, left: 0, bottom: 1, right: 1 } });
    expect(new Sheet(sheet.toJSON()).print).toEqual(sheet.print);
  });

  it('refuses settings that make no sense', () => {
    const print = normalisePrint({ margin: 900, area: { top: 5, left: 0, bottom: 1, right: 0 }, rowBreaks: [3, -1, 3, 'x', 0], size: 'custom' });
    expect(print.margin).toBe(50);
    expect(print.area).toBeNull();
    expect(print.rowBreaks).toEqual([3]);
    expect(print.size).toBe('A4');
  });
});
