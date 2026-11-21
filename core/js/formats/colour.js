/** Colours read from files, kept only as plain #rrggbb, so no file can put other text into a style or a dialog. */

const HEX = /^#[0-9a-f]{6}$/i;
const WORDS = new Set(['transparent', 'font-color', 'none', 'true', 'false']);

/** A #rrggbb colour in lower case, or null for anything else. */
export const hexColour = (value) => (typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null);

/** An ODF property bag with every colour that is not #rrggbb, or one of ODF's words for no colour, taken out. */
export function cleanColours(bag) {
  for (const key of Object.keys(bag)) {
    if (/color$/i.test(key) && !HEX.test(bag[key]) && !WORDS.has(bag[key])) delete bag[key];
  }
  return bag;
}
