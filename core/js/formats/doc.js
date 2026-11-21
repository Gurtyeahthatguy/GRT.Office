/** Word 97 to 2003 documents (.doc): read into the editor's document, and written back from it. */

import { readCfb, writeCfb, isCfb } from './cfb.js';
import { normaliseRuns, OBJECT } from '../editor/model.js';
import { Losses } from '../losses.js';
import { greatest } from '../extent.js';

const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
/** Word's sixteen colours by their number. */
const ICO = [null, '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#ffff00', '#ffffff', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0'];
const MAX_TEXT = 50_000_000;
const PX_PER_TWIP = 96 / 1440;

// Reading

/** The operand size of a property change, from its code: one, two, four bytes, or counted. */
function sprmSize(sprm, bytes, at) {
  const spra = sprm >> 13;
  switch (spra) {
    case 0: case 1: return 1;
    case 2: case 4: case 5: return 2;
    case 3: return 4;
    case 7: return 3;
    default:
      // Variable: its length in the byte after the code, but one table property counts in two.
      if (sprm === 0xd608 || sprm === 0xd606) return 2 + ((bytes[at] | (bytes[at + 1] << 8)) - 1);
      return 1 + bytes[at];
  }
}

/** The property changes of a group, as code and operand offset. */
function* sprms(bytes, start, end) {
  let at = start;
  while (at + 2 <= end) {
    const sprm = bytes[at] | (bytes[at + 1] << 8);
    at += 2;
    const size = sprmSize(sprm, bytes, at);
    if (at + size > end) return;
    yield { sprm, at, size };
    at += size;
  }
}

const toggle = (value, base) => (value === 0x80 ? base : value === 0x81 ? !base : value === 1);

/**
 * @param {Uint8Array} bytes the .doc file
 * @returns {{document: Object, images: Map<string, Uint8Array>, losses: Losses}}
 */
function readDocUnsafe(bytes) {
  if (!isCfb(bytes)) return readPlainWord(bytes);
  const losses = new Losses();
  const streams = readCfb(bytes);
  const word = streams.get('WordDocument');
  if (!word || word.length < 512) throw new Error('This file has no Word document in it');
  const wv = new DataView(word.buffer, word.byteOffset, word.byteLength);
  const nFib = wv.getUint16(2, true);
  if (wv.getUint16(0, true) === 0xa5dc || (nFib >= 101 && nFib <= 105)) return readWord6(word);
  if (wv.getUint16(0, true) !== 0xa5ec) throw new Error('Not a Word document');
  if (nFib < 0xc1) throw new Error('A Word document of a version GRT does not know');
  const flags = wv.getUint16(10, true);
  if (flags & 0x0100) throw new Error('This document is encrypted');
  const table = streams.get(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('This document has no table stream');
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const data = streams.get('Data') ?? new Uint8Array(0);

  const csw = wv.getUint16(32, true);
  const lwAt = 34 + csw * 2;
  const cslw = wv.getUint16(lwAt, true);
  const lw = (i) => wv.getInt32(lwAt + 2 + i * 4, true);
  const fcAt = lwAt + 2 + cslw * 4;
  const cbRgFcLcb = wv.getUint16(fcAt, true);
  const pair = (i) => (i < cbRgFcLcb ? { fc: wv.getUint32(fcAt + 2 + i * 8, true), lcb: wv.getUint32(fcAt + 6 + i * 8, true) } : { fc: 0, lcb: 0 });
  const ccpText = lw(3);
  const ccpFtn = lw(4);
  const ccpHdd = lw(5);
  const ccpAtn = lw(7);
  const ccpEdn = lw(8);
  const inTable = (p) => p.fc + p.lcb <= table.length;

  // The text, through the piece table.
  const clx = pair(33);
  if (!inTable(clx) || clx.lcb === 0) throw new Error('This document has no piece table');
  let at = clx.fc;
  const clxEnd = clx.fc + clx.lcb;
  while (at < clxEnd && table[at] === 0x01) at += 3 + tv.getInt16(at + 1, true);
  if (table[at] !== 0x02) throw new Error('A damaged piece table');
  const lcb = tv.getUint32(at + 1, true);
  const plc = at + 5;
  const pieces = Math.floor((lcb - 4) / 12);
  const parts = [];
  const cpToFc = [];
  let total = 0;
  for (let i = 0; i < pieces; i += 1) {
    const cpStart = tv.getUint32(plc + i * 4, true);
    const cpEnd = tv.getUint32(plc + (i + 1) * 4, true);
    const pcd = plc + (pieces + 1) * 4 + i * 8;
    const fcRaw = tv.getUint32(pcd + 2, true);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = compressed ? (fcRaw & 0x3fffffff) / 2 : fcRaw;
    // A piece is read only as far as the stream goes: one that claims more is damaged, and padding it would fill memory.
    const inStream = Math.max(0, Math.floor((word.length - fc) / (compressed ? 1 : 2)));
    const count = Math.max(0, Math.min(cpEnd - cpStart, MAX_TEXT - total, inStream));
    let text = '';
    for (let k = 0; k < count; k += 1) {
      if (compressed) { const b = word[fc + k] ?? 0x20; text += String.fromCharCode(CP1252[b] ?? b); } else text += String.fromCharCode(fc + k * 2 + 1 < word.length ? wv.getUint16(fc + k * 2, true) : 0x20);
    }
    parts.push(text);
    cpToFc.push({ cpStart, cpEnd: cpStart + count, fc, compressed });
    total += count;
  }
  const all = parts.join('');
  const fcOf = (cp) => {
    const piece = cpToFc.find((p) => cp >= p.cpStart && cp < p.cpEnd);
    return piece ? piece.fc + (cp - piece.cpStart) * (piece.compressed ? 1 : 2) : -1;
  };

  // Styles: names, and how each heading is a heading.
  const stsh = pair(1);
  const styles = [];
  if (inTable(stsh) && stsh.lcb > 2) {
    const cbStshi = tv.getUint16(stsh.fc, true);
    const cstd = tv.getUint16(stsh.fc + 2, true);
    const cbBase = tv.getUint16(stsh.fc + 4, true);
    let p = stsh.fc + 2 + cbStshi;
    for (let i = 0; i < cstd && p + 2 <= stsh.fc + stsh.lcb; i += 1) {
      const cbStd = tv.getUint16(p, true);
      p += 2;
      if (cbStd === 0) { styles.push(null); continue; }
      const sti = tv.getUint16(p, true) & 0x0fff;
      const nameAt = p + cbBase;
      const cch = nameAt + 2 <= table.length ? tv.getUint16(nameAt, true) : 0;
      let name = '';
      for (let k = 0; k < Math.min(cch, 255) && nameAt + 4 + k * 2 <= table.length; k += 1) name += String.fromCharCode(tv.getUint16(nameAt + 2 + k * 2, true));
      styles.push({ sti, name });
      p += cbStd;
    }
  }

  /** The FKPs a bin table names, each page's runs from file positions to its properties. */
  const fkpRuns = (index, kind) => {
    const bte = pair(index);
    const out = [];
    if (!inTable(bte) || bte.lcb < 8) return out;
    const n = Math.floor((bte.lcb - 4) / 8);
    for (let i = 0; i < n; i += 1) {
      const pn = tv.getUint32(bte.fc + (n + 1) * 4 + i * 4, true) & 0x3fffff;
      const page = pn * 512;
      if (page + 512 > word.length) continue;
      const crun = word[page + 511];
      for (let k = 0; k < crun; k += 1) {
        const fcStart = wv.getUint32(page + k * 4, true);
        const fcEnd = wv.getUint32(page + (k + 1) * 4, true);
        if (kind === 'chp') {
          const offset = word[page + (crun + 1) * 4 + k] * 2;
          if (!offset) { out.push({ fcStart, fcEnd, start: 0, end: 0 }); continue; }
          const cb = word[page + offset];
          out.push({ fcStart, fcEnd, start: page + offset + 1, end: page + offset + 1 + cb });
        } else {
          const offset = word[page + (crun + 1) * 4 + k * 13] * 2;
          if (!offset) { out.push({ fcStart, fcEnd, start: 0, end: 0, istd: 0 }); continue; }
          let cb = word[page + offset];
          let start = page + offset + 1;
          if (cb === 0) { cb = word[page + offset + 1]; start += 1; cb *= 2; } else cb = cb * 2 - 1;
          const istd = wv.getUint16(start, true);
          out.push({ fcStart, fcEnd, start: start + 2, end: start + cb, istd });
        }
      }
    }
    return out.sort((a, b) => a.fcStart - b.fcStart);
  };
  const chpRuns = fkpRuns(12, 'chp');
  const papRuns = fkpRuns(13, 'pap');
  const find = (runs, fc) => {
    let low = 0;
    let high = runs.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (runs[mid].fcEnd <= fc) low = mid + 1; else if (runs[mid].fcStart > fc) high = mid - 1; else return runs[mid];
    }
    return null;
  };

  const charLook = (cp) => {
    const run = find(chpRuns, fcOf(cp));
    const look = {};
    if (!run || !run.end) return look;
    for (const { sprm, at: o } of sprms(word, run.start, run.end)) {
      const v = word[o];
      switch (sprm) {
        case 0x0835: look.bold = toggle(v, false); break;
        case 0x0836: look.italic = toggle(v, false); break;
        case 0x0837: look.strike = toggle(v, false); break;
        case 0x083a: look.smallcaps = toggle(v, false); break;
        case 0x2a3e: if (v === 3) look.double = true; else if (v) look.underline = true; break;
        case 0x2a48: if (v === 1) look.sup = true; else if (v === 2) look.sub = true; break;
        case 0x4a43: look.size = (word[o] | (word[o + 1] << 8)) / 2; break;
        case 0x2a42: if (ICO[v] && v !== 1) look.color = ICO[v]; break;
        case 0x6870: { const auto = word[o + 3] === 0xff; if (!auto) { const hex = [word[o], word[o + 1], word[o + 2]].map((b) => b.toString(16).padStart(2, '0')).join(''); if (hex !== '000000') look.color = `#${hex}`; } break; }
        case 0x2a0c: if (ICO[v] && v) look.highlight = ICO[v]; break;
        case 0x0855: look.special = toggle(v, false); break;
        case 0x6a03: look.picture = word[o] | (word[o + 1] << 8) | (word[o + 2] << 16) | (word[o + 3] << 24); break;
        case 0x0806: look.data = toggle(v, false); break;
        case 0x0800: if (v) look.deleted = true; break;
        default: break;
      }
    }
    return look;
  };

  const paraOf = (cp) => {
    const run = find(papRuns, fcOf(cp));
    const out = { istd: run?.istd ?? 0, align: null, inTable: false, rowEnd: false, list: null, level: 0, outline: null };
    if (!run || !run.end) return out;
    for (const { sprm, at: o } of sprms(word, run.start, run.end)) {
      const v = word[o];
      switch (sprm) {
        case 0x2403: case 0x2461: out.align = { 1: 'center', 2: 'right', 3: 'justify' }[v] ?? 'left'; break;
        case 0x2416: out.inTable = v === 1; break;
        case 0x2417: out.rowEnd = v === 1; break;
        case 0x6649: out.depth = wv.getInt32(o, true); break;
        case 0x244b: out.inTable = true; out.rowEnd = v === 1; break;
        case 0x460b: out.list = v | (word[o + 1] << 8); break;
        case 0x260a: out.level = v; break;
        case 0x2640: out.outline = v; break;
        default: break;
      }
    }
    return out;
  };

  // Footnotes and endnotes, by where their marks are in the main text.
  const notesOf = (refIndex, textIndex, base, kind) => {
    const ref = pair(refIndex);
    const txt = pair(textIndex);
    const out = new Map();
    if (!inTable(ref) || !inTable(txt) || ref.lcb < 4) return out;
    const n = Math.floor((ref.lcb - 4) / 6);
    for (let i = 0; i < n; i += 1) {
      const cp = tv.getUint32(ref.fc + i * 4, true);
      const from = tv.getUint32(txt.fc + i * 4, true);
      const to = tv.getUint32(txt.fc + (i + 1) * 4, true);
      out.set(cp, { kind, text: all.slice(base + from, base + to).replace(/^\u0002/, '').replace(/[\r\u0003\u0004]+$/g, '').trim() });
    }
    return out;
  };
  const notes = new Map([...notesOf(2, 3, ccpText, 'foot'), ...notesOf(46, 47, ccpText + ccpFtn + ccpHdd + ccpAtn, 'end')]);
  if (ccpAtn > 0) losses.add('Comments in Word 97 documents');
  if (ccpHdd > 0) losses.add('Headers and footers of Word 97 documents');
  void ccpEdn;

  // Pictures: the bytes of a PNG, JPEG or GIF in the picture's data, at the size it is shown.
  const images = new Map();
  const pictureAt = (offset) => {
    if (offset < 0 || offset + 68 > data.length) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const lcbPic = dv.getUint32(offset, true);
    const end = Math.min(data.length, offset + lcbPic);
    const dxa = dv.getInt16(offset + 28, true);
    const dya = dv.getInt16(offset + 30, true);
    const mx = dv.getUint16(offset + 32, true) || 1000;
    const my = dv.getUint16(offset + 34, true) || 1000;
    for (let p = offset + 68; p < end - 8; p += 1) {
      const png = data[p] === 0x89 && data[p + 1] === 0x50 && data[p + 2] === 0x4e && data[p + 3] === 0x47;
      const jpg = data[p] === 0xff && data[p + 1] === 0xd8 && data[p + 2] === 0xff;
      if (!png && !jpg) continue;
      const bytesOf = data.slice(p, end);
      const name = `resources/picture${images.size + 1}.${png ? 'png' : 'jpg'}`;
      images.set(name, bytesOf);
      return { resource: name, w: Math.max(1, Math.round((dxa * mx) / 1000 * PX_PER_TWIP)), h: Math.max(1, Math.round((dya * my) / 1000 * PX_PER_TWIP)) };
    }
    return null;
  };

  // Lists: each override names a list, whose first level says whether it counts or shows a bullet.
  const listKinds = new Map();
  const lists = new Map();
  const plfLst = pair(73);
  const plfLfo = pair(74);
  if (inTable(plfLst) && plfLst.lcb > 2) {
    const count = tv.getUint16(plfLst.fc, true);
    let p = plfLst.fc + 2;
    const heads = [];
    for (let i = 0; i < count && p + 28 <= table.length; i += 1) {
      heads.push({ lsid: tv.getInt32(p, true), simple: (table[p + 26] & 1) === 1 });
      p += 28;
    }
    for (const head of heads) {
      const levels = head.simple ? 1 : 9;
      for (let l = 0; l < levels && p + 28 <= table.length; l += 1) {
        const nfc = table[p + 4];
        const chpx = table[p + 24];
        const papx = table[p + 25];
        if (l === 0) lists.set(head.lsid, nfc === 23 || nfc === 0xff ? 'bullet' : 'number');
        p += 28 + papx + chpx;
        const cch = p + 2 <= table.length ? tv.getUint16(p, true) : 0;
        p += 2 + cch * 2;
      }
    }
  }
  if (inTable(plfLfo) && plfLfo.lcb > 4) {
    const count = tv.getUint32(plfLfo.fc, true);
    for (let i = 0; i < count && plfLfo.fc + 4 + (i + 1) * 16 <= table.length; i += 1) {
      listKinds.set(i + 1, lists.get(tv.getInt32(plfLfo.fc + 4 + i * 16, true)) ?? 'bullet');
    }
  }

  // The main text in paragraphs, fields shown by their results, tables by their cells.
  const blocks = [];
  let runs = [];
  let fieldDepth = 0;
  const fieldStack = [];
  let row = [];
  let rows = [];
  let cellRuns = [];
  let pendingList = null;
  const flushTable = () => {
    if (!rows.length) return;
    const width = greatest(rows.map((r) => r.length));
    blocks.push({ kind: 'table', rows: rows.map((r) => ({ cells: Array.from({ length: width }, (_, i) => ({ runs: normaliseRuns(r[i] ?? [{ text: '' }]) })) })) });
    rows = [];
  };
  const pushRun = (target, text, look, extra = {}) => {
    if (!text && !extra.object) return;
    const run = { text: extra.object ? OBJECT : text };
    for (const key of ['bold', 'italic', 'strike', 'underline', 'double', 'sup', 'sub', 'smallcaps', 'color', 'highlight']) if (look[key]) run[key] = look[key];
    if (look.size && Math.abs(look.size - 12) > 0.1) run.size = look.size;
    if (extra.object) run.object = extra.object;
    if (extra.link) run.link = extra.link;
    target.push(run);
  };
  const styleOf = (istd) => styles[istd];
  let cp = 0;
  let pending = '';
  let pendingLook = null;
  const flushText = (target) => {
    if (pending) pushRun(target, pending, pendingLook ?? {});
    pending = '';
    pendingLook = null;
  };
  const target = () => (paraOf(cp).inTable ? cellRuns : runs);
  for (cp = 0; cp < Math.min(ccpText, all.length); cp += 1) {
    const ch = all[cp];
    const look = charLook(cp);
    if (look.deleted) continue;
    const code = ch.charCodeAt(0);
    if (code === 0x13) { flushText(target()); fieldDepth += 1; fieldStack.push({ code: '', result: false }); continue; }
    if (code === 0x14) { if (fieldStack.length) fieldStack[fieldStack.length - 1].result = true; continue; }
    if (code === 0x15) {
      flushText(target());
      const field = fieldStack.pop();
      fieldDepth = Math.max(0, fieldDepth - 1);
      const link = /HYPERLINK\s+"([^"]+)"/i.exec(field?.code ?? '');
      if (link && field.resultRuns) for (const r of field.resultRuns) { if (/^(https?:|mailto:)/i.test(link[1])) r.link = link[1]; target().push(r); }
      else if (field?.resultRuns) target().push(...field.resultRuns);
      continue;
    }
    if (fieldStack.length) {
      const field = fieldStack[fieldStack.length - 1];
      if (!field.result) { field.code += ch; continue; }
      field.resultRuns ??= [];
      if (code >= 0x20 || code === 0x09) pushRun(field.resultRuns, ch, look);
      continue;
    }
    if (code === 0x0d || code === 0x07) {
      flushText(target());
      const para = paraOf(cp);
      if (para.inTable) {
        if (code === 0x07 && para.rowEnd) { rows.push(row); row = []; cellRuns = []; continue; }
        if (code === 0x07) { row.push(cellRuns.length ? cellRuns : [{ text: '' }]); cellRuns = []; continue; }
        cellRuns.push({ text: '\n' });
        continue;
      }
      flushTable();
      const style = styleOf(para.istd);
      const sti = style?.sti ?? 0;
      const level = sti >= 1 && sti <= 9 ? sti : para.outline !== null && para.outline < 9 ? para.outline + 1 : 0;
      if (para.list && !level) {
        const listType = listKinds.get(para.list) ?? 'bullet';
        if (!pendingList || pendingList.listType !== listType) { pendingList = { kind: 'list', listType, items: [] }; blocks.push(pendingList); }
        pendingList.items.push({ level: Math.min(5, para.level), runs: normaliseRuns(runs) });
      } else {
        pendingList = null;
        const align = para.align && para.align !== 'left' ? para.align : 'left';
        if (level) blocks.push({ kind: 'heading', level: Math.min(4, level), style: `h${Math.min(4, level)}`, align, runs: normaliseRuns(runs) });
        else blocks.push({ kind: 'paragraph', style: /quot/i.test(style?.name ?? '') ? 'quote' : 'body', align, runs: normaliseRuns(runs) });
      }
      runs = [];
      continue;
    }
    if (code === 0x0c) { flushText(target()); blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: normaliseRuns(runs) }); runs = []; blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: '' }], breakBefore: true }); continue; }
    if (code === 0x02 && notes.has(cp)) {
      flushText(target());
      const note = notes.get(cp);
      pushRun(target(), '', look, { object: { type: 'note', kind: note.kind, runs: [{ text: note.text }] } });
      continue;
    }
    if (code === 0x01 && look.special && look.picture !== undefined) {
      flushText(target());
      const picture = pictureAt(look.picture);
      if (picture) {
        if (runs.length) { blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: normaliseRuns(runs) }); runs = []; }
        blocks.push({ kind: 'image', resource: picture.resource, w: picture.w, h: picture.h, align: 'center', caption: [] });
      } else losses.add('Pictures in a format GRT does not show, such as WMF or EMF');
      continue;
    }
    if (code === 0x08 || (code === 0x01 && look.special)) { losses.add('Drawings and objects in Word 97 documents'); continue; }
    if (code < 0x20 && code !== 0x09 && code !== 0x0b) continue;
    const shown = code === 0x0b ? '\n' : code === 0x1e ? '‑' : code === 0x1f ? '­' : ch;
    const key = JSON.stringify(look);
    if (pendingLook && JSON.stringify(pendingLook) !== key) flushText(target());
    pending += shown;
    pendingLook = look;
  }
  flushText(target());
  if (runs.length) blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: normaliseRuns(runs) });
  flushTable();
  if (!blocks.length) blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: '' }] });
  return { document: { version: 1, type: 'paper', blocks }, images, losses };
}

