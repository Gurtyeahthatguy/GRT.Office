/** OpenDocument spreadsheets to and from Grid's document. */

import { NS, kids, kid, attr, is, tag, xmlDocument, parseXml } from '../xml.js';
import { parseLength, formatLength, toMm } from '../units.js';
import { Losses } from '../losses.js';
import {
  odfDocuments, OdfStyles, textLook, MIMETYPES, ODF_VERSION, ROOT_NAMESPACES, odfPackage, odfText,
} from './odf.js';
import { fromOpenFormula, toOpenFormula, parseCell } from './formulas.js';
import {
  SHEET_PRINT_DEFAULTS, sheetPrint, paperOf, paperFields, parseSheetRange, splitOutsideQuotes, odfArea, odfBandParts, odfBandText,
} from './sheet-print.js';
import { declareExternal } from './external.js';
import { clearSpilled } from './spills.js';
import { readOdsConditions, writeOdsConditions, readOdsValidations, writeOdsValidations } from './ods-rules.js';
import { readOdsPivots, writeOdsPivots } from './ods-pivots.js';
import { readOdsCharts, writeOdsCharts, hasOtherFrames } from './ods-charts.js';
import { cleanLook, withoutDefaults, sameLook, borderFromOdf, borderToOdf, SIDES } from './cell-look.js';

const PX_PER_MM = 96 / 25.4;
const DEFAULT_WIDTH = 96;
const DEFAULT_HEIGHT = 24;
const DAY = 86400000;

/** Rows and columns a file may say are repeated, past which only blanks follow. */
const ROW_LIMIT = 1048576;
const COLUMN_LIMIT = 16384;

// Reading

/**
 * @param {import('../package.js').Package|string} source a package, or a flat file's text
 * @returns {{document: object, losses: Losses}}
 */
export function readOds(source) {
  const docs = odfDocuments(source);
  if (docs.mimetype && !docs.mimetype.startsWith(MIMETYPES.spreadsheet)) {
    throw new Error('This OpenDocument file is not a spreadsheet');
  }
  const body = kid(kid(docs.content.documentElement, NS.office, 'body'), NS.office, 'spreadsheet');
  if (!body) throw new Error('This document has no spreadsheet in it');

  const styles = new OdfStyles([docs.styles, docs.content].filter(Boolean), docs.content);
  const losses = new Losses();
  if (typeof source !== 'string' && source.damage) losses.add('The file was damaged, and only what could still be read was opened');
  declareExternal(source, losses);

  const masterStyles = new OdfStyles([docs.styles, docs.content].filter(Boolean), docs.styles ?? docs.content);
  const reader = {
    styles, masterStyles, losses, patterns: new Map(), gridStyles: new Map(), styleNames: new Map(),
    validationRules: readOdsValidations(body),
  };


  const frozen = readFrozen(typeof source === 'string' ? docs.content : source);
  const tables = kids(body, NS.table, 'table');
  const sheets = tables.map((table) => readTable(table, reader, frozen));
  if (sheets.length === 0) throw new Error('This spreadsheet has no sheets');
  const charts = readOdsCharts(tables, sheets, typeof source === 'string' ? null : source, losses);
  readOdsPivots(body, sheets, losses);
  readFilters(body, sheets, losses);
  const names = readNames(body, losses);

  const gridStyles = {};
  for (const [name, style] of reader.gridStyles) gridStyles[name] = style;
  return {
    document: { version: 1, type: 'grid', sheets, styles: gridStyles, charts, ...(Object.keys(names).length ? { names } : {}) },
    losses,
  };
}

function readTable(table, reader, frozen) {
  const { styles, losses } = reader;
  const name = attr(table, NS.table, 'name') ?? 'Sheet';
  const tableStyle = styles.resolve('table', attr(table, NS.table, 'style-name'), 'table');
  const tab = /^#[0-9a-f]{6}$/i.test(tableStyle['tab-color'] ?? '') ? tableStyle['tab-color'].toLowerCase() : null;
  if (hasOtherFrames(table)) losses.add('Pictures and drawings in sheets');

  const cells = {};
  const cols = {};
  const rows = {};
  const columnDefaults = [];
  const merges = [];
  const spans = [];
  const rowBreaks = [];
  const colBreaks = [];
  let headerRows = null;

  let col = 0;
  for (const column of flatten(table, 'table-column', ['table-columns', 'table-column-group', 'table-header-columns'])) {
    const repeat = Math.min(Number(attr(column, NS.table, 'number-columns-repeated') ?? 1), COLUMN_LIMIT - col);
    const props = styles.resolve('table-column', attr(column, NS.table, 'style-name'), 'column');
    const width = parseLength(props['column-width']);
    const hidden = attr(column, NS.table, 'visibility') === 'collapse';
    const defaultStyle = attr(column, NS.table, 'default-cell-style-name');
    if (props['break-before'] === 'page' && col > 0) colBreaks.push(col);
    for (let i = 0; i < repeat && col < COLUMN_LIMIT; i += 1, col += 1) {
      columnDefaults[col] = defaultStyle;
      if (width !== null && i < 1024) {
        const px = Math.round(width * PX_PER_MM);
        if (Math.abs(px - DEFAULT_WIDTH) > 1) cols[col] = { w: px };
      }
      if (hidden && i < 1024) cols[col] = { ...(cols[col] ?? {}), hidden: true };
    }
  }

  let row = 0;
  for (const rowElement of flatten(table, 'table-row', ['table-rows', 'table-row-group', 'table-header-rows'])) {
    if (row >= ROW_LIMIT) break;
    const repeat = Number(attr(rowElement, NS.table, 'number-rows-repeated') ?? 1);
    const props = styles.resolve('table-row', attr(rowElement, NS.table, 'style-name'), 'row');
    // Rows the filter hid come back when the filter runs again; only rows hidden by hand are kept.
    const hiddenRow = attr(rowElement, NS.table, 'visibility') === 'collapse';
    const height = props['use-optimal-row-height'] === 'true' ? null : parseLength(props['row-height']);
    const rowDefault = attr(rowElement, NS.table, 'default-cell-style-name');
    if (props['break-before'] === 'page' && row > 0) rowBreaks.push(row);
    if (inHeaderRows(rowElement, table)) {
      headerRows = { top: headerRows?.top ?? row, bottom: row + Math.min(repeat, 1000) - 1 };
    }

    const values = readRow(rowElement, reader, columnDefaults, rowDefault, row, merges, spans, Math.min(repeat, ROW_LIMIT - row));
    // A row repeated a million times is formatting reaching the bottom of the sheet.
    if (values.size > 0 && repeat > 1000) losses.add('A row repeated more than a thousand times, kept a thousand times');
    const times = values.size > 0 ? Math.min(repeat, 1000) : Math.min(repeat, ROW_LIMIT - row);
    for (let r = 0; r < times; r += 1) {
      for (const [c, cell] of values) cells[`${row + r},${c}`] = { ...cell };
      if (height !== null && values.size > 0) {
        const px = Math.round(height * PX_PER_MM);
        if (Math.abs(px - DEFAULT_HEIGHT) > 1) rows[row + r] = { h: px };
      }
    }
    if (hiddenRow) for (let r = 0; r < Math.min(repeat, 1000); r += 1) rows[row + r] = { ...(rows[row + r] ?? {}), hidden: true };
    row += repeat;
  }

  clearSpilled(cells);
  const validations = validationsFrom(spans, reader.validationRules);
  const lookOf = (styleName) => {
    const encoded = styleName.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
    const name = styles.style('table-cell', encoded) && !styles.style('table-cell', styleName) ? encoded : styleName;
    reader.baseLook ??= lookOfChain('Default', reader);
    return withoutDefaults(lookOfChain(name, reader), reader.baseLook);
  };
  const conditions = readOdsConditions(table, lookOf, readAddress, losses);
  const sheetFrozen = frozen.get(name) ?? null;
  const print = readPrint(table, reader);
  Object.assign(print, { rowBreaks, colBreaks, repeatRows: headerRows });
  return {
    name, cells, cols, rows, frozen: sheetFrozen, print, ...(merges.length ? { merges } : {}),
    ...(tableStyle.display === 'false' ? { hidden: true } : {}), ...(tab ? { tab } : {}),
    ...(validations.length ? { validations } : {}), ...(conditions.length ? { conditions } : {}),
  };
}

