/** Whole ZIP packages (ODF, OOXML), read and written in one block of bytes. */

const MAGIC = 'GRTPACK1';

const utf8 = new TextDecoder('utf-8');

/** The entries of a package, in the archive's order. */
export class Package {
  /**
   * @param {Map<string, Uint8Array>} entries
   * @param {?string} damage why the archive could only be read in part
   */
  constructor(entries, damage = null) {
    this.entries = entries;
    this.damage = damage;
    // OOXML part names are case-insensitive.
    this.folded = new Map([...entries.keys()].map((name) => [name.toLowerCase(), name]));
  }

  get names() {
    return [...this.entries.keys()];
  }

  /** The stored name for a name in any case, or null. */
  find(name) {
    if (this.entries.has(name)) return name;
    return this.folded.get(name.toLowerCase()) ?? null;
  }

  has(name) {
    return this.find(name) !== null;
  }

  bytes(name) {
    const found = this.find(name);
    return found === null ? null : this.entries.get(found);
  }

  /** An entry as text, without a byte-order mark. */
  text(name) {
    const bytes = this.bytes(name);
    if (bytes === null) return null;
    return utf8.decode(bytes).replace(/^﻿/, '');
  }
}

/** @returns {Package} */
export function decodeBlock(block) {
  const bytes = block instanceof Uint8Array ? block : new Uint8Array(block);
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 8)) !== MAGIC) {
    throw new Error('The package came back in a shape this program does not know');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  const header = JSON.parse(utf8.decode(bytes.subarray(12, 12 + length)));
  const entries = new Map();
  let at = 12 + length;
  for (const { name, size } of header.entries) {
    entries.set(name, bytes.subarray(at, at + size));
    at += size;
  }
  return new Package(entries, header.damage ?? null);
}

/**
 * @param {{name: string, data: string|Uint8Array, store?: boolean}[]} entries in order
 * @returns {Uint8Array}
 */
export function encodeBlock(entries) {
  const encoder = new TextEncoder();
  const data = entries.map((entry) => (typeof entry.data === 'string'
    ? encoder.encode(entry.data) : entry.data));
  const header = encoder.encode(JSON.stringify({
    entries: entries.map((entry, i) => ({
      name: entry.name, size: data[i].length, store: !!entry.store,
    })),
  }));

  const size = data.reduce((sum, bytes) => sum + bytes.length, 0);
  const out = new Uint8Array(12 + header.length + size);
  for (let i = 0; i < MAGIC.length; i += 1) out[i] = MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, header.length, true);
  out.set(header, 12);
  let at = 12 + header.length;
  for (const bytes of data) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

const invoke = (...args) => window.__TAURI__.core.invoke(...args);

/** @returns {Promise<Package>} */
export async function readPackage(path) {
  return decodeBlock(await invoke('read_package', { path }));
}

/** Writes a package atomically, entries in the order given. */
export async function writePackage(path, entries) {
  await invoke('write_package', encodeBlock(entries), {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}
