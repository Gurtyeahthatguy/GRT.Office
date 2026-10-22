/** OpenDocument spreadsheets to and from Grid's document. */

import { NS, kids, kid, attr, is, tag, xmlDocument } from '../xml.js';
import { parseLength, formatLength, toMm } from '../units.js';
import { Losses } from '../losses.js';
import {
  odfDocuments, OdfStyles, textLook, MIMETYPES, ODF_VERSION, ROOT_NAMESPACES, odfPackage, odfText,
} from './odf.js';
import { fromOpenFormula, toOpenFormula } from './formulas.js';
import {
  SHEET_PRINT_DEFAULTS, sheetPrint, paperOf, paperFields, parseSheetRange, splitOutsideQuotes, odfArea,
} from './sheet-print.js';

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

  const masterStyles = new OdfStyles([docs.styles, docs.content].filter(Boolean), docs.styles ?? docs.content);
  const reader = { styles, masterStyles, losses, patterns: new Map(), gridStyles: new Map(), styleNames: new Map() };

  if (kid(body, NS.table, 'named-expressions')?.firstElementChild) losses.add('Named ranges, which formulas using them cannot find');
  if (kid(body, NS.table, 'content-validations')) losses.add('Rules on what a cell accepts');
  if (kid(body, NS.table, 'data-pilot-tables')) losses.add('Pivot tables, kept as their last results');
  if (body.getElementsByTagNameNS(NS.table, 'database-range').length > 0) losses.add('Filters on columns');
  if ([...body.getElementsByTagName('*')].some((n) => n.localName === 'conditional-formats')) losses.add('Formatting that depends on a cell’s value');

  const frozen = readFrozen(typeof source === 'string' ? docs.content : source);
  const sheets = kids(body, NS.table, 'table').map((table) => readTable(table, reader, frozen));
  if (sheets.length === 0) throw new Error('This spreadsheet has no sheets');

  const gridStyles = {};
  for (const [name, style] of reader.gridStyles) gridStyles[name] = style;
  return {
    document: { version: 1, type: 'grid', sheets, styles: gridStyles, charts: [] },
    losses,
  };
}

