/** Format, Table: the cells chosen in a table, and what Impress's Table menu does with them. */

import {
  widen, insertRows, deleteRows, insertCols, deleteCols, mergeCells, unmergeCells, distribute, fitToText, mergeAt,
} from './tables.js';

/**
 * @param {{model: () => Object, slideId: () => string, chosen: () => Object[], change: Function, toast: Function,
 *   surface: HTMLElement, select: (ids: string[]) => void, size: (element: Object) => number}} app
 */
export function tableTools(app) {
  /** The cells chosen: the table they are in, where the choice began, and the block it covers. */
  let cells = null;

  const table = () => {
    const found = app.chosen().filter((e) => e.kind === 'table');
    return found.length === 1 ? found[0] : null;
  };

  /** The block the commands work on: the cells chosen in this table, or all of it. */
  function area(element) {
    if (cells && cells.id === element.id) {
      const block = {
        top: Math.min(cells.anchor.row, cells.focus.row), bottom: Math.max(cells.anchor.row, cells.focus.row),
        left: Math.min(cells.anchor.col, cells.focus.col), right: Math.max(cells.anchor.col, cells.focus.col),
      };
      const fits = block.bottom < element.rows && block.right < element.cols;
      if (fits) return widen(element, block);
    }
    return { top: 0, left: 0, bottom: element.rows - 1, right: element.cols - 1 };
  }

  /** A press on a cell of the chosen table chooses it, or with Shift stretches the choice to it. */
  function press(event) {
    const td = event.target?.closest?.('td[data-row]');
    const box = td?.closest('[data-id]');
    if (!td || !box) {
      if (!event.target?.closest?.('.grt-menubar, .grt-menu, #overlay')) cells = null;
      return;
    }
    const at = { row: Number(td.dataset.row), col: Number(td.dataset.col) };
    if (event.shiftKey && cells?.id === box.dataset.id) cells = { ...cells, focus: at };
    else cells = { id: box.dataset.id, anchor: at, focus: at };
    mark();
  }

  /** Shows the chosen cells; called after every drawing of the slide. */
  function mark() {
    for (const td of app.surface.querySelectorAll('td.cell-chosen')) td.classList.remove('cell-chosen');
    const element = table();
    if (!element || !cells || cells.id !== element.id) return;
    const block = area(element);
    for (const td of app.surface.querySelectorAll(`[data-id="${CSS.escape(element.id)}"] td[data-row]`)) {
      const row = Number(td.dataset.row);
      const col = Number(td.dataset.col);
      if (row >= block.top && row <= block.bottom && col >= block.left && col <= block.right) td.classList.add('cell-chosen');
    }
  }

  /** Runs a change on the chosen table as one step; the choice of cells follows what `after` says. */
  function onTable(op, after = null) {
    const element = table();
    if (!element) return app.toast('Choose a table first');
    const block = area(element);
    let result = false;
    app.change(() => {
      result = app.model().changeTable(app.slideId(), element.id, (live) => op(live, block));
      return result;
    });
    if (after && result !== false) {
      const next = after(block, app.model().element(app.slideId(), element.id));
      cells = next ? { id: element.id, anchor: { row: next.top, col: next.left }, focus: { row: next.bottom, col: next.right } } : null;
      mark();
    }
    return result;
  }

  const selectRow = () => {
    const element = table();
    if (!element) return app.toast('Choose a table first');
    const block = area(element);
    cells = { id: element.id, anchor: { row: block.top, col: 0 }, focus: { row: block.bottom, col: element.cols - 1 } };
    mark();
  };
  const selectColumn = () => {
    const element = table();
    if (!element) return app.toast('Choose a table first');
    const block = area(element);
    cells = { id: element.id, anchor: { row: 0, col: block.left }, focus: { row: element.rows - 1, col: block.right } };
    mark();
  };
  const selectTable = () => {
    const element = table();
    if (!element) return app.toast('Choose a table first');
    cells = { id: element.id, anchor: { row: 0, col: 0 }, focus: { row: element.rows - 1, col: element.cols - 1 } };
    mark();
  };

  const rowsAbove = () => onTable((e, b) => insertRows(e, b.top, b.bottom - b.top + 1) || full('rows'));
  const rowsBelow = () => onTable((e, b) => insertRows(e, b.bottom + 1, b.bottom - b.top + 1) || full('rows'));
  const columnsBefore = () => onTable((e, b) => insertCols(e, b.left, b.right - b.left + 1) || full('columns'));
  const columnsAfter = () => onTable((e, b) => insertCols(e, b.right + 1, b.right - b.left + 1) || full('columns'));
  const full = (what) => {
    app.toast(`A table holds at most ${what === 'rows' ? '30 rows' : '12 columns'}`);
    return false;
  };

  const removeRows = () => onTable((e, b) => {
    if (b.bottom - b.top + 1 >= e.rows) return app.toast('A table keeps one row at least; use Delete Table to take it away'), false;
    return deleteRows(e, b.top, b.bottom - b.top + 1);
  }, () => null);
  const removeColumns = () => onTable((e, b) => {
    if (b.right - b.left + 1 >= e.cols) return app.toast('A table keeps one column at least; use Delete Table to take it away'), false;
    return deleteCols(e, b.left, b.right - b.left + 1);
  }, () => null);

  const merge = () => onTable((e, b) => mergeCells(e, b) || (app.toast('Choose two cells or more to merge'), false), (b) => b);
  const unmerge = () => onTable((e, b) => {
    const block = cells ? b : (mergeAt(e, b.top, b.left) ?? b);
    return unmergeCells(e, block) || (app.toast('There are no merged cells there'), false);
  }, (b) => b);

  const evenRows = () => onTable((e, b) => distribute(e, 'row', b.top, b.bottom === b.top ? e.rows - 1 : b.bottom), (b) => b);
  const evenColumns = () => onTable((e, b) => distribute(e, 'col', b.left, b.right === b.left ? e.cols - 1 : b.right), (b) => b);

  /** The size a text takes in a cell, at the table's font size, wrapped at a width. */
  let context = null;
  function measure(element) {
    const size = app.size(element);
    context ??= document.createElement('canvas').getContext('2d');
    if (context) context.font = `${size}px sans-serif`;
    const width = (text) => (context ? context.measureText(text).width : text.length * size * 0.55);
    return (text, room) => {
      let lines = 0;
      let widest = 0;
      for (const paragraph of String(text).split('\n')) {
        if (room === Infinity) {
          widest = Math.max(widest, width(paragraph));
          lines += 1;
          continue;
        }
        let line = '';
        lines += 1;
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
          const next = line ? `${line} ${word}` : word;
          if (line && width(next) > room) {
            lines += 1;
            line = word;
          } else line = next;
        }
      }
      return { width: widest, height: Math.max(1, lines) * size * 1.25 };
    };
  }

  const fit = (axis, mode) => onTable((e, b) => {
    const [from, to] = axis === 'row' ? [b.top, b.bottom] : [b.left, b.right];
    const whole = from === to && !cells;
    return fitToText(e, axis, mode, whole ? 0 : from, whole ? (axis === 'row' ? e.rows - 1 : e.cols - 1) : to, measure(e));
  }, (b) => b);

  function deleteTable() {
    const element = table();
    if (!element) return app.toast('Choose a table first');
    cells = null;
    app.change(() => app.model().deleteElements(app.slideId(), [element.id]));
    app.select([]);
  }

  /** Chooses one cell, as a find does when it lands in a table. */
  function choose(id, row, col) {
    cells = { id, anchor: { row, col }, focus: { row, col } };
    mark();
  }

  return {
    press, mark, choose, selectRow, selectColumn, selectTable, rowsAbove, rowsBelow, columnsBefore, columnsAfter, removeRows, removeColumns,
    merge, unmerge, evenRows, evenColumns, deleteTable,
    minimalRows: () => fit('row', 'minimal'), optimalRows: () => fit('row', 'optimal'),
    minimalColumns: () => fit('col', 'minimal'), optimalColumns: () => fit('col', 'optimal'),
    get cells() { return cells; },
  };
}
