/** Excel 2003 XML workbooks (SpreadsheetML): read into Grid's document and written back from it, formulas between R1C1 and A1. */

import { parseXml, escapeText, escapeAttr } from '../xml.js';
import { Losses } from '../losses.js';
import { cleanLook } from './cell-look.js';
import { fromExcelFormula, toExcelFormula, fromOpenFormula, columnIndex, columnLetters } from './formulas.js';
import { hexColour } from './colour.js';

const SS = 'urn:schemas-microsoft-com:office:spreadsheet';
const X = 'urn:schemas-microsoft-com:office:excel';
const ROWS = 1048576;
const COLS = 16384;
const MAX_CELLS = 2_000_000;
const PT = 96 / 72;
const ERRORS = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A']);
const BORDER_WEIGHT = { 1: 1, 2: 2, 3: 3 };

// Formulas

/** Steps over the strings and quoted sheet names of a formula, giving each piece in between to `visit`. */
function rewrite(text, visit) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === c && text[j + 1] !== c)) j += text[j] === c ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const done = !/[\w.$]/.test(text[i - 1] ?? '') ? visit(text.slice(i)) : null;
    if (done) { out += done.out; i += done.length; continue; }
    out += c;
    i += 1;
  }
  return out;
}

const R1C1 = /^[Rr](\[-?\d+\]|\d+)?[Cc](\[-?\d+\]|\d+)?(?![\w(.])/;
const ROWS_ONLY = /^[Rr](\[-?\d+\]|\d+)?:[Rr](\[-?\d+\]|\d+)?(?![\w(.[])/;
const COLS_ONLY = /^[Cc](\[-?\d+\]|\d+)?:[Cc](\[-?\d+\]|\d+)?(?![\w(.[])/;

/** One part of an R1C1 reference, made absolute or relative to the cell it is in. */
function part(token, here, limit) {
  if (token === undefined) return { index: here, absolute: false };
  if (token.startsWith('[')) return { index: (here + Number(token.slice(1, -1)) + limit) % limit, absolute: false };
  return { index: Number(token) - 1, absolute: true };
}

/** `=R[-1]C+SUM(R1C1:R2C2)` in a cell as `=A1+SUM($A$1:$B$2)`. */
export function r1c1ToA1(formula, row, col) {
  const body = String(formula).replace(/^=/, '');
  const a1 = rewrite(body, (rest) => {
    let m = R1C1.exec(rest);
    if (m) {
      const r = part(m[1], row, ROWS);
      const c = part(m[2], col, COLS);
      return { out: `${c.absolute ? '$' : ''}${columnLetters(c.index)}${r.absolute ? '$' : ''}${r.index + 1}`, length: m[0].length };
    }
    m = ROWS_ONLY.exec(rest);
    if (m) {
      const [a, b] = [part(m[1], row, ROWS), part(m[2], row, ROWS)];
      return { out: `${a.absolute ? '$' : ''}${a.index + 1}:${b.absolute ? '$' : ''}${b.index + 1}`, length: m[0].length };
    }
    m = COLS_ONLY.exec(rest);
    if (m) {
      const [a, b] = [part(m[1], col, COLS), part(m[2], col, COLS)];
      return { out: `${a.absolute ? '$' : ''}${columnLetters(a.index)}:${b.absolute ? '$' : ''}${columnLetters(b.index)}`, length: m[0].length };
    }
    return null;
  });
  return fromExcelFormula(a1);
}

const A1 = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\w(.])/;
const A1_ROWS = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\w(.])/;
const A1_COLS = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\w(.])/;

const relative = (axis, index, here) => (index === here ? axis : `${axis}[${index - here}]`);

/** Grid's `=A1+1` in a cell as Excel 2003's `=R[-1]C+1`. */
export function a1ToR1c1(formula, row, col) {
  const excel = toExcelFormula(formula).replace(/_xlfn\.(_xlws\.)?/g, '');
  return `=${rewrite(excel, (rest) => {
    let m = A1_COLS.exec(rest);
    if (m && columnIndex(m[2]) < COLS && columnIndex(m[4]) < COLS) {
      const a = columnIndex(m[2]);
      const b = columnIndex(m[4]);
      return { out: `${m[1] ? `C${a + 1}` : relative('C', a, col)}:${m[3] ? `C${b + 1}` : relative('C', b, col)}`, length: m[0].length };
    }
    m = A1_ROWS.exec(rest);
    if (m) {
      const a = Number(m[2]) - 1;
      const b = Number(m[4]) - 1;
      return { out: `${m[1] ? `R${a + 1}` : relative('R', a, row)}:${m[3] ? `R${b + 1}` : relative('R', b, row)}`, length: m[0].length };
    }
    m = A1.exec(rest);
    if (m && columnIndex(m[2]) < COLS) {
      const c = columnIndex(m[2]);
      const r = Number(m[4]) - 1;
      return { out: `${m[3] ? `R${r + 1}` : relative('R', r, row)}${m[1] ? `C${c + 1}` : relative('C', c, col)}`, length: m[0].length };
    }
    return null;
  })}`;
}

// Reading

const ss = (e, name) => e?.getAttributeNS(SS, name) ?? null;
const kids = (e, name, ns = SS) => [...(e?.children ?? [])].filter((c) => c.localName === name && c.namespaceURI === ns);
const kid = (e, name, ns = SS) => kids(e, name, ns)[0] ?? null;

/** A day and time as the serial number spreadsheets count from 30 December 1899. */
function serial(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?)?/.exec(text);
  if (!m) return null;
  const days = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 + 25569;
  return days + ((Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) / 86400);
}

/** A style's look in Grid's terms. */
function lookOf(style, base) {
  const font = kid(style, 'Font');
  const interior = kid(style, 'Interior');
  const align = kid(style, 'Alignment');
  const format = ss(kid(style, 'NumberFormat'), 'Format');
  const borders = {};
  for (const b of kids(kid(style, 'Borders'), 'Border')) {
    const side = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }[ss(b, 'Position')];
    if (!side || !ss(b, 'LineStyle') || ss(b, 'LineStyle') === 'None') continue;
    borders[side] = { width: BORDER_WEIGHT[ss(b, 'Weight')] ?? 1, color: hexColour(ss(b, 'Color')) ?? '#000000' };
  }
  const named = { General: null, 'General Number': null, Fixed: '0.00', Standard: '#,##0.00', Percent: '0.00%', Scientific: '0.00E+00', 'Short Date': 'dd/mm/yyyy', 'Medium Date': 'dd-mmm-yy', 'Long Date': 'dddd, mmmm dd, yyyy', 'Short Time': 'hh:mm', 'Medium Time': 'hh:mm AM/PM', 'Long Time': 'hh:mm:ss', 'Yes/No': null, 'True/False': null, 'On/Off': null, Currency: '#,##0.00' };
  const size = Number(ss(font, 'Size'));
  const rotate = Number(ss(align, 'Rotate'));
  return cleanLook({
    bold: ss(font, 'Bold') === '1', italic: ss(font, 'Italic') === '1', strike: ss(font, 'StrikeThrough') === '1',
    underline: ss(font, 'Underline') === 'Single' || ss(font, 'Underline') === 'SingleAccounting',
    double: ss(font, 'Underline') === 'Double' || ss(font, 'Underline') === 'DoubleAccounting',
    color: /^#[0-9a-f]{6}$/i.test(ss(font, 'Color') ?? '') && ss(font, 'Color').toLowerCase() !== '#000000' ? ss(font, 'Color').toLowerCase() : null,
    size: Number.isFinite(size) && size > 0 && size !== base.size ? size : null,
    font: ss(font, 'FontName') && ss(font, 'FontName') !== base.font ? ss(font, 'FontName') : null,
    bg: ss(interior, 'Pattern') && ss(interior, 'Pattern') !== 'None' && /^#[0-9a-f]{6}$/i.test(ss(interior, 'Color') ?? '') ? ss(interior, 'Color').toLowerCase() : null,
    align: { Left: 'left', Center: 'center', Right: 'right', Justify: 'justify', CenterAcrossSelection: 'center' }[ss(align, 'Horizontal')] ?? null,
    valign: { Top: 'top', Center: 'middle' }[ss(align, 'Vertical')] ?? null,
    wrap: ss(align, 'WrapText') === '1', indent: Number(ss(align, 'Indent')) || null,
    rotate: Number.isFinite(rotate) && rotate !== 0 ? rotate : null,
    borders: Object.keys(borders).length ? borders : null,
    format: format === null ? null : format in named ? named[format] : format.replace(/\s*AM\/PM|\s*A\/P/gi, ''),
  });
}