// Writing

class Bytes {
  constructor() { this.list = []; }
  u8(v) { this.list.push(v & 0xff); return this; }
  u16(v) { this.list.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v) { this.list.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  add(bytes) { for (const b of bytes) this.list.push(b); return this; }
  pad(to) { while (this.list.length < to) this.list.push(0); return this; }
  get length() { return this.list.length; }
  get bytes() { return Uint8Array.from(this.list); }
}

const hexColour = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex ?? ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };

/** A run's look as character property changes. */
function chpx(run) {
  const b = new Bytes();
  if (run.bold) b.u16(0x0835).u8(1);
  if (run.italic) b.u16(0x0836).u8(1);
  if (run.strike) b.u16(0x0837).u8(1);
  if (run.smallcaps) b.u16(0x083a).u8(1);
  if (run.underline) b.u16(0x2a3e).u8(1);
  if (run.double) b.u16(0x2a3e).u8(3);
  if (run.sup) b.u16(0x2a48).u8(1);
  if (run.sub) b.u16(0x2a48).u8(2);
  if (run.size) b.u16(0x4a43).u16(Math.round(run.size * 2));
  const color = hexColour(run.color);
  if (color) b.u16(0x6870).u8(color[0]).u8(color[1]).u8(color[2]).u8(0);
  if (run.highlight) b.u16(0x2a0c).u8(7);
  return b.list;
}

