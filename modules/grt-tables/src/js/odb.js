/** LibreOffice Base files: tables, rows, views and queries read from HSQLDB or Firebird inside a .odb, and written back as HSQLDB. */

import { parseXml, kids, attr, escapeAttr } from './core/xml.js';
import { odfPackage, ODF_VERSION } from './core/formats/odf.js';
import { quoteIdent } from './schema.js';

export const ODB_MIMETYPE = 'application/vnd.oasis.opendocument.base';
const NS_DB = 'urn:oasis:names:tc:opendocument:xmlns:database:1.0';
const NS_XLINK = 'http://www.w3.org/1999/xlink';

// A file from outside is hostile until read: every count and size has a ceiling.
export const ODB_LIMITS = { tables: 500, columns: 1000, rows: 2_000_000, cell: 16 * 1024 * 1024, record: 4 * 1024 * 1024, statements: 5_000_000 };

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');
const DAY = 86400000;

class OdbError extends Error {}
const fail = (message) => {
  throw new OdbError(message);
};

/**
 * A .odb package read into tables with their rows, plus its queries, forms and reports by name.
 * @param {{text: (name: string) => ?string, bytes: (name: string) => ?Uint8Array, names: string[]}} pkg
 */
export function readOdb(pkg) {
  const losses = [];
  const content = pkg.text('content.xml');
  if (!content) fail('That file has no content.xml: it is not a Base database');
  const doc = parseXml(content, 'the database');
  const source = doc.getElementsByTagNameNS(NS_DB, 'connection-resource')[0];
  const url = source ? attr(source, NS_XLINK, 'href') ?? '' : '';
  const queries = [...doc.getElementsByTagNameNS(NS_DB, 'query')].map((q) => ({
    name: attr(q, NS_DB, 'name') ?? 'Query', sql: attr(q, NS_DB, 'command') ?? '',
  })).filter((q) => q.sql);
  const components = (kind) => [...doc.getElementsByTagNameNS(NS_DB, kind)].flatMap((holder) => collect(holder, ''));
  const collect = (holder, prefix) => kids(holder).flatMap((child) => {
    const name = attr(child, NS_DB, 'name') ?? '';
    if (child.localName === 'component-collection') return collect(child, `${prefix}${name}/`);
    if (child.localName !== 'component') return [];
    return [{ name: `${prefix}${name}`, href: attr(child, NS_XLINK, 'href') ?? '' }];
  });
  const forms = components('forms').map((f) => readForm(pkg, f)).filter(Boolean);
  const reports = components('reports').map((r) => readReport(pkg, r)).filter(Boolean);

  let database;
  if (/embedded:hsqldb/i.test(url) || pkg.bytes('database/script')) {
    database = readHsqldb(pkg, losses);
  } else if (/embedded:firebird/i.test(url) || pkg.bytes('database/firebird.fbk')) {
    const backup = pkg.bytes('database/firebird.fbk');
    database = backup ? readFirebird(backup, losses) : { tables: [], views: [] };
  } else {
    fail('That database keeps its data on a server or in another file, which GRT does not connect to');
  }
  return { ...database, queries, forms, reports, losses };
}

// HSQLDB 1.8: the script holds the schema and the rows of MEMORY tables; cached rows are in database/data.

/** The script's string and identifier escapes: \uXXXX for anything outside ASCII. */
const unescape = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

/** A statement cut into tokens: quoted names, strings, numbers, words and punctuation. */
function tokens(line) {
  const out = [];
  const re = /\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?(?:E[-+]?\d+)?)|([A-Za-z_][\w$]*)|(\S))/gy;
  let match;
  while ((match = re.exec(line)) && match[0].trim()) {
    if (match[1] !== undefined) out.push({ name: unescape(match[1].replace(/""/g, '"')) });
    else if (match[2] !== undefined) out.push({ string: unescape(match[2].replace(/''/g, "'")) });
    else if (match[3] !== undefined) out.push({ number: match[3] });
    else if (match[4] !== undefined) out.push({ word: match[4].toUpperCase(), raw: match[4] });
    else out.push({ punct: match[5] });
  }
  return out;
}

/** Splits tokens at the commas of one level of brackets. */
function splitTop(list) {
  const parts = [[]];
  let depth = 0;
  for (const token of list) {
    if (token.punct === '(') depth += 1;
    if (token.punct === ')') depth -= 1;
    if (token.punct === ',' && depth === 0) parts.push([]);
    else parts.at(-1).push(token);
  }
  return parts.filter((part) => part.length);
}

/** The tokens inside the brackets that open at `start`, and where they end. */
function bracket(list, start) {
  let depth = 0;
  for (let i = start; i < list.length; i += 1) {
    if (list[i].punct === '(') depth += 1;
    if (list[i].punct === ')') {
      depth -= 1;
      if (depth === 0) return { inside: list.slice(start + 1, i), end: i };
    }
  }
  return { inside: list.slice(start + 1), end: list.length };
}

const nameOf = (token) => token?.name ?? token?.raw ?? '';
const namesIn = (list) => list.filter((t) => t.name !== undefined || t.word).map(nameOf);

/** A column type of HSQLDB as SQLite declares it, keeping its size so it goes back the same. */
function hsqlType(words) {
  const base = words[0]?.word ?? 'VARCHAR';
  const size = words[1]?.punct === '(' ? `(${words.slice(2).filter((t) => t.number).map((t) => t.number).join(',')})` : '';
  return { kind: base === 'VARCHAR_IGNORECASE' ? 'VARCHAR' : base, declared: `${base === 'VARCHAR_IGNORECASE' ? 'VARCHAR' : base}${size}` };
}

