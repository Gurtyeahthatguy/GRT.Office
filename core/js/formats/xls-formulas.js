/** Excel 97's formulas: the tokens of BIFF8 read into Grid's formula text, and Grid's text written back as tokens. */

/** Excel's built-in functions by their number, with how many arguments a fixed one takes; -1 for a variable count. */
export const FUNCTIONS = {
  0: ['COUNT', -1], 1: ['IF', -1], 2: ['ISNA', 1], 3: ['ISERROR', 1], 4: ['SUM', -1], 5: ['AVERAGE', -1], 6: ['MIN', -1], 7: ['MAX', -1],
  8: ['ROW', -1], 9: ['COLUMN', -1], 10: ['NA', 0], 11: ['NPV', -1], 12: ['STDEV', -1], 13: ['DOLLAR', -1], 14: ['FIXED', -1], 15: ['SIN', 1],
  16: ['COS', 1], 17: ['TAN', 1], 18: ['ATAN', 1], 19: ['PI', 0], 20: ['SQRT', 1], 21: ['EXP', 1], 22: ['LN', 1], 23: ['LOG10', 1],
  24: ['ABS', 1], 25: ['INT', 1], 26: ['SIGN', 1], 27: ['ROUND', 2], 28: ['LOOKUP', -1], 29: ['INDEX', -1], 30: ['REPT', 2], 31: ['MID', 3],
  32: ['LEN', 1], 33: ['VALUE', 1], 34: ['TRUE', 0], 35: ['FALSE', 0], 36: ['AND', -1], 37: ['OR', -1], 38: ['NOT', 1], 39: ['MOD', 2],
  40: ['DCOUNT', 3], 41: ['DSUM', 3], 42: ['DAVERAGE', 3], 43: ['DMIN', 3], 44: ['DMAX', 3], 45: ['DSTDEV', 3], 46: ['VAR', -1], 47: ['DVAR', 3],
  48: ['TEXT', 2], 49: ['LINEST', -1], 50: ['TREND', -1], 51: ['LOGEST', -1], 52: ['GROWTH', -1], 56: ['PV', -1], 57: ['FV', -1], 58: ['NPER', -1],
  59: ['PMT', -1], 60: ['RATE', -1], 61: ['MIRR', 3], 62: ['IRR', -1], 63: ['RAND', 0], 64: ['MATCH', -1], 65: ['DATE', 3], 66: ['TIME', 3],
  67: ['DAY', 1], 68: ['MONTH', 1], 69: ['YEAR', 1], 70: ['WEEKDAY', -1], 71: ['HOUR', 1], 72: ['MINUTE', 1], 73: ['SECOND', 1], 74: ['NOW', 0],
  75: ['AREAS', 1], 76: ['ROWS', 1], 77: ['COLUMNS', 1], 78: ['OFFSET', -1], 82: ['SEARCH', -1], 83: ['TRANSPOSE', 1], 86: ['TYPE', 1],
  97: ['ATAN2', 2], 98: ['ASIN', 1], 99: ['ACOS', 1], 100: ['CHOOSE', -1], 101: ['HLOOKUP', -1], 102: ['VLOOKUP', -1], 105: ['ISREF', 1],
  109: ['LOG', -1], 111: ['CHAR', 1], 112: ['LOWER', 1], 113: ['UPPER', 1], 114: ['PROPER', 1], 115: ['LEFT', -1], 116: ['RIGHT', -1],
  117: ['EXACT', 2], 118: ['TRIM', 1], 119: ['REPLACE', 4], 120: ['SUBSTITUTE', -1], 121: ['CODE', 1], 124: ['FIND', -1], 125: ['CELL', -1],
  126: ['ISERR', 1], 127: ['ISTEXT', 1], 128: ['ISNUMBER', 1], 129: ['ISBLANK', 1], 130: ['T', 1], 131: ['N', 1], 140: ['DATEVALUE', 1],
  141: ['TIMEVALUE', 1], 142: ['SLN', 3], 143: ['SYD', 4], 144: ['DDB', -1], 148: ['INDIRECT', -1], 162: ['CLEAN', 1], 163: ['MDETERM', 1],
  164: ['MINVERSE', 1], 165: ['MMULT', 2], 167: ['IPMT', -1], 168: ['PPMT', -1], 169: ['COUNTA', -1], 183: ['PRODUCT', -1], 184: ['FACT', 1],
  189: ['DPRODUCT', 3], 190: ['ISNONTEXT', 1], 193: ['STDEVP', -1], 194: ['VARP', -1], 195: ['DSTDEVP', 3], 196: ['DVARP', 3], 197: ['TRUNC', -1],
  198: ['ISLOGICAL', 1], 199: ['DCOUNTA', 3], 205: ['FINDB', -1], 206: ['SEARCHB', -1], 207: ['REPLACEB', 4], 208: ['LEFTB', -1], 209: ['RIGHTB', -1],
  210: ['MIDB', 3], 211: ['LENB', 1], 212: ['ROUNDUP', 2], 213: ['ROUNDDOWN', 2], 214: ['ASC', 1], 215: ['DBCS', 1], 216: ['RANK', -1],
  219: ['ADDRESS', -1], 220: ['DAYS360', -1], 221: ['TODAY', 0], 222: ['VDB', -1], 227: ['MEDIAN', -1], 228: ['SUMPRODUCT', -1], 229: ['SINH', 1],
  230: ['COSH', 1], 231: ['TANH', 1], 232: ['ASINH', 1], 233: ['ACOSH', 1], 234: ['ATANH', 1], 235: ['DGET', 3], 244: ['INFO', 1], 247: ['DB', -1],
  252: ['FREQUENCY', 2], 261: ['ERROR.TYPE', 1], 269: ['AVEDEV', -1], 270: ['BETADIST', -1], 271: ['GAMMALN', 1], 272: ['BETAINV', -1],
  273: ['BINOMDIST', 4], 274: ['CHIDIST', 2], 275: ['CHIINV', 2], 276: ['COMBIN', 2], 277: ['CONFIDENCE', 3], 278: ['CRITBINOM', 3], 279: ['EVEN', 1],
  280: ['EXPONDIST', 3], 281: ['FDIST', 3], 282: ['FINV', 3], 283: ['FISHER', 1], 284: ['FISHERINV', 1], 285: ['FLOOR', 2], 286: ['GAMMADIST', 4],
  287: ['GAMMAINV', 3], 288: ['CEILING', 2], 289: ['HYPGEOMDIST', 4], 290: ['LOGNORMDIST', 3], 291: ['LOGINV', 3], 292: ['NEGBINOMDIST', 3],
  293: ['NORMDIST', 4], 294: ['NORMSDIST', 1], 295: ['NORMINV', 3], 296: ['NORMSINV', 1], 297: ['STANDARDIZE', 3], 298: ['ODD', 1], 299: ['PERMUT', 2],
  300: ['POISSON', 3], 301: ['TDIST', 3], 302: ['WEIBULL', 4], 303: ['SUMXMY2', 2], 304: ['SUMX2MY2', 2], 305: ['SUMX2PY2', 2], 306: ['CHITEST', 2],
  307: ['CORREL', 2], 308: ['COVAR', 2], 309: ['FORECAST', 3], 310: ['FTEST', 2], 311: ['INTERCEPT', 2], 312: ['PEARSON', 2], 313: ['RSQ', 2],
  314: ['STEYX', 2], 315: ['SLOPE', 2], 316: ['TTEST', 4], 317: ['PROB', -1], 318: ['DEVSQ', -1], 319: ['GEOMEAN', -1], 320: ['HARMEAN', -1],
  321: ['SUMSQ', -1], 322: ['KURT', -1], 323: ['SKEW', -1], 324: ['ZTEST', -1], 325: ['LARGE', 2], 326: ['SMALL', 2], 327: ['QUARTILE', 2],
  328: ['PERCENTILE', 2], 329: ['PERCENTRANK', -1], 330: ['MODE', -1], 331: ['TRIMMEAN', 2], 332: ['TINV', 2], 336: ['CONCATENATE', -1],
  337: ['POWER', 2], 342: ['RADIANS', 1], 343: ['DEGREES', 1], 344: ['SUBTOTAL', -1], 345: ['SUMIF', -1], 346: ['COUNTIF', 2], 347: ['COUNTBLANK', 1],
  350: ['ISPMT', 4], 351: ['DATEDIF', 3], 354: ['ROMAN', -1], 358: ['GETPIVOTDATA', -1], 359: ['HYPERLINK', -1], 361: ['AVERAGEA', -1],
  362: ['MAXA', -1], 363: ['MINA', -1], 364: ['STDEVPA', -1], 365: ['VARPA', -1], 366: ['STDEVA', -1], 367: ['VARA', -1],
};
const BY_NAME = new Map(Object.entries(FUNCTIONS).map(([index, [name, count]]) => [name, { index: Number(index), count }]));

