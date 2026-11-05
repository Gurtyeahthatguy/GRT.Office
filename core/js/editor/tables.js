/** Changes to a table's shape: rows, columns, merged cells and how cells look. */

import { normaliseTable, TABLE_LIMITS, normaliseRuns } from './model.js';
import { point, collapsed, normalise } from './selection.js';

const empty = () => ({ runs: [{ text: '' }] });

/** The table the selection is in, with the row and column of each end. */
export function tableAt(model, selection) {
  const { start, end } = normalise(selection, model);
  const block = model.block(start.blockId);
  if (block?.kind !== 'table' || start.blockId !== end.blockId) return null;
  const cols = block.rows[0].cells.length;
  const at = (index) => ({ row: Math.floor((index ?? 0) / cols), col: (index ?? 0) % cols });
  const a = at(start.itemIndex);
  const b = at(end.itemIndex);
  return {
    block, cols,
    top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row), left: Math.min(a.col, b.col), right: Math.max(a.col, b.col),
    row: a.row, col: a.col,
  };
}

/** Clears the merges of a table so that its grid can change shape, then lets normalise mark them again. */
function reshape(block, change) {
  for (const row of block.rows) for (const cell of row.cells) delete cell.covered;
  change(block);
  normaliseTable(block);
}

const cursorIn = (block, row, col) => collapsed(point(block.id, 0, row * block.rows[0].cells.length + col));

export function insertRow(model, selection, below = true) {
  const at = tableAt(model, selection);
  if (!at || at.block.rows.length >= TABLE_LIMITS.rows) return selection;
  const index = below ? at.bottom + 1 : at.top;
  reshape(at.block, (block) => {
    // A merged block across the new row grows to cover it.
    for (const [r, row] of block.rows.entries()) {
      for (const cell of row.cells) if (cell.rowspan > 1 && r < index && r + cell.rowspan > index) cell.rowspan += 1;
    }
    block.rows.splice(index, 0, { cells: Array.from({ length: at.cols }, empty) });
  });
  model.dirty = true;
  return cursorIn(at.block, index, at.col);
}

export function deleteRows(model, selection) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  if (at.bottom - at.top + 1 >= at.block.rows.length) return deleteTable(model, selection);
  reshape(at.block, (block) => {
    for (const [r, row] of block.rows.entries()) {
      for (const cell of row.cells) {
        if (!(cell.rowspan > 1) || r >= at.top) continue;
        const overlap = Math.max(0, Math.min(r + cell.rowspan - 1, at.bottom) - at.top + 1);
        cell.rowspan -= overlap;
      }
    }
    block.rows.splice(at.top, at.bottom - at.top + 1);
  });
  model.dirty = true;
  return cursorIn(at.block, Math.min(at.top, at.block.rows.length - 1), at.col);
}

export function insertColumn(model, selection, right = true) {
  const at = tableAt(model, selection);
  if (!at || at.cols >= TABLE_LIMITS.cols) return selection;
  const index = right ? at.right + 1 : at.left;
  reshape(at.block, (block) => {
    for (const row of block.rows) {
      for (const [c, cell] of row.cells.entries()) if (cell.colspan > 1 && c < index && c + cell.colspan > index) cell.colspan += 1;
      row.cells.splice(index, 0, empty());
    }
    block.widths.splice(index, 0, block.widths[Math.min(index, block.widths.length - 1)] ?? 1);
  });
  model.dirty = true;
  return cursorIn(at.block, at.row, index);
}

export function deleteColumns(model, selection) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  if (at.right - at.left + 1 >= at.cols) return deleteTable(model, selection);
  reshape(at.block, (block) => {
    for (const row of block.rows) {
      for (const [c, cell] of row.cells.entries()) {
        if (!(cell.colspan > 1) || c >= at.left) continue;
        cell.colspan -= Math.max(0, Math.min(c + cell.colspan - 1, at.right) - at.left + 1);
      }
      row.cells.splice(at.left, at.right - at.left + 1);
    }
    block.widths.splice(at.left, at.right - at.left + 1);
  });
  model.dirty = true;
  return cursorIn(at.block, at.row, Math.min(at.left, at.block.rows[0].cells.length - 1));
}