/**
 * The editor's document as a .doc file: paragraphs, headings, lists as indented paragraphs, tables, footnotes and character looks.
 * @param {Object} document the editor's document as stored
 * @returns {{bytes: Uint8Array, losses: Losses}}
 */
export function writeDoc(document, { template = false } = {}) {
  const losses = new Losses();
  // The text, paragraph by paragraph, each with its properties; character runs with theirs.
  const paras = [];
  const footnotes = [];
  const listParagraphs = [];
  const runsOf = (list) => {
    const out = [];
    for (const run of list ?? []) {
      if (run.del) continue;
      if (run.object) {
        if (run.object.type === 'note' && run.object.kind !== 'end') { out.push({ text: '\u0002', note: run.object, look: { sup: true } }); continue; }
        if (run.object.type === 'note') { losses.add('Endnotes, written as footnotes'); out.push({ text: '\u0002', note: run.object, look: { sup: true } }); continue; }
        if (run.object.type === 'comment') { losses.add('Comments, which this writer of Word 97 documents leaves out'); continue; }
        if (run.object.type === 'math') { losses.add('Formulas, written as their TeX'); out.push({ text: run.object.tex ?? '', look: {} }); continue; }
        continue;
      }
      if (run.link) losses.add('Links, written as their text');
      const text = run.text.replace(/\n/g, '\u000b').replace(/[\u0000-\u0008\u000c-\u001f]/g, '');
      if (text) out.push({ text, look: run });
    }
    return out;
  };
  for (const block of document.blocks ?? []) {
    switch (block.kind) {
      case 'heading': paras.push({ runs: runsOf(block.runs), istd: Math.min(9, block.level ?? 1), align: block.align, breakBefore: block.breakBefore }); break;
      case 'list':
        for (const [i, item] of block.items.entries()) {
          const mark = block.listType === 'number' ? `${i + 1}.\t` : '•\t';
          paras.push({ runs: [{ text: mark, look: {} }, ...runsOf(item.runs)], istd: 0, indent: 360 * ((item.level ?? 0) + 1), hanging: 360 });
        }
        listParagraphs.push(block);
        break;
      case 'table': {
        const width = block.rows[0]?.cells.length ?? 1;
        for (const row of block.rows) {
          row.cells.forEach((cell, c) => {
            const text = runsOf(cell.covered ? [] : cell.runs);
            paras.push({ runs: text, istd: 0, cellEnd: true, inTable: true, last: c === width - 1 });
          });
          paras.push({ runs: [], istd: 0, rowEnd: true, inTable: true, cells: width });
        }
        if (block.rows.some((r) => r.cells.some((c) => c.colspan > 1 || c.rowspan > 1))) losses.add('Merged table cells, written apart');
        break;
      }
      case 'image': losses.add('Pictures, which this writer of Word 97 documents leaves out'); break;
      case 'chart': losses.add('Charts, which this writer of Word 97 documents leaves out'); break;
      case 'code': case 'quote': case 'paragraph':
        paras.push({ runs: runsOf(block.runs), istd: 0, align: block.align, breakBefore: block.breakBefore });
        break;
      default:
        if (block.runs) paras.push({ runs: runsOf(block.runs), istd: 0 });
        else if (!['section', 'toc', 'index'].includes(block.kind)) losses.add('Blocks of another program, left out');
    }
  }
  if (listParagraphs.length) losses.add('Lists, written as paragraphs with their bullets and numbers');
  if ((document.drawings ?? []).length) losses.add('Drawings, which this writer of Word 97 documents leaves out');
  if (!paras.length) paras.push({ runs: [], istd: 0 });

  // Main text, then the footnotes' text after it.
  let text = '';
  const chars = [];
  const paraEnds = [];
  for (const p of paras) {
    for (const r of p.runs) {
      if (r.note) footnotes.push({ cp: text.length, note: r.note });
      chars.push({ start: text.length, end: text.length + r.text.length, look: r.look });
      text += r.text;
    }
    const end = p.cellEnd || p.rowEnd ? '\u0007' : '\r';
    chars.push({ start: text.length, end: text.length + 1, look: {} });
    text += end;
    paraEnds.push({ end: text.length, p });
  }
  const ccpText = text.length;
  let notesText = '';
  const noteStarts = [];
  for (const f of footnotes) {
    noteStarts.push(notesText.length);
    const body = (f.note.runs ?? []).map((r) => r.text).join('').replace(/[\u0000-\u001f]/g, ' ');
    chars.push({ start: ccpText + notesText.length, end: ccpText + notesText.length + 1, look: { sup: true } });
    notesText += `\u0002${body}\r`;
    paraEnds.push({ end: ccpText + notesText.length, p: { istd: 0, runs: [] } });
  }
  const ccpFtn = footnotes.length ? notesText.length + 1 : 0;
  if (footnotes.length) { notesText += '\r'; paraEnds.push({ end: ccpText + notesText.length, p: { istd: 0, runs: [] } }); }
  const full = `${text}${notesText}\r`;
  paraEnds.push({ end: full.length, p: { istd: 0, runs: [] } });

  // The WordDocument stream: the FIB, the text from 0x600 on, then the property pages.
  const FC_TEXT = 0x600;
  const word = new Bytes().pad(FC_TEXT);
  for (const ch of full) word.u16(ch.charCodeAt(0));
  const fcOf = (cp) => FC_TEXT + cp * 2;
  const pageAlign = () => word.pad(Math.ceil(word.length / 512) * 512);

  // Character pages: one run a look, packed into 512-byte pages.
  const chpRuns = [];
  for (const c of chars) {
    const grpprl = chpx(c.look ?? {});
    const last = chpRuns[chpRuns.length - 1];
    if (last && JSON.stringify(last.grpprl) === JSON.stringify(grpprl) && last.end === fcOf(c.start)) last.end = fcOf(c.end);
    else chpRuns.push({ start: fcOf(c.start), end: fcOf(c.end), grpprl });
  }
  const lastChar = chpRuns[chpRuns.length - 1];
  if (lastChar.end < fcOf(full.length)) chpRuns.push({ start: lastChar.end, end: fcOf(full.length), grpprl: [] });
  const writePages = (runList, kind) => {
    const bins = [];
    let i = 0;
    while (i < runList.length) {
      pageAlign();
      const pageStart = word.length;
      const page = new Uint8Array(512);
      const pv = new DataView(page.buffer);
      // How many runs fit: their positions, their offsets, and their properties from the end of the page backward.
      let count = 0;
      let free = 511;
      const offsets = [];
      while (i + count < runList.length) {
        const r = runList[i + count];
        const size = kind === 'chp' ? r.grpprl.length + 1 : r.grpprl.length + 2 + (r.grpprl.length % 2 === 0 ? 1 : 1);
        const headerNeed = (count + 2) * 4 + (count + 1) * (kind === 'chp' ? 1 : 13);
        const at = (free - size) & ~1;
        if (at < headerNeed || count >= (kind === 'chp' ? 101 : 29)) break;
        offsets.push(at);
        free = at;
        count += 1;
      }
      if (count === 0) throw new Error('A run too large for a page');
      const header = (count + 1) * 4;
      for (let k = 0; k < count; k += 1) {
        const r = runList[i + k];
        pv.setUint32(k * 4, r.start, true);
        if (k === count - 1) pv.setUint32((k + 1) * 4, r.end, true);
        const at = offsets[k];
        if (kind === 'chp') {
          page[header + k] = r.grpprl.length ? at / 2 : 0;
          page[at] = r.grpprl.length;
          page.set(r.grpprl, at + 1);
        } else {
          page[header + k * 13] = at / 2;
          // A PAPX: cb in words, the style index, and the property changes.
          const body = [r.istd & 0xff, r.istd >> 8, ...r.grpprl];
          if (body.length % 2 === 1) { page[at] = (body.length + 1) / 2; page.set(body, at + 1); } else { page[at] = 0; page[at + 1] = body.length / 2; page.set(body, at + 2); }
        }
      }
      page[511] = count;
      word.add(page);
      bins.push({ fc: runList[i].start, pn: pageStart / 512 });
      i += count;
    }
    return bins;
  };
  const chpBins = writePages(chpRuns, 'chp');

  // Paragraph pages: each paragraph's style, alignment, table flags, indents and break.
  const papRuns = [];
  let previous = 0;
  for (const { end, p } of paraEnds) {
    const b = new Bytes();
    if (p.align && p.align !== 'left') b.u16(0x2461).u8({ center: 1, right: 2, justify: 3 }[p.align] ?? 0);
    if (p.breakBefore) b.u16(0x2407).u8(1);
    if (p.indent) b.u16(0x845e).u16(p.indent).u16(0x8460).u16((-p.hanging) & 0xffff);
    if (p.istd >= 1 && p.istd <= 9) b.u16(0x2640).u8(p.istd - 1);
    if (p.inTable) b.u16(0x2416).u8(1).u16(0x6649).u32(1);
    if (p.rowEnd) {
      b.u16(0x2417).u8(1).u16(0x244b).u8(1);
      // The row's cells, each an equal part of the text column.
      const width = Math.floor(9000 / p.cells);
      const def = new Bytes().u8(p.cells);
      for (let k = 0; k <= p.cells; k += 1) def.u16(k * width);
      for (let k = 0; k < p.cells; k += 1) def.pad(def.length + 20);
      b.u16(0xd608).u16(def.length + 1).add(def.list);
    }
    papRuns.push({ start: fcOf(previous), end: fcOf(end), istd: p.istd ?? 0, grpprl: b.list });
    previous = end;
  }
  const papBins = writePages(papRuns, 'pap');
  pageAlign();

  // The table stream: styles, bin tables, fonts, the piece table, the section and the document's properties.
  const tableStream = new Bytes();
  const place = (bytes) => { const fc = tableStream.length; tableStream.add(bytes); return { fc, lcb: bytes.length }; };
  // A stylesheet of Normal and Heading 1 to 9, the names Word and LibreOffice know.
  const stsh = new Bytes();
  // STSHI: the count of styles, the size of each style's base, names written, the built-in styles known, the fixed ones.
  const stshi = new Bytes().u16(10).u16(10).u16(1).u16(0x5b).u16(0x0f).u16(0).u16(0).u16(0).u16(0);
  stshi.pad(18);
  stsh.u16(stshi.length).add(stshi.list);
  const std = (sti, name, base) => {
    const b = new Bytes();
    // The style's base: its built-in number, a paragraph style on its base style, two property groups, Normal after it.
    b.u16(sti).u16(1 | (base << 4)).u16(2).u16(0).u16(0);
    b.u16(name.length);
    for (const ch of name) b.u16(ch.charCodeAt(0));
    b.u16(0);
    if (b.length % 2) b.u8(0);
    // Paragraph properties: the style index and, for headings, the outline level; no character properties.
    const papx = new Bytes().u16(sti);
    if (sti >= 1 && sti <= 9) papx.u16(0x2640).u8(sti - 1).u16(0x2407).u8(0);
    b.u16(papx.length).add(papx.list);
    if (b.length % 2) b.u8(0);
    const chp = new Bytes();
    if (sti >= 1 && sti <= 9) chp.u16(0x0835).u8(1).u16(0x4a43).u16([0, 32, 28, 26, 24, 22, 22, 22, 22, 22][sti]);
    b.u16(chp.length).add(chp.list);
    if (b.length % 2) b.u8(0);
    return b.list;
  };
  const names = ['Normal', ...Array.from({ length: 9 }, (_, i) => `heading ${i + 1}`)];
  const stdBytes = names.map((name, sti) => std(sti, name, sti === 0 ? 0xfff : 0));
  stsh.list[2] = names.length & 0xff;
  stsh.list[3] = names.length >> 8;
  for (const s of stdBytes) stsh.u16(s.length).add(s);
  const stshPlace = place(stsh.list);
  const plcfBte = (bins, endFc) => {
    const b = new Bytes();
    for (const bin of bins) b.u32(bin.fc);
    b.u32(endFc);
    for (const bin of bins) b.u32(bin.pn);
    return b.list;
  };
  const chpPlace = place(plcfBte(chpBins, fcOf(full.length)));
  const papPlace = place(plcfBte(papBins, fcOf(full.length)));
  // Fonts: Times New Roman, Symbol and Arial.
  const ffn = new Bytes().u16(3).u16(0);
  for (const [name, family] of [['Times New Roman', 0x16], ['Symbol', 0x17], ['Arial', 0x26]]) {
    const body = new Bytes().u8(family).u16(400).u8(0).u8(0).u8(0).pad(40);
    for (const ch of name) body.u16(ch.charCodeAt(0));
    body.u16(0);
    ffn.u8(body.length).add(body.list);
  }
  const ffnPlace = place(ffn.list);
  // Footnote references and texts.
  let fndRef = { fc: 0, lcb: 0 };
  let fndTxt = { fc: 0, lcb: 0 };
  if (footnotes.length) {
    const ref = new Bytes();
    for (const f of footnotes) ref.u32(f.cp);
    ref.u32(ccpText + 1);
    for (let i = 0; i < footnotes.length; i += 1) ref.u16(i + 1);
    fndRef = place(ref.list);
    const txt = new Bytes();
    for (const s of noteStarts) txt.u32(s);
    txt.u32(ccpFtn - 1);
    txt.u32(ccpFtn);
    fndTxt = place(txt.list);
  }
  // One section, with default properties.
  const sed = new Bytes().u32(0).u32(full.length).u16(0).u32(0xffffffff).u16(0).u32(0);
  const sedPlace = place(sed.list);
  // The piece table: one piece of UTF-16 text.
  const clx = new Bytes().u8(0x02).u32(4 * 2 + 8).u32(0).u32(full.length).u16(0).u32(FC_TEXT).u16(0);
  const clxPlace = place(clx.list);
  // The document's properties: Word's defaults, no dates, no editing time.
  // Footnotes numbered from one, a default tab of half an inch.
  const dop = new Bytes().u16(0).u16(1 << 2).u16(0x0000).u32(0).u16(720).pad(84);
  const dopPlace = place(dop.list);

  // The FIB, with its counts and the places of the tables.
  const fib = new Bytes();
  fib.u16(0xa5ec).u16(0x00c1).u16(0x6027).u16(0x0409).u16(0).u16(0x0200 | 0x0004 | 0x0008 | (template ? 0x0001 : 0)).u16(0x00bf).u32(0).u8(0).u8(0).u16(0).u16(0);
  fib.pad(32);
  fib.u16(14);
  for (let i = 0; i < 14; i += 1) fib.u16(0);
  fib.u16(22);
  const lw = new Array(22).fill(0);
  lw[0] = word.length;
  lw[3] = ccpText;
  lw[4] = ccpFtn;
  for (const v of lw) fib.u32(v);
  const fcLcb = new Array(93).fill(null).map(() => ({ fc: 0, lcb: 0 }));
  fcLcb[1] = stshPlace;
  fcLcb[0] = stshPlace;
  fcLcb[2] = fndRef;
  fcLcb[3] = fndTxt;
  fcLcb[6] = sedPlace;
  fcLcb[12] = chpPlace;
  fcLcb[13] = papPlace;
  fcLcb[15] = ffnPlace;
  fcLcb[31] = dopPlace;
  fcLcb[33] = clxPlace;
  fib.u16(93);
  for (const p of fcLcb) fib.u32(p.fc).u32(p.lcb);
  fib.u16(0);
  const wordBytes = word.bytes;
  wordBytes.set(fib.bytes.subarray(0, Math.min(fib.length, FC_TEXT)), 0);
  if (fib.length > FC_TEXT) throw new Error('The FIB does not fit');
  const bytes = writeCfb(new Map([['WordDocument', wordBytes], ['1Table', tableStream.bytes]]));
  return { bytes, losses };
}

