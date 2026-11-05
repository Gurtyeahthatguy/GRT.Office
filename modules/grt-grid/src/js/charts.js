/** Grid's charts: series read from ranges of the sheets, drawn by the core's SVG engine. */

import { parse } from './parser/parser.js';
import { evaluate } from './engine/evaluate.js';
import { isMatrix, isError, isBlank } from './engine/values.js';
import { columnName } from './references.js';
import { formatValue } from './format.js';

/** A range written with its sheet, the way chart series keep it: `Sheet1!$B$2:$B$9`. */
export function rangeText(sheetName, area) {
  const sheet = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
  const corner = (row, col) => `$${columnName(col)}$${row + 1}`;
  const single = area.top === area.bottom && area.left === area.right;
  return `${sheet}!${corner(area.top, area.left)}${single ? '' : `:${corner(area.bottom, area.right)}`}`;
}

/** The values of a range a chart refers to, in reading order. */
function valuesOf(ref, engine, sheetId) {
  if (!ref) return [];
  const { ast, error } = parse(`=${ref}`);
  if (error || !ast) return [];
  const result = evaluate(ast, engine.contextFor(sheetId, 0, 0));
  return isMatrix(result) ? result.flat : [result];
}

/** What the chart engine draws for one of Grid's charts, from the current values of its ranges. */
export function chartSpec(chart, engine, model) {
  const sheetId = chart.sheet ?? model.sheets[0]?.id;
  let categories = null;
  const series = (chart.series ?? []).map((s, i) => {
    const values = valuesOf(s.values, engine, sheetId).map((v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : null));
    if (!categories && s.categories) {
      categories = valuesOf(s.categories, engine, sheetId).map((v) => (isBlank(v) || isError(v) ? '' : typeof v === 'number' ? formatValue(v) : String(v)));
    }
    const name = s.nameRef ? valuesOf(s.nameRef, engine, sheetId)[0] : s.name;
    return {
      name: isBlank(name) || isError(name) ? `Series ${i + 1}` : String(name),
      values,
      x: s.x ? valuesOf(s.x, engine, sheetId).map((v) => (typeof v === 'number' ? v : null)) : null,
      type: s.type,
      color: s.color,
    };
  });
  return {
    type: chart.type, stacked: chart.stacked ?? false, title: chart.title ?? '', xTitle: chart.xTitle ?? '', yTitle: chart.yTitle ?? '',
    legend: chart.legend ?? 'right', categories: categories ?? undefined, series,
  };
}

/**
 * A chart over a block of data: names from the first row and labels from the first column when they are text.
 * @param {'columns'|'rows'} by whether each series is a column or a row of the block
 */
export function chartFromArea(sheet, area, { type = 'column', by = 'columns', headerRow = null, headerCol = null } = {}) {
  const text = (r, c) => typeof sheet.valueAt(r, c) === 'string';
  const firstRowNames = headerRow ?? (area.bottom > area.top && rowIsText(sheet, area.top, area.left + 1, area.right, text));
  const firstColLabels = headerCol ?? (area.right > area.left && colIsText(sheet, area.left, area.top + (firstRowNames ? 1 : 0), area.bottom, text));
  const top = area.top + (firstRowNames ? 1 : 0);
  const left = area.left + (firstColLabels ? 1 : 0);
  const series = [];
  if (by === 'columns') {
    const categories = firstColLabels ? rangeText(sheet.name, { top, bottom: area.bottom, left: area.left, right: area.left }) : null;
    for (let c = left; c <= area.right; c += 1) {
      series.push({
        ...(firstRowNames ? { nameRef: rangeText(sheet.name, { top: area.top, bottom: area.top, left: c, right: c }) } : {}),
        values: rangeText(sheet.name, { top, bottom: area.bottom, left: c, right: c }),
        ...(categories ? { categories } : {}),
      });
    }
  } else {
    const categories = firstRowNames ? rangeText(sheet.name, { top: area.top, bottom: area.top, left, right: area.right }) : null;
    for (let r = top; r <= area.bottom; r += 1) {
      series.push({
        ...(firstColLabels ? { nameRef: rangeText(sheet.name, { top: r, bottom: r, left: area.left, right: area.left }) } : {}),
        values: rangeText(sheet.name, { top: r, bottom: r, left, right: area.right }),
        ...(categories ? { categories } : {}),
      });
    }
  }
  // A scatter chart takes its x values from the first series.
  if (type === 'scatter' && series.length > 1) {
    const [first, ...rest] = series;
    for (const s of rest) s.x = first.values;
    series.splice(0, 1);
  }
  return { type, series, legend: series.length > 1 || type === 'pie' || type === 'doughnut' ? 'right' : 'none' };
}

function rowIsText(sheet, row, from, to, text) {
  for (let c = from; c <= to; c += 1) if (!text(row, c) && !isBlank(sheet.valueAt(row, c))) return false;
  return true;
}

function colIsText(sheet, col, from, to, text) {
  let any = false;
  for (let r = from; r <= to; r += 1) {
    if (text(r, col)) any = true;
    else if (!isBlank(sheet.valueAt(r, col))) return false;
  }
  return any;
}
