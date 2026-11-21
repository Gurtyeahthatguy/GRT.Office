/** Excel 97 to 2003 workbooks (.xls, BIFF8): read into Grid's document and written back from it. */

import { readCfb, writeCfb, isCfb } from './cfb.js';
import { readTokens, writeTokens, errorText, ERROR_CODES, tokensFromBiff5 } from './xls-formulas.js';
import { Losses } from '../losses.js';
import { cleanLook } from './cell-look.js';

const LIMIT_RECORDS = 5_000_000;
const ROWS = 65536;
const COLS = 256;

/** Excel's own number formats, by their index. */
const BUILT_IN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd h:mm',
  37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss',
  47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};

/** The colours of Excel 97's palette, indices 8 to 63. */
const PALETTE = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', '800000', '008000', '000080', '808000', '800080', '008080',
  'c0c0c0', '808080', '9999ff', '993366', 'ffffcc', 'ccffff', '660066', 'ff8080', '0066cc', 'ccccff', '000080', 'ff00ff', 'ffff00', '00ffff',
  '800080', '800000', '008080', '0000ff', '00ccff', 'ccffff', 'ccffcc', 'ffff99', '99ccff', 'ff99cc', 'cc99ff', 'ffcc99', '3366ff', '33cccc',
  '99cc00', 'ffcc00', 'ff9900', 'ff6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

const BORDER_STYLES = { 1: 1, 2: 2, 5: 3, 3: 1, 4: 1, 6: 3, 7: 1, 8: 2, 9: 1, 10: 2, 11: 1, 12: 2, 13: 2 };

// Reading

/** The records of a stream, each CONTINUE joined to the record before it with where the joins fall. */
function records(bytes) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 4 <= bytes.length && out.length < LIMIT_RECORDS) {
    const type = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    const data = bytes.subarray(at + 4, Math.min(bytes.length, at + 4 + size));
    if (type === 0x003c && out.length) {
      const last = out[out.length - 1];
      last.breaks.push(last.data.length);
      const joined = new Uint8Array(last.data.length + data.length);
      joined.set(last.data);
      joined.set(data, last.data.length);
      last.data = joined;
    } else out.push({ type, data, offset: at, breaks: [] });
    at += 4 + size;
  }
  return out;
}

/** A reader of one record's bytes, which knows that a string may continue in the next record with its flags repeated. */
class Cursor {
  constructor(record, mode = { biff: 8, decode: null }) {
    this.mode = mode;
    this.bytes = record.data;
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.breaks = record.breaks;
    this.at = 0;
  }

  u8() { return this.bytes[this.at++]; }
  u16() { const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  u32() { const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  get left() { return this.bytes.length - this.at; }

  /** An XLUnicodeString or a ShortXLUnicodeString, its characters read across a CONTINUE. */
  string(lengthBytes = 2) {
    const count = lengthBytes === 2 ? this.u16() : this.u8();
    if (this.mode.biff < 8) {
      // Excel 5 and older: bytes in the workbook's code page, no flags.
      const text = this.mode.decode(this.bytes.subarray(this.at, this.at + count));
      this.at += count;
      return text;
    }
    let flags = this.u8();
    const rich = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    let text = '';
    for (let i = 0; i < count && this.at < this.bytes.length; i += 1) {
      if (this.breaks.includes(this.at)) flags = this.u8();
      text += String.fromCharCode(flags & 1 ? this.u16() : this.u8());
    }
    this.at += rich * 4 + ext;
    return text;
  }
}

const rkValue = (rk) => {
  let value;
  if (rk & 2) value = rk >> 2;
  else {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, rk & 0xfffffffc, true);
    value = buffer.getFloat64(0, true);
  }
  return rk & 1 ? value / 100 : value;
};

/** A decoder for a workbook's code page, Windows Western when it names none GRT knows. */
function codePage(cp) {
  const label = cp === 10000 ? 'macintosh' : cp === 1200 ? 'utf-16le' : cp >= 874 && cp <= 1258 ? `windows-${cp}` : cp === 866 ? 'ibm866' : 'windows-1252';
  let decoder;
  try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder('windows-1252'); }
  return (bytes) => decoder.decode(bytes);
}

/** An Excel 5 cell format, put in Excel 97's terms so one reader serves both. */
function biff5Xf(c) {
  const font = c.u16();
  const format = c.u16();
  const type = c.u16();
  const align = c.u8();
  const orientation = c.u8() & 3;
  const fillWord = c.u32();
  const lines = c.u32();
  const kind = (v) => v & 7;
  const border1 = (kind(lines >>> 3) | (kind(lines >>> 6) << 4) | (kind(lines) << 8) | (kind(fillWord >>> 22) << 12)
    | (((lines >>> 16) & 0x7f) << 16) | (((lines >>> 23) & 0x7f) << 23)) >>> 0;
  const border2 = (((lines >>> 9) & 0x7f) | (((fillWord >>> 25) & 0x7f) << 7) | (((fillWord >>> 16) & 0x3f) << 26)) >>> 0;
  return { font, format, style: Boolean(type & 4), align, rotation: [0, 255, 90, 180][orientation], indent: 0, border1, border2, fill: fillWord & 0x7f };
}

/**
 * @param {Uint8Array} bytes the .xls file
 * @returns {{document: Object, losses: Losses}}
 */
