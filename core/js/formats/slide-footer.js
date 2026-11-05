/** Where a slide's footer, date and number go, the same in Slides, .odp and .pptx. */

/** Each part, its left and width as fractions of the slide, and how its text lines up. */
export const FOOTER_PLACES = [['date', 0.05, 0.25, 'left'], ['footer', 0.34, 0.32, 'center'], ['number', 0.7, 0.25, 'right']];
export const FOOTER_TOP = 0.91;
export const FOOTER_HEIGHT = 0.065;

/**
 * The boxes a slide's footer shows, with their text.
 * @param {{text: string, number: boolean, date: ?string, dateText: string}|null} footer
 * @param {{w: number, h: number}} canvas
 * @param {number} number the slide's place, from 1
 */
export function footerBoxes(footer, canvas, number, today = new Date()) {
  if (!footer) return [];
  const text = {
    date: footer.date ? (footer.date === 'auto' ? today.toLocaleDateString() : footer.dateText ?? '') : null,
    footer: footer.text || null,
    number: footer.number ? String(number) : null,
  };
  return FOOTER_PLACES.filter(([part]) => text[part] !== null).map(([part, x, width, align]) => ({
    part, align, text: text[part], auto: part === 'number' || (part === 'date' && footer.date === 'auto'),
    x: Math.round(x * canvas.w), y: Math.round(FOOTER_TOP * canvas.h), w: Math.round(width * canvas.w), h: Math.round(FOOTER_HEIGHT * canvas.h),
  }));
}