const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };
export const ERROR_CODES = Object.fromEntries(Object.entries(ERRORS).map(([code, text]) => [text, Number(code)]));
export const errorText = (code) => ERRORS[code] ?? '#N/A';

const BINARY = { 0x03: '+', 0x04: '-', 0x05: '*', 0x06: '/', 0x07: '^', 0x08: '&', 0x09: '<', 0x0a: '<=', 0x0b: '=', 0x0c: '>=', 0x0d: '>', 0x0e: '<>' };
const BINARY_CODES = Object.fromEntries(Object.entries(BINARY).map(([code, op]) => [op, Number(code)]));

export function columnName(col) {
  let n = col + 1;
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
const quoteSheet = (name) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);

/**
 * A formula's tokens as Grid's text, without the leading "=".
 * @param {Uint8Array} bytes the record's bytes
 * @param {number} start where the tokens begin
 * @param {number} size how many bytes of tokens
 * @param {{row: number, col: number, sheetName: (ixti) => ?string, name: (index) => ?string, externName: (ixti, index) => ?string, shared?: boolean}} ctx
 */
export function readTokens(bytes, start, size, ctx) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = start + size;
  // Constant arrays keep their values after the tokens, in the order their tokens come.
  let extra = end;
  const stack = [];
  const pop = () => stack.pop() ?? '';
  const cell = (row, colField, relativeTo) => {
    const rowRel = (colField & 0x8000) !== 0;
    const colRel = (colField & 0x4000) !== 0;
    let col = colField & 0x3fff;
    let r = row;
    if (relativeTo) {
      // A shared formula's references are offsets from the cell it is written in.
      if (rowRel) r = (relativeTo.row + ((row << 16) >> 16) + 65536) % 65536;
      if (colRel) col = (relativeTo.col + ((col << 18) >> 18) + 256) % 256;
    }
    return `${colRel ? '' : '$'}${columnName(col)}${rowRel ? '' : '$'}${r + 1}`;
  };
  let at = start;
  while (at < end) {
    const token = bytes[at];
    const base = token & 0x1f | (token < 0x20 ? 0 : 0x20);
    at += 1;
    if (BINARY[token]) { const b = pop(); const a = pop(); stack.push(`${a}${BINARY[token]}${b}`); continue; }
    switch (token) {
      case 0x01: case 0x02: at += 4; stack.push(''); break;
      case 0x0f: { const b = pop(); const a = pop(); stack.push(`${a} ${b}`); break; }
      case 0x10: { const b = pop(); const a = pop(); stack.push(`${a},${b}`); break; }
      case 0x11: { const b = pop(); const a = pop(); stack.push(`${a}:${b}`); break; }
      case 0x12: stack.push(`+${pop()}`); break;
      case 0x13: stack.push(`-${pop()}`); break;
      case 0x14: stack.push(`${pop()}%`); break;
      case 0x15: stack.push(`(${pop()})`); break;
      case 0x16: stack.push(''); break;
      case 0x17: {
        const cch = bytes[at];
        const wide = bytes[at + 1] & 1;
        at += 2;
        let text = '';
        for (let i = 0; i < cch; i += 1) text += String.fromCharCode(wide ? view.getUint16(at + i * 2, true) : bytes[at + i]);
        at += cch * (wide ? 2 : 1);
        stack.push(`"${text.replace(/"/g, '""')}"`);
        break;
      }
      case 0x18: at += 1; break;
      case 0x19: {
        const kind = bytes[at];
        at += 1;
        if (kind & 0x04) { const count = view.getUint16(at, true); at += 2 + (count + 1) * 2; } else at += 2;
        if (kind & 0x10) stack.push(`SUM(${pop()})`);
        break;
      }
      case 0x1c: stack.push(errorText(bytes[at])); at += 1; break;
      case 0x1d: stack.push(bytes[at] ? 'TRUE' : 'FALSE'); at += 1; break;
      case 0x1e: stack.push(String(view.getUint16(at, true))); at += 2; break;
      case 0x1f: stack.push(String(view.getFloat64(at, true))); at += 8; break;
      default: {
        if (base === 0x20) {
          // A constant array: its size and values after the tokens.
          at += 7;
          const cols = bytes[extra] + 1;
          const rows = view.getUint16(extra + 1, true) + 1;
          extra += 3;
          const rowsText = [];
          for (let r = 0; r < rows; r += 1) {
            const items = [];
            for (let c = 0; c < cols; c += 1) {
              const kind = bytes[extra];
              extra += 1;
              if (kind === 0x01) { items.push(String(view.getFloat64(extra, true))); extra += 8; } else if (kind === 0x02) {
                const cch = view.getUint16(extra, true);
                const wide = bytes[extra + 2] & 1;
                extra += 3;
                let text = '';
                for (let i = 0; i < cch; i += 1) text += String.fromCharCode(wide ? view.getUint16(extra + i * 2, true) : bytes[extra + i]);
                extra += cch * (wide ? 2 : 1);
                items.push(`"${text.replace(/"/g, '""')}"`);
              } else if (kind === 0x04) { items.push(bytes[extra] ? 'TRUE' : 'FALSE'); extra += 8; } else if (kind === 0x10) { items.push(errorText(bytes[extra])); extra += 8; } else { items.push(''); extra += 8; }
            }
            rowsText.push(items.join(','));
          }
          stack.push(`{${rowsText.join(';')}}`);
          break;
        }
        if (base === 0x21 || base === 0x22) {
          let count;
          let index;
          if (base === 0x21) { index = view.getUint16(at, true); at += 2; count = FUNCTIONS[index]?.[1] ?? 0; } else { count = bytes[at] & 0x7f; index = view.getUint16(at + 1, true) & 0x7fff; at += 3; }
          const args = [];
          for (let i = 0; i < count; i += 1) args.unshift(pop());
          if (index === 255) {
            // A function by name: an add-in's, or one newer than Excel 97 written as _xlfn.
            const name = args.shift().replace(/^_xlfn\./i, '');
            stack.push(`${name}(${args.join(',')})`);
          } else stack.push(`${FUNCTIONS[index]?.[0] ?? `UNKNOWN${index}`}(${args.join(',')})`);
          break;
        }
        if (base === 0x23) { const index = view.getUint32(at, true); at += 4; stack.push(ctx.name?.(index - 1) ?? '#NAME?'); break; }
        if (base === 0x24 || base === 0x2c) {
          const row = view.getUint16(at, true);
          const col = view.getUint16(at + 2, true);
          at += 4;
          stack.push(cell(row, col, base === 0x2c ? ctx : null));
          break;
        }
        if (base === 0x25 || base === 0x2d) {
          const r1 = view.getUint16(at, true); const r2 = view.getUint16(at + 2, true);
          const c1 = view.getUint16(at + 4, true); const c2 = view.getUint16(at + 6, true);
          at += 8;
          const rel = base === 0x2d ? ctx : null;
          stack.push(`${cell(r1, c1, rel)}:${cell(r2, c2, rel)}`);
          break;
        }
        if (base === 0x26 || base === 0x27 || base === 0x28 || base === 0x29 || base === 0x2e || base === 0x2f) { at += base === 0x29 || base === 0x2e || base === 0x2f ? 2 : 6; break; }
        if (base === 0x2a) { at += 4; stack.push('#REF!'); break; }
        if (base === 0x2b) { at += 8; stack.push('#REF!'); break; }
        if (base === 0x39) {
          const ixti = view.getUint16(at, true);
          const index = view.getUint32(at + 2, true);
          at += 6;
          stack.push(ctx.externName?.(ixti, index - 1) ?? '#NAME?');
          break;
        }
        if (base === 0x3a || base === 0x3c) {
          const ixti = view.getUint16(at, true);
          const row = view.getUint16(at + 2, true);
          const col = view.getUint16(at + 4, true);
          at += 6;
          const sheet = ctx.sheetName?.(ixti);
          stack.push(base === 0x3c ? '#REF!' : `${sheet ? `${quoteSheet(sheet)}!` : ''}${cell(row, col)}`);
          break;
        }
        if (base === 0x3b || base === 0x3d) {
          const ixti = view.getUint16(at, true);
          const r1 = view.getUint16(at + 2, true); const r2 = view.getUint16(at + 4, true);
          const c1 = view.getUint16(at + 6, true); const c2 = view.getUint16(at + 8, true);
          at += 10;
          const sheet = ctx.sheetName?.(ixti);
          stack.push(base === 0x3d ? '#REF!' : `${sheet ? `${quoteSheet(sheet)}!` : ''}${cell(r1, c1)}:${cell(r2, c2)}`);
          break;
        }
        // A token this reader does not know: the rest cannot be read safely.
        return null;
      }
    }
  }
  return stack.length === 1 ? stack[0] : stack.length ? stack[stack.length - 1] : null;
}