/** Merges the selected cells into the first, their text joined line by line. */
export function mergeCells(model, selection) {
  const at = tableAt(model, selection);
  if (!at || (at.top === at.bottom && at.left === at.right)) return selection;
  reshape(at.block, (block) => {
    const first = block.rows[at.top].cells[at.left];
    const texts = [];
    for (let r = at.top; r <= at.bottom; r += 1) {
      for (let c = at.left; c <= at.right; c += 1) {
        const cell = block.rows[r].cells[c];
        if (cell.runs.some((run) => run.text !== '')) texts.push(cell.runs);
        delete cell.rowspan;
        delete cell.colspan;
        if (r !== at.top || c !== at.left) cell.runs = [{ text: '' }];
      }
    }
    first.runs = normaliseRuns(texts.flatMap((runs, i) => (i ? [{ text: '\n' }, ...runs] : runs)));
    if (at.bottom > at.top) first.rowspan = at.bottom - at.top + 1;
    if (at.right > at.left) first.colspan = at.right - at.left + 1;
  });
  model.dirty = true;
  return cursorIn(at.block, at.top, at.left);
}

/** Splits a merged cell back into the cells it covered. */
export function splitCell(model, selection) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  const cell = at.block.rows[at.row].cells[at.col];
  if (!(cell.rowspan > 1) && !(cell.colspan > 1)) return selection;
  reshape(at.block, () => {
    delete cell.rowspan;
    delete cell.colspan;
  });
  model.dirty = true;
  return selection;
}

/** Sets a look on every selected cell: a background, an alignment. */
export function setCells(model, selection, patch) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  for (let r = at.top; r <= at.bottom; r += 1) {
    for (let c = at.left; c <= at.right; c += 1) {
      const cell = at.block.rows[r].cells[c];
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete cell[key]; else cell[key] = value;
      }
    }
  }
  model.dirty = true;
  return selection;
}

/** Whether the selected rows repeat at the top of every page the table runs onto. */
export function setHeaderRows(model, selection, on) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  // Only rows from the top can repeat, as in LibreOffice and Word.
  for (let r = 0; r < at.block.rows.length; r += 1) {
    if (on && r <= at.bottom) at.block.rows[r].header = true;
    else if (!on && r >= at.top) delete at.block.rows[r].header;
  }
  model.dirty = true;
  return selection;
}

export function setTable(model, selection, patch) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  Object.assign(at.block, patch);
  normaliseTable(at.block);
  model.dirty = true;
  return selection;
}

export function deleteTable(model, selection) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  const index = model.indexOf(at.block.id);
  model.removeBlock(at.block.id);
  if (model.blocks.length === 0) model.insertBlock({ kind: 'paragraph' }, 0);
  const next = model.blocks[Math.min(index, model.blocks.length - 1)];
  model.dirty = true;
  return collapsed(point(next.id, 0, next.kind === 'list' ? 0 : null));
}

// Whole tables: their columns' widths, their rows in order, split, joined, made from text and back.

const cellText = (cell) => (cell?.runs ?? []).map((run) => run.text).join('');

/** Column widths: all the same, or each as wide as its longest text, or as narrow as its shortest word allows. */
export function setColumnWidths(model, selection, how) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  const block = at.block;
  if (how === 'even') block.widths = Array(at.cols).fill(1);
  else {
    const lengths = Array.from({ length: at.cols }, (_, c) => block.rows.reduce((most, row) => {
      const text = cellText(row.cells[c]);
      const size = how === 'minimal' ? Math.max(0, ...text.split(/\s+/).map((w) => w.length)) : text.length;
      return Math.max(most, size);
    }, 0));
    block.widths = lengths.map((n) => Math.max(1, n));
  }
  normaliseTable(block);
  model.dirty = true;
  return selection;
}

/** One column's share of the width, as a number of parts against the others. */
export function setColumnWidth(model, selection, share) {
  const at = tableAt(model, selection);
  if (!at || !(share > 0)) return selection;
  for (let c = at.left; c <= at.right; c += 1) at.block.widths[c] = share;
  normaliseTable(at.block);
  model.dirty = true;
  return selection;
}

