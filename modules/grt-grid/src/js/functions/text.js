/** Text: numerals and bases, bytes for East Asian text, searching, joining, regular expressions and XML. */

import { riskyPattern } from '../core/find.js';
import { ERROR, isError, isBlank, toNumber, toText, toBoolean, Matrix } from '../engine/values.js';
import { wildcard } from './criteria.js';
import { parseXml } from '../core/xml.js';

/** The longest text a function builds, so a formula cannot fill the memory with one cell. */
const MAX_TEXT = 1_000_000;

function textArg(arg, fallback = null) {
  if (arg === undefined || arg.missing) return fallback === null ? ERROR.value : fallback;
  return toText(arg.matrix && arg.matrix.rows * arg.matrix.cols === 1 ? arg.matrix.first : arg.value);
}

function numberArg(arg, fallback = null) {
  if (arg === undefined || arg.missing) return fallback === null ? ERROR.value : fallback;
  return toNumber(arg.matrix && arg.matrix.rows * arg.matrix.cols === 1 ? arg.matrix.first : arg.value);
}

/** The arguments read by kind ('t' text, 'n' number), with defaults; the first error otherwise. */
function read(args, kinds, fallbacks = []) {
  if (args.length > kinds.length) return ERROR.value;
  const out = [];
  for (let i = 0; i < kinds.length; i += 1) {
    const value = kinds[i] === 't' ? textArg(args[i], fallbacks[i] ?? null) : numberArg(args[i], fallbacks[i] ?? null);
    if (isError(value)) return value;
    out.push(value);
  }
  return out;
}

const fn = (kinds, fallbacks, apply) => (args) => {
  const values = read(args, kinds, fallbacks);
  return isError(values) ? values : apply(...values);
};

const capped = (text) => (text.length > MAX_TEXT ? ERROR.value : text);

// Roman numerals

const ROMAN_CHARS = ['M', 'D', 'C', 'L', 'X', 'V', 'I'];
const ROMAN_VALUES = [1000, 500, 100, 50, 10, 5, 1];

/** A number as Roman numerals, classic (0) to most concise (4), as both programs write them. */
function roman(number, mode) {
  let value = number;
  let out = '';
  for (let i = 0; i <= 3; i += 1) {
    let index = 2 * i;
    let digit = Math.floor(value / ROMAN_VALUES[index]);
    if (digit % 5 === 4) {
      const second = digit === 4 ? index - 1 : index - 2;
      let steps = 0;
      while (steps < mode && index < ROMAN_VALUES.length - 1) {
        steps += 1;
        if (ROMAN_VALUES[second] - ROMAN_VALUES[index + 1] <= value) index += 1;
        else steps = mode;
      }
      out += ROMAN_CHARS[index] + ROMAN_CHARS[second];
      value = value + ROMAN_VALUES[index] - ROMAN_VALUES[second];
    } else {
      if (digit > 4) {
        out += ROMAN_CHARS[index - 1];
        digit -= 5;
      }
      out += ROMAN_CHARS[index].repeat(digit);
      value %= ROMAN_VALUES[index];
    }
  }
  return out;
}

