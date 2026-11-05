/** Excel workbooks to and from Grid's document. */

import { NS, kids, kid, is, tag, xmlDocument } from '../xml.js';
import { Losses } from '../losses.js';
import { relationships, mainPart, readPart, relIs, relsXml, contentTypesXml, REL } from './ooxml.js';
import {
  fromExcelFormula, toExcelFormula, shiftFormula, parseCell, columnLetters,
} from './formulas.js';
import {
  SHEET_PRINT_DEFAULTS, sheetPrint, paperOf, paperFields, paperFromExcel, excelPaperCode,
  parseSheetRange, splitOutsideQuotes, excelArea, excelRows, fromExcelBand,
} from './sheet-print.js';
import { declareExternal } from './external.js';
import { clearSpilled } from './spills.js';
import { readXlsxPivots, writeXlsxPivots, REL_PIVOT_CACHE } from './xlsx-pivots.js';
import { readXlsxCharts, writeXlsxCharts, REL_DRAWING } from './xlsx-charts.js';
import { cleanLook, withoutDefaults, sameLook, borderFromXlsx, borderToXlsx, SIDES } from './cell-look.js';

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
  declareExternal(pkg, losses);
  const rels = relationships(pkg, main);
  const partOf = (type) => [...rels.values()].find((rel) => relIs(rel.type, type))?.target ?? null;

  const date1904 = ['1', 'true'].includes(kid(workbook.documentElement, S, 'workbookPr')?.getAttribute('date1904'));
  const strings = readStrings(pkg, partOf('sharedStrings'));
  const theme = readTheme(pkg, partOf('theme'));
  const styles = readStyles(pkg, partOf('styles'), theme);
  const reader = { losses, strings, styles, date1904, gridStyles: new Map(), styleNames: new Map() };

  // Print areas and rows to repeat are names Excel keeps for itself, one per sheet.
  const printNames = new Map();
  const names = {};
  for (const name of kids(kid(workbook.documentElement, S, 'definedNames'), S, 'definedName')) {
    const which = name.getAttribute('name') ?? '';
    const sheetIndex = Number(name.getAttribute('localSheetId'));
    if (/^_xlnm\.(Print_Area|Print_Titles)$/i.test(which) && Number.isInteger(sheetIndex)) {
      if (!printNames.has(sheetIndex)) printNames.set(sheetIndex, []);
      printNames.get(sheetIndex).push({ which: which.slice(6).toLowerCase(), text: name.textContent });
    } else if (/^_xlnm\./i.test(which)) {
      // Excel's own names, such as the filter's range, are worked out again.
    } else if (name.hasAttribute('localSheetId')) {
      losses.add('Names that belong to one sheet, kept for the whole document');
      names[which.toUpperCase()] = fromExcelFormula(name.textContent);
    } else names[which.toUpperCase()] = fromExcelFormula(name.textContent);
  }
  if (kid(workbook.documentElement, S, 'externalReferences')) losses.add('References to other files');
  // Caches a pivot table names by id when its own relationship to one is missing.
  const pivotCaches = new Map();
  for (const cache of kids(kid(workbook.documentElement, S, 'pivotCaches'), S, 'pivotCache')) {
    const target = rels.get(cache.getAttributeNS(NS.r, 'id'));
    const doc = target && !target.external ? readPart(pkg, target.target, 'a pivot cache') : null;
    if (doc) pivotCaches.set(cache.getAttribute('cacheId'), doc);
  }

  const sheets = [];
  const charts = [];
  for (const [sheetIndex, sheet] of kids(kid(workbook.documentElement, S, 'sheets'), S, 'sheet').entries()) {
    const rel = rels.get(sheet.getAttributeNS(NS.r, 'id'));
    if (!rel || !relIs(rel.type, 'worksheet')) {
      losses.add('Chart sheets and dialog sheets');
      continue;
    }
    const doc = readPart(pkg, rel.target, `the sheet ${sheet.getAttribute('name')}`);
    if (!doc) continue;
    const read = readSheet(sheet.getAttribute('name') ?? `Sheet${sheets.length + 1}`, doc, reader);
    read.print = readPrint(doc.documentElement, printNames.get(sheetIndex) ?? [], losses);
    if (['hidden', 'veryHidden'].includes(sheet.getAttribute('state'))) read.hidden = true;
    const tab = dig(doc.documentElement, 'sheetPr', 'tabColor')?.getAttribute('rgb') ?? '';
    if (/^[0-9a-f]{8}$/i.test(tab)) read.tab = `#${tab.slice(2).toLowerCase()}`;
    readXlsxPivots(pkg, rel.target, read, losses, pivotCaches);
    charts.push(...readXlsxCharts(pkg, rel.target, doc.documentElement, read, sheets.length, losses)
      .map((chart, i) => ({ id: `chart-${charts.length + i + 1}`, ...chart })));
    sheets.push(read);
  }
  if (sheets.length === 0) throw new Error('This workbook has no sheets GRT can read');

  return {
    document: { version: 1, type: 'grid', sheets, styles: Object.fromEntries(reader.gridStyles), charts, ...(Object.keys(names).length ? { names } : {}) },
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
    underline: !!kid(font, S, 'u') && kid(font, S, 'u').getAttribute('val') !== 'none',
    strike: toggle(kid(font, S, 'strike')),
    color: colorOf(kid(font, S, 'color'), theme),
    size: Number(kid(font, S, 'sz')?.getAttribute('val')) || null,
    font: kid(font, S, 'name')?.getAttribute('val') ?? null,
  }));
  const fills = kids(kid(root, S, 'fills'), S, 'fill').map((fill) => {
    const pattern = kid(fill, S, 'patternFill');
    if (!pattern || pattern.getAttribute('patternType') !== 'solid') return null;
    return colorOf(kid(pattern, S, 'fgColor'), theme);
  });
  const borders = kids(kid(root, S, 'borders'), S, 'border').map((border) => {
    const out = {};
    for (const side of SIDES) {
      const element = kid(border, S, side) ?? kid(border, S, { left: 'start', right: 'end' }[side] ?? side);
      const found = element ? borderFromXlsx(element.getAttribute('style'), colorOf(kid(element, S, 'color'), theme)) : null;
      if (found) out[side] = found;
    }
    return out;
  });
  const xfLook = (xf) => {
    const id = Number(xf.getAttribute('numFmtId') ?? 0);
    const alignment = kid(xf, S, 'alignment');
    return {
      format: formats.get(id) ?? BUILT_IN[id] ?? null,
      font: fonts[Number(xf.getAttribute('fontId') ?? 0)] ?? {},
      fill: fills[Number(xf.getAttribute('fillId') ?? 0)] ?? null,
      borders: borders[Number(xf.getAttribute('borderId') ?? 0)] ?? {},
      align: alignment?.getAttribute('horizontal') ?? null,
      valign: alignment?.getAttribute('vertical') ?? null,
      wrap: alignment?.getAttribute('wrapText') === '1' || alignment?.getAttribute('wrapText') === 'true',
      indent: Number(alignment?.getAttribute('indent') ?? 0),
      rotate: Number(alignment?.getAttribute('textRotation') ?? 0),
    };
  };
  const named = new Map(kids(kid(root, S, 'cellStyles'), S, 'cellStyle')
    .filter((c) => c.getAttribute('builtinId') !== '0')
    .map((c) => [Number(c.getAttribute('xfId')), c.getAttribute('name')]));
  const styleXfs = kids(kid(root, S, 'cellStyleXfs'), S, 'xf').map(xfLook);
  const xfs = kids(kid(root, S, 'cellXfs'), S, 'xf').map((xf) => {
    const parent = Number(xf.getAttribute('xfId') ?? 0);
    return { ...xfLook(xf), parent: named.has(parent) ? { name: named.get(parent), look: styleXfs[parent] } : null };
  });
  // The looks conditional formats give, which Excel keeps apart from the cells' own.
  const dxfs = kids(kid(root, S, 'dxfs'), S, 'dxf').map((dxf) => {
    const look = {};
    const font = kid(dxf, S, 'font');
    if (font) {
      if (kid(font, S, 'b') && toggle(kid(font, S, 'b'))) look.bold = true;
      if (kid(font, S, 'i') && toggle(kid(font, S, 'i'))) look.italic = true;
      if (kid(font, S, 'u')) look.underline = true;
      if (kid(font, S, 'strike') && toggle(kid(font, S, 'strike'))) look.strike = true;
      const color = colorOf(kid(font, S, 'color'), theme);
      if (color) look.color = color;
    }
    const pattern = kid(kid(dxf, S, 'fill'), S, 'patternFill');
    const bg = colorOf(kid(pattern, S, 'bgColor'), theme) ?? colorOf(kid(pattern, S, 'fgColor'), theme);
    if (bg) look.bg = bg;
    return look;
  });
  return { xfs, defaultFont: fonts[0] ?? {}, dxfs, theme };
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
    if (['1', 'true'].includes(col.getAttribute('hidden'))) {
      for (let c = min; c <= max; c += 1) cols[c - 1] = { ...(cols[c - 1] ?? {}), hidden: true };
    }
    const width = col.getAttribute('width');
    if (width === null) continue;
    const px = Math.round(Number(width) * 7 + 5);
    if (Math.abs(px - DEFAULT_WIDTH) <= 1) continue;
    for (let c = min; c <= max; c += 1) cols[c - 1] = { ...(cols[c - 1] ?? {}), w: px };
  }

  const filter = readAutoFilter(kid(root, S, 'autoFilter'), losses);
  let nextRow = 0;
  for (const rowElement of kids(kid(root, S, 'sheetData'), S, 'row')) {
    const r = rowElement.hasAttribute('r') ? Number(rowElement.getAttribute('r')) - 1 : nextRow;
    nextRow = r + 1;
    // A row the filter hid comes back when the filter runs again; only rows hidden by hand are kept.
    const byFilter = filter && r > filter.area.top && r <= filter.area.bottom;
    if (['1', 'true'].includes(rowElement.getAttribute('hidden')) && !byFilter) rows[r] = { ...(rows[r] ?? {}), hidden: true };
    const height = rowElement.getAttribute('ht');
    if (height !== null && ['1', 'true'].includes(rowElement.getAttribute('customHeight'))) {
      const px = Math.round(Number(height) * PX_PER_PT);
      if (Math.abs(px - DEFAULT_HEIGHT) > 1) rows[r] = { ...(rows[r] ?? {}), h: px };
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

  clearSpilled(cells);
  const conditions = readConditions(root, reader);
  const validations = readValidations(root, losses);
  const merges = [];
  for (const merge of kids(kid(root, S, 'mergeCells'), S, 'mergeCell')) {
    const area = readArea(merge.getAttribute('ref'));
    if (area) merges.push(area);
  }
  if (kid(root, S, 'legacyDrawing')) losses.add('Comments on cells');
  if (kid(root, S, 'tableParts')) losses.add('Excel tables, kept as plain cells');

  const pane = dig(root, 'sheetViews', 'sheetView', 'pane');
  let frozen = null;
  if (pane && ['frozen', 'frozenSplit'].includes(pane.getAttribute('state'))) {
    frozen = { rows: Math.round(Number(pane.getAttribute('ySplit') ?? 0)), cols: Math.round(Number(pane.getAttribute('xSplit') ?? 0)) };
  }
  return {
    name, cells, cols, rows, frozen, ...(merges.length ? { merges } : {}), ...(filter ? { filter } : {}),
    ...(conditions.length ? { conditions } : {}), ...(validations.length ? { validations } : {}),
  };
}

const CELL_OPS = {
  equal: '=', notEqual: '<>', lessThan: '<', lessThanOrEqual: '<=', greaterThan: '>', greaterThanOrEqual: '>=',
  between: 'between', notBetween: 'not-between',
};
const CELL_OPS_BACK = Object.fromEntries(Object.entries(CELL_OPS).map(([k, v]) => [v, k]));

/** Every range of a space-separated list, as blocks. */
const areasOf = (sqref) => String(sqref ?? '').trim().split(/\s+/).map(readArea).filter(Boolean);

/** A colour scale's or data bar's point. */
function readPoint(cfvo) {
  const type = cfvo.getAttribute('type');
  const value = cfvo.getAttribute('val');
  return { type: { num: 'number', min: 'min', max: 'max', percent: 'percent', percentile: 'percentile' }[type] ?? 'min', ...(value !== null ? { value } : {}) };
}

/** Conditional formats, by priority, one rule per block they cover. */
function readConditions(root, reader) {
  const found = [];
  for (const format of kids(root, S, 'conditionalFormatting')) {
    const areas = areasOf(format.getAttribute('sqref'));
    for (const cfRule of kids(format, S, 'cfRule')) {
      const type = cfRule.getAttribute('type');
      const formulas = kids(cfRule, S, 'formula').map((f) => fromExcelFormula(f.textContent));
      const style = reader.styles.dxfs?.[Number(cfRule.getAttribute('dxfId'))] ?? {};
      let rule = null;
      switch (type) {
        case 'cellIs': rule = { type: 'cell', op: CELL_OPS[cfRule.getAttribute('operator')] ?? '=', values: formulas, style }; break;
        case 'expression': rule = { type: 'formula', formula: formulas[0], style }; break;
        case 'containsText': case 'notContainsText': case 'beginsWith': case 'endsWith': {
          const op = { containsText: 'contains', notContainsText: 'not-contains', beginsWith: 'begins', endsWith: 'ends' }[type];
          rule = { type: 'text', op, value: cfRule.getAttribute('text') ?? '', style };
          break;
        }
        case 'duplicateValues': rule = { type: 'duplicate', style }; break;
        case 'uniqueValues': rule = { type: 'unique', style }; break;
        case 'top10': rule = { type: 'top', count: Number(cfRule.getAttribute('rank') ?? 10), style };
          if (['1', 'true'].includes(cfRule.getAttribute('percent'))) rule.percent = true;
          if (['1', 'true'].includes(cfRule.getAttribute('bottom'))) rule.bottom = true;
          break;
        case 'aboveAverage': rule = { type: 'average', style };
          if (['0', 'false'].includes(cfRule.getAttribute('aboveAverage'))) rule.below = true;
          if (['1', 'true'].includes(cfRule.getAttribute('equalAverage'))) rule.equal = true;
          break;
        case 'containsBlanks': rule = { type: 'blank', style }; break;
        case 'notContainsBlanks': rule = { type: 'blank', op: 'not', style }; break;
        case 'containsErrors': rule = { type: 'error', style }; break;
        case 'notContainsErrors': rule = { type: 'error', op: 'not', style }; break;
        case 'colorScale': {
          const scale = kid(cfRule, S, 'colorScale');
          rule = {
            type: 'scale', points: kids(scale, S, 'cfvo').map(readPoint),
            colors: kids(scale, S, 'color').map((c) => colorOf(c, reader.styles.theme ?? []) ?? '#ffffff'),
          };
          break;
        }
        case 'dataBar': {
          const bar = kid(cfRule, S, 'dataBar');
          rule = { type: 'bar', points: kids(bar, S, 'cfvo').map(readPoint), color: colorOf(kid(bar, S, 'color'), reader.styles.theme ?? []) ?? '#638ec6' };
          break;
        }
        default: reader.losses.add('Icon sets and other conditional formats GRT Grid does not draw, left out');
      }
      if (!rule) continue;
      rule.stop = ['1', 'true'].includes(cfRule.getAttribute('stopIfTrue'));
      const priority = Number(cfRule.getAttribute('priority') ?? found.length + 1);
      for (const area of areas) found.push({ priority, rule: { ...structuredClone(rule), area } });
    }
  }
  return found.sort((a, b) => a.priority - b.priority).map((entry) => entry.rule);
}

const VALIDATION_TYPES = { whole: 'whole', decimal: 'decimal', list: 'list', date: 'date', time: 'time', textLength: 'length', custom: 'custom' };

/** Rules on what cells accept. */
function readValidations(root, losses) {
  const out = [];
  for (const node of kids(kid(root, S, 'dataValidations'), S, 'dataValidation')) {
    const type = VALIDATION_TYPES[node.getAttribute('type') ?? ''];
    if (!type) continue;
    const formulas = kids(node, S, 'formula1').concat(kids(node, S, 'formula2')).map((f) => f.textContent);
    const rule = { type, allowBlank: ['1', 'true'].includes(node.getAttribute('allowBlank')) };
    if (type === 'list') {
      const literal = /^"(.*)"$/s.exec(formulas[0] ?? '');
      if (literal) rule.list = literal[1].split(',');
      else rule.source = fromExcelFormula(formulas[0] ?? '');
      if (['1', 'true'].includes(node.getAttribute('showDropDown'))) rule.dropdown = false;
    } else if (type === 'custom') {
      rule.formula = fromExcelFormula(formulas[0] ?? '');
    } else {
      rule.op = CELL_OPS[node.getAttribute('operator') ?? 'between'] ?? 'between';
      // A second bound is only meant for between; LibreOffice writes one anyway.
      rule.values = formulas.slice(0, rule.op.endsWith('between') ? 2 : 1).map(fromExcelFormula);
    }
    if (['1', 'true'].includes(node.getAttribute('showErrorMessage'))) {
      rule.error = {
        style: { warning: 'warning', information: 'info' }[node.getAttribute('errorStyle')] ?? 'stop',
        title: node.getAttribute('errorTitle') ?? '', message: node.getAttribute('error') ?? '',
      };
    } else rule.error = { style: 'info' };
    if (['1', 'true'].includes(node.getAttribute('showInputMessage'))) {
      rule.input = { title: node.getAttribute('promptTitle') ?? '', message: node.getAttribute('prompt') ?? '' };
    }
    const areas = areasOf(node.getAttribute('sqref'));
    if (areas.length === 0) losses.add('A rule on what cells accept, on cells GRT Grid could not find');
    for (const area of areas) out.push({ ...structuredClone(rule), area });
  }
  return out;
}

/** `A1:D9` to a block, or null. */
function readArea(ref) {
  const [first, second] = String(ref ?? '').split(':');
  const from = parseCell(first);
  const to = parseCell(second ?? first);
  if (!from || !to) return null;
  return { top: Math.min(from.row, to.row), left: Math.min(from.col, to.col), bottom: Math.max(from.row, to.row), right: Math.max(from.col, to.col) };
}

const CUSTOM_OPS = { equal: '=', notEqual: '<>', lessThan: '<', lessThanOrEqual: '<=', greaterThan: '>', greaterThanOrEqual: '>=' };

/** A custom filter's value, its wildcards turned into the operator they stand for. */
function customCondition(operator, value) {
  const op = CUSTOM_OPS[operator] ?? '=';
  const text = String(value ?? '');
  if ((op === '=' || op === '<>') && /^\*.+\*$/.test(text)) return { op: op === '=' ? 'contains' : 'not-contains', value: text.slice(1, -1) };
  if (op === '=' && /^[^*]+\*$/.test(text)) return { op: 'begins', value: text.slice(0, -1) };
  if (op === '=' && /^\*[^*]+$/.test(text)) return { op: 'ends', value: text.slice(1) };
  if (op === '=' && text === '') return { op: 'empty', value: '' };
  if (op === '<>' && text === '') return { op: 'not-empty', value: '' };
  return { op, value: text };
}

/** The autofilter: its range, and by column what each lets through. */
function readAutoFilter(node, losses) {
  if (!node) return null;
  const area = readArea(node.getAttribute('ref'));
  if (!area) return null;
  const columns = {};
  for (const column of kids(node, S, 'filterColumn')) {
    const offset = column.getAttribute('colId') ?? '0';
    const filters = kid(column, S, 'filters');
    const custom = kid(column, S, 'customFilters');
    const top = kid(column, S, 'top10');
    if (filters) {
      const values = kids(filters, S, 'filter').map((f) => f.getAttribute('val') ?? '');
      if (['1', 'true'].includes(filters.getAttribute('blank'))) values.push('');
      if (kids(filters, S, 'dateGroupItem').length) losses.add('Filters on parts of dates, left out');
      columns[offset] = { values };
    } else if (custom) {
      const conditions = kids(custom, S, 'customFilter').map((f) => customCondition(f.getAttribute('operator'), f.getAttribute('val')));
      columns[offset] = { conditions, ...(['1', 'true'].includes(custom.getAttribute('and')) ? {} : { join: 'or' }) };
    } else if (top) {
      columns[offset] = { top: { count: Number(top.getAttribute('val') ?? 10), percent: ['1', 'true'].includes(top.getAttribute('percent')), largest: !['0', 'false'].includes(top.getAttribute('top')) } };
    } else losses.add('A filter GRT Grid does not know, left out');
  }
  return { area, columns };
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
    [print.header, print.footer] = texts.map(fromExcelBand);
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
    print.labels ? tag('headerFooter', {}, tag('oddHeader', {}, `&C${print.header ?? '&A'}`), tag('oddFooter', {}, `&C${print.footer ?? 'Page &P of &N'}`)) : null,
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
      if (text) out.f = fromExcelFormula(text);
      const span = /^([A-Z]+\d+)(?::([A-Z]+\d+))?$/i.exec(f.getAttribute('ref') ?? '');
      const from = span && parseCell(span[1]);
      const to = span && parseCell(span[2] ?? span[1]);
      if (out.f && from && to && (to.row > from.row || to.col > from.col)) out.a = [to.row - from.row + 1, to.col - from.col + 1];
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

/** The display names of Excel's styles that Grid has under names of its own. */
const KNOWN_STYLES = { Heading: 'header', Currency: 'currency', Percent: 'percent', Date: 'date' };

/** An xf record as one of Grid's looks, without what the workbook's first font gives every cell. */
function lookOfXf(xf, reader) {
  const base = reader.styles.defaultFont;
  const look = {
    bold: xf.font.bold && !base.bold, italic: xf.font.italic && !base.italic,
    underline: xf.font.underline, strike: xf.font.strike,
    color: xf.font.color && xf.font.color !== base.color && xf.font.color !== '#000000' ? xf.font.color : null,
    font: xf.font.font !== base.font ? xf.font.font : null,
    size: xf.font.size !== base.size ? xf.font.size : null,
    bg: xf.fill,
    align: { center: 'center', centerContinuous: 'center', right: 'right', left: 'left', justify: 'justify' }[xf.align] ?? null,
    valign: { top: 'top', center: 'middle', bottom: null }[xf.valign] ?? null,
    wrap: xf.wrap, indent: xf.indent,
    rotate: xf.rotate > 90 && xf.rotate <= 180 ? 90 - xf.rotate : xf.rotate === 255 ? 0 : xf.rotate,
    borders: xf.borders,
  };
  if (xf.format && !/^general$/i.test(xf.format)) {
    if (/AM\/PM|A\/P/i.test(xf.format)) reader.losses.add('Times with AM and PM, shown on 24 hours');
    if (/\[h+\]|\[m+\]|\[s+\]/i.test(xf.format)) reader.losses.add('Times counted past 24 hours, shown within a day');
    look.format = xf.format.replace(/\s*AM\/PM|\s*A\/P/gi, '').replace(/\[(h+|m+|s+)\]/gi, '$1');
  }
  return cleanLook(look);
}

function gridStyle(index, reader) {
  if (reader.styleNames.has(index)) return reader.styleNames.get(index);
  const xf = reader.styles.xfs[index];
  let name = null;
  if (xf) {
    const look = lookOfXf(xf, reader);
    let parent = null;
    if (xf.parent) {
      parent = KNOWN_STYLES[xf.parent.name] ?? `named-${xf.parent.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
      if (!reader.gridStyles.has(parent)) reader.gridStyles.set(parent, { ...lookOfXf({ ...xf.parent.look, parent: null }, reader), name: xf.parent.name });
    }
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
  for (const [id, style] of Object.entries(gridStyles)) if (style?.name && style.name !== 'Default') styles.named(id);

  const pivots = writeXlsxPivots(document, losses);
  // Each sheet with charts gets a drawing that anchors them, and a relationship to it.
  const chartParts = [];
  const sheetRels = [];
  let drawings = 0;
  let chartCount = 0;
  const sheetXml = sheets.map((sheet, i) => {
    const own = (document.charts ?? []).filter((chart) => (typeof chart.sheet === 'number' ? chart.sheet : Math.max(0, sheets.findIndex((s) => s.id === chart.sheet))) === i);
    const rels = (pivots.sheetRels.get(i) ?? []).map((rel, k) => ({ ...rel, id: `rId${k + 2}` }));
    let drawing = null;
    if (own.length) {
      drawings += 1;
      const { parts, drawingTarget } = writeXlsxCharts(document, sheet, own, drawings, chartCount + 1);
      chartCount += own.length;
      chartParts.push(...parts);
      rels.unshift({ id: 'rId1', type: REL_DRAWING, target: drawingTarget });
      drawing = tag('drawing', { 'r:id': 'rId1' });
    }
    if (rels.length) sheetRels.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: relsXml(rels) });
    return writeSheet(sheet, styles, stringIndex, drawing);
  });
  const workbookRels = [
    ...sheets.map((_, i) => ({ id: `rId${i + 1}`, type: REL.worksheet, target: `worksheets/sheet${i + 1}.xml` })),
    { id: `rId${sheets.length + 1}`, type: REL.styles, target: 'styles.xml' },
    { id: `rId${sheets.length + 2}`, type: REL.sharedStrings, target: 'sharedStrings.xml' },
    ...pivots.caches.map((cache) => ({ id: `rIdPivot${cache.id}`, type: REL_PIVOT_CACHE, target: cache.target })),
  ];
  const workbook = xmlDocument(tag('workbook', { xmlns: NS.s, 'xmlns:r': NS.r },
    tag('bookViews', {}, tag('workbookView', { activeTab: String(Math.max(0, sheets.findIndex((sheet) => !sheet.hidden))) })),
    tag('sheets', {}, sheets.map((sheet, i) => tag('sheet', {
      name: safeSheetName(sheet.name ?? `Sheet${i + 1}`), sheetId: String(i + 1), state: sheet.hidden ? 'hidden' : null, 'r:id': `rId${i + 1}`,
    }))),
    definedNamesXml(sheets, document.names ?? {}),
    tag('calcPr', { calcId: '191029', fullCalcOnLoad: '1' }),
    pivots.caches.length ? tag('pivotCaches', {}, pivots.caches.map((cache) => tag('pivotCache', { cacheId: String(cache.id), 'r:id': `rIdPivot${cache.id}` }))) : null));

  const sharedStrings = xmlDocument(tag('sst', { xmlns: NS.s, count: String(strings.size), uniqueCount: String(strings.size) },
    [...strings.keys()].map((text) => tag('si', {}, tag('t', /^\s|\s$|\n/.test(text) ? { 'xml:space': 'preserve' } : {}, escapeControls(text))))));

  const overrides = [
    ['xl/workbook.xml', `${MAIN}.sheet.main+xml`],
    ...sheets.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, `${MAIN}.worksheet+xml`]),
    ['xl/styles.xml', `${MAIN}.styles+xml`],
    ['xl/sharedStrings.xml', `${MAIN}.sharedStrings+xml`],
    ...chartParts.filter((part) => part.type).map((part) => [part.name, part.type]),
    ...pivots.parts.map((part) => [part.name, part.type]),
  ];
  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml' }, overrides) },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'xl/workbook.xml' }]) },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml(workbookRels) },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
    { name: 'xl/styles.xml', data: styles.xml() },
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
    ...sheetRels,
    ...chartParts.map((part) => ({ name: part.name, data: part.rels ? relsXml(part.data) : part.data })),
    ...pivots.parts.map((part) => ({ name: part.name, data: part.data })),
    ...pivots.parts.filter((part) => part.rels).map((part) => ({ name: part.name.replace(/([^/]+)$/, '_rels/$1.rels'), data: relsXml(part.rels) })),
  ];
  return { entries, losses };
}

/** Print areas and rows to repeat, which Excel keeps as names of its own, the filters' ranges, and defined names. */
function definedNamesXml(sheets, defined = {}) {
  const names = [];
  for (const [name, text] of Object.entries(defined).sort()) names.push(tag('definedName', { name }, toExcelFormula(text)));
  sheets.forEach((sheet, i) => {
    const print = sheetPrint(sheet);
    const name = safeSheetName(sheet.name ?? `Sheet${i + 1}`);
    if (print.area) names.push(tag('definedName', { name: '_xlnm.Print_Area', localSheetId: String(i) }, excelArea(name, print.area)));
    if (print.repeatRows) names.push(tag('definedName', { name: '_xlnm.Print_Titles', localSheetId: String(i) }, excelRows(name, print.repeatRows)));
    if (sheet.filter) names.push(tag('definedName', { name: '_xlnm._FilterDatabase', localSheetId: String(i), hidden: '1' }, excelArea(name, sheet.filter.area)));
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

const NO_FONT = JSON.stringify({});

class StyleTable {
  constructor(gridStyles) {
    this.gridStyles = gridStyles;
    this.formats = new Map();
    this.fonts = [NO_FONT];
    this.fills = ['none', 'gray125'];
    this.borders = [JSON.stringify({})];
    this.xfs = [JSON.stringify({ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0 })];
    this.styleXfs = [JSON.stringify({ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0 })];
    this.cellStyles = [{ name: 'Normal', xfId: 0, builtinId: '0' }];
    this.namedIds = new Map();
    this.byName = new Map();
    this.dxfs = [];
  }

  /** The index of a conditional format's look among the dxf records. */
  dxf(look) {
    const json = JSON.stringify(look);
    let index = this.dxfs.indexOf(json);
    if (index === -1) {
      this.dxfs.push(json);
      index = this.dxfs.length - 1;
    }
    return index;
  }

  /** The index of a value in one of the tables, added the first time. */
  static slot(list, value) {
    let index = list.indexOf(value);
    if (index === -1) {
      list.push(value);
      index = list.length - 1;
    }
    return index;
  }

  /** The parts of an xf record a look needs. */
  record(style) {
    const font = JSON.stringify(cleanLook({
      bold: style.bold, italic: style.italic, underline: style.underline, strike: style.strike,
      color: style.color, font: style.font, size: style.size,
    }));
    const borders = JSON.stringify(cleanLook({ borders: style.borders }).borders ?? {});
    return {
      numFmtId: style.format ? this.format(style.format) : 0,
      fontId: font === NO_FONT ? 0 : StyleTable.slot(this.fonts, font),
      fillId: style.bg ? StyleTable.slot(this.fills, style.bg) : 0,
      borderId: StyleTable.slot(this.borders, borders),
      align: style.align ?? null, valign: style.valign ?? null, wrap: !!style.wrap, indent: style.indent ?? 0, rotate: style.rotate ?? 0,
    };
  }

  /** The cellStyleXfs index of one of Grid's named styles, written as an Excel cell style. */
  named(id) {
    if (this.namedIds.has(id)) return this.namedIds.get(id);
    const index = StyleTable.slot(this.styleXfs, JSON.stringify(this.record(this.gridStyles[id])));
    this.cellStyles.push({ name: this.gridStyles[id].name ?? id, xfId: index });
    this.namedIds.set(id, index);
    return index;
  }

  index(name) {
    if (!name || !this.gridStyles[name]) return 0;
    if (this.byName.has(name)) return this.byName.get(name);
    const style = this.gridStyles[name];
    const owner = style.name ? name : style.parent && this.gridStyles[style.parent] ? style.parent : null;
    const xf = JSON.stringify({ ...this.record(style), xfId: owner ? this.named(owner) : 0 });
    const index = StyleTable.slot(this.xfs, xf);
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
        font.strike ? tag('strike', {}) : null,
        font.underline ? tag('u', {}) : null,
        tag('sz', { val: String(font.size ?? 11) }),
        font.color ? tag('color', { rgb: argb(font.color) }) : null,
        tag('name', { val: font.font ?? 'Liberation Sans' }));
    };
    const fillXml = (fill) => tag('fill', {}, fill === 'none' || fill === 'gray125'
      ? tag('patternFill', { patternType: fill })
      : tag('patternFill', { patternType: 'solid' }, tag('fgColor', { rgb: argb(fill) }), tag('bgColor', { indexed: '64' })));
    const borderXml = (json) => {
      const borders = JSON.parse(json);
      const side = (name) => {
        const border = borders[name];
        return border ? tag(name, { style: borderToXlsx(border) }, tag('color', { rgb: argb(border.color ?? '#000000') })) : tag(name, {});
      };
      return tag('border', {}, side('left'), side('right'), side('top'), side('bottom'), tag('diagonal', {}));
    };
    const xfXml = (xf, extra = {}) => {
      const aligned = xf.align || xf.valign || xf.wrap || xf.indent || xf.rotate;
      return tag('xf', {
        numFmtId: String(xf.numFmtId), fontId: String(xf.fontId), fillId: String(xf.fillId), borderId: String(xf.borderId ?? 0), ...extra,
        applyNumberFormat: xf.numFmtId ? '1' : null, applyFont: xf.fontId ? '1' : null,
        applyFill: xf.fillId ? '1' : null, applyBorder: xf.borderId ? '1' : null, applyAlignment: aligned ? '1' : null,
      }, aligned ? tag('alignment', {
        horizontal: xf.align ?? null,
        vertical: xf.valign ? { top: 'top', middle: 'center', bottom: 'bottom' }[xf.valign] : null,
        wrapText: xf.wrap ? '1' : null, indent: xf.indent ? String(xf.indent) : null,
        textRotation: xf.rotate ? String(xf.rotate < 0 ? 90 - xf.rotate : xf.rotate) : null,
      }) : null);
    };
    return xmlDocument(tag('styleSheet', { xmlns: NS.s },
      this.formats.size ? tag('numFmts', { count: String(this.formats.size) },
        [...this.formats].map(([code, id]) => tag('numFmt', { numFmtId: String(id), formatCode: code }))) : null,
      tag('fonts', { count: String(this.fonts.length) }, this.fonts.map(fontXml)),
      tag('fills', { count: String(this.fills.length) }, this.fills.map(fillXml)),
      tag('borders', { count: String(this.borders.length) }, this.borders.map(borderXml)),
      tag('cellStyleXfs', { count: String(this.styleXfs.length) }, this.styleXfs.map((json) => xfXml(JSON.parse(json)))),
      tag('cellXfs', { count: String(this.xfs.length) }, this.xfs.map((json) => {
        const xf = JSON.parse(json);
        return xfXml(xf, { xfId: String(xf.xfId ?? 0) });
      })),
      tag('cellStyles', { count: String(this.cellStyles.length) }, this.cellStyles.map((c) => tag('cellStyle', {
        name: c.name, xfId: String(c.xfId), builtinId: c.builtinId ?? null, customBuiltin: null,
      }))),
      this.dxfs.length ? tag('dxfs', { count: String(this.dxfs.length) }, this.dxfs.map((json) => {
        const look = JSON.parse(json);
        const font = look.bold || look.italic || look.underline || look.strike || look.color;
        return tag('dxf', {},
          font ? tag('font', {}, look.bold ? tag('b', {}) : null, look.italic ? tag('i', {}) : null,
            look.strike ? tag('strike', {}) : null, look.underline ? tag('u', {}) : null,
            look.color ? tag('color', { rgb: `FF${look.color.replace('#', '').toUpperCase()}` }) : null) : null,
          look.bg ? tag('fill', {}, tag('patternFill', {}, tag('bgColor', { rgb: `FF${look.bg.replace('#', '').toUpperCase()}` }))) : null);
      })) : null));
  }
}

function writeSheet(sheet, styles, stringIndex, drawing = null) {
  const byRow = new Map();
  for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
    const [row, col] = key.split(',').map(Number);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push({ col, cell });
  }
  const heights = new Map(Object.entries(sheet.rows ?? {}).map(([r, h]) => [Number(r), sizeOf(h, 'h')]).filter(([, h]) => h > 0));
  for (const r of heights.keys()) if (!byRow.has(r)) byRow.set(r, []);
  // Excel shows a filter's result from the rows marked hidden, so the filtered ones are written hidden too.
  const hiddenRows = new Set([
    ...Object.entries(sheet.rows ?? {}).filter(([, v]) => v?.hidden).map(([r]) => Number(r)),
    ...(sheet.filteredRows ?? []),
  ]);
  for (const r of hiddenRows) if (!byRow.has(r)) byRow.set(r, []);

  const rows = [...byRow.keys()].sort((a, b) => a - b).map((r) => {
    const height = heights.get(r);
    const cells = byRow.get(r).sort((a, b) => a.col - b.col).map(({ col, cell }) => cellXml(r, col, cell, styles, stringIndex));
    return tag('row', {
      r: String(r + 1), ht: height ? String(Math.round((height / PX_PER_PT) * 100) / 100) : null, customHeight: height ? '1' : null,
      hidden: hiddenRows.has(r) ? '1' : null,
    }, cells);
  });

  const hiddenCols = new Set(Object.entries(sheet.cols ?? {}).filter(([, v]) => v?.hidden).map(([c]) => Number(c)));
  const widths = Object.entries(sheet.cols ?? {}).map(([c, w]) => [Number(c), sizeOf(w, 'w')])
    .filter(([c, px]) => px > 0 || hiddenCols.has(c)).sort((a, b) => a[0] - b[0]);
  for (const c of hiddenCols) if (!widths.some(([w]) => w === c)) widths.push([c, 0]);
  widths.sort((a, b) => a[0] - b[0]);
  const frozen = sheet.frozen && (sheet.frozen.rows > 0 || sheet.frozen.cols > 0) ? sheet.frozen : null;
  const print = sheetPrint(sheet);
  return xmlDocument(tag('worksheet', { xmlns: NS.s, 'xmlns:r': NS.r },
    print.fitWidth || /^#[0-9a-f]{6}$/i.test(sheet.tab ?? '') ? tag('sheetPr', {},
      /^#[0-9a-f]{6}$/i.test(sheet.tab ?? '') ? tag('tabColor', { rgb: `FF${sheet.tab.slice(1).toUpperCase()}` }) : null,
      print.fitWidth ? tag('pageSetUpPr', { fitToPage: '1' }) : null) : null,
    tag('sheetViews', {}, tag('sheetView', { workbookViewId: '0' }, frozen ? tag('pane', {
      xSplit: frozen.cols > 0 ? String(frozen.cols) : null,
      ySplit: frozen.rows > 0 ? String(frozen.rows) : null,
      topLeftCell: `${columnLetters(frozen.cols)}${frozen.rows + 1}`,
      activePane: frozen.rows > 0 && frozen.cols > 0 ? 'bottomRight' : frozen.rows > 0 ? 'bottomLeft' : 'topRight',
      state: 'frozen',
    }) : null)),
    tag('sheetFormatPr', { defaultRowHeight: '15' }),
    widths.length ? tag('cols', {}, widths.map(([c, px]) => tag('col', {
      min: String(c + 1), max: String(c + 1), width: String(Math.round(((Math.max(px, DEFAULT_WIDTH) - 5) / 7) * 100) / 100),
      customWidth: px > 0 ? '1' : null, hidden: hiddenCols.has(c) ? '1' : null,
    }))) : null,
    tag('sheetData', {}, rows),
    sheet.filter ? autoFilterXml(sheet.filter) : null,
    sheet.merges?.length ? tag('mergeCells', { count: String(sheet.merges.length) }, sheet.merges.map((m) => tag('mergeCell', { ref: areaRef(m) }))) : null,
    conditionsXml(sheet.conditions ?? [], styles),
    validationsXml(sheet.validations ?? []),
    printXml(print),
    drawing));
}

const pointXml = (point) => tag('cfvo', {
  type: { number: 'num', min: 'min', max: 'max', percent: 'percent', percentile: 'percentile' }[point?.type] ?? 'min',
  val: point?.value !== undefined ? String(point.value) : null,
});
const argb = (hex) => `FF${String(hex).replace('#', '').toUpperCase()}`;
const formulaText = (text) => toExcelFormula(String(text ?? '').startsWith('=') ? text : `=${text}`);

/** One conditional formatting element per rule, in the order the rules are tried. */
function conditionsXml(conditions, styles) {
  return conditions.map((rule, i) => {
    const attrs = { priority: String(i + 1), stopIfTrue: rule.stop === false ? null : '1' };
    const dxf = () => String(styles.dxf(rule.style ?? {}));
    const top = `${columnLetters(rule.area.left)}${rule.area.top + 1}`;
    let content;
    switch (rule.type) {
      case 'cell':
        content = tag('cfRule', { type: 'cellIs', dxfId: dxf(), ...attrs, operator: CELL_OPS_BACK[rule.op] ?? 'equal' },
          (rule.values ?? []).map((v) => tag('formula', {}, formulaText(v))));
        break;
      case 'formula': content = tag('cfRule', { type: 'expression', dxfId: dxf(), ...attrs }, tag('formula', {}, formulaText(rule.formula))); break;
      case 'text': {
        const type = { contains: 'containsText', 'not-contains': 'notContainsText', begins: 'beginsWith', ends: 'endsWith' }[rule.op ?? 'contains'];
        const value = String(rule.value ?? '').replace(/"/g, '""');
        const formula = {
          containsText: `NOT(ISERROR(SEARCH("${value}",${top})))`, notContainsText: `ISERROR(SEARCH("${value}",${top}))`,
          beginsWith: `LEFT(${top},LEN("${value}"))="${value}"`, endsWith: `RIGHT(${top},LEN("${value}"))="${value}"`,
        }[type];
        content = tag('cfRule', { type, dxfId: dxf(), ...attrs, operator: type === 'containsText' ? 'containsText' : type === 'notContainsText' ? 'notContains' : type, text: String(rule.value ?? '') }, tag('formula', {}, formula));
        break;
      }
      case 'duplicate': content = tag('cfRule', { type: 'duplicateValues', dxfId: dxf(), ...attrs }); break;
      case 'unique': content = tag('cfRule', { type: 'uniqueValues', dxfId: dxf(), ...attrs }); break;
      case 'top': content = tag('cfRule', { type: 'top10', dxfId: dxf(), ...attrs, rank: String(rule.count), percent: rule.percent ? '1' : null, bottom: rule.bottom ? '1' : null }); break;
      case 'average': content = tag('cfRule', { type: 'aboveAverage', dxfId: dxf(), ...attrs, aboveAverage: rule.below ? '0' : null, equalAverage: rule.equal ? '1' : null }); break;
      case 'blank': content = tag('cfRule', { type: rule.op === 'not' ? 'notContainsBlanks' : 'containsBlanks', dxfId: dxf(), ...attrs },
        tag('formula', {}, rule.op === 'not' ? `LEN(TRIM(${top}))>0` : `LEN(TRIM(${top}))=0`)); break;
      case 'error': content = tag('cfRule', { type: rule.op === 'not' ? 'notContainsErrors' : 'containsErrors', dxfId: dxf(), ...attrs },
        tag('formula', {}, rule.op === 'not' ? `NOT(ISERROR(${top}))` : `ISERROR(${top})`)); break;
      case 'scale': content = tag('cfRule', { type: 'colorScale', priority: attrs.priority },
        tag('colorScale', {}, rule.points.map(pointXml), rule.colors.map((c) => tag('color', { rgb: argb(c) })))); break;
      case 'bar': content = tag('cfRule', { type: 'dataBar', priority: attrs.priority },
        tag('dataBar', {}, (rule.points ?? [{ type: 'min' }, { type: 'max' }]).map(pointXml), tag('color', { rgb: argb(rule.color ?? '#638ec6') }))); break;
      default: return null;
    }
    return tag('conditionalFormatting', { sqref: areaRef(rule.area) }, content);
  });
}

const VALIDATION_TYPES_BACK = { whole: 'whole', decimal: 'decimal', list: 'list', date: 'date', time: 'time', length: 'textLength', custom: 'custom' };

function validationsXml(validations) {
  if (validations.length === 0) return null;
  return tag('dataValidations', { count: String(validations.length) }, validations.map((rule) => {
    const formulas = [];
    if (rule.type === 'list') formulas.push(rule.list ? `"${rule.list.join(',')}"` : formulaText(rule.source));
    else if (rule.type === 'custom') formulas.push(formulaText(rule.formula));
    else formulas.push(...(rule.values ?? []).map(formulaText));
    const error = rule.error ?? { style: 'stop' };
    return tag('dataValidation', {
      type: VALIDATION_TYPES_BACK[rule.type] ?? 'custom',
      operator: ['list', 'custom'].includes(rule.type) ? null : CELL_OPS_BACK[rule.op ?? 'between'],
      allowBlank: rule.allowBlank === false ? null : '1', showDropDown: rule.dropdown === false ? '1' : null,
      showInputMessage: rule.input ? '1' : null, showErrorMessage: error.style === 'info' && !error.message ? null : '1',
      errorStyle: error.style === 'warning' ? 'warning' : error.style === 'info' ? 'information' : null,
      errorTitle: error.title || null, error: error.message || null,
      promptTitle: rule.input?.title || null, prompt: rule.input?.message || null,
      sqref: areaRef(rule.area),
    }, formulas.map((f, i) => tag(i === 0 ? 'formula1' : 'formula2', {}, f)));
  }));
}

const areaRef = (a) => `${columnLetters(a.left)}${a.top + 1}:${columnLetters(a.right)}${a.bottom + 1}`;

const EXCEL_OPS = { '=': 'equal', '<>': 'notEqual', '<': 'lessThan', '<=': 'lessThanOrEqual', '>': 'greaterThan', '>=': 'greaterThanOrEqual' };

/** A filter condition as Excel's custom filters write it, wildcards standing for the text operators. */
function customFilterXml({ op, value }) {
  const text = String(value ?? '');
  const as = {
    contains: ['equal', `*${text}*`], 'not-contains': ['notEqual', `*${text}*`], begins: ['equal', `${text}*`],
    ends: ['equal', `*${text}`], empty: ['equal', ''], 'not-empty': ['notEqual', ''],
  }[op] ?? [EXCEL_OPS[op] ?? 'equal', text];
  return tag('customFilter', { operator: as[0] === 'equal' ? null : as[0], val: as[1] });
}

function autoFilterXml(filter) {
  const columns = Object.entries(filter.columns ?? {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([offset, rule]) => {
    let content = null;
    if (rule.values) {
      const blank = rule.values.includes('');
      content = tag('filters', { blank: blank ? '1' : null }, rule.values.filter((v) => v !== '').map((val) => tag('filter', { val })));
    } else if (rule.conditions?.length) {
      content = tag('customFilters', { and: rule.join === 'or' ? null : '1' }, rule.conditions.slice(0, 2).map(customFilterXml));
    } else if (rule.top) {
      content = tag('top10', { top: rule.top.largest === false ? '0' : null, percent: rule.top.percent ? '1' : null, val: String(rule.top.count) });
    }
    return content ? tag('filterColumn', { colId: offset }, content) : null;
  });
  return tag('autoFilter', { ref: areaRef(filter.area) }, columns);
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
  if (cell.f && cell.a) {
    const end = `${columnLetters(col + cell.a[1] - 1)}${row + cell.a[0]}`;
    children.push(tag('f', { t: 'array', ref: `${ref}:${end}` }, toExcelFormula(cell.f)));
  } else if (cell.f) children.push(tag('f', {}, toExcelFormula(cell.f)));
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
