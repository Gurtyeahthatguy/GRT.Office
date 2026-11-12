import { readPackage } from './package.js';
import { readOds } from './formats/ods.js';
import { readXlsx } from './formats/xlsx.js';
import { parseCsv, sniff } from './csv.js';

/** Where a live node takes its value: a cell of a spreadsheet, or a column of a Tables database read without running anything in it. */

// A database or a spreadsheet from outside is hostile until read: every count has a ceiling.
export const SOURCE_LIMITS = { rows: 200_000, pages: 1_000_000, depth: 40, tables: 500, payload: 16 * 1024 * 1024 };

class SourceError extends Error {}
const fail = (message) => {
  throw new SourceError(message);
};

// SQLite, read only: the file format, not the engine. Nothing in the file is executed.

/**
 * The tables of a SQLite file with their columns and rows.
 * @param {Uint8Array} bytes
 * @returns {{tables: {name: string, columns: string[], rows: any[][]}[], notes: string[]}}
 */
export function readSqlite(bytes) {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  if (header !== 'SQLite format 3\0') fail('That is not a SQLite database');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawSize = view.getUint16(16);
  const pageSize = rawSize === 1 ? 65536 : rawSize;
  if (pageSize < 512 || (pageSize & (pageSize - 1))) fail('The database has a page size SQLite never writes');
  const usable = pageSize - bytes[20];
  const encoding = view.getUint32(56);
  const decoder = new TextDecoder(encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8');
  const pageCount = Math.min(Math.floor(bytes.length / pageSize), SOURCE_LIMITS.pages);
  const notes = [];

  const varint = (at) => {
    let value = 0n;
    for (let i = 0; i < 9; i += 1) {
      const byte = bytes[at + i];
      if (byte === undefined) fail('A record runs past the end of the file');
      if (i === 8) return { value: (value << 8n) | BigInt(byte), size: 9 };
      value = (value << 7n) | BigInt(byte & 0x7f);
      if (!(byte & 0x80)) return { value, size: i + 1 };
    }
    return { value, size: 9 };
  };

  /** The payload of a cell, gathered from its overflow pages when it does not fit on its own. */
  const payload = (at, length) => {
    if (length > SOURCE_LIMITS.payload) fail('A value is too long to read safely');
    const max = usable - 35;
    if (length <= max) return bytes.subarray(at, at + length);
    const min = Math.floor(((usable - 12) * 32) / 255) - 23;
    let local = min + ((length - min) % (usable - 4));
    if (local > max) local = min;
    const out = new Uint8Array(length);
    out.set(bytes.subarray(at, at + local));
    let got = local;
    let page = view.getUint32(at + local);
    const seen = new Set();
    while (got < length && page) {
      if (page > pageCount || seen.has(page)) fail('An overflow chain is broken');
      seen.add(page);
      const start = (page - 1) * pageSize;
      const take = Math.min(usable - 4, length - got);
      out.set(bytes.subarray(start + 4, start + 4 + take), got);
      got += take;
      page = view.getUint32(start);
    }
    return out;
  };

  /** The values of one record. */
  const record = (data) => {
    const rv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const head = varintIn(data, 0);
    let at = head.size;
    const types = [];
    while (at < Number(head.value) && types.length < 2000) {
      const t = varintIn(data, at);
      types.push(Number(t.value));
      at += t.size;
    }
    let body = Number(head.value);
    return types.map((type) => {
      let value;
      if (type === 0) value = null;
      else if (type >= 1 && type <= 6) {
        const size = [0, 1, 2, 3, 4, 6, 8][type];
        let n = 0n;
        for (let i = 0; i < size; i += 1) n = (n << 8n) | BigInt(data[body + i] ?? 0);
        if (n >> BigInt(size * 8 - 1)) n -= 1n << BigInt(size * 8);
        value = n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
        body += size;
      } else if (type === 7) {
        value = body + 8 <= data.length ? rv.getFloat64(body) : null;
        body += 8;
      } else if (type === 8 || type === 9) value = type - 8;
      else if (type >= 12) {
        const length = Math.floor((type - (type % 2 ? 13 : 12)) / 2);
        const piece = data.subarray(body, body + length);
        value = type % 2 ? decoder.decode(piece) : `«${length} bytes»`;
        body += length;
      } else value = null;
      return value;
    });
  };
  const varintIn = (data, at) => {
    let value = 0n;
    for (let i = 0; i < 9; i += 1) {
      const byte = data[at + i] ?? 0;
      if (i === 8) return { value: (value << 8n) | BigInt(byte), size: 9 };
      value = (value << 7n) | BigInt(byte & 0x7f);
      if (!(byte & 0x80)) return { value, size: i + 1 };
    }
    return { value, size: 9 };
  };

  /** Every row of a table b-tree, in rowid order. */
  const walk = (root) => {
    const rows = [];
    const seen = new Set();
    const visit = (page, depth) => {
      if (depth > SOURCE_LIMITS.depth || page < 1 || page > pageCount || seen.has(page)) fail('The database pages point somewhere they should not');
      seen.add(page);
      const base = (page - 1) * pageSize;
      const at = page === 1 ? base + 100 : base;
      const kind = bytes[at];
      const cells = view.getUint16(at + 3);
      if (kind === 0x05) {
        for (let i = 0; i < cells; i += 1) {
          const pointer = base + view.getUint16(at + 12 + i * 2);
          visit(view.getUint32(pointer), depth + 1);
        }
        visit(view.getUint32(at + 8), depth + 1);
      } else if (kind === 0x0d) {
        for (let i = 0; i < cells; i += 1) {
          let pointer = base + view.getUint16(at + 8 + i * 2);
          const length = varint(pointer);
          pointer += length.size;
          const rowid = varint(pointer);
          pointer += rowid.size;
          rows.push({ rowid: Number(rowid.value), values: record(payload(pointer, Number(length.value))) });
          if (rows.length > SOURCE_LIMITS.rows) fail('The table has too many rows to read safely');
        }
      } else {
        fail('A table page is not one');
      }
    };
    visit(root, 0);
    return rows;
  };

  const tables = [];
  for (const { values } of walk(1)) {
    const [type, name, , rootpage, sql] = values;
    if (type !== 'table' || /^sqlite_/i.test(name) || !rootpage) continue;
    if (/WITHOUT\s+ROWID/i.test(sql ?? '')) {
      notes.push(`${name} is kept in a way GRT does not read yet`);
      continue;
    }
    if (tables.length >= SOURCE_LIMITS.tables) break;
    const columns = columnsOf(sql ?? '');
    const key = columns.findIndex((c) => c.rowid);
    const rows = walk(Number(rootpage)).map(({ rowid, values: row }) => columns.map((c, i) => (i === key ? rowid : row[i] ?? null)));
    tables.push({ name, columns: columns.map((c) => c.name), rows });
  }
  return { tables, notes };
}

/** The column names of a CREATE TABLE, and which one is the rowid itself. */
function columnsOf(sql) {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open === -1 || close <= open) return [];
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of sql.slice(open + 1, close)) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === '`' || ch === "'" || ch === '[') quote = ch === '[' ? ']' : ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(p)).map((p) => {
    const match = /^("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|\S+)\s*(.*)$/s.exec(p);
    const name = match[1].replace(/^["`[]|["`\]]$/g, '').replace(/""/g, '"');
    return { name, rowid: /^INTEGER\s+PRIMARY\s+KEY\b/i.test(match[2].trim()) && !/\bDESC\b/i.test(match[2]) };
  });
}

// Values from what was read

export const AGGREGATES = { value: 'The value', sum: 'Sum', count: 'Count', avg: 'Average', min: 'Minimum', max: 'Maximum' };

/**
 * One value out of a table: a column's sum, count and so on, over the rows where another column has a given value.
 * @param {{columns: string[], rows: any[][]}} table
 * @param {{column: string, aggregate?: string, where?: string, equals?: string}} pick
 */
export function pickValue(table, { column, aggregate = 'value', where = '', equals = '' }) {
  const at = table.columns.indexOf(column);
  if (at === -1) return null;
  const filter = table.columns.indexOf(where);
  const rows = filter === -1 ? table.rows : table.rows.filter((row) => String(row[filter] ?? '') === String(equals));
  const values = rows.map((row) => row[at]).filter((v) => v !== null && v !== undefined && v !== '');
  const numbers = values.map(Number).filter(Number.isFinite);
  switch (aggregate) {
    case 'sum': return numbers.reduce((a, b) => a + b, 0);
    case 'count': return values.length;
    case 'avg': return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    case 'min': return numbers.length ? Math.min(...numbers) : null;
    case 'max': return numbers.length ? Math.max(...numbers) : null;
    default: return values[0] ?? null;
  }
}

/** A cell reference such as B3 or Sheet1.B3, as a row and a column counted from zero. */
export function parseCell(ref) {
  const match = /^(?:(.+)[.!])?\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(ref ?? '').trim());
  if (!match) return null;
  const col = [...match[2].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { sheet: match[1]?.replace(/^'|'$/g, '') ?? null, row: Number(match[3]) - 1, col };
}

/**
 * A spreadsheet's sheets as tables, the first row naming the columns, and the value of one cell.
 * @param {{sheets: {name: string, cells: Object<string, {v?: any}>}[]}} document from the core readers
 */
export function sheetTables(document) {
  return document.sheets.map((sheet) => {
    const cells = Object.entries(sheet.cells ?? {}).map(([key, cell]) => [...key.split(',').map(Number), cell?.v ?? null]);
    const bottom = Math.max(-1, ...cells.map(([r]) => r));
    const right = Math.max(-1, ...cells.map(([, c]) => c));
    const grid = Array.from({ length: Math.min(bottom + 1, SOURCE_LIMITS.rows) }, () => Array(right + 1).fill(null));
    for (const [r, c, v] of cells) if (grid[r]) grid[r][c] = typeof v === 'object' && v !== null ? null : v;
    const [head = [], ...rows] = grid;
    return { name: sheet.name, columns: head.map((h, i) => (h === null || h === '' ? `Column ${i + 1}` : String(h))), rows, grid };
  });
}

export function cellValue(tables, ref) {
  const at = parseCell(ref);
  if (!at) return null;
  const table = at.sheet ? tables.find((t) => t.name === at.sheet) : tables[0];
  return table?.grid?.[at.row]?.[at.col] ?? null;
}

/** A value as a node shows it. */
export function shownValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  return String(value);
}

/** The tables a source file holds: sheets of a spreadsheet, or tables of a database. Nothing in it is run. */
export async function readSource(path, { readBytes, readText }) {
  if (/\.(sqlite|sqlite3|db)$/i.test(path)) return { kind: 'database', ...readSqlite(await readBytes(path)) };
  if (/\.csv$/i.test(path)) {
    const text = await readText(path);
    const rows = parseCsv(text, { separator: sniff(text).separator ?? ',' });
    const cells = {};
    rows.slice(0, SOURCE_LIMITS.rows).forEach((row, r) => row.forEach((v, c) => { cells[`${r},${c}`] = { v: v !== '' && Number.isFinite(Number(v)) ? Number(v) : v }; }));
    return { kind: 'sheet', tables: sheetTables({ sheets: [{ name: 'Sheet1', cells }] }), notes: [] };
  }
  const document = /\.fods$/i.test(path) ? readOds(await readText(path)).document
    : /\.xlsx$/i.test(path) ? readXlsx(await readPackage(path)).document : readOds(await readPackage(path)).document;
  return { kind: 'sheet', tables: sheetTables(document), notes: [] };
}

export const SOURCE_FILTERS = [
  { name: 'Spreadsheets and databases', extensions: ['ods', 'fods', 'xlsx', 'csv', 'sqlite', 'db', 'sqlite3'] },
  { name: 'Spreadsheets', extensions: ['ods', 'fods', 'xlsx', 'csv'] },
  { name: 'Tables databases', extensions: ['sqlite', 'db', 'sqlite3'] },
];