// Word 6 and 95, and Word for Windows 2: their text, as paragraphs, tables and footnotes

/** Text of one byte a character, in Windows' Western code page. */
const ansi = (bytes) => { let out = ''; for (const b of bytes) out += String.fromCharCode(CP1252[b] ?? b); return out; };

/**
 * The blocks of a story's text as Word keeps it: paragraphs end in a carriage return, table cells in 7, a row in a cell mark of its own.
 * Fields keep the text they show; footnote marks, the notes given.
 */
function textBlocks(text, notes = []) {
  const blocks = [];
  let rows = null;
  let row = [];
  let note = 0;
  const runsOf = (raw) => {
    // A field shows its result: the code, from its start to its separator, is left out.
    let clean = '';
    let depth = 0;
    let hidden = 0;
    for (const ch of raw) {
      if (ch === '\x13') { depth += 1; hidden = depth; continue; }
      if (ch === '\x14') { if (hidden === depth) hidden = 0; continue; }
      if (ch === '\x15') { if (hidden === depth) hidden = 0; depth = Math.max(0, depth - 1); continue; }
      if (hidden) continue;
      clean += ch;
    }
    const runs = [];
    let current = '';
    for (const ch of clean) {
      if (ch === '\x02' && note < notes.length) {
        if (current) runs.push({ text: current });
        current = '';
        runs.push({ text: OBJECT, object: { type: 'note', kind: 'foot', runs: [{ text: notes[note] }] } });
        note += 1;
      } else if (ch === '\x0b') current += '\n';
      else if (ch === '\x1e') current += '\u2011';
      else if (ch === '\x1f') current += '\u00ad';
      else if (ch === '\t' || ch >= ' ') current += ch;
    }
    if (current) runs.push({ text: current });
    return normaliseRuns(runs.length ? runs : [{ text: '' }]);
  };
  const endTable = () => {
    if (rows?.length) {
      const width = greatest(rows.map((r) => r.length));
      blocks.push({ kind: 'table', rows: rows.map((r) => ({ cells: Array.from({ length: width }, (_, i) => ({ runs: r[i] ?? [{ text: '' }] })) })) });
    }
    rows = null;
  };
  for (const paragraph of text.split(/\r/).slice(0, 1_000_000)) {
    if (paragraph.includes('\x07')) {
      rows ??= [];
      const pieces = paragraph.split('\x07');
      pieces.pop();
      for (const piece of pieces) {
        // A cell mark with nothing in front of it, right after a cell, closes the row.
        if (piece === '' && row.length && row.lastWasCell) { rows.push(row.map((r) => r)); row = []; continue; }
        row.push(runsOf(piece));
        row.lastWasCell = true;
      }
      continue;
    }
    if (row.length) { rows ??= []; rows.push([...row]); row = []; }
    endTable();
    if (paragraph.includes('\x0c')) {
      const [before, ...after] = paragraph.split('\x0c');
      if (before) blocks.push({ kind: 'paragraph', runs: runsOf(before) });
      blocks.push({ kind: 'paragraph', breakBefore: true, runs: runsOf(after.join('')) });
      continue;
    }
    blocks.push({ kind: 'paragraph', runs: runsOf(paragraph) });
  }
  if (row.length) { rows ??= []; rows.push([...row]); }
  endTable();
  while (blocks.length > 1 && blocks[blocks.length - 1].kind === 'paragraph' && !runsText(blocks[blocks.length - 1].runs)) blocks.pop();
  return blocks.length ? blocks : [{ kind: 'paragraph', runs: [{ text: '' }] }];
}