// Writing

/** Grid's formula text split into tokens. */
function lex(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ') { i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') { value += '"'; j += 2; continue; }
        if (text[j] === '"') break;
        value += text[j];
        j += 1;
      }
      out.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) { out.push({ type: 'op', value: two }); i += 2; continue; }
    if ('+-*/^&=<>%(),:;{}'.includes(c)) { out.push({ type: 'op', value: c }); i += 1; continue; }
    const error = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/.exec(text.slice(i));
    if (error) { out.push({ type: 'err', value: error[0] }); i += error[0].length; continue; }
    const number = /^\d+(\.\d+)?([eE][+-]?\d+)?|^\.\d+([eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) { out.push({ type: 'num', value: Number(number[0]) }); i += number[0].length; continue; }
    const quoted = /^'((?:[^']|'')+)'!/.exec(text.slice(i));
    if (quoted) { out.push({ type: 'sheet', value: quoted[1].replace(/''/g, "'") }); i += quoted[0].length; continue; }
    // A cell before a name: B$2 is a cell, LOG10( a function.
    const cellRef = /^\$?[A-Za-z]{1,3}\$?\d+(?![\w.(!])/.exec(text.slice(i));
    if (cellRef) { out.push({ type: 'word', value: cellRef[0] }); i += cellRef[0].length; continue; }
    const word = /^[A-Za-z_\\][\w.]*(!)?/.exec(text.slice(i));
    if (word) {
      if (word[1]) out.push({ type: 'sheet', value: word[0].slice(0, -1) });
      else out.push({ type: 'word', value: word[0] });
      i += word[0].length;
      continue;
    }
    throw new Error(`Cannot read the formula at "${text.slice(i, i + 10)}"`);
  }
  return out;
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
const parseCell = (text) => {
  const m = CELL.exec(text);
  if (!m) return null;
  const col = [...m[2].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const row = Number(m[4]) - 1;
  if (col > 255 || row > 65535) throw new Error('A reference beyond Excel 97\'s sheet');
  return { row, col, rowAbs: m[3] === '$', colAbs: m[1] === '$' };
};

/**
 * Grid's formula as BIFF8 tokens.
 * @param {string} formula with or without "="
 * @param {{sheetIndex: (name) => ?number, xti: (sheet) => number}} ctx
 * @returns {Uint8Array} or throws when Excel 97 cannot hold it
 */
export function writeTokens(formula, ctx) {
  const tokens = lex(String(formula).replace(/^=/, ''));
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (t, value) => t?.type === 'op' && t.value === value;
  const out = [];
  const u8 = (v) => out.push(v & 0xff);
  const u16 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); out.push(...b); };
  const field = (ref) => (ref.col & 0x3fff) | (ref.rowAbs ? 0 : 0x8000) | (ref.colAbs ? 0 : 0x4000);

  const PRECEDENCE = { '=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '<>': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  // Operators bind by precedence, all of them left to right, as Excel reads them.
  const expression = (min = 0) => {
    unary();
    for (;;) {
      const t = peek();
      const level = t?.type === 'op' ? PRECEDENCE[t.value] : undefined;
      if (level === undefined || level <= min) break;
      next();
      expression(level);
      u8(BINARY_CODES[t.value]);
    }
  };
  const unary = () => {
    if (isOp(peek(), '-')) { next(); unary(); u8(0x13); return; }
    if (isOp(peek(), '+')) { next(); unary(); u8(0x12); return; }
    primary();
    while (isOp(peek(), '%')) { next(); u8(0x14); }
  };
  const reference = (sheet) => {
    const t = next();
    const a = parseCell(t.value);
    if (!a) throw new Error(`Not a reference: ${t.value}`);
    let b = null;
    if (isOp(peek(), ':') && tokens[pos + 1]?.type === 'word' && CELL.test(tokens[pos + 1].value)) { next(); b = parseCell(next().value); }
    if (sheet !== null) {
      const ixti = ctx.xti(sheet);
      if (b) { u8(0x3b); u16(ixti); u16(a.row); u16(b.row); u16(field(a)); u16(field(b)); } else { u8(0x3a); u16(ixti); u16(a.row); u16(field(a)); }
    } else if (b) { u8(0x25); u16(a.row); u16(b.row); u16(field(a)); u16(field(b)); } else { u8(0x24); u16(a.row); u16(field(a)); }
  };
  const primary = () => {
    const t = peek();
    if (!t) throw new Error('A formula that ends too soon');
    if (t.type === 'num') {
      next();
      if (Number.isInteger(t.value) && t.value >= 0 && t.value <= 65535) { u8(0x1e); u16(t.value); } else { u8(0x1f); f64(t.value); }
      return;
    }
    if (t.type === 'str') {
      next();
      if (t.value.length > 255) throw new Error('A text over 255 characters in a formula');
      u8(0x17); u8(t.value.length); u8(1);
      for (const ch of t.value) u16(ch.charCodeAt(0));
      return;
    }
    if (t.type === 'err') { next(); u8(0x1c); u8(ERROR_CODES[t.value]); return; }
    if (t.type === 'sheet') {
      next();
      if (peek()?.type !== 'word') throw new Error('A sheet without a reference');
      reference(t.value);
      return;
    }
    if (isOp(t, '(')) { next(); expression(); if (!isOp(next(), ')')) throw new Error('A bracket not closed'); u8(0x15); return; }
    if (isOp(t, '{')) throw new Error('Constant arrays');
    if (t.type === 'word') {
      const upper = t.value.toUpperCase();
      if (isOp(tokens[pos + 1], '(')) {
        next();
        next();
        let count = 0;
        if (!isOp(peek(), ')')) {
          for (;;) {
            if (isOp(peek(), ',') || isOp(peek(), ')')) u8(0x16); else expression();
            count += 1;
            if (isOp(peek(), ',')) { next(); continue; }
            break;
          }
        }
        if (!isOp(next(), ')')) throw new Error('A function not closed');
        const known = BY_NAME.get(upper);
        if (!known) throw new Error(`The function ${upper}, which Excel 97 does not have`);
        if (known.count === -1) { u8(0x42); u8(count); u16(known.index); } else {
          if (known.count !== count) throw new Error(`${upper} with ${count} arguments`);
          u8(0x41); u16(known.index);
        }
        return;
      }
      if (upper === 'TRUE' || upper === 'FALSE') { next(); u8(0x1d); u8(upper === 'TRUE' ? 1 : 0); return; }
      if (CELL.test(t.value)) { reference(null); return; }
      throw new Error(`The name ${t.value}`);
    }
    throw new Error(`Cannot write "${t.value}"`);
  };
  expression();
  if (pos < tokens.length) throw new Error('More in the formula than could be read');
  return Uint8Array.from(out);
}

