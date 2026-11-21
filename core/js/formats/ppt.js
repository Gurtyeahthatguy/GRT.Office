/** PowerPoint 97 to 2003 presentations (.ppt): read into Slides' document, and written back from it. */

import { readCfb, writeCfb } from './cfb.js';
import { Losses } from '../losses.js';

const MASTER_PER_PX = 6;
const LIMIT_RECORDS = 2_000_000;

/** One record's header and where its body is. */
function header(view, at) {
  const verInst = view.getUint16(at, true);
  return { ver: verInst & 0x0f, instance: verInst >> 4, type: view.getUint16(at + 2, true), length: view.getUint32(at + 4, true), body: at + 8 };
}

/** The records directly inside a stretch of bytes. */
function* children(view, start, end) {
  let at = start;
  let count = 0;
  while (at + 8 <= end && count < LIMIT_RECORDS) {
    const h = header(view, at);
    const next = h.body + h.length;
    if (next > end || next <= at) return;
    yield h;
    at = next;
    count += 1;
  }
}

const find = (view, record, type) => {
  for (const h of children(view, record.body, record.body + record.length)) if (h.type === type) return h;
  return null;
};
/** Every record of a type at any depth below one. */
function* deep(view, record, type, depth = 0) {
  if (depth > 32) return;
  for (const h of children(view, record.body, record.body + record.length)) {
    if (h.type === type) yield h;
    if (h.ver === 0x0f) yield* deep(view, h, type, depth + 1);
  }
}

const textOf = (view, bytes, h) => {
  let text = '';
  if (h.type === 0x0fa0) for (let i = 0; i + 1 < h.length; i += 2) text += String.fromCharCode(view.getUint16(h.body + i, true));
  else for (let i = 0; i < h.length; i += 1) text += String.fromCharCode(bytes[h.body + i]);
  return text.replace(/\r/g, '\n').replace(/\u000b/g, '\n');
};

/**
 * @param {Uint8Array} bytes the .ppt file
 * @returns {{document: Object, images: Map<string, Uint8Array>, losses: Losses}}
 */