function arabic(text) {
  const t = text.trim().toUpperCase();
  // LibreOffice takes no sign.
  const negative = false;
  const body = t;
  if (body === '') return 0;
  const values = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let total = 0;
  for (let i = 0; i < body.length; i += 1) {
    const v = values[body[i]];
    if (!v) return ERROR.num;
    const next = values[body[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return total > 3999 ? ERROR.num : negative ? -total : total;
}

// Thai baht in words

const THAI_DIGITS = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const THAI_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/** Up to six digits in Thai words: ten is สิบ, twenty ยี่สิบ, a final one after tens เอ็ด. */
function thaiGroup(n) {
  const digits = String(n).split('').reverse().map(Number);
  let out = '';
  for (let place = digits.length - 1; place >= 0; place -= 1) {
    const d = digits[place];
    if (d === 0) continue;
    if (place === 1) out += (d === 1 ? '' : d === 2 ? 'ยี่' : THAI_DIGITS[d]) + THAI_PLACES[1];
    else if (place === 0) out += d === 1 && digits[1] > 0 ? 'เอ็ด' : THAI_DIGITS[d];
    else out += THAI_DIGITS[d] + THAI_PLACES[place];
  }
  return out;
}

function thaiNumber(n) {
  if (n === 0) return '';
  const groups = [];
  let rest = n;
  while (rest > 0) {
    groups.unshift(rest % 1_000_000);
    rest = Math.floor(rest / 1_000_000);
  }
  return groups.map((g, i) => (g === 0 ? '' : thaiGroup(g)) + (i < groups.length - 1 ? 'ล้าน' : '')).join('');
}

function bahtText(number) {
  const negative = number < 0;
  const cents = Math.round(Math.abs(number) * 100);
  const baht = Math.floor(cents / 100);
  const satang = cents % 100;
  if (baht > 9e15) return ERROR.num;
  let out = negative ? 'ลบ' : '';
  if (baht === 0 && satang === 0) return 'ศูนย์บาทถ้วน';
  if (baht > 0) out += `${thaiNumber(baht)}บาท`;
  out += satang === 0 ? 'ถ้วน' : `${thaiNumber(satang)}สตางค์`;
  return out;
}

// Full-width and half-width forms

const HALF_KATAKANA = '｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ';
const FULL_KATAKANA = '。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜';
const VOICED = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボ';
const VOICED_BASE = 'カキクケコサシスセソタチツテトハヒフヘホ';
const SEMI = 'パピプペポ';
const SEMI_BASE = 'ハヒフヘホ';

function toHalfWidth(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (VOICED.includes(ch)) out += HALF_KATAKANA[FULL_KATAKANA.indexOf(VOICED_BASE[VOICED.indexOf(ch)])] + 'ﾞ';
    else if (SEMI.includes(ch)) out += HALF_KATAKANA[FULL_KATAKANA.indexOf(SEMI_BASE[SEMI.indexOf(ch)])] + 'ﾟ';
    else if (ch === 'ヴ') out += 'ｳﾞ';
    else if (FULL_KATAKANA.includes(ch)) out += HALF_KATAKANA[FULL_KATAKANA.indexOf(ch)];
    else out += ch;
  }
  return out;
}

function toFullWidth(text) {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const code = ch.codePointAt(0);
    const at = HALF_KATAKANA.indexOf(ch);
    if (code >= 0x21 && code <= 0x7e) out += String.fromCharCode(code + 0xfee0);
    else if (at >= 0) {
      const full = FULL_KATAKANA[at];
      if (chars[i + 1] === 'ﾞ' && VOICED_BASE.includes(full)) { out += VOICED[VOICED_BASE.indexOf(full)]; i += 1; }
      else if (chars[i + 1] === 'ﾞ' && full === 'ウ') { out += 'ヴ'; i += 1; }
      else if (chars[i + 1] === 'ﾟ' && SEMI_BASE.includes(full)) { out += SEMI[SEMI_BASE.indexOf(full)]; i += 1; }
      else out += full;
    } else out += ch;
  }
  return out;
}

// Bytes, as the B functions count them: East Asian characters are two

const wide = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c > 0xffff;
};
const bytesOf = (text) => [...text].reduce((n, ch) => n + (wide(ch) ? 2 : 1), 0);

/** The characters covering bytes `from` (0-based) for `count` bytes; a wide character cut in half becomes a space. */
function bytesSlice(text, from, count) {
  let at = 0;
  let out = '';
  const end = from + count;
  for (const ch of text) {
    const size = wide(ch) ? 2 : 1;
    const next = at + size;
    if (next <= from) { at = next; continue; }
    if (at >= end) break;
    if (at < from || next > end) out += ' ';
    else out += ch;
    at = next;
  }
  return out;
}

// Windows-1252, which CHAR and CODE use between 128 and 159

const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const charOf = (n) => (n >= 128 && n < 160 ? CP1252[n - 128] : String.fromCharCode(n));
const codeOf = (ch) => {
  const at = CP1252.indexOf(ch);
  return at >= 0 ? 128 + at : ch.charCodeAt(0);
};

// Regular expressions: patterns that can take for ever are refused

/** A repeated group that holds a repeat or a choice, such as (a+)+ or (a|aa)*, can backtrack exponentially. */
const dangerous = (pattern) => riskyPattern(pattern);