/** The rows below the heading rows put in order by one column, numbers as numbers. */
export function sortRows(model, selection, { column = null, descending = false } = {}) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  const block = at.block;
  if (block.rows.some((row) => row.cells.some((cell) => cell.colspan > 1 || cell.rowspan > 1))) return selection;
  const col = column ?? at.col;
  const head = block.rows.filter((row) => row.header);
  const body = block.rows.filter((row) => !row.header);
  const key = (row) => cellText(row.cells[col]).trim();
  body.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    const [nx, ny] = [Number(x.replace(',', '.')), Number(y.replace(',', '.'))];
    const order = x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
    return descending ? -order : order;
  });
  block.rows = [...head, ...body];
  model.dirty = true;
  return selection;
}

/** The table cut in two before the row the cursor is in; the heading rows go with both parts. */
export function splitTable(model, selection) {
  const at = tableAt(model, selection);
  if (!at || at.top === 0) return selection;
  const block = at.block;
  if (block.rows.some((row, r) => r < at.top && row.cells.some((cell) => r + (cell.rowspan ?? 1) > at.top))) return selection;
  const heading = block.rows.filter((row, r) => row.header && r < at.top).map((row) => structuredClone(row));
  const rest = block.rows.splice(at.top);
  const { id: _, ...shape } = structuredClone({ ...block, rows: [] });
  model.insertBlock({ kind: 'paragraph', runs: [{ text: '' }] }, model.indexOf(block.id) + 1);
  const second = model.insertBlock({ ...shape, rows: [...heading, ...rest] }, model.indexOf(block.id) + 2);
  normaliseTable(block);
  normaliseTable(second);
  model.dirty = true;
  return cursorIn(second, heading.length, 0);
}

/** The table joined with the next one when only an empty paragraph or nothing stands between them. */
export function mergeTables(model, selection) {
  const at = tableAt(model, selection);
  if (!at) return selection;
  const index = model.indexOf(at.block.id);
  let next = model.blocks[index + 1];
  const between = next && next.kind !== 'table' && cellText(next) === '' ? next : null;
  if (between) next = model.blocks[index + 2];
  if (next?.kind !== 'table' || next.rows[0].cells.length !== at.cols) return selection;
  at.block.rows.push(...next.rows.filter((row) => !row.header));
  if (between) model.removeBlock(between.id);
  model.removeBlock(next.id);
  normaliseTable(at.block);
  model.dirty = true;
  return selection;
}

/** Paragraphs made into a table, one row each, cells cut at a separator: a tab, a semicolon or another character. */
export function textToTable(model, blocks, separator = '\t') {
  const lines = blocks.filter((b) => b.kind === 'paragraph' || b.kind === 'heading').map((b) => cellText(b).split(separator));
  if (!lines.length) return null;
  const cols = Math.min(TABLE_LIMITS.cols, Math.max(...lines.map((l) => l.length)));
  const shape = {
    kind: 'table', style: 'body', align: 'left', borders: 'all',
    rows: lines.slice(0, TABLE_LIMITS.rows).map((line) => ({ cells: Array.from({ length: cols }, (_, c) => ({ runs: [{ text: line[c] ?? '' }] })) })),
    widths: Array(cols).fill(1),
  };
  // The table goes in first, so the document is never left with nothing in it.
  const table = model.insertBlock(normaliseTable(shape), model.indexOf(blocks[0].id));
  for (const b of blocks) model.removeBlock(b.id);
  model.dirty = true;
  return cursorIn(table, 0, 0);
}

/** A table made back into paragraphs, a row each, cells joined by a separator. */
export function tableToText(model, selection, separator = '\t') {
  const at = tableAt(model, selection);
  if (!at) return selection;
  const index = model.indexOf(at.block.id);
  const paragraphs = at.block.rows.map((row, i) => model.insertBlock({
    kind: 'paragraph', style: 'body', align: 'left',
    runs: [{ text: row.cells.filter((cell) => !cell.covered).map(cellText).join(separator) }],
  }, index + 1 + i));
  model.removeBlock(at.block.id);
  model.dirty = true;
  return collapsed(point(paragraphs[0].id, 0));
}
