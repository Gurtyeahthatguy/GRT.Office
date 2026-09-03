/** Removing content, not covering it. */

import { tokenize, serialize } from './content-stream.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** PDF matrices are row-vector form: [a b c d e f]. */
function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Average glyph width as a fraction of the font size. */
const GLYPH_WIDTH_RATIO = 0.65;

/**
 * How far outside the marked box text still counts as inside it, in points.
 */
const SAFETY_MARGIN = 2;

function rectsIntersect(a, b) {
  return !(a.x2 < b.x - SAFETY_MARGIN || a.x > b.x2 + SAFETY_MARGIN
    || a.y2 < b.y - SAFETY_MARGIN || a.y > b.y2 + SAFETY_MARGIN);
}

/**
 * Axis-aligned bounds of a box after a transform, so rotated text still
 * works.
 */
function transformedBounds(matrix, x, y, width, height) {
  const corners = [
    apply(matrix, x, y),
    apply(matrix, x + width, y),
    apply(matrix, x, y + height),
    apply(matrix, x + width, y + height),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    x: Math.min(...xs), x2: Math.max(...xs),
    y: Math.min(...ys), y2: Math.max(...ys),
  };
}

/**
 * Rewrites a content stream with everything inside the given regions removed.
 * @param {Uint8Array} bytes decoded content stream
 * @param {{x: number, y: number, x2: number, y2: number}[]} regions user space
 * @returns {{bytes: Uint8Array, removed: string[], leaked: string[]}}
 */
export function redactContent(bytes, regions) {
  if (regions.length === 0) {
    return { bytes, removed: [], leaked: [] };
  }

  const tokens = tokenize(bytes);
  const instructions = groupIntoInstructions(tokens);

  // Graphics state.
  let ctm = IDENTITY;
  const stack = [];
  let textMatrix = IDENTITY;
  let lineMatrix = IDENTITY;
  let fontSize = 12;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let rise = 0;

  const kept = [];
  const removed = [];

  for (const instruction of instructions) {
    const { op, operands } = instruction;
    const numbers = operands.filter((t) => t.type === 'number').map((t) => t.value);
    const strings = operands.filter((t) => t.type === 'string').map((t) => t.value);

    let drop = false;

    switch (op) {
      case 'q':
        stack.push({ ctm, fontSize, leading, charSpacing, wordSpacing, horizontalScale, rise });
        break;
      case 'Q': {
        const saved = stack.pop();
        if (saved) {
          ({ ctm, fontSize, leading, charSpacing, wordSpacing, horizontalScale, rise } = saved);
        }
        break;
      }
      case 'cm':
        if (numbers.length >= 6) ctm = multiply(numbers.slice(-6), ctm);
        break;
      case 'BT':
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        break;
      case 'Tf':
        if (numbers.length >= 1) fontSize = numbers[numbers.length - 1];
        break;
      case 'TL':
        if (numbers.length >= 1) leading = numbers[0];
        break;
      case 'Tc':
        if (numbers.length >= 1) charSpacing = numbers[0];
        break;
      case 'Tw':
        if (numbers.length >= 1) wordSpacing = numbers[0];
        break;
      case 'Tz':
        if (numbers.length >= 1) horizontalScale = numbers[0] / 100;
        break;
      case 'Ts':
        if (numbers.length >= 1) rise = numbers[0];
        break;
      case 'Td':
        if (numbers.length >= 2) {
          lineMatrix = multiply([1, 0, 0, 1, numbers[0], numbers[1]], lineMatrix);
          textMatrix = lineMatrix;
        }
        break;
      case 'TD':
        if (numbers.length >= 2) {
          leading = -numbers[1];
          lineMatrix = multiply([1, 0, 0, 1, numbers[0], numbers[1]], lineMatrix);
          textMatrix = lineMatrix;
        }
        break;
      case 'Tm':
        if (numbers.length >= 6) {
          lineMatrix = numbers.slice(-6);
          textMatrix = lineMatrix;
        }
        break;
      case 'T*':
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
        textMatrix = lineMatrix;
        break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        // The quote operators start a new line before showing anything.
        if (op === "'" || op === '"') {
          lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
          textMatrix = lineMatrix;
        }

        const shown = strings.join('');
        const advance = estimateAdvance(shown, fontSize, charSpacing, wordSpacing, horizontalScale);

        const trm = multiply(
          [fontSize * horizontalScale, 0, 0, fontSize, 0, rise],
          multiply(textMatrix, ctm),
        );
        // A generous line box: most of an em above the baseline and a
        // descender below it, in text space where the font size is 1.
        const bounds = transformedBounds(trm, 0, -0.3, advance / Math.max(fontSize, 0.001), 1.2);

        if (regions.some((region) => rectsIntersect(bounds, region))) {
          drop = true;
          if (shown) removed.push(shown);
        }

        // The pen advances whether or not the text was kept, so everything
        // that follows stays where it belongs.
        textMatrix = multiply([1, 0, 0, 1, advance, 0], textMatrix);
        break;
      }
      case 'Do': {
        // An image or form placed inside the region goes too.
        const bounds = transformedBounds(ctm, 0, 0, 1, 1);
        if (regions.some((region) => rectsIntersect(bounds, region))) drop = true;
        break;
      }
      case 'INLINE_IMAGE': {
        const bounds = transformedBounds(ctm, 0, 0, 1, 1);
        if (regions.some((region) => rectsIntersect(bounds, region))) drop = true;
        break;
      }
      default:
        break;
    }

    if (!drop) kept.push(...instruction.tokens);
  }

  const out = serialize(kept);

  // Verification rather than trust.
  const text = new TextDecoder('latin1').decode(out);
  const leaked = [...new Set(removed)].filter((value) => value.length > 2 && text.includes(value));

  return { bytes: out, removed, leaked };
}

function estimateAdvance(shown, fontSize, charSpacing, wordSpacing, horizontalScale) {
  const spaces = (shown.match(/ /g) ?? []).length;
  const width = shown.length * fontSize * GLYPH_WIDTH_RATIO
    + shown.length * charSpacing
    + spaces * wordSpacing;
  return width * horizontalScale;
}

/** Collects tokens into operator-with-operands groups. */
function groupIntoInstructions(tokens) {
  const instructions = [];
  let operands = [];
  let raw = [];

  for (const token of tokens) {
    if (token.type === 'inline-image') {
      instructions.push({ op: 'INLINE_IMAGE', operands: [...operands], tokens: [...raw, token] });
      operands = [];
      raw = [];
      continue;
    }

    raw.push(token);

    if (token.type === 'operator') {
      instructions.push({ op: token.value, operands: [...operands], tokens: [...raw] });
      operands = [];
      raw = [];
    } else if (token.type !== 'comment') {
      operands.push(token);
    }
  }

  // Trailing operands with no operator are malformed but harmless; keep them
  // so nothing is silently discarded.
  if (raw.length > 0) instructions.push({ op: '', operands, tokens: raw });

  return instructions;
}
