/** Excel workbooks to and from Grid's document. */

import { NS, kids, kid, is, tag, xmlDocument } from '../xml.js';
import { Losses } from '../losses.js';
import { relationships, mainPart, readPart, relIs, relsXml, contentTypesXml, REL } from './ooxml.js';
import {
  fromExcelFormula, toExcelFormula, shiftFormula, parseCell, columnLetters,
} from './formulas.js';
import {
  SHEET_PRINT_DEFAULTS, sheetPrint, paperOf, paperFields, paperFromExcel, excelPaperCode,
  parseSheetRange, splitOutsideQuotes, excelArea, excelRows,
} from './sheet-print.js';

const S = NS.s;
const MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const DEFAULT_WIDTH = 96;
const DEFAULT_HEIGHT = 24;
const PX_PER_PT = 96 / 72;
/** Days between the 1904 date system's zero and the 1900 one's. */
const DAYS_1904 = 1462;

/** The formats Excel numbers instead of writing out. */
const BUILT_IN = {
  0: null, 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  12: '0.00', 13: '0.00', 14: 'dd/mm/yyyy', 15: 'd mmm yy', 16: 'd mmm', 17: 'mmm yy', 18: 'h:mm',
  19: 'h:mm:ss', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm', 37: '#,##0;(#,##0)',
  38: '#,##0;(#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;(#,##0.00)', 45: 'mm:ss',
  46: 'h:mm:ss', 47: 'mm:ss', 48: '0.0E+0', 49: null,
};

/** The legacy palette, for colours given by index. */
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000',
  '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF',
  '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000',
  '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966',
  '003300', '333300', '993300', '993366', '333399', '333333'];

// Reading

/**
 * @param {import('../package.js').Package} pkg
 * @returns {{document: object, losses: Losses}}
 */
