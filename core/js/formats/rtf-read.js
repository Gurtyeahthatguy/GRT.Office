/** Rich Text Format into the editor's document model. */

import { normaliseRuns, pageSizeFields } from '../editor/model.js';
import { toMm } from '../units.js';
import { Losses } from '../losses.js';
import { fittedSize } from '../images.js';

const PX_PER_TWIP = 96 / 1440;

/** Code pages for the font charsets RTF names. */
const CHARSETS = {
  0: 1252, 1: 1252, 2: 1252, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950,
  161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250,
};

const ENCODINGS = {
  437: 'ibm866', 850: 'ibm866', 866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr',
  950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  10000: 'macintosh', 65001: 'utf-8',
};

function decoderFor(codepage) {
  try {
    return new TextDecoder(ENCODINGS[codepage] ?? 'windows-1252');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

/** Destinations whose content is never text. */
const SKIPPED = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'mmathPr', 'pgdsctbl',
  'fldinst', 'nonshppict', 'bkmkstart', 'bkmkend', 'pntext', 'pntxtb', 'pntxta', 'listtext', 'revtbl',
  'filetbl', 'objdata', 'objclass', 'blipuid', 'xe', 'tc', 'template', 'password', 'userprops', 'docvar',
  'atnid', 'atnauthor', 'atntime', 'atnref', 'atndate', 'annotation', 'comment', 'keywords', 'subject',
  'author', 'operator', 'title', 'company', 'manager', 'category', 'doccomm', 'hlinkbase', 'sp', 'sn', 'sv',
  'listname', 'list', 'listlevel', 'leveltext', 'levelnumbers', 'listoverride', 'listpicture', 'shprslt',
]);

const BAND_KINDS = {
  header: ['header', 'default'], headerl: ['header', 'even'], headerr: ['header', 'default'], headerf: ['header', 'first'],
  footer: ['footer', 'default'], footerl: ['footer', 'even'], footerr: ['footer', 'default'], footerf: ['footer', 'first'],
};

/**
 * @param {Uint8Array|string} source the file's bytes, or its text already decoded as Latin-1
 * @returns {{document: object, images: Map<string, Uint8Array>, losses: Losses}}
 */