/** The blocks of cells that share a validation, built from the runs read row by row. */
function validationsFrom(spans, rules) {
  const byName = new Map();
  for (const span of spans) {
    if (!rules.has(span.name)) continue;
    const list = byName.get(span.name) ?? [];
    const last = list.find((a) => a.left === span.left && a.right === span.right && a.bottom + 1 === span.top);
    if (last) last.bottom = span.bottom;
    else list.push({ top: span.top, left: span.left, bottom: span.bottom, right: span.right });
    byName.set(span.name, list);
  }
  const out = [];
  for (const [name, areas] of byName) for (const area of areas) out.push({ ...structuredClone(rules.get(name)), area });
  return out;
}

/** `Sheet1.A1:Sheet1.D9` or `'My sheet'.A1:.D9` to a sheet name and a block. */
function readAddress(text) {
  const match = /^\$?('(?:[^']|'')+'|[^.]+)\.\$?([A-Z]+)\$?(\d+)(?::(?:\$?('(?:[^']|'')+'|[^.]+))?\.\$?([A-Z]+)\$?(\d+))?$/.exec(String(text).trim());
  if (!match) return null;
  const sheet = match[1].replace(/^'|'$/g, '').replace(/''/g, "'");
  const from = parseCell(`${match[2]}${match[3]}`);
  const to = match[5] ? parseCell(`${match[5]}${match[6]}`) : from;
  if (!from || !to) return null;
  return { sheet, area: { top: Math.min(from.row, to.row), left: Math.min(from.col, to.col), bottom: Math.max(from.row, to.row), right: Math.max(from.col, to.col) } };
}