function readTable(table, reader, frozen) {
  const { styles, losses } = reader;
  const name = attr(table, NS.table, 'name') ?? 'Sheet';
  const tableStyle = styles.resolve('table', attr(table, NS.table, 'style-name'), 'table');
  if (tableStyle.display === 'false') losses.add('Hidden sheets, shown');
  if (table.getElementsByTagNameNS(NS.draw, 'frame').length > 0) losses.add('Charts and pictures in sheets');

  const cells = {};
  const cols = {};
  const rows = {};
  const columnDefaults = [];
  const rowBreaks = [];
  const colBreaks = [];
  let headerRows = null;

  let col = 0;
  for (const column of flatten(table, 'table-column', ['table-columns', 'table-column-group', 'table-header-columns'])) {
    const repeat = Math.min(Number(attr(column, NS.table, 'number-columns-repeated') ?? 1), COLUMN_LIMIT - col);
    const props = styles.resolve('table-column', attr(column, NS.table, 'style-name'), 'column');
    const width = parseLength(props['column-width']);
    if (attr(column, NS.table, 'visibility') === 'collapse') losses.add('Hidden rows and columns, shown');
    const defaultStyle = attr(column, NS.table, 'default-cell-style-name');
    if (props['break-before'] === 'page' && col > 0) colBreaks.push(col);
    for (let i = 0; i < repeat && col < COLUMN_LIMIT; i += 1, col += 1) {
      columnDefaults[col] = defaultStyle;
      if (width !== null && i < 1024) {
        const px = Math.round(width * PX_PER_MM);
        if (Math.abs(px - DEFAULT_WIDTH) > 1) cols[col] = { w: px };
      }
    }
  }

  let row = 0;
  for (const rowElement of flatten(table, 'table-row', ['table-rows', 'table-row-group', 'table-header-rows'])) {
    if (row >= ROW_LIMIT) break;
    const repeat = Number(attr(rowElement, NS.table, 'number-rows-repeated') ?? 1);
    const props = styles.resolve('table-row', attr(rowElement, NS.table, 'style-name'), 'row');
    if (attr(rowElement, NS.table, 'visibility') === 'collapse') losses.add('Hidden rows and columns, shown');
    const height = props['use-optimal-row-height'] === 'true' ? null : parseLength(props['row-height']);
    const rowDefault = attr(rowElement, NS.table, 'default-cell-style-name');
    if (props['break-before'] === 'page' && row > 0) rowBreaks.push(row);
    if (inHeaderRows(rowElement, table)) {
      headerRows = { top: headerRows?.top ?? row, bottom: row + Math.min(repeat, 1000) - 1 };
    }

    const values = readRow(rowElement, reader, columnDefaults, rowDefault);
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
    row += repeat;
  }

  const sheetFrozen = frozen.get(name) ?? null;
  const print = readPrint(table, reader);
  Object.assign(print, { rowBreaks, colBreaks, repeatRows: headerRows });
  return { name, cells, cols, rows, frozen: sheetFrozen, print };
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

function readRow(rowElement, reader, columnDefaults, rowDefault) {
  const values = new Map();
  let col = 0;
  for (const cell of kids(rowElement)) {
    if (cell.namespaceURI !== NS.table || !['table-cell', 'covered-table-cell'].includes(cell.localName)) continue;
    const repeat = Number(attr(cell, NS.table, 'number-columns-repeated') ?? 1);
    if (cell.localName === 'covered-table-cell') {
      col += repeat;
      continue;
    }
    if (Number(attr(cell, NS.table, 'number-columns-spanned') ?? 1) > 1 || Number(attr(cell, NS.table, 'number-rows-spanned') ?? 1) > 1) {
      reader.losses.add('Merged cells, shown unmerged');
    }
    if (kid(cell, NS.office, 'annotation')) reader.losses.add('Comments on cells');
    const read = readCell(cell, reader, attr(cell, NS.table, 'style-name') ?? columnDefaults[col] ?? rowDefault);
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
  return out.v === undefined && out.f === undefined ? null : out;
}

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

/** A cell style from the file as one of Grid's, named in order of first use. */
function gridStyle(styleName, reader) {
  if (!styleName) return null;
  if (reader.styleNames.has(styleName)) return reader.styleNames.get(styleName);
  const { styles } = reader;
  const text = textLook(styles.resolve('table-cell', styleName, 'text'), styles);
  const cell = styles.resolve('table-cell', styleName, 'cell');
  const paragraph = styles.resolve('table-cell', styleName, 'paragraph');
  const dataStyle = styles.chain('table-cell', styleName).find((s) => s.dataStyle)?.dataStyle ?? null;

  const style = {};
  if (text.bold) style.bold = true;
  if (text.italic) style.italic = true;
  if (text.color && text.color !== '#000000') style.color = text.color;
  const bg = cell['background-color'];
  if (bg && bg !== 'transparent') style.bg = bg.toLowerCase();
  const align = { center: 'center', end: 'right', right: 'right', start: 'left', left: 'left', justify: 'left' }[paragraph['text-align']];
  if (align) style.align = align;
  const pattern = dataStyle ? patternOf(styles, dataStyle, reader) : null;
  if (pattern) style.format = pattern;

  let name = null;
  if (Object.keys(style).length > 0) {
    const key = JSON.stringify(style);
    for (const [existing, defined] of reader.gridStyles) {
      if (JSON.stringify(defined) === key) name = existing;
    }
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
        doc = new DOMParser().parseFromString(text, 'application/xml');
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
  const writer = {
    cellStyles: new Map(), dataStyles: new Map(), columnStyles: new Map(), rowStyles: new Map(), pages: new Map(),
  };
  const gridStyles = document.styles ?? {};

  const tables = (document.sheets ?? []).map((sheet) => writeTable(sheet, gridStyles, writer));
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

  if (flat) {
    const root = tag('office:document', {
      ...ROOT_NAMESPACES, 'xmlns:config': CONFIG, 'office:version': ODF_VERSION, 'office:mimetype': MIMETYPES.spreadsheet,
    },
    settings ? tag('office:settings', {}, settings) : null,
    tag('office:automatic-styles', {}, automatic, layouts),
    masters,
    tag('office:body', {}, tag('office:spreadsheet', {}, tables)));
    return { text: xmlDocument(root), losses };
  }

  const content = tag('office:document-content', { ...ROOT_NAMESPACES, 'office:version': ODF_VERSION },
    tag('office:automatic-styles', {}, automatic),
    tag('office:body', {}, tag('office:spreadsheet', {}, tables)));
  const files = [{ name: 'content.xml', data: xmlDocument(content), mediaType: 'text/xml' }];
  if (masters) {
    files.push({
      name: 'styles.xml',
      data: xmlDocument(tag('office:document-styles', { ...ROOT_NAMESPACES, 'office:version': ODF_VERSION },
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

function writeTable(sheet, gridStyles, writer) {
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

  const columns = [];
  const widthMap = new Map(widths);
  const widthOf = (c) => widthMap.get(c) ?? DEFAULT_WIDTH;
  for (let c = 0; c <= Math.max(maxCol, 0);) {
    const width = widthOf(c);
    let run = 1;
    while (c + run <= maxCol && widthOf(c + run) === width && !colBreaks.has(c + run)) run += 1;
    columns.push(tag('table:table-column', {
      'table:style-name': columnStyle(width, colBreaks.has(c), writer),
      'table:number-columns-repeated': run > 1 ? String(run) : null,
    }));
    c += run;
  }

  const marked = (r) => heights.has(r) || rowBreaks.has(r) || (header && (r === header.top || r === header.bottom + 1));
  const rows = [];
  for (let r = 0; r <= maxRow;) {
    const rowCells = [];
    for (let c = 0; c <= maxCol; c += 1) {
      const found = cells.get(`${r},${c}`);
      if (found) rowCells[c] = found.cell;
    }
    const style = heights.has(r) || rowBreaks.has(r) ? rowStyle(heights.get(r) ?? null, rowBreaks.has(r), writer) : null;
    if (rowCells.length === 0) {
      let run = 1;
      while (r + run <= maxRow && !marked(r + run) && !hasRow(cells, r + run, maxCol)) run += 1;
      rows.push({ at: r, element: tag('table:table-row', {
        'table:style-name': style, 'table:number-rows-repeated': run > 1 ? String(run) : null,
      }, tag('table:table-cell', {})) });
      r += run;
      continue;
    }
    const children = [];
    for (let c = 0; c <= maxCol;) {
      const cell = rowCells[c];
      if (!cell) {
        let run = 1;
        while (c + run <= maxCol && !rowCells[c + run]) run += 1;
        children.push(tag('table:table-cell', { 'table:number-columns-repeated': run > 1 ? String(run) : null }));
        c += run;
        continue;
      }
      children.push(writeCell(cell, gridStyles, writer));
      c += 1;
    }
    if (children.length === 0) children.push(tag('table:table-cell', {}));
    rows.push({ at: r, element: tag('table:table-row', { 'table:style-name': style }, children) });
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
    'table:style-name': sheet.print ? tableStyle(print, writer) : null,
    'table:print-ranges': print.area ? odfArea(sheet.name ?? 'Sheet1', print.area) : null,
  }, columns, body);
}

/** A sheet's page, as a table style pointing at a master page of its own kind. */
function tableStyle(print, writer) {
  const key = JSON.stringify([print.size, print.width, print.height, print.orientation, print.margin, print.fitWidth, print.gridlines, print.labels]);
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
        tag('style:header', {}, centred(tag('text:sheet-name', {}, '???'))),
        tag('style:footer', {}, centred('Page ', tag('text:page-number', {}, '1'), ' of ', tag('text:page-count', {}, '1'))),
      ] : null);
    const style = tag('style:style', { 'style:name': `ta${n}`, 'style:family': 'table', 'style:master-page-name': `GRT_Page_${n}` },
      tag('style:table-properties', { 'table:display': 'true', 'style:writing-mode': 'lr-tb' }));
    writer.pages.set(key, { style, layout, master });
  }
  return writer.pages.get(key).style.attrs['style:name'];
}

/** A column width or row height in pixels, as Grid keeps it ({w} or {h}) or as a bare number. */
function sizeOf(value, key) {
  const px = typeof value === 'number' ? value : value?.[key];
  return Number.isFinite(px) ? px : 0;
}

function hasRow(cells, row, maxCol) {
  for (let c = 0; c <= maxCol; c += 1) if (cells.has(`${row},${c}`)) return true;
  return false;
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
  const attrs = { 'table:style-name': style ? cellStyle(cell.s, style, writer) : null };
  if (cell.f) attrs['table:formula'] = toOpenFormula(cell.f);
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
  const paragraphs = shown === null ? [] : String(shown).split('\n').map((line) => tag('text:p', {}, odfText(line)));
  return tag('table:table-cell', attrs, paragraphs);
}

function isoDate(serial) {
  const ms = Math.round(serial * DAY) + Date.UTC(1899, 11, 30);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19);
}

function isoDuration(fraction) {
  const total = Math.round(Math.abs(fraction) * 86400);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return `${fraction < 0 ? '-' : ''}PT${String(h).padStart(2, '0')}H${String(m).padStart(2, '0')}M${String(s).padStart(2, '0')}S`;
}

function cellStyle(name, style, writer) {
  if (writer.cellStyles.has(name)) return writer.cellStyles.get(name).name;
  const styleName = `ce${writer.cellStyles.size + 1}`;
  const data = style.format ? dataStyle(style.format, writer) : null;
  const text = {};
  if (style.bold) Object.assign(text, { 'fo:font-weight': 'bold', 'style:font-weight-asian': 'bold', 'style:font-weight-complex': 'bold' });
  if (style.italic) Object.assign(text, { 'fo:font-style': 'italic', 'style:font-style-asian': 'italic', 'style:font-style-complex': 'italic' });
  if (style.color) text['fo:color'] = style.color;
  const align = { left: 'start', center: 'center', right: 'end' }[style.align];
  const element = tag('style:style', {
    'style:name': styleName, 'style:family': 'table-cell', 'style:data-style-name': data,
  },
  style.bg ? tag('style:table-cell-properties', { 'fo:background-color': style.bg }) : null,
  align ? tag('style:paragraph-properties', { 'fo:text-align': align }) : null,
  Object.keys(text).length ? tag('style:text-properties', text) : null);
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
