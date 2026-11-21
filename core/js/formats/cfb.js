/** Microsoft's Compound File Binary: the container of .doc, .xls and .ppt, read and written, version 3 with 512-byte sectors. */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const NONE = 0xffffffff;
const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
/** The most a file may ask to be read, so a hostile one cannot make the reader allocate without end. */
const LIMIT = 512 * 1024 * 1024;

/**
 * The streams of a compound file, by their paths: "WordDocument", "ObjectPool/_1234/Ole".
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
function readCfbUnsafe(bytes) {
  if (bytes.length < SECTOR || !SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('Not a compound file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  const shift = u16(30);
  if (shift !== 9 && shift !== 12) throw new Error('A compound file with sectors of an unknown size');
  const size = 1 << shift;
  const miniShift = u16(32);
  const miniSize = 1 << miniShift;
  const cutoff = u32(56);
  const sectorAt = (n) => size + n * size;
  const sectorCount = Math.floor((bytes.length - size) / size);

  // The FAT's own sectors: 109 in the header, the rest down the DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) { const s = u32(76 + i * 4); if (s !== FREE) fatSectors.push(s); }
  let difat = u32(68);
  for (let guard = 0; difat !== END && difat !== FREE && guard < sectorCount; guard += 1) {
    if (difat >= sectorCount) break;
    const base = sectorAt(difat);
    for (let i = 0; i < size / 4 - 1; i += 1) { const s = u32(base + i * 4); if (s !== FREE) fatSectors.push(s); }
    difat = u32(base + size - 4);
  }
  const fat = new Uint32Array(Math.min(fatSectors.length * (size / 4), sectorCount + 1024));
  fatSectors.forEach((s, i) => {
    if (s >= sectorCount) return;
    for (let k = 0; k < size / 4 && i * (size / 4) + k < fat.length; k += 1) fat[i * (size / 4) + k] = u32(sectorAt(s) + k * 4);
  });

  /** A chain of sectors followed through a table, refusing loops. */
  const chain = (start, table, count) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== END && s !== FREE; s = table[s]) {
      if (s >= count || seen.has(s) || s >= table.length) break;
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readChain = (start, length = Infinity) => {
    const list = chain(start, fat, sectorCount);
    const total = Math.min(list.length * size, length, LIMIT);
    const out = new Uint8Array(total);
    list.forEach((s, i) => {
      const from = sectorAt(s);
      const take = Math.min(size, total - i * size);
      if (take > 0) out.set(bytes.subarray(from, from + take), i * size);
    });
    return out;
  };

  const directory = readChain(u32(48));
  const entries = [];
  for (let at = 0; at + 128 <= directory.length; at += 128) {
    const nameLength = directory[at + 64] | (directory[at + 65] << 8);
    let name = '';
    for (let i = 0; i < Math.min(nameLength, 64) - 2; i += 2) name += String.fromCharCode(directory[at + i] | (directory[at + i + 1] << 8));
    const dv = new DataView(directory.buffer, directory.byteOffset + at, 128);
    entries.push({
      name, type: directory[at + 66], left: dv.getUint32(68, true), right: dv.getUint32(72, true), child: dv.getUint32(76, true),
      start: dv.getUint32(116, true), size: shift === 9 ? dv.getUint32(120, true) : dv.getUint32(120, true) + dv.getUint32(124, true) * 2 ** 32,
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new Error('A compound file without its root');
  const miniStream = readChain(root.start, root.size);
  const miniFat = (() => {
    const raw = readChain(u32(60));
    return new Uint32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  })();
  const miniCount = Math.floor(miniStream.length / miniSize);

  const streamOf = (entry) => {
    const length = Math.min(entry.size, LIMIT);
    if (length < cutoff) {
      const list = chain(entry.start, miniFat, miniCount);
      const out = new Uint8Array(Math.min(length, list.length * miniSize));
      list.forEach((s, i) => {
        const take = Math.min(miniSize, out.length - i * miniSize);
        if (take > 0) out.set(miniStream.subarray(s * miniSize, s * miniSize + take), i * miniSize);
      });
      return out;
    }
    return readChain(entry.start, length);
  };

  // The tree of storages, walked from the root's child, each storage's members under its path.
  const out = new Map();
  const visited = new Set();
  const walk = (id, prefix) => {
    if (id === NONE || id >= entries.length || visited.has(id)) return;
    visited.add(id);
    const entry = entries[id];
    walk(entry.left, prefix);
    walk(entry.right, prefix);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 2) out.set(path, streamOf(entry));
    else if (entry.type === 1) walk(entry.child, path);
  };
  walk(root.child, '');
  return out;
}

/** Whether bytes are a compound file. */
export const isCfb = (bytes) => bytes?.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);

/** Directory names compare by length first, then letter by letter in upper case, as the format orders them. */
const compareNames = (a, b) => (a.length !== b.length ? a.length - b.length : a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);

/**
 * A compound file of streams, given by paths; storages are made for the folders.
 * @param {Map<string, Uint8Array>|[string, Uint8Array][]} streams
 * @param {{clsid?: Uint8Array}} options the root's class, as Word and Excel set it
 * @returns {Uint8Array}
 */
export function writeCfb(streams, options = {}) {
  // The tree of storages and streams.
  const root = { name: 'Root Entry', type: 5, children: new Map(), clsid: options.clsid };
  for (const [path, data] of streams) {
    const parts = path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node.children.set(part, { name: part, type: 2, data });
      else {
        if (!node.children.has(part)) node.children.set(part, { name: part, type: 1, children: new Map() });
        node = node.children.get(part);
      }
    });
  }
  const nodes = [];
  const number = (node) => { node.id = nodes.length; nodes.push(node); for (const child of node.children?.values() ?? []) number(child); };
  number(root);
  // Each storage's members as a balanced binary tree in the format's order.
  const balance = (list) => {
    if (!list.length) return NONE;
    const mid = list.length >> 1;
    const node = list[mid];
    node.left = balance(list.slice(0, mid));
    node.right = balance(list.slice(mid + 1));
    return node.id;
  };
  for (const node of nodes) {
    if (!node.children) continue;
    node.child = balance([...node.children.values()].sort((a, b) => compareNames(a.name, b.name)));
  }

  // Small streams go in the mini stream, sixty-four bytes a sector; the rest in sectors of their own.
  const small = nodes.filter((n) => n.type === 2 && n.data.length < CUTOFF);
  const large = nodes.filter((n) => n.type === 2 && n.data.length >= CUTOFF);
  const miniFat = [];
  const miniChunks = [];
  for (const node of small) {
    const count = Math.ceil(node.data.length / MINI);
    node.start = count ? miniFat.length : END;
    for (let i = 0; i < count; i += 1) miniFat.push(i === count - 1 ? END : miniFat.length + 1);
    if (count) {
      const padded = new Uint8Array(count * MINI);
      padded.set(node.data);
      miniChunks.push(padded);
    }
  }
  const miniStream = concat(miniChunks);
  const sectorsFor = (length) => Math.ceil(length / SECTOR);
  const directorySectors = sectorsFor(nodes.length * 128);
  const miniFatSectors = sectorsFor(miniFat.length * 4);
  const miniStreamSectors = sectorsFor(miniStream.length);
  const dataSectors = large.reduce((sum, n) => sum + sectorsFor(n.data.length), 0);
  const content = directorySectors + miniFatSectors + miniStreamSectors + dataSectors;
  // The FAT must hold itself and the DIFAT too.
  let fatSectors = 1;
  let difatSectors = 0;
  for (;;) {
    difatSectors = fatSectors > 109 ? Math.ceil((fatSectors - 109) / 127) : 0;
    const need = Math.ceil((content + fatSectors + difatSectors) / 128);
    if (need <= fatSectors) break;
    fatSectors = need;
  }
  const total = content + fatSectors + difatSectors;
  const fat = new Uint32Array(fatSectors * 128).fill(FREE);
  let next = 0;
  const allocate = (count) => {
    if (!count) return END;
    const first = next;
    for (let i = 0; i < count; i += 1) fat[next + i] = i === count - 1 ? END : next + i + 1;
    next += count;
    return first;
  };
  const difatStart = next;
  for (let i = 0; i < difatSectors; i += 1) fat[next + i] = DIFAT_SECTOR;
  next += difatSectors;
  const fatStart = next;
  for (let i = 0; i < fatSectors; i += 1) fat[next + i] = FAT_SECTOR;
  next += fatSectors;
  const directoryStart = allocate(directorySectors);
  const miniFatStart = allocate(miniFatSectors);
  const miniStreamStart = allocate(miniStreamSectors);
  for (const node of large) node.start = allocate(sectorsFor(node.data.length));
  root.start = miniStream.length ? miniStreamStart : END;
  root.size = miniStream.length;

  const out = new Uint8Array(SECTOR + total * SECTOR);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 0x0003, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, directoryStart, true);
  view.setUint32(56, CUTOFF, true);
  view.setUint32(60, miniFatSectors ? miniFatStart : END, true);
  view.setUint32(64, miniFatSectors, true);
  view.setUint32(68, difatSectors ? difatStart : END, true);
  view.setUint32(72, difatSectors, true);
  const fatList = Array.from({ length: fatSectors }, (_, i) => fatStart + i);
  for (let i = 0; i < 109; i += 1) view.setUint32(76 + i * 4, i < fatList.length ? fatList[i] : FREE, true);
  const at = (sector) => SECTOR + sector * SECTOR;
  // DIFAT sectors list the FAT sectors past the first 109, each ending with the next DIFAT sector.
  for (let d = 0; d < difatSectors; d += 1) {
    const base = at(difatStart + d);
    for (let i = 0; i < 127; i += 1) {
      const k = 109 + d * 127 + i;
      view.setUint32(base + i * 4, k < fatList.length ? fatList[k] : FREE, true);
    }
    view.setUint32(base + 508, d === difatSectors - 1 ? END : difatStart + d + 1, true);
  }
  fat.forEach((v, i) => view.setUint32(at(fatStart) + i * 4, v, true));
  nodes.forEach((node, i) => {
    const base = at(directoryStart) + i * 128;
    const name = node.name.slice(0, 31);
    for (let k = 0; k < name.length; k += 1) view.setUint16(base + k * 2, name.charCodeAt(k), true);
    view.setUint16(base + 64, (name.length + 1) * 2, true);
    out[base + 66] = node.type;
    out[base + 67] = 1;
    view.setUint32(base + 68, node.left ?? NONE, true);
    view.setUint32(base + 72, node.right ?? NONE, true);
    view.setUint32(base + 76, node.child ?? NONE, true);
    if (node.clsid) out.set(node.clsid.subarray(0, 16), base + 80);
    view.setUint32(base + 116, node.type === 1 ? 0 : (node.start ?? END), true);
    view.setUint32(base + 120, node.type === 2 ? node.data.length : node.type === 5 ? node.size : 0, true);
  });
  // The directory's unused slots are empty entries with no siblings.
  for (let i = nodes.length; i < directorySectors * 4; i += 1) {
    const base = at(directoryStart) + i * 128;
    view.setUint32(base + 68, NONE, true);
    view.setUint32(base + 72, NONE, true);
    view.setUint32(base + 76, NONE, true);
  }
  miniFat.forEach((v, i) => view.setUint32(at(miniFatStart) + i * 4, v, true));
  for (let i = miniFat.length; i < miniFatSectors * 128; i += 1) view.setUint32(at(miniFatStart) + i * 4, FREE, true);
  if (miniStream.length) out.set(miniStream, at(miniStreamStart));
  for (const node of large) out.set(node.data, at(node.start));
  return out;
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** readCfb with a damaged file's out-of-range reads reported as damage, never as a crash. */
export function readCfb(bytes) {
  try {
    return readCfbUnsafe(bytes);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw new Error('This file is damaged and cannot be read');
    throw error;
  }
}