const FILTER_OPS = { '=': '=', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=', contains: 'contains', '!contains': 'not-contains', begins: 'begins', ends: 'ends', empty: 'empty', '!empty': 'not-empty' };

/** The autofilters: each anonymous database range with filter buttons, its conditions by column. */
function readFilters(body, sheets, losses) {
  for (const range of body.getElementsByTagNameNS(NS.table, 'database-range')) {
    if (attr(range, NS.table, 'display-filter-buttons') !== 'true') continue;
    const target = readAddress(attr(range, NS.table, 'target-range-address') ?? '');
    const sheet = target && sheets.find((each) => each.name === target.sheet);
    if (!sheet) continue;
    const columns = {};
    const or = range.getElementsByTagNameNS(NS.table, 'filter-or').length > 0;
    for (const condition of range.getElementsByTagNameNS(NS.table, 'filter-condition')) {
      const offset = attr(condition, NS.table, 'field-number') ?? '0';
      const op = attr(condition, NS.table, 'operator') ?? '=';
      const value = attr(condition, NS.table, 'value') ?? '';
      const items = kids(condition, NS.table, 'filter-set-item').map((item) => attr(item, NS.table, 'value') ?? '');
      const rule = columns[offset] ?? {};
      const top = /^(top|bottom) (values|percent)$/.exec(op);
      if (items.length > 0 || op === '=') rule.values = [...(rule.values ?? []), ...(items.length ? items : [value])];
      else if (top) rule.top = { count: Number(value), percent: top[2] === 'percent', largest: top[1] === 'top' };
      else if (FILTER_OPS[op]) {
        rule.conditions = [...(rule.conditions ?? []), { op: FILTER_OPS[op], value }];
        if (or) rule.join = 'or';
      } else losses.add('A filter condition GRT Grid does not know, left out');
      columns[offset] = rule;
    }
    sheet.filter = { area: target.area, columns };
  }
}

/** Named ranges and expressions, as formulas Grid reads. */
function readNames(body, losses) {
  const names = {};
  const holder = kid(body, NS.table, 'named-expressions');
  for (const node of kids(holder)) {
    const name = attr(node, NS.table, 'name');
    if (!name) continue;
    if (node.localName === 'named-range') {
      const address = attr(node, NS.table, 'cell-range-address') ?? '';
      names[name.toUpperCase()] = fromOpenFormula(`of:=[${address}]`).formula ?? '';
    } else if (node.localName === 'named-expression') {
      names[name.toUpperCase()] = fromOpenFormula(attr(node, NS.table, 'expression') ?? '').formula ?? '';
    }
    if (!names[name.toUpperCase()]) {
      delete names[name.toUpperCase()];
      losses.add('A named range GRT Grid could not read');
    }
  }
  return names;
}

function inHeaderRows(rowElement, table) {
  for (let node = rowElement.parentNode; node && node !== table; node = node.parentNode) {
    if (is(node, NS.table, 'table-header-rows')) return true;
  }
  return false;
}

/** The sheet's page: paper, margins, scaling, gridlines, headers and the print range. */
function readPrint(table, reader) {
  const { styles, masterStyles, losses } = reader;
  const print = { ...SHEET_PRINT_DEFAULTS };

  const ranges = splitOutsideQuotes(attr(table, NS.table, 'print-ranges') ?? '', ' ')
    .map(parseSheetRange).filter((range) => range?.kind === 'cells');
  if (ranges.length > 0) {
    const [area] = ranges;
    print.area = { top: area.top, left: area.left, bottom: area.bottom, right: area.right };
    if (ranges.length > 1) losses.add('Several print areas, the first kept');
  }

  const masterName = styles.chain('table', attr(table, NS.table, 'style-name'))
    .map((style) => style.masterPage).find(Boolean);
  const master = masterName
    ? masterStyles.masters.find((m) => attr(m, NS.style, 'name') === masterName) ?? null
    : null;
  if (!master) return print;
  const layout = masterStyles.layouts.get(attr(master, NS.style, 'page-layout-name'));
  const props = {};
  for (const attribute of kid(layout, NS.style, 'page-layout-properties')?.attributes ?? []) {
    props[attribute.localName] = attribute.value;
  }

  const width = parseLength(props['page-width']);
  const height = parseLength(props['page-height']);
  if (width && height) Object.assign(print, paperFields(width, height));
  if (props['print-orientation'] === 'landscape' || (width && height && width > height)) print.orientation = 'landscape';
  const left = parseLength(props['margin-left']);
  if (left !== null) print.margin = Math.round(left * 10) / 10;
  print.gridlines = String(props.print ?? '').split(/\s+/).includes('grid');

  if (props['scale-to-X'] !== undefined || props['scale-to-Y'] !== undefined) {
    print.fitWidth = props['scale-to-X'] === '1';
    if (props['scale-to-X'] !== '1' || Number(props['scale-to-Y'] ?? 0) > 0) {
      losses.add('Fitting to a number of pages, printed fitted to the page width');
    }
  } else if (props['scale-to-pages'] !== undefined) {
    print.fitWidth = true;
    losses.add('Fitting to a number of pages, printed fitted to the page width');
  } else if (props['scale-to'] !== undefined && parseFloat(props['scale-to']) !== 100) {
    losses.add('A print scale, printed at full size');
  }

  const shown = (name) => {
    const band = kid(master, NS.style, name);
    return !!band && attr(band, NS.style, 'display') !== 'false' && band.textContent.trim() !== '';
  };
  print.labels = shown('header') || shown('footer');
  if (print.labels) {
    print.header = shown('header') ? odfBandText(kid(master, NS.style, 'header')) : '';
    print.footer = shown('footer') ? odfBandText(kid(master, NS.style, 'footer')) : '';
  }
  return print;
}

/** Elements of a kind, looking through the groups ODF wraps them in. */
function flatten(parent, local, wrappers) {
  const out = [];
  for (const child of kids(parent)) {
    if (child.namespaceURI !== NS.table) continue;
    if (child.localName === local) out.push(child);
    else if (wrappers.includes(child.localName)) out.push(...flatten(child, local, wrappers));
  }
  return out;
}

function readRow(rowElement, reader, columnDefaults, rowDefault, row = 0, merges = [], spans = [], rowsRepeated = 1) {
  const values = new Map();
  let col = 0;
  for (const cell of kids(rowElement)) {
    if (cell.namespaceURI !== NS.table || !['table-cell', 'covered-table-cell'].includes(cell.localName)) continue;
    const repeat = Number(attr(cell, NS.table, 'number-columns-repeated') ?? 1);
    const validation = attr(cell, NS.table, 'content-validation-name');
    if (validation) {
      const right = Math.min(col + repeat, COLUMN_LIMIT) - 1;
      const previous = spans[spans.length - 1];
      if (previous && previous.name === validation && previous.top === row && previous.right + 1 === col) previous.right = right;
      else spans.push({ name: validation, top: row, bottom: row + rowsRepeated - 1, left: col, right });
    }
    if (cell.localName === 'covered-table-cell') {
      col += repeat;
      continue;
    }
    const spanCols = Number(attr(cell, NS.table, 'number-columns-spanned') ?? 1);
    const spanRows = Number(attr(cell, NS.table, 'number-rows-spanned') ?? 1);
    if (spanCols > 1 || spanRows > 1) merges.push({ top: row, left: col, bottom: row + spanRows - 1, right: col + spanCols - 1 });
    let read = readCell(cell, reader, attr(cell, NS.table, 'style-name') ?? columnDefaults[col] ?? rowDefault);
    const note = readNote(kid(cell, NS.office, 'annotation'), reader);
    if (note) read = { ...(read ?? {}), ...note };
    const matrixRows = Number(attr(cell, NS.table, 'number-matrix-rows-spanned') ?? 1);
    const matrixCols = Number(attr(cell, NS.table, 'number-matrix-columns-spanned') ?? 1);
    if (read?.f && (matrixRows > 1 || matrixCols > 1)) read = { ...read, a: [matrixRows, matrixCols] };
    // LibreOffice gives a formula that is not an array formula the value on its own row, so it never spills.
    else if (read?.f && !attr(cell, NS.table, 'number-matrix-rows-spanned')) read = { ...read, i: 1 };
    if (read && repeat > 1024) reader.losses.add('A cell repeated across more than a thousand columns, kept a thousand times');
    if (read) {
      const times = Math.min(repeat, COLUMN_LIMIT - col);
      for (let i = 0; i < times && i < 1024; i += 1) values.set(col + i, read);
    }
    col += repeat;
    if (col >= COLUMN_LIMIT) break;
  }
  return values;
}

function readCell(cell, reader, styleName) {
  const type = attr(cell, NS.office, 'value-type') ?? attr(cell, NS.loext, 'value-type') ?? null;
  const formula = attr(cell, NS.table, 'formula');
  const text = kids(cell, NS.text, 'p').map(paragraphText).join('\n');
  let value = null;
  switch (type) {
    case 'float': case 'percentage': case 'currency':
      value = Number(attr(cell, NS.office, 'value'));
      break;
    case 'date': {
      // A date is written out in full, whatever day the document counts from.
      const iso = attr(cell, NS.office, 'date-value');
      value = iso ? dateSerial(iso) : null;
      break;
    }
    case 'time':
      value = duration(attr(cell, NS.office, 'time-value'));
      break;
    case 'boolean':
      value = attr(cell, NS.office, 'boolean-value') === 'true';
      break;
    case 'string':
      value = attr(cell, NS.office, 'string-value') ?? text;
      break;
    default:
      value = text === '' ? null : text;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) value = null;
  if (attr(cell, NS.calcext, 'value-type') === 'error') value = errorName(text);

  const out = {};
  if (value !== null && value !== '') out.v = value;
  if (formula) {
    const { formula: translated, problems } = fromOpenFormula(formula);
    for (const problem of problems) reader.losses.add(problem);
    out.f = translated;
    if (out.v === undefined && /^#[A-Z/0!?]+/.test(text)) out.v = text;
  }
  const style = gridStyle(styleName, reader);
  if (style) out.s = style;
  // The cell's link: the first one in its text, as Calc keeps one per cell.
  const link = kids(cell, NS.text, 'p').flatMap((p) => [...p.getElementsByTagNameNS(NS.text, 'a')])[0];
  const href = link ? link.getAttributeNS(NS.xlink, 'href') : null;
  if (href && out.v !== undefined) out.l = href.slice(0, 2048);
  return out.v === undefined && out.f === undefined ? null : out;
}

/** A link inside the document written as ODF writes it, Sheet2.A1, whichever way it was read. */
const odfLink = (href) => href.replace(/^#(.+)!(\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?)$/, '#$1.$2');

/** A cell's comment as text, and whether it is always shown; who wrote it and when are not kept. */
function readNote(annotation, reader) {
  if (!annotation) return null;
  if (kids(annotation).some((k) => k.localName === 'creator' || k.localName === 'date')) reader.losses.add('Names and dates on comments, left out');
  const text = kids(annotation, NS.text, 'p').map(paragraphText).join('\n').slice(0, NOTE_LIMIT);
  if (text.trim() === '') return null;
  return attr(annotation, NS.office, 'display') === 'true' ? { n: text, ns: 1 } : { n: text };
}

const NOTE_LIMIT = 100_000;

/** Error names as LibreOffice shows them in other languages, and its own codes. */
const ERROR_NAMES = {
  '#WERT!': '#VALUE!', '#NV': '#N/A', '#BEZUG!': '#REF!', '#ZAHL!': '#NUM!', '#NULL!': '#NULL!',
  '#VALEUR!': '#VALUE!', '#NOM?': '#NAME?', '#NOMBRE!': '#NUM!', '#NUL!': '#NULL!',
  '#VALORE!': '#VALUE!', '#N/D': '#N/A', '#RIF!': '#REF!', '#NOME?': '#NAME?', '#NULLO!': '#NULL!',
  '#¡VALOR!': '#VALUE!', '#¡REF!': '#REF!', '#¿NOMBRE?': '#NAME?', '#¡NUM!': '#NUM!', '#¡NULO!': '#NULL!', '#¡DIV/0!': '#DIV/0!',
  '#VALOR!': '#VALUE!', '#WAARDE!': '#VALUE!', '#VERW!': '#REF!', '#GETAL!': '#NUM!',
  'Err:502': '#NUM!', 'Err:503': '#NUM!', 'Err:504': '#VALUE!', 'Err:519': '#VALUE!',
  'Err:522': '#VALUE!', 'Err:523': '#NUM!', 'Err:524': '#REF!', 'Err:525': '#NAME?', 'Err:532': '#DIV/0!',
};

function errorName(text) {
  const trimmed = String(text).trim();
  if (ERROR_NAMES[trimmed]) return ERROR_NAMES[trimmed];
  if (/^Err:\d+$/.test(trimmed)) return '#VALUE!';
  return trimmed;
}

function paragraphText(p) {
  let out = '';
  for (let node = p.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3) out += node.nodeValue;
    else if (is(node, NS.text, 's')) out += ' '.repeat(Number(attr(node, NS.text, 'c') ?? 1));
    else if (is(node, NS.text, 'tab')) out += '\t';
    else if (is(node, NS.text, 'line-break')) out += '\n';
    else if (node.nodeType === 1) out += paragraphText(node);
  }
  return out;
}

/** Days from 1899-12-30 to an ISO date or date-time. */
function dateSerial(iso) {
  const match = /^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?/.exec(iso);
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = match;
  const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) + Number(`0.${frac}`) * 1000;
  return (at - Date.UTC(1899, 11, 30)) / DAY;
}

/** An ISO duration such as PT12H30M15S as a fraction of a day. */
function duration(text) {
  const match = /^-?P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(text ?? '');
  if (!match) return null;
  const [, d = 0, h = 0, m = 0, s = 0] = match;
  const value = Number(d) + (Number(h) * 3600 + Number(m) * 60 + Number(s)) / 86400;
  return text.startsWith('-') ? -value : value;
}

/** The display names of LibreOffice's styles that Grid has under names of its own. */
const KNOWN_STYLES = { Heading: 'header', Currency: 'currency', Percent: 'percent', Date: 'date' };

/** How a chain of ODF cell styles looks, as one of Grid's looks. */
function lookOfChain(name, reader) {
  const { styles } = reader;
  const text = textLook(styles.resolve('table-cell', name, 'text'), styles);
  const cell = styles.resolve('table-cell', name, 'cell');
  const paragraph = styles.resolve('table-cell', name, 'paragraph');
  const dataStyle = name ? styles.chain('table-cell', name).find((s) => s.dataStyle)?.dataStyle ?? null : null;
  const look = {
    bold: text.bold, italic: text.italic, underline: text.underline && !text.double, strike: text.strike,
    double: text.double, overline: text.overline, shadow: text.shadow, outline: text.outline,
    color: text.color && text.color !== '#000000' ? text.color : null, font: text.font, size: text.size,
  };
  const bg = cell['background-color'];
  if (bg && bg !== 'transparent') look.bg = bg.toLowerCase();
  look.align = { center: 'center', end: 'right', right: 'right', start: 'left', left: 'left', justify: 'justify' }[paragraph['text-align']] ?? null;
  if (cell['text-align-source'] === 'value-type') look.align = null;
  look.valign = { top: 'top', middle: 'middle', bottom: 'bottom' }[cell['vertical-align']] ?? null;
  look.wrap = cell['wrap-option'] === 'wrap';
  const margin = paragraph['margin-left'] ? parseLength(paragraph['margin-left']) : null;
  if (margin) look.indent = Math.max(0, Math.round(margin / (10 * 25.4 / 72)));
  const angle = Number(cell['rotation-angle'] ?? 0);
  if (angle) look.rotate = angle > 180 ? angle - 360 : angle;
  const borders = {};
  for (const side of SIDES) {
    const border = borderFromOdf(cell[`border-${side}`] ?? cell.border);
    if (border) borders[side] = border;
  }
  look.borders = borders;
  const pattern = dataStyle ? patternOf(styles, dataStyle, reader) : null;
  if (pattern) look.format = pattern;
  return cleanLook(look);
}

/** A named style of the file as one of Grid's, the first time a cell uses it. */
function namedGridStyle(style, reader) {
  const display = style.displayName ?? style.name;
  const id = KNOWN_STYLES[display] ?? `named-${display.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
  if (!reader.gridStyles.has(id)) {
    reader.gridStyles.set(id, { ...withoutDefaults(lookOfChain(style.name, reader), reader.baseLook), name: display });
  }
  return id;
}

/** A cell style from the file as one of Grid's: its named style, or a look of its own on top of one. */
function gridStyle(styleName, reader) {
  if (!styleName) return null;
  if (reader.styleNames.has(styleName)) return reader.styleNames.get(styleName);
  reader.baseLook ??= lookOfChain('Default', reader);
  const look = withoutDefaults(lookOfChain(styleName, reader), reader.baseLook);
  const common = reader.styles.chain('table-cell', styleName).find((s) => !s.automatic && s.name !== 'Default');
  const parent = common ? namedGridStyle(common, reader) : null;

  let name = null;
  if (parent && sameLook(look, reader.gridStyles.get(parent))) name = parent;
  else if (Object.keys(look).length > 0 || parent) {
    const style = parent ? { ...look, parent } : look;
    const key = JSON.stringify(style);
    for (const [existing, defined] of reader.gridStyles) if (JSON.stringify(defined) === key) name = existing;
    if (!name) {
      name = `imported-${reader.gridStyles.size + 1}`;
      reader.gridStyles.set(name, style);
    }
  }
  reader.styleNames.set(styleName, name);
  return name;
}

/** A data style as a format pattern; null when it is the plain default. */
function patternOf(styles, name, reader, depth = 0) {
  if (reader.patterns.has(name)) return reader.patterns.get(name);
  const element = styles.dataStyles.get(name);
  if (!element || depth > 4) return null;
  let pattern = sectionOf(element, reader);
  // LibreOffice keeps the positive case in a style it maps to, and the negative in this one.
  const positive = kids(element, NS.style, 'map').find((map) => /value\(\)\s*>=?\s*0/.test(attr(map, NS.style, 'condition') ?? ''));
  if (positive) {
    const first = patternOf(styles, attr(positive, NS.style, 'apply-style-name'), reader, depth + 1);
    if (first && pattern) pattern = `${first};${pattern}`;
  }
  reader.patterns.set(name, pattern);
  return pattern;
}

function sectionOf(element, reader) {
  const kind = element.localName;
  if (kind === 'boolean-style' || kind === 'text-style') return null;
  let out = '';
  const quote = (text) => {
    if (!text) return '';
    return /^[\s/\-:()$€£¥+]+$/.test(text) ? text : `"${text.replace(/"/g, '')}"`;
  };
  for (const part of kids(element)) {
    if (part.namespaceURI !== NS.number) continue;
    const long = attr(part, NS.number, 'style') === 'long';
    switch (part.localName) {
      case 'number': {
        const decimals = Number(attr(part, NS.number, 'decimal-places') ?? 0);
        const minDecimals = Number(attr(part, NS.number, 'min-decimal-places') ?? decimals);
        const integers = Math.max(1, Number(attr(part, NS.number, 'min-integer-digits') ?? 1));
        const grouping = attr(part, NS.number, 'grouping') === 'true';
        const digits = '0'.repeat(integers).padStart(4, '#');
        const whole = grouping ? `${digits.slice(0, -3)},${digits.slice(-3)}` : '0'.repeat(integers);
        const fraction = decimals > 0 ? `.${'0'.repeat(minDecimals)}${'#'.repeat(decimals - minDecimals)}` : '';
        out += `${whole}${fraction}`;
        break;
      }
      case 'scientific-number': {
        const decimals = Number(attr(part, NS.number, 'decimal-places') ?? 2);
        const digits = Number(attr(part, NS.number, 'min-exponent-digits') ?? 2);
        out += `0${decimals ? `.${'0'.repeat(decimals)}` : ''}E+${'0'.repeat(digits)}`;
        break;
      }
      case 'fraction':
        reader.losses.add('Numbers shown as fractions, shown as decimals');
        out += '0.00';
        break;
      case 'currency-symbol': out += quote(part.textContent); break;
      case 'text': out += kind === 'percentage-style' && part.textContent === '%' ? '%' : quote(part.textContent); break;
      case 'day': out += long ? 'dd' : 'd'; break;
      case 'month':
        if (attr(part, NS.number, 'textual') === 'true') out += long ? 'mmmm' : 'mmm';
        else out += long ? 'mm' : 'm';
        break;
      case 'year': out += long ? 'yyyy' : 'yy'; break;
      case 'day-of-week': out += long ? 'dddd' : 'ddd'; break;
      case 'hours':
        if (element.getAttributeNS(NS.number, 'truncate-on-overflow') === 'false') reader.losses.add('Times counted past 24 hours, shown within a day');
        out += long ? 'hh' : 'h';
        break;
      case 'minutes': out += long ? 'mm' : 'm'; break;
      case 'seconds': out += long ? 'ss' : 's'; break;
      case 'am-pm':
        reader.losses.add('Times with AM and PM, shown on 24 hours');
        break;
      default: break;
    }
  }
  if (kind === 'percentage-style' && !out.includes('%')) out += '%';
  return out || null;
}