export function readXlsx(pkg) {
  const main = mainPart(pkg);
  const workbook = main ? readPart(pkg, main, 'the workbook') : null;
  if (!workbook || !is(workbook.documentElement, S, 'workbook')) {
    throw new Error('This is not an Excel workbook');
  }
  const losses = new Losses();
  if (pkg.damage) losses.add('The file was damaged, and only what could still be read was opened');
  const rels = relationships(pkg, main);
  const partOf = (type) => [...rels.values()].find((rel) => relIs(rel.type, type))?.target ?? null;

  const date1904 = ['1', 'true'].includes(kid(workbook.documentElement, S, 'workbookPr')?.getAttribute('date1904'));
  const strings = readStrings(pkg, partOf('sharedStrings'));
  const theme = readTheme(pkg, partOf('theme'));
  const styles = readStyles(pkg, partOf('styles'), theme);
  const reader = { losses, strings, styles, date1904, gridStyles: new Map(), styleNames: new Map() };

  // Print areas and rows to repeat are names Excel keeps for itself, one per sheet.
  const printNames = new Map();
  for (const name of kids(kid(workbook.documentElement, S, 'definedNames'), S, 'definedName')) {
    const which = name.getAttribute('name') ?? '';
    const sheetIndex = Number(name.getAttribute('localSheetId'));
    if (/^_xlnm\.(Print_Area|Print_Titles)$/i.test(which) && Number.isInteger(sheetIndex)) {
      if (!printNames.has(sheetIndex)) printNames.set(sheetIndex, []);
      printNames.get(sheetIndex).push({ which: which.slice(6).toLowerCase(), text: name.textContent });
    } else if (!/^_xlnm\._FilterDatabase$/i.test(which)) {
      losses.add('Named ranges, which formulas using them cannot find');
    }
  }
  if (kid(workbook.documentElement, S, 'externalReferences')) losses.add('References to other files');
  if (pkg.names.some((name) => /^xl\/vbaProject\.bin$/i.test(name))) losses.add('Macros, which GRT never runs');
  if (pkg.names.some((name) => /^xl\/pivotTables\//i.test(name))) losses.add('Pivot tables, kept as their last results');

  const sheets = [];
  for (const [sheetIndex, sheet] of kids(kid(workbook.documentElement, S, 'sheets'), S, 'sheet').entries()) {
    const rel = rels.get(sheet.getAttributeNS(NS.r, 'id'));
    if (!rel || !relIs(rel.type, 'worksheet')) {
      losses.add('Chart sheets and dialog sheets');
      continue;
    }
    if (['hidden', 'veryHidden'].includes(sheet.getAttribute('state'))) losses.add('Hidden sheets, shown');
    const doc = readPart(pkg, rel.target, `the sheet ${sheet.getAttribute('name')}`);
    if (!doc) continue;
    const read = readSheet(sheet.getAttribute('name') ?? `Sheet${sheets.length + 1}`, doc, reader);
    read.print = readPrint(doc.documentElement, printNames.get(sheetIndex) ?? [], losses);
    sheets.push(read);
  }
  if (sheets.length === 0) throw new Error('This workbook has no sheets GRT can read');

  return {
    document: { version: 1, type: 'grid', sheets, styles: Object.fromEntries(reader.gridStyles), charts: [] },
    losses,
  };
}

function readStrings(pkg, part) {
  const doc = part ? readPart(pkg, part) : null;
  return kids(doc?.documentElement, S, 'si').map(richText);
}

/** The text of a string item, its phonetic guides left out. */
function richText(element) {
  let out = '';
  for (const child of kids(element)) {
    if (is(child, S, 't')) out += child.textContent;
    else if (is(child, S, 'r')) out += kids(child, S, 't').map((t) => t.textContent).join('');
  }
  return out.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function readTheme(pkg, part) {
  const doc = part ? readPart(pkg, part) : null;
  const scheme = doc?.getElementsByTagNameNS(NS.a, 'clrScheme')[0];
  const color = (name) => {
    const element = kid(scheme, NS.a, name);
    const value = kid(element, NS.a, 'srgbClr')?.getAttribute('val') ?? kid(element, NS.a, 'sysClr')?.getAttribute('lastClr');
    return value ?? null;
  };
  // Excel's theme indexes put the light colours first.
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(color);
}

function colorOf(element, theme) {
  if (!element) return null;
  let hex = null;
  const rgb = element.getAttribute('rgb');
  if (rgb) hex = rgb.slice(-6);
  else if (element.hasAttribute('theme')) hex = theme[Number(element.getAttribute('theme'))];
  else if (element.hasAttribute('indexed')) hex = INDEXED[Number(element.getAttribute('indexed'))] ?? null;
  if (!hex) return null;
  const tint = Number(element.getAttribute('tint') ?? 0);
  return `#${(tint ? tinted(hex, tint) : hex).toLowerCase()}`;
}

/** A colour lightened or darkened the way Excel's tint does it. */
function tinted(hex, tint) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const [nr, ng, nb] = s === 0 ? [l, l, l] : [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  return [nr, ng, nb].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function readStyles(pkg, part, theme) {
  const doc = part ? readPart(pkg, part) : null;
  const root = doc?.documentElement;
  const formats = new Map(kids(kid(root, S, 'numFmts'), S, 'numFmt').map((f) => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode')]));
  const fonts = kids(kid(root, S, 'fonts'), S, 'font').map((font) => ({
    bold: toggle(kid(font, S, 'b')),
    italic: toggle(kid(font, S, 'i')),
    color: colorOf(kid(font, S, 'color'), theme),
  }));
  const fills = kids(kid(root, S, 'fills'), S, 'fill').map((fill) => {
    const pattern = kid(fill, S, 'patternFill');
    if (!pattern || pattern.getAttribute('patternType') !== 'solid') return null;
    return colorOf(kid(pattern, S, 'fgColor'), theme);
  });
  const xfs = kids(kid(root, S, 'cellXfs'), S, 'xf').map((xf) => {
    const id = Number(xf.getAttribute('numFmtId') ?? 0);
    return {
      format: formats.get(id) ?? BUILT_IN[id] ?? null,
      font: fonts[Number(xf.getAttribute('fontId') ?? 0)] ?? {},
      fill: fills[Number(xf.getAttribute('fillId') ?? 0)] ?? null,
      align: kid(xf, S, 'alignment')?.getAttribute('horizontal') ?? null,
    };
  });
  return { xfs, defaultFont: fonts[0] ?? {} };
}

function toggle(element) {
  if (!element) return false;
  const value = element.getAttribute('val');
  return value === null || !['0', 'false'].includes(value);
}

function readSheet(name, doc, reader) {
  const { losses } = reader;
  const root = doc.documentElement;
  const cells = {};
  const cols = {};
  const rows = {};
  const shared = new Map();

  for (const col of kids(kid(root, S, 'cols'), S, 'col')) {
    const min = Number(col.getAttribute('min'));
    const max = Math.min(Number(col.getAttribute('max')), min + 1023);
    if (['1', 'true'].includes(col.getAttribute('hidden'))) losses.add('Hidden rows and columns, shown');
    const width = col.getAttribute('width');
    if (width === null) continue;
    const px = Math.round(Number(width) * 7 + 5);
    if (Math.abs(px - DEFAULT_WIDTH) <= 1) continue;
    for (let c = min; c <= max; c += 1) cols[c - 1] = { w: px };
  }

  let nextRow = 0;
  for (const rowElement of kids(kid(root, S, 'sheetData'), S, 'row')) {
    const r = rowElement.hasAttribute('r') ? Number(rowElement.getAttribute('r')) - 1 : nextRow;
    nextRow = r + 1;
    if (['1', 'true'].includes(rowElement.getAttribute('hidden'))) losses.add('Hidden rows and columns, shown');
    const height = rowElement.getAttribute('ht');
    if (height !== null && ['1', 'true'].includes(rowElement.getAttribute('customHeight'))) {
      const px = Math.round(Number(height) * PX_PER_PT);
      if (Math.abs(px - DEFAULT_HEIGHT) > 1) rows[r] = { h: px };
    }
    let nextCol = 0;
    for (const c of kids(rowElement, S, 'c')) {
      const place = c.hasAttribute('r') ? parseCell(c.getAttribute('r')) : { row: r, col: nextCol };
      if (!place) continue;
      nextCol = place.col + 1;
      const cell = readCellElement(c, place, reader, shared);
      if (cell) cells[`${place.row},${place.col}`] = cell;
    }
  }

  if (kid(root, S, 'mergeCells')) losses.add('Merged cells, shown unmerged');
  if (kid(root, S, 'conditionalFormatting')) losses.add('Formatting that depends on a cell’s value');
  if (kid(root, S, 'dataValidations')) losses.add('Rules on what a cell accepts');
  if (kid(root, S, 'autoFilter')) losses.add('Filters on columns');
  if (kid(root, S, 'drawing')) losses.add('Charts and pictures in sheets');
  if (kid(root, S, 'legacyDrawing')) losses.add('Comments on cells');
  if (kid(root, S, 'tableParts')) losses.add('Excel tables, kept as plain cells');

  const pane = dig(root, 'sheetViews', 'sheetView', 'pane');
  let frozen = null;
  if (pane && ['frozen', 'frozenSplit'].includes(pane.getAttribute('state'))) {
    frozen = { rows: Math.round(Number(pane.getAttribute('ySplit') ?? 0)), cols: Math.round(Number(pane.getAttribute('xSplit') ?? 0)) };
  }
  return { name, cells, cols, rows, frozen };
}

/** How a sheet prints: paper, margins, scaling, gridlines, headers, breaks, area and titles. */
function readPrint(root, names, losses) {
  const print = { ...SHEET_PRINT_DEFAULTS, labels: false };
  const setup = kid(root, S, 'pageSetup');
  if (setup) {
    const width = parseFloat(setup.getAttribute('paperWidth') ?? '');
    const height = parseFloat(setup.getAttribute('paperHeight') ?? '');
    const mm = (value, text) => (/in$/.test(text) ? value * 25.4 : /cm$/.test(text) ? value * 10 : value);
    const paper = width > 0 && height > 0
      ? paperFields(mm(width, setup.getAttribute('paperWidth')), mm(height, setup.getAttribute('paperHeight')))
      : paperFromExcel(Number(setup.getAttribute('paperSize') ?? 1));
    if (paper) Object.assign(print, paper);
    else losses.add('A paper size GRT does not know, printed on A4');
    if (setup.getAttribute('orientation') === 'landscape') print.orientation = 'landscape';
  }
  const fitToPage = ['1', 'true'].includes(dig(root, 'sheetPr', 'pageSetUpPr')?.getAttribute('fitToPage'));
  if (fitToPage) {
    const wide = Number(setup?.getAttribute('fitToWidth') ?? 1);
    const tall = Number(setup?.getAttribute('fitToHeight') ?? 1);
    print.fitWidth = wide === 1;
    if (wide > 1 || tall > 0) losses.add('Fitting to a number of pages, printed fitted to the page width');
  } else if (setup && ![0, 100].includes(Number(setup.getAttribute('scale') ?? 100))) {
    losses.add('A print scale, printed at full size');
  }
  if (['1', 'true'].includes(kid(root, S, 'printOptions')?.getAttribute('gridLines'))) print.gridlines = true;
  const margins = kid(root, S, 'pageMargins');
  if (margins?.hasAttribute('left')) print.margin = Math.round(Number(margins.getAttribute('left')) * 254) / 10;

  const headerFooter = kid(root, S, 'headerFooter');
  const texts = ['oddHeader', 'oddFooter'].map((name) => kid(headerFooter, S, name)?.textContent ?? '');
  if (texts.some((text) => text.trim() !== '')) {
    print.labels = true;
    const other = texts.join(' ').replace(/&"[^"]*"|&\d+|&[LCRAPNDTZFG]/gi, ' ').replace(/\b(Page|of)\b/gi, '');
    if (other.trim() !== '') {
      losses.add('Header and footer text, printed as the sheet name and page numbers');
    }
  }

  const breaks = (name) => kids(kid(root, S, name), S, 'brk')
    .filter((brk) => ['1', 'true'].includes(brk.getAttribute('man')))
    .map((brk) => Number(brk.getAttribute('id')))
    .filter((id) => Number.isInteger(id) && id > 0);
  print.rowBreaks = breaks('rowBreaks');
  print.colBreaks = breaks('colBreaks');

  for (const { which, text } of names) {
    const ranges = splitOutsideQuotes(text, ',').map(parseSheetRange).filter(Boolean);
    if (which === 'print_area') {
      const area = ranges.find((range) => range.kind === 'cells');
      if (area) print.area = { top: area.top, left: area.left, bottom: area.bottom, right: area.right };
      if (ranges.length > 1) losses.add('Several print areas, the first kept');
    } else {
      const rows = ranges.find((range) => range.kind === 'rows');
      if (rows) print.repeatRows = { top: rows.top, bottom: rows.bottom };
      if (ranges.some((range) => range.kind === 'cols')) losses.add('Columns repeated on every page, printed once');
    }
  }
  return print;
}

/** The print parts of a worksheet, in the order Excel requires them after the cells. */
function printXml(print) {
  const paper = paperOf(print);
  const code = excelPaperCode(print);
  const inches = (mm) => String(Math.round((mm / 25.4) * 10000) / 10000);
  return [
    print.gridlines ? tag('printOptions', { gridLines: '1' }) : null,
    tag('pageMargins', {
      left: inches(print.margin), right: inches(print.margin), top: inches(print.margin), bottom: inches(print.margin),
      header: inches(print.margin * 0.35), footer: inches(print.margin * 0.35),
    }),
    tag('pageSetup', {
      paperSize: code,
      paperHeight: code ? null : `${paper.long}mm`,
      paperWidth: code ? null : `${paper.short}mm`,
      fitToWidth: print.fitWidth ? '1' : null,
      fitToHeight: print.fitWidth ? '0' : null,
      orientation: paper.landscape ? 'landscape' : 'portrait',
    }),
    print.labels ? tag('headerFooter', {}, tag('oddHeader', {}, '&C&A'), tag('oddFooter', {}, '&CPage &P of &N')) : null,
    print.rowBreaks.length > 0 ? tag('rowBreaks', { count: String(print.rowBreaks.length), manualBreakCount: String(print.rowBreaks.length) },
      print.rowBreaks.map((id) => tag('brk', { id: String(id), max: '16383', man: '1' }))) : null,
    print.colBreaks.length > 0 ? tag('colBreaks', { count: String(print.colBreaks.length), manualBreakCount: String(print.colBreaks.length) },
      print.colBreaks.map((id) => tag('brk', { id: String(id), max: '1048575', man: '1' }))) : null,
  ];
}

function dig(root, ...names) {
  let at = root;
  for (const name of names) {
    at = kid(at, S, name);
    if (!at) return null;
  }
  return at;
}

function readCellElement(c, place, reader, shared) {
  const type = c.getAttribute('t') ?? 'n';
  const v = kid(c, S, 'v')?.textContent ?? null;
  let value = null;
  switch (type) {
    case 's': value = v === null ? null : reader.strings[Number(v)] ?? null; break;
    case 'str': value = v; break;
    case 'inlineStr': value = richText(kid(c, S, 'is') ?? c); break;
    case 'b': value = v === null ? null : v === '1' || v === 'true'; break;
    case 'e': value = v; break;
    case 'd': value = v === null ? null : (Date.parse(v) - Date.UTC(1899, 11, 30)) / 86400000; break;
    default: value = v === null || v === '' ? null : Number(v);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) value = null;

  const out = {};
  const style = gridStyle(Number(c.getAttribute('s') ?? 0), reader);
  if (typeof value === 'number' && reader.date1904 && style && isDate(reader.gridStyles.get(style)?.format)) value += DAYS_1904;
  if (value !== null && value !== '') out.v = value;

  const f = kid(c, S, 'f');
  if (f) {
    const kind = f.getAttribute('t');
    const text = f.textContent;
    if (kind === 'shared') {
      const index = f.getAttribute('si');
      if (text) {
        shared.set(index, { formula: fromExcelFormula(text), row: place.row, col: place.col });
        out.f = fromExcelFormula(text);
      } else if (shared.has(index)) {
        const master = shared.get(index);
        out.f = shiftFormula(master.formula, place.row - master.row, place.col - master.col);
      }
    } else if (kind === 'array') {
      reader.losses.add('Formulas filling several cells at once, kept in their first cell');
      if (text) out.f = fromExcelFormula(text);
    } else if (kind === 'dataTable') {
      reader.losses.add('What-if tables, kept as their values');
    } else if (text) {
      out.f = fromExcelFormula(text);
    }
  }
  if (style) out.s = style;
  return out.v === undefined && out.f === undefined ? null : out;
}

const isDate = (format) => !!format && /[ymdhs]/i.test(format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''))
  && !/[#0?]/.test(format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

function gridStyle(index, reader) {
  if (reader.styleNames.has(index)) return reader.styleNames.get(index);
  const xf = reader.styles.xfs[index];
  let name = null;
  if (xf) {
    const style = {};
    const base = reader.styles.defaultFont;
    if (xf.font.bold && !base.bold) style.bold = true;
    if (xf.font.italic && !base.italic) style.italic = true;
    if (xf.font.color && xf.font.color !== base.color && xf.font.color !== '#000000') style.color = xf.font.color;
    if (xf.fill) style.bg = xf.fill;
    const align = { center: 'center', centerContinuous: 'center', right: 'right', left: 'left' }[xf.align];
    if (align) style.align = align;
    if (xf.format && !/^general$/i.test(xf.format)) {
      if (/AM\/PM|A\/P/i.test(xf.format)) reader.losses.add('Times with AM and PM, shown on 24 hours');
      if (/\[h+\]|\[m+\]|\[s+\]/i.test(xf.format)) reader.losses.add('Times counted past 24 hours, shown within a day');
      style.format = xf.format.replace(/\s*AM\/PM|\s*A\/P/gi, '').replace(/\[(h+|m+|s+)\]/gi, '$1');
    }
    if (Object.keys(style).length > 0) {
      const key = JSON.stringify(style);
      for (const [existing, defined] of reader.gridStyles) if (JSON.stringify(defined) === key) name = existing;
      if (!name) {
        name = `imported-${reader.gridStyles.size + 1}`;
        reader.gridStyles.set(name, style);
      }
    }
  }
  reader.styleNames.set(index, name);
  return name;
}

// Writing

/**
 * @param {object} document Grid's toJSON()
 * @returns {{entries: object[], losses: Losses}}
 */
export function writeXlsx(document) {
  const losses = new Losses();
  const sheets = document.sheets ?? [];
  const gridStyles = document.styles ?? {};
  const strings = new Map();
  const stringIndex = (text) => {
    if (!strings.has(text)) strings.set(text, strings.size);
    return strings.get(text);
  };
  const styles = new StyleTable(gridStyles);

  const sheetXml = sheets.map((sheet) => writeSheet(sheet, styles, stringIndex));
  const workbookRels = [
    ...sheets.map((_, i) => ({ id: `rId${i + 1}`, type: REL.worksheet, target: `worksheets/sheet${i + 1}.xml` })),
    { id: `rId${sheets.length + 1}`, type: REL.styles, target: 'styles.xml' },
    { id: `rId${sheets.length + 2}`, type: REL.sharedStrings, target: 'sharedStrings.xml' },
  ];
  const workbook = xmlDocument(tag('workbook', { xmlns: NS.s, 'xmlns:r': NS.r },
    tag('bookViews', {}, tag('workbookView', { activeTab: '0' })),
    tag('sheets', {}, sheets.map((sheet, i) => tag('sheet', {
      name: safeSheetName(sheet.name ?? `Sheet${i + 1}`), sheetId: String(i + 1), 'r:id': `rId${i + 1}`,
    }))),
    definedNamesXml(sheets),
    tag('calcPr', { calcId: '191029', fullCalcOnLoad: '1' })));

  const sharedStrings = xmlDocument(tag('sst', { xmlns: NS.s, count: String(strings.size), uniqueCount: String(strings.size) },
    [...strings.keys()].map((text) => tag('si', {}, tag('t', /^\s|\s$|\n/.test(text) ? { 'xml:space': 'preserve' } : {}, escapeControls(text))))));

  const overrides = [
    ['xl/workbook.xml', `${MAIN}.sheet.main+xml`],
    ...sheets.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, `${MAIN}.worksheet+xml`]),
    ['xl/styles.xml', `${MAIN}.styles+xml`],
    ['xl/sharedStrings.xml', `${MAIN}.sharedStrings+xml`],
  ];
  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml' }, overrides) },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'xl/workbook.xml' }]) },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml(workbookRels) },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
    { name: 'xl/styles.xml', data: styles.xml() },
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
  ];
  return { entries, losses };
}

/** Print areas and rows to repeat, which Excel keeps as names of its own. */
function definedNamesXml(sheets) {
  const names = [];
  sheets.forEach((sheet, i) => {
    const print = sheetPrint(sheet);
    const name = safeSheetName(sheet.name ?? `Sheet${i + 1}`);
    if (print.area) names.push(tag('definedName', { name: '_xlnm.Print_Area', localSheetId: String(i) }, excelArea(name, print.area)));
    if (print.repeatRows) names.push(tag('definedName', { name: '_xlnm.Print_Titles', localSheetId: String(i) }, excelRows(name, print.repeatRows)));
  });
  return names.length > 0 ? tag('definedNames', {}, names) : null;
}

/** Excel refuses some characters in sheet names and names longer than 31. */
function safeSheetName(name) {
  return String(name).replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
}

/** Control characters as Excel escapes them in text. */
function escapeControls(text) {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`);
}

class StyleTable {
  constructor(gridStyles) {
    this.gridStyles = gridStyles;
    this.formats = new Map();
    this.fonts = [JSON.stringify({})];
    this.fills = ['none', 'gray125'];
    this.xfs = [JSON.stringify({ numFmtId: 0, fontId: 0, fillId: 0 })];
    this.byName = new Map();
  }

  index(name) {
    if (!name || !this.gridStyles[name]) return 0;
    if (this.byName.has(name)) return this.byName.get(name);
    const style = this.gridStyles[name];
    const numFmtId = style.format ? this.format(style.format) : 0;
    const font = JSON.stringify({ bold: !!style.bold, italic: !!style.italic, color: style.color ?? null });
    let fontId = this.fonts.indexOf(font);
    if (fontId === -1 && font !== JSON.stringify({ bold: false, italic: false, color: null })) {
      this.fonts.push(font);
      fontId = this.fonts.length - 1;
    }
    if (fontId === -1) fontId = 0;
    let fillId = 0;
    if (style.bg) {
      fillId = this.fills.indexOf(style.bg);
      if (fillId === -1) {
        this.fills.push(style.bg);
        fillId = this.fills.length - 1;
      }
    }
    const xf = JSON.stringify({ numFmtId, fontId, fillId, align: style.align ?? null });
    let index = this.xfs.indexOf(xf);
    if (index === -1) {
      this.xfs.push(xf);
      index = this.xfs.length - 1;
    }
    this.byName.set(name, index);
    return index;
  }

  format(code) {
    for (const [id, builtIn] of Object.entries(BUILT_IN)) if (builtIn === code && Number(id) < 14) return Number(id);
    if (!this.formats.has(code)) this.formats.set(code, 164 + this.formats.size);
    return this.formats.get(code);
  }

  xml() {
    const fontXml = (json) => {
      const font = JSON.parse(json);
      return tag('font', {},
        font.bold ? tag('b', {}) : null,
        font.italic ? tag('i', {}) : null,
        tag('sz', { val: '11' }),
        font.color ? tag('color', { rgb: `FF${font.color.replace('#', '').toUpperCase()}` }) : null,
        tag('name', { val: 'Liberation Sans' }));
    };
    const fillXml = (fill) => tag('fill', {}, fill === 'none' || fill === 'gray125'
      ? tag('patternFill', { patternType: fill })
      : tag('patternFill', { patternType: 'solid' },
        tag('fgColor', { rgb: `FF${fill.replace('#', '').toUpperCase()}` }), tag('bgColor', { indexed: '64' })));
    return xmlDocument(tag('styleSheet', { xmlns: NS.s },
      this.formats.size ? tag('numFmts', { count: String(this.formats.size) },
        [...this.formats].map(([code, id]) => tag('numFmt', { numFmtId: String(id), formatCode: code }))) : null,
      tag('fonts', { count: String(this.fonts.length) }, this.fonts.map(fontXml)),
      tag('fills', { count: String(this.fills.length) }, this.fills.map(fillXml)),
      tag('borders', { count: '1' }, tag('border', {}, tag('left', {}), tag('right', {}), tag('top', {}), tag('bottom', {}), tag('diagonal', {}))),
      tag('cellStyleXfs', { count: '1' }, tag('xf', { numFmtId: '0', fontId: '0', fillId: '0', borderId: '0' })),
      tag('cellXfs', { count: String(this.xfs.length) }, this.xfs.map((json) => {
        const xf = JSON.parse(json);
        return tag('xf', {
          numFmtId: String(xf.numFmtId), fontId: String(xf.fontId), fillId: String(xf.fillId), borderId: '0', xfId: '0',
          applyNumberFormat: xf.numFmtId ? '1' : null, applyFont: xf.fontId ? '1' : null,
          applyFill: xf.fillId ? '1' : null, applyAlignment: xf.align ? '1' : null,
        }, xf.align ? tag('alignment', { horizontal: xf.align }) : null);
      })),
      tag('cellStyles', { count: '1' }, tag('cellStyle', { name: 'Normal', xfId: '0', builtinId: '0' }))));
  }
}

function writeSheet(sheet, styles, stringIndex) {
  const byRow = new Map();
  for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
    const [row, col] = key.split(',').map(Number);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push({ col, cell });
  }
  const heights = new Map(Object.entries(sheet.rows ?? {}).map(([r, h]) => [Number(r), sizeOf(h, 'h')]).filter(([, h]) => h > 0));
  for (const r of heights.keys()) if (!byRow.has(r)) byRow.set(r, []);

  const rows = [...byRow.keys()].sort((a, b) => a - b).map((r) => {
    const height = heights.get(r);
    const cells = byRow.get(r).sort((a, b) => a.col - b.col).map(({ col, cell }) => cellXml(r, col, cell, styles, stringIndex));
    return tag('row', {
      r: String(r + 1), ht: height ? String(Math.round((height / PX_PER_PT) * 100) / 100) : null, customHeight: height ? '1' : null,
    }, cells);
  });

  const widths = Object.entries(sheet.cols ?? {}).map(([c, w]) => [Number(c), sizeOf(w, 'w')])
    .filter(([, px]) => px > 0).sort((a, b) => a[0] - b[0]);
  const frozen = sheet.frozen && (sheet.frozen.rows > 0 || sheet.frozen.cols > 0) ? sheet.frozen : null;
  const print = sheetPrint(sheet);
  return xmlDocument(tag('worksheet', { xmlns: NS.s, 'xmlns:r': NS.r },
    print.fitWidth ? tag('sheetPr', {}, tag('pageSetUpPr', { fitToPage: '1' })) : null,
    tag('sheetViews', {}, tag('sheetView', { workbookViewId: '0' }, frozen ? tag('pane', {
      xSplit: frozen.cols > 0 ? String(frozen.cols) : null,
      ySplit: frozen.rows > 0 ? String(frozen.rows) : null,
      topLeftCell: `${columnLetters(frozen.cols)}${frozen.rows + 1}`,
      activePane: frozen.rows > 0 && frozen.cols > 0 ? 'bottomRight' : frozen.rows > 0 ? 'bottomLeft' : 'topRight',
      state: 'frozen',
    }) : null)),
    tag('sheetFormatPr', { defaultRowHeight: '15' }),
    widths.length ? tag('cols', {}, widths.map(([c, px]) => tag('col', {
      min: String(c + 1), max: String(c + 1), width: String(Math.round(((px - 5) / 7) * 100) / 100), customWidth: '1',
    }))) : null,
    tag('sheetData', {}, rows),
    printXml(print)));
}

/** A column width or row height in pixels, as Grid keeps it ({w} or {h}) or as a bare number. */
function sizeOf(value, key) {
  const px = typeof value === 'number' ? value : value?.[key];
  return Number.isFinite(px) ? px : 0;
}

function cellXml(row, col, cell, styles, stringIndex) {
  const ref = `${columnLetters(col)}${row + 1}`;
  const s = styles.index(cell.s);
  const attrs = { r: ref, s: s ? String(s) : null, t: null };
  const children = [];
  if (cell.f) children.push(tag('f', {}, toExcelFormula(cell.f)));
  const value = cell.v;
  if (typeof value === 'number' && Number.isFinite(value)) {
    children.push(tag('v', {}, String(value)));
  } else if (typeof value === 'boolean') {
    attrs.t = 'b';
    children.push(tag('v', {}, value ? '1' : '0'));
  } else if (typeof value === 'string') {
    if (/^#(DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!|NULL!)$/.test(value)) {
      attrs.t = 'e';
      children.push(tag('v', {}, value));
    } else if (cell.f) {
      attrs.t = 'str';
      children.push(tag('v', {}, escapeControls(value)));
    } else {
      attrs.t = 's';
      children.push(tag('v', {}, String(stringIndex(value))));
    }
  }
  return tag('c', attrs, children);
}