const runsText = (runs) => runs.map((r) => r.text).join('');

/** Word 6 and 95: the text through the piece table, footnotes from their own story. */
function readWord6(word) {
  const losses = new Losses();
  const v = new DataView(word.buffer, word.byteOffset, word.byteLength);
  const flags = v.getUint16(10, true);
  if (flags & 0x0100) throw new Error('This document is encrypted');
  const fcMin = v.getUint32(0x18, true);
  const ccpText = v.getUint32(0x34, true);
  const ccpFtn = v.getUint32(0x38, true);
  const total = Math.min(MAX_TEXT, ccpText + ccpFtn + v.getUint32(0x3c, true) + v.getUint32(0x40, true) + v.getUint32(0x44, true) + v.getUint32(0x48, true) + 1);
  let text = '';
  if (flags & 0x0004) {
    // Fast-saved: the text in pieces, in the order the piece table gives.
    const fc = v.getUint32(0x160, true);
    const lcb = v.getUint32(0x164, true);
    if (fc + lcb > word.length || lcb === 0) throw new Error('This document has no piece table');
    let at = fc;
    while (at < fc + lcb && word[at] === 0x01) at += 3 + v.getUint16(at + 1, true);
    if (word[at] !== 0x02) throw new Error('A damaged piece table');
    const size = v.getUint32(at + 1, true);
    const plc = at + 5;
    const pieces = Math.floor((size - 4) / 12);
    for (let i = 0; i < pieces && text.length < total; i += 1) {
      const cp0 = v.getUint32(plc + i * 4, true);
      const cp1 = v.getUint32(plc + (i + 1) * 4, true);
      const pcd = plc + (pieces + 1) * 4 + i * 8;
      const start = v.getUint32(pcd + 2, true);
      if (cp1 < cp0 || start + (cp1 - cp0) > word.length) throw new Error('A damaged piece table');
      text += ansi(word.subarray(start, start + (cp1 - cp0)));
    }
  } else {
    if (fcMin + total > word.length + 1) throw new Error('This document is shorter than it says');
    text = ansi(word.subarray(fcMin, Math.min(word.length, fcMin + total)));
  }
  const main = text.slice(0, ccpText);
  // The footnotes' story follows the main text, each note ending where the next begins.
  const notesText = text.slice(ccpText, ccpText + ccpFtn);
  const fcTxt = v.getUint32(0x70, true);
  const lcbTxt = v.getUint32(0x74, true);
  const notes = [];
  if (ccpFtn && lcbTxt >= 8 && fcTxt + lcbTxt <= word.length) {
    const count = Math.floor(lcbTxt / 4) - 1;
    for (let i = 0; i < count && i < 10000; i += 1) {
      const a = v.getUint32(fcTxt + i * 4, true);
      const b = v.getUint32(fcTxt + (i + 1) * 4, true);
      notes.push(notesText.slice(a, b).replace(/^[\x02\s]+/, '').replace(/[\r\x03\x04]+$/g, '').replace(/[\r\x00-\x08]/g, ' ').trim());
    }
  }
  losses.add('Looks of Word 6 and 95 documents: their text, paragraphs, tables and footnotes are read');
  if (v.getUint32(0x3c, true)) losses.add('Headers and footers of Word 6 and 95 documents');
  if (text.includes('\x01') || text.includes('\x08')) losses.add('Pictures and drawings of Word 6 and 95 documents');
  return { document: { version: 1, type: 'paper', blocks: textBlocks(main.replace(/[\x01\x08]/g, ''), notes) }, images: new Map(), losses };
}

/** Word for Windows 2: a file of its own, its text in one run between fcMin and fcMac. */
function readPlainWord(bytes) {
  if (bytes.length < 128) throw new Error('This is not a Word document');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint16(0, true) !== 0xa5db) throw new Error('This is not a Word document GRT knows');
  const losses = new Losses();
  const fcMin = v.getUint32(0x18, true);
  const fcMac = Math.min(bytes.length, v.getUint32(0x1c, true));
  if (fcMin >= fcMac) throw new Error('This document has no text');
  const ccpText = v.getUint32(0x34, true);
  const end = ccpText > 0 && fcMin + ccpText <= fcMac ? fcMin + ccpText : fcMac;
  const text = ansi(bytes.subarray(fcMin, Math.min(end, fcMin + MAX_TEXT)));
  losses.add('Looks of Word for Windows 2 documents: their text and paragraphs are read');
  return { document: { version: 1, type: 'paper', blocks: textBlocks(text) }, images: new Map(), losses };
}

/** readDoc with a damaged file's out-of-range reads reported as damage, never as a crash. */
export function readDoc(bytes) {
  try {
    return readDocUnsafe(bytes);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw new Error('This file is damaged and cannot be read');
    throw error;
  }
}