/**
 * @param {string} text the .xml file
 * @returns {{document: Object, losses: Losses}}
 */
export function readSpreadsheet2003(text) {
  const doc = parseXml(text, 'The workbook');
  const workbook = doc.documentElement;
  if (workbook.localName !== 'Workbook' || workbook.namespaceURI !== SS) throw new Error('This is not an Excel 2003 XML workbook');
  const losses = new Losses();
  const styleElements = kids(kid(workbook, 'Styles'), 'Style');
  const defaultFont = kid(styleElements.find((s) => ss(s, 'ID') === 'Default'), 'Font');
  const base = { size: Number(ss(defaultFont, 'Size')) || 10, font: ss(defaultFont, 'FontName') ?? 'Arial' };
  const styles = {};
  const styleName = new Map();
  for (const style of styleElements) {
    const id = ss(style, 'ID');
    if (!id || id === 'Default') continue;
    // A style built on another takes what the other says first.
    const parent = styleElements.find((s) => ss(s, 'ID') === ss(style, 'Parent'));
    const look = { ...(parent ? lookOf(parent, base) : {}), ...lookOf(style, base) };
    if (!Object.keys(look).length) continue;
    const key = JSON.stringify(look);
    let name = Object.entries(styles).find(([, s]) => JSON.stringify(s) === key)?.[0];
    if (!name) { name = `imported-${Object.keys(styles).length + 1}`; styles[name] = look; }
    styleName.set(id, name);
  }

  let count = 0;
  const sheets = kids(workbook, 'Worksheet').slice(0, 1024).map((worksheet, index) => {
    const name = ss(worksheet, 'Name') ?? `Sheet${index + 1}`;
    const table = kid(worksheet, 'Table');
    const cells = {};
    const cols = {};
    const rows = {};
    const merges = [];
    let col = 0;
    for (const column of kids(table, 'Column')) {
      if (ss(column, 'Index')) col = Number(ss(column, 'Index')) - 1;
      if (!(col >= 0)) break;
      const span = Math.min(Number(ss(column, 'Span') ?? 0), 1024);
      const width = Number(ss(column, 'Width'));
      for (let k = 0; k <= span && col < COLS; k += 1, col += 1) {
        const entry = {};
        if (Number.isFinite(width) && width > 0 && Math.abs(width * PT - 64) > 1) entry.w = Math.round(width * PT);
        if (ss(column, 'Hidden') === '1') entry.hidden = true;
        if (Object.keys(entry).length) cols[col] = entry;
      }
    }
    let next = 0;
    for (const rowElement of kids(table, 'Row')) {
      const row = ss(rowElement, 'Index') ? Number(ss(rowElement, 'Index')) - 1 : next;
      if (!(row >= 0 && row < ROWS)) break;
      next = row + 1;
      const height = Number(ss(rowElement, 'Height'));
      const entry = {};
      if (Number.isFinite(height) && height > 0 && ss(rowElement, 'AutoFitHeight') === '0') entry.h = Math.round(height * PT);
      if (ss(rowElement, 'Hidden') === '1') entry.hidden = true;
      if (Object.keys(entry).length) rows[row] = entry;
      let nextCol = 0;
      for (const cell of kids(rowElement, 'Cell')) {
        const c = ss(cell, 'Index') ? Number(ss(cell, 'Index')) - 1 : nextCol;
        if (!(c >= 0 && c < COLS)) break;
        if ((count += 1) > MAX_CELLS) { losses.add('Cells past two million'); break; }
        const out = {};
        const data = kid(cell, 'Data');
        if (data) {
          const type = ss(data, 'Type');
          const value = data.textContent;
          if (type === 'Number') out.v = Number(value);
          else if (type === 'Boolean') out.v = value.trim() === '1';
          else if (type === 'DateTime') out.v = serial(value);
          else if (type === 'Error') out.v = value;
          else out.v = value;
          if (data.children.length) losses.add('Text with several looks in one cell, kept in one look');
          if (out.v === null || (typeof out.v === 'number' && !Number.isFinite(out.v))) delete out.v;
        }
        const formula = ss(cell, 'Formula');
        if (formula) {
          // LibreOffice writes its own OpenFormula here, marked of:; Excel writes R1C1.
          out.f = /^of:/i.test(formula) ? fromOpenFormula(formula).formula : r1c1ToA1(formula, row, c);
          if (ss(cell, 'ArrayRange')) losses.add('Array formulas, kept as plain formulas');
          else out.i = 1;
        }
        const style = styleName.get(ss(cell, 'StyleID'));
        if (style) out.s = style;
        const comment = kid(cell, 'Comment');
        if (comment) {
          const note = (kid(comment, 'Data')?.textContent ?? '').slice(0, 10000);
          if (note.trim()) out.n = note;
          if (ss(comment, 'ShowAlways') === '1') out.ns = 1;
        }
        const across = Number(ss(cell, 'MergeAcross') ?? 0);
        const down = Number(ss(cell, 'MergeDown') ?? 0);
        if (across > 0 || down > 0) merges.push({ top: row, left: c, bottom: Math.min(ROWS - 1, row + down), right: Math.min(COLS - 1, c + across) });
        if (Object.keys(out).length) cells[`${row},${c}`] = out;
        nextCol = c + Math.max(0, across) + 1;
      }
    }
    const options = kid(worksheet, 'WorksheetOptions', X);
    let frozen = null;
    if (kid(options, 'FreezePanes', X)) {
      const down = Number(kid(options, 'SplitHorizontal', X)?.textContent ?? 0);
      const across = Number(kid(options, 'SplitVertical', X)?.textContent ?? 0);
      if (down || across) frozen = { rows: down, cols: across };
    }
    const hidden = /Hidden/.test(kid(options, 'Visible', X)?.textContent ?? '');
    if (kid(worksheet, 'AutoFilter', X) || kid(worksheet, 'ConditionalFormatting', X) || kid(worksheet, 'DataValidation', X)) losses.add('Filters, conditional formats and validity rules of Excel 2003 XML');
    return { name, cells, cols, rows, ...(merges.length ? { merges } : {}), ...(frozen ? { frozen } : {}), ...(hidden ? { hidden: true } : {}) };
  });
  if (!sheets.length) throw new Error('This workbook has no sheets');

  const names = {};
  for (const named of kids(kid(workbook, 'Names'), 'NamedRange')) {
    const name = ss(named, 'Name');
    const refers = ss(named, 'RefersTo');
    if (!name || !refers || /^_xlnm\./i.test(name) || /^Print_/i.test(name)) continue;
    names[name.toUpperCase()] = r1c1ToA1(refers, 0, 0);
  }
  return {
    document: { version: 1, type: 'grid', sheets, styles, charts: [], ...(Object.keys(names).length ? { names } : {}) },
    losses,
  };
}

