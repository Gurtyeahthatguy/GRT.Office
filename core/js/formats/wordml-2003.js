/** Word 2003 XML documents (WordprocessingML 2003): read by turning them into a Word package, written by turning one back. */

import { NS, parseXml, escapeText, escapeAttr } from '../xml.js';
import { Package } from '../package.js';
import { Losses } from '../losses.js';
import { readDocx } from './docx-read.js';
import { writeDocx } from './docx-write.js';
import { REL, IMAGE_TYPES } from './ooxml.js';

const W03 = 'http://schemas.microsoft.com/office/word/2003/wordml';
const W06 = NS.w;
const WX = 'http://schemas.microsoft.com/office/word/2003/auxHint';
const AML = 'http://schemas.microsoft.com/aml/2001/core';
const XMLNS = 'http://www.w3.org/XML/1998/namespace';
const KEPT = {
  'urn:schemas-microsoft-com:vml': 'v', 'urn:schemas-microsoft-com:office:office': 'o', 'urn:schemas-microsoft-com:office:word': 'w10',
};
const DECLARE = Object.entries(KEPT).map(([uri, prefix]) => ` xmlns:${prefix}="${uri}"`).join('');
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const OMML = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const MAX_PICTURE = 50 * 1024 * 1024;

/** 2003's attribute names that the later format spells otherwise, each way. */
const ATTRS_IN = { 'first-line': 'firstLine', 'line-rule': 'lineRule', 'before-autospacing': 'beforeAutospacing', 'after-autospacing': 'afterAutospacing', 'h-ansi': 'hAnsi', fareast: 'eastAsia' };
const ATTRS_OUT = Object.fromEntries(Object.entries(ATTRS_IN).map(([a, b]) => [b, a]));
const ELEMENTS_IN = { vmerge: 'vMerge' };
const ELEMENTS_OUT = { vMerge: 'vmerge' };

/** Number formats: 2003 numbers them, the later format names them. */
const NFC = { 0: 'decimal', 1: 'upperRoman', 2: 'lowerRoman', 3: 'upperLetter', 4: 'lowerLetter', 5: 'ordinal', 6: 'cardinalText', 7: 'ordinalText', 22: 'decimalZero', 23: 'bullet', 255: 'none' };
const NFC_OUT = Object.fromEntries(Object.entries(NFC).map(([k, v]) => [v, k]));

const kidsOf = (e, ns, local) => [...(e?.children ?? [])].filter((c) => c.namespaceURI === ns && (!local || c.localName === local));
const kidOf = (e, ns, local) => kidsOf(e, ns, local)[0] ?? null;
const val = (e, ns = W03) => e?.getAttributeNS(ns, 'val') ?? null;

