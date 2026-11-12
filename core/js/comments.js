/** Comments placed on a page or a slide: a place and some text; GRT keeps no name or date with them. */

export const COMMENT_LIMITS = { count: 500, text: 100_000 };

let counter = 0;
const freshId = () => `c${Date.now().toString(36)}${(counter += 1).toString(36)}`;

/** Comments as a file gave them, kept to what is sound: a place and some text, five hundred at most. */
export function cleanComments(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 100_000).filter((c) => c && typeof c.text === 'string' && c.text.trim() !== '').slice(0, COMMENT_LIMITS.count)
    .map((c) => ({
      id: typeof c.id === 'string' && c.id !== '' ? c.id.slice(0, 64) : freshId(),
      x: Number.isFinite(Number(c.x)) ? Math.round(Number(c.x)) : 0,
      y: Number.isFinite(Number(c.y)) ? Math.round(Number(c.y)) : 0,
      text: c.text.slice(0, COMMENT_LIMITS.text),
    }));
}

export function newComment({ x, y, text }) {
  return { id: freshId(), x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0), text: String(text ?? '').slice(0, COMMENT_LIMITS.text) };
}