function parseCreateTable(list, losses) {
  // CREATE [MEMORY|CACHED|TEXT|TEMP] TABLE "name"( ... )
  const at = list.findIndex((t) => t.word === 'TABLE');
  const name = nameOf(list[at + 1]);
  const kind = list[1]?.word;
  const open = list.findIndex((t, i) => i > at && t.punct === '(');
  const table = { name, columns: [], primaryKey: [], foreignKeys: [], indexes: [], rows: [], cached: kind === 'CACHED', text: kind === 'TEXT' };
  for (const part of splitTop(bracket(list, open).inside)) {
    if (part[0].word === 'CONSTRAINT' || ['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'].includes(part[0].word)) {
      constraint(table, part[0].word === 'CONSTRAINT' ? part.slice(2) : part, losses, part[0].word === 'CONSTRAINT' ? nameOf(part[1]) : null);
      continue;
    }
    const column = { name: nameOf(part[0]) };
    const typeEnd = part.findIndex((t, i) => i > 1 && t.word && !['('].includes(t.punct));
    Object.assign(column, hsqlType(part.slice(1, typeEnd === -1 ? undefined : typeEnd)));
    const words = part.map((t) => t.word).filter(Boolean);
    if (words.includes('IDENTITY')) column.autoIncrement = true;
    const start = part.findIndex((t) => t.word === 'START');
    if (start !== -1 && part[start + 2]?.number) column.start = Number(part[start + 2].number);
    if (words.includes('NOT') && words[words.indexOf('NOT') + 1] === 'NULL') column.notNull = true;
    if (words.includes('PRIMARY')) table.primaryKey = [column.name];
    if (words.includes('UNIQUE')) table.indexes.push({ columns: [column.name], unique: true });
    const fallback = part.findIndex((t) => t.word === 'DEFAULT');
    if (fallback !== -1) column.default = literalOf(part[fallback + 1], part[fallback + 2]);
    table.columns.push(column);
  }
  return table;
}

/** A default kept only when it is a plain value; anything computed is left out. */
function literalOf(token, next) {
  if (token?.string !== undefined) return { value: token.string };
  if (token?.number !== undefined) return { value: Number(token.number) };
  if (token?.punct === '-' && next?.number !== undefined) return { value: -Number(next.number) };
  if (token?.word === 'TRUE' || token?.word === 'FALSE') return { value: token.word === 'TRUE' ? 1 : 0 };
  return null;
}

function constraint(table, part, losses, name) {
  const word = part[0].word;
  const open = part.findIndex((t) => t.punct === '(');
  const { inside, end } = bracket(part, open);
  const columns = namesIn(inside);
  if (word === 'PRIMARY') table.primaryKey = columns;
  else if (word === 'UNIQUE') table.indexes.push({ name, columns, unique: true });
  else if (word === 'FOREIGN') {
    const ref = part.findIndex((t, i) => i > end && t.word === 'REFERENCES');
    const target = nameOf(part[ref + 1]);
    const targetOpen = part.findIndex((t, i) => i > ref && t.punct === '(');
    const to = targetOpen === -1 ? [] : namesIn(bracket(part, targetOpen).inside);
    const words = part.map((t) => t.word);
    const onDelete = words.includes('DELETE') ? words.slice(words.indexOf('DELETE') + 1, words.indexOf('DELETE') + 3).filter((w) => ['CASCADE', 'SET', 'NULL', 'DEFAULT', 'NO', 'ACTION', 'RESTRICT'].includes(w)).join(' ') : null;
    table.foreignKeys.push({ name, columns, table: target, toColumns: to, onDelete });
  } else {
    losses.push(`The check "${name ?? 'unnamed'}" on ${table.name} was left out`);
  }
}

/** A value of the script: a literal read by the column it goes into. */
function scriptValue(token, next, column) {
  if (!token || token.word === 'NULL') return null;
  if (token.word === 'TRUE') return 1;
  if (token.word === 'FALSE') return 0;
  const kind = column?.kind ?? '';
  if (token.string !== undefined) {
    if (/BINARY|OTHER/.test(kind)) return hexBytes(token.string);
    if (kind === 'TIMESTAMP') return token.string.replace(/\.0+$/, '');
    if (kind === 'CHAR') return token.string.replace(/ +$/, '');
    return token.string;
  }
  if (token.number !== undefined) return numberValue(token.number);
  if (token.punct === '-' && next?.number !== undefined) return numberValue(`-${next.number}`);
  return null;
}

const numberValue = (text) => {
  const n = Number(text);
  // A decimal too long for a double stays as its digits, so nothing is rounded away.
  return Number.isFinite(n) && (Number.isSafeInteger(n) || !/^-?\d{16,}/.test(text)) ? n : text;
};