/** Frozen rows and columns, from the view settings LibreOffice keeps per sheet. */
function readFrozen(source) {
  const frozen = new Map();
  let doc = null;
  if (typeof source?.text === 'function') {
    const text = source.text('settings.xml');
    if (text) {
      try {
        doc = parseXml(text, 'settings.xml');
      } catch {
        doc = null;
      }
    }
  } else doc = source;
  if (!doc) return frozen;
  const configNS = 'urn:oasis:names:tc:opendocument:xmlns:config:1.0';
  for (const entries of doc.getElementsByTagNameNS(configNS, 'config-item-map-named')) {
    if (entries.getAttributeNS(configNS, 'name') !== 'Tables') continue;
    for (const entry of kids(entries, configNS, 'config-item-map-entry')) {
      const items = new Map(kids(entry, configNS, 'config-item').map((item) => [item.getAttributeNS(configNS, 'name'), item.textContent]));
      const cols = items.get('HorizontalSplitMode') === '2' ? Number(items.get('HorizontalSplitPosition') ?? 0) : 0;
      const rows = items.get('VerticalSplitMode') === '2' ? Number(items.get('VerticalSplitPosition') ?? 0) : 0;
      if (cols > 0 || rows > 0) frozen.set(entry.getAttributeNS(configNS, 'name'), { rows, cols });
    }
  }
  return frozen;
}

// Writing

/**
 * @param {object} document Grid's toJSON()
 * @param {{flat?: boolean}} options
 * @returns {{entries?: object[], text?: string, losses: Losses}}
 */