function readPptUnsafe(bytes) {
  const losses = new Losses();
  const streams = readCfb(bytes);
  const doc = streams.get('PowerPoint Document');
  const user = streams.get('Current User');
  if (!doc || !user) throw new Error('This file has no presentation in it');
  const view = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  const uv = new DataView(user.buffer, user.byteOffset, user.byteLength);
  const token = uv.getUint32(12, true);
  if (token === 0xf3d1c4df) throw new Error('This presentation is encrypted');
  let edit = uv.getUint32(16, true);

  // The persist directory, from the oldest edit to the newest.
  const edits = [];
  const seen = new Set();
  while (edit && edit + 8 < doc.length && !seen.has(edit) && edits.length < 1000) {
    seen.add(edit);
    const h = header(view, edit);
    if (h.type !== 0x0ff5) break;
    edits.push({ docRef: view.getUint32(h.body + 16, true), directory: view.getUint32(h.body + 12, true) });
    edit = view.getUint32(h.body + 8, true);
  }
  if (!edits.length) throw new Error('This presentation has no edit to read');
  const persist = new Map();
  for (const e of [...edits].reverse()) {
    if (e.directory + 8 > doc.length) continue;
    const h = header(view, e.directory);
    let at = h.body;
    while (at + 4 <= h.body + h.length) {
      const info = view.getUint32(at, true);
      const first = info & 0xfffff;
      const count = info >>> 20;
      at += 4;
      for (let k = 0; k < count && at + 4 <= h.body + h.length; k += 1) { persist.set(first + k, view.getUint32(at, true)); at += 4; }
    }
  }
  const at = (id) => { const offset = persist.get(id); return offset !== undefined && offset + 8 <= doc.length ? header(view, offset) : null; };
  const document = at(edits[0].docRef);
  if (!document || document.type !== 0x03e8) throw new Error('This presentation has no document record');

  const docAtom = find(view, document, 0x03e9);
  const canvas = docAtom ? { w: Math.round(view.getInt32(docAtom.body, true) / MASTER_PER_PX), h: Math.round(view.getInt32(docAtom.body + 4, true) / MASTER_PER_PX) } : { w: 1600, h: 1200 };
  // Slides show at 1920 pixels wide in Slides; everything is scaled to that.
  const scale = canvas.w ? 1920 / canvas.w : 1;
  const px = (v) => Math.round((v / MASTER_PER_PX) * scale * 100) / 100;

  // Pictures: the store in the drawing group, each entry's picture in the Pictures stream.
  const images = new Map();
  const blips = [];
  const pictures = streams.get('Pictures') ?? new Uint8Array(0);
  const group = find(view, document, 0x040b);
  if (group) {
    for (const fbse of deep(view, group, 0xf007)) {
      const offset = view.getUint32(fbse.body + 28, true);
      blips.push(offset);
    }
  }
  const picture = (index) => {
    const offset = blips[index - 1];
    if (offset === undefined || offset + 8 > pictures.length) return null;
    const pv = new DataView(pictures.buffer, pictures.byteOffset, pictures.byteLength);
    const h = header(pv, offset);
    const kind = { 0xf01e: 'png', 0xf01d: 'jpg' }[h.type];
    if (!kind) { losses.add('Pictures in a format GRT does not show, such as WMF or EMF'); return null; }
    const twoIds = [0x6e1, 0x46b, 0x6e3].includes(h.instance);
    const start = h.body + 16 * (twoIds ? 2 : 1) + 1;
    const end = Math.min(pictures.length, h.body + h.length);
    const name = `resources/picture${images.size + 1}.${kind}`;
    if (!images.has(name)) images.set(name, pictures.slice(start, end));
    return name;
  };

  // Slides, in the order the slide list gives them, with the texts of their placeholders.
  const slides = [];
  const list = [...children(view, document.body, document.body + document.length)].find((h) => h.type === 0x0ff0 && h.instance === 0);
  const slideRefs = [];
  if (list) {
    let current = null;
    for (const h of children(view, list.body, list.body + list.length)) {
      if (h.type === 0x03f3) { current = { ref: view.getUint32(h.body, true), texts: [] }; slideRefs.push(current); } else if ((h.type === 0x0fa0 || h.type === 0x0fa8) && current) current.texts.push(textOf(view, doc, h));
    }
  }
  if (!slideRefs.length) losses.add('A presentation with no slides listed');
  let counter = 0;
  const id = (prefix) => { counter += 1; return `${prefix}${counter}`; };
  for (const ref of slideRefs) {
    const slide = at(ref.ref);
    const elements = [];
    if (slide && slide.type === 0x03ee) {
      const drawing = find(view, slide, 0x040c);
      for (const sp of drawing ? deep(view, drawing, 0xf004) : []) {
        const fsp = find(view, sp, 0xf00a);
        if (!fsp) continue;
        const flags = view.getUint32(fsp.body + 4, true);
        if (flags & 0x5 || flags & 0x400) continue;
        const anchor = find(view, sp, 0xf010);
        if (!anchor) continue;
        const [top, left, right, bottom] = anchor.length >= 16
          ? [0, 4, 8, 12].map((o) => view.getInt32(anchor.body + o, true))
          : [0, 2, 4, 6].map((o) => view.getInt16(anchor.body + o, true));
        const box = { x: px(left), y: px(top), w: Math.max(1, px(right - left)), h: Math.max(1, px(bottom - top)) };
        // Properties: fill, line, picture, turn.
        const props = new Map();
        const opt = find(view, sp, 0xf00b);
        if (opt) for (let k = 0; k < opt.instance && opt.body + k * 6 + 6 <= opt.body + opt.length; k += 1) props.set(view.getUint16(opt.body + k * 6, true) & 0x3fff, view.getUint32(opt.body + k * 6 + 2, true));
        const colour = (v) => (v === undefined || (v >>> 24) & 0x08 ? null : `#${[v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
        const rotation = props.has(0x0004) ? (props.get(0x0004) | 0) / 65536 : 0;
        const filled = props.has(0x01bf) ? (props.get(0x01bf) & 0x10) !== 0 : true;
        const lined = props.has(0x01ff) ? (props.get(0x01ff) & 0x08) !== 0 : true;
        // Text, in the shape or named from the slide list.
        let text = null;
        const box2 = find(view, sp, 0xf00d);
        if (box2) {
          for (const h of children(view, box2.body, box2.body + box2.length)) {
            if (h.type === 0x0fa0 || h.type === 0x0fa8) text = textOf(view, doc, h);
            if (h.type === 0x0f9e) text = ref.texts[view.getUint32(h.body, true)] ?? null;
          }
        }
        const type = fsp.instance;
        if (props.has(0x0104) && type === 75) {
          const resource = picture(props.get(0x0104));
          if (resource) elements.push({ id: id('e'), kind: 'image', resource, ...box, rotation, data: {} });
          continue;
        }
        if (text !== null && (type === 202 || type === 1 && !props.has(0x0181))) {
          elements.push({ id: id('e'), kind: 'text', ...box, rotation, content: [{ text }], style: 'body', data: {} });
          continue;
        }
        const shape = { 1: 'rectangle', 2: 'round-rectangle', 3: 'ellipse', 4: 'diamond', 5: 'isosceles-triangle', 6: 'right-triangle', 9: 'hexagon', 10: 'octagon', 56: 'pentagon', 13: 'right-arrow', 66: 'left-arrow', 67: 'down-arrow', 68: 'up-arrow', 12: 'star5', 96: 'smiley' }[type];
        if (type === 20 || type === 32) {
          elements.push({ id: id('e'), kind: 'path', ...box, rotation, subpaths: [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: box.w, y: box.h }] }], line: { color: colour(props.get(0x01c0)) ?? '#000000', width: Math.max(1, (props.get(0x01cb) ?? 9525) / 9525) }, data: {} });
          continue;
        }
        if (!shape) { losses.add('Shapes of PowerPoint 97 that GRT does not draw, drawn as rectangles'); }
        const element = {
          id: id('e'), kind: 'shape', shape: shape ?? 'rectangle', ...box, rotation,
          fillLook: filled ? { type: 'solid', color: colour(props.get(0x0181)) ?? '#ffffff' } : { type: 'none' },
          line: lined ? { color: colour(props.get(0x01c0)) ?? '#000000', width: Math.max(0.5, (props.get(0x01cb) ?? 9525) / 9525) } : { style: 'none' },
          data: {},
        };
        if (text) element.text = text;
        elements.push(element);
        if (text) elements.push({ id: id('e'), kind: 'text', ...box, rotation, content: [{ text }], style: 'body', align: 'center', valign: 'middle', data: {} });
      }
    }
    slides.push({ id: id('s'), master: null, footer: null, background: null, section: null, notes: '', transition: 'none', elements });
  }
  if (!slides.length) slides.push({ id: id('s'), master: null, footer: null, background: null, section: null, notes: '', transition: 'none', elements: [] });
  losses.add('Text formatting, notes and masters of PowerPoint 97 presentations');
  return { document: { version: 1, type: 'slides', canvas: { w: 1920, h: Math.round(canvas.h * scale) }, slides }, images, losses };
}

export function readPpt(bytes) {
  try {
    return readPptUnsafe(bytes);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw new Error('This file is damaged and cannot be read');
    throw error;
  }
}

// Writing

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const i16 = (v) => u16(v & 0xffff);
const i32 = (v) => u32(v | 0);
/** A record: its version, instance and type, then its body. */
const rec = (ver, instance, type, body) => [...u16((instance << 4) | ver), ...u16(type), ...u32(body.length), ...body];
const SHAPE_TYPES = { rectangle: 1, 'round-rectangle': 2, ellipse: 3, diamond: 4, 'isosceles-triangle': 5, 'right-triangle': 6, hexagon: 9, octagon: 10, pentagon: 56, 'right-arrow': 13, 'left-arrow': 66, 'down-arrow': 67, 'up-arrow': 68, star5: 12, smiley: 96 };
const colourref = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex ?? ''); return m ? (parseInt(m[1].slice(0, 2), 16) | (parseInt(m[1].slice(2, 4), 16) << 8) | (parseInt(m[1].slice(4, 6), 16) << 16)) >>> 0 : 0; };

/**
 * Slides' document as a .ppt file: shapes with their fill and line, text boxes with their words, lines and pictures.
 * @param {Object} document Slides' document as stored
 * @param {Map<string, Uint8Array>} images resource to bytes
 * @returns {{bytes: Uint8Array, losses: Losses}}
 */
export function writePpt(document, images = new Map()) {
  const losses = new Losses();
  const canvas = document.canvas ?? { w: 1920, h: 1080 };
  // PowerPoint's 10 by 5.625 inch slide, or 10 by 7.5 for 4:3, in master units of 1/576 inch.
  const slideW = 5760;
  const slideH = Math.round(5760 * (canvas.h / canvas.w));
  const unit = slideW / canvas.w;
  const slides = document.slides ?? [];

  // Pictures: each once in the Pictures stream, its store entry in the drawing group.
  const blips = [];
  const blipOf = new Map();
  const pictureStream = [];
  const blipIndex = (resource) => {
    if (blipOf.has(resource)) return blipOf.get(resource);
    const bytes = images.get(resource);
    const png = bytes && bytes[0] === 0x89 && bytes[1] === 0x50;
    const jpg = bytes && bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpg) { losses.add(bytes ? 'Pictures other than PNG and JPEG, left out' : 'Pictures whose file was missing'); blipOf.set(resource, null); return null; }
    const uid = new Array(16).fill(0).map((_, i) => (bytes.length * (i + 7) + bytes[i % bytes.length]) & 0xff);
    const offset = pictureStream.length;
    pictureStream.push(...rec(0, png ? 0x6e0 : 0x46a, png ? 0xf01e : 0xf01d, [...uid, 0xff, ...bytes]));
    blips.push({ png, uid, size: pictureStream.length - offset, offset });
    blipOf.set(resource, blips.length);
    return blips.length;
  };

  /** A shape's container: its kind, its properties, where it is, and its text. */
  let spid = 0;
  const shape = (dg, type, props, box, text = null, flags = 0x0a00) => {
    spid += 1;
    const id = dg * 1024 + spid;
    const sorted = [...props].sort((a, b) => (a[0] & 0x3fff) - (b[0] & 0x3fff));
    const opt = sorted.flatMap(([pid, value]) => [...u16(pid), ...u32(value)]);
    const anchor = [...i16(Math.round(box.y * unit)), ...i16(Math.round(box.x * unit)), ...i16(Math.round((box.x + box.w) * unit)), ...i16(Math.round((box.y + box.h) * unit))];
    const parts = [rec(2, type, 0xf00a, [...u32(id), ...u32(flags)]), rec(3, sorted.length, 0xf00b, opt), rec(0, 0, 0xf010, anchor)];
    if (text !== null) {
      const body = text.replace(/\n/g, '\r');
      const chars = [...body].flatMap((ch) => u16(ch.charCodeAt(0)));
      const style = [...u32(body.length + 1), ...u16(0), ...u32(0), ...u32(body.length + 1), ...u32(0)];
      parts.push(rec(15, 0, 0xf00d, [...rec(0, 0, 0x0f9f, u32(4)), ...rec(0, 0, 0x0fa0, chars), ...rec(0, 0, 0x0fa1, style)]));
    }
    return rec(15, 0, 0xf004, parts.flat());
  };

  const drawingOf = (dg, elements) => {
    spid = 0;
    const shapes = [];
    for (const e of [...elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) {
      const box = { x: e.x ?? 0, y: e.y ?? 0, w: e.w ?? 100, h: e.h ?? 50 };
      const turn = e.rotation ? [[0x0004, Math.round(e.rotation * 65536) >>> 0]] : [];
      if (e.kind === 'text') {
        const text = (e.content ?? []).map((r) => r.text).join('');
        shapes.push(shape(dg, 202, [...turn, [0x01bf, 0x00100000], [0x01ff, 0x00080000]], box, text));
      } else if (e.kind === 'shape') {
        const type = SHAPE_TYPES[e.shape];
        if (!type) losses.add('Shapes PowerPoint 97 does not have, drawn as rectangles');
        const fill = e.fillLook?.type === 'none' ? [[0x01bf, 0x00100000]] : [[0x0181, colourref(e.fillLook?.color ?? '#729fcf')], [0x01bf, 0x00100010]];
        const line = e.line?.style === 'none' ? [[0x01ff, 0x00080000]] : [[0x01c0, colourref(e.line?.color ?? '#3465a4')], [0x01cb, Math.round((e.line?.width ?? 1) * 9525)], [0x01ff, 0x00080008]];
        shapes.push(shape(dg, type ?? 1, [...turn, ...fill, ...line], box, e.text ? e.text : null));
      } else if (e.kind === 'image') {
        const index = blipIndex(e.resource);
        if (index) shapes.push(shape(dg, 75, [...turn, [0x4104, index]], box));
      } else if (e.kind === 'path' && (e.subpaths ?? []).length === 1 && e.subpaths[0].nodes.length === 2 && !e.subpaths[0].closed) {
        shapes.push(shape(dg, 20, [[0x01c0, colourref(e.line?.color ?? '#000000')], [0x01cb, Math.round((e.line?.width ?? 1) * 9525)], [0x01ff, 0x00080008]], box));
      } else losses.add('Drawings other than shapes, text boxes, lines and pictures, left out');
    }
    const fdg = rec(0, dg, 0xf008, [...u32(shapes.length + 1), ...u32(dg * 1024 + spid)]);
    const group = rec(15, 0, 0xf003, [...rec(15, 0, 0xf004, [...rec(1, 0, 0xf009, new Array(16).fill(0)), ...rec(2, 0, 0xf00a, [...u32(dg * 1024), ...u32(0x5)])]), ...shapes.flat()]);
    return { record: rec(15, 0, 0x040c, rec(15, 0, 0xf002, [...fdg, ...group])), count: shapes.length + 1, last: dg * 1024 + spid };
  };
  const scheme = rec(0, 1, 0x07f0, [0xffffff, 0x000000, 0x808080, 0x000000, 0xbbe0e3, 0x333399, 0x009999, 0x99cc00].flatMap((c) => u32(c)));
  const slideAtom = (master) => rec(2, 0, 0x03ef, [...u32(0), ...new Array(8).fill(0), ...u32(master), ...u32(0), ...u16(master ? 0x0007 : 0), ...u16(0)]);

  // The master, then each slide, their offsets kept for the persist directory.
  const stream = [];
  const offsets = new Map();
  const documentPlaceholder = 1;
  const drawings = [];
  const masterDrawing = drawingOf(1, []);
  drawings.push(masterDrawing);
  const slideRecords = slides.map((slide, i) => {
    const d = drawingOf(i + 2, slide.elements ?? []);
    drawings.push(d);
    return rec(15, 0, 0x03ee, [...slideAtom(0x80000000), ...d.record, ...scheme]);
  });
  if (slides.some((s) => (s.notes ?? '').trim())) losses.add('Speaker notes, which this writer of PowerPoint 97 files leaves out');
  if (slides.some((s) => s.transition && s.transition !== 'none')) losses.add('Slide transitions');
  const fonts = rec(15, 0, 0x07d5, rec(0, 0, 0x0fb7, [...[...'Arial'.padEnd(32, '\u0000')].flatMap((ch) => u16(ch.charCodeAt(0))), 0, 0, 0, 0x22]));
  const environment = rec(15, 0, 0x03f2, fonts);
  const persistAtom = (ref, slideId) => rec(0, 0, 0x03f3, [...u32(ref), ...u32(0), ...i32(0), ...u32(slideId), ...u32(0)]);
  const masterList = rec(15, 1, 0x0ff0, persistAtom(2, 0x80000000));
  const slideList = rec(15, 0, 0x0ff0, slides.flatMap((_, i) => persistAtom(3 + i, 256 + i)));
  const dgg = (() => {
    const cluster = drawings.flatMap((d, i) => [...u32(i + 1), ...u32(d.last + 1)]);
    const fdgg = rec(0, 0, 0xf006, [...u32(drawings.length * 1024 + 1024), ...u32(drawings.length + 1), ...u32(drawings.reduce((n, d) => n + d.count, 0)), ...u32(drawings.length), ...cluster]);
    const store = blips.length ? rec(15, blips.length, 0xf001, blips.flatMap((b) => rec(2, b.png ? 6 : 5, 0xf007, [b.png ? 6 : 5, b.png ? 6 : 5, ...b.uid, ...u16(0xff), ...u32(b.size), ...u32(1), ...u32(b.offset), 0, 0, 0, 0]))) : [];
    return rec(15, 0, 0x040b, rec(15, 0, 0xf000, [...fdgg, ...store]));
  })();
  const docAtom = rec(1, 0, 0x03e9, [...i32(slideW), ...i32(slideH), ...i32(slideH), ...i32(slideW), ...i32(1), ...i32(2), ...u32(0), ...u32(0), ...u16(1), ...u16(canvas.w / canvas.h < 1.5 ? 0 : 6), 0, 0, 0, 1]);
  const documentRecord = rec(15, 0, 0x03e8, [...docAtom, ...environment, ...dgg, ...masterList, ...slideList, ...rec(0, 0, 0x03ea, [])]);
  offsets.set(documentPlaceholder, stream.length);
  stream.push(...documentRecord);
  offsets.set(2, stream.length);
  stream.push(...rec(15, 0, 0x03f8, [...slideAtom(0), ...scheme, ...masterDrawing.record]));
  slideRecords.forEach((r, i) => { offsets.set(3 + i, stream.length); stream.push(...r); });
  const ids = [...offsets.keys()].sort((a, b) => a - b);
  const directoryAt = stream.length;
  stream.push(...rec(0, 0, 0x1772, [...u32(1 | (ids.length << 20)), ...ids.flatMap((k) => u32(offsets.get(k)))]));
  const editAt = stream.length;
  stream.push(...rec(0, 0, 0x0ff5, [...u32(256), ...u16(0), 0, 3, ...u32(0), ...u32(directoryAt), ...u32(1), ...u32(ids.length + 1), ...u16(1), ...u16(0)]));
  // The current user: no name, as GRT writes none.
  const current = rec(0, 0, 0x0ff6, [...u32(0x14), ...u32(0xe391c05f), ...u32(editAt), ...u16(0), ...u16(0x03f4), 3, 0, ...u16(0), ...u32(8)]);
  const streams = new Map([['PowerPoint Document', Uint8Array.from(stream)], ['Current User', Uint8Array.from(current)]]);
  if (pictureStream.length) streams.set('Pictures', Uint8Array.from(pictureStream));
  return { bytes: writeCfb(streams), losses };
}