// Excel 5 and 95

/** Bytes, built up little-endian. */
class Out {
  constructor() { this.list = []; }
  u8(v) { this.list.push(v & 0xff); }
  u16(v) { this.list.push(v & 0xff, (v >> 8) & 0xff); }
  copy(bytes) { for (const b of bytes) this.list.push(b); }
}

/**
 * Excel 5's tokens (BIFF5) as Excel 97's, so one reader reads both: references widened, strings made Unicode,
 * sheets named by their place in the workbook rather than through a list of links.
 * @param {(bytes: Uint8Array) => string} decode the workbook's code page
 * @returns {?{bytes: Uint8Array, size: number}} the tokens and how long they are, constant arrays after them; null when a token is one this does not know
 */
export function tokensFromBiff5(bytes, start, size, decode) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, start + size);
  const out = new Out();
  const string = (text) => { out.u8(Math.min(255, text.length)); out.u8(1); for (const ch of text.slice(0, 255)) out.u16(ch.charCodeAt(0)); };
  // A reference's row carries the relative flags in Excel 5, its column in Excel 97.
  const ref = (rw, col, offsets) => {
    const flags = rw & 0xc000;
    let row = rw & 0x3fff;
    let column = col;
    if (offsets) {
      if (flags & 0x8000) row = ((row << 18) >> 18) & 0xffff;
      if (flags & 0x4000) column = ((col << 24) >> 24) & 0x3fff;
    }
    return [row, (column & 0x3fff) | flags];
  };
  let at = start;
  let arrays = 0;
  while (at < end) {
    const token = bytes[at];
    const base = token & 0x1f | (token < 0x20 ? 0 : 0x20);
    at += 1;
    if (token >= 0x03 && token <= 0x16) { out.u8(token); continue; }
    switch (token) {
      case 0x01: case 0x02: out.u8(token); out.copy(bytes.subarray(at, at + 4)); at += 4; continue;
      case 0x17: { const cch = bytes[at]; out.u8(token); string(decode(bytes.subarray(at + 1, at + 1 + cch))); at += 1 + cch; continue; }
      case 0x19: {
        const kind = bytes[at];
        const length = kind & 0x04 ? 3 + (view.getUint16(at + 1, true) + 1) * 2 : 3;
        out.u8(token); out.copy(bytes.subarray(at, at + length)); at += length; continue;
      }
      case 0x1c: case 0x1d: out.u8(token); out.u8(bytes[at]); at += 1; continue;
      case 0x1e: out.u8(token); out.copy(bytes.subarray(at, at + 2)); at += 2; continue;
      case 0x1f: out.u8(token); out.copy(bytes.subarray(at, at + 8)); at += 8; continue;
      default: break;
    }
    out.u8(token);
    if (base === 0x20) { out.copy(bytes.subarray(at, at + 7)); at += 7; arrays += 1; continue; }
    if (base === 0x21) { out.copy(bytes.subarray(at, at + 2)); at += 2; continue; }
    if (base === 0x22) { out.copy(bytes.subarray(at, at + 3)); at += 3; continue; }
    if (base === 0x23) { out.u16(view.getUint16(at, true)); out.u16(0); at += 14; continue; }
    if (base === 0x24 || base === 0x2c) {
      const [row, col] = ref(view.getUint16(at, true), bytes[at + 2], base === 0x2c);
      out.u16(row); out.u16(col); at += 3; continue;
    }
    if (base === 0x25 || base === 0x2d) {
      const [r1, c1] = ref(view.getUint16(at, true), bytes[at + 4], base === 0x2d);
      const [r2, c2] = ref(view.getUint16(at + 2, true), bytes[at + 5], base === 0x2d);
      out.u16(r1); out.u16(r2); out.u16(c1); out.u16(c2); at += 6; continue;
    }
    if (base === 0x26 || base === 0x27 || base === 0x28) { out.copy(bytes.subarray(at, at + 6)); at += 6; continue; }
    if (base === 0x29 || base === 0x2e || base === 0x2f) { out.copy(bytes.subarray(at, at + 2)); at += 2; continue; }
    if (base === 0x2a) { out.copy([0, 0, 0, 0]); at += 3; continue; }
    if (base === 0x2b) { out.copy([0, 0, 0, 0, 0, 0, 0, 0]); at += 6; continue; }
    if (base === 0x39) { out.list.pop(); out.u8(0x1c); out.u8(0x1d); at += 24; continue; }
    if (base === 0x3a || base === 0x3c) {
      const sheet = view.getInt16(at + 10, true);
      const [row, col] = ref(view.getUint16(at + 14, true), bytes[at + 16], false);
      if (sheet < 0 || base === 0x3c) { out.list.pop(); out.u8(0x1c); out.u8(0x17); } else { out.u16(sheet); out.u16(row); out.u16(col); }
      at += 17;
      continue;
    }
    if (base === 0x3b || base === 0x3d) {
      const sheet = view.getInt16(at + 10, true);
      const [r1, c1] = ref(view.getUint16(at + 14, true), bytes[at + 18], false);
      const [r2, c2] = ref(view.getUint16(at + 16, true), bytes[at + 19], false);
      if (sheet < 0 || base === 0x3d) { out.list.pop(); out.u8(0x1c); out.u8(0x17); } else { out.u16(sheet); out.u16(r1); out.u16(r2); out.u16(c1); out.u16(c2); }
      at += 20;
      continue;
    }
    return null;
  }
  // Constant arrays keep their values after the tokens; their strings are made Unicode too.
  const tokens = out.list.length;
  for (let n = 0; n < arrays && at + 3 <= bytes.length; n += 1) {
    const cols = bytes[at] + 1;
    const rows = view.getUint16(at + 1, true) + 1;
    out.copy(bytes.subarray(at, at + 3));
    at += 3;
    for (let i = 0; i < cols * rows && at < bytes.length; i += 1) {
      const kind = bytes[at];
      out.u8(kind);
      at += 1;
      if (kind === 0x02) {
        const cch = bytes[at];
        const text = decode(bytes.subarray(at + 1, at + 1 + cch));
        out.u16(text.length); out.u8(1);
        for (const ch of text) out.u16(ch.charCodeAt(0));
        at += 1 + cch;
      } else { out.copy(bytes.subarray(at, at + 8)); at += 8; }
    }
  }
  return { bytes: Uint8Array.from(out.list), size: tokens };
}
