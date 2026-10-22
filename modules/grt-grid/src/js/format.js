/** Turning a value into what the cell shows. */

import { isError, formatNumberForText } from './engine/values.js';
import { fromSerial } from './functions/index.js';

/**
 * A format pattern in pieces: quoted text, escaped characters and the codes
 * spreadsheets write as literal text are literals; the rest is code.
 */
function pieces(section) {
  const out = [];
  const literal = (text) => out.push({ literal: text });
  for (let i = 0; i < section.length; i += 1) {
    const c = section[i];
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      literal(section.slice(i + 1, end === -1 ? section.length : end));
      i = end === -1 ? section.length : end;
    } else if (c === '\\') {
      literal(section[i + 1] ?? '');
      i += 1;
    } else if (c === '[') {
      const end = section.indexOf(']', i);
      const inner = section.slice(i + 1, end === -1 ? section.length : end);
      const currency = /^\$([^-]*)/.exec(inner);
      if (currency && currency[1]) literal(currency[1]);
      i = end === -1 ? section.length : end;
    } else if (c === '_') {
      literal(' ');
      i += 1;
    } else if (c === '*') {
      i += 1;
    } else {
      out.push({ code: c });
    }
  }
  return out;
}

const DATE_PART = /^[ymdhs]$/i;

/** The section of a pattern that applies to a value: positive;negative;zero. */
function section(pattern, value) {
  const sections = [];
  let current = '';
  let quoted = false;
  for (const c of pattern) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      sections.push(current);
      current = '';
    } else current += c;
  }
  sections.push(current);
  if (value < 0 && sections.length > 1 && sections[1] !== '') return { text: sections[1], signed: false };
  if (value === 0 && sections.length > 2 && sections[2] !== '') return { text: sections[2], signed: false };
  return { text: sections[0], signed: true };
}

/**
 * @param {*} value
 * @param {?string} pattern
 * @returns {string}
 */
