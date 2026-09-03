/** Test utilities. */

import { inflateSync, constants } from 'node:zlib';

const LATIN1 = new TextDecoder('latin1');

/** Expands <48656C6C6F> style strings into the characters they encode. */
function decodeHexStrings(text) {
  const out = [];
  const pattern = /<([0-9A-Fa-f\s]{4,})>/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const digits = match[1].replace(/\s+/g, '');
    if (digits.length % 2 !== 0) continue;

    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    }

    out.push(LATIN1.decode(bytes));
    out.push(...utf16Variants(bytes));
  }

  return out;
}

/** The same bytes read as UTF-16, in both byte orders. */
function utf16Variants(bytes) {
  if (bytes.length < 4) return [];
  const out = [];
  for (const label of ['utf-16be', 'utf-16le']) {
    try {
      const decoded = new TextDecoder(label).decode(bytes);
      // The replacement character means it was not text in that encoding.
      if (!decoded.includes('\uFFFD')) out.push(decoded);
    } catch {
      // Encoding unsupported by this runtime; the other one still applies.
    }
  }
  return out;
}

/**
 * Every byte of the file, with all deflate-compressed streams expanded and
 * all hex strings decoded.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function deepText(bytes) {
  const raw = LATIN1.decode(bytes);
  const parts = [raw, ...decodeHexStrings(raw)];

  let cursor = 0;
  while (true) {
    const start = raw.indexOf('stream', cursor);
    if (start === -1) break;
    cursor = start + 'stream'.length;

    // Skip "endstream", which contains the keyword too.
    if (raw.slice(start - 3, start) === 'end') continue;

    // The specification allows CRLF or a bare LF after the keyword.
    let dataStart = start + 'stream'.length;
    if (raw[dataStart] === '\r') dataStart += 1;
    if (raw[dataStart] === '\n') dataStart += 1;

    const end = raw.indexOf('endstream', dataStart);
    if (end === -1) break;

    let inflated;
    try {
      inflated = LATIN1.decode(inflateSync(bytes.subarray(dataStart, end)));
    } catch {
      try {
        // Tolerates the trailing whitespace some writers leave before the
        // endstream keyword.
        inflated = LATIN1.decode(
          inflateSync(bytes.subarray(dataStart, end), {
            finishFlush: constants.Z_SYNC_FLUSH,
          }),
        );
      } catch {
        // Not deflate-compressed: the raw copy above already covers it.
        continue;
      }
    }

    parts.push(inflated, ...decodeHexStrings(inflated));
  }

  // Catch-all for UTF-16 text that never went through a hex string.
  const joined = parts.join('\n');
  return `${joined}\n${joined.replace(/\u0000/g, '')}`;
}

/**
 * Whether a string is reachable in the file at all.
 * @param {Uint8Array} bytes
 * @param {string} needle
 */
export function contains(bytes, needle) {
  return deepText(bytes).includes(needle);
}