export function writeOds(document, { flat = false } = {}) {
  const losses = new Losses();
  if ((document.sheets ?? []).some((sheet) => Object.values(sheet.cells ?? {}).some((cell) => cell?.rd))) losses.add('Cells marked to be covered, written in full: File, Export As, Redacted Export makes a copy without them');
  const writer = {
    cellStyles: new Map(), dataStyles: new Map(), columnStyles: new Map(), rowStyles: new Map(), pages: new Map(),
  };
  const gridStyles = document.styles ?? {};

  writer.namedStyles = new Map();
  writer.commonStyles = new Map();
  // Named styles are written whether or not a cell uses them, as LibreOffice keeps them.
  for (const [id, style] of Object.entries(gridStyles)) if (style?.name) commonStyle(id, writer, gridStyles);
  const validations = writeOdsValidations(document.sheets ?? []);
  const sheetList = document.sheets ?? [];
  const chartFiles = [];
  let objectNumber = 1;
  const tables = sheetList.map((sheet, i) => {
    const own = (document.charts ?? []).filter((chart) => chartSheetIndex(chart, sheetList) === i);
    const { shapes, files } = writeOdsCharts(sheet, own, objectNumber, { flat });
    objectNumber += own.length;
    chartFiles.push(...files);
    return writeTable(sheet, gridStyles, writer, validations.names[i], shapes);
  });
  const named = namedExpressions(document.names ?? {});
  const pivots = writeOdsPivots(sheetList, losses);
  const ranges = databaseRanges(document.sheets ?? []);
  const pages = [...writer.pages.values()];
  const automatic = [
    ...[...writer.dataStyles.values()].map((entry) => entry.element),
    ...[...writer.columnStyles.values()],
    ...[...writer.rowStyles.values()],
    ...pages.map((page) => page.style),
    ...[...writer.cellStyles.values()].map((entry) => entry.element),
  ];
  const layouts = pages.map((page) => page.layout);
  const masters = pages.length > 0 ? tag('office:master-styles', {}, pages.map((page) => page.master)) : null;
  const settings = settingsXml(document.sheets ?? []);
  // Wildcards, not regular expressions, in conditions such as COUNTIF(A1:A9;"ap*"), as Grid reads them.
  const calculation = tag('table:calculation-settings', {
    'table:automatic-find-labels': 'false', 'table:use-regular-expressions': 'false', 'table:use-wildcards': 'true',
  });

  // A common style sees only common data styles, so in a package the ones they use are written there too.
  const byName = new Map([...writer.dataStyles.values()].map((entry) => [entry.name, entry.element]));
  const commonData = new Set();
  const addData = (name) => {
    const element = byName.get(name);
    if (!element || commonData.has(element)) return;
    commonData.add(element);
    for (const child of element.children) if (child?.name === 'style:map') addData(child.attrs['style:apply-style-name']);
  };
  if (!flat) for (const entry of writer.commonStyles.values()) addData(entry.data);
  const named_styles = [...[...commonData].reverse(), ...[...writer.commonStyles.values(), ...writer.namedStyles.values()].map((entry) => entry.element)];
  const commonStyles = named_styles.length
    ? tag('office:styles', {}, tag('style:style', { 'style:name': 'Default', 'style:family': 'table-cell' }), named_styles) : null;

  if (flat) {
    const root = tag('office:document', {
      ...ROOT_NAMESPACES, 'xmlns:calcext': NS.calcext, 'xmlns:tableooo': TABLEOOO, 'xmlns:config': CONFIG, 'office:version': ODF_VERSION, 'office:mimetype': MIMETYPES.spreadsheet,
    },
    settings ? tag('office:settings', {}, settings) : null,
    commonStyles,
    tag('office:automatic-styles', {}, automatic, layouts),
    masters,
    tag('office:body', {}, tag('office:spreadsheet', {}, calculation, validations.element, ...[tables].flat(), named, ranges, pivots)));
    return { text: xmlDocument(root), losses };
  }

  const content = tag('office:document-content', { ...ROOT_NAMESPACES, 'xmlns:calcext': NS.calcext, 'xmlns:tableooo': TABLEOOO, 'office:version': ODF_VERSION },
    tag('office:automatic-styles', {}, automatic),
    tag('office:body', {}, tag('office:spreadsheet', {}, calculation, validations.element, ...[tables].flat(), named, ranges, pivots)));
  const files = [{ name: 'content.xml', data: xmlDocument(content), mediaType: 'text/xml' }, ...chartFiles];
  if (masters || named_styles.length) {
    files.push({
      name: 'styles.xml',
      data: xmlDocument(tag('office:document-styles', { ...ROOT_NAMESPACES, 'office:version': ODF_VERSION },
        commonStyles,
        tag('office:automatic-styles', {}, layouts), masters)),
      mediaType: 'text/xml',
    });
  }
  if (settings) {
    files.push({
      name: 'settings.xml',
      data: xmlDocument(tag('office:document-settings', { 'xmlns:office': NS.office, 'xmlns:config': CONFIG, 'office:version': ODF_VERSION },
        tag('office:settings', {}, settings))),
      mediaType: 'text/xml',
    });
  }
  return { entries: odfPackage(MIMETYPES.spreadsheet, files), losses };
}

const CONFIG = 'urn:oasis:names:tc:opendocument:xmlns:config:1.0';
/** LibreOffice's namespace for a sheet tab's colour. */
const TABLEOOO = 'http://openoffice.org/2009/table';

/** The index of the sheet a chart is on: by id, by index, or the first. */
function chartSheetIndex(chart, sheets) {
  if (typeof chart.sheet === 'number') return chart.sheet;
  const found = sheets.findIndex((sheet) => sheet.id === chart.sheet);
  return found === -1 ? 0 : found;
}

function writeTable(sheet, gridStyles, writer, validations = [], shapes = null) {
  const print = sheetPrint(sheet);
  const cells = new Map(Object.entries(sheet.cells ?? {}).map(([key, cell]) => {
    const [row, col] = key.split(',').map(Number);
    return [key, { row, col, cell }];
  }));
  let maxRow = -1;
  let maxCol = -1;
  for (const { row, col } of cells.values()) {
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
  }
  const widths = Object.entries(sheet.cols ?? {}).map(([c, w]) => [Number(c), sizeOf(w, 'w')]).filter(([, w]) => w > 0);
  for (const [c] of widths) maxCol = Math.max(maxCol, c);
  const heights = new Map(Object.entries(sheet.rows ?? {}).map(([r, h]) => [Number(r), sizeOf(h, 'h')]).filter(([, h]) => h > 0));
  for (const r of heights.keys()) maxRow = Math.max(maxRow, r);
  const rowBreaks = new Set(print.rowBreaks);
  const colBreaks = new Set(print.colBreaks);
  for (const r of rowBreaks) maxRow = Math.max(maxRow, r);
  for (const c of colBreaks) maxCol = Math.max(maxCol, c);
  const header = print.repeatRows;
  if (header) maxRow = Math.max(maxRow, header.bottom);

  const hiddenCols = new Set(Object.entries(sheet.cols ?? {}).filter(([, v]) => v?.hidden).map(([c]) => Number(c)));
  const hiddenRows = new Set(Object.entries(sheet.rows ?? {}).filter(([, v]) => v?.hidden).map(([r]) => Number(r)));
  const filteredRows = new Set(sheet.filteredRows ?? []);
  for (const c of hiddenCols) maxCol = Math.max(maxCol, c);
  for (const r of [...hiddenRows, ...filteredRows]) maxRow = Math.max(maxRow, r);
  const merges = sheet.merges ?? [];
  for (const m of merges) {
    maxRow = Math.max(maxRow, m.bottom);
    maxCol = Math.max(maxCol, m.right);
  }
  const mergeAnchor = new Map(merges.map((m) => [`${m.top},${m.left}`, m]));
  for (const { area } of validations) {
    maxRow = Math.max(maxRow, area.bottom);
    maxCol = Math.max(maxCol, area.right);
  }
  const validationAt = (r, c) => validations.find(({ area }) => r >= area.top && r <= area.bottom && c >= area.left && c <= area.right)?.name ?? null;
  const covered = (r, c) => merges.some((m) => r >= m.top && r <= m.bottom && c >= m.left && c <= m.right && !(r === m.top && c === m.left));
  const rowVisibility = (r) => (filteredRows.has(r) ? 'filter' : hiddenRows.has(r) ? 'collapse' : null);

  const columns = [];
  const widthMap = new Map(widths);
  const widthOf = (c) => widthMap.get(c) ?? DEFAULT_WIDTH;
  for (let c = 0; c <= Math.max(maxCol, 0);) {
    const width = widthOf(c);
    let run = 1;
    while (c + run <= maxCol && widthOf(c + run) === width && !colBreaks.has(c + run) && hiddenCols.has(c + run) === hiddenCols.has(c)) run += 1;
    columns.push(tag('table:table-column', {
      'table:style-name': columnStyle(width, colBreaks.has(c), writer),
      'table:number-columns-repeated': run > 1 ? String(run) : null,
      'table:visibility': hiddenCols.has(c) ? 'collapse' : null,
    }));
    c += run;
  }

  const inMerge = (r) => merges.some((m) => r >= m.top && r <= m.bottom);
  // The validations a row lies in; empty rows under the same ones are written once and repeated.
  const coveringOf = (r) => validations.filter(({ area }) => r >= area.top && r <= area.bottom).map(({ name }) => name).join('\n');
  const byRow = new Map();
  for (const { row, col, cell } of cells.values()) {
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row)[col] = cell;
  }
  const marked = (r) => heights.has(r) || rowBreaks.has(r) || (header && (r === header.top || r === header.bottom + 1))
    || rowVisibility(r) !== null || inMerge(r) || byRow.has(r);
  const childrenOf = (r, rowCells) => {
    const children = [];
    for (let c = 0; c <= maxCol;) {
      if (covered(r, c)) {
        children.push(tag('table:covered-table-cell', {}));
        c += 1;
        continue;
      }
      const cell = rowCells[c];
      const merge = mergeAnchor.get(`${r},${c}`);
      const rule = validationAt(r, c);
      if (!cell && !merge) {
        let run = 1;
        while (c + run <= maxCol && !rowCells[c + run] && !covered(r, c + run) && !mergeAnchor.has(`${r},${c + run}`)
          && validationAt(r, c + run) === rule) run += 1;
        children.push(tag('table:table-cell', { 'table:number-columns-repeated': run > 1 ? String(run) : null, 'table:content-validation-name': rule }));
        c += run;
        continue;
      }
      const written = cell ? writeCell(cell, gridStyles, writer) : tag('table:table-cell', {});
      if (rule) written.attrs['table:content-validation-name'] = rule;
      if (merge) {
        written.attrs['table:number-columns-spanned'] = String(merge.right - merge.left + 1);
        written.attrs['table:number-rows-spanned'] = String(merge.bottom - merge.top + 1);
      }
      children.push(written);
      c += 1;
    }
    if (children.length === 0) children.push(tag('table:table-cell', {}));
    return children;
  };
  const rows = [];
  for (let r = 0; r <= maxRow;) {
    const rowCells = byRow.get(r) ?? [];
    const style = heights.has(r) || rowBreaks.has(r) ? rowStyle(heights.get(r) ?? null, rowBreaks.has(r), writer) : null;
    if (rowCells.length === 0 && !inMerge(r)) {
      const covering = coveringOf(r);
      let run = 1;
      while (r + run <= maxRow && !marked(r + run) && rowVisibility(r + run) === rowVisibility(r) && coveringOf(r + run) === covering) run += 1;
      rows.push({ at: r, element: tag('table:table-row', {
        'table:style-name': style, 'table:number-rows-repeated': run > 1 ? String(run) : null,
        'table:visibility': rowVisibility(r),
      }, covering ? childrenOf(r, rowCells) : tag('table:table-cell', {})) });
      r += run;
      continue;
    }
    rows.push({ at: r, element: tag('table:table-row', { 'table:style-name': style, 'table:visibility': rowVisibility(r) }, childrenOf(r, rowCells)) });
    r += 1;
  }
  if (rows.length === 0) rows.push({ at: 0, element: tag('table:table-row', {}, tag('table:table-cell', {})) });

  const inHeader = (row) => header && row.at >= header.top && row.at <= header.bottom;
  const body = header
    ? [
      ...rows.filter((row) => row.at < header.top).map((row) => row.element),
      tag('table:table-header-rows', {}, rows.filter(inHeader).map((row) => row.element)),
      ...rows.filter((row) => row.at > header.bottom).map((row) => row.element),
    ]
    : rows.map((row) => row.element);

  return tag('table:table', {
    'table:name': sheet.name ?? 'Sheet1',
    'table:style-name': sheet.print || sheet.hidden || sheet.tab ? tableStyle(print, writer, sheet) : null,
    'table:print-ranges': print.area ? odfArea(sheet.name ?? 'Sheet1', print.area) : null,
  }, shapes, columns, body, writeOdsConditions(sheet.name ?? 'Sheet1', sheet.conditions, (look) => namedStyle(look, writer)));
}

