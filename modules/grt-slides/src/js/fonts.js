/** Fonts carried by a document. */

/** Name-table entries worth showing, by their standard ids. */
const NAME_IDS = {
  0: 'Copyright',
  1: 'Family',
  5: 'Version',
  7: 'Trademark',
  8: 'Manufacturer',
  9: 'Designer',
  13: 'Licence',
  14: 'Licence URL',
};

const readU16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const readU32 = (bytes, at) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

/**
 * Reads what a font says about itself.
 * @param {Uint8Array} bytes
 * @returns {{format: string, names: Object<string,string>, readable: boolean}}
 */
export function describeFont(bytes) {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));

  if (tag === 'wOFF') return { format: 'WOFF', names: {}, readable: false };
  if (tag === 'wOF2') return { format: 'WOFF2', names: {}, readable: false };

  const sfnt = readU32(bytes, 0);
  const isTrueType = sfnt === 0x00010000 || tag === 'true' || tag === 'ttcf';
  const isOpenType = tag === 'OTTO';
  if (!isTrueType && !isOpenType) {
    return { format: 'unknown', names: {}, readable: false };
  }

  const format = isOpenType ? 'OpenType' : 'TrueType';

  try {
    const tableCount = readU16(bytes, 4);
    let nameOffset = 0;

    for (let i = 0; i < tableCount; i += 1) {
      const at = 12 + i * 16;
      if (String.fromCharCode(...bytes.subarray(at, at + 4)) === 'name') {
        nameOffset = readU32(bytes, at + 8);
        break;
      }
    }
    if (nameOffset === 0) return { format, names: {}, readable: true };

    const count = readU16(bytes, nameOffset + 2);
    const stringsAt = nameOffset + readU16(bytes, nameOffset + 4);
    const names = {};

    for (let i = 0; i < count; i += 1) {
      const record = nameOffset + 6 + i * 12;
      const platform = readU16(bytes, record);
      const nameId = readU16(bytes, record + 6);
      const length = readU16(bytes, record + 8);
      const offset = readU16(bytes, record + 10);

      const label = NAME_IDS[nameId];
      if (!label || names[label]) continue;

      const raw = bytes.subarray(stringsAt + offset, stringsAt + offset + length);
      // Platform 3 (Windows) stores UTF-16BE; platform 1 (Macintosh) is
      // single-byte.
      const text = platform === 3
        ? new TextDecoder('utf-16be').decode(raw)
        : new TextDecoder('latin1').decode(raw);

      const clean = text.replace(/\u0000/g, '').trim();
      if (clean) names[label] = clean;
    }

    return { format, names, readable: true };
  } catch {
    // A malformed font must not lose the document it was added to.
    return { format, names: {}, readable: false };
  }
}

/** The media type for an @font-face source. */
export function fontMediaType(name) {
  const extension = String(name).toLowerCase().split('.').pop();
  return {
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  }[extension] ?? 'application/octet-stream';
}

/**
 * The @font-face rules for the fonts a document carries.
 * @param {{id: string, name: string, resource: string}[]} fonts
 * @param {Map<string, string>} sources resource path to data URL
 * @returns {string}
 */
export function fontFaceRules(fonts, sources) {
  return (fonts ?? [])
    .map((font) => {
      const source = sources.get(font.resource);
      if (!source) return '';
      return `@font-face{font-family:"${font.name}";src:url(${source});font-display:swap}`;
    })
    .filter(Boolean)
    .join('\n');
}