function regex(args) {
  const text = textArg(args[0]);
  const pattern = textArg(args[1]);
  if (isError(text)) return text;
  if (isError(pattern)) return pattern;
  if (args.length > 4) return ERROR.value;
  if (pattern.length > 1000 || text.length > MAX_TEXT || dangerous(pattern)) return ERROR.value;
  const replacing = args[2] !== undefined && !args[2].missing;
  const replacement = replacing ? textArg(args[2]) : null;
  if (isError(replacement)) return replacement;
  let global = false;
  let occurrence = 1;
  if (args[3] !== undefined && !args[3].missing) {
    const raw = args[3].value;
    if (typeof raw === 'number') {
      occurrence = Math.trunc(raw);
      if (occurrence < 0) return ERROR.value;
    } else {
      const flags = toText(raw);
      if (flags === 'g') global = true;
      else if (flags !== '') return ERROR.value;
    }
  }
  let expression;
  try {
    expression = new RegExp(pattern, 'gu');
  } catch {
    return ERROR.value;
  }
  // ICU's $1 and JavaScript's $1 agree; a backslash escape in the replacement is taken as the character.
  const replaceWith = replacing ? replacement.replace(/\\(.)/g, '$1') : null;
  if (!replacing) {
    const matches = [...text.matchAll(expression)];
    const found = matches[occurrence - 1];
    if (occurrence === 0) return text;
    return found ? found[0] : ERROR.na;
  }
  if (global) return capped(text.replace(expression, replaceWith));
  if (occurrence === 0) return text;
  let seen = 0;
  return capped(text.replace(expression, (...m) => {
    seen += 1;
    if (seen !== occurrence) return m[0];
    const groups = m.slice(1, -2);
    return replaceWith.replace(/\$(\d)/g, (_, d) => groups[Number(d) - 1] ?? '').replace(/\$&/g, m[0]);
  }));
}

// XML

function filterXml(args) {
  const xml = textArg(args[0]);
  const path = textArg(args[1]);
  if (isError(xml)) return xml;
  if (isError(path)) return path;
  if (args.length !== 2) return ERROR.value;
  let doc;
  try {
    doc = parseXml(xml, 'the XML');
  } catch {
    return ERROR.value;
  }
  let result;
  try {
    result = doc.evaluate(path, doc, (prefix) => doc.documentElement.lookupNamespaceURI(prefix), 0, null);
  } catch {
    return ERROR.value;
  }
  // ANY_TYPE: numbers, strings and booleans come back as themselves, node sets as their text.
  if (result.resultType === 1) return result.numberValue;
  if (result.resultType === 2) return result.stringValue;
  if (result.resultType === 3) return result.booleanValue;
  const values = [];
  for (let node = result.iterateNext(); node; node = result.iterateNext()) {
    values.push(node.textContent);
    if (values.length > 100_000) return ERROR.value;
  }
  // The matches come back as text, as LibreOffice gives them.
  if (values.length === 0) return ERROR.na;
  return values.length === 1 ? values[0] : Matrix.column(values);
}

// Before and after a delimiter

/** Where the instance-th delimiter starts and ends, counted from the end when instance is negative. */
function findDelimiter(text, delimiters, instance, caseless, matchEnd) {
  const haystack = caseless ? text.toLowerCase() : text;
  const needles = delimiters.map((d) => (caseless ? d.toLowerCase() : d));
  const hits = [];
  for (let i = 0; i <= haystack.length; i += 1) {
    for (const d of needles) {
      if (d !== '' && haystack.startsWith(d, i)) {
        hits.push({ start: i, end: i + d.length });
        i += d.length - 1;
        break;
      }
    }
  }
  if (matchEnd) {
    if (instance > 0) hits.push({ start: text.length, end: text.length });
    else hits.unshift({ start: 0, end: 0 });
  }
  const hit = instance > 0 ? hits[instance - 1] : hits[hits.length + instance];
  return hit ?? null;
}

function around(args, after) {
  const text = textArg(args[0]);
  if (isError(text)) return text;
  if (args.length < 2 || args.length > 6) return ERROR.value;
  const delimiterArg = args[1];
  const delimiters = (delimiterArg.matrix ? delimiterArg.matrix.flat : [delimiterArg.value]).map(toText);
  if (delimiters.some(isError)) return ERROR.value;
  const instance = Math.trunc(numberArg(args[2], 1));
  const mode = numberArg(args[3], 0);
  const end = numberArg(args[4], 0);
  for (const v of [instance, mode, end]) if (isError(v)) return v;
  if (instance === 0 || Math.abs(instance) > text.length + 1 || (mode !== 0 && mode !== 1)) return ERROR.value;
  if (delimiters.every((d) => d === '')) return after ? (instance > 0 ? text : '') : (instance > 0 ? '' : text);
  const hit = findDelimiter(text, delimiters, instance, mode === 1, end !== 0);
  if (!hit) return args[5] !== undefined && !args[5].missing ? args[5].value : ERROR.na;
  return after ? text.slice(hit.end) : text.slice(0, hit.start);
}