/** A named cell style for a conditional format's look, as LibreOffice applies them by name. */
function namedStyle(look, writer) {
  const key = JSON.stringify(look);
  if (writer.namedStyles.has(key)) return writer.namedStyles.get(key).name;
  const name = `GRTConditional${writer.namedStyles.size + 1}`;
  const element = tag('style:style', { 'style:name': name, 'style:family': 'table-cell', 'style:parent-style-name': 'Default' },
    lookProperties(look, writer));
  writer.namedStyles.set(key, { name, element });
  return name;
}

/** Defined names: a block of cells as a named range, anything else as a named expression. */
function namedExpressions(names) {
  const entries = Object.entries(names);
  if (entries.length === 0) return null;
  return tag('table:named-expressions', {}, entries.sort().map(([name, text]) => {
    const formula = toOpenFormula(text);
    const block = /^of:=\[([^\]]+)\]$/.exec(formula);
    return block
      ? tag('table:named-range', { 'table:name': name, 'table:base-cell-address': '$Sheet1.$A$1', 'table:cell-range-address': block[1].replace(/^\./, '') })
      : tag('table:named-expression', { 'table:name': name, 'table:base-cell-address': '$Sheet1.$A$1', 'table:expression': formula });
  }));
}

const FILTER_OPERATORS = { '=': '=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', contains: 'contains', 'not-contains': '!contains', begins: 'begins', ends: 'ends', empty: 'empty', 'not-empty': '!empty' };

/** Each sheet's autofilter, as LibreOffice keeps it: an anonymous database range with filter buttons. */
function databaseRanges(sheets) {
  const ranges = sheets.map((sheet, i) => {
    const filter = sheet.filter;
    if (!filter) return null;
    const conditions = [];
    for (const [offset, rule] of Object.entries(filter.columns ?? {})) {
      if (rule.values) {
        const values = rule.values.length ? rule.values : [''];
        conditions.push(tag('table:filter-condition', { 'table:field-number': offset, 'table:operator': '=', 'table:value': values[0] },
          values.length > 1 ? values.map((value) => tag('table:filter-set-item', { 'table:value': value })) : null));
      }
      for (const c of rule.conditions ?? []) {
        conditions.push(tag('table:filter-condition', {
          'table:field-number': offset, 'table:operator': FILTER_OPERATORS[c.op] ?? '=', 'table:value': String(c.value ?? ''),
          'table:data-type': Number.isFinite(Number(c.value)) && String(c.value).trim() !== '' ? 'number' : null,
        }));
      }
      if (rule.top) {
        const op = `${rule.top.largest === false ? 'bottom' : 'top'} ${rule.top.percent ? 'percent' : 'values'}`;
        conditions.push(tag('table:filter-condition', { 'table:field-number': offset, 'table:operator': op, 'table:value': String(rule.top.count), 'table:data-type': 'number' }));
      }
    }
    const ors = Object.values(filter.columns ?? {}).some((rule) => rule.join === 'or');
    return tag('table:database-range', {
      'table:name': `__Anonymous_Sheet_DB__${i}`, 'table:target-range-address': odfArea(sheet.name ?? 'Sheet1', filter.area),
      'table:display-filter-buttons': 'true',
    }, conditions.length ? tag('table:filter', {}, conditions.length > 1 ? tag(ors ? 'table:filter-or' : 'table:filter-and', {}, conditions) : conditions) : null);
  }).filter(Boolean);
  return ranges.length ? tag('table:database-ranges', {}, ranges) : null;
}