function readXlsUnsafe(bytes) {
  if (!isCfb(bytes)) return readOldBiff(bytes);
  const losses = new Losses();
  const streams = readCfb(bytes);
  const workbook = streams.get('Workbook') ?? streams.get('Book');
  if (!workbook) throw new Error('This file has no workbook in it');
  if (streams.has('EncryptionInfo') || [...streams.keys()].some((k) => /encrypt/i.test(k))) throw new Error('This workbook is encrypted');
  const all = records(workbook);
  // Excel 97 and later say 0x0600 in their first record, Excel 5 and 95 0x0500.
  const first = all[0];
  const version = first?.type === 0x0809 && first.data.length >= 2 ? first.data[0] | (first.data[1] << 8) : 0x0600;
  const mode = { biff: version >= 0x0600 ? 8 : 5, decode: codePage(1252) };
  if (mode.biff === 5) losses.add('Excel 5 and 95 workbooks are read, and saved as Excel 97 or later');
  const fonts = [];
  const formats = new Map();
  const xfs = [];
  const sheets = [];
  const palette = [...PALETTE];
  let strings = [];
  let date1904 = false;
  const externSheets = [];
  const names = [];
  const supbooks = [];
  const externNames = [];
  for (const record of all) {
    const c = new Cursor(record, mode);
    switch (record.type) {
      case 0x002f: throw new Error('This workbook is protected with a password');
      case 0x0042: mode.decode = codePage(c.u16()); break;
      case 0x0022: date1904 = c.u16() === 1; break;
      case 0x0031: {
        const height = c.u16();
        const flags = c.u16();
        const color = c.u16();
        const weight = c.u16();
        const escapement = c.u16();
        const underline = c.u8();
        c.at += 3;
        fonts.push({ size: height / 20, italic: Boolean(flags & 2), strike: Boolean(flags & 8), bold: weight >= 700, color, underline, escapement, name: c.string(1) });
        // Excel never writes a font numbered four, so the list skips it.
        if (fonts.length === 4) fonts.push(null);
        break;
      }
      case 0x041e: { const index = c.u16(); formats.set(index, c.string(mode.biff === 8 ? 2 : 1)); break; }
      case 0x00e0: {
        if (mode.biff === 5) { xfs.push(biff5Xf(c)); break; }
        const font = c.u16();
        const format = c.u16();
        const type = c.u16();
        const align = c.u8();
        const rotation = c.u8();
        const indent = c.u8();
        c.u8();
        const border1 = c.u32();
        const border2 = c.u32();
        const fill = c.u16();
        xfs.push({ font, format, style: Boolean(type & 4), align, rotation, indent: indent & 0x0f, border1, border2, fill });
        break;
      }
      case 0x0092: { const count = c.u16(); for (let i = 0; i < count && i < 56; i += 1) { const r = c.u8(); const g = c.u8(); const b = c.u8(); c.u8(); palette[i] = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''); } break; }
      case 0x0085: {
        const offset = c.u32();
        const hidden = c.u8();
        const kind = c.u8();
        const name = c.string(1);
        if (kind !== 0) { losses.add('Chart sheets and macro sheets'); break; }
        sheets.push({ offset, hidden: hidden !== 0, name });
        break;
      }
      case 0x00fc: {
        c.u32();
        const count = c.u32();
        strings = [];
        for (let i = 0; i < count && c.left > 0; i += 1) strings.push(c.string(2));
        break;
      }
      case 0x01ae: { const ctab = c.u16(); const kind = c.u16(); supbooks.push(kind === 0x0401 ? 'self' : kind === 0x3a01 ? 'addin' : 'external'); void ctab; break; }
      case 0x0023: { c.at += 6; externNames.push({ book: supbooks.length - 1, name: c.string(1) }); break; }
      case 0x0017: { if (mode.biff === 5) break; const count = c.u16(); for (let i = 0; i < count; i += 1) externSheets.push({ book: c.u16(), first: (c.u16() << 16) >> 16, last: (c.u16() << 16) >> 16 }); break; }
      case 0x0018: {
        const flags = c.u16();
        c.u8();
        const cch = c.u8();
        const cce = c.u16();
        c.u16();
        const sheet = c.u16();
        c.at += 4;
        let name = '';
        if (mode.biff === 5) { name = mode.decode(record.data.subarray(c.at, c.at + cch)); c.at += cch; } else {
          const wide = c.u8() & 1;
          for (let i = 0; i < cch; i += 1) name += String.fromCharCode(wide ? c.u16() : c.u8());
        }
        names.push({ name: flags & 0x20 ? null : name, builtin: Boolean(flags & 0x20), sheet, tokens: record.data.subarray(c.at, c.at + cce) });
        break;
      }
      case 0x0013: case 0x00e1: break;
      default: break;
    }
  }
  if (sheets.length === 0) throw new Error('This workbook has no sheets');
  const colorOf = (index) => (index >= 8 && index < 64 ? `#${palette[index - 8]}` : null);
  const sheetName = (ixti) => {
    const x = externSheets[ixti];
    if (!x) return null;
    if (supbooks[x.book] !== 'self') return null;
    return sheets[x.first]?.name ?? null;
  };
  const externName = (ixti, index) => {
    const x = externSheets[ixti];
    const own = externNames.filter((e) => e.book === x?.book);
    return own[index]?.name ?? null;
  };
  // Excel 5's references name a sheet by its place; translated, they arrive as such.
  const tokenContext = { sheetName: mode.biff === 5 ? (i) => sheets[i]?.name ?? null : sheetName, name: (i) => names[i]?.name ?? null, externName };
  /** Formula text from a record's tokens, Excel 5's turned into Excel 97's first. */
  const formulaText = (data, start, size, place) => {
    if (mode.biff === 8) return readTokens(data, start, size, { ...tokenContext, ...place });
    const translated = tokensFromBiff5(data, start, size, mode.decode);
    return translated ? readTokens(translated.bytes, 0, translated.size, { ...tokenContext, ...place }) : null;
  };

  // Looks: each XF read into Grid's terms, shared by every cell that names it.
  const base = fonts[0] ?? { size: 10, name: 'Arial' };
  const styles = {};
  const styleOf = new Map();
  const lookOf = (index) => {
    if (styleOf.has(index)) return styleOf.get(index);
    const xf = xfs[index];
    let name = null;
    if (xf) {
      const font = fonts[xf.font] ?? base;
      const fmt = BUILT_IN_FORMATS[xf.format] ?? formats.get(xf.format) ?? 'General';
      const look = cleanLook({
        bold: font.bold && !base.bold, italic: font.italic, strike: font.strike,
        underline: font.underline === 1 || font.underline === 0x21, double: font.underline === 2 || font.underline === 0x22,
        color: font.color !== 0x7fff && font.color !== 8 ? colorOf(font.color) : null,
        size: font.size !== base.size ? font.size : null, font: font.name !== base.name ? font.name : null,
        align: { 1: 'left', 2: 'center', 3: 'right', 5: 'justify', 6: 'center' }[xf.align & 7] ?? null,
        valign: { 0: 'top', 1: 'middle' }[(xf.align >> 4) & 7] ?? null,
        wrap: Boolean(xf.align & 0x08), indent: xf.indent || null,
        rotate: xf.rotation > 90 && xf.rotation <= 180 ? 90 - xf.rotation : xf.rotation === 255 ? 0 : xf.rotation,
        bg: ((xf.border2 >>> 26) & 0x3f) === 1 ? colorOf(xf.fill & 0x7f) : null,
        borders: (() => {
          const out = {};
          const sides = [['left', xf.border1 & 0xf, (xf.border1 >>> 16) & 0x7f], ['right', (xf.border1 >>> 4) & 0xf, (xf.border1 >>> 23) & 0x7f],
            ['top', (xf.border1 >>> 8) & 0xf, xf.border2 & 0x7f], ['bottom', (xf.border1 >>> 12) & 0xf, (xf.border2 >>> 7) & 0x7f]];
          for (const [side, kind, color] of sides) if (kind) out[side] = { width: BORDER_STYLES[kind] ?? 1, color: colorOf(color) ?? '#000000' };
          return out;
        })(),
        format: /^general$/i.test(fmt) ? null : fmt.replace(/\s*AM\/PM|\s*A\/P/gi, '').replace(/\[(h+|m+|s+)\]/gi, '$1'),
      });
      if (Object.keys(look).length) {
        const key = JSON.stringify(look);
        name = Object.entries(styles).find(([, s]) => JSON.stringify(s) === key)?.[0] ?? null;
        if (!name) { name = `imported-${Object.keys(styles).length + 1}`; styles[name] = look; }
      }
    }
    styleOf.set(index, name);
    return name;
  };

  // The sheets, each from its BOF to its EOF.
  const byOffset = new Map(all.map((r, i) => [r.offset, i]));
  const outSheets = sheets.map((sheet) => {
    const cells = {};
    const cols = {};
    const rows = {};
    const merges = [];
    let frozen = null;
    const start = byOffset.get(sheet.offset);
    if (start === undefined) { losses.add('Sheets that could not be found in the file'); return { name: sheet.name, cells }; }
    const shared = [];
    let pendingString = null;
    const put = (row, col, cell) => {
      if (row >= ROWS || col >= COLS) return;
      const style = lookOf(cell.xf);
      const out = {};
      if (cell.v !== undefined && cell.v !== null && cell.v !== '') out.v = cell.v;
      if (cell.f) out.f = cell.f;
      if (style) out.s = style;
      if (Object.keys(out).length) cells[`${row},${col}`] = out;
    };
    for (let i = start + 1; i < all.length; i += 1) {
      const record = all[i];
      if (record.type === 0x000a) break;
      const c = new Cursor(record, mode);
      switch (record.type) {
        case 0x0203: { const row = c.u16(); const col = c.u16(); const xf = c.u16(); put(row, col, { xf, v: c.view.getFloat64(6, true) }); break; }
        case 0x027e: { const row = c.u16(); const col = c.u16(); const xf = c.u16(); put(row, col, { xf, v: rkValue(c.u32()) }); break; }
        case 0x00bd: {
          const row = c.u16();
          const first = c.u16();
          const count = (record.data.length - 6) / 6;
          for (let k = 0; k < count; k += 1) { const xf = c.u16(); put(row, first + k, { xf, v: rkValue(c.u32()) }); }
          break;
        }
        case 0x00fd: { const row = c.u16(); const col = c.u16(); const xf = c.u16(); put(row, col, { xf, v: strings[c.u32()] ?? '' }); break; }
        case 0x0204: case 0x00d6: { const row = c.u16(); const col = c.u16(); const xf = c.u16(); put(row, col, { xf, v: c.string(2) }); break; }
        case 0x0205: {
          const row = c.u16(); const col = c.u16(); const xf = c.u16();
          const value = c.u8();
          const error = c.u8();
          put(row, col, { xf, v: error ? errorText(value) : value === 1 });
          break;
        }
        case 0x0201: { const row = c.u16(); const col = c.u16(); put(row, col, { xf: c.u16() }); break; }
        case 0x00be: {
          const row = c.u16();
          const first = c.u16();
          const count = (record.data.length - 6) / 2;
          for (let k = 0; k < count; k += 1) put(row, first + k, { xf: c.u16() });
          break;
        }
        case 0x0006: {
          const row = c.u16(); const col = c.u16(); const xf = c.u16();
          const d = record.data;
          let value;
          if (d[12] === 0xff && d[13] === 0xff) {
            value = d[6] === 1 ? d[8] === 1 : d[6] === 2 ? errorText(d[8]) : d[6] === 0 ? '' : null;
          } else value = c.view.getFloat64(6, true);
          const size = c.view.getUint16(20, true);
          let text;
          if (d[22] === 0x01 && size === 5) {
            // A shared formula: its tokens are those of the cell named, moved to this one.
            const masterRow = c.view.getUint16(23, true);
            const masterCol = c.view.getUint16(25, true);
            const found = shared.find((s) => masterRow >= s.r1 && masterRow <= s.r2 && masterCol >= s.c1 && masterCol <= s.c2);
            text = found ? formulaText(found.data, found.start, found.size, { row, col }) : null;
          } else text = formulaText(d, 22, size, { row, col });
          if (text === null) losses.add('Formulas with parts Excel 97 files keep that GRT does not read, kept as their values');
          const cell = { xf, v: value };
          if (text !== null) cell.f = `=${text}`;
          put(row, col, cell);
          if (d[6] === 0 && d[12] === 0xff && d[13] === 0xff) pendingString = { row, col };
          break;
        }
        case 0x0207: {
          if (pendingString) {
            const at = cells[`${pendingString.row},${pendingString.col}`];
            const text = c.string(2);
            if (at) at.v = text;
            pendingString = null;
          }
          break;
        }
        case 0x04bc: {
          const r1 = c.u16(); const r2 = c.u16(); const c1 = c.u8(); const c2 = c.u8();
          c.u16();
          const size = c.u16();
          shared.push({ r1, r2, c1, c2, data: record.data, start: c.at, size });
          break;
        }
        case 0x00e5: {
          const count = c.u16();
          for (let k = 0; k < count && c.left >= 8; k += 1) {
            const top = c.u16(); const bottom = c.u16(); const left = c.u16(); const right = c.u16();
            if (bottom > top || right > left) merges.push({ top, bottom, left, right });
          }
          break;
        }
        case 0x007d: {
          const first = c.u16(); const last = c.u16(); const width = c.u16(); c.u16(); const options = c.u16();
          // A run over most of the sheet is the default width, written out by LibreOffice.
          if (last - first > 100 && !(options & 1)) break;
          for (let col = first; col <= Math.min(last, COLS - 1); col += 1) {
            const entry = {};
            if (Math.abs(width - 2340) > 64) entry.w = Math.round((width / 256) * 7 + 5);
            if (options & 1) entry.hidden = true;
            if (Object.keys(entry).length) cols[col] = entry;
          }
          break;
        }
        case 0x0208: {
          const row = c.u16(); c.u16(); c.u16();
          const height = c.u16() & 0x7fff;
          c.at += 4;
          const options = c.u32();
          const entry = {};
          if (options & 0x40 && Math.abs(height - 255) > 10) entry.h = Math.round((height / 20) * (96 / 72));
          if (options & 0x20) entry.hidden = true;
          if (Object.keys(entry).length && row < ROWS) rows[row] = entry;
          break;
        }
        case 0x0041: {
          const x = c.u16(); const y = c.u16();
          if (x || y) frozen = { rows: y, cols: x };
          break;
        }
        case 0x001c: losses.add('Comments in Excel 97 workbooks'); break;
        case 0x01b8: losses.add('Links in Excel 97 workbooks'); break;
        case 0x00ec: losses.add('Pictures and drawings in Excel 97 workbooks'); break;
        default: break;
      }
    }
    return { name: sheet.name, cells, cols, rows, ...(merges.length ? { merges } : {}), ...(frozen ? { frozen } : {}), ...(sheet.hidden ? { hidden: true } : {}) };
  });
  if (date1904) losses.add('Dates counted from 1904, read as they are counted');

  const definedNames = {};
  for (const n of names) {
    if (!n.name || n.sheet) continue;
    const text = formulaText(n.tokens, 0, n.tokens.length, { row: 0, col: 0 });
    if (text) definedNames[n.name.toUpperCase()] = `=${text}`;
  }
  return {
    document: { version: 1, type: 'grid', sheets: outSheets, styles, charts: [], ...(Object.keys(definedNames).length ? { names: definedNames } : {}) },
    losses,
  };
}

