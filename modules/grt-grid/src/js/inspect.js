/** The document inspector for Grid: what a workbook carries besides what shows, and a clean copy without it. */

import { redactedDocument } from './redact.js';

const hidden = (map) => Object.entries(map ?? {}).filter(([, v]) => v?.hidden).map(([k]) => Number(k));

export function gridFindings(controller) {
  const { model } = controller;
  let comments = 0;
  let links = 0;
  let covered = 0;
  let rows = 0;
  let cols = 0;
  for (const sheet of model.sheets) {
    for (const cell of sheet.cells.values()) {
      if (cell.n) comments += 1;
      if (cell.l && !cell.l.startsWith('#')) links += 1;
      if (cell.rd) covered += 1;
    }
    for (const [, row] of sheet.rows) if (row?.hidden) rows += 1;
    for (const [, col] of sheet.cols) if (col?.hidden) cols += 1;
  }
  const hiddenSheets = model.sheets.filter((s) => s.hidden);
  return [
    { id: 'comments', label: 'Comments', count: comments },
    { id: 'sheets', label: 'Hidden sheets', count: hiddenSheets.length, detail: hiddenSheets.map((s) => s.name).slice(0, 6).join(', ') },
    { id: 'rows', label: 'Hidden rows', count: rows, detail: 'Their cells are emptied in the copy, and shown' },
    { id: 'cols', label: 'Hidden columns', count: cols, detail: 'Their cells are emptied in the copy, and shown' },
    { id: 'links', label: 'Links to web addresses', count: links, keep: true },
    { id: 'redact', label: 'Cells marked to be covered', count: covered, detail: 'Covered, with every cell drawn from them; formulas become values' },
  ];
}

/** The workbook as other formats take it, without what was chosen. */
export function cleanGridCopy(controller, out) {
  const json = out.includes('redact') ? redactedDocument(controller).document : controller.model.exportJSON();
  if (out.includes('sheets')) {
    const kept = json.sheets.filter((s) => !s.hidden);
    const gone = new Set(json.sheets.filter((s) => s.hidden).map((s) => s.id));
    json.sheets = kept.length ? kept : json.sheets.slice(0, 1).map((s) => ({ ...s, hidden: false }));
    json.charts = (json.charts ?? []).filter((c) => !gone.has(c.sheet));
  }
  for (const sheet of json.sheets) {
    const rows = new Set(out.includes('rows') ? hidden(sheet.rows) : []);
    const cols = new Set(out.includes('cols') ? hidden(sheet.cols) : []);
    const cells = {};
    for (const [at, cell] of Object.entries(sheet.cells ?? {})) {
      const [row, col] = at.split(',').map(Number);
      if (rows.has(row) || cols.has(col)) continue;
      const next = { ...cell };
      if (out.includes('comments')) {
        delete next.n;
        delete next.ns;
      }
      if (out.includes('links') && next.l && !next.l.startsWith('#')) delete next.l;
      cells[at] = next;
    }
    sheet.cells = cells;
    for (const r of rows) delete sheet.rows[r].hidden;
    for (const c of cols) delete sheet.cols[c].hidden;
  }
  return json;
}
