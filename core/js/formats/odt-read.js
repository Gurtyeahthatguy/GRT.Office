/** OpenDocument text into the editor's document model. */

import { NS, kids, kid, attr, is, parseXml } from '../xml.js';
import { parseLength } from '../units.js';
import { normaliseRuns, pageSizeFields, normaliseTable, TABLE_LIMITS, OBJECT, styleKey, BULLETS, normalisePara } from '../editor/model.js';

/** Paragraph styles Paper has its own name for, or that belong to something else; any other named style is one of the person's. */
const KNOWN_PARAGRAPH = /^(Standard|Text_20_body|Text body|Default_20_Paragraph_20_Style|Heading.*|Title|Subtitle|Quotations|Quote|Preformatted.*|Source_20_Code|Caption|Figure|Table|Illustration|Drawing|Text|Table_20_(Contents|Heading)|Contents.*|Index.*|Footnote|Endnote|List.*|Numbering.*|Header|Footer|Frame_20_contents|Signature|Salutation|Horizontal_20_Line|Sender|Addressee|Marginalia|Hanging_20_indent|First_20_line_20_indent|Text_20_body_20_indent)$/;
import { makeId } from '../editor/ids.js';
import { runListsOf } from '../editor/fields.js';
import { readOdfChartDocument, frameSize } from './chart-object.js';
import { readMathElement, MATHML } from './math-ml.js';
import { Losses } from '../losses.js';
import {
  odfDocuments, OdfStyles, textLook, fontKind, internalHref, extensionOf, DRAWABLE, fromBase64,
  outlineNumbered, headingNumbersOf, noteSettingsOf,
} from './odf.js';
import { declareExternal } from './external.js';

