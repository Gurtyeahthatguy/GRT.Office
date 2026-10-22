/** A Word document into the editor's document model. */

import { NS, kids, kid, attr, is, dig } from '../xml.js';
import { toMm } from '../units.js';
import { normaliseRuns, pageSizeFields } from '../editor/model.js';
import { Losses } from '../losses.js';
import { relationships, mainPart, readPart, relIs, EMU_PER_PX } from './ooxml.js';
import { fontKind, extensionOf, DRAWABLE } from './odf.js';

const W = NS.w;
const MARKS = ['bold', 'italic', 'underline', 'strike', 'sup', 'sub'];
const PAPER_STYLES = ['body', 'h1', 'h2', 'h3', 'h4', 'quote', 'code'];

const wAttr = (element, name) => attr(element, W, name);

/** A toggle property: present and not switched off. */
function toggle(element) {
  if (!element) return undefined;
  const value = wAttr(element, 'val');
  return value === null || !['0', 'false', 'off', 'none'].includes(value);
}

/**
 * @param {import('../package.js').Package} pkg
 * @returns {{document: object, images: Map<string, Uint8Array>, losses: Losses}}
 */
export function readDocx(pkg) {
  const main = mainPart(pkg);
  if (!main) throw new Error('This is not a Word document: it names no main part');
  const document = readPart(pkg, main, 'the document');
  if (!document || !is(document.documentElement, W, 'document')) {
    throw new Error('This is not a Word document');
  }
  return new WordReader(pkg, main, document).read();
}

class WordReader {
  constructor(pkg, main, document) {
    this.pkg = pkg;
    this.main = main;
    this.document = document;
    this.rels = relationships(pkg, main);
    this.losses = new Losses();
    if (pkg.damage) {
      this.losses.add('The file was damaged, and only what could still be read was opened');
    }
    this.blocks = [];
    this.images = new Map();
    this.notes = [];
    this.usage = new Map();
    this.theme = this.readTheme();
    this.readStyles();
    this.readNumbering();
    this.footnotes = this.readNotes('footnotes', 'footnote');
    this.endnotes = this.readNotes('endnotes', 'endnote');
  }

  part(type) {
    for (const rel of this.rels.values()) if (relIs(rel.type, type)) return rel.target;
    return null;
  }

  readTheme() {
    const doc = this.part('theme') ? readPart(this.pkg, this.part('theme')) : null;
    const font = (which) => dig(doc?.documentElement, [NS.a, 'themeElements'], [NS.a, 'fontScheme'], [NS.a, which], [NS.a, 'latin'])
      ?.getAttribute('typeface') ?? null;
    return { major: font('majorFont'), minor: font('minorFont') };
  }

  readStyles() {
    this.styles = new Map();
    this.defaultParagraph = null;
    this.defaults = { run: null, paragraph: null };
    const part = this.part('styles');
    const doc = part ? readPart(this.pkg, part) : null;
    const root = doc?.documentElement;
    const defaults = kid(root, W, 'docDefaults');
    this.defaults.run = dig(defaults, [W, 'rPrDefault'], [W, 'rPr']);
    this.defaults.paragraph = dig(defaults, [W, 'pPrDefault'], [W, 'pPr']);
    for (const style of kids(root, W, 'style')) {
      const id = wAttr(style, 'styleId');
      const entry = {
        id,
        type: wAttr(style, 'type'),
        name: wAttr(kid(style, W, 'name'), 'val') ?? id,
        basedOn: wAttr(kid(style, W, 'basedOn'), 'val'),
        pPr: kid(style, W, 'pPr'),
        rPr: kid(style, W, 'rPr'),
      };
      this.styles.set(id, entry);
      if (entry.type === 'paragraph' && ['1', 'true', 'on'].includes(wAttr(style, 'default'))) this.defaultParagraph = id;
    }
  }

  chain(id) {
    const out = [];
    const seen = new Set();
    let style = id ? this.styles.get(id) : null;
    while (style && !seen.has(style.id)) {
      seen.add(style.id);
      out.push(style);
      style = this.styles.get(style.basedOn);
    }
    return out;
  }

