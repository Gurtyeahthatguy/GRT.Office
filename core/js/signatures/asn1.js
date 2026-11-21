/** DER, the encoding of certificates and signatures: read into a tree of tagged values, refusing what does not fit. */

const MAX_DEPTH = 64;
const MAX_NODES = 200000;

/**
 * One DER value and its children.
 * @typedef {{tag: number, cls: number, constructed: boolean, start: number, header: number, length: number, end: number, children: Node[] | null, bytes: Uint8Array}} Node
 */

/** Reads the DER value at a place; constructed values are read into their children. */
export function parseDer(bytes, start = 0, end = bytes.length, depth = 0, count = { n: 0 }) {
  if (depth > MAX_DEPTH || count.n > MAX_NODES) throw new Error('A signature nested too deeply');
  count.n += 1;
  if (start + 2 > end) throw new Error('A damaged signature');
  const first = bytes[start];
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let at = start + 1;
  if (tag === 0x1f) {
    tag = 0;
    for (let i = 0; i < 4; i += 1) { const b = bytes[at++]; tag = (tag << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
  }
  if (at >= end) throw new Error('A damaged signature');
  let length = bytes[at++];
  if (length & 0x80) {
    const size = length & 0x7f;
    if (size === 0 || size > 4) throw new Error('A signature with a length GRT does not read');
    if (at + size > end) throw new Error('A damaged signature');
    length = 0;
    for (let i = 0; i < size; i += 1) length = length * 256 + bytes[at++];
  }
  const header = at - start;
  if (at + length > end) throw new Error('A damaged signature');
  const node = { tag, cls, constructed, start, header, length, end: at + length, children: null, bytes: bytes.subarray(start, at + length) };
  if (constructed) {
    node.children = [];
    let p = at;
    while (p < at + length) {
      const child = parseDer(bytes, p, at + length, depth + 1, count);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

/** The content bytes of a value, without its tag and length. */
export const content = (node) => node.bytes.subarray(node.header);

/** An object identifier as dotted text. */
export function oid(node) {
  const b = content(node);
  if (!b.length) return '';
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let value = 0;
  for (let i = 1; i < b.length; i += 1) {
    value = value * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(value); value = 0; }
  }
  return parts.join('.');
}

/** A string value: UTF-8, printable, IA5, BMP or T61. */
export function text(node) {
  const b = content(node);
  if (node.tag === 0x1e) {
    let out = '';
    for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return out;
  }
  if (node.tag === 0x0c) return new TextDecoder().decode(b);
  let out = '';
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return out;
}

/** A UTCTime or GeneralizedTime as a date. */
export function time(node) {
  const s = text(node);
  const m = node.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/.exec(s);
  if (!m) return null;
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

/** Bytes of hex text, spaces and line ends ignored. */
export function fromHex(hex) {
  const clean = String(hex).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Two byte arrays equal. */
export const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Base64 to bytes, whitespace ignored. */
export function fromBase64(text) {
  const binary = atob(String(text).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
