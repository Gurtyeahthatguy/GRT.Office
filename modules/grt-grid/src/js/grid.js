/** Drawing only what can be seen. */

import { formatValue, alignmentFor } from './format.js';
import { columnName } from './references.js';
import { DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT } from './model.js';
import { chartSvg } from './core/charts.js';
import { chartSpec } from './charts.js';

/** How many extra rows and columns to draw beyond the viewport. */
const OVERSCAN = 6;

/**
 * How far the grid extends past the data, so there is always somewhere to go.
 */
const SPARE_ROWS = 200;
const SPARE_COLS = 20;

export class GridView {
  /**
   * @param {HTMLElement} container the scrolling element
   * @param {import('./controller.js').SheetController} sheet
   */
  constructor(container, sheet) {
    this.container = container;
    this.sheet = sheet;

    this.body = container.querySelector('.grid-body');
    this.columnHeader = container.querySelector('.grid-column-header');
    this.rowHeader = container.querySelector('.grid-row-header');

    /**
     * The headers occupy the first grid row and column, so the cells start
     * this far into the scrolled content.
     */
    this.headOffset = { top: 0, left: 0 };

    /** Reused cell elements, keyed by their pool index. */
    this.pool = [];
    this.columnPool = [];
    this.rowPool = [];

    this.offsets = { rows: [0], cols: [0] };
    this.rebuildOffsets();
    this.watchSize();
  }

  /** Redraws when the viewport changes. */
  watchSize() {
    const view = this.container.ownerDocument.defaultView;
    if (!view) return;

    if (typeof view.ResizeObserver === 'function') {
      this.observer = new view.ResizeObserver(() => this.draw());
      this.observer.observe(this.container);
      return;
    }

    this.onResize = () => this.draw();
    view.addEventListener('resize', this.onResize);
  }

  /** Takes this view off the page, before another view replaces it. */
  dispose() {
    this.observer?.disconnect();
    if (this.onResize) this.container.ownerDocument.defaultView?.removeEventListener('resize', this.onResize);
    for (const node of [...this.pool, ...this.columnPool, ...this.rowPool, ...(this.chartNodes?.values() ?? [])]) node.remove();
    this.chartNodes = new Map();
    this.pool = [];
    this.columnPool = [];
    this.rowPool = [];
  }

  // Geometry

  get rowCount() {
    const bounds = this.sheet.sheet.usedBounds();
    return Math.max((bounds?.bottom ?? 0) + SPARE_ROWS, SPARE_ROWS);
  }

  get colCount() {
    const bounds = this.sheet.sheet.usedBounds();
    return Math.max((bounds?.right ?? 0) + SPARE_COLS, SPARE_COLS);
  }

  /** Cumulative pixel offsets for every row and column. */
  rebuildOffsets() {
    const sheet = this.sheet.sheet;

    const rows = new Array(this.rowCount + 1);
    rows[0] = 0;
    for (let i = 0; i < this.rowCount; i += 1) rows[i + 1] = rows[i] + sheet.rowHeight(i);

    const cols = new Array(this.colCount + 1);
    cols[0] = 0;
    for (let i = 0; i < this.colCount; i += 1) cols[i + 1] = cols[i] + sheet.columnWidth(i);

    this.offsets = { rows, cols };

    // The body's own size is what gives the scroll bars their length.
    const totalHeight = rows[rows.length - 1];
    const totalWidth = cols[cols.length - 1];

    this.body.style.width = `${totalWidth}px`;
    this.body.style.height = `${totalHeight}px`;
    this.columnHeader.style.width = `${totalWidth}px`;
    this.rowHeader.style.height = `${totalHeight}px`;

    this.measureHeads();
  }

  /** How far into the scrolled content the cells begin. */
  measureHeads() {
    const styles = this.container.ownerDocument.defaultView?.getComputedStyle?.(this.container);
    const read = (name, fallback) => {
      const value = Number.parseFloat(styles?.getPropertyValue(name) ?? '');
      return Number.isFinite(value) ? value : fallback;
    };
    this.headOffset = { top: read('--head-h', 24), left: read('--head-w', 52) };
  }