const PT_PER_MM = 72 / 25.4;
const PX_PER_MM = 96 / 25.4;
const MARKS = ['bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'double', 'overline', 'shadow', 'outline', 'smallcaps'];
const PAPER_STYLES = ['body', 'h1', 'h2', 'h3', 'h4', 'quote', 'code', 'title', 'subtitle', 'hr'];
/** LibreOffice's paragraph styles that are Paper's own styles of plain paragraphs. */
const PLAIN_STYLES = { Title: 'title', Subtitle: 'subtitle', Horizontal_20_Line: 'hr' };

/**
 * @param {import('../package.js').Package|string} source a package, or a flat file's text
 * @returns {{document: object, images: Map<string, Uint8Array>, losses: Losses}}
 */
export function readOdt(source) {
  const docs = odfDocuments(source);
  if (docs.mimetype && !docs.mimetype.startsWith('application/vnd.oasis.opendocument.text')) {
    throw new Error('This OpenDocument file is not a text document');
  }
  const named = [docs.styles, docs.content].filter(Boolean);
  const reader = new TextReader({
    styles: new OdfStyles(named, docs.content),
    masterStyles: new OdfStyles(named, docs.styles ?? docs.content),
    pkg: typeof source === 'string' ? null : source,
  });
  declareExternal(source, reader.losses);
  return reader.read(docs.content);
}

class TextReader {
  constructor({ styles, masterStyles, pkg }) {
    this.styles = styles;
    this.masterStyles = masterStyles;
    this.pkg = pkg;
    this.losses = new Losses();
    if (pkg?.damage) {
      this.losses.add('The file was damaged, and only what could still be read was opened');
    }
    this.blocks = [];
    this.images = new Map();
    this.notes = [];
    this.usage = new Map();
    // Bookmarks LibreOffice puts on headings for references, and the references to resolve once every block has an id.
    this.headingMarks = new Map();
    this.references = [];
    // The person's own styles found in the file: Paper's key to the file's style name.
    this.customStyles = new Map();
    this.customChars = new Map();
    this.firstMaster = null;
  }

  read(content) {
    const body = kid(kid(content.documentElement, NS.office, 'body'), NS.office, 'text');
    if (!body) throw new Error('This document has no text body');
    this.prepareReview(body);
    this.walkBlocks(body, { listLevel: -1 });

    if (this.notes.length > 0) {
      this.blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: '' }], breakBefore: false });
      for (const [index, runs] of this.notes.entries()) {
        this.blocks.push(paragraph('body', 'left', [{ text: `[${index + 1}] ` }, ...runs]));
      }
      this.losses.add('Footnotes and endnotes, moved to the end of the document', this.notes.length);
    }

    // References to headings point at the heading's block, now that it has one.
    for (const block of this.blocks) {
      for (const { runs } of runListsOf(block)) {
        for (const run of runs) {
          if (run.object?.type === 'ref' && this.headingMarks.has(run.object.target)) run.object.target = `heading:${this.headingMarks.get(run.object.target)}`;
        }
      }
    }

    const blocks = mergeCode(this.blocks);
    if (blocks.length === 0) blocks.push(paragraph('body', 'left', []));
    return {
      document: {
        version: 1,
        type: 'paper',
        page: this.page(),
        styles: this.paperStyles(),
        charStyles: this.charStyles(),
        fonts: [],
        blocks,
        headingNumbers: headingNumbersOf(this.styles),
        noteSettings: noteSettingsOf(this.styles),
      },
      images: this.images,
      losses: this.losses,
    };
  }

  // Blocks

  walkBlocks(parent, context) {
    for (const node of kids(parent)) this.block(node, context);
  }

  block(node, context) {
    if (node.namespaceURI === NS.text) {
      switch (node.localName) {
        case 'p':
        case 'h':
          this.paragraph(node, context);
          return;
        case 'list':
          this.list(node);
          return;
        case 'section': {
          // A section in columns becomes a mark where they start and one where they end.
          const props = this.styles.resolve('section', attr(node, NS.text, 'style-name'), 'section');
          const columns = Math.max(1, Math.min(4, Number(props.columnCount ?? 1)));
          if (columns > 1) this.blocks.push({ kind: 'section', style: 'body', align: 'left', columns });
          this.walkBlocks(node, context);
          if (columns > 1) this.blocks.push({ kind: 'section', style: 'body', align: 'left', columns: 1 });
          return;
        }
        case 'table-of-content': {
          const source = kid(node, NS.text, 'table-of-content-source');
          const title = kid(kid(node, NS.text, 'index-body'), NS.text, 'index-title')?.textContent.trim() || kid(source, NS.text, 'index-title-template')?.textContent.trim() || 'Contents';
          this.blocks.push({ kind: 'toc', style: 'body', align: 'left', title, levels: Math.max(1, Math.min(4, Number(attr(source, NS.text, 'outline-level') ?? 3))) });
          return;
        }
        case 'alphabetical-index': {
          const source = kid(node, NS.text, 'alphabetical-index-source');
          const title = kid(kid(node, NS.text, 'index-body'), NS.text, 'index-title')?.textContent.trim() || kid(source, NS.text, 'index-title-template')?.textContent.trim() || 'Index';
          this.blocks.push({ kind: 'index', style: 'body', align: 'left', title });
          return;
        }
        case 'illustration-index':
        case 'table-index':
        case 'object-index':
        case 'user-index':
        case 'bibliography':
          this.losses.add('Indexes and tables of contents, kept as plain text');
          this.walkBlocks(kid(node, NS.text, 'index-body') ?? node, context);
          return;
        case 'index-title':
          this.walkBlocks(node, context);
          return;
        case 'tracked-changes':
          // Read before the text, in prepareReview.
          return;
        case 'sequence-decls': case 'variable-decls': case 'user-field-decls':
        case 'dde-connection-decls': case 'soft-page-break': case 'bookmark':
        case 'bookmark-start': case 'bookmark-end':
          return;
        default:
          break;
      }
    }
    if (is(node, NS.table, 'table')) {
      this.table(node, context);
      return;
    }
    if (is(node, NS.draw, 'frame') || is(node, NS.draw, 'a')) {
      this.frames(node, context, 'left');
      return;
    }
    if (node.namespaceURI === NS.office && node.localName === 'forms') return;
    if (node.namespaceURI === NS.draw || node.namespaceURI === NS.office) {
      this.losses.add('Drawings and embedded objects');
      return;
    }
    if (node.textContent.trim()) {
      this.losses.add('Parts of the document GRT does not know, kept as text');
      this.walkBlocks(node, context);
    }
  }

  paragraph(node, context) {
    const styleName = attr(node, NS.text, 'style-name');
    const props = this.styles.resolve('paragraph', styleName, 'paragraph');
    const names = this.styles.names('paragraph', styleName);
    // What the paragraph's automatic style sets is the paragraph's own formatting.
    const ownStyle = this.styles.style('paragraph', styleName);
    const parentPara = ownStyle?.automatic ? directPara(this.styles.resolve('paragraph', ownStyle.parent, 'paragraph')) ?? {} : {};
    const ownPara = ownStyle?.automatic ? directPara(ownStyle.props.paragraph ?? {}) : null;
    const para = ownPara && Object.keys(ownPara).some((f) => ownPara[f] !== (parentPara[f] ?? 0))
      ? Object.fromEntries(Object.entries(ownPara).filter(([f, v]) => v !== (parentPara[f] ?? 0))) : null;
    const chain = this.styles.chain('paragraph', styleName);

    const master = chain.find((style) => style.masterPage)?.masterPage ?? null;
    const changesPage = master !== null && master !== '';
    if (changesPage && this.firstMaster === null && this.blocks.length === 0) this.firstMaster = master;

    let kind = 'paragraph';
    let level = 1;
    let style = 'body';
    if (node.localName === 'h') {
      kind = 'heading';
      level = Number(attr(node, NS.text, 'outline-level') ?? chain.find((s) => s.outlineLevel)?.outlineLevel ?? 1);
    } else {
      const heading = headingLevel(names) ?? Number(chain.find((s) => s.outlineLevel)?.outlineLevel ?? 0);
      if (heading > 0) {
        kind = 'heading';
        level = heading;
      } else if (names.some((n) => /^(Quotations|Quote|Block_20_Quotation|Intense_20_Quote)$/i.test(n))) {
        kind = 'quote';
      } else if (names.some((n) => /^(Preformatted_20_Text|Preformatted Text|Source_20_Code|HTML_20_Preformatted)$/i.test(n))) {
        kind = 'code';
      }
    }
    if (kind === 'heading') {
      // Paper numbers four levels in one format; LibreOffice may number each its own way.
      if (level > 4 && outlineNumbered(this.styles, level)) this.losses.add('Numbered headings deeper than level 4, their numbers dropped');
      if (level > 4) this.losses.add('Headings deeper than level 4, made level 4');
      level = Math.max(1, Math.min(level, 4));
      style = `h${level}`;
    } else if (kind === 'quote') {
      style = 'quote';
    } else if (kind === 'code') {
      style = 'code';
    } else {
      style = names.map((n) => PLAIN_STYLES[n]).find(Boolean) ?? style;
    }

    const named = this.styles.named('paragraph', styleName);
    if (named) {
      const counts = this.usage.get(style) ?? new Map();
      counts.set(named.name, (counts.get(named.name) ?? 0) + 1);
      this.usage.set(style, counts);
    }

    const baseline = textLook(this.styles.resolve('paragraph', named?.name ?? null, 'text'), this.styles);
    const own = this.styles.resolve('paragraph', styleName, 'text');
    const align = alignment(props['text-align']);
    const marks = [];
    const segments = this.inline(node, own, baseline, { ...context, align, marks });

    const breakBefore = props['break-before'] === 'page' || (changesPage && this.blocks.length > 0);

    segments.forEach((segment, index) => {
      if (segment.image) {
        this.blocks.push(segment.image);
        return;
      }
      if (segment.blocks) {
        for (const block of segment.blocks) this.blocks.push(block);
        return;
      }
      const runs = normaliseRuns(segment.runs);
      const empty = runs.length === 1 && runs[0].text === '';
      if (empty && segments.length > 1) return;
      const own = kind === 'paragraph' ? this.customStyle(chain) : null;
      const block = kind === 'heading'
        ? { kind: 'heading', level, style, align, runs }
        : { kind, style: own ?? (names.some((n) => /^(Caption|Figure|Table|Illustration|Drawing|Text)$/.test(n)) && kind === 'paragraph' ? 'caption' : style), align, runs };
      if (para) block.para = para;
      if (index === 0 && breakBefore) block.breakBefore = true;
      if (index === 0 && marks.length) {
        block.id = makeId('b');
        for (const name of marks) this.headingMarks.set(name, block.id);
      }
      this.blocks.push(block);
    });
  }

  /** A paragraph's content as segments: runs, broken where pictures and line breaks fall. */
  inline(node, paragraphProps, baseline, context) {
    const segments = [{ runs: [] }];
    const state = { lastSpace: true };
    const current = () => segments[segments.length - 1];

    const emit = (text, look, object = null) => {
      const run = { text };
      if (object) run.object = object;
      if (this.openIns) {
        run.ins = this.openIns.id;
        if (this.openIns.note) run.chgnote = this.openIns.note;
      }
      if (this.openComment && !object) run.cmt = this.openComment;
      if (state.link) run.link = state.link;
      if (state.cstyle) run.cstyle = state.cstyle;
      for (const mark of MARKS) if (look[mark] && !baseline[mark]) run[mark] = true;
      if (look.color && look.color !== baseline.color && look.color !== '#000000') run.color = look.color;
      if (look.highlight && look.highlight !== baseline.highlight) run.highlight = look.highlight;
      if (look.size && baseline.size && Math.abs(look.size - baseline.size) > 0.1) run.size = look.size;
      if (look.lang && look.lang !== baseline.lang) run.lang = look.lang;
      if (look.font && baseline.font && look.font !== baseline.font
        && fontKind(look.font, look.generic) !== fontKind(baseline.font, baseline.generic)) {
        this.losses.add('Fonts that differ from the paragraph’s, shown in its font');
      }
      current().runs.push(run);
    };

    const walk = (parent, props) => {
      const look = textLook(props, this.styles);
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          let text = child.nodeValue.replace(/[ \t\r\n]+/g, ' ');
          if (state.lastSpace) text = text.replace(/^ /, '');
          if (text === '') continue;
          state.lastSpace = text.endsWith(' ');
          emit(text, look);
          continue;
        }
        if (child.nodeType !== 1) continue;

        if (child.namespaceURI === NS.text) {
          switch (child.localName) {
            case 's':
              emit(' '.repeat(Number(attr(child, NS.text, 'c') ?? 1)), look);
              state.lastSpace = false;
              continue;
            case 'tab':
              emit('\t', look);
              state.lastSpace = false;
              continue;
            case 'line-break':
              this.losses.add('Line breaks inside a paragraph, made into new paragraphs');
              segments.push({ runs: [] });
              state.lastSpace = true;
              continue;
            case 'span': {
              const spanStyle = attr(child, NS.text, 'style-name');
              // A named character style is one of the person's; its look comes with it, not as direct formatting.
              const named = this.styles.chain('text', spanStyle).find((style) => !style.automatic && !/^(Footnote|Endnote|Internet_20_link|Visited_20_Internet_20_Link|Index_20_Link|Numbering_20_Symbols|Bullet_20_Symbols)/.test(style.name));
              const outer = state.cstyle;
              if (named) {
                const display = named.displayName ?? named.name.replace(/_20_/g, ' ');
                const key = styleKey(display, 'k');
                if (!this.customChars.has(key)) this.customChars.set(key, { source: named.name, name: display });
                state.cstyle = key;
              }
              walk(child, named ? props : { ...props, ...this.styles.resolve('text', spanStyle, 'text') });
              state.cstyle = outer;
              continue;
            }
            case 'a': {
              const outer = state.link;
              state.link = attr(child, NS.xlink, 'href');
              walk(child, { ...props, ...this.styles.resolve('text', attr(child, NS.text, 'style-name'), 'text') });
              state.link = outer;
              continue;
            }
            case 'ruby':
              this.losses.add('Reading guides above characters (ruby), kept as the base text');
              walk(kid(child, NS.text, 'ruby-base') ?? child, props);
              continue;
            case 'note': {
              const body = kid(child, NS.text, 'note-body');
              const kind = attr(child, NS.text, 'note-class') === 'endnote' ? 'end' : 'foot';
              const mark = attr(kid(child, NS.text, 'note-citation'), NS.text, 'label');
              emit(OBJECT, look, { type: 'note', kind, runs: this.plainRuns(body), ...(mark ? { mark } : {}) });
              state.lastSpace = false;
              continue;
            }
            case 'bookmark': case 'bookmark-start': case 'reference-mark': case 'reference-mark-start': {
              const name = attr(child, NS.text, 'name');
              if (!name) continue;
              // A heading's bookmark for references is part of the heading, not something placed in it.
              if (name.startsWith('__RefHeading__')) context.marks?.push(name);
              else emit(OBJECT, look, { type: 'bookmark', name });
              continue;
            }
            case 'database-display': {
              const name = attr(child, NS.text, 'column-name');
              if (name) emit(OBJECT, look, { type: 'merge', name });
              state.lastSpace = false;
              continue;
            }
            case 'bibliography-mark': {
              // A citation keeps what it cites; what it showed is drawn again from its short name.
              const raw = attr(child, NS.text, 'identifier') ?? '';
              const key = /"([^"]+)"/.exec(raw)?.[1] ?? raw;
              const type = attr(child, NS.text, 'bibliography-type');
              const kind = { book: 'book', article: 'article', www: 'website', phdthesis: 'thesis', mastersthesis: 'thesis', techreport: 'report' }[type] ?? 'misc';
              const fields = Object.fromEntries(['author', 'title', 'year', 'publisher', 'url'].map((f) => [f, attr(child, NS.text, f)]).filter(([, v]) => v));
              emit(OBJECT, look, { type: 'cite', key: key.trim(), kind, ...fields });
              state.lastSpace = false;
              continue;
            }
            case 'alphabetical-index-mark': {
              const value = attr(child, NS.text, 'string-value');
              const key = attr(child, NS.text, 'key1');
              if (value) emit(OBJECT, look, key ? { type: 'index', term: key, sub: value } : { type: 'index', term: value });
              continue;
            }
            case 'alphabetical-index-mark-start': {
              const key = attr(child, NS.text, 'key1');
              const value = attr(child, NS.text, 'string-value');
              if (key || value) emit(OBJECT, look, { type: 'index', term: key ?? value, ...(key && value ? { sub: value } : {}) });
              else this.losses.add('Index entries marked over a stretch of text, kept as their text');
              continue;
            }
            case 'change-start': {
              const region = this.changeRegions.get(attr(child, NS.text, 'change-id'));
              if (region?.kind === 'insertion') this.openIns = region;
              continue;
            }
            case 'change-end':
              if (this.openIns?.region === attr(child, NS.text, 'change-id')) this.openIns = null;
              continue;
            case 'change': {
              // Text taken out stands where it was, marked, so it can be looked at and put back.
              const region = this.changeRegions.get(attr(child, NS.text, 'change-id'));
              if (region?.kind !== 'deletion') continue;
              const before = this.openIns;
              this.openIns = null;
              region.paragraphs.forEach((p, i) => {
                if (i > 0) emit('\n', look);
                const from = current().runs.length;
                walk(p, props);
                for (const run of current().runs.slice(from)) {
                  run.del = region.id;
                  if (region.note) run.chgnote = region.note;
                }
              });
              this.openIns = before;
              continue;
            }
            case 'soft-page-break': case 'bookmark-end': case 'reference-mark-end':
            case 'alphabetical-index-mark-end':
            case 'toc-mark': case 'toc-mark-start': case 'toc-mark-end':
              continue;
            case 'page-number':
              emit(OBJECT, look, { type: 'field', field: 'page' });
              continue;
            case 'page-count':
              emit(OBJECT, look, { type: 'field', field: 'pages' });
              continue;
            case 'sequence': {
              const name = attr(child, NS.text, 'name') ?? 'Figure';
              emit(OBJECT, look, { type: 'seq', name, id: attr(child, NS.text, 'ref-name') ?? `seq${this.references.length}${Math.random().toString(36).slice(2, 8)}` });
              continue;
            }
            case 'sequence-ref': case 'bookmark-ref': case 'reference-ref': {
              const format = attr(child, NS.text, 'reference-format') ?? 'text';
              const object = { type: 'ref', target: attr(child, NS.text, 'ref-name') ?? '', show: format === 'page' ? 'page' : format === 'category-and-value' || format === 'value' || format === 'number' ? 'number' : 'text' };
              if (!object.target) {
                walk(child, props);
                continue;
              }
              this.references.push(object);
              emit(OBJECT, look, object);
              continue;
            }
            case 'date':
            case 'time':
              emit(OBJECT, look, { type: 'field', field: child.localName });
              continue;
            case 'title':
            case 'subject':
            case 'chapter':
            case 'file-name':
            case 'author-name':
            case 'user-defined':
            case 'variable-get':
            case 'variable-set':
            case 'user-field-get':
            case 'note-ref':
              this.losses.add('Fields, kept as the text they showed');
              walk(child, props);
              continue;
            default:
              walk(child, props);
              continue;
          }
        }
        const formula = is(child, NS.draw, 'frame') ? this.formulaObject(kid(child, NS.draw, 'object')) : null;
        if (formula) {
          emit(OBJECT, look, formula);
          state.lastSpace = false;
          continue;
        }
        if (is(child, NS.draw, 'frame') || is(child, NS.draw, 'a')) {
          const found = this.frameBlocks(child, context, context.align ?? 'left');
          for (const block of found) segments.push(block.kind === 'image' ? { image: block } : { blocks: [block] });
          if (found.length > 0) segments.push({ runs: [] });
          continue;
        }
        if (child.namespaceURI === NS.office && child.localName === 'annotation') {
          // A reply is part of its thread, put with the comment it answers.
          const found = this.annotations.get(child);
          if (!found || found.parent) continue;
          emit(OBJECT, look, found.object);
          if (found.name && this.annotationEnds.has(found.name)) {
            this.openComment = found.object.id;
            this.openCommentName = found.name;
          }
          state.lastSpace = false;
          continue;
        }
        if (child.namespaceURI === NS.office && child.localName === 'annotation-end') {
          if (attr(child, NS.office, 'name') === this.openCommentName) this.openComment = null;
          continue;
        }
        if (child.namespaceURI === NS.draw) {
          this.losses.add('Drawings and embedded objects');
          continue;
        }
        walk(child, props);
      }
    };

    walk(node, paragraphProps);
    return segments;
  }

  /**
   * The changes the text records, and its comments with their replies, read before the text that marks them.
   * Who made them and when are not kept.
   */
  prepareReview(body) {
    this.changeRegions = new Map();
    this.openIns = null;
    this.openComment = null;
    this.openCommentName = null;
    const tracked = kid(body, NS.text, 'tracked-changes');
    const fresh = (prefix) => `${prefix}${this.changeRegions.size + 1}`;
    for (const region of kids(tracked, NS.text, 'changed-region').slice(0, 20_000)) {
      const id = attr(region, NS.text, 'id') ?? attr(region, 'http://www.w3.org/XML/1998/namespace', 'id');
      const change = kids(region).find((k) => k.namespaceURI === NS.text);
      if (!id || !change) continue;
      const info = kid(change, NS.office, 'change-info');
      if (kids(info).some((k) => k.localName === 'creator' && k.textContent.trim())) this.losses.add('Names and dates on changes and comments, left out');
      const note = kids(info, NS.text, 'p').map((p) => p.textContent).join('\n').slice(0, 10_000) || null;
      if (change.localName === 'format-change') {
        this.losses.add('Recorded changes of formatting, shown as made');
        continue;
      }
      if (!['insertion', 'deletion'].includes(change.localName)) continue;
      this.changeRegions.set(id, {
        kind: change.localName, region: id, id: fresh(change.localName === 'insertion' ? 'i' : 'd'), note,
        paragraphs: change.localName === 'deletion' ? kids(change).filter((k) => k.namespaceURI === NS.text && ['p', 'h'].includes(k.localName)).slice(0, 1000) : [],
      });
      if (change.localName === 'deletion' && kids(change).some((k) => k.namespaceURI === NS.table || k.localName === 'list')) this.losses.add('Deleted tables and lists, kept as their text');
    }

    // Comments: every one by its name, replies put with the comment they answer.
    this.annotations = new Map();
    this.annotationEnds = new Set([...body.getElementsByTagNameNS(NS.office, 'annotation-end')].map((e) => attr(e, NS.office, 'name')).filter(Boolean));
    const byName = new Map();
    const all = [...body.getElementsByTagNameNS(NS.office, 'annotation')].slice(0, 5000);
    all.forEach((element, i) => {
      if (kids(element).some((k) => (k.localName === 'creator' && k.textContent.trim()) || (k.localName === 'date' && !/^(0000|1970)/.test(k.textContent)))) {
        this.losses.add('Names and dates on changes and comments, left out');
      }
      const name = attr(element, NS.office, 'name');
      const text = kids(element, NS.text, 'p').map((p) => p.textContent).join('\n').slice(0, 100_000);
      const done = attr(element, NS.loext, 'resolved') === 'true';
      const parent = attr(element, NS.loext, 'parent-name');
      const object = { type: 'comment', id: `k${i + 1}`, text, ...(done ? { done: true } : {}) };
      const found = { name, parent, object };
      this.annotations.set(element, found);
      if (name) byName.set(name, found);
    });
    for (const found of this.annotations.values()) {
      if (!found.parent) continue;
      // A reply to a reply goes with the thread's first comment.
      let root = byName.get(found.parent);
      for (let hops = 0; root?.parent && hops < 50; hops += 1) root = byName.get(root.parent);
      if (!root || root === found) {
        found.parent = null;
        continue;
      }
      root.object.replies = [...(root.object.replies ?? []), { id: found.object.id, text: found.object.text, ...(found.object.done ? { done: true } : {}) }];
    }
  }

  /** Text without formatting, for notes. */
  plainRuns(element) {
    const parts = [];
    for (const p of element ? element.getElementsByTagNameNS(NS.text, 'p') : []) {
      parts.push(p.textContent.replace(/\s+/g, ' ').trim());
    }
    return [{ text: parts.filter(Boolean).join(' ').replaceAll(OBJECT, '') }];
  }

  /** A list, in order: runs of items become list blocks, anything else breaks them. */
  list(node) {
    const entries = [];
    this.flattenList(node, 0, attr(node, NS.text, 'style-name'), entries);
    let current = null;
    for (const entry of entries) {
      if (entry.kind === 'block') {
        current = null;
        if (entry.heading) this.losses.add('Headings inside lists, their numbering dropped');
        else this.losses.add('Tables and pictures inside lists, which end the list there');
        this.block(entry.node, { listLevel: -1 });
        continue;
      }
      const texts = [];
      const extras = [];
      for (const p of entry.paragraphs) {
        const styleName = attr(p, NS.text, 'style-name');
        const named = this.styles.named('paragraph', styleName);
        const baseline = textLook(this.styles.resolve('paragraph', named?.name ?? null, 'text'), this.styles);
        const own = this.styles.resolve('paragraph', styleName, 'text');
        const align = alignment(this.styles.resolve('paragraph', styleName, 'paragraph')['text-align']);
        for (const segment of this.inline(p, own, baseline, { listLevel: entry.level, align })) {
          if (segment.runs) texts.push(segment.runs);
          else extras.push(...(segment.image ? [segment.image] : segment.blocks));
        }
      }
      const nonEmpty = texts.filter((runs) => runs.some((run) => run.text !== ''));
      if (nonEmpty.length > 1) this.losses.add('List items of several paragraphs, joined into one');
      const runs = nonEmpty.flatMap((r, i) => (i === 0 ? r : [{ text: ' ' }, ...r]));
      if (nonEmpty.length > 0 || extras.length === 0) {
        if (!current) {
          current = { kind: 'list', style: 'body', align: 'left', listType: null, items: [] };
          this.blocks.push(current);
        }
        const type = this.listType(entry.listStyle, entry.level);
        if (current.listType === null) {
          current.listType = type;
          Object.assign(current, this.listFormat(entry.listStyle, type));
        }
        else if (type !== current.listType) this.losses.add('Lists mixing bullets and numbers, shown with one kind');
        if (entry.level > 5) this.losses.add('Lists nested deeper than six levels, flattened');
        current.items.push({
          level: Math.min(entry.level, 5), runs: normaliseRuns(runs),
          ...(entry.unnumbered ? { unnumbered: true } : {}), ...(entry.restart && current.items.length ? { restart: true } : {}),
        });
      }
      if (extras.length > 0) {
        this.losses.add('Tables and pictures inside lists, which end the list there');
        this.blocks.push(...extras);
        current = null;
      }
    }
    for (const block of this.blocks) if (block.kind === 'list') block.listType ??= 'bullet';
  }

  /** Items with their level and list style, and the blocks between them, in order. */
  flattenList(node, level, listStyle, entries) {
    for (const item of kids(node)) {
      if (!is(item, NS.text, 'list-item') && !is(item, NS.text, 'list-header')) continue;
      let paragraphs = [];
      const flush = () => {
        if (paragraphs.length === 0) return;
        const first = attr(paragraphs[0], NS.text, 'style-name');
        const own = this.styles.chain('paragraph', first).find((s) => s.listStyle)?.listStyle;
        // A list header is an entry without a number; a start value of 1 starts the count again.
        entries.push({
          kind: 'item', level, listStyle: own || listStyle, paragraphs,
          unnumbered: is(item, NS.text, 'list-header'),
          restart: attr(item, NS.text, 'start-value') === '1' && entries.some((e) => e.kind === 'item'),
        });
        paragraphs = [];
      };
      for (const child of kids(item)) {
        if (is(child, NS.text, 'list')) {
          flush();
          this.flattenList(child, level + 1, attr(child, NS.text, 'style-name') ?? listStyle, entries);
        } else if (is(child, NS.text, 'h') || (is(child, NS.text, 'p')
          && headingLevel(this.styles.names('paragraph', attr(child, NS.text, 'style-name'))))) {
          flush();
          entries.push({ kind: 'block', node: child, heading: true });
        } else if (is(child, NS.text, 'p')) {
          paragraphs.push(child);
        } else if (!is(child, NS.text, 'soft-page-break')) {
          flush();
          entries.push({ kind: 'block', node: child, heading: false });
        }
      }
      flush();
    }
  }

  /** How a list style counts or what bullet it shows, when it is not the plain one. */
  listFormat(listStyleName, type) {
    const style = this.styles.lists.get(listStyleName);
    const first = style ? kids(style).find((element) => Number(attr(element, NS.text, 'level')) === 1) : null;
    if (!first) return {};
    if (type === 'number') {
      const format = { a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' }[attr(first, NS.style, 'num-format')];
      return format ? { format } : {};
    }
    const bullet = attr(first, NS.text, 'bullet-char');
    return BULLETS.includes(bullet) && bullet !== '•' ? { bullet } : {};
  }

  listType(listStyleName, level) {
    const style = this.styles.lists.get(listStyleName);
    if (!style) return 'bullet';
    const levels = kids(style).filter((element) => attr(element, NS.text, 'level'));
    const exact = levels.find((element) => Number(attr(element, NS.text, 'level')) === level + 1) ?? levels[0];
    if (!exact) return 'bullet';
    if (exact.localName === 'list-level-style-number') {
      const format = attr(exact, NS.style, 'num-format');
      return format === '' ? 'bullet' : 'number';
    }
    return 'bullet';
  }

  /** A table: its rows and cells, merged ones included; each cell's paragraphs become lines of its text. */
  table(node, context) {
    const rows = [];
    const collect = (parent, header) => {
      for (const child of kids(parent)) {
        if (is(child, NS.table, 'table-row')) rows.push(this.tableRow(child, header, context));
        else if (is(child, NS.table, 'table-header-rows')) collect(child, true);
        else if (is(child, NS.table, 'table-rows') || is(child, NS.table, 'table-row-group')) collect(child, header);
      }
    };
    collect(node, false);
    if (rows.length > TABLE_LIMITS.rows) this.losses.add('Tables longer than GRT keeps, cut at their last rows');
    const widths = [];
    for (const column of kids(node, NS.table, 'table-column')) {
      const props = this.styles.resolve('table-column', attr(column, NS.table, 'style-name'), 'column');
      const rel = parseFloat(props['rel-column-width']);
      const absolute = props['column-width'] ? parseLength(props['column-width']) : null;
      const repeat = Math.min(64, Number(attr(column, NS.table, 'number-columns-repeated') ?? 1));
      for (let i = 0; i < repeat; i += 1) widths.push(rel > 0 ? rel : absolute > 0 ? absolute : 1);
    }
    // The borders, as one of the few patterns Paper draws.
    const all = rows.flatMap((row) => row.cells).filter((cell) => cell.lines);
    const every = (test) => all.length > 0 && all.every(test);
    let borders = 'all';
    if (every((cell) => !Object.values(cell.lines).some(Boolean))) borders = 'none';
    else if (!every((cell) => Object.values(cell.lines).every(Boolean))) {
      borders = all.some((cell) => cell.lines.top && !cell.lines.left && !cell.lines.right) ? 'rows' : 'outer';
    }
    for (const cell of all) delete cell.lines;
    const block = normaliseTable({ id: undefined, kind: 'table', style: 'body', align: 'left', rows, widths, borders });
    delete block.id;
    this.blocks.push(block);
  }

  tableRow(row, header, context) {
    const cells = [];
    for (const cell of kids(row)) {
      if (is(cell, NS.table, 'covered-table-cell')) {
        cells.push({ runs: [{ text: '' }] });
        continue;
      }
      if (!is(cell, NS.table, 'table-cell')) continue;
      const repeat = Math.min(64, Number(attr(cell, NS.table, 'number-columns-repeated') ?? 1));
      const out = this.cellContent(cell, context);
      const props = this.styles.resolve('table-cell', attr(cell, NS.table, 'style-name'), 'cell');
      const bg = props['background-color'];
      if (bg && bg !== 'transparent') out.bg = bg.toLowerCase();
      if (['top', 'middle', 'bottom'].includes(props['vertical-align'])) out.valign = props['vertical-align'];
      const line = (side) => {
        const value = props[`border-${side}`] ?? props.border ?? 'none';
        return value !== 'none' && !/^0(\.0+)?\w*\s/.test(value);
      };
      out.lines = { top: line('top'), right: line('right'), bottom: line('bottom'), left: line('left') };
      const colspan = Number(attr(cell, NS.table, 'number-columns-spanned') ?? 1);
      const rowspan = Number(attr(cell, NS.table, 'number-rows-spanned') ?? 1);
      if (colspan > 1) out.colspan = colspan;
      if (rowspan > 1) out.rowspan = rowspan;
      for (let i = 0; i < repeat; i += 1) cells.push(i === 0 ? out : { runs: structuredClone(out.runs) });
    }
    return { ...(header ? { header: true } : {}), cells };
  }

  /** The text of a cell: what its paragraphs read as, one line each. */
  cellContent(cell, context) {
    const saved = this.blocks;
    this.blocks = [];
    for (const child of kids(cell)) this.block(child, context);
    const inner = this.blocks;
    this.blocks = saved;
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
    const runs = normaliseRuns(lines.flatMap((runs, i) => (i ? [{ text: '\n' }, ...runs] : runs)));
    return align ? { runs, align } : { runs };
  }

  frames(node, context, align) {
    this.blocks.push(...this.frameBlocks(node, context, align));
  }

  /** What a frame becomes: a picture, or the paragraphs of a text box. */
  frameBlocks(frame, context, align) {
    if (is(frame, NS.draw, 'a')) {
      this.losses.add('Links, kept as their text');
      return kids(frame).flatMap((child) => (is(child, NS.draw, 'frame') ? this.frameBlocks(child, context, align) : []));
    }

    const image = this.frameImage(frame);
    if (image) return [{ ...image, align: frameAlign(this.styles, frame, align) }];

    const box = kid(frame, NS.draw, 'text-box');
    if (box) {
      const inner = [...box.getElementsByTagNameNS(NS.draw, 'frame')];
      const picture = inner.length === 1 ? this.frameImage(inner[0]) : null;
      if (picture) {
        const clone = box.cloneNode(true);
        for (const nested of clone.getElementsByTagNameNS(NS.draw, 'frame')) nested.remove();
        const caption = clone.textContent.replace(/\s+/g, ' ').trim();
        return [{ ...picture, align: frameAlign(this.styles, frame, align), caption: caption ? [{ text: caption }] : [] }];
      }
      this.losses.add('Text boxes, their text kept as paragraphs');
      const saved = this.blocks;
      this.blocks = [];
      this.walkBlocks(box, { listLevel: -1 });
      const found = this.blocks;
      this.blocks = saved;
      return found;
    }

    const object = kid(frame, NS.draw, 'object');
    const chart = object ? this.chartObject(object) : null;
    if (chart) {
      const size = frameSize(frame);
      return [{ kind: 'chart', style: 'body', align: frameAlign(this.styles, frame, align), w: size.width, h: size.height, ...chart }];
    }
    if (kid(frame, NS.draw, 'object') || kid(frame, NS.draw, 'object-ole')) {
      this.losses.add('Charts, formulas and other embedded objects');
      return [];
    }
    return [];
  }

  /** An embedded object that is a formula: MathML inline in a flat file, a folder of the package otherwise. */
  formulaObject(object) {
    if (!object) return null;
    const inline = [...object.childNodes].find((node) => node.localName === 'math');
    if (inline) return readMathElement(inline);
    const href = attr(object, NS.xlink, 'href');
    const folder = href ? href.replace(/^\.\//, '').replace(/\/$/, '') : null;
    if (!folder || folder.includes('..') || typeof this.pkg?.text !== 'function') return null;
    const text = this.pkg.text(`${folder}/content.xml`);
    if (!text || !/<(\w+:)?math[\s>]/.test(text)) return null;
    try {
      const root = parseXml(text, `${folder}/content.xml`).documentElement;
      return readMathElement(root.localName === 'math' ? root : root.getElementsByTagNameNS(MATHML, 'math')[0]);
    } catch {
      return null;
    }
  }

  /** An embedded object that is a chart: inline in a flat file, a folder of the package otherwise. */
  chartObject(object) {
    const inline = kid(object, NS.office, 'document');
    if (inline) return readOdfChartDocument(inline);
    const href = attr(object, NS.xlink, 'href');
    const folder = href ? href.replace(/^\.\//, '').replace(/\/$/, '') : null;
    if (!folder || folder.includes('..') || typeof this.pkg?.text !== 'function') return null;
    const text = this.pkg.text(`${folder}/content.xml`);
    if (!text) return null;
    try {
      return readOdfChartDocument(parseXml(text, `${folder}/content.xml`).documentElement);
    } catch {
      return null;
    }
  }

  frameImage(frame) {
    const images = kids(frame, NS.draw, 'image');
    if (images.length === 0) return null;
    let bytes = null;
    let name = null;
    for (const image of images) {
      const href = internalHref(attr(image, NS.xlink, 'href'));
      const data = kid(image, NS.office, 'binary-data');
      const ext = href ? extensionOf(href) : sniffExtension(data ? fromBase64(data.textContent) : null);
      if (!DRAWABLE.has(ext)) continue;
      if (data) {
        bytes = fromBase64(data.textContent);
        name = `image.${ext}`;
      } else if (href && this.pkg?.has(href)) {
        bytes = this.pkg.bytes(href);
        name = href.split('/').pop();
      }
      if (bytes) break;
    }
    if (!bytes) {
      const external = images.some((image) => attr(image, NS.xlink, 'href') && !internalHref(attr(image, NS.xlink, 'href')));
      this.losses.add(external
        ? 'Pictures linked from outside the file'
        : 'Pictures in a format the program cannot show, such as WMF or EMF');
      return null;
    }

    const resource = this.uniqueResource(name);
    this.images.set(resource, bytes);
    const width = parseLength(attr(frame, NS.svg, 'width'));
    const height = parseLength(attr(frame, NS.svg, 'height'));
    return {
      kind: 'image',
      style: 'body',
      resource,
      w: Math.max(1, Math.round((width ?? 100) * PX_PER_MM)),
      h: Math.max(1, Math.round((height ?? 75) * PX_PER_MM)),
      align: 'center',
      caption: [],
    };
  }

  uniqueResource(name) {
    const clean = name.replace(/[^\w.-]+/g, '_');
    let candidate = `resources/${clean}`;
    let n = 2;
    while (this.images.has(candidate)) {
      candidate = `resources/${clean.replace(/(\.[^.]*)?$/, `-${n}$1`)}`;
      n += 1;
    }
    return candidate;
  }

  // Page and styles

  page() {
    const master = this.masterPage();
    const layout = master ? this.masterStyles.layouts.get(attr(master, NS.style, 'page-layout-name')) : null;
    const props = {};
    for (const child of kids(layout, NS.style, 'page-layout-properties')) {
      for (const attribute of child.attributes) props[attribute.localName] = attribute.value;
    }
    const width = parseLength(props['page-width']) ?? 210;
    const height = parseLength(props['page-height']) ?? 297;
    const landscape = props['print-orientation'] === 'landscape' || width > height;

    const band = (which) => {
      const style = kid(layout, NS.style, `${which}-style`);
      const bandProps = kid(style, NS.style, 'header-footer-properties');
      if (!bandProps) return 0;
      return (parseLength(attr(bandProps, NS.fo, 'min-height')) ?? 0)
        + (parseLength(attr(bandProps, NS.fo, which === 'header' ? 'margin-bottom' : 'margin-top')) ?? 0);
    };
    const running = this.running(master);
    const hasHeader = ['default', 'first', 'even'].some((w) => running.header[w]);
    const hasFooter = ['default', 'first', 'even'].some((w) => running.footer[w]);
    const margin = (name) => parseLength(props[name]) ?? 20;
    const clamp = (mm) => Math.max(5, Math.min(60, Math.round(mm * 10) / 10));

    return {
      ...pageSizeFields(width, height),
      orientation: landscape ? 'landscape' : 'portrait',
      margins: {
        top: clamp(margin('margin-top') + (hasHeader ? band('header') : 0)),
        bottom: clamp(margin('margin-bottom') + (hasFooter ? band('footer') : 0)),
        left: clamp(margin('margin-left')),
        right: clamp(margin('margin-right')),
      },
      running,
    };
  }

  masterPage() {
    const masters = this.masterStyles.masters;
    const wanted = this.firstMaster ?? 'Standard';
    return masters.find((m) => attr(m, NS.style, 'name') === wanted) ?? masters[0] ?? null;
  }

  running(master) {
    const slot = (name) => {
      const element = kid(master, NS.style, name);
      if (!element || attr(element, NS.style, 'display') === 'false') return null;
      const paragraphs = kids(element).filter((p) => is(p, NS.text, 'p') || is(p, NS.text, 'h'));
      if (paragraphs.length === 0) {
        if (kids(element).length > 0) this.losses.add('Headers and footers laid out as tables or frames, dropped');
        return null;
      }
      const lines = paragraphs.map((p) => fieldText(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (lines.length === 0) return null;
      if (lines.length > 1) this.losses.add('Headers and footers of several lines, joined into one');
      if (paragraphs.some((p) => p.getElementsByTagNameNS(NS.text, 'span').length > 0)) {
        this.losses.add('Formatting inside headers and footers');
      }
      const props = this.masterStyles.resolve('paragraph', attr(paragraphs[0], NS.text, 'style-name'), 'paragraph');
      const align = alignment(props['text-align']);
      return { text: lines.join(' '), align: align === 'justify' ? 'left' : align };
    };

    const running = {
      firstDifferent: false,
      evenDifferent: false,
      header: { default: slot('header'), first: null, even: null },
      footer: { default: slot('footer'), first: null, even: null },
    };
    for (const part of ['header', 'footer']) {
      if (kid(master, NS.style, `${part}-first`)) {
        running.firstDifferent = true;
        running[part].first = slot(`${part}-first`);
      }
      if (kid(master, NS.style, `${part}-left`)) {
        running.evenDifferent = true;
        running[part].even = slot(`${part}-left`);
      }
    }
    for (const part of ['header', 'footer']) {
      if (running.firstDifferent && !kid(master, NS.style, `${part}-first`)) running[part].first = running[part].default;
      if (running.evenDifferent && !kid(master, NS.style, `${part}-left`)) running[part].even = running[part].default;
    }
    return running;
  }

  /** Paper's seven styles, taken from the styles the document used for each. */
  /** The person's own paragraph style a chain of styles names, registered the first time. */
  customStyle(chain) {
    const named = chain.find((style) => !style.automatic);
    if (!named || KNOWN_PARAGRAPH.test(named.name) || KNOWN_PARAGRAPH.test(named.displayName ?? '')) return null;
    const display = named.displayName ?? named.name.replace(/_20_/g, ' ');
    const key = styleKey(display);
    if (!this.customStyles.has(key)) this.customStyles.set(key, { source: named.name, name: display });
    return key;
  }

  /** A paragraph style of the file as a Paper style. */
  styleFrom(source) {
    const text = textLook(this.styles.resolve('paragraph', source, 'text'), this.styles);
    const para = this.styles.resolve('paragraph', source, 'paragraph');
    const style = {
      font: fontKind(text.font, text.generic),
      size: text.size ?? 12,
      bold: !!text.bold,
      italic: !!text.italic,
      lineHeight: lineHeight(para['line-height']),
      spaceBefore: points(para['margin-top']),
      spaceAfter: points(para['margin-bottom']),
    };
    const indent = points(para['margin-left']);
    if (indent > 0) style.indent = indent;
    const first = points(para['text-indent']);
    if (first) style.firstLine = first;
    if (text.underline) style.underline = true;
    if (text.color && text.color !== '#000000') style.color = text.color;
    return style;
  }

  charStyles() {
    const out = {};
    for (const [key, { source, name }] of this.customChars) {
      const props = this.styles.resolve('text', source, 'text');
      const look = textLook(props, this.styles);
      const style = { name };
      for (const mark of ['bold', 'italic', 'underline', 'strike']) if (look[mark]) style[mark] = true;
      if (look.color) style.color = look.color;
      if (look.highlight) style.highlight = look.highlight;
      if (props['font-size'] && !props['font-size'].endsWith('%') && look.size) style.size = look.size;
      if (look.font) style.font = fontKind(look.font, look.generic);
      out[key] = style;
    }
    return out;
  }

  paperStyles() {
    const out = {};
    for (const [key, { source, name }] of this.customStyles) out[key] = { ...this.styleFrom(source), name };
    const wellKnown = {
      body: ['Text_20_body', 'Standard', 'Default_20_Paragraph_20_Style'],
      h1: ['Heading_20_1'],
      h2: ['Heading_20_2'],
      h3: ['Heading_20_3'],
      h4: ['Heading_20_4'],
      quote: ['Quotations'],
      title: ['Title'],
      subtitle: ['Subtitle'],
      hr: ['Horizontal_20_Line'],
      code: ['Preformatted_20_Text'],
    };
    for (const name of PAPER_STYLES) {
      const customSources = new Set([...this.customStyles.values()].map((c) => c.source));
      const used = [...(this.usage.get(name) ?? new Map())].filter(([source]) => !customSources.has(source)).sort((a, b) => b[1] - a[1])[0]?.[0];
      const source = used ?? wellKnown[name].find((candidate) => this.styles.style('paragraph', candidate));
      if (!source) continue;
      const text = textLook(this.styles.resolve('paragraph', source, 'text'), this.styles);
      const para = this.styles.resolve('paragraph', source, 'paragraph');
      const style = {
        font: fontKind(text.font, text.generic),
        size: text.size ?? 12,
        bold: !!text.bold,
        italic: !!text.italic,
        lineHeight: lineHeight(para['line-height']),
        spaceBefore: points(para['margin-top']),
        spaceAfter: points(para['margin-bottom']),
      };
      const indent = points(para['margin-left']);
      if (indent > 0) style.indent = indent;
      if (text.color && text.color !== '#000000') style.color = text.color;
      out[name] = style;
    }
    return out;
  }
}

// Helpers

function paragraph(style, align, runs) {
  return { kind: 'paragraph', style, align, runs: normaliseRuns(runs) };
}

/** Consecutive code paragraphs are one block of several lines, as they were written. */
function mergeCode(blocks) {
  const out = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.kind === 'code' && last?.kind === 'code' && !block.breakBefore) {
      last.runs = normaliseRuns([...last.runs, { text: '\n' }, ...block.runs]);
      continue;
    }
    out.push(block);
  }
  return out;
}

function headingLevel(names) {
  for (const name of names) {
    const match = /^Heading(?:_20_| )?(\d+)$/i.exec(name);
    if (match) return Number(match[1]);
  }
  return null;
}

function alignment(value) {
  switch (value) {
    case 'center': return 'center';
    case 'end': case 'right': return 'right';
    case 'justify': return 'justify';
    default: return 'left';
  }
}

function frameAlign(styles, frame, fallback) {
  const graphic = styles.resolve('graphic', attr(frame, NS.draw, 'style-name'), 'graphic');
  switch (graphic['horizontal-pos']) {
    case 'center': return 'center';
    case 'left': case 'from-left': return 'left';
    case 'right': return 'right';
    default: return fallback === 'justify' ? 'left' : fallback;
  }
}

function points(length) {
  const mm = parseLength(length);
  return mm === null ? 0 : Math.round(mm * PT_PER_MM * 10) / 10;
}

/** A paragraph's own spacing from its automatic style's properties. */
function directPara(props) {
  const para = {};
  if (typeof props['line-height'] === 'string' && props['line-height'].endsWith('%')) para.lineHeight = lineHeight(props['line-height']);
  if (props['margin-top'] !== undefined) para.spaceBefore = points(props['margin-top']);
  if (props['margin-bottom'] !== undefined) para.spaceAfter = points(props['margin-bottom']);
  if (props['margin-left'] !== undefined) para.indent = points(props['margin-left']);
  return normalisePara(para);
}

function lineHeight(value) {
  if (typeof value === 'string' && value.endsWith('%')) {
    return Math.round((parseFloat(value) / 100) * 1.15 * 100) / 100;
  }
  return 1.15;
}


/** A header paragraph's text, with the page fields written as `{page}` and `{pages}`. */
function fieldText(element) {
  let out = '';
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) out += child.nodeValue;
    else if (is(child, NS.text, 'page-number')) out += '{page}';
    else if (is(child, NS.text, 'page-count')) out += '{pages}';
    else if (is(child, NS.text, 's')) out += ' '.repeat(Number(attr(child, NS.text, 'c') ?? 1));
    else if (is(child, NS.text, 'tab')) out += ' ';
    else if (child.nodeType === 1) out += fieldText(child);
  }
  return out;
}

function sniffExtension(bytes) {
  if (!bytes || bytes.length < 4) return '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'bmp';
  if (bytes[0] === 0x3C) return 'svg';
  return '';
}