// Writing

/** A style's look as an Excel 2003 Style element. */
function styleXml(id, look) {
  const parts = [];
  const align = [];
  if (look.align) align.push(`ss:Horizontal="${{ left: 'Left', center: 'Center', right: 'Right', justify: 'Justify' }[look.align] ?? 'General'}"`);
  if (look.valign) align.push(`ss:Vertical="${look.valign === 'middle' ? 'Center' : look.valign === 'top' ? 'Top' : 'Bottom'}"`);
  if (look.wrap) align.push('ss:WrapText="1"');
  if (look.indent) align.push(`ss:Indent="${Math.round(look.indent)}"`);
  if (look.rotate) align.push(`ss:Rotate="${Math.round(look.rotate)}"`);
  if (align.length) parts.push(`<Alignment ${align.join(' ')}/>`);
  const sides = Object.entries(look.borders ?? {}).filter(([, b]) => b);
  if (sides.length) {
    parts.push(`<Borders>${sides.map(([side, b]) => `<Border ss:Position="${side[0].toUpperCase()}${side.slice(1)}" ss:LineStyle="Continuous" ss:Weight="${Math.min(3, Math.max(1, Math.round(b.width ?? 1)))}" ss:Color="${escapeAttr(b.color ?? '#000000')}"/>`).join('')}</Borders>`);
  }
  const font = [];
  if (look.font) font.push(`ss:FontName="${escapeAttr(look.font)}"`);
  if (look.size) font.push(`ss:Size="${look.size}"`);
  if (look.color) font.push(`ss:Color="${escapeAttr(look.color)}"`);
  if (look.bold) font.push('ss:Bold="1"');
  if (look.italic) font.push('ss:Italic="1"');
  if (look.strike) font.push('ss:StrikeThrough="1"');
  if (look.underline) font.push('ss:Underline="Single"');
  else if (look.double) font.push('ss:Underline="Double"');
  if (font.length) parts.push(`<Font ${font.join(' ')}/>`);
  if (look.bg) parts.push(`<Interior ss:Color="${escapeAttr(look.bg)}" ss:Pattern="Solid"/>`);
  if (look.format) parts.push(`<NumberFormat ss:Format="${escapeAttr(look.format)}"/>`);
  return `<Style ss:ID="${id}">${parts.join('')}</Style>`;
}

