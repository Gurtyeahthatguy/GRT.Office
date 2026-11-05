/** Pictures without what the camera or the editor wrote about them: EXIF, GPS, XMP, comments, file names. */

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
/** PNG chunks that hold text, dates or EXIF. */
const PNG_DROPPED = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
const damaged = () => new Error('The picture is damaged, and was not inserted');

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The orientation an EXIF block gives, 1 when it gives none. */
function orientationOf(segment) {
  const tiff = 10;
  if (segment.length < tiff + 8) return 1;
  const little = ascii(segment, tiff, 2) === 'II';
  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  const u16 = (at) => view.getUint16(at, little);
  const u32 = (at) => view.getUint32(at, little);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > segment.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > segment.length) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** An EXIF block that says only how the picture is turned. */
function orientationOnly(orientation) {
  return new Uint8Array([
    0xFF, 0xE1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

function stripJpeg(bytes) {
  const kept = [bytes.subarray(0, 2)];
  let orientation = 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xFF) throw damaged();
    const marker = bytes[at + 1];
    if (marker === 0xFF) {
      at += 1;
      continue;
    }
    if (marker === 0xD9) {
      kept.push(bytes.subarray(at, at + 2));
      at = bytes.length;
      break;
    }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      kept.push(bytes.subarray(at, at + 2));
      at += 2;
      continue;
    }
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2 || at + 2 + length > bytes.length) throw damaged();
    const segment = bytes.subarray(at, at + 2 + length);
    if (marker === 0xDA) {
      // The scans run to the end-of-image marker; whatever a camera appends after it goes.
      let end = at + 2 + length;
      while (end + 1 < bytes.length && !(bytes[end] === 0xFF && bytes[end + 1] === 0xD9)) end += 1;
      if (end + 1 >= bytes.length) throw damaged();
      kept.push(bytes.subarray(at, end + 2));
      at = bytes.length;
      break;
    }
    const app = marker >= 0xE0 && marker <= 0xEF;
    if (marker === 0xE1 && ascii(segment, 4, 6) === 'Exif\0\0') orientation = orientationOf(segment.subarray(0));
    const keep = !app && marker !== 0xFE
      || marker === 0xE0
      || (marker === 0xE2 && ascii(segment, 4, 12) === 'ICC_PROFILE\0')
      || (marker === 0xEE && ascii(segment, 4, 5) === 'Adobe');
    if (keep) kept.push(segment);
    at += 2 + length;
  }
  if (orientation !== 1) kept.splice(kept[1] && kept[1][1] === 0xE0 ? 2 : 1, 0, orientationOnly(orientation));
  return concat(kept);
}

function stripPng(bytes) {
  const kept = [bytes.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
    const end = at + 12 + length;
    if (end > bytes.length) throw damaged();
    const type = ascii(bytes, at + 4, 4);
    if (!PNG_DROPPED.has(type)) kept.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  return concat(kept);
}

function stripWebp(bytes) {
  const kept = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0, true);
    const end = at + 8 + size + (size % 2);
    if (end > bytes.length + 1) throw damaged();
    const type = ascii(bytes, at, 4);
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = bytes.slice(at, Math.min(end, bytes.length));
      // The extended header says which of the dropped chunks there were.
      if (type === 'VP8X' && chunk.length > 8) chunk[8] &= ~0x0C;
      kept.push(chunk);
    }
    at = end;
  }
  const body = concat(kept);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}

function stripGif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const table = (packed) => (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  let at = 13 + table(bytes[10]);
  const kept = [bytes.subarray(0, at)];
  const blocksEnd = (from) => {
    let i = from;
    while (i < bytes.length && bytes[i] !== 0) i += bytes[i] + 1;
    if (i >= bytes.length) throw damaged();
    return i + 1;
  };
  while (at < bytes.length) {
    const kind = bytes[at];
    if (kind === 0x3B) {
      kept.push(bytes.subarray(at, at + 1));
      break;
    }
    if (kind === 0x21) {
      const label = bytes[at + 1];
      const end = blocksEnd(at + 2);
      const application = label === 0xFF && ascii(bytes, at + 3, 8);
      if (label !== 0xFE && !(label === 0xFF && application !== 'NETSCAPE' && application !== 'ANIMEXTS')) {
        kept.push(bytes.subarray(at, end));
      }
      at = end;
    } else if (kind === 0x2C) {
      const imageStart = at;
      at += 10 + table(view.getUint8(at + 9)) + 1;
      at = blocksEnd(at);
      kept.push(bytes.subarray(imageStart, at));
    } else {
      throw damaged();
    }
  }
  return concat(kept);
}

/** SVG without its metadata block, comments, and the file names drawing programs leave in it. */
function stripSvg(bytes) {
  const text = new TextDecoder().decode(bytes)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '')
    .replace(/\s(?:sodipodi|inkscape):[\w-]+="[^"]*"/g, '');
  return new TextEncoder().encode(text);
}

/** The picture with nothing identifying left in it; throws when it cannot be read well enough to be sure. */
export function stripMetadata(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return stripJpeg(bytes);
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return stripPng(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return stripWebp(bytes);
  if (bytes.length >= 13 && ascii(bytes, 0, 3) === 'GIF') return stripGif(bytes);
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  if (/<svg|<\?xml/.test(head)) return stripSvg(bytes);
  return bytes;
}

/** A name for a picture inside a document that says nothing about the file it came from. */
export async function neutralName(bytes, original) {
  const extension = (/\.([a-z0-9]{1,5})$/i.exec(String(original))?.[1] ?? 'bin').toLowerCase();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `resources/picture-${hex}.${extension}`;
}
