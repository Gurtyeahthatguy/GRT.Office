/** Redaction in a spreadsheet: cells marked to be covered, and a copy to share in which they, and all drawn from them, are gone. */

import { findSensitive, REDACTED } from './core/sensitive.js';
import { nodeId, parseNodeId } from './engine/graph.js';
import { cellsInRange, parseRange, parseRef } from './references.js';

/** The cells of every sheet whose shown value the finder flags; marks them and says how many. */
export function autoRedactCells(controller, kinds, extra = []) {
  let count = 0;
  for (const sheet of controller.model.sheets) {
    for (const [at, cell] of sheet.cells) {
      const [row, col] = at.split(',').map(Number);
      const value = sheet.valueAt(row, col);
      if (value === null || value === undefined || cell.rd) continue;
      if (findSensitive(String(value), kinds, extra).length === 0) continue;
      sheet.set(row, col, { rd: 1 });
      count += 1;
    }
  }
  if (count) controller.model.dirty = true;
  return count;
}

/** Whether an area of a sheet holds a covered cell. */
function touches(sheet, area, covered) {
  for (const id of covered) {
    const at = parseNodeId(id);
    if (at.sheetId === sheet.id && at.row >= area.top && at.row <= area.bottom && at.col >= area.left && at.col <= area.right) return true;
  }
  return false;
}

/**
 * The copy to share, as other formats take it: every formula its value, covered cells and every cell
 * drawn from them replaced by the same black blocks, pivot results over covered data too; no comments,
 * links, rules on what cells accept, or charts, which could carry what is covered.
 * @returns {{document: Object, covered: number}}
 */
export function redactedDocument(controller) {
  const { model, engine } = controller;
  const marked = [];
  for (const sheet of model.sheets) for (const [at, cell] of sheet.cells) if (cell.rd) {
    const [row, col] = at.split(',').map(Number);
    marked.push(nodeId(sheet.id, row, col));
  }
  // What a covered cell feeds, through formulas, is covered as well.
  const covered = new Set(engine.graph.affectedBy(marked));
  const json = model.exportJSON();
  json.sheets.forEach((out, index) => {
    const sheet = model.sheets[index];
    for (const pivot of sheet.pivots ?? []) {
      const source = sourceArea(model, pivot.source);
      if (pivot.area && source && touches(source.sheet, source.area, covered)) {
        for (const { row, col } of cellsInRange({ from: { row: pivot.area.top, col: pivot.area.left }, to: { row: pivot.area.bottom, col: pivot.area.right } })) covered.add(nodeId(sheet.id, row, col));
      }
    }
    const cells = {};
    for (const [at, cell] of Object.entries(out.cells)) {
      const [row, col] = at.split(',').map(Number);
      const { f: _f, a: _a, i: _i, n: _n, ns: _ns, l: _l, rd: _rd, ...rest } = cell;
      const value = covered.has(nodeId(sheet.id, row, col)) ? REDACTED : sheet.valueAt(row, col) ?? cell.v;
      if (value === null || value === undefined) {
        if (rest.s) cells[at] = { s: rest.s };
        continue;
      }
      cells[at] = { ...rest, v: value };
    }
    out.cells = cells;
    out.pivots = [];
    out.validations = [];
    delete out.filteredRows;
  });
  json.charts = [];
  json.names = {};
  return { document: json, covered: covered.size };
}

function sourceArea(model, source) {
  const text = String(source ?? '');
  const bang = text.lastIndexOf('!');
  const name = bang >= 0 ? text.slice(0, bang).replace(/^'|'$/g, '') : null;
  const sheet = name ? model.sheets.find((s) => s.name === name) : model.sheets[0];
  const range = parseRange(bang >= 0 ? text.slice(bang + 1) : text) ?? (parseRef(text) ? { from: parseRef(text), to: parseRef(text) } : null);
  if (!sheet || !range) return null;
  return { sheet, area: { top: Math.min(range.from.row, range.to.row), bottom: Math.max(range.from.row, range.to.row), left: Math.min(range.from.col, range.to.col), right: Math.max(range.from.col, range.to.col) } };
}