/**
 * Grid's document as an Excel 2003 XML workbook.
 * @param {Object} document Grid's exportJSON()
 * @returns {{text: string, losses: Losses}}
 */
export function writeSpreadsheet2003(document) {
  const losses = new Losses();
  const styles = document.styles ?? {};
  const lookOfStyle = (name) => {
    const style = styles[name] ?? {};
    return { ...(style.parent ? styles[style.parent] ?? {} : {}), ...style };
  };
  const ids = new Map();
  const idOf = (name) => {
    if (!name || !styles[name]) return null;
    if (!ids.has(name)) ids.set(name, `s${21 + ids.size}`);
    return ids.get(name);
  };
  const sheets = (document.sheets ?? []).map((sheet) => {
    const entries = Object.entries(sheet.cells ?? {}).map(([key, cell]) => { const [r, c] = key.split(',').map(Number); return { r, c, cell }; })
      .sort((a, b) => a.r - b.r || a.c - b.c);
    const merges = new Map((sheet.merges ?? []).map((m) => [`${m.top},${m.left}`, m]));
    const covered = new Set();
    for (const m of sheet.merges ?? []) for (let r = m.top; r <= m.bottom; r += 1) for (let c = m.left; c <= m.right; c += 1) if (r !== m.top || c !== m.left) covered.add(`${r},${c}`);
    // Merged cells start a cell even when they are empty.
    for (const m of sheet.merges ?? []) if (!sheet.cells?.[`${m.top},${m.left}`]) entries.push({ r: m.top, c: m.left, cell: {} });
    entries.sort((a, b) => a.r - b.r || a.c - b.c);
    const byRow = new Map();
    for (const e of entries) {
      if (covered.has(`${e.r},${e.c}`)) continue;
      if (!byRow.has(e.r)) byRow.set(e.r, []);
      byRow.get(e.r).push(e);
    }
    for (const r of Object.keys(sheet.rows ?? {}).map(Number)) if (!byRow.has(r)) byRow.set(r, []);
    const columns = Object.entries(sheet.cols ?? {}).map(([c, e]) => ({ c: Number(c), e })).sort((a, b) => a.c - b.c)
      .map(({ c, e }) => `<Column ss:Index="${c + 1}"${e.w ? ` ss:AutoFitWidth="0" ss:Width="${Math.round((e.w / PT) * 100) / 100}"` : ''}${e.hidden ? ' ss:Hidden="1"' : ''}/>`).join('');
    const rowsXml = [...byRow.keys()].sort((a, b) => a - b).map((r) => {
      const look = sheet.rows?.[r] ?? {};
      const cellsXml = byRow.get(r).map(({ c, cell }) => {
        const attrs = [`ss:Index="${c + 1}"`];
        const style = idOf(cell.s);
        if (style) attrs.push(`ss:StyleID="${style}"`);
        const merge = merges.get(`${r},${c}`);
        if (merge && merge.right > merge.left) attrs.push(`ss:MergeAcross="${merge.right - merge.left}"`);
        if (merge && merge.bottom > merge.top) attrs.push(`ss:MergeDown="${merge.bottom - merge.top}"`);
        if (cell.f) attrs.push(`ss:Formula="${escapeAttr(a1ToR1c1(cell.f, r, c))}"`);
        if (cell.a) losses.add('Array formulas, written as plain formulas');
        let data = '';
        const v = cell.v;
        if (typeof v === 'number' && Number.isFinite(v)) data = `<Data ss:Type="Number">${v}</Data>`;
        else if (typeof v === 'boolean') data = `<Data ss:Type="Boolean">${v ? 1 : 0}</Data>`;
        else if (typeof v === 'string' && ERRORS.has(v)) data = `<Data ss:Type="Error">${escapeText(v)}</Data>`;
        else if (typeof v === 'string' && v !== '') data = `<Data ss:Type="String">${escapeText(v)}</Data>`;
        const note = cell.n ? `<Comment${cell.ns ? ' ss:ShowAlways="1"' : ''}><ss:Data xmlns="http://www.w3.org/TR/REC-html40">${escapeText(cell.n)}</ss:Data></Comment>` : '';
        return `<Cell ${attrs.join(' ')}>${data}${note}</Cell>`;
      }).join('');
      return `<Row ss:Index="${r + 1}"${look.h ? ` ss:AutoFitHeight="0" ss:Height="${Math.round((look.h / PT) * 100) / 100}"` : ''}${look.hidden ? ' ss:Hidden="1"' : ''}>${cellsXml}</Row>`;
    }).join('');
    const frozen = sheet.frozen && (sheet.frozen.rows || sheet.frozen.cols)
      ? `<FreezePanes/><FrozenNoSplit/>${sheet.frozen.rows ? `<SplitHorizontal>${sheet.frozen.rows}</SplitHorizontal><TopRowBottomPane>${sheet.frozen.rows}</TopRowBottomPane>` : ''}${sheet.frozen.cols ? `<SplitVertical>${sheet.frozen.cols}</SplitVertical><LeftColumnRightPane>${sheet.frozen.cols}</LeftColumnRightPane>` : ''}`
      : '';
    const options = frozen || sheet.hidden ? `<WorksheetOptions xmlns="${X}">${frozen}${sheet.hidden ? '<Visible>SheetHidden</Visible>' : ''}</WorksheetOptions>` : '';
    if (sheet.validations?.length || sheet.conditions?.length) losses.add('Validity rules and conditional formats, which GRT does not write to Excel 2003 XML');
    // Excel writes how far the table reaches, and LibreOffice reads no further than it says.
    const lastRow = Math.max(0, ...entries.map((e) => e.r), ...Object.keys(sheet.rows ?? {}).map(Number), ...(sheet.merges ?? []).map((m) => m.bottom));
    const lastCol = Math.max(0, ...entries.map((e) => e.c), ...Object.keys(sheet.cols ?? {}).map(Number), ...(sheet.merges ?? []).map((m) => m.right));
    return `<Worksheet ss:Name="${escapeAttr(sheet.name ?? 'Sheet')}"><Table ss:ExpandedColumnCount="${lastCol + 1}" ss:ExpandedRowCount="${lastRow + 1}" x:FullColumns="1" x:FullRows="1">${columns}${rowsXml}</Table>${options}</Worksheet>`;
  });
  if ((document.charts ?? []).length || (document.drawings ?? []).length) losses.add('Charts and drawings, which Excel 2003 XML does not keep');
  const names = Object.entries(document.names ?? {}).map(([name, refers]) => `<NamedRange ss:Name="${escapeAttr(name)}" ss:RefersTo="${escapeAttr(a1ToR1c1(refers, 0, 0))}"/>`).join('');
  const styleList = [...ids].map(([name, id]) => styleXml(id, lookOfStyle(name))).join('');
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="${SS}" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="${X}" xmlns:ss="${SS}" xmlns:html="http://www.w3.org/TR/REC-html40">`
    + `<Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/><Font ss:FontName="Arial" ss:Size="10"/></Style>${styleList}</Styles>`
    + `${names ? `<Names>${names}</Names>` : ''}${sheets.join('')}</Workbook>\n`;
  return { text, losses };
}
