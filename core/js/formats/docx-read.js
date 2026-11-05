/** A Word document into the editor's document model. */

import { NS, kids, kid, attr, is, dig } from '../xml.js';
import { toMm } from '../units.js';
import { normaliseRuns, pageSizeFields, normaliseTable, TABLE_LIMITS, OBJECT, styleKey, BULLETS, normalisePara } from '../editor/model.js';

/** Bullets written in the Symbol or Wingdings fonts, as Office and LibreOffice write them, as the characters they show. */
const SYMBOL_BULLETS = { '\uF0B7': '•', '\uF02D': '–', '\uF0A7': '▪', '\uF06F': '◦', '\uF0FC': '✓', '\uF0D8': '➢', o: '◦', '-': '–' };

/** Word's built-in paragraph styles and Paper's own; any other paragraph style is one of the person's. */
const KNOWN_WORD = /^(normal|heading \d|title|subtitle|quote|intense quote|block text|html preformatted|source code|code|preformatted text|plain text|caption|list paragraph|footnote text|endnote text|toc \d|toc heading|header|footer|index \d|index heading|no spacing|body text.*|default paragraph font|table grid|table paragraph|horizontal line)$/i;
import { makeId } from '../editor/ids.js';
import { runListsOf } from '../editor/fields.js';
import { readOoxmlChartPart, C as CHART } from './chart-object.js';
import { readOmml, OMML } from './math-ml.js';

/** A Word field's instruction as one of Paper's objects, or null for a field kept as the text it shows. */
function fieldObject(instr) {
  const text = String(instr ?? '').trim();
  const [name = '', ...rest] = text.split(/\s+/);
  const quoted = /"([^"]*)"/.exec(text)?.[1];
  switch (name.toUpperCase()) {
    case 'PAGE': return { type: 'field', field: 'page' };
    case 'NUMPAGES': case 'SECTIONPAGES': return { type: 'field', field: 'pages' };
    case 'DATE': return { type: 'field', field: 'date' };
    case 'TIME': return { type: 'field', field: 'time' };
    case 'SEQ': return rest[0] ? { type: 'seq', name: rest[0].replace(/_/g, ' ') } : null;
    case 'REF': return rest[0] ? { type: 'ref', target: rest[0], show: 'number' } : null;
    case 'PAGEREF': return rest[0] ? { type: 'ref', target: rest[0], show: 'page' } : null;
    case 'XE': {
      if (!quoted) return null;
      const [term, sub] = quoted.split(':');
      return { type: 'index', term: term.trim(), ...(sub ? { sub: sub.trim() } : {}) };
    }
    default: return null;
  }
}
import { Losses } from '../losses.js';
import { relationships, mainPart, readPart, relIs, EMU_PER_PX } from './ooxml.js';
import { fontKind, extensionOf, DRAWABLE } from './odf.js';
import { declareExternal } from './external.js';