  /** The index whose band contains a pixel offset. */
  indexAt(axis, pixels) {
    const offsets = this.offsets[axis];
    let low = 0;
    let high = offsets.length - 1;

    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (offsets[middle] <= pixels) low = middle;
      else high = middle - 1;
    }

    return Math.min(low, offsets.length - 2);
  }

  /** Which rows and columns are worth drawing. */
  visibleRange() {
    const { scrollTop, scrollLeft, clientHeight, clientWidth } = this.container;

    const top = scrollTop - this.headOffset.top;
    const left = scrollLeft - this.headOffset.left;

    const firstRow = Math.max(0, this.indexAt('rows', top) - OVERSCAN);
    const lastRow = Math.min(this.rowCount - 1,
      this.indexAt('rows', top + clientHeight) + OVERSCAN);

    const firstCol = Math.max(0, this.indexAt('cols', left) - OVERSCAN);
    const lastCol = Math.min(this.colCount - 1,
      this.indexAt('cols', left + clientWidth) + OVERSCAN);

    return { firstRow, lastRow, firstCol, lastCol };
  }

  // Drawing

  draw() {
    const range = this.visibleRange();
    this.drawCells(range);
    this.drawHeaders(range);
    this.drawCharts();
  }

  /** Where a line starts, past the end of the offsets counted at the default size. */
  offsetAt(axis, index) {
    const list = this.offsets[axis];
    if (index < list.length) return list[index];
    return list[list.length - 1] + (index - list.length + 1) * (axis === 'rows' ? DEFAULT_ROW_HEIGHT : DEFAULT_COLUMN_WIDTH);
  }

  /** The cell a point of the sheet falls in, and how far into it. */
  anchorAt(x, y) {
    const find = (axis, at) => {
      const list = this.offsets[axis];
      let low = 0;
      let high = list.length - 2;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (list[mid] <= at) low = mid; else high = mid - 1;
      }
      return Math.max(0, low);
    };
    const row = find('rows', Math.max(0, y));
    const col = find('cols', Math.max(0, x));
    return { row, col, dx: Math.round(Math.max(0, x) - this.offsets.cols[col]), dy: Math.round(Math.max(0, y) - this.offsets.rows[row]) };
  }

  /** A chart's box in the sheet's pixels. */
  chartBox(chart) {
    const anchor = chart.anchor ?? { row: 0, col: 0 };
    return {
      x: this.offsetAt('cols', anchor.col) + (anchor.dx ?? 0), y: this.offsetAt('rows', anchor.row) + (anchor.dy ?? 0),
      width: Math.max(80, chart.width ?? 480), height: Math.max(60, chart.height ?? 300),
    };
  }

  /** The charts of the sheet in view, drawn again only when their data, size or the theme changed. */
  drawCharts() {
    const model = this.sheet.model;
    const doc = this.body.ownerDocument;
    this.chartNodes ??= new Map();
    const shown = new Set();
    const style = doc.defaultView?.getComputedStyle?.(this.container);
    const ink = style?.getPropertyValue('--text').trim() || '#333333';
    const paper = style?.getPropertyValue('--bg-raised').trim() || '#ffffff';
    const rule = style?.getPropertyValue('--rule').trim() || '#d9d9d9';
    for (const chart of model.charts ?? []) {
      if ((chart.sheet ?? model.sheets[0]?.id) !== this.sheet.sheetId) continue;
      shown.add(chart.id);
      let node = this.chartNodes.get(chart.id);
      if (!node) {
        node = doc.createElement('div');
        node.className = 'chart-frame';
        node.dataset.chart = chart.id;
        const handle = doc.createElement('span');
        handle.className = 'chart-handle';
        node.append(doc.createElement('div'), handle);
        this.body.append(node);
        this.chartNodes.set(chart.id, node);
      }
      const box = this.chartBox(chart);
      node.style.transform = `translate(${box.x}px, ${box.y}px)`;
      node.style.width = `${box.width}px`;
      node.style.height = `${box.height}px`;
      node.classList.toggle('chosen', this.sheet.chosenChart === chart.id);
      const stamp = `${this.sheet.stamp ?? 0}|${box.width}x${box.height}|${ink}|${paper}|${JSON.stringify(chart)}`;
      if (node.dataset.stamp !== stamp) {
        const spec = chartSpec(chart, this.sheet.engine, model);
        node.firstChild.innerHTML = chartSvg(spec, { width: box.width, height: box.height, text: ink, background: paper, grid: rule });
        node.setAttribute('aria-label', spec.title || `${spec.type} chart`);
        node.dataset.stamp = stamp;
      }
    }
    for (const [id, node] of this.chartNodes) {
      if (shown.has(id)) continue;
      node.remove();
      this.chartNodes.delete(id);
    }
  }

  drawCells({ firstRow, lastRow, firstCol, lastCol }) {
    const sheet = this.sheet.sheet;
    this.container.classList.toggle('no-gridlines', this.sheet.view?.gridlines === false);
    const styles = this.sheet.model.styles;
    const selection = this.sheet.selection;
    const { active } = this.sheet;
    const { scrollTop, scrollLeft } = this.container;
    const frozenRows = Math.min(sheet.frozen.rows, this.rowCount);
    const frozenCols = Math.min(sheet.frozen.cols, this.colCount);

    const rowBreaks = new Set(sheet.print.rowBreaks);
    const colBreaks = new Set(sheet.print.colBreaks);
    const rows = lines(frozenRows, firstRow, lastRow);
    const cols = lines(frozenCols, firstCol, lastCol);
    const places = [];
    for (const row of rows) for (const col of cols) places.push([row, col]);
    // A merged block whose top-left cell is out of view is still drawn where it shows.
    for (const m of sheet.merges) {
      if (m.bottom < firstRow || m.top > lastRow || m.right < firstCol || m.left > lastCol) continue;
      if (!rows.includes(m.top) || !cols.includes(m.left)) places.push([m.top, m.left]);
    }
    let index = 0;

    for (const [row, col] of places) {
      const node = this.cellNode(index);
      index += 1;

      const merge = sheet.merges.length > 0 ? sheet.mergeAt(row, col) : null;
      const covered = merge && (merge.top !== row || merge.left !== col);
      const width = merge && !covered ? this.offsets.cols[merge.right + 1] - this.offsets.cols[merge.left] : sheet.columnWidth(col);
      const height = merge && !covered ? this.offsets.rows[merge.bottom + 1] - this.offsets.rows[merge.top] : sheet.rowHeight(row);
      if (covered || width <= 0 || height <= 0) {
        node.hidden = true;
        continue;
      }

      const cell = sheet.cell(row, col);
      const style = { ...(cell?.s ? styles[cell.s] ?? {} : {}), ...this.conditionalStyle(row, col) };
      // The value, spilled ones included, which the cell itself does not hold.
      const value = sheet.valueAt(row, col);

      node.dataset.row = String(row);
      node.dataset.col = String(col);

      // Placed with a transform rather than top and left; frozen rows and columns ride along with the scroll.
      const x = this.offsets.cols[col] + (col < frozenCols ? scrollLeft : 0);
      const y = this.offsets.rows[row] + (row < frozenRows ? scrollTop : 0);
      node.style.transform = `translate(${x}px, ${y}px)`;
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
      node.classList.toggle('frozen', row < frozenRows || col < frozenCols);
      node.classList.toggle('frozen-corner', row < frozenRows && col < frozenCols);
      node.classList.toggle('merged', Boolean(merge));

      const view = this.sheet.view ?? {};
      const asFormula = view.formulas && cell?.f;
      node.textContent = asFormula ? cell.f : formatValue(value, style.format);
      applyLook(node, style, value);
      if (asFormula) node.style.textAlign = 'left';
      // Value highlighting: numbers, text and formulas told apart by colour, over the cell's own.
      const kind = !view.values || value === null || value === undefined || value === '' ? null
        : cell?.f ? 'formula' : typeof value === 'number' ? 'number' : 'text';
      for (const each of ['formula', 'number', 'text']) node.classList.toggle(`value-${each}`, kind === each);
      node.classList.toggle('crosshair', Boolean(view.crosshair) && (row === active.row || col === active.col));
      const filter = sheet.filter;
      if (filter && row === filter.area.top && col >= filter.area.left && col <= filter.area.right) {
        node.append(cornerButton(node, 'filter-button', col, Boolean(filter.columns[String(col - filter.area.left)])));
      } else if (row === active.row && col === active.col && this.sheet.validationAt?.(row, col)?.type === 'list'
        && this.sheet.validationAt(row, col).dropdown !== false) {
        node.append(cornerButton(node, 'list-button', col, false));
      }

      const selected = row >= selection.top && row <= selection.bottom
        && col >= selection.left && col <= selection.right;
      node.classList.toggle('selected', selected && !(row === active.row && col === active.col));
      node.classList.toggle('active', row === active.row && col === active.col);
      node.classList.toggle('break-above', rowBreaks.has(row));
      node.classList.toggle('break-left', colBreaks.has(col));
      node.classList.toggle('frozen-edge-bottom', frozenRows > 0 && row === frozenRows - 1);
      node.classList.toggle('frozen-edge-right', frozenCols > 0 && col === frozenCols - 1);
      node.hidden = false;
    }

    // Anything left over from a larger viewport is hidden rather than
    // removed, so it is there to be reused on the next pass.
    for (let i = index; i < this.pool.length; i += 1) this.pool[i].hidden = true;
  }

  /** The look conditional formatting gives a cell, or nothing. */
  conditionalStyle(row, col) {
    return this.sheet.conditionalStyleAt?.(row, col) ?? {};
  }

  drawHeaders({ firstRow, lastRow, firstCol, lastCol }) {
    const sheet = this.sheet.sheet;
    const selection = this.sheet.selection;

    let index = 0;
    for (const col of lines(Math.min(sheet.frozen.cols, this.colCount), firstCol, lastCol)) {
      const node = this.headerNode('columnPool', this.columnHeader, index);
      index += 1;
      node.textContent = columnName(col);
      node.dataset.col = String(col);
      node.style.transform = `translateX(${this.offsets.cols[col] + (col < sheet.frozen.cols ? this.container.scrollLeft : 0)}px)`;
      node.style.width = `${sheet.columnWidth(col)}px`;
      node.classList.toggle('frozen', col < sheet.frozen.cols);
      if (sheet.columnWidth(col) === 0) { node.hidden = true; continue; }
      node.classList.toggle('in-selection', col >= selection.left && col <= selection.right);
      node.hidden = false;
    }
    for (let i = index; i < this.columnPool.length; i += 1) this.columnPool[i].hidden = true;

    index = 0;
    for (const row of lines(Math.min(sheet.frozen.rows, this.rowCount), firstRow, lastRow)) {
      const node = this.headerNode('rowPool', this.rowHeader, index);
      index += 1;
      node.textContent = String(row + 1);
      node.dataset.row = String(row);
      node.style.transform = `translateY(${this.offsets.rows[row] + (row < sheet.frozen.rows ? this.container.scrollTop : 0)}px)`;
      node.style.height = `${sheet.rowHeight(row)}px`;
      node.classList.toggle('frozen', row < sheet.frozen.rows);
      node.classList.toggle('filtered', sheet.filtered.has(row));
      if (sheet.rowHeight(row) === 0) { node.hidden = true; continue; }
      node.classList.toggle('in-selection', row >= selection.top && row <= selection.bottom);
      node.hidden = false;
    }
    for (let i = index; i < this.rowPool.length; i += 1) this.rowPool[i].hidden = true;
  }

  /** A cell element from the pool, made if the pool is not big enough yet. */
  cellNode(index) {
    let node = this.pool[index];
    if (!node) {
      node = this.body.ownerDocument.createElement('div');
      node.className = 'cell';
      this.body.append(node);
      this.pool[index] = node;
    }
    return node;
  }

  headerNode(poolName, host, index) {
    let node = this[poolName][index];
    if (!node) {
      node = host.ownerDocument.createElement('div');
      node.className = poolName === 'columnPool' ? 'column-head' : 'row-head';
      host.append(node);
      this[poolName][index] = node;
    }
    return node;
  }

  /** Scrolls until the active cell is inside the viewport. */
  revealActive() {
    const { row, col } = this.sheet.active;
    const top = this.offsets.rows[row];
    const bottom = this.offsets.rows[row + 1] ?? top + DEFAULT_ROW_HEIGHT;
    const left = this.offsets.cols[col];
    const right = this.offsets.cols[col + 1] ?? left + DEFAULT_COLUMN_WIDTH;

    const { scrollTop, scrollLeft, clientHeight, clientWidth } = this.container;

    // In the scrolled content, a cell sits a header further along than its
    // offset within the body.
    const contentTop = top + this.headOffset.top;
    const contentBottom = bottom + this.headOffset.top;
    const contentLeft = left + this.headOffset.left;
    const contentRight = right + this.headOffset.left;

    if (contentTop < scrollTop + this.headOffset.top) {
      this.container.scrollTop = contentTop - this.headOffset.top;
    } else if (contentBottom > scrollTop + clientHeight) {
      this.container.scrollTop = contentBottom - clientHeight;
    }

    if (contentLeft < scrollLeft + this.headOffset.left) {
      this.container.scrollLeft = contentLeft - this.headOffset.left;
    } else if (contentRight > scrollLeft + clientWidth) {
      this.container.scrollLeft = contentRight - clientWidth;
    }
  }
}

