/** Drawing only what can be seen. */

import { formatValue, alignmentFor } from './format.js';
import { columnName } from './references.js';
import { DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT } from './model.js';

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

    view.addEventListener('resize', () => this.draw());
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
  }

  drawCells({ firstRow, lastRow, firstCol, lastCol }) {
    const sheet = this.sheet.sheet;
    const styles = this.sheet.model.styles;
    const selection = this.sheet.selection;
    const { active } = this.sheet;

    let index = 0;

    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        const node = this.cellNode(index);
        index += 1;

        const cell = sheet.cell(row, col);
        const style = cell?.s ? styles[cell.s] ?? {} : {};
        const value = cell?.v ?? null;

        node.dataset.row = String(row);
        node.dataset.col = String(col);

        // A transform, not top/left: the whole point of 's performance
        // note.
        node.style.transform =
          `translate(${this.offsets.cols[col]}px, ${this.offsets.rows[row]}px)`;
        node.style.width = `${sheet.columnWidth(col)}px`;
        node.style.height = `${sheet.rowHeight(row)}px`;

        node.textContent = formatValue(value, style.format);
        node.style.textAlign = style.align ?? alignmentFor(value);
        node.style.fontWeight = style.bold ? '700' : '';
        node.style.fontStyle = style.italic ? 'italic' : '';
        node.style.color = style.color ?? '';
        node.style.background = style.bg ?? '';

        const selected = row >= selection.top && row <= selection.bottom
          && col >= selection.left && col <= selection.right;
        node.classList.toggle('selected', selected && !(row === active.row && col === active.col));
        node.classList.toggle('active', row === active.row && col === active.col);
        node.hidden = false;
      }
    }

    // Anything left over from a larger viewport is hidden rather than
    // removed, so it is there to be reused on the next pass.
    for (let i = index; i < this.pool.length; i += 1) this.pool[i].hidden = true;
  }

  drawHeaders({ firstRow, lastRow, firstCol, lastCol }) {
    const sheet = this.sheet.sheet;
    const selection = this.sheet.selection;

    let index = 0;
    for (let col = firstCol; col <= lastCol; col += 1) {
      const node = this.headerNode('columnPool', this.columnHeader, index);
      index += 1;
      node.textContent = columnName(col);
      node.dataset.col = String(col);
      node.style.transform = `translateX(${this.offsets.cols[col]}px)`;
      node.style.width = `${sheet.columnWidth(col)}px`;
      node.classList.toggle('in-selection', col >= selection.left && col <= selection.right);
      node.hidden = false;
    }
    for (let i = index; i < this.columnPool.length; i += 1) this.columnPool[i].hidden = true;

    index = 0;
    for (let row = firstRow; row <= lastRow; row += 1) {
      const node = this.headerNode('rowPool', this.rowHeader, index);
      index += 1;
      node.textContent = String(row + 1);
      node.dataset.row = String(row);
      node.style.transform = `translateY(${this.offsets.rows[row]}px)`;
      node.style.height = `${sheet.rowHeight(row)}px`;
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