const W = NS.w;
const MARKS = ['bold', 'italic', 'underline', 'strike', 'sup', 'sub'];
const PAPER_STYLES = ['body', 'h1', 'h2', 'h3', 'h4', 'quote', 'code', 'title', 'subtitle', 'hr'];

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
    declareExternal(pkg, this.losses);
    this.blocks = [];
    this.images = new Map();
    this.notes = [];
    this.usage = new Map();
    this.theme = this.readTheme();
    this.readStyles();
    this.readNumbering();
    this.headingMarks = new Map();
    this.sectionStart = 0;
    this.customStyles = new Map();
    this.customChars = new Map();
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
      levels.texts = new Map();
      for (const level of kids(abstract, W, 'lvl')) {
        levels.set(Number(wAttr(level, 'ilvl')), wAttr(kid(level, W, 'numFmt'), 'val') ?? 'decimal');
        levels.texts.set(Number(wAttr(level, 'ilvl')), wAttr(kid(level, W, 'lvlText'), 'val') ?? '');
      if (Number(wAttr(level, 'ilvl')) === 0) levels.text = wAttr(kid(level, W, 'lvlText'), 'val');
      }
      abstracts.set(wAttr(abstract, 'abstractNumId'), levels);
    }
    this.listAbstract = new Map();
    for (const num of kids(doc?.documentElement, W, 'num')) {
      const abstract = wAttr(kid(num, W, 'abstractNumId'), 'val');
      const levels = abstracts.get(abstract) ?? new Map();
      this.numbering.set(wAttr(num, 'numId'), levels);
      // Numbering instances of the same definition continue one list unless one starts it again.
      const restarts = kids(num, W, 'lvlOverride').some((o) => kid(o, W, 'startOverride'));
      this.listAbstract.set(wAttr(num, 'numId'), { abstract, restarts });
    }
  }

  /** How footnotes and endnotes count, from the document's settings. */
  noteSettings(section) {
    const settings = this.part('settings') ? readPart(this.pkg, this.part('settings')) : null;
    const one = (name) => {
      const pr = kid(section, W, name) ?? kid(settings?.documentElement, W, name);
      if (!pr) return undefined;
      return { format: FROM_WORD_NUMBER[wAttr(kid(pr, W, 'numFmt'), 'val')], start: Number(wAttr(kid(pr, W, 'numStart'), 'val') ?? 1) };
    };
    return { foot: one('footnotePr'), end: one('endnotePr') };
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
      if (name === 'title') return { kind: 'paragraph', plain: 'title' };
      if (name === 'subtitle') return { kind: 'paragraph', plain: 'subtitle' };
      if (name === 'horizontal line') return { kind: 'paragraph', plain: 'hr' };
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
    if (kid(body, W, 'sectPr')) this.endSection(kid(body, W, 'sectPr'));
    // References to headings point at the heading's block, now that it has one.
    for (const block of this.blocks) {
      for (const { runs } of runListsOf(block)) {
        for (const run of runs) {
          if (run.object?.type === 'ref' && this.headingMarks.has(run.object.target)) run.object.target = `heading:${this.headingMarks.get(run.object.target)}`;
        }
      }
    }
    if (this.notes.length > 0) {
      this.blocks.push(paragraph('body', 'left', [{ text: '' }]));
      this.notes.forEach((text, i) => this.blocks.push(paragraph('body', 'left', [{ text: `[${i + 1}] ${text}` }])));
      this.losses.add('Footnotes and endnotes, moved to the end of the document', this.notes.length);
    }
    const blocks = mergeCode(this.blocks);
    if (blocks.length === 0) blocks.push(paragraph('body', 'left', []));
    return {
      document: {
        version: 1, type: 'paper', page: this.page(body), styles: this.paperStyles(), charStyles: this.charStyles(), fonts: [], blocks,
        headingNumbers: this.headingNumbers ?? null, noteSettings: this.noteSettings(kid(body, W, 'sectPr')),
      },
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
          case 'sdt': {
            const gallery = wAttr(dig(node, [W, 'sdtPr'], [W, 'docPartObj'], [W, 'docPartGallery']), 'val');
            if (gallery === 'Table of Contents') {
              this.contents(kid(node, W, 'sdtContent'));
              continue;
            }
            this.walk(kid(node, W, 'sdtContent'));
            continue;
          }
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
    // A paragraph there only to end a section with a continuous break is not text.
    const sectPr = kid(pPr, W, 'sectPr');
    if (sectPr && kids(p).every((child) => is(child, W, 'pPr')) && (wAttr(kid(sectPr, W, 'type'), 'val') === 'continuous')) {
      this.endSection(sectPr);
      return;
    }
    const styleId = wAttr(kid(pPr, W, 'pStyle'), 'val') ?? this.defaultParagraph;
    const { kind: classified, level: headingLevel, plain } = this.classify(styleId);
    const last = this.blocks[this.blocks.length - 1];
    if (classified === 'caption' && last?.kind === 'image' && !last.caption.some((run) => run.text)) {
      const segments = this.inline(p, styleId, this.look(this.styleRuns(styleId)), 'left');
      last.caption = normaliseRuns(segments.flatMap((s) => s.runs ?? []).map((run) => (run.object ? { text: run.text, object: run.object } : { text: run.text })));
      // A page break written at the end of the caption starts the next block's page.
      if (segments.some((segment) => segment.pageBreak)) this.pendingBreak = true;
      return;
    }
    // A paragraph holding an index field is where the index goes.
    if ([...p.getElementsByTagNameNS(W, 'instrText')].some((t) => /^\s*INDEX\b/i.test(t.textContent))) {
      this.blocks.push({ kind: 'index', style: 'body', align: 'left', title: 'Index' });
      return;
    }
    const kind = classified === 'caption' ? 'paragraph' : classified;
    const numPr = this.paragraphProp(pPr, styleId, 'numPr');
    const numId = wAttr(kid(numPr, W, 'numId'), 'val');
    const listed = numId && numId !== '0' && this.numbering.has(numId);

    let style = 'body';
    let level = headingLevel ?? 1;
    if (kind === 'heading' && listed) {
      this.headingNumbers ??= headingNumbersFrom(this.numbering.get(numId));
      if (!this.headingNumbers) this.losses.add('Numbered headings, their numbers dropped');
    }
    if (kind === 'heading') {
      if (level > 4) this.losses.add('Headings deeper than level 4, made level 4');
      level = Math.max(1, Math.min(level, 4));
      style = `h${level}`;
    } else if (kind === 'quote') style = 'quote';
    else if (kind === 'code') style = 'code';
    else if (plain) style = plain;

    const counts = this.usage.get(style) ?? new Map();
    counts.set(styleId, (counts.get(styleId) ?? 0) + 1);
    this.usage.set(style, counts);

    const baseline = this.look(this.styleRuns(styleId));
    const align = alignment(wAttr(this.paragraphProp(pPr, styleId, 'jc'), 'val'));
    const breakBefore = toggle(this.paragraphProp(pPr, styleId, 'pageBreakBefore')) === true;
    // Only what differs from the paragraph's style is its own; LibreOffice repeats the style's values.
    const para = withoutSame(directPara(kid(pPr, W, 'spacing'), kid(pPr, W, 'ind')),
      directPara(this.paragraphProp(null, styleId, 'spacing'), this.paragraphProp(null, styleId, 'ind')));
    const marks = [];
    const segments = this.inline(p, styleId, baseline, align, marks);
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
        const same = this.listAbstract.get(numId);
        const continues = this.currentList && (ilvl > 0 || this.currentList.numId === numId
          || (same && this.listAbstract.get(this.currentList.numId)?.abstract === same.abstract && !same.restarts));
        if (!continues || this.pendingBreak || (index === 0 && breakBefore)) {
          this.currentList = { kind: 'list', style: 'body', align, listType, items: [], numId };
          // How the list counts, or the bullet it shows, when it is not the plain one.
          const levels = this.numbering.get(numId);
          const counted = { lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman' }[levels.get(0)];
          if (listType === 'number' && counted) this.currentList.format = counted;
          const bullet = SYMBOL_BULLETS[levels.text] ?? levels.text;
          if (listType === 'bullet' && BULLETS.includes(bullet) && bullet !== '•') this.currentList.bullet = bullet;
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
        : { kind, style: classified === 'caption' ? 'caption' : (kind === 'paragraph' ? this.customStyle(styleId) : null) ?? style, align, runs };
      if (para) block.para = para;
      if (index === 0 && marks.length) {
        block.id = makeId('b');
        for (const name of marks) this.headingMarks.set(name, block.id);
      }
      if ((index === 0 && breakBefore) || this.pendingBreak) block.breakBefore = true;
      this.pendingBreak = false;
      this.blocks.push(block);
    });

    // A paragraph ending a section starts the next one on a new page.
    if (kid(pPr, W, 'sectPr')) {
      const type = wAttr(kid(kid(pPr, W, 'sectPr'), W, 'type'), 'val') ?? 'nextPage';
      if (type !== 'continuous') {
        this.pendingBreak = true;
        this.losses.add('Sections with a page setup of their own, set up like the last one');
      }
      this.endSection(kid(pPr, W, 'sectPr'));
    }
  }

  /** A section ends here: when it had several columns, marks go where it started and here. */
  endSection(sectPr) {
    const columns = Math.max(1, Math.min(4, Number(wAttr(kid(sectPr, W, 'cols'), 'num') ?? 1)));
    if (columns > 1 && this.blocks.length > this.sectionStart) {
      this.blocks.splice(this.sectionStart, 0, { kind: 'section', style: 'body', align: 'left', columns });
      this.blocks.push({ kind: 'section', style: 'body', align: 'left', columns: 1 });
    }
    this.currentList = null;
    this.sectionStart = this.blocks.length;
  }

  inline(p, styleId, baseline, align, marks = []) {
    const segments = [{ runs: [] }];
    const current = () => segments[segments.length - 1];
    // Fields as they open and close: their instruction, and whether the text they show is kept.
    const fields = [];
    const state = { link: null, mark: null };

    const emit = (text, look, object = null) => {
      if (fields.length > 0 && !fields[fields.length - 1].showing) return;
      const run = { text };
      if (object) run.object = object;
      if (state.link) run.link = state.link;
      if (state.cstyle) run.cstyle = state.cstyle;
      if (!object) state.mark = null;
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
      // A character style of the person's own is kept by name; Word's own ones, such as links and note marks, by their look.
      const own = runStyle ? this.customChar(runStyle) : null;
      const runStyles = own ? [] : this.chain(runStyle).reverse().map((style) => style.rPr);
      const look = this.look([...this.styleRuns(styleId), ...runStyles, rPr]);
      state.cstyle = own;
      for (const child of kids(r)) {
        if (child.namespaceURI === W) {
          switch (child.localName) {
            case 't': {
              if (state.markFor) {
                const note = state.markFor;
                state.markFor = null;
                note.mark = child.textContent.trim();
                // The note's own text starts with its mark, which LibreOffice writes twice.
                let rest = note.runs[0].text;
                while (note.mark && rest.startsWith(note.mark)) rest = rest.slice(note.mark.length).trimStart();
                note.runs = [{ text: rest }];
                continue;
              }
              emit(child.textContent, look);
              continue;
            }
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
                fields.push({ instr: '', showing: false, object: null, parsed: false });
              } else if (type === 'separate' && fields.length > 0) {
                const top = fields[fields.length - 1];
                top.object = fieldObject(top.instr);
                top.parsed = true;
                top.showing = !top.object;
              } else if (type === 'end' && fields.length > 0) {
                const top = fields.pop();
                const object = top.parsed ? top.object : fieldObject(top.instr);
                if (object) this.fieldResult(object, state, marks, emit, look);
                else if (!/^\s*(TOC|INDEX)\b/i.test(top.instr)) this.losses.add('Fields, kept as the text they showed');
              }
              continue;
            }
            case 'instrText':
              if (fields.length > 0) fields[fields.length - 1].instr += child.textContent;
              continue;
            case 'delText': case 'delInstrText': case 'rPr':
            case 'lastRenderedPageBreak': case 'annotationRef': case 'commentReference':
              continue;
            case 'footnoteReference': case 'endnoteReference': {
              const foot = child.localName === 'footnoteReference';
              const text = (foot ? this.footnotes : this.endnotes).get(wAttr(child, 'id')) ?? '';
              const note = { type: 'note', kind: foot ? 'foot' : 'end', runs: [{ text }] };
              // A note shown by a character of its own has that character in the next text.
              if (['1', 'true', 'on'].includes(wAttr(child, 'customMarkFollows'))) state.markFor = note;
              emit(OBJECT, look, note);
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
        if (child.namespaceURI === OMML && (child.localName === 'oMath' || child.localName === 'oMathPara')) {
          const formula = readOmml(child);
          if (formula) emit(OBJECT, this.look(this.styleRuns(styleId)), formula);
          continue;
        }
        if (child.namespaceURI === W) {
          switch (child.localName) {
            case 'r': runElement(child); continue;
            case 'hyperlink': {
              const outer = state.link;
              const anchor = wAttr(child, 'anchor');
              const rel = this.rels.get(child.getAttributeNS(NS.r, 'id'));
              state.link = anchor ? `#${anchor}` : rel?.external ? rel.target : null;
              walk(child);
              state.link = outer;
              continue;
            }
            case 'fldSimple': {
              const object = fieldObject(wAttr(child, 'instr'));
              if (object) this.fieldResult(object, state, marks, emit, this.look(this.styleRuns(styleId)));
              else {
                this.losses.add('Fields, kept as the text they showed');
                walk(child);
              }
              continue;
            }
            case 'bookmarkStart': {
              const name = wAttr(child, 'name');
              if (!name || name === '_GoBack') continue;
              // Word's own reference bookmarks belong to the heading or caption number they hold.
              if (/^_(Ref|Toc)/.test(name)) {
                marks.push(name);
                state.mark = name;
              } else emit(OBJECT, this.look(this.styleRuns(styleId)), { type: 'bookmark', name });
              continue;
            }
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

  /** A field Paper keeps as an object: a caption number takes the bookmark just before it as its name. */
  fieldResult(object, state, marks, emit, look) {
    if (object.type === 'seq') {
      if (state.mark) {
        object.id = state.mark;
        marks.splice(marks.indexOf(state.mark), 1);
      } else object.id = `seq${Math.random().toString(36).slice(2, 10)}`;
    }
    emit(OBJECT, look, object);
  }

  drawing(element, segments, align) {
    const chart = element.getElementsByTagNameNS(CHART, 'chart')[0];
    if (chart) {
      const rel = this.rels.get(chart.getAttributeNS(NS.r, 'id'));
      const part = rel && !rel.external ? readPart(this.pkg, rel.target, 'a chart') : null;
      const read = part ? readOoxmlChartPart(part) : null;
      if (read) {
        const extent = [...element.getElementsByTagNameNS(NS.wp, 'extent')][0];
        const px = (value, fallback) => Math.max(60, Math.min(2000, Math.round(Number(value ?? 0) / 9525) || fallback));
        segments.push({ block: { kind: 'chart', style: 'body', align, w: px(extent?.getAttribute('cx'), 480), h: px(extent?.getAttribute('cy'), 300), ...read } });
        segments.push({ runs: [] });
        return;
      }
    }
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

  /** A table of contents: its title, and how deep its field goes; the entries are worked out again. */
  contents(content) {
    this.currentList = null;
    const instr = [...(content?.getElementsByTagNameNS(W, 'instrText') ?? [])].map((t) => t.textContent).join('');
    const depth = /\\o\s*"\d+-(\d+)"/.exec(instr);
    const first = kid(content, W, 'p');
    const titleStyle = wAttr(dig(first, [W, 'pPr'], [W, 'pStyle']), 'val') ?? '';
    const title = /toc ?heading|contents ?heading/i.test(titleStyle) ? [...first.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('').trim() : '';
    this.blocks.push({ kind: 'toc', style: 'body', align: 'left', title: title || 'Contents', levels: Math.max(1, Math.min(4, Number(depth?.[1] ?? 3))) });
  }

  /** A table: its grid, spans and merges as Word writes them, each cell's paragraphs as lines of its text. */
  table(tbl) {
    this.currentList = null;
    const grid = wrapped(kid(tbl, W, 'tblGrid'), 'gridCol').map((col) => Number(wAttr(col, 'w')) || 1);
    const width = Math.min(TABLE_LIMITS.cols, Math.max(grid.length, ...wrapped(tbl, 'tr').map((tr) => wrapped(tr, 'tc')
      .reduce((n, tc) => n + (Number(wAttr(kid(kid(tc, W, 'tcPr'), W, 'gridSpan'), 'val')) || 1), 0))));
    const rows = [];
    // Where a vertical merge started in each column, so the cells below can join it.
    const open = new Map();
    for (const tr of wrapped(tbl, 'tr').slice(0, TABLE_LIMITS.rows)) {
      const header = kid(kid(tr, W, 'trPr'), W, 'tblHeader') !== null && rows.every((row) => row.header);
      const cells = [];
      let col = Number(wAttr(kid(kid(tr, W, 'trPr'), W, 'gridBefore'), 'val')) || 0;
      for (let i = 0; i < col; i += 1) cells.push({ runs: [{ text: '' }] });
      for (const tc of wrapped(tr, 'tc')) {
        const tcPr = kid(tc, W, 'tcPr');
        const span = Math.max(1, Number(wAttr(kid(tcPr, W, 'gridSpan'), 'val')) || 1);
        const merge = kid(tcPr, W, 'vMerge');
        const mergeValue = merge ? wAttr(merge, 'val') ?? 'continue' : null;
        if (mergeValue === 'continue' && open.has(col)) {
          open.get(col).rowspan = (open.get(col).rowspan ?? 1) + 1;
          for (let k = 0; k < span; k += 1) cells.push({ runs: [{ text: '' }] });
          col += span;
          continue;
        }
        const cell = this.cellContent(tc);
        const fill = wAttr(kid(tcPr, W, 'shd'), 'fill');
        if (fill && /^[0-9a-f]{6}$/i.test(fill)) cell.bg = `#${fill.toLowerCase()}`;
        const valign = wAttr(kid(tcPr, W, 'vAlign'), 'val');
        if (valign === 'center' || valign === 'top' || valign === 'bottom') cell.valign = valign === 'center' ? 'middle' : valign;
        if (span > 1) cell.colspan = span;
        if (mergeValue === 'restart') open.set(col, cell); else open.delete(col);
        cells.push(cell);
        for (let k = 1; k < span; k += 1) cells.push({ runs: [{ text: '' }] });
        col += span;
      }
      rows.push({ ...(header ? { header: true } : {}), cells: cells.slice(0, width) });
    }
    const borders = kid(kid(tbl, W, 'tblPr'), W, 'tblBorders');
    const has = (side) => {
      const value = wAttr(kid(borders, W, side), 'val');
      return !!value && value !== 'nil' && value !== 'none';
    };
    let style = 'all';
    if (borders) {
      if (has('insideH') && has('insideV')) style = 'all';
      else if (has('insideH') && !has('insideV') && !has('left')) style = 'rows';
      else if (has('top') || has('left')) style = 'outer';
      else style = 'none';
    } else if (!wAttr(kid(kid(tbl, W, 'tblPr'), W, 'tblStyle'), 'val')) style = 'none';
    this.blocks.push(normaliseTable({ kind: 'table', style: 'body', align: 'left', rows, widths: grid.length === width ? grid : [], borders: style }));
  }

  /** The text of a cell, a line per paragraph. */
  cellContent(tc) {
    const saved = this.blocks;
    const savedList = this.currentList;
    this.blocks = [];
    this.walk(tc);
    const inner = this.blocks;
    this.blocks = saved;
    this.currentList = savedList;
    const lines = [];
    let align = null;
    for (const block of inner) {
      if (block.kind === 'table') {
        this.losses.add('Tables inside tables, kept as text');
        lines.push([{ text: block.rows.map((r) => r.cells.map((c) => c.runs.map((run) => run.text).join('')).join('\t')).join('\n') }]);
      } else if (block.kind === 'list') {
        for (const item of block.items) lines.push(item.runs);
      } else if (block.kind === 'image') {
        this.losses.add('Pictures inside tables');
      } else if (block.runs) {
        lines.push(block.runs);
        align ??= block.align && block.align !== 'left' ? block.align : null;
      }
    }
    // Trailing empty paragraphs Word keeps in a cell are not text.
    while (lines.length > 1 && lines[lines.length - 1].every((run) => run.text === '')) lines.pop();
    const runs = normaliseRuns(lines.flatMap((runs, i) => (i ? [{ text: '\n' }, ...runs] : runs)));
    return align ? { runs, align } : { runs };
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

  /** The person's own paragraph style a style id names, registered the first time. */
  customStyle(styleId) {
    const style = this.styles.get(styleId);
    if (!style || style.type !== 'paragraph' || KNOWN_WORD.test(style.name)) return null;
    const key = styleKey(style.name);
    if (!this.customStyles.has(key)) this.customStyles.set(key, { source: styleId, name: style.name });
    return key;
  }

  customChar(styleId) {
    const style = this.styles.get(styleId);
    if (!style || style.type !== 'character' || /^(hyperlink|followed ?hyperlink|footnote reference|endnote reference|default paragraph font|page number|line number|strong|emphasis)$/i.test(style.name)) {
      return null;
    }
    const key = styleKey(style.name, 'k');
    if (!this.customChars.has(key)) this.customChars.set(key, { source: styleId, name: style.name });
    return key;
  }

  charStyles() {
    const out = {};
    for (const [key, { source, name }] of this.customChars) {
      const look = this.look(this.chain(source).reverse().map((style) => style.rPr));
      const style = { name };
      for (const mark of ['bold', 'italic', 'underline', 'strike']) if (look[mark]) style[mark] = true;
      if (look.color && look.color !== '#000000') style.color = look.color;
      if (look.highlight) style.highlight = look.highlight;
      out[key] = style;
    }
    return out;
  }

  paperStyles() {
    const out = {};
    for (const [key, { source, name }] of this.customStyles) out[key] = { ...this.styleOf(source), name };
    const wellKnown = {
      body: [this.defaultParagraph, 'Normal'],
      h1: ['Heading1'],
      h2: ['Heading2'],
      h3: ['Heading3'],
      h4: ['Heading4'],
      quote: ['Quote'],
      title: ['Title'],
      subtitle: ['Subtitle'],
      hr: ['HorizontalLine'],
      code: ['HTMLPreformatted'],
    };
    const customSources = new Set([...this.customStyles.values()].map((c) => c.source));
    for (const name of PAPER_STYLES) {
      const used = [...(this.usage.get(name) ?? new Map())].filter(([id]) => !customSources.has(id)).sort((a, b) => b[1] - a[1])[0]?.[0];
      const source = used ?? wellKnown[name].find((id) => id && this.styles.has(id));
      if (!source) continue;
      out[name] = this.styleOf(source);
    }
    return out;
  }

  /** A paragraph style of the file as a Paper style. */
  styleOf(source) {
    {
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
      const first = pt(indent, 'firstLine') - pt(indent, 'hanging');
      if (first) style.firstLine = first;
      if (look.underline) style.underline = true;
      if (look.color && look.color !== '#000000') style.color = look.color;
      return style;
    }
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

/** A paragraph's own spacing and indent, from the w:spacing and w:ind written on it. */
function directPara(spacing, indent) {
  const pt = (element, name) => {
    const value = wAttr(element, name);
    return value === null || !Number.isFinite(Number(value)) ? undefined : Math.round((Number(value) / 20) * 10) / 10;
  };
  const para = {};
  if (spacing) {
    para.spaceBefore = pt(spacing, 'before');
    para.spaceAfter = pt(spacing, 'after');
    const line = wAttr(spacing, 'line');
    if (line && (wAttr(spacing, 'lineRule') ?? 'auto') === 'auto') para.lineHeight = Math.round((Number(line) / 240) * 1.15 * 100) / 100;
  }
  if (indent) para.indent = pt(indent, 'left') ?? pt(indent, 'start');
  return normalisePara(para);
}

/** A paragraph's own spacing less what its style already gives. */
function withoutSame(para, base) {
  if (!para) return null;
  const defaults = { spaceBefore: 0, spaceAfter: 0, indent: 0 };
  const out = Object.fromEntries(Object.entries(para).filter(([field, value]) => value !== (base?.[field] ?? defaults[field])));
  return Object.keys(out).length ? out : null;
}

const FROM_WORD_NUMBER = { decimal: 'decimal', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman' };

/** Heading numbers as Paper keeps them, from the numbering Word's headings use, or null when Paper cannot show it. */
function headingNumbersFrom(levels) {
  const format = FROM_WORD_NUMBER[levels?.get(0)];
  if (!format) return null;
  let depth = 1;
  while (depth < 4 && FROM_WORD_NUMBER[levels.get(depth)]) depth += 1;
  const first = levels.texts?.get(0) ?? '%1';
  return {
    format,
    full: /%1.*%2/.test(levels.texts?.get(1) ?? ''),
    after: first.includes('%1') ? first.slice(first.indexOf('%1') + 2) : '',
    depth,
  };
}