export function formatValue(value, pattern = null) {
  if (value === null || value === undefined) return '';
  if (isError(value)) return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  if (typeof value !== 'number') return String(value);
  if (!pattern || /^general$/i.test(pattern.trim()) || pattern.trim() === '@') return formatNumberForText(value);

  const chosen = section(pattern, value);
  const parts = pieces(chosen.text);
  const codes = parts.filter((part) => part.code).map((part) => part.code).join('');
  const shown = chosen.signed ? value : Math.abs(value);

  if (/[ymdhs]/i.test(codes) && !/[#0?]/.test(codes)) return formatDate(shown, parts);
  if (!/[#0?]/.test(codes)) return parts.map((part) => part.literal ?? part.code).join('') || formatNumberForText(value);
  return formatNumber(shown, parts);
}

/** Whether a formatted value should sit right or left in its cell. */
export function alignmentFor(value) {
  if (value === null || value === undefined) return 'left';
  if (isError(value)) return 'center';
  if (typeof value === 'number') return 'right';
  if (typeof value === 'boolean') return 'center';
  return 'left';
}

// Numbers

/** Formats a number with the numeric run of a pattern, its literals kept around it. */
function formatNumber(value, parts) {
  const isNumeric = (c) => /[#0?,.Ee+\-]/.test(c);
  const first = parts.findIndex((part) => part.code && /[#0?]/.test(part.code));
  let last = first;
  while (last + 1 < parts.length && parts[last + 1].code && isNumeric(parts[last + 1].code)) last += 1;
  const before = parts.slice(0, first).map((part) => part.literal ?? part.code).join('');
  const after = parts.slice(last + 1).map((part) => part.literal ?? part.code).join('');
  const core = parts.slice(first, last + 1).map((part) => part.code).join('');
  const percent = parts.some((part) => part.code === '%');
  return `${before}${numberCore(percent ? value * 100 : value, core)}${after}`;
}

function numberCore(value, core) {
  const exponent = /[Ee][+-]/.exec(core);
  if (exponent) {
    const mantissa = core.slice(0, exponent.index);
    const decimals = (mantissa.split('.')[1] ?? '').replace(/[^#0?]/g, '').length;
    const digits = core.slice(exponent.index + 2).replace(/[^0]/g, '').length || 1;
    const [m, e] = value.toExponential(decimals).split('e');
    const power = Number(e);
    const sign = power < 0 ? '-' : (exponent[0][1] === '+' ? '+' : '');
    return `${m}E${sign}${String(Math.abs(power)).padStart(digits, '0')}`;
  }

  const [intPattern = '', fractionPattern = ''] = core.replace(/%/g, '').split('.');
  const decimals = (fractionPattern.match(/[#0?]/g) ?? []).length;
  const grouped = intPattern.includes(',');
  // Commas at the end of the integer part divide by a thousand each.
  const scale = 1000 ** ((/,+$/.exec(intPattern)?.[0].length) ?? 0);

  const negative = value < 0;
  const fixed = Math.abs(value / scale).toFixed(decimals);
  const [whole, fraction = ''] = fixed.split('.');

  const minimumDigits = (intPattern.match(/0/g) ?? []).length;
  let head = whole === '0' && minimumDigits === 0 && decimals > 0 ? '' : whole.padStart(Math.max(1, minimumDigits), '0');
  if (grouped && head) head = head.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // A `#` after the decimal point means "only if there is something there".
  let tail = fraction;
  const required = (fractionPattern.match(/0/g) ?? []).length;
  while (tail.length > required && tail.endsWith('0')) tail = tail.slice(0, -1);

  const body = tail ? `${head || '0'}.${tail}` : (head || '0');
  return `${negative && Number(fixed) !== 0 ? '-' : ''}${body}`;
}

// Dates

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDate(serial, parts) {
  const days = Math.floor(serial);
  const date = fromSerial(days);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();

  const seconds = Math.min(Math.round((serial - days) * 86400), 86399);
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor(seconds / 60) % 60;
  const second = seconds % 60;

  const pad = (n, width = 2) => String(n).padStart(width, '0');

  const tokens = [];
  for (const part of parts) {
    const last = tokens[tokens.length - 1];
    if (part.code && DATE_PART.test(part.code) && last?.code && last.code[0].toLowerCase() === part.code.toLowerCase()) {
      last.code += part.code;
    } else tokens.push({ ...part });
  }
  const isPart = (token) => token.code && DATE_PART.test(token.code[0]);
  // `m` and `mm` are minutes right after an hour or right before a second.
  const minutesAt = (i) => {
    const before = tokens.slice(0, i).reverse().find(isPart);
    const after = tokens.slice(i + 1).find(isPart);
    return /^h/i.test(before?.code ?? '') || /^s/i.test(after?.code ?? '');
  };

  return tokens.map((token, i) => {
    if (token.literal !== undefined) return token.literal;
    const code = token.code.toLowerCase();
    switch (code) {
      case 'yyyy': case 'yyy': return String(year);
      case 'yy': case 'y': return pad(year % 100);
      case 'mmmmm': return MONTHS[month - 1][0];
      case 'mmmm': return MONTHS[month - 1];
      case 'mmm': return MONTHS[month - 1].slice(0, 3);
      case 'mm': return minutesAt(i) ? pad(minute) : pad(month);
      case 'm': return minutesAt(i) ? String(minute) : String(month);
      case 'dddd': return DAYS[weekday];
      case 'ddd': return DAYS[weekday].slice(0, 3);
      case 'dd': return pad(day);
      case 'd': return String(day);
      case 'hh': return pad(hour);
      case 'h': return String(hour);
      case 'ss': return pad(second);
      case 's': return String(second);
      default: return DATE_PART.test(code[0]) ? token.code : code;
    }
  }).join('');
}

/** Reads what someone typed into a cell. */
export function parseInput(text) {
  const trimmed = String(text ?? '').trim();

  if (trimmed === '') return { kind: 'blank', value: null };
  if (trimmed.startsWith('=')) return { kind: 'formula', value: trimmed };

  if (/^(TRUE|FALSE)$/i.test(trimmed)) {
    return { kind: 'value', value: trimmed.toUpperCase() === 'TRUE' };
  }

  const percent = /^-?[\d.,]+%$/.test(trimmed);
  const numeric = percent ? trimmed.slice(0, -1) : trimmed;
  const cleaned = numeric.replace(/,/g, '');

  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) {
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) {
      return { kind: 'value', value: percent ? parsed / 100 : parsed, percent };
    }
  }

  return { kind: 'value', value: trimmed };
}