  readNumbering() {
    this.numbering = new Map();
    const part = this.part('numbering');
    const doc = part ? readPart(this.pkg, part) : null;
    const abstracts = new Map();
    for (const abstract of kids(doc?.documentElement, W, 'abstractNum')) {
      const levels = new Map();
      for (const level of kids(abstract, W, 'lvl')) {
        levels.set(Number(wAttr(level, 'ilvl')), wAttr(kid(level, W, 'numFmt'), 'val') ?? 'decimal');
      }
      abstracts.set(wAttr(abstract, 'abstractNumId'), levels);
    }
    for (const num of kids(doc?.documentElement, W, 'num')) {
      const levels = abstracts.get(wAttr(kid(num, W, 'abstractNumId'), 'val')) ?? new Map();
      this.numbering.set(wAttr(num, 'numId'), levels);
    }
  }

  readNotes(type, element) {
    const notes = new Map();
    const part = this.part(type);
    const doc = part ? readPart(this.pkg, part) : null;
    for (const note of kids(doc?.documentElement, W, element)) {
      const text = [...note.getElementsByTagNameNS(W, 'p')]
        .map((p) => [...p.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join(''))
        .join(' ').replace(/\s+/g, ' ').trim();
      notes.set(wAttr(note, 'id'), text);
    }
    return notes;
  }

  // Properties

  /** Run properties in the model's terms, from a list of rPr elements, farthest first. */
  look(rPrs) {
    const look = {};
    for (const rPr of rPrs) {
      if (!rPr) continue;
      const set = (name, element) => {
        const value = toggle(element);
        if (value !== undefined) look[name] = value;
      };
      set('bold', kid(rPr, W, 'b'));
      set('italic', kid(rPr, W, 'i'));
      set('strike', kid(rPr, W, 'strike') ?? kid(rPr, W, 'dstrike'));
      const underline = kid(rPr, W, 'u');
      if (underline) look.underline = !['none', '0', 'false'].includes(wAttr(underline, 'val') ?? 'single');
      const vertical = kid(rPr, W, 'vertAlign');
      if (vertical) {
        const value = wAttr(vertical, 'val');
        look.sup = value === 'superscript';
        look.sub = value === 'subscript';
      }
      const color = wAttr(kid(rPr, W, 'color'), 'val');
      if (color) look.color = color === 'auto' ? null : `#${color.toLowerCase()}`;
      const highlight = wAttr(kid(rPr, W, 'highlight'), 'val');
      if (highlight) look.highlight = HIGHLIGHTS[highlight] ?? null;
      const shade = wAttr(kid(rPr, W, 'shd'), 'fill');
      if (shade && shade !== 'auto') look.highlight = `#${shade.toLowerCase()}`;
      const size = wAttr(kid(rPr, W, 'sz'), 'val');
      if (size) look.size = Number(size) / 2;
      const fonts = kid(rPr, W, 'rFonts');
      if (fonts) {
        const theme = wAttr(fonts, 'asciiTheme');
        const named = wAttr(fonts, 'ascii') ?? wAttr(fonts, 'hAnsi');
        if (named) look.font = named;
        else if (theme) look.font = theme.startsWith('major') ? this.theme.major : this.theme.minor;
      }
    }
    return look;
  }

  /** rPr elements a paragraph style passes down, farthest first. */
  styleRuns(styleId) {
    return [this.defaults.run, ...this.chain(styleId).reverse().map((style) => style.rPr)];
  }

  /** A paragraph property, nearest first: direct, then the style chain, then the defaults. */
  paragraphProp(pPr, styleId, name) {
    const direct = kid(pPr, W, name);
    if (direct) return direct;
    for (const style of this.chain(styleId)) {
      const found = kid(style.pPr, W, name);
      if (found) return found;
    }
    return kid(this.defaults.paragraph, W, name);
  }

  classify(styleId) {
    for (const style of this.chain(styleId)) {
      const name = style.name.toLowerCase();
      const heading = /^heading\s*(\d)$/.exec(name) ?? /^Heading(\d)$/.exec(style.id);
      if (heading) return { kind: 'heading', level: Number(heading[1]) };
      if (name === 'title') return { kind: 'heading', level: 1 };
      if (name === 'subtitle') return { kind: 'heading', level: 2 };
      if (/^(quote|intense quote|block text)$/.test(name)) return { kind: 'quote' };
      if (/^(html preformatted|source code|code|preformatted text|plain text)$/.test(name)) return { kind: 'code' };
      if (name === 'caption') return { kind: 'caption' };
      const outline = wAttr(kid(style.pPr, W, 'outlineLvl'), 'val');
      if (outline !== null && Number(outline) < 9) return { kind: 'heading', level: Number(outline) + 1 };
    }
    return { kind: 'paragraph' };
  }

  // Body

  read() {
    // A document with several bodies is malformed, but Word shows them all.
    const bodies = kids(this.document.documentElement, W, 'body');
    for (const body of bodies) this.walk(body);
    const body = bodies[bodies.length - 1] ?? null;
    if (this.notes.length > 0) {
      this.blocks.push(paragraph('body', 'left', [{ text: '' }]));
      this.notes.forEach((text, i) => this.blocks.push(paragraph('body', 'left', [{ text: `[${i + 1}] ${text}` }])));
      this.losses.add('Footnotes and endnotes, moved to the end of the document', this.notes.length);
    }
    const blocks = mergeCode(this.blocks);
    if (blocks.length === 0) blocks.push(paragraph('body', 'left', []));
    return {
      document: { version: 1, type: 'paper', page: this.page(body), styles: this.paperStyles(), fonts: [], blocks },
      images: this.images,
      losses: this.losses,
    };
  }

  walk(parent) {
    for (const node of kids(parent)) {
      if (node.namespaceURI === W) {
        switch (node.localName) {
          case 'p': this.paragraph(node); continue;
          case 'tbl': this.table(node); continue;
          case 'sdt': this.walk(kid(node, W, 'sdtContent')); continue;
          case 'customXml': case 'smartTag': this.walk(node); continue;
          case 'ins': case 'moveTo':
            this.losses.add('Tracked changes, shown as if accepted');
            this.walk(node);
            continue;
          case 'del': case 'moveFrom':
            this.losses.add('Tracked changes, shown as if accepted');
            continue;
          case 'sectPr': case 'bookmarkStart': case 'bookmarkEnd': case 'proofErr':
          case 'permStart': case 'permEnd': case 'commentRangeStart': case 'commentRangeEnd':
            continue;
          default:
            break;
        }
      }
      if (is(node, NS.mc, 'AlternateContent')) {
        this.walk(kid(node, NS.mc, 'Choice') ?? kid(node, NS.mc, 'Fallback'));
        continue;
      }
      if (node.textContent.trim()) {
        this.losses.add('Parts of the document GRT does not know, kept as text');
        this.walk(node);
      }
    }
  }

  paragraph(p) {
    const pPr = kid(p, W, 'pPr');
    const styleId = wAttr(kid(pPr, W, 'pStyle'), 'val') ?? this.defaultParagraph;
    const { kind: classified, level: headingLevel } = this.classify(styleId);
    const last = this.blocks[this.blocks.length - 1];
    if (classified === 'caption' && last?.kind === 'image' && !last.caption.some((run) => run.text)) {
      const segments = this.inline(p, styleId, this.look(this.styleRuns(styleId)), 'left');
      last.caption = normaliseRuns(segments.flatMap((s) => s.runs ?? []).map((run) => ({ text: run.text })));
      // A page break written at the end of the caption starts the next block's page.
      if (segments.some((segment) => segment.pageBreak)) this.pendingBreak = true;
      return;
    }
    const kind = classified === 'caption' ? 'paragraph' : classified;
    const numPr = this.paragraphProp(pPr, styleId, 'numPr');
    const numId = wAttr(kid(numPr, W, 'numId'), 'val');
    const listed = numId && numId !== '0' && this.numbering.has(numId);

    let style = 'body';
    let level = headingLevel ?? 1;
    if (kind === 'heading' && listed) this.losses.add('Numbered headings, their numbers dropped');
    if (kind === 'heading') {
      if (level > 4) this.losses.add('Headings deeper than level 4, made level 4');
      level = Math.max(1, Math.min(level, 4));
      style = `h${level}`;
    } else if (kind === 'quote') style = 'quote';
    else if (kind === 'code') style = 'code';

    const counts = this.usage.get(style) ?? new Map();
    counts.set(styleId, (counts.get(styleId) ?? 0) + 1);
    this.usage.set(style, counts);

    const baseline = this.look(this.styleRuns(styleId));
    const align = alignment(wAttr(this.paragraphProp(pPr, styleId, 'jc'), 'val'));
    const breakBefore = toggle(this.paragraphProp(pPr, styleId, 'pageBreakBefore')) === true;
    const segments = this.inline(p, styleId, baseline, align);
    if (kid(pPr, W, 'sectPr') && kids(p).length > 1) this.sectionBreak = true;

    segments.forEach((segment, index) => {
      if (segment.image || segment.block) {
        this.currentList = null;
        const block = segment.image ?? segment.block;
        if (this.pendingBreak || (index === 0 && breakBefore)) block.breakBefore = true;
        this.pendingBreak = false;
        this.blocks.push(block);
        return;
      }
      if (segment.pageBreak) {
        this.pendingBreak = true;
        return;
      }
      const runs = normaliseRuns(segment.runs);
      const empty = runs.length === 1 && runs[0].text === '';
      if (empty && segments.length > 1) return;

      if (listed && kind !== 'heading') {
        const ilvl = Number(wAttr(kid(numPr, W, 'ilvl'), 'val') ?? 0);
        const format = this.numbering.get(numId).get(ilvl) ?? this.numbering.get(numId).get(0) ?? 'bullet';
        const listType = format === 'bullet' || format === 'none' ? 'bullet' : 'number';
        const continues = this.currentList && (ilvl > 0 || this.currentList.numId === numId);
        if (!continues || this.pendingBreak || (index === 0 && breakBefore)) {
          this.currentList = { kind: 'list', style: 'body', align, listType, items: [], numId };
          if (this.pendingBreak || (index === 0 && breakBefore)) this.currentList.breakBefore = true;
          this.pendingBreak = false;
          this.blocks.push(this.currentList);
        } else if (listType !== this.currentList.listType) {
          this.losses.add('Lists mixing bullets and numbers, shown with one kind');
        }
        if (ilvl > 5) this.losses.add('Lists nested deeper than six levels, flattened');
        this.currentList.items.push({ level: Math.min(ilvl, 5), runs });
        return;
      }

      this.currentList = null;
      const block = kind === 'heading'
        ? { kind: 'heading', level, style, align, runs }
        : { kind, style, align, runs };
      if ((index === 0 && breakBefore) || this.pendingBreak) block.breakBefore = true;
      this.pendingBreak = false;
      this.blocks.push(block);
    });

    // A paragraph ending a section starts the next one on a new page.
    if (kid(pPr, W, 'sectPr')) {
      const type = wAttr(kid(kid(pPr, W, 'sectPr'), W, 'type'), 'val') ?? 'nextPage';
      if (type !== 'continuous') this.pendingBreak = true;
      this.losses.add('Sections with a page setup of their own, set up like the last one');
    }
  }

  inline(p, styleId, baseline, align) {
    const segments = [{ runs: [] }];
    const current = () => segments[segments.length - 1];
    const field = { depth: 0, showing: [] };

    const emit = (text, look) => {
      if (field.depth > 0 && !field.showing[field.depth - 1]) return;
      const run = { text };
      for (const mark of MARKS) if (look[mark] && !baseline[mark]) run[mark] = true;
      if (look.color && look.color !== baseline.color && look.color !== '#000000') run.color = look.color;
      if (look.highlight && look.highlight !== baseline.highlight) run.highlight = look.highlight;
      if (look.size && baseline.size && Math.abs(look.size - baseline.size) > 0.1) run.size = look.size;
      if (look.font && baseline.font && look.font !== baseline.font && fontKind(look.font) !== fontKind(baseline.font)) {
        this.losses.add('Fonts that differ from the paragraph’s, shown in its font');
      }
      current().runs.push(run);
    };

    const runElement = (r) => {
      const rPr = kid(r, W, 'rPr');
      const runStyle = wAttr(kid(rPr, W, 'rStyle'), 'val');
      const runStyles = this.chain(runStyle).reverse().map((style) => style.rPr);
      const look = this.look([...this.styleRuns(styleId), ...runStyles, rPr]);
      for (const child of kids(r)) {
        if (child.namespaceURI === W) {
          switch (child.localName) {
            case 't': emit(child.textContent, look); continue;
            case 'tab': case 'ptab': emit('\t', look); continue;
            case 'noBreakHyphen': emit('‑', look); continue;
            case 'softHyphen': emit('­', look); continue;
            case 'sym': emit(String.fromCodePoint(parseInt(wAttr(child, 'char') ?? '20', 16) & 0xFFFF), look); continue;
            case 'br': case 'cr': {
              const type = wAttr(child, 'type');
              if (type === 'page') segments.push({ pageBreak: true }, { runs: [] });
              else if (type !== 'column') {
                this.losses.add('Line breaks inside a paragraph, made into new paragraphs');
                segments.push({ runs: [] });
              }
              continue;
            }
            case 'fldChar': {
              const type = wAttr(child, 'fldCharType');
              if (type === 'begin') {
                field.depth += 1;
                field.showing.push(false);
              } else if (type === 'separate' && field.depth > 0) {
                field.showing[field.depth - 1] = true;
              } else if (type === 'end' && field.depth > 0) {
                field.depth -= 1;
                field.showing.pop();
                this.losses.add('Fields, kept as the text they showed');
              }
              continue;
            }
            case 'instrText': case 'delText': case 'delInstrText': case 'rPr':
            case 'lastRenderedPageBreak': case 'annotationRef': case 'commentReference':
              continue;
            case 'footnoteReference': case 'endnoteReference': {
              const notes = child.localName === 'footnoteReference' ? this.footnotes : this.endnotes;
              this.notes.push(notes.get(wAttr(child, 'id')) ?? '');
              emit(`[${this.notes.length}]`, { ...look, sup: true });
              continue;
            }
            case 'drawing': case 'pict': case 'object':
              this.drawing(child, segments, align);
              continue;
            case 'ruby':
              this.losses.add('Reading guides above characters (ruby), kept as the base text');
              walk(kid(child, W, 'rubyBase'));
              continue;
            default:
              continue;
          }
        }
        if (is(child, NS.mc, 'AlternateContent')) {
          const choice = kid(child, NS.mc, 'Choice') ?? kid(child, NS.mc, 'Fallback');
          for (const inner of kids(choice)) {
            if (inner.namespaceURI === W && ['drawing', 'pict'].includes(inner.localName)) this.drawing(inner, segments, align);
          }
        }
      }
    };

    const walk = (parent) => {
      for (const child of kids(parent)) {
        if (child.namespaceURI === W) {
          switch (child.localName) {
            case 'r': runElement(child); continue;
            case 'hyperlink':
              this.losses.add('Links, kept as their text');
              walk(child);
              continue;
            case 'fldSimple':
              this.losses.add('Fields, kept as the text they showed');
              walk(child);
              continue;
            case 'ins': case 'moveTo':
              this.losses.add('Tracked changes, shown as if accepted');
              walk(child);
              continue;
            case 'del': case 'moveFrom':
              this.losses.add('Tracked changes, shown as if accepted');
              continue;
            case 'smartTag': case 'customXml': case 'dir': case 'bdo':
              walk(child);
              continue;
            case 'sdt':
              walk(kid(child, W, 'sdtContent'));
              continue;
            default:
              continue;
          }
        }
        if (is(child, NS.mc, 'AlternateContent')) walk(kid(child, NS.mc, 'Choice') ?? kid(child, NS.mc, 'Fallback'));
      }
    };
    walk(p);
    return segments;
  }

  drawing(element, segments, align) {
    const textBox = [...element.getElementsByTagName('*')].find((node) => node.localName === 'txbxContent');
    // A text box holding one picture and some text is a captioned picture.
    if (textBox && textBox.getElementsByTagNameNS(NS.a, 'blip').length === 1) {
      const inner = textBox.getElementsByTagNameNS(W, 'drawing')[0];
      const caption = [...textBox.getElementsByTagNameNS(W, 't')].map((node) => node.textContent).join('').replace(/\s+/g, ' ').trim();
      const before = segments.length;
      this.drawing(inner, segments, align);
      const added = segments.slice(before).find((segment) => segment.image);
      if (added && caption) added.image.caption = [{ text: caption }];
      return;
    }
    const blip = textBox ? null : element.getElementsByTagNameNS(NS.a, 'blip')[0];
    const imageData = textBox ? null : [...element.getElementsByTagName('*')].find((node) => node.localName === 'imagedata');
    const id = blip?.getAttributeNS(NS.r, 'embed') ?? imageData?.getAttributeNS(NS.r, 'id') ?? null;

    if (!id) {
      if (textBox) {
        this.losses.add('Text boxes, their text kept as paragraphs');
        const saved = this.blocks;
        this.blocks = [];
        this.walk(textBox);
        const found = this.blocks;
        this.blocks = saved;
        for (const block of found) segments.push({ block });
        segments.push({ runs: [] });
      } else if (element.localName === 'object') {
        this.losses.add('Charts, formulas and other embedded objects');
      } else {
        this.losses.add('Drawings and shapes');
      }
      return;
    }

    const rel = this.rels.get(id);
    if (!rel || rel.external) {
      this.losses.add('Pictures linked from outside the file');
      return;
    }
    const ext = extensionOf(rel.target);
    if (!DRAWABLE.has(ext)) {
      this.losses.add('Pictures in a format the program cannot show, such as WMF or EMF');
      return;
    }
    const bytes = this.pkg.bytes(rel.target);
    if (!bytes) {
      this.losses.add('Pictures whose file was missing');
      return;
    }
    let resource = this.resourceFor(rel.target);
    if (!this.images.has(resource)) this.images.set(resource, bytes);
    else if (this.images.get(resource) !== bytes) resource = this.uniqueResource(rel.target, bytes);

    const extent = element.getElementsByTagNameNS(NS.wp, 'extent')[0];
    const width = extent ? Number(extent.getAttribute('cx')) / EMU_PER_PX : 400;
    const height = extent ? Number(extent.getAttribute('cy')) / EMU_PER_PX : 260;
    if (element.getElementsByTagNameNS(NS.wp, 'anchor').length > 0) {
      this.losses.add('Pictures placed freely on the page, put in line with the text');
    }
    segments.push({
      image: {
        kind: 'image', style: 'body', resource,
        w: Math.max(1, Math.round(width)), h: Math.max(1, Math.round(height)),
        align: align === 'justify' ? 'left' : align, caption: [],
      },
    }, { runs: [] });
  }

  resourceFor(target) {
    return `resources/${target.split('/').pop().replace(/[^\w.-]+/g, '_')}`;
  }

  uniqueResource(target, bytes) {
    const base = this.resourceFor(target);
    let n = 2;
    let candidate = base.replace(/(\.[^.]*)?$/, `-${n}$1`);
    while (this.images.has(candidate)) {
      n += 1;
      candidate = base.replace(/(\.[^.]*)?$/, `-${n}$1`);
    }
    this.images.set(candidate, bytes);
    return candidate;
  }

  table(tbl) {
    this.currentList = null;
    this.losses.add('Tables, kept as text with a tab between cells');
    for (const row of wrapped(tbl, 'tr')) {
      const cells = wrapped(row, 'tc').map((cell) => [...cell.getElementsByTagNameNS(W, 'p')]
        .map((p) => [...p.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('').trim())
        .filter(Boolean).join(' '));
      this.blocks.push(paragraph('body', 'left', [{ text: cells.join('\t') }]));
    }
  }

  // Page

  page(body) {
    const sections = [...body.getElementsByTagNameNS(W, 'sectPr')];
    const section = kid(body, W, 'sectPr') ?? sections[sections.length - 1] ?? null;
    const size = kid(section, W, 'pgSz');
    const margins = kid(section, W, 'pgMar');
    const twip = (element, name, fallback) => {
      const value = wAttr(element, name);
      return value === null ? fallback : toMm(Number(value), 'twip');
    };
    const width = twip(size, 'w', 210);
    const height = twip(size, 'h', 297);
    const landscape = wAttr(size, 'orient') === 'landscape' || width > height;
    const clamp = (mm) => Math.max(5, Math.min(60, Math.round(mm * 10) / 10));

    const settings = this.part('settings') ? readPart(this.pkg, this.part('settings')) : null;
    const evenDifferent = toggle(kid(settings?.documentElement, W, 'evenAndOddHeaders')) === true;
    const firstDifferent = toggle(kid(section, W, 'titlePg')) === true;
    const running = {
      firstDifferent,
      evenDifferent,
      header: { default: null, first: null, even: null },
      footer: { default: null, first: null, even: null },
    };
    for (const part of ['header', 'footer']) {
      for (const reference of kids(section, W, `${part}Reference`)) {
        const type = wAttr(reference, 'type') ?? 'default';
        const rel = this.rels.get(reference.getAttributeNS(NS.r, 'id'));
        if (!rel) continue;
        running[part][type === 'even' ? 'even' : type === 'first' ? 'first' : 'default'] = this.band(rel.target);
      }
    }

    return {
      ...pageSizeFields(width, height),
      orientation: landscape ? 'landscape' : 'portrait',
      margins: {
        top: clamp(Math.abs(twip(margins, 'top', 25))),
        bottom: clamp(Math.abs(twip(margins, 'bottom', 25))),
        left: clamp(twip(margins, 'left', 25)),
        right: clamp(twip(margins, 'right', 25)),
      },
      running,
    };
  }

  /** A header or footer part as one slot of text. */
  band(part) {
    const doc = readPart(this.pkg, part);
    if (!doc) return null;
    const paragraphs = [...doc.documentElement.getElementsByTagNameNS(W, 'p')];
    if (doc.documentElement.getElementsByTagNameNS(W, 'tbl').length > 0) {
      this.losses.add('Headers and footers laid out as tables, kept as one line');
    }
    const lines = paragraphs.map((p) => bandText(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (lines.length === 0) return null;
    if (lines.length > 1) this.losses.add('Headers and footers of several lines, joined into one');
    const pPr = kid(paragraphs[0], W, 'pPr');
    const styleId = wAttr(kid(pPr, W, 'pStyle'), 'val') ?? this.defaultParagraph;
    const align = alignment(wAttr(this.paragraphProp(pPr, styleId, 'jc'), 'val'));
    return { text: lines.join(' '), align: align === 'justify' ? 'left' : align };
  }

  paperStyles() {
    const out = {};
    const wellKnown = {
      body: [this.defaultParagraph, 'Normal'],
      h1: ['Heading1', 'Title'],
      h2: ['Heading2', 'Subtitle'],
      h3: ['Heading3'],
      h4: ['Heading4'],
      quote: ['Quote'],
      code: ['HTMLPreformatted'],
    };
    for (const name of PAPER_STYLES) {
      const used = [...(this.usage.get(name) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0];
      const source = used ?? wellKnown[name].find((id) => id && this.styles.has(id));
      if (!source) continue;
      const look = this.look(this.styleRuns(source));
      const spacing = this.paragraphProp(null, source, 'spacing');
      const indent = this.paragraphProp(null, source, 'ind');
      const pt = (element, name) => {
        const value = wAttr(element, name);
        return value === null ? 0 : Math.round((Number(value) / 20) * 10) / 10;
      };
      const line = wAttr(spacing, 'line');
      const rule = wAttr(spacing, 'lineRule') ?? 'auto';
      const style = {
        font: fontKind(look.font),
        size: look.size ?? 10,
        bold: !!look.bold,
        italic: !!look.italic,
        lineHeight: line && rule === 'auto' ? Math.round((Number(line) / 240) * 1.15 * 100) / 100 : 1.15,
        spaceBefore: pt(spacing, 'before'),
        spaceAfter: pt(spacing, 'after'),
      };
      const left = pt(indent, 'left') || pt(indent, 'start');
      if (left > 0) style.indent = left;
      if (look.color && look.color !== '#000000') style.color = look.color;
      out[name] = style;
    }
    return out;
  }
}

/** Children of a kind, looking through the content controls Word wraps them in. */
function wrapped(parent, local) {
  const out = [];
  for (const child of kids(parent)) {
    if (is(child, W, local)) out.push(child);
    else if (is(child, W, 'sdt')) out.push(...wrapped(kid(child, W, 'sdtContent'), local));
    else if (is(child, W, 'customXml')) out.push(...wrapped(child, local));
  }
  return out;
}

const HIGHLIGHTS = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

function paragraph(style, align, runs) {
  return { kind: 'paragraph', style, align, runs: normaliseRuns(runs) };
}

function mergeCode(blocks) {
  const out = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.kind === 'code' && last?.kind === 'code' && !block.breakBefore) {
      last.runs = normaliseRuns([...last.runs, { text: '\n' }, ...block.runs]);
      continue;
    }
    if (block.kind === 'list') delete block.numId;
    out.push(block);
  }
  return out;
}

function alignment(value) {
  switch (value) {
    case 'center': return 'center';
    case 'right': case 'end': return 'right';
    case 'both': case 'distribute': case 'justify': return 'justify';
    default: return 'left';
  }
}


/** A header paragraph's text, PAGE and NUMPAGES fields as `{page}` and `{pages}`. */
function bandText(p) {
  let out = '';
  let instruction = null;
  let showing = true;
  const fieldToken = (instr) => {
    const name = String(instr).trim().split(/\s+/)[0]?.toUpperCase();
    if (name === 'PAGE') return '{page}';
    if (name === 'NUMPAGES' || name === 'SECTIONPAGES') return '{pages}';
    return null;
  };
  const visit = (element) => {
    for (const child of kids(element)) {
      if (child.namespaceURI !== W) {
        if (is(child, NS.mc, 'AlternateContent')) visit(kid(child, NS.mc, 'Choice') ?? kid(child, NS.mc, 'Fallback'));
        continue;
      }
      switch (child.localName) {
        case 'fldSimple': {
          const token = fieldToken(wAttr(child, 'instr'));
          if (token) out += token;
          else visit(child);
          break;
        }
        case 'fldChar': {
          const type = wAttr(child, 'fldCharType');
          if (type === 'begin') {
            instruction = '';
            showing = false;
          } else if (type === 'separate') {
            const token = fieldToken(instruction);
            if (token) out += token;
            showing = !token;
          } else if (type === 'end') {
            instruction = null;
            showing = true;
          }
          break;
        }
        case 'instrText':
          if (instruction !== null) instruction += child.textContent;
          break;
        case 't':
          if (showing) out += child.textContent;
          break;
        case 'tab': case 'ptab':
          if (showing) out += ' ';
          break;
        case 'pPr': case 'rPr':
          break;
        default:
          visit(child);
      }
    }
  };
  visit(p);
  return out;
}