function base64(text) {
  const clean = String(text).replace(/\s+/g, '');
  if (clean.length > (MAX_PICTURE * 4) / 3) return null;
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch { return null; }
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Reading

class Reader2003 {
  constructor(root) {
    this.root = root;
    this.losses = new Losses();
    this.rels = [];
    this.media = new Map();
    this.notes = { footnote: [], endnote: [] };
    this.parts = new Map();
    this.pictures = new Map();
    // Character styles hidden from the person are LibreOffice's automatic ones: their looks belong to the text.
    this.hiddenStyles = new Map();
    for (const style of kidsOf(kidOf(root, W03, 'styles'), W03, 'style')) {
      if (style.getAttributeNS(W03, 'type') === 'character' && ['on', 'true', '1', null].includes(kidOf(style, W03, 'hidden') ? val(kidOf(style, W03, 'hidden')) : 'no')) {
        this.hiddenStyles.set(style.getAttributeNS(W03, 'styleId'), kidOf(style, W03, 'rPr'));
      }
    }
    for (const data of root.getElementsByTagNameNS(W03, 'binData')) {
      const bytes = base64(data.textContent);
      if (bytes) this.pictures.set(data.getAttributeNS(W03, 'name'), bytes);
    }
  }

  rel(type, target, external = false) {
    const id = `rId${this.rels.length + 10}`;
    this.rels.push({ id, type, target, external });
    return id;
  }

  attrs(e, rename = true) {
    let out = '';
    for (const a of e.attributes) {
      if (a.namespaceURI === W03) out += ` w:${rename ? ATTRS_IN[a.localName] ?? a.localName : a.localName}="${escapeAttr(a.value)}"`;
      else if (a.namespaceURI === XMLNS) out += ` xml:${a.localName}="${escapeAttr(a.value)}"`;
      else if (KEPT[a.namespaceURI]) out += ` ${KEPT[a.namespaceURI]}:${a.localName}="${escapeAttr(a.value)}"`;
      else if (!a.namespaceURI && !a.name.startsWith('xmlns')) out += ` ${a.name}="${escapeAttr(a.value)}"`;
    }
    return out;
  }

  children(e) {
    let out = '';
    for (const c of e.childNodes) out += this.node(c);
    return out;
  }

  node(n) {
    if (n.nodeType === 3 || n.nodeType === 4) return escapeText(n.nodeValue);
    if (n.nodeType !== 1) return '';
    if (n.namespaceURI === W03) return this.word(n);
    if (KEPT[n.namespaceURI]) return this.vml(n);
    if (n.namespaceURI === WX) {
      // Hints only Word reads, and wrappers round sections and paragraphs with borders.
      return [...n.children].some((c) => c.namespaceURI === W03 || c.namespaceURI === WX || c.namespaceURI === AML) ? this.children(n) : '';
    }
    if (n.namespaceURI === AML) return this.annotation(n);
    // Smart tags and custom markup: what they wrap is kept.
    return this.children(n);
  }

  annotation(n) {
    if (n.localName === 'content') return this.children(n);
    if (n.localName !== 'annotation') return '';
    const type = n.getAttributeNS(W03, 'type') ?? '';
    const id = n.getAttributeNS(AML, 'id') ?? '0';
    if (type === 'Word.Bookmark.Start') return `<w:bookmarkStart w:id="${escapeAttr(id)}" w:name="${escapeAttr(n.getAttributeNS(W03, 'name') ?? '')}"/>`;
    if (type === 'Word.Bookmark.End') return `<w:bookmarkEnd w:id="${escapeAttr(id)}"/>`;
    if (type === 'Word.Insertion') { this.losses.add('Tracked changes, shown as accepted'); return this.children(n); }
    if (type === 'Word.Deletion') { this.losses.add('Tracked changes, shown as accepted'); return ''; }
    if (type === 'Word.Comment') { this.losses.add('Comments of Word 2003 XML documents'); return ''; }
    return '';
  }

  vml(n) {
    const prefix = KEPT[n.namespaceURI];
    let extra = '';
    if (n.localName === 'imagedata') {
      const src = n.getAttributeNS(W03, 'src') ?? n.getAttribute('src') ?? '';
      const bytes = this.pictures.get(src);
      if (bytes) {
        const extension = (/\.(\w+)$/.exec(src)?.[1] ?? 'png').toLowerCase();
        const name = `media/image${this.media.size + 1}.${IMAGE_TYPES[extension] ? extension : 'png'}`;
        this.media.set(`word/${name}`, bytes);
        extra = ` r:id="${this.rel(REL.image, name)}"`;
      } else if (src) this.losses.add('Pictures linked from outside the file');
    }
    const attrs = [...n.attributes].filter((a) => !(n.localName === 'imagedata' && a.localName === 'src'));
    let out = '';
    for (const a of attrs) {
      if (KEPT[a.namespaceURI]) out += ` ${KEPT[a.namespaceURI]}:${a.localName}="${escapeAttr(a.value)}"`;
      else if (!a.namespaceURI && !a.name.startsWith('xmlns')) out += ` ${a.name}="${escapeAttr(a.value)}"`;
    }
    return `<${prefix}:${n.localName}${out}${extra}>${this.children(n)}</${prefix}:${n.localName}>`;
  }

  word(n) {
    const local = n.localName;
    switch (local) {
      case 'binData': case 'fonts': case 'docPr': case 'lists': case 'styles': case 'docOleData': case 'docSuppData': case 'shapeDefaults': case 'bgPict': return '';
      case 'hlink': {
        const dest = n.getAttributeNS(W03, 'dest');
        const bookmark = n.getAttributeNS(W03, 'bookmark');
        if (dest) return `<w:hyperlink r:id="${this.rel(REL.hyperlink, dest, true)}"${bookmark ? ` w:anchor="${escapeAttr(bookmark)}"` : ''}>${this.children(n)}</w:hyperlink>`;
        if (bookmark) return `<w:hyperlink w:anchor="${escapeAttr(bookmark)}">${this.children(n)}</w:hyperlink>`;
        return this.children(n);
      }
      case 'listPr': {
        const ilvl = val(kidOf(n, W03, 'ilvl')) ?? '0';
        const ilfo = val(kidOf(n, W03, 'ilfo'));
        return ilfo ? `<w:numPr><w:ilvl w:val="${escapeAttr(ilvl)}"/><w:numId w:val="${escapeAttr(ilfo)}"/></w:numPr>` : '';
      }
      case 'r': return this.run(n);
      case 'hdr': case 'ftr': {
        const kind = { odd: 'default', even: 'even', first: 'first' }[n.getAttributeNS(W03, 'type')] ?? 'default';
        const part = `${local === 'hdr' ? 'header' : 'footer'}${this.parts.size + 1}.xml`;
        this.parts.set(`word/${part}`, `<w:${local} xmlns:w="${W06}" xmlns:r="${R}"${DECLARE}>${this.children(n)}</w:${local}>`);
        return `<w:${local === 'hdr' ? 'headerReference' : 'footerReference'} w:type="${kind}" r:id="${this.rel(local === 'hdr' ? REL.header : REL.footer, part)}"/>`;
      }
      case 'rPr': {
        const ref = val(kidOf(n, W03, 'rStyle'));
        if (!ref || !this.hiddenStyles.has(ref)) break;
        const own = [...n.children].filter((c) => c.namespaceURI === W03 && c.localName !== 'rStyle');
        const names = new Set(own.map((c) => c.localName));
        const inherited = [...(this.hiddenStyles.get(ref)?.children ?? [])].filter((c) => c.namespaceURI === W03 && !names.has(c.localName));
        return `<w:rPr>${[...inherited, ...own].map((c) => this.node(c)).join('')}</w:rPr>`;
      }
      case 'name': {
        // LibreOffice writes its style names coded as in ODF, Heading_20_1 for Heading 1.
        const name = (val(n) ?? '').replace(/_([0-9a-f]{2,4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        return `<w:name w:val="${escapeAttr(name)}"/>`;
      }
      default: break;
    }
    const name = ELEMENTS_IN[local] ?? local;
    return `<w:${name}${this.attrs(n)}>${this.children(n)}</w:${name}>`;
  }

  /** A run: the runs Word nests inside it taken out, and a footnote in it moved to the notes, a reference left. */
  run(n) {
    const rPr = kidOf(n, W03, 'rPr');
    const own = rPr ? this.word(rPr) : '';
    let out = '';
    let pending = '';
    const flush = () => { if (pending) out += `<w:r>${own}${pending}</w:r>`; pending = ''; };
    for (const c of n.childNodes) {
      if (c === rPr) continue;
      if (c.nodeType === 1 && c.namespaceURI === W03 && c.localName === 'r') {
        flush();
        const inner = this.run(c);
        out += kidOf(c, W03, 'rPr') || !own ? inner : inner.replace(/<w:r>/g, `<w:r>${own}`);
      } else if (c.nodeType === 1 && c.namespaceURI === W03 && (c.localName === 'footnote' || c.localName === 'endnote')) {
        const list = this.notes[c.localName];
        const id = list.length + 1;
        list.push(`<w:${c.localName} w:id="${id}">${this.children(c)}</w:${c.localName}>`);
        pending += `<w:${c.localName}Reference w:id="${id}"/>`;
      } else pending += this.node(c);
    }
    flush();
    return out || `<w:r>${own}</w:r>`;
  }

  numbering() {
    const lists = kidOf(this.root, W03, 'lists');
    if (!lists) return null;
    const defs = kidsOf(lists, W03, 'listDef').map((def) => {
      const id = def.getAttributeNS(W03, 'listDefId') ?? '0';
      const levels = kidsOf(def, W03, 'lvl').map((lvl) => {
        let inner = '';
        let format = 'decimal';
        for (const c of lvl.children) {
          if (c.namespaceURI !== W03) continue;
          if (c.localName === 'nfc') { format = NFC[val(c)] ?? 'decimal'; continue; }
          inner += this.word(c);
        }
        return `<w:lvl${this.attrs(lvl)}><w:numFmt w:val="${format}"/>${inner}</w:lvl>`;
      }).join('');
      return `<w:abstractNum w:abstractNumId="${escapeAttr(id)}">${levels}</w:abstractNum>`;
    }).join('');
    const nums = kidsOf(lists, W03, 'list').map((list) => `<w:num w:numId="${escapeAttr(list.getAttributeNS(W03, 'ilfo') ?? '0')}"><w:abstractNumId w:val="${escapeAttr(val(kidOf(list, W03, 'ilst')) ?? '0')}"/></w:num>`).join('');
    return `<w:numbering xmlns:w="${W06}">${defs}${nums}</w:numbering>`;
  }

  read() {
    const body = kidOf(this.root, W03, 'body');
    if (!body) throw new Error('This Word 2003 XML document has no body');
    const document = `<w:document xmlns:w="${W06}" xmlns:r="${R}"${DECLARE}><w:body>${this.children(body)}</w:body></w:document>`;
    const styles = kidOf(this.root, W03, 'styles');
    const entries = new Map();
    const xml = (text) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n${text}`);
    if (styles) entries.set('word/styles.xml', xml(`<w:styles xmlns:w="${W06}">${this.children(styles)}</w:styles>`));
    const numbering = this.numbering();
    if (numbering) entries.set('word/numbering.xml', xml(numbering));
    if (styles) this.rel(REL.styles, 'styles.xml');
    if (numbering) this.rel(REL.numbering, 'numbering.xml');
    for (const kind of ['footnote', 'endnote']) {
      if (!this.notes[kind].length) continue;
      entries.set(`word/${kind}s.xml`, xml(`<w:${kind}s xmlns:w="${W06}" xmlns:r="${R}"${DECLARE}>${this.notes[kind].join('')}</w:${kind}s>`));
      this.rel(REL[`${kind}s`], `${kind}s.xml`);
    }
    for (const [name, text] of this.parts) entries.set(name, xml(text));
    for (const [name, bytes] of this.media) entries.set(name, bytes);
    entries.set('word/document.xml', xml(document));
    entries.set('word/_rels/document.xml.rels', xml(`<Relationships xmlns="${NS.rel}">${this.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`));
    entries.set('_rels/.rels', xml(`<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL.officeDocument}" Target="word/document.xml"/></Relationships>`));
    entries.set('[Content_Types].xml', xml(`<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`));
    return new Package(entries);
  }
}

/**
 * @param {string} text the .xml file
 * @returns {{document: Object, images: Map, losses: Losses}}
 */
export function readWordml2003(text) {
  const doc = parseXml(text, 'The document');
  const root = doc.documentElement;
  if (root.localName !== 'wordDocument' || root.namespaceURI !== W03) throw new Error('This is not a Word 2003 XML document');
  const reader = new Reader2003(root);
  const pkg = reader.read();
  const result = readDocx(pkg);
  for (const line of reader.losses.lines()) result.losses.add(line);
  return result;
}

// Writing

class Writer2003 {
  constructor(parts, losses) {
    this.parts = parts;
    this.losses = losses;
    this.rels = new Map();
    this.pictures = 0;
    const rels = this.xml('word/_rels/document.xml.rels');
    for (const r of rels?.documentElement.children ?? []) this.rels.set(r.getAttribute('Id'), { type: r.getAttribute('Type'), target: r.getAttribute('Target') });
    this.notes = {};
    for (const kind of ['footnote', 'endnote']) {
      this.notes[kind] = new Map();
      for (const note of this.xml(`word/${kind}s.xml`)?.documentElement.children ?? []) this.notes[kind].set(note.getAttributeNS(W06, 'id'), note);
    }
  }

  xml(name) {
    const bytes = this.parts.get(name);
    return bytes ? parseXml(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes), name) : null;
  }

  attrs(e) {
    let out = '';
    for (const a of e.attributes) {
      if (a.namespaceURI === W06) out += ` w:${ATTRS_OUT[a.localName] ?? a.localName}="${escapeAttr(a.value)}"`;
      else if (a.namespaceURI === XMLNS) out += ` xml:${a.localName}="${escapeAttr(a.value)}"`;
    }
    return out;
  }

  children(e) {
    let out = '';
    for (const c of e.childNodes) out += this.node(c);
    return out;
  }

  node(n) {
    if (n.nodeType === 3 || n.nodeType === 4) return escapeText(n.nodeValue);
    if (n.nodeType !== 1) return '';
    if (n.namespaceURI === W06) return this.word(n);
    if (KEPT[n.namespaceURI]) return `<${KEPT[n.namespaceURI]}:${n.localName}${[...n.attributes].filter((a) => !a.name.startsWith('xmlns')).map((a) => ` ${KEPT[a.namespaceURI] ? `${KEPT[a.namespaceURI]}:` : ''}${a.localName}="${escapeAttr(a.value)}"`).join('')}>${this.children(n)}</${KEPT[n.namespaceURI]}:${n.localName}>`;
    if (n.namespaceURI === OMML) { this.losses.add('Formulas, which Word 2003 XML cannot hold'); return ''; }
    return '';
  }

  /** A DrawingML picture as Word 2003's VML, its bytes inside the file. */
  picture(drawing) {
    const blip = drawing.getElementsByTagNameNS(NS.a, 'blip')[0];
    const target = this.rels.get(blip?.getAttributeNS(R, 'embed'))?.target;
    const bytes = target ? this.parts.get(`word/${target}`) : null;
    if (!bytes) { this.losses.add('Drawings and shapes, which GRT does not write to Word 2003 XML'); return ''; }
    const extent = drawing.getElementsByTagNameNS(NS.wp, 'extent')[0];
    const pt = (emu) => Math.round((Number(emu) / 12700) * 100) / 100;
    this.pictures += 1;
    const name = `wordml://${String(this.pictures).padStart(8, '0')}.${(/\.(\w+)$/.exec(target)?.[1] ?? 'png').toLowerCase()}`;
    return `<w:pict><w:binData w:name="${name}">${toBase64(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)}</w:binData>`
      + `<v:shape id="_x0000_i${1024 + this.pictures}" type="#_x0000_t75" style="width:${pt(extent?.getAttribute('cx') ?? 914400)}pt;height:${pt(extent?.getAttribute('cy') ?? 914400)}pt"><v:imagedata src="${name}" o:title=""/></v:shape></w:pict>`;
  }

  word(n) {
    const local = n.localName;
    switch (local) {
      case 'hyperlink': {
        const target = this.rels.get(n.getAttributeNS(R, 'id'))?.target;
        const anchor = n.getAttributeNS(W06, 'anchor');
        if (!target && !anchor) return this.children(n);
        return `<w:hlink${target ? ` w:dest="${escapeAttr(target)}"` : ''}${anchor ? ` w:bookmark="${escapeAttr(anchor)}"` : ''}>${this.children(n)}</w:hlink>`;
      }
      case 'numPr': {
        const ilvl = val(kidOf(n, W06, 'ilvl'), W06) ?? '0';
        const numId = val(kidOf(n, W06, 'numId'), W06);
        return numId && numId !== '0' ? `<w:listPr><w:ilvl w:val="${escapeAttr(ilvl)}"/><w:ilfo w:val="${escapeAttr(numId)}"/></w:listPr>` : '';
      }
      case 'footnoteReference': case 'endnoteReference': {
        const kind = local.replace('Reference', '');
        const note = this.notes[kind].get(n.getAttributeNS(W06, 'id'));
        return note ? `<w:${kind}>${this.children(note)}</w:${kind}>` : '';
      }
      case 'drawing': return this.picture(n);
      case 'headerReference': case 'footerReference': {
        const target = this.rels.get(n.getAttributeNS(R, 'id'))?.target;
        const part = target ? this.xml(`word/${target}`) : null;
        if (!part) return '';
        const kind = { default: 'odd', even: 'even', first: 'first' }[n.getAttributeNS(W06, 'type')] ?? 'odd';
        const tagName = local === 'headerReference' ? 'hdr' : 'ftr';
        return `<w:${tagName} w:type="${kind}">${this.children(part.documentElement)}</w:${tagName}>`;
      }
      case 'bookmarkStart': return `<aml:annotation aml:id="${escapeAttr(n.getAttributeNS(W06, 'id') ?? '0')}" w:type="Word.Bookmark.Start" w:name="${escapeAttr(n.getAttributeNS(W06, 'name') ?? '')}"/>`;
      case 'bookmarkEnd': return `<aml:annotation aml:id="${escapeAttr(n.getAttributeNS(W06, 'id') ?? '0')}" w:type="Word.Bookmark.End"/>`;
      case 'commentRangeStart': case 'commentRangeEnd': case 'commentReference': this.losses.add('Comments, which GRT does not write to Word 2003 XML'); return '';
      case 'ins': this.losses.add('Tracked changes, written as accepted'); return this.children(n);
      case 'del': case 'moveFrom': this.losses.add('Tracked changes, written as accepted'); return '';
      case 'sdt': return this.children(kidOf(n, W06, 'sdtContent') ?? n);
      case 'smartTag': case 'customXml': case 'moveTo': return this.children(n);
      case 'proofErr': case 'lastRenderedPageBreak': case 'docGrid': case 'tblLook': case 'rsid': case 'noProof': return '';
      default: {
        const name = ELEMENTS_OUT[local] ?? local;
        return `<w:${name}${this.attrs(n)}>${this.children(n)}</w:${name}>`;
      }
    }
  }

  lists() {
    const numbering = this.xml('word/numbering.xml')?.documentElement;
    if (!numbering) return '';
    const defs = kidsOf(numbering, W06, 'abstractNum').map((def) => {
      const levels = kidsOf(def, W06, 'lvl').map((lvl) => {
        let inner = '';
        for (const c of lvl.children) {
          if (c.namespaceURI !== W06) continue;
          if (c.localName === 'numFmt') inner += `<w:nfc w:val="${NFC_OUT[val(c, W06)] ?? 0}"/>`;
          else if (['start', 'lvlText', 'lvlJc', 'pPr', 'rPr', 'lvlRestart', 'isLgl', 'suff'].includes(c.localName)) inner += this.word(c);
        }
        return `<w:lvl w:ilvl="${escapeAttr(lvl.getAttributeNS(W06, 'ilvl') ?? '0')}">${inner}</w:lvl>`;
      }).join('');
      return `<w:listDef w:listDefId="${escapeAttr(def.getAttributeNS(W06, 'abstractNumId') ?? '0')}">${levels}</w:listDef>`;
    }).join('');
    const lists = kidsOf(numbering, W06, 'num').map((num) => `<w:list w:ilfo="${escapeAttr(num.getAttributeNS(W06, 'numId') ?? '0')}"><w:ilst w:val="${escapeAttr(val(kidOf(num, W06, 'abstractNumId'), W06) ?? '0')}"/></w:list>`).join('');
    return `<w:lists>${defs}${lists}</w:lists>`;
  }

  styles() {
    const styles = this.xml('word/styles.xml')?.documentElement;
    if (!styles) return '';
    const allowed = new Set(['name', 'aliases', 'basedOn', 'next', 'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr']);
    return `<w:styles>${kidsOf(styles, W06, 'style').map((style) => {
      const inner = [...style.children].filter((c) => c.namespaceURI === W06 && allowed.has(c.localName)).map((c) => this.word(c)).join('');
      return `<w:style${this.attrs(style)}>${inner}</w:style>`;
    }).join('')}</w:styles>`;
  }

  write() {
    const document = this.xml('word/document.xml')?.documentElement;
    const body = kidOf(document, W06, 'body');
    const content = this.children(body);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<?mso-application progid="Word.Document"?>\n'
      + `<w:wordDocument xmlns:w="${W03}" xmlns:wx="${WX}" xmlns:aml="${AML}"${DECLARE} xml:space="preserve">`
      + `${this.lists()}${this.styles()}<w:docPr><w:view w:val="print"/></w:docPr><w:body>${content}</w:body></w:wordDocument>\n`;
  }
}

/**
 * Paper's document as a Word 2003 XML file.
 * @returns {{text: string, losses: Losses}}
 */
export function writeWordml2003(document, images = new Map()) {
  const { entries, losses } = writeDocx(document, images);
  const parts = new Map(entries.map((e) => [e.name, e.data]));
  const text = new Writer2003(parts, losses).write();
  return { text, losses };
}
