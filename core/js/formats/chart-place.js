/** Where a chart sits on a sheet: a cell and an offset, or a point in pixels from the sheet's corner. */

export const DEFAULT_COLUMN_PX = 96;
export const DEFAULT_ROW_PX = 24;

const sizeOf = (entry, field) => (typeof entry === 'number' ? entry : entry?.hidden ? 0 : entry?.[field] ?? null);

function lineSize(sheet, axis, index) {
  const entry = axis === 'cols' ? sheet.cols?.[index] : sheet.rows?.[index];
  const size = sizeOf(entry, axis === 'cols' ? 'w' : 'h');
  return size ?? (axis === 'cols' ? DEFAULT_COLUMN_PX : DEFAULT_ROW_PX);
}

/** The pixel position of an anchor on a sheet as Grid writes it in JSON. */
export function pointOf(sheet, anchor) {
  let x = 0;
  let y = 0;
  for (let c = 0; c < (anchor?.col ?? 0); c += 1) x += lineSize(sheet, 'cols', c);
  for (let r = 0; r < (anchor?.row ?? 0); r += 1) y += lineSize(sheet, 'rows', r);
  return { x: x + (anchor?.dx ?? 0), y: y + (anchor?.dy ?? 0) };
}

/** The anchor of a pixel position on a sheet, stopping at a sane distance from the corner. */
export function anchorOf(sheet, x, y) {
  let col = 0;
  let row = 0;
  let left = Math.max(0, x);
  let top = Math.max(0, y);
  while (col < 16383 && left >= lineSize(sheet, 'cols', col) && lineSize(sheet, 'cols', col) > 0) { left -= lineSize(sheet, 'cols', col); col += 1; }
  while (row < 1048575 && top >= lineSize(sheet, 'rows', row) && lineSize(sheet, 'rows', row) > 0) { top -= lineSize(sheet, 'rows', row); row += 1; }
  return { row, col, dx: Math.round(left), dy: Math.round(top) };
}

/** Grid's chart kinds and what a chart may hold, so one read from a file is always drawable. */
export const KINDS = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'combo'];
export const MAX_CHARTS = 200;
export const MAX_SERIES = 64;
