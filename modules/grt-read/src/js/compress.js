/** Making a PDF smaller: its JPEG pictures encoded again, smaller where they are larger than they need to be, and only where that saves bytes. */

import { PDFName, PDFNumber, PDFRawStream, PDFArray } from '../vendor/pdf-lib.esm.js';

/** How hard to squeeze: the JPEG quality and the longest side a picture keeps, in pixels. */
export const LEVELS = {
  light: { label: 'Light: pictures stay sharp', quality: 0.85, maxSide: 3000 },
  medium: { label: 'Medium: good for the screen', quality: 0.7, maxSide: 2000 },
  strong: { label: 'Strong: smallest, pictures softer', quality: 0.5, maxSide: 1400 },
};

const name = (value) => (value instanceof PDFName ? value.asString() : null);

/** Whether a picture is a plain colour or grey JPEG that a browser can decode and encode again without changing its colours. */
function recompressible(dict, context) {
  if (name(dict.get(PDFName.of('Subtype'))) !== '/Image') return false;
  let filter = dict.get(PDFName.of('Filter'));
  if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.get(0) : null;
  if (name(filter) !== '/DCTDecode') return false;
  // A colour key mask, a stencil, a decode array or odd bit depths would mean something else once lossy.
  for (const key of ['Mask', 'ImageMask', 'Decode', 'DecodeParms']) if (dict.get(PDFName.of(key))) return false;
  const bits = dict.get(PDFName.of('BitsPerComponent'));
  if (bits && bits.asNumber?.() !== 8) return false;
  let space = dict.get(PDFName.of('ColorSpace'));
  space = space ? context.lookup(space) : null;
  const spaceName = name(space);
  if (spaceName) return spaceName === '/DeviceRGB' || spaceName === '/DeviceGray';
  // An ICC profile with three or one components is ordinary colour or grey.
  if (space instanceof PDFArray && name(space.get(0)) === '/ICCBased') {
    const profile = context.lookup(space.get(1));
    const n = profile?.dict?.get(PDFName.of('N'))?.asNumber?.();
    return n === 3 || n === 1;
  }
  return false;
}

/**
 * Encodes the document's JPEG pictures again.
 * @param {import('../vendor/pdf-lib.esm.js').PDFDocument} doc
 * @param {{quality: number, maxSide: number}} level
 * @param {(jpeg: Uint8Array, options: {quality: number, maxSide: number}) => Promise<?{bytes: Uint8Array, width: number, height: number}>} encode
 * @returns {Promise<{pictures: number, before: number, after: number}>}
 */
export async function recompressImages(doc, level, encode = encodeInWebview) {
  const context = doc.context;
  let pictures = 0;
  let before = 0;
  let after = 0;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || !recompressible(object.dict, context)) continue;
    const jpeg = object.contents;
    let made = null;
    try {
      made = await encode(jpeg, level);
    } catch {
      made = null;
    }
    // Only a smaller picture replaces the old one.
    if (!made || made.bytes.length >= jpeg.length) continue;
    const dict = object.dict.clone(context);
    dict.set(PDFName.of('Width'), PDFNumber.of(made.width));
    dict.set(PDFName.of('Height'), PDFNumber.of(made.height));
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    dict.set(PDFName.of('Length'), PDFNumber.of(made.bytes.length));
    context.assign(ref, PDFRawStream.of(dict, made.bytes));
    pictures += 1;
    before += jpeg.length;
    after += made.bytes.length;
  }
  return { pictures, before, after };
}

/** The webview's own decoder and encoder: the picture is drawn, smaller if need be, and encoded as JPEG again. */
export async function encodeInWebview(jpeg, { quality, maxSide }) {
  // The picture is taken as stored: an EXIF rotation would turn it on the page.
  const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), { imageOrientation: 'none' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const draw = canvas.getContext('2d');
  draw.imageSmoothingQuality = 'high';
  draw.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}
