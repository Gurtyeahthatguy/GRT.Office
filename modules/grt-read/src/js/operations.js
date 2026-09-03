/** Things drawn onto pages at save time. */

import {
  StandardFonts, degrees, rgb, PDFName, PDFArray, PDFRawStream, decodePDFRawStream,
} from '../vendor/pdf-lib.esm.js';
import { redactContent } from './redact.js';

/**
 * Restricts each page to the visible region the user chose.
 * @param {PDFPage[]} pages
 * @param {{crop: ?Object}[]} plan
 */
export function applyCrops(pages, plan) {
  pages.forEach((page, i) => {
    const crop = plan[i]?.crop;
    if (!crop) return;

    const box = page.getMediaBox();
    // Fractions rather than points, so a crop set on one page size still
    // means the same thing if applied to another.
    const left = box.x + box.width * crop.left;
    const bottom = box.y + box.height * crop.bottom;
    const width = box.width * (1 - crop.left - crop.right);
    const height = box.height * (1 - crop.bottom - crop.top);

    if (width <= 1 || height <= 1) return;
    page.setCropBox(left, bottom, width, height);
  });
}

/**
 * Draws a diagonal text watermark across every page.
 * @param {PDFDocument} doc
 * @param {PDFPage[]} pages
 * @param {{text: string, opacity: number, size: number}} config
 */
export async function applyWatermark(doc, pages, config) {
  const text = (config.text ?? '').trim();
  if (!text) return;

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const opacity = clamp(config.opacity ?? 0.18, 0.02, 1);

  for (const page of pages) {
    const { width, height } = page.getSize();

    // Sized to the page rather than fixed, so the same watermark reads the
    // same on A4 and on a slide.
    const size = config.size && config.size > 0
      ? config.size
      : Math.min(width, height) / Math.max(text.length, 6) * 1.6;

    const textWidth = font.widthOfTextAtSize(text, size);
    const angle = Math.atan2(height, width);

    // Centre the string on the page's diagonal.
    const x = width / 2 - (textWidth / 2) * Math.cos(angle);
    const y = height / 2 - (textWidth / 2) * Math.sin(angle);

    page.drawText(text, {
      x,
      y,
      size,
      font,
      color: rgb(0.5, 0.5, 0.5),
      opacity,
      rotate: degrees((angle * 180) / Math.PI),
    });
  }
}

const NUMBER_POSITIONS = ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'];

/**
 * Stamps a page number onto every page.
 * @param {PDFDocument} doc
 * @param {PDFPage[]} pages
 * @param {{start: number, position: string, format: string, size: number}} config
 */
export async function applyPageNumbers(doc, pages, config) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = config.size && config.size > 0 ? config.size : 10;
  const start = Number.isFinite(config.start) ? config.start : 1;
  const position = NUMBER_POSITIONS.includes(config.position)
    ? config.position
    : 'bottom-center';
  const margin = 24;

  pages.forEach((page, i) => {
    const number = start + i;
    const label = (config.format ?? '{n}')
      .replaceAll('{n}', String(number))
      .replaceAll('{total}', String(pages.length));

    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, size);

    const x = position.endsWith('left') ? margin
      : position.endsWith('right') ? width - margin - textWidth
        : (width - textWidth) / 2;
    const y = position.startsWith('top') ? height - margin : margin - size / 2;

    page.drawText(label, { x, y, size, font, color: rgb(0, 0, 0) });
  });
}

/**
 * Writes metadata the user asked for, after stripping cleared everything.
 * @param {PDFDocument} doc
 * @param {Object} metadata
 */
export function applyMetadata(doc, metadata) {
  if (!metadata) return;
  const set = (value, apply) => {
    if (typeof value === 'string' && value.trim() !== '') apply(value);
  };

  set(metadata.title, (v) => doc.setTitle(v));
  set(metadata.author, (v) => doc.setAuthor(v));
  set(metadata.subject, (v) => doc.setSubject(v));
  set(metadata.creator, (v) => doc.setCreator(v));
  set(metadata.producer, (v) => doc.setProducer(v));
  if (typeof metadata.keywords === 'string' && metadata.keywords.trim() !== '') {
    doc.setKeywords(metadata.keywords.split(',').map((k) => k.trim()).filter(Boolean));
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Marks drawn on, or cut out of, pages

/** Reads a page's content stream, whatever shape it is stored in. */
function readPageContent(doc, page) {
  const entry = page.node.get(PDFName.of('Contents'));
  const value = doc.context.lookup(entry);
  const chunks = [];
  const refs = [];

  const collect = (ref, stream) => {
    if (stream instanceof PDFRawStream) {
      chunks.push(decodePDFRawStream(stream).decode());
      if (ref) refs.push(ref);
    }
  };

  if (value instanceof PDFArray) {
    for (const item of value.asArray()) collect(item, doc.context.lookup(item));
  } else {
    collect(entry, value);
  }

  if (chunks.length === 0) return { bytes: new Uint8Array(0), refs };

  // Streams in an array are concatenated with whitespace between them.
  const total = chunks.reduce((sum, c) => sum + c.length + 1, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
    joined[offset] = 0x0a;
    offset += 1;
  }
  return { bytes: joined, refs };
}

/** Replaces a page's content with the rewritten bytes. */
function writePageContent(doc, page, bytes, refs) {
  const replacement = doc.context.flateStream(bytes);

  if (refs.length === 0) {
    page.node.set(PDFName.of('Contents'), doc.context.register(replacement));
    return;
  }

  const [first, ...spares] = refs;
  doc.context.assign(first, replacement);
  for (const ref of spares) doc.context.delete(ref);
  page.node.set(PDFName.of('Contents'), first);
}

/** Converts a mark's fractional rectangle into PDF user space. */
function toUserSpace(page, rect) {
  const box = page.getMediaBox();
  const x = box.x + box.width * rect.x;
  const width = box.width * rect.width;
  // Marks are stored with the origin at the top left, the way the interface
  // sees the page; PDF counts from the bottom.
  const y2 = box.y + box.height * (1 - rect.y);
  const y = y2 - box.height * rect.height;
  return { x, y, x2: x + width, y2 };
}

/**
 * Applies highlights and redactions.
 * @returns {{redacted: number, leaked: string[]}}
 */
export function applyMarks(doc, pages, plan) {
  const summary = { redacted: 0, leaked: [] };

  pages.forEach((page, i) => {
    const marks = plan[i]?.marks;
    if (!marks || marks.length === 0) return;

    const redactions = marks.filter((m) => m.type === 'redact');
    const highlights = marks.filter((m) => m.type === 'highlight');

    if (redactions.length > 0) {
      const regions = redactions.map((m) => toUserSpace(page, m.rect));
      const { bytes: content, refs } = readPageContent(doc, page);

      if (content.length > 0) {
        const result = redactContent(content, regions);
        writePageContent(doc, page, result.bytes, refs);
        summary.redacted += redactions.length;
        summary.leaked.push(...result.leaked);
      }

      // Only now, with nothing left underneath, is the box drawn.
      for (const region of regions) {
        page.drawRectangle({
          x: region.x,
          y: region.y,
          width: region.x2 - region.x,
          height: region.y2 - region.y,
          color: rgb(0, 0, 0),
        });
      }
    }

    for (const mark of highlights) {
      const region = toUserSpace(page, mark.rect);
      page.drawRectangle({
        x: region.x,
        y: region.y,
        width: region.x2 - region.x,
        height: region.y2 - region.y,
        color: rgb(1, 0.92, 0.23),
        opacity: 0.35,
      });
    }
  });

  return summary;
}
