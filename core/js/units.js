/** Lengths between the units the formats use; everything passes through millimetres. */

const PER_MM = {
  mm: 1,
  cm: 0.1,
  in: 1 / 25.4,
  pt: 72 / 25.4,
  pc: 6 / 25.4,
  px: 96 / 25.4,
  twip: 1440 / 25.4,
  emu: 36000,
};

export const toMm = (value, unit) => value / PER_MM[unit];
export const fromMm = (mm, unit) => mm * PER_MM[unit];

/** An ODF or CSS length such as "2.54cm" or "12pt", in millimetres; null if it is not one. */
export function parseLength(text) {
  const match = /^\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)\s*$/i.exec(String(text ?? ''));
  if (!match) return null;
  return toMm(Number(match[1]), match[2].toLowerCase());
}

/** A length to write: at most three decimals, no trailing zeros. */
export function formatLength(mm, unit = 'mm') {
  const value = Math.round(fromMm(mm, unit) * 1000) / 1000;
  return `${Object.is(value, -0) ? 0 : value}${unit}`;
}

export const round = (value, places = 0) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
