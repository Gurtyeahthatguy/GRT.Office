/** Turning a value into what the cell shows. */

import { isError, formatNumberForText } from './engine/values.js';
import { fromSerial } from './functions/index.js';

const DATE_PATTERN = /y{2,4}|m{1,4}|d{1,4}|h{1,2}|s{1,2}/;

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
  if (!pattern) return formatNumberForText(value);

  if (DATE_PATTERN.test(pattern) && !/[#0]/.test(pattern)) {
    return formatDate(value, pattern);
  }

  return formatNumber(value, pattern);
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

function formatNumber(value, pattern) {
  const percent = pattern.includes('%');
  const scaled = percent ? value * 100 : value;

  const [intPattern = '', fractionPattern = ''] = pattern.replace(/%/g, '').split('.');
  const decimals = (fractionPattern.match(/[#0]/g) ?? []).length;
  const grouped = intPattern.includes(',');

  const negative = scaled < 0;
  const fixed = Math.abs(scaled).toFixed(decimals);
  const [whole, fraction = ''] = fixed.split('.');

  const minimumDigits = (intPattern.match(/0/g) ?? []).length;
  let head = whole.padStart(Math.max(1, minimumDigits), '0');
  if (grouped) head = head.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // A `#` after the decimal point means "only if there is something there".
  let tail = fraction;
  const optional = (fractionPattern.match(/#/g) ?? []).length;
  if (optional > 0) tail = tail.replace(/0+$/, '');

  const body = tail ? `${head}.${tail}` : head;
  return `${negative ? '-' : ''}${body}${percent ? '%' : ''}`;
}

// Dates

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDate(serial, pattern) {
  const date = fromSerial(Math.floor(serial));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();

  const fraction = serial - Math.floor(serial);
  const minutesOfDay = Math.round(fraction * 1440);
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;

  const pad = (n, width = 2) => String(n).padStart(width, '0');

  // Longest tokens first, so `mm` is not eaten by two `m`s.
  return pattern.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s/g, (token) => {
    switch (token) {
      case 'yyyy': return String(year);
      case 'yy': return pad(year % 100);
      case 'mmmm': return MONTHS[month - 1];
      case 'mmm': return MONTHS[month - 1].slice(0, 3);
      case 'mm': return pad(month);
      case 'm': return String(month);
      case 'dddd': return DAYS[weekday];
      case 'ddd': return DAYS[weekday].slice(0, 3);
      case 'dd': return pad(day);
      case 'd': return String(day);
      case 'hh': return pad(hour);
      case 'h': return String(hour);
      case 'ss': return pad(minute);
      case 's': return String(minute);
      default: return token;
    }
  });
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
