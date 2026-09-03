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
 * @param {{audit?: boolean}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function renderToPdf(page, options = {}) {
  const { audit = true } = options;

  const doc = await PDFDocument.create({ updateMetadata: false });
  const pdfPage = doc.addPage([page.width, page.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

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
        const width = font.widthOfTextAtSize(item.text ?? '', size);
        const x = item.align === 'center' ? item.x - width / 2
          : item.align === 'right' ? item.x - width
            : item.x;

        pdfPage.drawText(item.text ?? '', {
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