function hexBytes(text) {
  const clean = text.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readHsqldb(pkg, losses) {
  const scriptBytes = pkg.bytes('database/script');
  if (!scriptBytes) return { tables: [], views: [] };
  const properties = Object.fromEntries((pkg.text('database/properties') ?? '').split(/\r?\n/).map((l) => l.split('=')).filter((p) => p.length === 2));
  if (properties['hsqldb.script_format'] && properties['hsqldb.script_format'] !== '0') fail('That database script is compressed, which GRT cannot read yet');
  const scale = Number(properties['hsqldb.cache_file_scale'] ?? 1) || 1;
  const lines = latin1.decode(scriptBytes).split(/\r?\n/);
  if (lines.length > ODB_LIMITS.statements) fail('That database script is too long to read safely');
  const tables = new Map();
  const views = [];
  const roots = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const list = tokens(line);
    const [a, b] = [list[0]?.word, list[1]?.word];
    if (a === 'CREATE' && list.some((t, i) => i < 3 && t.word === 'TABLE')) {
      if (tables.size >= ODB_LIMITS.tables) fail('That database has too many tables');
      const table = parseCreateTable(list, losses);
      if (table.columns.length > ODB_LIMITS.columns) fail('That table has too many columns');
      if (table.text) losses.push(`${table.name} is a text table, linked to a file outside the database: its rows were left out`);
      tables.set(table.name, table);
    } else if (a === 'CREATE' && (b === 'INDEX' || (b === 'UNIQUE' && list[2]?.word === 'INDEX'))) {
      const unique = b === 'UNIQUE';
      const name = nameOf(list[unique ? 3 : 2]);
      const on = list.findIndex((t) => t.word === 'ON');
      const open = list.findIndex((t, i) => i > on && t.punct === '(');
      tables.get(nameOf(list[on + 1]))?.indexes.push({ name, columns: namesIn(bracket(list, open).inside), unique });
    } else if (a === 'CREATE' && b === 'VIEW') {
      const as = line.search(/\)\s*AS\s|"\s+AS\s/i);
      const sql = as === -1 ? null : line.slice(line.indexOf('AS', as) + 2).trim();
      if (sql) views.push({ name: nameOf(list[2]), sql: unescape(sql) });
    } else if (a === 'ALTER' && b === 'TABLE') {
      const table = tables.get(nameOf(list[2]));
      if (!table) continue;
      if (list[3]?.word === 'ADD' && list[4]?.word === 'CONSTRAINT') constraint(table, list.slice(6), losses, nameOf(list[5]));
      const restart = list.findIndex((t) => t.word === 'RESTART');
      if (restart !== -1 && list[restart + 2]?.number) {
        const column = table.columns.find((c) => c.name === nameOf(list[restart - 1]));
        if (column) column.next = Number(list[restart + 2].number);
      }
    } else if (a === 'SET' && b === 'TABLE' && list[3]?.word === 'INDEX') {
      roots.set(nameOf(list[2]), (list[4]?.string ?? '').trim().split(/\s+/).map(Number));
    } else if (a === 'INSERT' && b === 'INTO') {
      const table = tables.get(nameOf(list[2]));
      if (!table) continue;
      const open = list.findIndex((t) => t.punct === '(');
      const values = splitTop(bracket(list, open).inside);
      table.rows.push(table.columns.map((column, i) => scriptValue(values[i]?.[0], values[i]?.[1], column)));
      if (table.rows.length > ODB_LIMITS.rows) fail('That table has too many rows to open safely');
    }
  }
  const data = pkg.bytes('database/data');
  for (const table of tables.values()) {
    if (!table.cached) continue;
    const list = roots.get(table.name);
    if (!list || !data || list[0] <= 0) continue;
    try {
      table.rows = cachedRows(data, list[0] * scale, Math.max(1, list.length - 1), table, scale);
    } catch (error) {
      losses.push(`The rows of ${table.name} could not all be read: ${error.message}`);
    }
  }
  for (const table of tables.values()) {
    for (const column of table.columns) {
      if (column.autoIncrement && column.next === undefined) column.next = Math.max(column.start ?? 0, ...table.rows.map((r) => Number(r[table.columns.indexOf(column)]) + 1).filter(Number.isFinite));
    }
  }
  return { engine: 'hsqldb', tables: [...tables.values()], views };
}

/** The rows of a cached table, in the order of its primary index: an AVL tree whose nodes sit in each row. */
function cachedRows(data, root, indexCount, table, scale) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rows = [];
  const seen = new Set();
  const stack = [];
  let at = root;
  const left = (p) => view.getInt32(p + 8) * scale;
  const right = (p) => view.getInt32(p + 12) * scale;
  const check = (p) => {
    if (p < 0 || p + 4 + indexCount * 16 > data.length) fail('a row lies outside the file');
    if (seen.has(p)) fail('the index loops');
  };
  while (stack.length || at) {
    while (at) {
      check(at);
      seen.add(at);
      stack.push(at);
      at = left(at);
    }
    const p = stack.pop();
    rows.push(readCachedRow(data, view, p + 4 + indexCount * 16, table));
    if (rows.length > ODB_LIMITS.rows) fail('there are too many rows to open safely');
    at = right(p);
    if (at && seen.has(at)) fail('the index loops');
  }
  return rows;
}

function readCachedRow(data, view, start, table) {
  let q = start;
  const need = (n) => {
    if (q + n > data.length) fail('a row is cut short');
  };
  const int = () => {
    need(4);
    q += 4;
    return view.getInt32(q - 4);
  };
  const long = () => {
    need(8);
    q += 8;
    return view.getBigInt64(q - 8);
  };
  const bytes = () => {
    const n = int();
    if (n < 0 || n > ODB_LIMITS.cell) fail('a value is too long');
    need(n);
    q += n;
    return data.subarray(q - n, q);
  };
  const values = [];
  for (const column of table.columns) {
    need(1);
    if (data[q++] === 0) {
      values.push(null);
      continue;
    }
    const kind = column.kind;
    let value;
    if (kind === 'INTEGER') value = int();
    else if (kind === 'SMALLINT' || kind === 'TINYINT') {
      need(2);
      value = view.getInt16(q);
      q += 2;
    } else if (kind === 'BIGINT') value = safeBig(long());
    else if (['DOUBLE', 'REAL', 'FLOAT'].includes(kind)) {
      need(8);
      value = view.getFloat64(q);
      q += 8;
    } else if (kind === 'NUMERIC' || kind === 'DECIMAL') {
      const raw = bytes();
      value = decimal(signedBig(raw), int());
    } else if (kind === 'BOOLEAN' || kind === 'BIT') {
      need(1);
      value = data[q++] ? 1 : 0;
    } else if (kind === 'DATE') value = isoDate(Number(long()) + DAY / 2);
    else if (kind === 'TIME') value = localTime(Number(long()));
    else if (kind === 'TIMESTAMP') {
      const ms = Number(long());
      int();
      value = localStamp(ms);
    } else if (/BINARY|OTHER|BLOB/.test(kind)) value = new Uint8Array(bytes());
    else value = modifiedUtf8(bytes());
    if (kind === 'CHAR') value = value.replace(/ +$/, '');
    values.push(value);
  }
  return values;
}

const safeBig = (big) => (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString());

function signedBig(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  if (bytes.length && bytes[0] & 0x80) value -= 1n << BigInt(bytes.length * 8);
  return value;
}

/** An unscaled integer and its scale as a number, or as digits when a double would round it. */
function decimal(unscaled, scale) {
  // HSQLDB and Firebird keep scales far below this; a larger one would build a string of that many digits.
  if (!Number.isInteger(scale) || Math.abs(scale) > 1000) fail('a number has a scale no database uses');
  const negative = unscaled < 0n;
  let digits = (negative ? -unscaled : unscaled).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
  } else if (scale < 0) digits += '0'.repeat(-scale);
  const text = `${negative ? '-' : ''}${digits}`;
  return numberValue(text);
}

