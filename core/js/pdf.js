/** The suite's print engine. */

import { PDFDocument, StandardFonts, rgb } from '../../vendor/pdf-lib.esm.js';
import { stripMetadata, auditBytes } from './metadata.js';

/**
 * @typedef {Object} Primitive
 * @property {'rect'|'ellipse'|'polygon'|'polyline'|'text'|'image'} type
 */

/** A colour, or undefined for "do not draw this part". */
/**
 * Embeds a picture, choosing the decoder from its own bytes.
 * @returns {Promise<?Object>} null when the format is not one of the two a PDF
 */
async function embedImage(doc, bytes) {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;

  try {
    if (isPng) return await doc.embedPng(bytes);
    if (isJpeg) return await doc.embedJpg(bytes);
  } catch {
    // A corrupt or unsupported picture must not lose the whole document.
  }
  return null;
}

/** The characters the standard PDF fonts can draw: Latin-1 and Windows-1252's extras. */
const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const SUBSTITUTES = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≤': '<=', '≥': '>=', '≠': '!=', '−': '-', '‐': '-',
  '‑': '-', '‒': '-', '―': '-', '′': "'", '″': '"', '✓': 'v', '✔': 'v', '✗': 'x', '☐': '[ ]', '☑': '[x]',
};

const drawable = (char) => {
  const code = char.codePointAt(0);
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char);
};

/**
 * Text the standard fonts can draw: a close equivalent, or the letter
 * without its accent, or a question mark, for every character they cannot.
 * @returns {{text: string, replaced: number}}
 */
export function drawableText(text) {
  let out = '';
  let replaced = 0;
  for (const char of String(text ?? '')) {
    if (drawable(char)) {
      out += char;
      continue;
    }
    if (/\s/.test(char)) {
      out += ' ';
      continue;
    }
    replaced += 1;
    if (SUBSTITUTES[char]) {
      out += SUBSTITUTES[char];
      continue;
    }
    const bare = char.normalize('NFKD').replace(/\p{M}/gu, '');
    out += [...bare].every(drawable) && bare !== '' ? bare : '?';
  }
  return { text: out, replaced };
}

const colour = (value, fallback = undefined) => {
  if (!value || value === 'none') return fallback;
  const hex = String(value).replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length !== 6) return fallback;
  return rgb(
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  );
};

/**
 * Draws a page and returns the PDF bytes.
 * @param {{width: number, height: number, primitives: Primitive[]}} page
 * @param {{audit?: boolean, report?: {replaced: number}}} [options] `report`
 *        counts the characters the PDF font could not draw
 * @returns {Promise<Uint8Array>}
 */