/** A number rounded half away from zero to some decimals, with thousands marked by commas when wanted. */
function grouped(n, decimals, commas) {
  if (decimals > 127) return ERROR.value;
  const factor = 10 ** decimals;
  const rounded = (Math.sign(n) * Math.round(Number((Math.abs(n) * factor).toPrecision(15)))) / factor;
  const places = Math.max(0, decimals);
  const [whole, fraction] = Math.abs(rounded).toFixed(places).split('.');
  const integer = commas ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  return `${rounded < 0 ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

// The library

export const TEXT = {
  ARABIC: fn(['t'], [], arabic),
  ROMAN: fn(['n', 'n'], [null, 0], (n, mode) => {
    const value = Math.trunc(n);
    const m = typeof mode === 'boolean' ? (mode ? 0 : 4) : Math.trunc(mode);
    if (value < 0 || value > 3999 || m < 0 || m > 4) return ERROR.num;
    return roman(value, m);
  }),
  BASE: fn(['n', 'n', 'n'], [null, null, 0], (n, radix, minimum) => {
    const value = Math.trunc(n);
    const r = Math.trunc(radix);
    const width = Math.trunc(minimum);
    if (value < 0 || value >= 2 ** 53 || r < 2 || r > 36 || width < 0 || width > 255) return ERROR.num;
    return value.toString(r).toUpperCase().padStart(width, '0');
  }),
  DECIMAL: fn(['t', 'n'], [], (text, radix) => {
    const r = Math.trunc(radix);
    if (r < 2 || r > 36) return ERROR.value;
    let t = text.trim().toLowerCase();
    if (r === 16) t = t.replace(/^(0x|x)/, '').replace(/h$/, '');
    if (r === 2) t = t.replace(/b$/, '');
    if (t === '') return 0;
    let value = 0;
    for (const ch of t) {
      const d = Number.parseInt(ch, 36);
      if (Number.isNaN(d) || d >= r) return ERROR.num;
      value = value * r + d;
    }
    return Number.isFinite(value) ? value : ERROR.num;
  }),
  BAHTTEXT: fn(['n'], [], bahtText),
  ASC: fn(['t'], [], toHalfWidth),
  JIS: fn(['t'], [], toFullWidth),
  CHAR: fn(['n'], [], (n) => {
    const code = Math.trunc(n);
    if (code === 0) return '';
    return code < 0 || code > 255 ? ERROR.value : charOf(code);
  }),
  CODE: fn(['t'], [], (text) => (text === '' ? 0 : codeOf(text[0]))),
  UNICHAR: fn(['n'], [], (n) => {
    const code = Math.trunc(n);
    if (code === 0) return '';
    if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ERROR.value;
    return String.fromCodePoint(code);
  }),
  UNICODE: fn(['t'], [], (text) => (text === '' ? ERROR.value : text.codePointAt(0))),
  CLEAN: fn(['t'], [], (text) => text.replace(/[\u0000-\u001f]/g, '')),
  T: (args) => {
    const value = args[0]?.matrix ? args[0].matrix.first : args[0]?.value;
    if (isError(value)) return value;
    return typeof value === 'string' ? value : '';
  },
  ROT13: fn(['t'], [], (text) => text.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  })),
  REPT: fn(['t', 'n'], [], (text, n) => {
    const times = Math.trunc(n);
    if (times < 0) return ERROR.num;
    return text.length * times > MAX_TEXT ? ERROR.value : text.repeat(times);
  }),
  REPLACE: fn(['t', 'n', 'n', 't'], [], (text, start, count, replacement) => {
    const s = Math.trunc(start);
    const c = Math.trunc(count);
    if (s < 1 || c < 0) return ERROR.num;
    return capped(text.slice(0, s - 1) + replacement + text.slice(s - 1 + c));
  }),
  SEARCH: (args) => {
    const values = read(args, ['t', 't', 'n'], [null, null, 1]);
    if (isError(values)) return values;
    const [needle, haystack, start] = values;
    const from = Math.trunc(start);
    if (needle === '' || from < 1 || from > haystack.length) return ERROR.value;
    const pattern = new RegExp(wildcard(needle).source.slice(1, -1), 'i');
    const rest = haystack.slice(from - 1);
    const at = rest.search(pattern);
    return at === -1 ? ERROR.value : from + at;
  },
  NUMBERVALUE: (args) => {
    const values = read(args, ['t', 't', 't'], [null, '.', ',']);
    if (isError(values)) return values;
    const [text, decimal, group] = values;
    if (decimal === '' || (decimal[0] === group[0] && group !== '')) return ERROR.value;
    let t = text.trim();
    let percent = 0;
    if (t.endsWith('%')) { percent = 1; t = t.slice(0, -1).trimEnd(); }
    if (group) t = t.split(group[0]).join('');
    const at = t.indexOf(decimal[0]);
    if (at >= 0 && t.indexOf(decimal[0], at + 1) >= 0) return ERROR.value;
    if (at >= 0) t = `${t.slice(0, at)}.${t.slice(at + 1)}`;
    if (t === '') return 0;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return ERROR.value;
    return Number(t) / 100 ** percent;
  },
  ENCODEURL: fn(['t'], [], (text) => capped(encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))),
  // WEBSERVICE is left out by principle: GRT never opens the network.
  FILTERXML: filterXml,
  REGEX: regex,
  TEXTBEFORE: (args) => around(args, false),
  TEXTAFTER: (args) => around(args, true),
  TEXTJOIN: (args) => {
    if (args.length < 3) return ERROR.value;
    const delimiters = (args[0].matrix ? args[0].matrix.flat : [args[0].value]).map((v) => (isBlank(v) ? '' : toText(v)));
    if (delimiters.some(isError)) return ERROR.value;
    const skip = toBoolean(args[1].value);
    if (isError(skip)) return skip;
    const pieces = [];
    for (const arg of args.slice(2)) {
      for (const v of arg.matrix ? arg.matrix.flat : [arg.value]) {
        if (isError(v)) return v;
        if (skip && (v === null || v === undefined || v === '')) continue;
        pieces.push(isBlank(v) ? '' : toText(v));
      }
    }
    let out = '';
    pieces.forEach((p, i) => {
      if (i > 0) out += delimiters[(i - 1) % delimiters.length];
      out += p;
    });
    return capped(out);
  },

  FIXED: (args) => {
    const values = read(args.slice(0, 2), ['n', 'n'], [null, 2]);
    if (isError(values)) return values;
    const commas = args[2] !== undefined && !args[2].missing ? toBoolean(args[2].value) !== true : true;
    return grouped(values[0], Math.trunc(values[1]), commas);
  },
  DOLLAR: fn(['n', 'n'], [null, 2], (n, decimals) => {
    const shown = grouped(Math.abs(n), Math.trunc(decimals), true);
    return n < 0 ? `-$${shown}` : `$${shown}`;
  }),
  LENB: fn(['t'], [], bytesOf),
  LEFTB: fn(['t', 'n'], [null, 1], (text, n) => (n < 0 ? ERROR.value : bytesSlice(text, 0, Math.trunc(n)))),
  RIGHTB: fn(['t', 'n'], [null, 1], (text, n) => {
    if (n < 0) return ERROR.value;
    const total = bytesOf(text);
    const count = Math.min(total, Math.trunc(n));
    return bytesSlice(text, total - count, count);
  }),
  MIDB: fn(['t', 'n', 'n'], [], (text, start, n) => (start < 1 || n < 0 ? ERROR.value : bytesSlice(text, Math.trunc(start) - 1, Math.trunc(n)))),
  REPLACEB: fn(['t', 'n', 'n', 't'], [], (text, start, n, replacement) => {
    const s = Math.trunc(start);
    const c = Math.trunc(n);
    if (s < 1 || c < 0) return ERROR.value;
    const total = bytesOf(text);
    return capped(bytesSlice(text, 0, s - 1) + replacement + bytesSlice(text, s - 1 + c, Math.max(0, total - (s - 1 + c))));
  }),
  FINDB: (args) => {
    const values = read(args, ['t', 't', 'n'], [null, null, 1]);
    if (isError(values)) return values;
    const [needle, haystack, start] = values;
    const chars = [...haystack];
    let bytes = 0;
    for (let i = 0; i < chars.length; i += 1) {
      if (bytes + 1 >= start && chars.slice(i).join('').startsWith(needle)) return bytes + 1;
      bytes += wide(chars[i]) ? 2 : 1;
    }
    return ERROR.value;
  },
  SEARCHB: (args) => {
    const values = read(args, ['t', 't', 'n'], [null, null, 1]);
    if (isError(values)) return values;
    const [needle, haystack, start] = values;
    const pattern = new RegExp(`^${wildcard(needle).source.slice(1, -1)}`, 'i');
    const chars = [...haystack];
    let bytes = 0;
    for (let i = 0; i < chars.length; i += 1) {
      if (bytes + 1 >= start && pattern.test(chars.slice(i).join(''))) return bytes + 1;
      bytes += wide(chars[i]) ? 2 : 1;
    }
    return ERROR.value;
  },
};