/** Java's modified UTF-8: a zero is two bytes, and characters past the basic plane are two surrogates. */
function modifiedUtf8(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i];
    if (a < 0x80) {
      out += String.fromCharCode(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0) {
      out += String.fromCharCode(((a & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(((a & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    }
  }
  return out.replace(/\0/g, '');
}

const pad = (n, size = 2) => String(n).padStart(size, '0');
const isoDate = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const localTime = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const localStamp = (ms) => {
  const d = new Date(ms);
  const fraction = d.getMilliseconds() ? `.${pad(d.getMilliseconds(), 3)}` : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${fraction}`;
};

// Firebird: the embedded database is kept as a gbak backup, a stream of records made of attributes.

const REC = { burp: 0, database: 1, globalField: 2, relation: 3, field: 4, index: 5, data: 6, blob: 7, relationData: 8, relationEnd: 9, end: 10, view: 11, generator: 26, relConstraint: 31, refConstraint: 32 };
// Attributes known to hold a blob: a 4-byte length and its bytes, where others have one length byte.
const BLOB_ATTRIBUTES = {
  [REC.database]: [6, 10],
  [REC.globalField]: [5, 15, 16, 17, 18, 19, 20, 21, 35, 36, 37, 39],
  [REC.field]: [5, 15, 16, 17, 18, 19, 20, 21, 35, 36, 37, 39],
  [REC.relation]: [2, 3, 9, 11, 13, 14, 15],
};
const FB_EPOCH = Date.UTC(1858, 10, 17);

function readFirebird(backup, losses) {
  const d = backup;
  let p = 0;
  const byte = () => {
    if (p >= d.length) fail('the backup is cut short');
    return d[p++];
  };
  const le = (bytes) => bytes.reduceRight((value, b) => value * 256 + b, 0);
  const signed = (bytes) => {
    const value = le(bytes);
    return bytes.length && bytes[bytes.length - 1] & 0x80 ? value - 2 ** (8 * bytes.length) : value;
  };

  /** One record's attributes; where the format leaves it open whether a value is a blob, the reading that ends cleanly wins. */
  function attributes(type) {
    const known = new Set(BLOB_ATTRIBUTES[type] ?? []);
    const attempt = (start, guesses) => {
      let q = start;
      const out = [];
      let open = 0;
      for (;;) {
        if (q >= d.length) return null;
        const code = d[q++];
        if (code === 0) return startsRecord(q) ? { out, end: q } : null;
        if (type === REC.data && code === 2) return { out: [...out, [2, null]], end: q };
        if (q >= d.length) return null;
        const n = d[q++];
        const blob = n === 4 && (known.has(code) || guesses[open] === true);
        if (n === 4 && !known.has(code)) open += 1;
        if (blob) {
          if (q + 4 > d.length) return null;
          const length = le(d.subarray(q, q + 4));
          q += 4;
          if (length > ODB_LIMITS.cell || q + length > d.length) return null;
          out.push([code, d.subarray(q, q + length)]);
          q += length;
        } else {
          if (q + n > d.length) return null;
          out.push([code, d.subarray(q, q + n)]);
          q += n;
        }
        if (open > 16) return null;
      }
    };
    // Try every reading of the doubtful attributes, scalar first, until one ends where a record can begin.
    for (let mask = 0; mask < 1 << 12; mask += 1) {
      const guesses = Array.from({ length: 16 }, (_, i) => Boolean(mask & (1 << i)));
      const read = attempt(p, guesses);
      if (read) {
        p = read.end;
        return read.out;
      }
    }
    fail('a record of the backup cannot be read');
  }

  /** Whether a record can begin here: a known type, and a first attribute that fits in the file. */
  function startsRecord(q) {
    if (q >= d.length) return true;
    const type = d[q];
    if (type > 45) return false;
    if (type === REC.end || type === REC.relationEnd) return true;
    if (type === REC.blob || type === REC.data) return q + 2 < d.length;
    const code = d[q + 1];
    return code === 0 || (code < 0x70 && q + 3 + (d[q + 2] ?? 0) <= d.length);
  }

  const tables = [];
  const views = [];
  const byName = new Map();
  const generators = new Map();
  const domains = new Map();
  const indexes = new Map();
  const constraints = [];
  const refs = new Map();
  let relation = null;
  let fields = null;
  let current = null;
  let lastRow = null;
  const text = (bytes, charset = 4) => (charset === 21 || charset === 53 ? latin1 : utf8).decode(bytes ?? new Uint8Array()).replace(/\0+$/, '');

  if (byte() !== REC.burp) fail('That is not a Firebird backup');
  attributes(REC.burp);
  for (let guard = 0; p < d.length; guard += 1) {
    if (guard > ODB_LIMITS.rows * 4) fail('the backup has too many records');
    const type = byte();
    if (type === REC.end) break;
    if (type === REC.relationEnd) continue;
    if (type === REC.data) {
      const attrs = new Map(attributes(REC.data));
      const length = le(attrs.get(0x11) ?? attrs.get(1) ?? new Uint8Array());
      if (!current || length > ODB_LIMITS.record) fail('a row of the backup is too long');
      const buffer = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const count = (byte() << 24) >> 24;
        if (count < 0) {
          const value = byte();
          const end = Math.min(length, got - count);
          buffer.fill(value, got, end);
          got = end;
        } else {
          if (p + count > d.length) fail('the backup is cut short');
          buffer.set(d.subarray(p, p + Math.min(count, length - got)), got);
          got += count;
          p += count;
        }
      }
      lastRow = xdrRow(buffer, current, losses);
      current.rows.push(lastRow);
      if (current.rows.length > ODB_LIMITS.rows) fail('a table has too many rows to open safely');
      continue;
    }
    if (type === REC.blob) {
      let field = -1;
      let segments = 0;
      const parts = [];
      for (;;) {
        const code = byte();
        if (code === 0) break;
        if (code === 7) {
          let total = 0;
          for (let s = 0; s < segments; s += 1) {
            const length = byte() | (byte() << 8);
            total += length;
            if (total > ODB_LIMITS.cell || p + length > d.length) fail('a long value of the backup is too long');
            parts.push(d.subarray(p, p + length));
            p += length;
          }
          break;
        }
        const n = byte();
        const value = signed(d.subarray(p, p + n));
        p += n;
        if (code === 3) field = value;
        if (code === 5) segments = value;
      }
      const at = current?.fieldOrder.findIndex((f) => f.id === field) ?? -1;
      if (lastRow && at !== -1) {
        const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
        let o = 0;
        for (const part of parts) {
          joined.set(part, o);
          o += part.length;
        }
        const f = current.fieldOrder[at];
        lastRow[f.column] = f.subType === 1 ? text(joined, f.charset) : joined;
      }
      continue;
    }
    if (type > 50) fail('the backup has a record GRT does not know');
    const attrs = attributes(type);
    const get = (code) => attrs.find(([c]) => c === code)?.[1];
    const all = (code) => attrs.filter(([c]) => c === code).map(([, v]) => v);
    if (type === REC.relation) {
      const name = text(get(1));
      const viewSource = get(14) ?? get(9);
      if (get(2) || viewSource) {
        relation = null;
        if (viewSource) views.push({ name, sql: text(viewSource) });
        fields = null;
        continue;
      }
      if (tables.length >= ODB_LIMITS.tables) fail('That database has too many tables');
      relation = { name, columns: [], primaryKey: [], foreignKeys: [], indexes: [], rows: [], fieldOrder: [] };
      fields = relation.fieldOrder;
      tables.push(relation);
      byName.set(name, relation);
    } else if (type === REC.globalField) {
      domains.set(text(get(1)), { charLength: get(41) ? signed(get(41)) : null, precision: get(44) ? signed(get(44)) : 0 });
    } else if (type === REC.field && fields) {
      const domain = domains.get(text(get(2))) ?? {};
      if (!get(8) || !get(10)) fail('a column of the backup has no type or length');
      const f = {
        name: text(get(1)), type: signed(get(8)), subType: signed(get(9) ?? [0]), length: signed(get(10)), scale: signed(get(11) ?? [0]),
        position: signed(get(13) ?? [0]), id: signed(get(22) ?? [0]), charset: signed(get(42) ?? [4]), precision: get(44) ? signed(get(44)) : domain.precision ?? 0,
        computed: Boolean(get(23) && signed(get(23))), notNull: Boolean(get(38) && signed(get(38))), charLength: get(41) ? signed(get(41)) : domain.charLength ?? null,
        generator: get(46) ? text(get(46)) : null,
      };
      if (f.computed) {
        losses.push(`The computed column ${f.name} of ${relation.name} was left out`);
        continue;
      }
      fields.push(f);
    } else if (type === REC.relationData) {
      current = byName.get(text(get(1))) ?? null;
      lastRow = null;
      if (current && !current.columns.length) finishColumns(current, losses);
    } else if (type === REC.index) {
      if (!current) continue;
      indexes.set(text(get(1)), { table: current.name, columns: all(5).map((v) => text(v)), unique: Boolean(get(4) && signed(get(4))), references: get(8) ? text(get(8)) : null });
    } else if (type === REC.generator) {
      generators.set(text(get(1)), { value: signed(get(3) ?? [0]), step: signed(get(8) ?? [1]) || 1 });
    } else if (type === REC.relConstraint) {
      constraints.push({ name: text(get(1)), kind: text(get(2)), table: text(get(3)), index: get(6) ? text(get(6)) : null });
    } else if (type === REC.refConstraint) {
      refs.set(text(get(1)), { onDelete: get(5) ? text(get(5)) : null });
    }
  }
  for (const table of tables) if (!table.columns.length) finishColumns(table, losses);
  for (const c of constraints) {
    const table = byName.get(c.table);
    const index = indexes.get(c.index);
    if (!table || !index) continue;
    if (c.kind === 'PRIMARY KEY') table.primaryKey = index.columns;
    else if (c.kind === 'UNIQUE') table.indexes.push({ name: c.name, columns: index.columns, unique: true });
    else if (c.kind === 'FOREIGN KEY') {
      const target = indexes.get(index.references);
      if (target) table.foreignKeys.push({ name: c.name, columns: index.columns, table: target.table, toColumns: target.columns, onDelete: refs.get(c.name)?.onDelete ?? null });
    }
  }
  const owned = new Set(constraints.map((c) => c.index));
  for (const [name, index] of indexes) {
    if (!owned.has(name) && !/^RDB\$/.test(name)) byName.get(index.table)?.indexes.push({ name, columns: index.columns, unique: index.unique });
  }
  for (const table of tables) {
    for (const f of table.fieldOrder) {
      const column = table.columns[f.column];
      if (f.generator && generators.has(f.generator)) {
        column.autoIncrement = true;
        const g = generators.get(f.generator);
        column.next = g.value + g.step;
      }
    }
    delete table.fieldOrder;
  }
  return { engine: 'firebird', tables, views };
}

/** A Firebird field type as SQLite declares it. */
function fbDeclared(f) {
  const numeric = (f.subType === 1 || f.subType === 2 || f.scale < 0) && [7, 8, 16].includes(f.type);
  if (numeric) return { kind: 'NUMERIC', declared: `${f.subType === 2 ? 'DECIMAL' : 'NUMERIC'}(${f.precision || 18},${-f.scale})` };
  switch (f.type) {
    case 7: return { kind: 'SMALLINT', declared: 'SMALLINT' };
    case 8: return { kind: 'INTEGER', declared: 'INTEGER' };
    case 16: return { kind: 'BIGINT', declared: 'BIGINT' };
    case 10: return { kind: 'REAL', declared: 'REAL' };
    case 27: return { kind: 'DOUBLE', declared: 'DOUBLE' };
    case 12: return { kind: 'DATE', declared: 'DATE' };
    case 13: return { kind: 'TIME', declared: 'TIME' };
    case 35: return { kind: 'TIMESTAMP', declared: 'TIMESTAMP' };
    case 23: return { kind: 'BOOLEAN', declared: 'BOOLEAN' };
    case 14: return f.charset === 1 ? { kind: 'BINARY', declared: `BINARY(${f.length})` } : { kind: 'CHAR', declared: `CHAR(${f.charLength ?? f.length})` };
    case 37: return f.charset === 1 ? { kind: 'VARBINARY', declared: `VARBINARY(${f.length})` } : { kind: 'VARCHAR', declared: `VARCHAR(${f.charLength ?? f.length})` };
    case 261: return f.subType === 1 ? { kind: 'LONGVARCHAR', declared: 'TEXT' } : { kind: 'LONGVARBINARY', declared: 'BLOB' };
    default: return null;
  }
}

/** The columns of a relation in their declared order, and each field's place in a row. */
function finishColumns(table, losses) {
  const byPosition = [...table.fieldOrder].sort((a, b) => a.position - b.position);
  for (const f of byPosition) {
    const type = fbDeclared(f);
    if (!type) fail(`the column ${f.name} of ${table.name} has a type GRT cannot read yet`);
    f.column = table.columns.length;
    table.columns.push({ name: f.name, ...type, notNull: f.notNull });
  }
  if (table.columns.length > ODB_LIMITS.columns) fail('That table has too many columns');
}

/** A row in the backup's machine-neutral encoding: each value padded to four bytes, then a flag for each saying whether it is empty. */
function xdrRow(buffer, table, losses) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let q = 0;
  const need = (n) => {
    if (q + n > buffer.length) fail('a row of the backup is cut short');
  };
  const i32 = () => {
    need(4);
    q += 4;
    return view.getInt32(q - 4);
  };
  const i64 = () => {
    need(8);
    q += 8;
    return view.getBigInt64(q - 8);
  };
  const opaque = (n) => {
    need(n);
    const out = buffer.subarray(q, q + n);
    q += (n + 3) & ~3;
    return out;
  };
  const values = new Array(table.columns.length).fill(null);
  const raw = [];
  for (const f of table.fieldOrder) {
    let value;
    switch (f.type) {
      case 7: case 8: value = i32(); break;
      case 16: value = i64(); break;
      case 10: need(4); value = view.getFloat32(q); q += 4; break;
      case 27: need(8); value = view.getFloat64(q); q += 8; break;
      case 12: value = isoDate(FB_EPOCH + i32() * DAY); break;
      case 13: value = fbTime(i32()); break;
      case 35: {
        const day = i32();
        value = `${isoDate(FB_EPOCH + day * DAY)} ${fbTime(i32())}`;
        break;
      }
      case 23: value = opaque(1)[0] ? 1 : 0; break;
      case 14: {
        const bytes = opaque(f.length);
        value = f.charset === 1 ? new Uint8Array(bytes) : utf8.decode(bytes).replace(/ +$/, '');
        break;
      }
      case 37: {
        const length = i32();
        if (length < 0 || length > f.length) fail('a value of the backup is too long');
        const bytes = opaque(length);
        value = f.charset === 1 ? new Uint8Array(bytes) : (f.charset === 21 || f.charset === 53 ? latin1 : utf8).decode(bytes);
        break;
      }
      case 261: opaque(8); value = null; break;
      default: fail(`a value of type ${f.type} cannot be read`);
    }
    if ((f.type === 7 || f.type === 8 || f.type === 16) && (f.scale < 0 || f.subType)) value = decimal(BigInt(value), -f.scale);
    else if (f.type === 16) value = safeBig(value);
    raw.push(value);
  }
  table.fieldOrder.forEach((f, i) => {
    const empty = i32() !== 0;
    values[f.column] = empty ? null : raw[i];
  });
  return values;
}

const fbTime = (units) => {
  const seconds = Math.floor(units / 10000);
  const fraction = units % 10000;
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}${fraction ? `.${pad(Math.round(fraction / 10), 3)}` : ''}`;
};

// Into SQLite: the SQL GRT runs itself, every name quoted and every value a literal; nothing from the file runs.

const sqlText = (value) => `'${String(value).replace(/\0/g, '').replace(/'/g, "''")}'`;

/** A value as a SQLite literal. */
export function sqliteLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) return `X'${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}'`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return sqlText(value);
}

/** The SQLite schema and rows for what a .odb holds, tables in the order their foreign keys need. */
export function sqliteImport(database) {
  const tables = database.tables.filter((t) => t.columns.length);
  const schema = [];
  const data = [];
  for (const table of tables) {
    const single = table.primaryKey.length === 1 ? table.primaryKey[0] : null;
    const lines = table.columns.map((c) => {
      const integerKey = c.name === single && /INT/.test(c.kind);
      const type = integerKey ? 'INTEGER' : c.declared;
      return `  ${quoteIdent(c.name)} ${type}${integerKey ? ' PRIMARY KEY' : ''}${c.autoIncrement && integerKey ? ' AUTOINCREMENT' : ''}${c.notNull && !integerKey ? ' NOT NULL' : ''}${c.default ? ` DEFAULT ${sqliteLiteral(c.default.value)}` : ''}`;
    });
    if (table.primaryKey.length && !(single && table.columns.find((c) => c.name === single && /INT/.test(c.kind)))) lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(', ')})`);
    for (const key of table.foreignKeys) {
      const onDelete = /^(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)$/i.test(key.onDelete ?? '') ? ` ON DELETE ${key.onDelete.toUpperCase()}` : '';
      lines.push(`  FOREIGN KEY (${key.columns.map(quoteIdent).join(', ')}) REFERENCES ${quoteIdent(key.table)}${key.toColumns.length ? ` (${key.toColumns.map(quoteIdent).join(', ')})` : ''}${onDelete}`);
    }
    schema.push(`CREATE TABLE ${quoteIdent(table.name)} (\n${lines.join(',\n')}\n);`);
    table.indexes.forEach((index, i) => {
      const name = index.name || `${table.name}_${i + 1}`;
      schema.push(`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(`${table.name}.${name}`)} ON ${quoteIdent(table.name)} (${index.columns.map(quoteIdent).join(', ')});`);
    });
    const names = table.columns.map((c) => quoteIdent(c.name)).join(', ');
    for (const row of table.rows) data.push(`INSERT INTO ${quoteIdent(table.name)} (${names}) VALUES (${row.map(sqliteLiteral).join(', ')});`);
    const counter = table.columns.find((c) => c.autoIncrement && c.name === single);
    if (counter && counter.next > 0) data.push(`INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (${sqlText(table.name)}, ${Math.max(0, Math.floor(counter.next) - 1)});`);
  }
  return { schema: schema.join('\n'), data: data.join('\n') };
}

// Out to HSQLDB: MEMORY tables, the rows as INSERT lines in the script, which LibreOffice reopens as it is.

/** A string as the script writes it: quotes doubled, anything outside ASCII as \uXXXX. */
const hsqlString = (value) => `'${String(value).replace(/\0/g, '').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`;
const hsqlName = (name) => `"${String(name).replace(/"/g, '""').replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

/** A SQLite declared type as HSQLDB's: sizes kept where they were given, text without one unbounded. */
export function hsqlTypeOf(declared, values = []) {
  const text = String(declared ?? '').toUpperCase().trim();
  const size = /\(([\d\s,]+)\)/.exec(text)?.[1]?.replace(/\s/g, '') ?? null;
  if (/^(NUMERIC|DECIMAL)/.test(text)) return size ? `${text.startsWith('DEC') ? 'DECIMAL' : 'NUMERIC'}(${size})` : 'NUMERIC(38,10)';
  if (/^(BIGINT)/.test(text)) return 'BIGINT';
  if (/^(SMALLINT|TINYINT)/.test(text)) return 'SMALLINT';
  if (/INT/.test(text)) return values.some((v) => typeof v === 'number' && Math.abs(v) > 2147483647) ? 'BIGINT' : 'INTEGER';
  if (/^BOOL/.test(text)) return 'BOOLEAN';
  if (/^TIMESTAMP|^DATETIME/.test(text)) return 'TIMESTAMP';
  if (/^DATE/.test(text)) return 'DATE';
  if (/^TIME/.test(text)) return 'TIME';
  if (/REAL|FLOA|DOUB/.test(text)) return 'DOUBLE';
  if (/^(VAR)?BINARY/.test(text)) return size ? `VARBINARY(${size})` : 'LONGVARBINARY';
  if (/BLOB/.test(text) || values.some((v) => v instanceof Uint8Array)) return 'LONGVARBINARY';
  if (/^CHAR/.test(text) && size) return `CHAR(${size})`;
  if (/^(VARCHAR|NVARCHAR|CHARACTER VARYING)/.test(text) && size) return `VARCHAR(${size})`;
  return 'LONGVARCHAR';
}

function hsqlValue(value, type) {
  if (value === null || value === undefined || value === '') return value === '' && /CHAR/.test(type) ? "''" : 'NULL';
  if (type === 'BOOLEAN') return value === true || Number(value) ? 'TRUE' : 'FALSE';
  if (/BINARY/.test(type)) return value instanceof Uint8Array ? `'${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}'` : hsqlString(String(value));
  if (/INT|NUMERIC|DECIMAL|DOUBLE/.test(type)) {
    const n = typeof value === 'number' ? value : Number(value);
    // A decimal goes in with as many places as its column keeps, or HSQLDB keeps the places it was given.
    const places = /(?:NUMERIC|DECIMAL)\(\d+,(\d+)\)/.exec(type)?.[1];
    if (places !== undefined && Number.isFinite(n) && Math.abs(n) < 1e15) return n.toFixed(Number(places));
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim();
    if (!Number.isFinite(n)) return 'NULL';
    return type === 'DOUBLE' && Number.isInteger(n) ? `${n}.0E0` : String(n);
  }
  if (type === 'DATE') return hsqlString(String(value).slice(0, 10));
  if (type === 'TIME') return hsqlString(String(value).slice(0, 8));
  if (type === 'TIMESTAMP') {
    const text = String(value).replace('T', ' ');
    return hsqlString(/\.\d+$/.test(text) ? text : `${text.length === 10 ? `${text} 00:00:00` : text}.0`);
  }
  return hsqlString(value);
}

/**
 * The parts of a .odb: an HSQLDB database whose tables are MEMORY tables, its queries, forms and reports.
 * @param {{tables: {name: string, columns: {name: string, declared: string, notNull?: boolean, autoIncrement?: boolean}[], primaryKey: string[], foreignKeys: object[], indexes: object[], rows: any[][]}[], queries: {name: string, sql: string}[]}} database
 * @param {{forms?: {name: string, href: string, mimetype: string, files: [string, string|Uint8Array][]}[], reports?: object[]}} extra
 */
export function writeOdb(database, { forms = [], reports = [] } = {}) {
  const script = ['SET DATABASE COLLATION "Italian"', 'CREATE SCHEMA PUBLIC AUTHORIZATION DBA'];
  const later = [];
  const inserts = [];
  const restarts = [];
  for (const table of database.tables) {
    const types = table.columns.map((c, i) => hsqlTypeOf(c.declared, table.rows.map((r) => r[i])));
    const single = table.primaryKey.length === 1 ? table.primaryKey[0] : null;
    const defs = table.columns.map((c, i) => {
      const identity = c.autoIncrement && c.name === single && /INT/.test(types[i]);
      return `${hsqlName(c.name)} ${types[i]}${identity ? ' GENERATED BY DEFAULT AS IDENTITY(START WITH 0)' : ''}${c.notNull || c.name === single ? ' NOT NULL' : ''}${c.name === single ? ' PRIMARY KEY' : ''}`;
    });
    if (table.primaryKey.length > 1) defs.push(`PRIMARY KEY(${table.primaryKey.map(hsqlName).join(',')})`);
    script.push(`CREATE MEMORY TABLE ${hsqlName(table.name)}(${defs.join(',')})`);
    table.foreignKeys.forEach((key, i) => {
      const onDelete = /^(CASCADE|SET NULL|SET DEFAULT)$/i.test(key.onDelete ?? '') ? ` ON DELETE ${key.onDelete.toUpperCase()}` : '';
      later.push(`ALTER TABLE ${hsqlName(table.name)} ADD CONSTRAINT ${hsqlName(key.name || `FK_${table.name}_${i + 1}`)} FOREIGN KEY(${key.columns.map(hsqlName).join(',')}) REFERENCES ${hsqlName(key.table)}(${key.toColumns.map(hsqlName).join(',')})${onDelete}`);
    });
    table.indexes.forEach((index, i) => {
      later.push(`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${hsqlName(`${table.name}_${index.name || i + 1}`.slice(0, 120))} ON ${hsqlName(table.name)}(${index.columns.map(hsqlName).join(',')})`);
    });
    for (const row of table.rows) inserts.push(`INSERT INTO ${hsqlName(table.name)} VALUES(${row.map((v, i) => hsqlValue(v, types[i])).join(',')})`);
    const counter = table.columns.findIndex((c) => c.autoIncrement && c.name === single);
    if (counter !== -1) {
      const next = Math.max(0, ...table.rows.map((r) => Number(r[counter]) + 1).filter(Number.isFinite));
      restarts.push(`ALTER TABLE ${hsqlName(table.name)} ALTER COLUMN ${hsqlName(table.columns[counter].name)} RESTART WITH ${next}`);
    }
  }
  script.push(...later, ...restarts, 'CREATE USER SA PASSWORD ""', 'GRANT DBA TO SA', 'SET WRITE_DELAY 2', 'SET SCHEMA PUBLIC', ...inserts);
  const properties = [
    '#HSQL Database Engine 1.8.0.10', 'hsqldb.cache_version=1.7.0', 'hsqldb.compatible_version=1.8.0', 'hsqldb.default_table_type=cached',
    'hsqldb.original_version=1.8.0', 'hsqldb.script_format=0', 'modified=no', 'readonly=false', 'sql.enforce_strict_size=true', 'version=1.8.0', '',
  ].join('\n');
  const queries = database.queries.map((q) => `<db:query db:name="${escapeAttr(q.name)}" db:command="${escapeAttr(q.sql)}"/>`).join('');
  const component = (list) => list.map((c) => `<db:component db:name="${escapeAttr(c.name)}" xlink:href="${escapeAttr(c.href)}" db:as-template="false"/>`).join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:db="${NS_DB}" xmlns:xlink="${NS_XLINK}" office:version="1.3"><office:body><office:database><db:data-source><db:connection-data><db:connection-resource xlink:href="sdbc:embedded:hsqldb" xlink:type="simple"/><db:login db:is-password-required="false"/></db:connection-data><db:driver-settings db:system-driver-settings="" db:base-dn="" db:parameter-name-substitution="false"/><db:application-connection-settings db:is-table-name-length-limited="false" db:append-table-alias-name="false" db:max-row-count="100"><db:table-filter><db:table-include-filter><db:table-filter-pattern>%</db:table-filter-pattern></db:table-include-filter></db:table-filter></db:application-connection-settings></db:data-source>${forms.length ? `<db:forms>${component(forms)}</db:forms>` : ''}${reports.length ? `<db:reports>${component(reports)}</db:reports>` : ''}${queries ? `<db:queries>${queries}</db:queries>` : ''}</office:database></office:body></office:document-content>`;
  const files = [
    { name: 'content.xml', data: content, mediaType: 'text/xml' },
    { name: 'database/script', data: `${script.join('\n')}\n`, mediaType: '' },
    { name: 'database/properties', data: properties, mediaType: '' },
  ];
  for (const c of [...forms, ...reports]) {
    files.push({ name: `${c.href}/`, mediaType: c.mimetype, ...(c.unversioned ? {} : { version: ODF_VERSION }), manifestOnly: true });
    files.push(...c.files.map(([name, data]) => ({ name: `${c.href}/${name}`, data, mediaType: name.endsWith('.xml') ? 'text/xml' : '' })));
  }
  return odfPackage(ODB_MIMETYPE, files);
}

// Forms and reports: documents inside the package, read for what they show.

const NS_FORM = 'urn:oasis:names:tc:opendocument:xmlns:form:1.0';
const NS_RPT = 'http://openoffice.org/2005/report';
const NS_OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';

function readForm(pkg, component) {
  const xml = pkg.text(`${component.href}/content.xml`);
  if (!xml) return { name: component.name, table: null, fields: [] };
  try {
    const doc = parseXml(xml, 'a form');
    const form = doc.getElementsByTagNameNS(NS_FORM, 'form')[0];
    const commandType = form ? attr(form, NS_FORM, 'command-type') ?? 'table' : 'table';
    const fields = [...doc.getElementsByTagNameNS(NS_FORM, '*')].map((e) => attr(e, NS_FORM, 'data-field')).filter(Boolean);
    return { name: component.name, table: form ? attr(form, NS_FORM, 'command') : null, commandType, fields: [...new Set(fields)] };
  } catch {
    return { name: component.name, table: null, fields: [] };
  }
}

function readReport(pkg, component) {
  const xml = pkg.text(`${component.href}/content.xml`);
  if (!xml) return { name: component.name, table: null };
  try {
    const doc = parseXml(xml, 'a report');
    const report = doc.getElementsByTagNameNS(NS_OFFICE, 'report')[0];
    const groups = [...doc.getElementsByTagNameNS(NS_RPT, 'group')].map((g) => /\[([^\]]+)\]|"([^"]+)"/.exec(attr(g, NS_RPT, 'group-expression') ?? '')).filter(Boolean).map((m) => m[1] ?? m[2]);
    const fields = [...doc.getElementsByTagNameNS(NS_RPT, 'formatted-text')].map((e) => /field:\[([^\]]+)\]/.exec(attr(e, NS_RPT, 'formula') ?? '')?.[1]).filter(Boolean);
    return {
      name: component.name, table: report ? attr(report, NS_RPT, 'command') : null, commandType: report ? attr(report, NS_RPT, 'command-type') : null,
      groupBy: groups[0] ?? null, columns: [...new Set(fields)].filter((c) => c !== groups[0]),
    };
  } catch {
    return { name: component.name, table: null };
  }
}