/** A sheet's page, as a table style pointing at a master page of its own kind. */
function tableStyle(print, writer, sheet) {
  const tab = /^#[0-9a-f]{6}$/i.test(sheet.tab ?? '') ? sheet.tab : null;
  const key = JSON.stringify([print.size, print.width, print.height, print.orientation, print.margin, print.fitWidth, print.gridlines, print.labels, print.header, print.footer, Boolean(sheet.hidden), tab]);
  if (!writer.pages.has(key)) {
    const n = writer.pages.size + 1;
    const paper = paperOf(print);
    const [width, height] = paper.landscape ? [paper.long, paper.short] : [paper.short, paper.long];
    const cm = (mm) => formatLength(mm, 'cm');
    const band = print.margin * 0.65;
    const bandStyle = (which) => tag(`style:${which}-style`, {}, tag('style:header-footer-properties', {
      'fo:min-height': cm(band), 'fo:margin-left': '0cm', 'fo:margin-right': '0cm',
      [which === 'header' ? 'fo:margin-bottom' : 'fo:margin-top']: '0cm',
    }));
    const edge = print.labels ? print.margin * 0.35 : print.margin;
    const layout = tag('style:page-layout', { 'style:name': `Mpm${n}` },
      tag('style:page-layout-properties', {
        'fo:page-width': cm(width), 'fo:page-height': cm(height), 'style:print-orientation': paper.landscape ? 'landscape' : 'portrait',
        'fo:margin-top': cm(edge), 'fo:margin-bottom': cm(edge), 'fo:margin-left': cm(print.margin), 'fo:margin-right': cm(print.margin),
        'style:print-page-order': 'ttb', 'style:scale-to-X': print.fitWidth ? '1' : null,
        'style:print': print.gridlines ? 'charts drawings grid objects zero-values' : 'charts drawings objects zero-values',
      }),
      print.labels ? [bandStyle('header'), bandStyle('footer')] : null);
    const centred = (...content) => tag('style:region-center', {}, tag('text:p', {}, ...content));
    const master = tag('style:master-page', { 'style:name': `GRT_Page_${n}`, 'style:page-layout-name': `Mpm${n}` },
      print.labels ? [
        tag('style:header', {}, centred(...odfBandParts(print.header ?? '&A', tag))),
        tag('style:footer', {}, centred(...odfBandParts(print.footer ?? 'Page &P of &N', tag))),
      ] : null);
    const style = tag('style:style', { 'style:name': `ta${n}`, 'style:family': 'table', 'style:master-page-name': `GRT_Page_${n}` },
      tag('style:table-properties', { 'table:display': sheet.hidden ? 'false' : 'true', 'style:writing-mode': 'lr-tb', 'tableooo:tab-color': tab }));
    writer.pages.set(key, { style, layout, master });
  }
  return writer.pages.get(key).style.attrs['style:name'];
}

/** A column width or row height in pixels, as Grid keeps it ({w} or {h}) or as a bare number. */
function sizeOf(value, key) {
  const px = typeof value === 'number' ? value : value?.[key];
  return Number.isFinite(px) ? px : 0;
}

function columnStyle(width, pageBreak, writer) {
  const key = `${width}|${pageBreak}`;
  if (!writer.columnStyles.has(key)) {
    const name = `co${writer.columnStyles.size + 1}`;
    writer.columnStyles.set(key, tag('style:style', { 'style:name': name, 'style:family': 'table-column' },
      tag('style:table-column-properties', {
        'fo:break-before': pageBreak ? 'page' : 'auto', 'style:column-width': formatLength(toMm(width, 'px'), 'cm'),
      })));
  }
  return writer.columnStyles.get(key).attrs['style:name'];
}

function rowStyle(height, pageBreak, writer) {
  const key = `${height}|${pageBreak}`;
  if (!writer.rowStyles.has(key)) {
    const name = `ro${writer.rowStyles.size + 1}`;
    writer.rowStyles.set(key, tag('style:style', { 'style:name': name, 'style:family': 'table-row' },
      tag('style:table-row-properties', {
        'style:row-height': height === null ? null : formatLength(toMm(height, 'px'), 'cm'),
        'fo:break-before': pageBreak ? 'page' : 'auto',
        'style:use-optimal-row-height': height === null ? 'true' : 'false',
      })));
  }
  return writer.rowStyles.get(key).attrs['style:name'];
}

const isDatePattern = (pattern) => !!pattern && /[ymdhs]/i.test(stripLiterals(pattern)) && !/[#0?]/.test(stripLiterals(pattern));
const isTimeOnly = (pattern) => isDatePattern(pattern) && !/[yd]/i.test(stripLiterals(pattern)) && /[hs]/i.test(stripLiterals(pattern));

function stripLiterals(pattern) {
  return String(pattern).replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
}

function writeCell(cell, gridStyles, writer) {
  const style = cell.s ? gridStyles[cell.s] ?? null : null;
  const attrs = { 'table:style-name': style ? cellStyle(cell.s, style, writer, gridStyles) : null };
  if (cell.f) attrs['table:formula'] = toOpenFormula(cell.f);
  if (cell.f && cell.a) {
    attrs['table:number-matrix-rows-spanned'] = String(cell.a[0]);
    attrs['table:number-matrix-columns-spanned'] = String(cell.a[1]);
  }
  const value = cell.v;
  let shown = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (isDatePattern(style?.format)) {
      if (isTimeOnly(style.format)) {
        attrs['office:value-type'] = 'time';
        attrs['office:time-value'] = isoDuration(value);
      } else {
        attrs['office:value-type'] = 'date';
        attrs['office:date-value'] = isoDate(value);
      }
    } else if (style?.format?.includes('%')) {
      attrs['office:value-type'] = 'percentage';
      attrs['office:value'] = String(value);
    } else {
      attrs['office:value-type'] = 'float';
      attrs['office:value'] = String(value);
    }
    shown = String(value);
  } else if (typeof value === 'boolean') {
    attrs['office:value-type'] = 'boolean';
    attrs['office:boolean-value'] = String(value);
    shown = value ? 'TRUE' : 'FALSE';
  } else if (typeof value === 'string') {
    attrs['office:value-type'] = 'string';
    shown = value;
  }
  const link = typeof cell.l === 'string' && cell.l !== '' ? odfLink(cell.l) : null;
  const paragraphs = shown === null ? [] : String(shown).split('\n')
    .map((line) => tag('text:p', {}, link ? tag('text:a', { 'xlink:type': 'simple', 'xlink:href': link }, odfText(line)) : odfText(line)));
  const note = typeof cell.n === 'string' && cell.n !== ''
    ? tag('office:annotation', { 'office:display': cell.ns ? 'true' : null }, cell.n.split('\n').map((line) => tag('text:p', {}, odfText(line)))) : null;
  return tag('table:table-cell', attrs, note, paragraphs);
}

function isoDate(serial) {
  // Counted in microseconds, so a time between two seconds keeps its fraction.
  const micro = Math.round(serial * DAY * 1000);
  const whole = Math.floor(micro / 1e6);
  const iso = new Date(whole * 1000 + Date.UTC(1899, 11, 30)).toISOString();
  if (Number.isInteger(serial)) return iso.slice(0, 10);
  const fraction = micro - whole * 1e6;
  return fraction ? `${iso.slice(0, 19)}.${String(fraction).padStart(6, '0').replace(/0+$/, '')}` : iso.slice(0, 19);
}

function isoDuration(fraction) {
  const exact = Math.abs(fraction) * 86400;
  // Whole seconds unless the time holds less than a second, which is kept to the microsecond.
  const total = Math.abs(exact - Math.round(exact)) < 1e-6 ? Math.round(exact) : exact;
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total - h * 3600 - m * 60;
  const seconds = Number.isInteger(s) ? String(s) : s.toFixed(6).replace(/0+$/, '');
  return `${fraction < 0 ? '-' : ''}PT${String(h).padStart(2, '0')}H${String(m).padStart(2, '0')}M${seconds.padStart(s < 10 ? seconds.length + 1 : 0, '0')}S`;
}

/** A look as the property elements of an ODF cell style. */
function lookProperties(look, writer) {
  const text = {};
  if (look.bold) Object.assign(text, { 'fo:font-weight': 'bold', 'style:font-weight-asian': 'bold', 'style:font-weight-complex': 'bold' });
  if (look.italic) Object.assign(text, { 'fo:font-style': 'italic', 'style:font-style-asian': 'italic', 'style:font-style-complex': 'italic' });
  if (look.underline || look.double) Object.assign(text, { 'style:text-underline-style': 'solid', 'style:text-underline-width': 'auto', 'style:text-underline-color': 'font-color' });
  if (look.double) text['style:text-underline-type'] = 'double';
  if (look.strike) text['style:text-line-through-style'] = 'solid';
  if (look.overline) Object.assign(text, { 'style:text-overline-style': 'solid', 'style:text-overline-width': 'auto', 'style:text-overline-color': 'font-color' });
  if (look.shadow) text['fo:text-shadow'] = '1pt 1pt';
  if (look.outline) text['style:text-outline'] = 'true';
  if (look.color) text['fo:color'] = look.color;
  if (look.font) text['fo:font-family'] = /\s/.test(look.font) ? `'${look.font}'` : look.font;
  if (look.size) text['fo:font-size'] = `${look.size}pt`;
  const cell = {};
  if (look.bg) cell['fo:background-color'] = look.bg;
  if (look.valign) cell['style:vertical-align'] = look.valign;
  if (look.wrap) cell['fo:wrap-option'] = 'wrap';
  if (look.rotate) cell['style:rotation-angle'] = String((look.rotate + 360) % 360);
  for (const side of SIDES) {
    const border = borderToOdf(look.borders?.[side]);
    if (border) cell[`fo:border-${side}`] = border;
  }
  const align = { left: 'start', center: 'center', right: 'end', justify: 'justify' }[look.align];
  if (align) cell['style:text-align-source'] = 'fix';
  const paragraph = {};
  if (align) paragraph['fo:text-align'] = align;
  if (look.indent) paragraph['fo:margin-left'] = `${look.indent * 10}pt`;
  return [
    Object.keys(cell).length ? tag('style:table-cell-properties', cell) : null,
    Object.keys(paragraph).length ? tag('style:paragraph-properties', paragraph) : null,
    Object.keys(text).length ? tag('style:text-properties', text) : null,
  ];
}