/** The small arrow a filter's header or a cell with a list of choices shows. */
function cornerButton(node, kind, col, on) {
  const button = node.ownerDocument.createElement('span');
  button.className = `${kind}${on ? ' on' : ''}`;
  button.dataset.col = String(col);
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', kind === 'filter-button' ? 'Filter this column' : 'Choose from the list');
  return button;
}

/** The frozen lines first, then the ones in view after them. */
function lines(frozen, first, last) {
  const out = [];
  for (let i = 0; i < frozen; i += 1) out.push(i);
  for (let i = Math.max(first, frozen); i <= last; i += 1) out.push(i);
  return out;
}

/** Puts a cell's style on its element: font, colours, alignment, wrapping and borders. */
export function applyLook(node, style, value) {
  node.style.textAlign = style.align ?? alignmentFor(value);
  node.style.fontWeight = style.bold ? '700' : '';
  node.style.fontStyle = style.italic ? 'italic' : '';
  const lines = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  node.style.textDecoration = lines;
  node.style.color = style.color ?? '';
  node.style.background = style.bg ?? '';
  node.style.fontFamily = style.font ?? '';
  node.style.fontSize = style.size ? `${style.size}pt` : '';
  node.style.whiteSpace = style.wrap ? 'pre-wrap' : '';
  node.style.lineHeight = style.wrap ? '1.25' : '';
  node.style.alignContent = style.valign === 'top' ? 'start' : style.valign === 'middle' ? 'center' : style.valign === 'bottom' ? 'end' : '';
  node.style.paddingLeft = style.indent ? `${5 + style.indent * 10}px` : '';
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const border = style.borders?.[side];
    const name = `border${side[0].toUpperCase()}${side.slice(1)}`;
    node.style[name] = border ? `${border.width ?? 1}px ${border.style ?? 'solid'} ${border.color ?? '#000000'}` : '';
  }
  if (style.bar) {
    node.style.backgroundImage = `linear-gradient(to right, ${style.bar.color} ${Math.round(style.bar.fraction * 100)}%, transparent ${Math.round(style.bar.fraction * 100)}%)`;
  } else node.style.backgroundImage = '';
}