// Writing

/** Records into bytes, those longer than a record may be cut with CONTINUE. */
class Writer {
  constructor() { this.parts = []; this.size = 0; }

  record(type, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    let at = 0;
    let kind = type;
    do {
      const chunk = data.subarray(at, at + 8224);
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint16(0, kind, true);
      new DataView(head.buffer).setUint16(2, chunk.length, true);
      this.parts.push(head, chunk);
      this.size += 4 + chunk.length;
      at += chunk.length;
      kind = 0x003c;
    } while (at < data.length);
  }

  bytes() {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

/** Little-endian bytes, built up. */
class Bytes {
  constructor() { this.list = []; }
  u8(v) { this.list.push(v & 0xff); return this; }
  u16(v) { this.list.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v) { this.list.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.list.push(...b); return this; }
  add(bytes) { for (const b of bytes) this.list.push(b); return this; }
  /** An XLUnicodeString in UTF-16, its length in one byte or two. */
  string(text, lengthBytes = 2) {
    const value = String(text);
    if (lengthBytes === 1) this.u8(Math.min(value.length, 255)); else this.u16(value.length);
    this.u8(1);
    for (const ch of value.slice(0, lengthBytes === 1 ? 255 : 32767)) this.u16(ch.charCodeAt(0));
    return this;
  }
  get bytes() { return Uint8Array.from(this.list); }
  get length() { return this.list.length; }
}

const colourIndex = (hex, palette) => {
  const value = /^#([0-9a-f]{6})$/i.exec(hex ?? '')?.[1]?.toLowerCase();
  if (!value) return null;
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const want = rgb(value);
  let best = 0;
  let bestDistance = Infinity;
  palette.forEach((p, i) => {
    const d = rgb(p).reduce((sum, v, k) => sum + (v - want[k]) ** 2, 0);
    if (d < bestDistance) { best = i; bestDistance = d; }
  });
  return best + 8;
};

/**
 * Grid's document as an .xls file.
 * @param {Object} document Grid's exportJSON()
 * @returns {{bytes: Uint8Array, losses: Losses}}
 */
export function writeXls(document) {
  const losses = new Losses();
  const sheets = (document.sheets ?? []).slice(0, 255);
  if ((document.sheets ?? []).length > 255) losses.add('Sheets past the 255th');
  const styles = document.styles ?? {};
  // Colours the document uses replace the palette's last ones, so they come out exact.
  const palette = [...PALETTE];
  const used = new Set();
  const lookOfStyle = (name) => {
    const style = styles[name] ?? {};
    const parent = style.parent ? styles[style.parent] ?? {} : {};
    return { ...parent, ...style };
  };
  for (const name of Object.keys(styles)) {
    const look = lookOfStyle(name);
    for (const c of [look.color, look.bg, ...Object.values(look.borders ?? {}).map((b) => b?.color)]) if (/^#[0-9a-f]{6}$/i.test(c ?? '')) used.add(c.toLowerCase().slice(1));
  }
  let slot = 55;
  for (const c of used) {
    if (palette.includes(c)) continue;
    if (slot < 16) { losses.add('Colours past the 40 Excel 97 can add, the nearest taken'); break; }
    palette[slot] = c;
    slot -= 1;
  }

  // Fonts, formats and XFs for each style.
  const fonts = [{ name: 'Arial', size: 10 }];
  const fontKey = (f) => JSON.stringify(f);
  const fontIndex = (f) => {
    let i = fonts.findIndex((x) => fontKey(x) === fontKey(f));
    if (i < 0) { fonts.push(f); i = fonts.length - 1; }
    return i >= 4 ? i + 1 : i;
  };
  const formats = new Map();
  const formatIndex = (code) => {
    if (!code) return 0;
    const builtIn = Object.entries(BUILT_IN_FORMATS).find(([, v]) => v === code);
    if (builtIn) return Number(builtIn[0]);
    if (!formats.has(code)) formats.set(code, 164 + formats.size);
    return formats.get(code);
  };
  const xfs = [];
  const xfOf = new Map();
  const BORDER = { 1: 1, 2: 2, 3: 5 };
  const xfIndex = (name) => {
    if (!name) return 15;
    if (xfOf.has(name)) return xfOf.get(name);
    const look = lookOfStyle(name);
    const font = fontIndex({
      name: look.font ?? 'Arial', size: look.size ?? 10, ...(look.bold ? { bold: true } : {}), ...(look.italic ? { italic: true } : {}),
      ...(look.underline ? { underline: 1 } : look.double ? { underline: 2 } : {}), ...(look.strike ? { strike: true } : {}),
      ...(look.color ? { color: colourIndex(look.color, palette) } : {}),
    });
    const align = { left: 1, center: 2, right: 3, justify: 5 }[look.align] ?? 0;
    const valign = { top: 0, middle: 1 }[look.valign] ?? 2;
    const b = look.borders ?? {};
    const kind = (side) => (b[side] ? BORDER[b[side].width] ?? 1 : 0);
    const col = (side) => (b[side] ? colourIndex(b[side].color ?? '#000000', palette) : 0);
    const border1 = (kind('left') | (kind('right') << 4) | (kind('top') << 8) | (kind('bottom') << 12) | (col('left') << 16) | (col('right') << 23)) >>> 0;
    const fill = look.bg ? colourIndex(look.bg, palette) : 0;
    const border2 = ((col('top') & 0x7f) | ((col('bottom') & 0x7f) << 7) | ((look.bg ? 1 : 0) << 26)) >>> 0;
    const rotation = look.rotate ? (look.rotate > 0 ? Math.min(90, look.rotate) : 90 - Math.max(-90, look.rotate)) : 0;
    xfs.push({ font, format: formatIndex(look.format), align: align | (look.wrap ? 0x08 : 0) | (valign << 4), rotation, indent: Math.min(15, Math.round(look.indent ?? 0)), border1, border2, fill: fill | (64 << 7) });
    const index = 16 + xfs.length - 1 + 5;
    xfOf.set(name, index);
    return index;
  };

  // Cells first, so the styles they use are known.
  const strings = [];
  const stringIndex = new Map();
  const sst = (text) => {
    if (!stringIndex.has(text)) { stringIndex.set(text, strings.length); strings.push(text); }
    return stringIndex.get(text);
  };
  const sheetIds = new Map(sheets.map((s, i) => [s.name, i]));
  const xti = [];
  const xtiOf = (name) => {
    const index = sheetIds.get(name);
    if (index === undefined) throw new Error(`A reference to a sheet not in the workbook: ${name}`);
    let found = xti.indexOf(index);
    if (found < 0) { xti.push(index); found = xti.length - 1; }
    return found;
  };
  const sheetStreams = sheets.map((sheet) => {
    const w = new Writer();
    const cellEntries = Object.entries(sheet.cells ?? {}).map(([key, cell]) => { const [r, c] = key.split(',').map(Number); return { r, c, cell }; })
      .filter(({ r, c }) => {
        if (r >= ROWS || c >= COLS) { losses.add('Cells past row 65536 or column IV, which Excel 97 does not have'); return false; }
        return true;
      }).sort((a, b) => a.r - b.r || a.c - b.c);
    const maxRow = cellEntries.reduce((m, e) => Math.max(m, e.r), -1);
    const maxCol = cellEntries.reduce((m, e) => Math.max(m, e.c), -1);
    w.record(0x0809, new Bytes().u16(0x0600).u16(0x0010).u16(0x0dbb).u16(0x07cc).u32(0x000100c1).u32(0x00000006).bytes);
    w.record(0x0055, new Bytes().u16(8).bytes);
    for (const [c, entry] of Object.entries(sheet.cols ?? {})) {
      const col = Number(c);
      if (col >= COLS) continue;
      const px = entry?.w ?? (typeof entry === 'number' ? entry : null);
      const width = px ? Math.max(0, Math.round(((px - 5) / 7) * 256)) : 2340;
      w.record(0x007d, new Bytes().u16(col).u16(col).u16(width).u16(15).u16(entry?.hidden ? 1 : 0).u16(0).bytes);
    }
    w.record(0x0200, new Bytes().u32(0).u32(maxRow + 1).u16(0).u16(maxCol + 1).u16(0).bytes);
    for (const [r, entry] of Object.entries(sheet.rows ?? {})) {
      const row = Number(r);
      if (row >= ROWS) continue;
      const px = entry?.h ?? null;
      const height = px ? Math.round((px * 72) / 96 * 20) : 255;
      w.record(0x0208, new Bytes().u16(row).u16(0).u16(256).u16(height).u16(0).u16(0).u32((entry?.hidden ? 0x20 : 0) | (px ? 0x40 : 0) | 0x100).bytes);
    }
    for (const { r, c, cell } of cellEntries) {
      const xf = xfIndex(cell.s);
      const value = cell.v;
      if (cell.f) {
        let tokens = null;
        try {
          tokens = writeTokens(cell.f, { xti: xtiOf });
        } catch (error) {
          losses.add(`Formulas Excel 97 cannot hold, kept as their values (${String(error.message).replace(/:.*$/, '')})`);
        }
        if (tokens) {
          const result = new Bytes();
          let after = null;
          if (typeof value === 'number') result.f64(value);
          else if (typeof value === 'boolean') result.u8(1).u8(0).u8(value ? 1 : 0).u8(0).u8(0).u8(0).u16(0xffff);
          else if (typeof value === 'string' && ERROR_CODES[value] !== undefined) result.u8(2).u8(0).u8(ERROR_CODES[value]).u8(0).u8(0).u8(0).u16(0xffff);
          else if (typeof value === 'string' && value !== '') { result.u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u16(0xffff); after = value; } else result.u8(3).u8(0).u8(0).u8(0).u8(0).u8(0).u16(0xffff);
          w.record(0x0006, new Bytes().u16(r).u16(c).u16(xf).add(result.list).u16(0x0001).u32(0).u16(tokens.length).add(tokens).bytes);
          if (after !== null) w.record(0x0207, new Bytes().string(after).bytes);
          continue;
        }
      }
      if (typeof value === 'number') w.record(0x0203, new Bytes().u16(r).u16(c).u16(xf).f64(value).bytes);
      else if (typeof value === 'boolean') w.record(0x0205, new Bytes().u16(r).u16(c).u16(xf).u8(value ? 1 : 0).u8(0).bytes);
      else if (typeof value === 'string' && ERROR_CODES[value] !== undefined) w.record(0x0205, new Bytes().u16(r).u16(c).u16(xf).u8(ERROR_CODES[value]).u8(1).bytes);
      else if (typeof value === 'string' && value !== '') w.record(0x00fd, new Bytes().u16(r).u16(c).u16(xf).u32(sst(value)).bytes);
      else w.record(0x0201, new Bytes().u16(r).u16(c).u16(xf).bytes);
    }
    const merges = (sheet.merges ?? []).filter((m) => m.bottom < ROWS && m.right < COLS);
    for (let i = 0; i < merges.length; i += 1000) {
      const part = merges.slice(i, i + 1000);
      const b = new Bytes().u16(part.length);
      for (const m of part) b.u16(m.top).u16(m.bottom).u16(m.left).u16(m.right);
      w.record(0x00e5, b.bytes);
    }
    const frozen = sheet.frozen && (sheet.frozen.rows || sheet.frozen.cols);
    w.record(0x023e, new Bytes().u16(0x06b6 | (frozen ? 0x0108 : 0)).u16(0).u16(0).u32(64).u16(0).u16(0).u32(0).bytes);
    if (frozen) w.record(0x0041, new Bytes().u16(sheet.frozen.cols ?? 0).u16(sheet.frozen.rows ?? 0).u16(sheet.frozen.rows ?? 0).u16(sheet.frozen.cols ?? 0).u8(sheet.frozen.rows && sheet.frozen.cols ? 0 : sheet.frozen.rows ? 2 : 1).u8(0).bytes);
    w.record(0x000a, []);
    return w.bytes();
  });
  if ((document.charts ?? []).length) losses.add('Charts, which this writer of Excel 97 files leaves out');
  if ((document.drawings ?? []).length) losses.add('Drawings, which this writer of Excel 97 files leaves out');
  if (sheets.some((s) => Object.values(s.cells ?? {}).some((c) => c?.n))) losses.add('Comments, which this writer of Excel 97 files leaves out');

  // The globals, with each sheet's offset worked out from the size of what comes before.
  const globals = (offsets) => {
    const w = new Writer();
    w.record(0x0809, new Bytes().u16(0x0600).u16(0x0005).u16(0x0dbb).u16(0x07cc).u32(0x000100c1).u32(0x00000006).bytes);
    w.record(0x0042, new Bytes().u16(1200).bytes);
    w.record(0x003d, new Bytes().u16(0).u16(0).u16(0x4000).u16(0x2000).u16(0x0038).u16(0).u16(0).u16(1).u16(0x0258).bytes);
    w.record(0x0022, new Bytes().u16(0).bytes);
    // The palette, so the colours the document uses come out as they are.
    const pal = new Bytes().u16(56);
    for (const hex of palette) pal.u8(parseInt(hex.slice(0, 2), 16)).u8(parseInt(hex.slice(2, 4), 16)).u8(parseInt(hex.slice(4, 6), 16)).u8(0);
    w.record(0x0092, pal.bytes);
    // Font four is never named by a cell, so after the fourth record every number is one higher; four at least are written.
    const fontRecord = (f) => w.record(0x0031, new Bytes().u16(Math.round(f.size * 20)).u16((f.italic ? 2 : 0) | (f.strike ? 8 : 0)).u16(f.color ?? 0x7fff).u16(f.bold ? 700 : 400).u16(0).u8(f.underline ?? 0).u8(0).u8(0).u8(0).string(f.name, 1).bytes);
    fonts.forEach(fontRecord);
    for (let k = fonts.length; k < 4; k += 1) fontRecord({ name: 'Arial', size: 10 });
    for (const [code, index] of formats) w.record(0x041e, new Bytes().u16(index).string(code).bytes);
    // Fifteen style XFs, the default cell XF, and Excel's five built-in style XFs, then the document's.
    const xf = (font, format, type, align, extra = { rotation: 0, indent: 0, border1: 0, border2: 0, fill: 0x20c0 }) =>
      w.record(0x00e0, new Bytes().u16(font).u16(format).u16(type).u8(align).u8(extra.rotation).u8(extra.indent).u8(type & 4 ? 0 : 0xfc).u32(extra.border1).u32(extra.border2).u16(extra.fill).bytes);
    for (let i = 0; i < 15; i += 1) xf(0, 0, 0xfff5, 0x20, { rotation: 0, indent: 0, border1: 0, border2: 0, fill: 0x20c0 });
    xf(0, 0, 0x0001, 0x20);
    for (const format of [43, 41, 44, 42, 9]) xf(0, format, 0xfff5, 0x20);
    for (const x of xfs) xf(x.font, x.format, 0x0001, x.align, x);
    w.record(0x0293, new Bytes().u16(0x8000).u8(0).u8(0xff).bytes);
    sheets.forEach((sheet, i) => w.record(0x0085, new Bytes().u32(offsets[i] ?? 0).u8(sheet.hidden ? 1 : 0).u8(0).string(sheet.name ?? `Sheet${i + 1}`, 1).bytes));
    if (xti.length) {
      w.record(0x01ae, new Bytes().u16(sheets.length).u16(0x0401).bytes);
      const ext = new Bytes().u16(xti.length);
      for (const index of xti) ext.u16(0).u16(index).u16(index);
      w.record(0x0017, ext.bytes);
    }
    // Shared strings, cut into records at a string's edge or in its characters with the flag repeated.
    const parts = [];
    let chunk = new Bytes().u32(strings.length).u32(strings.length);
    const flush = () => { parts.push(chunk.bytes); chunk = new Bytes(); };
    for (const text of strings) {
      const value = String(text).slice(0, 32767);
      if (chunk.length + 3 + 2 > 8224) flush();
      chunk.u16(value.length).u8(1);
      for (let i = 0; i < value.length; i += 1) {
        if (chunk.length + 2 > 8224) { flush(); chunk.u8(1); }
        chunk.u16(value.charCodeAt(i));
      }
    }
    parts.push(chunk.bytes);
    parts.forEach((p, i) => w.record(i === 0 ? 0x00fc : 0x003c, p));
    w.record(0x000a, []);
    return w.bytes();
  };
  // A first pass sizes the globals; the offsets do not change their length.
  const sized = globals([]).length;
  const offsets = [];
  let at = sized;
  for (const s of sheetStreams) { offsets.push(at); at += s.length; }
  const head = globals(offsets);
  const stream = new Uint8Array(head.length + sheetStreams.reduce((n, s) => n + s.length, 0));
  stream.set(head, 0);
  let pos = head.length;
  for (const s of sheetStreams) { stream.set(s, pos); pos += s.length; }
  const bytes = writeCfb(new Map([['Workbook', stream]]));
  return { bytes, losses };
}

/** readXls with a damaged file's out-of-range reads reported as damage, never as a crash. */
export function readXls(bytes) {
  try {
    return readXlsUnsafe(bytes);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw new Error('This file is damaged and cannot be read');
    throw error;
  }
}

// Excel 2, 3 and 4

/**
 * A worksheet of Excel 2 to 4, or a workbook of Excel 4: one stream of records, outside a compound file.
 * Their values come across; their formulas, in tokens older than any Grid writes, are kept as their values.
 */
function readOldBiff(bytes) {
  const all = records(bytes);
  const bof = all[0];
  if (!bof || ![0x0009, 0x0209, 0x0409].includes(bof.type)) throw new Error('This is not an Excel file GRT knows');
  const losses = new Losses();
  const mode = { biff: 4, decode: codePage(1252) };
  const names = [];
  const sheets = [];
  let current = null;
  let pending = null;
  let formulas = false;
  for (const record of all) {
    const c = new Cursor(record, mode);
    const d = record.data;
    const put = (row, col, value) => {
      if (!current || row >= ROWS || col >= COLS || value === undefined || value === null || value === '') return;
      current.cells[`${row},${col}`] = { v: value };
    };
    switch (record.type) {
      case 0x0009: case 0x0209: case 0x0409: {
        // A worksheet begins; a workbook's own first record only holds the sheets' names.
        const kind = d.length >= 4 ? d[2] | (d[3] << 8) : 0x0010;
        if (kind === 0x0010 || record.type === 0x0009) { current = { name: names[sheets.length] ?? `Sheet${sheets.length + 1}`, cells: {} }; sheets.push(current); }
        break;
      }
      case 0x000a: current = null; break;
      case 0x0042: mode.decode = codePage(c.u16()); break;
      case 0x008e: { c.at += 6; names.push(c.string(1)); break; }
      case 0x0002: { const row = c.u16(); const col = c.u16(); c.at += 3; put(row, col, c.u16()); break; }
      case 0x0003: { const row = c.u16(); const col = c.u16(); put(row, col, c.view.getFloat64(7, true)); break; }
      case 0x0004: { const row = c.u16(); const col = c.u16(); c.at += 3; put(row, col, c.string(1)); break; }
      case 0x0005: { const row = c.u16(); const col = c.u16(); c.at += 3; const value = c.u8(); put(row, col, c.u8() ? errorText(value) : value === 1); break; }
      case 0x0203: { const row = c.u16(); const col = c.u16(); put(row, col, c.view.getFloat64(6, true)); break; }
      case 0x0204: { const row = c.u16(); const col = c.u16(); c.u16(); put(row, col, c.string(2)); break; }
      case 0x0205: { const row = c.u16(); const col = c.u16(); c.u16(); const value = c.u8(); put(row, col, c.u8() ? errorText(value) : value === 1); break; }
      case 0x027e: { const row = c.u16(); const col = c.u16(); c.u16(); put(row, col, rkValue(c.u32())); break; }
      case 0x0006: case 0x0206: case 0x0406: {
        const row = c.u16();
        const col = c.u16();
        // Excel 2 keeps three bytes of looks where later ones keep a format number.
        const at = record.type === 0x0006 ? 7 : 6;
        formulas = true;
        if (d[at + 6] === 0xff && d[at + 7] === 0xff) {
          const kind = d[at];
          if (kind === 0) pending = { row, col };
          else put(row, col, kind === 1 ? d[at + 2] === 1 : kind === 2 ? errorText(d[at + 2]) : null);
        } else put(row, col, c.view.getFloat64(at, true));
        break;
      }
      case 0x0007: case 0x0207: {
        if (pending) { put(pending.row, pending.col, c.string(record.type === 0x0007 ? 1 : 2)); pending = null; }
        break;
      }
      default: break;
    }
  }
  if (!sheets.length) throw new Error('This workbook has no sheets');
  if (formulas) losses.add('Formulas of Excel 4 and older, kept as their values');
  losses.add('Looks, widths and heights of Excel 4 and older files');
  return { document: { version: 1, type: 'grid', sheets, styles: {}, charts: [] }, losses };
}