/** The name a named style of Grid's has in the file, written among the common styles the first time. */
function commonStyle(id, writer, gridStyles) {
  if (writer.commonStyles.has(id)) return writer.commonStyles.get(id).name;
  const style = gridStyles[id];
  const display = style?.name ?? id;
  if (display === 'Default') return 'Default';
  const name = display.replace(/[^A-Za-z0-9_.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
  const data = style.format ? dataStyle(style.format, writer) : null;
  const element = tag('style:style', {
    'style:name': name, 'style:display-name': name === display ? null : display, 'style:family': 'table-cell',
    'style:parent-style-name': 'Default', 'style:data-style-name': data,
  }, lookProperties(style, writer));
  writer.commonStyles.set(id, { name, element, data });
  return name;
}

function cellStyle(name, style, writer, gridStyles) {
  if (writer.cellStyles.has(name)) return writer.cellStyles.get(name).name;
  const styleName = `ce${writer.cellStyles.size + 1}`;
  const data = style.format ? dataStyle(style.format, writer) : null;
  const named = style.name ? name : style.parent && gridStyles[style.parent] ? style.parent : null;
  const parent = named ? commonStyle(named, writer, gridStyles) : null;
  const element = tag('style:style', {
    'style:name': styleName, 'style:family': 'table-cell', 'style:parent-style-name': parent, 'style:data-style-name': data,
  }, lookProperties(style, writer));
  writer.cellStyles.set(name, { name: styleName, element });
  return styleName;
}

/** A pattern as an ODF data style; sections become mapped styles, as LibreOffice writes them. */
function dataStyle(pattern, writer) {
  if (writer.dataStyles.has(pattern)) return writer.dataStyles.get(pattern).name;
  const sections = splitSections(pattern);
  const name = `N${writer.dataStyles.size + 1}`;
  writer.dataStyles.set(pattern, { name, element: null });
  if (sections.length > 1) {
    const positive = dataStyle(sections[0], writer);
    const main = sectionElement(sections[1], name);
    main.children.push(tag('style:map', { 'style:condition': 'value()>=0', 'style:apply-style-name': positive }));
    writer.dataStyles.get(pattern).element = main;
  } else {
    writer.dataStyles.get(pattern).element = sectionElement(sections[0], name);
  }
  return name;
}

function splitSections(pattern) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const c of pattern) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out.slice(0, 2);
}

function sectionElement(section, name) {
  const pieces = [];
  let i = 0;
  const literal = (text) => {
    const last = pieces[pieces.length - 1];
    if (last?.literal !== undefined) last.literal += text;
    else pieces.push({ literal: text });
  };
  while (i < section.length) {
    const c = section[i];
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      literal(section.slice(i + 1, end === -1 ? undefined : end));
      i = end === -1 ? section.length : end + 1;
    } else if (c === '\\') {
      literal(section[i + 1] ?? '');
      i += 2;
    } else if (c === '[') {
      const end = section.indexOf(']', i);
      const currency = /^\[\$([^-\]]*)/.exec(section.slice(i));
      if (currency && currency[1]) literal(currency[1]);
      i = end === -1 ? section.length : end + 1;
    } else if (c === '_' || c === '*') {
      i += 2;
    } else {
      const run = /^(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|[#0?,.]+(?:E[+-]0+)?|%)/i.exec(section.slice(i));
      if (run) {
        pieces.push({ code: run[0] });
        i += run[0].length;
      } else {
        literal(c);
        i += 1;
      }
    }
  }

  const codes = pieces.filter((p) => p.code).map((p) => p.code).join('');
  const date = /[ymdhs]/i.test(codes) && !/[#0?]/.test(codes);
  const percent = codes.includes('%');
  const children = [];
  pieces.forEach((piece, index) => {
    if (piece.literal !== undefined) {
      children.push(tag('number:text', {}, piece.literal));
      return;
    }
    const code = piece.code;
    if (date) {
      const lower = code.toLowerCase();
      const long = lower.length > 1;
      const minutes = (lower === 'm' || lower === 'mm') && isMinute(pieces, index);
      if (lower[0] === 'y') children.push(tag('number:year', { 'number:style': lower.length > 2 ? 'long' : null }));
      else if (lower[0] === 'm' && !minutes) {
        children.push(tag('number:month', {
          'number:style': lower.length === 2 || lower.length === 4 ? 'long' : null,
          'number:textual': lower.length > 2 ? 'true' : null,
        }));
      } else if (lower[0] === 'm') children.push(tag('number:minutes', { 'number:style': long ? 'long' : null }));
      else if (lower[0] === 'd' && lower.length > 2) children.push(tag('number:day-of-week', { 'number:style': lower.length > 3 ? 'long' : null }));
      else if (lower[0] === 'd') children.push(tag('number:day', { 'number:style': long ? 'long' : null }));
      else if (lower[0] === 'h') children.push(tag('number:hours', { 'number:style': long ? 'long' : null }));
      else if (lower[0] === 's') children.push(tag('number:seconds', { 'number:style': long ? 'long' : null }));
      return;
    }
    if (code === '%') {
      children.push(tag('number:text', {}, '%'));
      return;
    }
    const scientific = /E[+-](0+)$/i.exec(code);
    const mantissa = scientific ? code.slice(0, scientific.index) : code;
    const [whole, fraction = ''] = mantissa.split('.');
    const decimals = fraction.replace(/[^0#?]/g, '').length;
    const minDecimals = fraction.replace(/[^0]/g, '').length;
    const integers = Math.max(1, (whole.match(/0/g) ?? []).length);
    if (scientific) {
      children.push(tag('number:scientific-number', {
        'number:decimal-places': String(decimals), 'number:min-integer-digits': String(integers), 'number:min-exponent-digits': String(scientific[1].length),
      }));
    } else {
      children.push(tag('number:number', {
        'number:decimal-places': String(decimals),
        'number:min-decimal-places': minDecimals !== decimals ? String(minDecimals) : null,
        'number:min-integer-digits': String(integers),
        'number:grouping': whole.includes(',') ? 'true' : null,
      }));
    }
  });

  const kind = date ? 'date-style' : percent ? 'percentage-style' : 'number-style';
  return tag(`number:${kind}`, { 'style:name': name }, children);
}

function isMinute(pieces, index) {
  const parts = pieces.filter((p) => p.code && /^[ymdhs]/i.test(p.code));
  const at = parts.indexOf(pieces[index]);
  return /^h/i.test(parts[at - 1]?.code ?? '') || /^s/i.test(parts[at + 1]?.code ?? '');
}

function settingsXml(sheets) {
  const frozen = sheets.filter((sheet) => sheet.frozen && (sheet.frozen.rows > 0 || sheet.frozen.cols > 0));
  if (frozen.length === 0) return null;
  const item = (name, type, value) => tag('config:config-item', { 'config:name': name, 'config:type': type }, String(value));
  return tag('config:config-item-set', { 'config:name': 'ooo:view-settings' },
    tag('config:config-item-map-indexed', { 'config:name': 'Views' },
      tag('config:config-item-map-entry', {},
        item('ViewId', 'string', 'view1'),
        tag('config:config-item-map-named', { 'config:name': 'Tables' },
          frozen.map((sheet) => tag('config:config-item-map-entry', { 'config:name': sheet.name },
            item('HorizontalSplitMode', 'short', sheet.frozen.cols > 0 ? 2 : 0),
            item('VerticalSplitMode', 'short', sheet.frozen.rows > 0 ? 2 : 0),
            item('HorizontalSplitPosition', 'int', sheet.frozen.cols),
            item('VerticalSplitPosition', 'int', sheet.frozen.rows),
            item('ActiveSplitRange', 'short', 2),
            item('PositionLeft', 'int', 0),
            item('PositionRight', 'int', sheet.frozen.cols),
            item('PositionTop', 'int', 0),
            item('PositionBottom', 'int', sheet.frozen.rows)))))));
}