export function readRtf(source) {
  const text = typeof source === 'string' ? source : latin1(source);
  if (!/^\s*\{\\rtf/.test(text)) throw new Error('This is not an RTF file');
  return new RtfReader(text).read();
}

function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

const OLD_BULLETS = -1;
const OLD_NUMBERS = -2;

const freshChar = () => ({ bold: false, italic: false, underline: false, strike: false, sup: false, sub: false, color: 0, highlight: 0, size: 24, font: null, hidden: false });
const freshPara = () => ({ align: 'left', style: 0, outline: null, pageBreak: false, list: null, level: 0, inTable: false });

class RtfReader {
  constructor(text) {
    this.text = text;
    this.at = 0;
    this.losses = new Losses();
    this.blocks = [];
    this.images = new Map();
    this.notes = [];
    this.fonts = new Map();
    this.colors = [null];
    this.styles = new Map();
    this.codepage = 1252;
    this.defaultFont = 0;
    this.page = { width: 12240, height: 15840, left: 1800, right: 1800, top: 1440, bottom: 1440, landscape: false };
    this.running = {
      firstDifferent: false,
      evenDifferent: false,
      header: { default: null, first: null, even: null },
      footer: { default: null, first: null, even: null },
    };
    this.runs = [];
    this.row = null;
    this.pendingBreak = false;
    this.list = null;
  }

  read() {
    this.group({ char: freshChar(), para: freshPara(), sink: 'body', uc: 1 });
    this.endParagraph(true);
    if (this.notes.length > 0) {
      this.blocks.push(block('paragraph', 'body', 'left', []));
      this.notes.forEach((note, i) => this.blocks.push(block('paragraph', 'body', 'left', [{ text: `[${i + 1}] ${note}` }])));
      this.losses.add('Footnotes and endnotes, moved to the end of the document', this.notes.length);
    }
    const blocks = mergeCode(this.blocks);
    if (blocks.length === 0) blocks.push(block('paragraph', 'body', 'left', []));
    return {
      document: { version: 1, type: 'paper', page: this.pageSetup(), blocks },
      images: this.images,
      losses: this.losses,
    };
  }

  // The tokenizer and the groups

  /**
   * Reads a group with a copy of the state: from its opening brace, or, when
   * `opened`, from inside it, as a destination does once its word is read.
   */
  group(outer, opened = false) {
    const state = { ...outer, char: { ...outer.char }, para: outer.para };
    if (!opened && this.text[this.at] === '{') this.at += 1;
    let first = true;
    let bytes = [];

    const flushBytes = () => {
      if (bytes.length === 0) return;
      const codepage = this.fonts.get(state.char.font)?.codepage ?? this.codepage;
      this.emit(decoderFor(codepage).decode(new Uint8Array(bytes)), state);
      bytes = [];
    };

    while (this.at < this.text.length) {
      const c = this.text[this.at];
      if (c === '}') {
        flushBytes();
        this.at += 1;
        return state;
      }
      if (c === '{') {
        flushBytes();
        this.group(state);
        first = false;
        continue;
      }
      if (c === '\\') {
        const next = this.text[this.at + 1];
        if (next === "'") {
          bytes.push(parseInt(this.text.slice(this.at + 2, this.at + 4), 16) || 0x3F);
          this.at += 4;
          first = false;
          continue;
        }
        flushBytes();
        const { word, param, symbol } = this.controlWord();
        if (symbol === '*') {
          const peek = /^\s*\\([a-zA-Z]+)/.exec(this.text.slice(this.at, this.at + 40));
          if (!peek || !['shppict', 'footnote', 'shpinst', 'do', 'pn'].includes(peek[1])) {
            this.skipGroup();
            return state;
          }
          continue;
        }
        if (symbol) {
          this.symbol(symbol, state);
          first = false;
          continue;
        }
        if (first && SKIPPED.has(word) && !['fonttbl', 'colortbl', 'stylesheet'].includes(word)) {
          if (word === 'annotation') this.losses.add('Comments');
          this.skipGroup();
          return state;
        }
        const ended = this.control(word, param, state, first);
        first = false;
        if (ended) return state;
        continue;
      }
      if (c === '\r' || c === '\n') {
        this.at += 1;
        continue;
      }
      // Plain text runs up to the next special character.
      let end = this.at;
      while (end < this.text.length && !'\\{}\r\n'.includes(this.text[end])) end += 1;
      for (let i = this.at; i < end; i += 1) bytes.push(this.text.charCodeAt(i) & 0xFF);
      this.at = end;
      first = false;
    }
    flushBytes();
    return state;
  }

  controlWord() {
    this.at += 1;
    const c = this.text[this.at];
    if (!/[a-zA-Z]/.test(c ?? '')) {
      this.at += 1;
      return { symbol: c };
    }
    const match = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(this.text.slice(this.at, this.at + 48));
    this.at += match[0].length;
    return { word: match[1], param: match[2] === undefined ? null : Number(match[2]) };
  }

  /** Skips to the end of the current group, its own closing brace included. */
  skipGroup() {
    let depth = 1;
    while (this.at < this.text.length && depth > 0) {
      const c = this.text[this.at];
      const binary = c === '\\' ? /^\\bin(\d+) ?/.exec(this.text.slice(this.at, this.at + 16)) : null;
      if (binary) this.at += binary[0].length + Number(binary[1]);
      else if (c === '\\') this.at += 2;
      else {
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        this.at += 1;
      }
    }
  }

  /** Reads a destination's raw text up to its group's end. */
  rawGroup() {
    const start = this.at;
    this.skipGroup();
    return this.text.slice(start, this.at - 1);
  }

  symbol(symbol, state) {
    switch (symbol) {
      case '\\': case '{': case '}': this.emit(symbol, state); break;
      case '~': this.emit('\u00A0', state); break;
      case '_': this.emit('\u2011', state); break;
      case '-': break;
      case '\n': case '\r': this.endParagraph(false, state); break;
      case '|': case ':': break;
      default: break;
    }
  }

  /** Handles a control word; returns true when it consumed the rest of the group. */
  control(word, param, state, first) {
    const char = state.char;
    const para = state.para;
    const on = param === null || param !== 0;
    switch (word) {
      // Document
      case 'ansicpg': this.codepage = param; return false;
      case 'deff': this.defaultFont = param; return false;
      case 'fonttbl': this.fontTable(); return true;
      case 'colortbl': this.colorTable(); return true;
      case 'stylesheet': this.styleSheet(); return true;
      case 'paperw': this.page.width = param; return false;
      case 'paperh': this.page.height = param; return false;
      case 'margl': this.page.left = param; return false;
      case 'margr': this.page.right = param; return false;
      case 'margt': this.page.top = param; return false;
      case 'margb': this.page.bottom = param; return false;
      case 'landscape': this.page.landscape = true; return false;
      case 'titlepg': this.running.firstDifferent = true; return false;
      case 'facingp': this.running.evenDifferent = true; return false;
      case 'uc': state.uc = param ?? 1; return false;
      case 'u': {
        const code = param < 0 ? param + 65536 : param;
        this.emit(String.fromCharCode(code), state);
        this.skipFallback(state.uc);
        return false;
      }

      // Character
      case 'plain': Object.assign(char, freshChar()); return false;
      case 'b': char.bold = on; return false;
      case 'i': char.italic = on; return false;
      case 'ul': case 'uld': case 'uldb': case 'ulw': case 'ulwave': case 'uldash': case 'ulth':
        char.underline = on; return false;
      case 'ulnone': char.underline = false; return false;
      case 'strike': case 'striked': char.strike = on; return false;
      case 'super': char.sup = on; char.sub = false; return false;
      case 'sub': char.sub = on; char.sup = false; return false;
      case 'nosupersub': char.sup = false; char.sub = false; return false;
      case 'fs': char.size = param ?? 24; return false;
      case 'cf': char.color = param ?? 0; return false;
      case 'highlight': case 'cb': case 'chcbpat': char.highlight = param ?? 0; return false;
      case 'f': char.font = param; return false;
      case 'v': char.hidden = on; return false;
      case 'bin':
        this.at += param ?? 0;
        return false;

      // Paragraph
      case 'pard': Object.assign(para, freshPara()); return false;
      case 'ql': para.align = 'left'; return false;
      case 'qc': para.align = 'center'; return false;
      case 'qr': para.align = 'right'; return false;
      case 'qj': case 'qd': para.align = 'justify'; return false;
      case 's': para.style = param ?? 0; return false;
      case 'outlinelevel': para.outline = param; return false;
      case 'pagebb': para.pageBreak = true; return false;
      case 'ls': para.list = param; return false;
      case 'ilvl': para.level = param ?? 0; return false;
      case 'intbl': para.inTable = true; return false;
      case 'par':
        if (state.sink !== 'body') this.emit(' ', state);
        else this.endParagraph(false, state);
        return false;
      case 'page':
        if (state.sink !== 'body') return false;
        this.endParagraph(false, state);
        this.pendingBreak = true;
        return false;
      case 'sect':
        if (state.sink !== 'body') return false;
        this.endParagraph(false, state);
        this.losses.add('Sections with a page setup of their own, set up like the first one');
        return false;
      case 'line':
        if (state.sink !== 'body') {
          this.emit(' ', state);
          return false;
        }
        this.losses.add('Line breaks inside a paragraph, made into new paragraphs');
        this.endParagraph(false, state);
        return false;
      case 'tab': this.emit('\t', state); return false;
      case 'emdash': this.emit('\u2014', state); return false;
      case 'endash': this.emit('\u2013', state); return false;
      case 'bullet': this.emit('\u2022', state); return false;
      case 'lquote': this.emit('\u2018', state); return false;
      case 'rquote': this.emit('\u2019', state); return false;
      case 'ldblquote': this.emit('\u201C', state); return false;
      case 'rdblquote': this.emit('\u201D', state); return false;
      case 'emspace': case 'enspace': case 'qmspace': this.emit(' ', state); return false;

      case 'trowd': return false;
      case 'cell':
        this.endCell();
        return false;
      case 'row':
        this.endRow();
        return false;

      // Destinations with something to read
      case 'pict':
        if (first) {
          this.picture(state);
          return true;
        }
        return false;
      case 'footnote':
        if (first) {
          const note = this.collect(state);
          this.notes.push(note.map((r) => r.text).join('').replace(/\s+/g, ' ').trim());
          this.emit(`[${this.notes.length}]`, { ...state, char: { ...state.char, sup: true } });
          return true;
        }
        return false;
      case 'field': return false;
      case 'fldrslt': return false;
      case 'shp': case 'shpinst': return false;
      case 'do':
        this.losses.add('Drawings and shapes, their text kept as paragraphs');
        return false;
      case 'pn':
        if (first) {
          para.list = /\\pnlvlblt/.test(this.rawGroup()) ? OLD_BULLETS : OLD_NUMBERS;
          return true;
        }
        return false;
      case 'shptxt':
        if (first) {
          this.textBox(state);
          return true;
        }
        return false;
      case 'shppict': return false;
      case 'object':
        this.losses.add('Charts, formulas and other embedded objects');
        return false;
      default:
        if (first && BAND_KINDS[word]) {
          this.band(word, state);
          return true;
        }
        return false;
    }
  }

  skipFallback(count) {
    let left = count;
    while (left > 0 && this.at < this.text.length) {
      const c = this.text[this.at];
      if (c === '}' || c === '{') return;
      if (c === '\\') {
        if (this.text[this.at + 1] === "'") this.at += 4;
        else this.controlWord();
      } else this.at += 1;
      left -= 1;
    }
  }

  // Tables of fonts, colours and styles

  fontTable() {
    const raw = this.rawGroup();
    for (const entry of raw.matchAll(/\\f(\d+)([^;{}]*?)(?:\\fcharset(\d+))?[^;{}]*;?/g)) {
      const number = Number(entry[1]);
      const charset = /\\fcharset(\d+)/.exec(entry[0])?.[1];
      const name = entry[0].replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{};]/g, '').trim();
      this.fonts.set(number, { name, codepage: charset !== undefined ? CHARSETS[Number(charset)] ?? null : null });
    }
  }

  colorTable() {
    const raw = this.rawGroup();
    this.colors = raw.split(';').slice(0, -1).map((entry) => {
      const r = /\\red(\d+)/.exec(entry);
      const g = /\\green(\d+)/.exec(entry);
      const b = /\\blue(\d+)/.exec(entry);
      if (!r && !g && !b) return null;
      const hex = (m) => Number(m?.[1] ?? 0).toString(16).padStart(2, '0');
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    });
  }

  styleSheet() {
    const raw = this.rawGroup();
    for (const entry of raw.split('}')) {
      const number = /\\s(\d+)/.exec(entry);
      const name = entry.replace(/\{\\\*[^}]*$/, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{};]/g, '').trim();
      const outline = /\\outlinelevel(\d+)/.exec(entry);
      if (number) this.styles.set(Number(number[1]), { name, outline: outline ? Number(outline[1]) : null });
      else if (/^Normal/i.test(name)) this.styles.set(0, { name, outline: null });
    }
  }

  // Content

  emit(text, state) {
    if (!text || state.char.hidden) return;
    if (state.sink !== 'body') {
      state.sink.push(this.run(text, state.char));
      return;
    }
    this.runs.push({ run: this.run(text, state.char), para: state.para });
  }

  run(text, char) {
    const run = { text };
    for (const mark of ['bold', 'italic', 'underline', 'strike', 'sup', 'sub']) if (char[mark]) run[mark] = true;
    const color = this.colors[char.color];
    if (color && color !== '#000000') run.color = color;
    const highlight = this.colors[char.highlight];
    if (char.highlight && highlight && highlight !== '#ffffff') run.highlight = highlight;
    if (char.size && char.size !== 24) run.size = char.size / 2;
    return run;
  }

  /** A destination's text, as runs, kept out of the body. */
  collect(state) {
    const sink = [];
    this.group({ ...state, sink, char: { ...state.char }, para: freshPara() }, true);
    return sink;
  }

  endParagraph(atEnd, state = null) {
    const collected = this.runs;
    this.runs = [];
    const onlyPicture = this.pictureHere;
    this.pictureHere = false;
    if (collected.length === 0) {
      if (!atEnd && !onlyPicture) this.blocks.push(this.paragraphBlock([], state?.para ?? freshPara()));
      return;
    }
    const para = collected[collected.length - 1].para;
    const runs = collected.map((entry) => entry.run);
    if (para.inTable) {
      this.row ??= { cells: [], cell: [] };
      this.row.cell.push(...(this.row.cell.length > 0 ? [{ text: ' ' }] : []), ...runs);
      return;
    }
    this.blocks.push(this.paragraphBlock(runs, para));
    this.rowBefore = false;
  }

  paragraphBlock(runs, para) {
    const style = this.styles.get(para.style) ?? null;
    const outline = para.outline ?? style?.outline ?? headingNumber(style?.name);
    let made;
    const heading = outline !== null && outline !== undefined && outline < 9;
    if (!heading && para.list !== null && para.list !== undefined && para.list !== 0) {
      const last = this.blocks[this.blocks.length - 1];
      const item = { level: Math.min(para.level, 5), runs: normaliseRuns(runs) };
      const listType = this.listType(para.list);
      if (last?.kind === 'list' && last.listType === listType && !this.pendingBreak) {
        last.items.push(item);
        return null;
      }
      made = { kind: 'list', style: 'body', align: para.align, listType, items: [item] };
    } else if (heading) {
      if (para.list > 0) this.losses.add('Numbered headings, their numbers dropped');
      const level = Math.min(outline + 1, 4);
      made = block('heading', `h${level}`, para.align, runs);
      made.level = level;
    } else if (/quot/i.test(style?.name ?? '')) {
      made = block('quote', 'quote', para.align, runs);
    } else if (/preformatted|code|plain text/i.test(style?.name ?? '')) {
      made = block('code', 'code', para.align, runs);
    } else {
      made = block('paragraph', 'body', para.align, runs);
    }
    if (para.pageBreak || this.pendingBreak) made.breakBefore = true;
    this.pendingBreak = false;
    return made;
  }

  listType(list) {
    if (list === OLD_BULLETS) return 'bullet';
    if (list === OLD_NUMBERS) return 'number';
    this.listTypes ??= this.readListTypes();
    return this.listTypes.get(list) ?? 'bullet';
  }

  /** Bullet or number for each list override, read from the list table. */
  readListTypes() {
    const types = new Map();
    const lists = new Map();
    for (const match of this.text.matchAll(/\{\\list\\listtemplateid-?\d+.*?\\listid(-?\d+)\}/gs)) {
      const format = /\\levelnfc(\d+)/.exec(match[0]);
      lists.set(Number(match[1]), format && format[1] === '23' ? 'bullet' : 'number');
    }
    for (const match of this.text.matchAll(/\{\\listoverride\\listid(-?\d+)[^}]*?\\ls(\d+)/g)) {
      types.set(Number(match[2]), lists.get(Number(match[1])) ?? 'bullet');
    }
    return types;
  }

  endCell() {
    this.row ??= { cells: [], cell: [] };
    if (this.runs.length > 0) {
      this.row.cell.push(...this.runs.map((entry) => entry.run));
      this.runs = [];
    }
    this.row.cells.push(this.row.cell);
    this.row.cell = [];
  }

  endRow() {
    if (!this.row) return;
    const runs = this.row.cells.flatMap((cell, i) => (i === 0 ? cell : [{ text: '\t' }, ...cell]));
    if (!this.rowBefore) this.losses.add('Tables, kept as text with a tab between cells');
    this.blocks.push(block('paragraph', 'body', 'left', runs));
    this.row = null;
    this.rowBefore = true;
  }

  picture(state) {
    const raw = this.rawGroup();
    const png = /\\pngblip/.test(raw);
    const jpeg = /\\jpegblip/.test(raw);
    if (!png && !jpeg) {
      this.losses.add('Pictures in a format the program cannot show, such as WMF or EMF');
      return;
    }
    const goalW = /\\picwgoal(\d+)/.exec(raw);
    const goalH = /\\pichgoal(\d+)/.exec(raw);
    const scaleX = Number(/\\picscalex(\d+)/.exec(raw)?.[1] ?? 100) / 100;
    const scaleY = Number(/\\picscaley(\d+)/.exec(raw)?.[1] ?? 100) / 100;
    const hex = raw.replace(/\{[^}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[^0-9a-f]/gi, '');
    const bytes = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    if (bytes.length === 0) return;

    const resource = `resources/image${this.images.size + 1}.${png ? 'png' : 'jpg'}`;
    this.images.set(resource, bytes);
    const size = goalW && goalH
      ? { w: Math.round(Number(goalW[1]) * scaleX * PX_PER_TWIP), h: Math.round(Number(goalH[1]) * scaleY * PX_PER_TWIP) }
      : fittedSize(bytes);
    // The text before the picture stays a paragraph of its own.
    if (this.runs.length > 0) this.endParagraph(false, state);
    const image = { kind: 'image', style: 'body', resource, w: Math.max(1, size.w), h: Math.max(1, size.h), align: state.para.align === 'justify' ? 'left' : state.para.align, caption: [] };
    if (this.pendingBreak) image.breakBefore = true;
    this.pendingBreak = false;
    this.blocks.push(image);
    this.pictureHere = true;
  }

  /** A text box: a captioned picture when it holds one picture, its paragraphs otherwise. */
  textBox(state) {
    const before = this.blocks.length;
    const savedRuns = this.runs;
    this.runs = [];
    this.group({ ...state, char: { ...state.char }, para: freshPara() }, true);
    if (this.runs.length > 0) this.endParagraph(false, state);
    this.runs = savedRuns;
    const inner = this.blocks.splice(before);
    const pictures = inner.filter((each) => each?.kind === 'image');
    const text = inner.filter((each) => each && each.kind !== 'image')
      .map((each) => (each.runs ?? []).map((run) => run.text).join('')).join(' ').replace(/\s+/g, ' ').trim();
    if (pictures.length === 1) {
      pictures[0].caption = text ? [{ text }] : [];
      this.blocks.push(pictures[0]);
      this.pictureHere = true;
      return;
    }
    this.losses.add('Text boxes, their text kept as paragraphs');
    this.blocks.push(...inner);
  }

  band(word, state) {
    const [part, which] = BAND_KINDS[word];
    const start = this.at;
    const sink = [];
    const inner = { ...state, sink, char: { ...state.char }, para: freshPara() };
    this.group(inner, true);
    const raw = this.text.slice(start, this.at);
    // Page fields become the tokens slots use.
    let text = sink.map((run) => run.text).join('').replace(/\s+/g, ' ').trim();
    const fields = [...raw.matchAll(/\\fldinst[^}]*?\b(PAGE|NUMPAGES|SECTIONPAGES)\b[^}]*\}[^]*?\\fldrslt[^}]*?([^\\{}]*)\}/g)];
    for (const field of fields) {
      const token = field[1] === 'PAGE' ? '{page}' : '{pages}';
      const shown = field[2].trim();
      text = shown ? text.replace(shown, token) : `${text} ${token}`.trim();
    }
    if (/\\chpgn\b/.test(raw)) text = text ? `${text} {page}` : '{page}';
    if (!text) return;
    const align = /\\qc\b/.test(raw) ? 'center' : /\\qr\b/.test(raw) ? 'right' : 'left';
    this.running[part][which] = { text, align };
    if (which === 'first') this.running.firstDifferent = this.running.firstDifferent || /\\titlepg/.test(this.text);
  }

  pageSetup() {
    const width = toMm(this.page.width, 'twip');
    const height = toMm(this.page.height, 'twip');
    const clamp = (twips) => Math.max(5, Math.min(60, Math.round(toMm(twips, 'twip') * 10) / 10));
    const running = this.running;
    if (!running.firstDifferent) running.header.first = running.footer.first = null;
    if (!running.evenDifferent) running.header.even = running.footer.even = null;
    return {
      ...pageSizeFields(width, height),
      orientation: this.page.landscape || width > height ? 'landscape' : 'portrait',
      margins: {
        top: clamp(this.page.top), bottom: clamp(this.page.bottom), left: clamp(this.page.left), right: clamp(this.page.right),
      },
      running,
    };
  }
}

function block(kind, style, align, runs) {
  return { kind, style, align, runs: normaliseRuns(runs) };
}

function headingNumber(name) {
  const match = /^heading\s*(\d)$/i.exec(name ?? '');
  return match ? Number(match[1]) - 1 : null;
}

function mergeCode(blocks) {
  const out = [];
  for (const each of blocks) {
    if (!each) continue;
    const last = out[out.length - 1];
    if (each.kind === 'code' && last?.kind === 'code' && !each.breakBefore) {
      last.runs = normaliseRuns([...last.runs, { text: '\n' }, ...each.runs]);
      continue;
    }
    out.push(each);
  }
  return out.filter((each, i) => !(each.kind === 'paragraph' && each.runs.length === 1 && each.runs[0].text === ''
    && (out[i - 1]?.kind === 'list' || i === out.length - 1)));
}