export async function renderToPdf(page, options = {}) {
  const { audit = true, report = null } = options;

  const doc = await PDFDocument.create({ updateMetadata: false });
  const pdfPage = doc.addPage([page.width, page.height]);
  const fonts = new Map();
  const fontFor = async (bold, italic) => {
    const name = bold && italic ? StandardFonts.HelveticaBoldOblique
      : bold ? StandardFonts.HelveticaBold
        : italic ? StandardFonts.HelveticaOblique
          : StandardFonts.Helvetica;
    if (!fonts.has(name)) fonts.set(name, await doc.embedFont(name));
    return fonts.get(name);
  };

  // Callers work in screen coordinates; PDF counts upwards from the bottom.
  const flip = (y) => page.height - y;

  for (const item of page.primitives ?? []) {
    switch (item.type) {
      case 'rect':
        pdfPage.drawRectangle({
          x: item.x,
          y: flip(item.y + item.h),
          width: item.w,
          height: item.h,
          color: colour(item.fill),
          borderColor: colour(item.stroke),
          borderWidth: item.strokeWidth ?? 0,
        });
        break;

      case 'ellipse':
        pdfPage.drawEllipse({
          x: item.cx,
          y: flip(item.cy),
          xScale: item.rx,
          yScale: item.ry,
          color: colour(item.fill),
          borderColor: colour(item.stroke),
          borderWidth: item.strokeWidth ?? 0,
        });
        break;

      case 'polygon': {
        const points = item.points ?? [];
        if (points.length < 3) break;

        // Filled shapes go through an SVG path.
        const d = `${points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')} Z`;
        pdfPage.drawSvgPath(d, {
          x: 0,
          y: page.height,
          color: colour(item.fill),
          borderColor: colour(item.stroke),
          borderWidth: item.strokeWidth ?? 0,
        });
        break;
      }

      case 'path': {
        if (!item.d) break;
        pdfPage.drawSvgPath(item.d, {
          x: 0,
          y: page.height,
          color: colour(item.fill),
          borderColor: colour(item.stroke),
          borderWidth: item.stroke ? item.strokeWidth ?? 1 : 0,
        });
        break;
      }

      case 'polyline': {
        const points = item.points ?? [];
        if (points.length < 2) break;

        for (let i = 0; i < points.length - 1; i += 1) {
          pdfPage.drawLine({
            start: { x: points[i][0], y: flip(points[i][1]) },
            end: { x: points[i + 1][0], y: flip(points[i + 1][1]) },
            color: colour(item.stroke, rgb(0.2, 0.2, 0.2)),
            thickness: item.strokeWidth ?? 1,
          });
        }
        break;
      }

      case 'image': {
        // Embedded rather than drawn.
        if (!item.bytes || item.bytes.length === 0) break;

        const embedded = await embedImage(doc, item.bytes);
        if (!embedded) {
          // Marked, not skipped: a visible frame says something belongs here.
          pdfPage.drawRectangle({
            x: item.x,
            y: flip(item.y + item.h),
            width: item.w,
            height: item.h,
            borderColor: rgb(0.75, 0.75, 0.75),
            borderWidth: 1,
          });
          break;
        }

        // Fitted inside the box it was given, keeping its proportions.
        const scale = Math.min(item.w / embedded.width, item.h / embedded.height);
        const width = embedded.width * scale;
        const height = embedded.height * scale;

        pdfPage.drawImage(embedded, {
          x: item.x + (item.w - width) / 2,
          y: flip(item.y + item.h) + (item.h - height) / 2,
          width,
          height,
        });
        break;
      }

      case 'text': {
        const size = item.size ?? 12;
        const font = await fontFor(!!item.bold, !!item.italic);
        const drawable = drawableText(item.text);
        if (report) report.replaced += drawable.replaced;
        let { text } = drawable;
        if (item.maxWidth > 0 && font.widthOfTextAtSize(text, size) > item.maxWidth) {
          let low = 0;
          let high = text.length;
          while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (font.widthOfTextAtSize(text.slice(0, middle), size) <= item.maxWidth) low = middle;
            else high = middle - 1;
          }
          text = text.slice(0, low);
        }
        const width = font.widthOfTextAtSize(text, size);
        const x = item.align === 'center' ? item.x - width / 2
          : item.align === 'right' ? item.x - width
            : item.x;

        pdfPage.drawText(text, {
          x,
          // drawText places the baseline; callers give the text's top edge.
          y: flip(item.y) - size * 0.8,
          size,
          font,
          color: colour(item.fill, rgb(0.13, 0.13, 0.13)),
        });
        break;
      }

      default:
        break;
    }
  }

  // Last thing before serialising, exactly as in GRT Read.
  stripMetadata(doc);

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  if (audit) {
    const found = auditBytes(bytes);
    if (found.length > 0) {
      console.warn('[GRT] Residual fingerprints in the exported PDF:', found);
    }
  }

  return bytes;
}

/** Joins single-page PDFs into one, metadata stripped like every PDF the suite writes. */
export async function mergePdfPages(pages) {
  const output = await PDFDocument.create({ updateMetadata: false });
  for (const bytes of pages) {
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const copied = await output.copyPages(source, source.getPageIndices());
    for (const page of copied) output.addPage(page);
  }
  stripMetadata(output);
  return output.save({ useObjectStreams: true, addDefaultPage: false });
}
