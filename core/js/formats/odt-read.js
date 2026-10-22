/** OpenDocument text into the editor's document model. */

import { NS, kids, kid, attr, is } from '../xml.js';
import { parseLength } from '../units.js';
import { normaliseRuns, pageSizeFields } from '../editor/model.js';
import { Losses } from '../losses.js';
import {
  odfDocuments, OdfStyles, textLook, fontKind, internalHref, extensionOf, DRAWABLE, fromBase64,
  outlineNumbered,
} from './odf.js';

const PT_PER_MM = 72 / 25.4;
const PX_PER_MM = 96 / 25.4;
const MARKS = ['bold', 'italic', 'underline', 'strike', 'sup', 'sub'];
const PAPER_STYLES = ['body', 'h1', 'h2', 'h3', 'h4', 'quote', 'code'];

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
    this.firstMaster = null;
  }

  read(content) {
    const body = kid(kid(content.documentElement, NS.office, 'body'), NS.office, 'text');
    if (!body) throw new Error('This document has no text body');
    this.walkBlocks(body, { listLevel: -1 });

    if (this.notes.length > 0) {
      this.blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: '' }], breakBefore: false });
      for (const [index, runs] of this.notes.entries()) {
        this.blocks.push(paragraph('body', 'left', [{ text: `[${index + 1}] ` }, ...runs]));
      }
      this.losses.add('Footnotes and endnotes, moved to the end of the document', this.notes.length);
    }

    const blocks = mergeCode(this.blocks);
    if (blocks.length === 0) blocks.push(paragraph('body', 'left', []));
    return {
      document: {
        version: 1,
        type: 'paper',
        page: this.page(),
        styles: this.paperStyles(),
        fonts: [],
        blocks,
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
        case 'section':
          this.losses.add('Sections, their text kept and their layout dropped');
          this.walkBlocks(node, context);
          return;
        case 'table-of-content':
        case 'alphabetical-index':
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
          this.losses.add('Tracked changes, shown as if accepted');
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
      if (outlineNumbered(this.styles, level)) this.losses.add('Numbered headings, their numbers dropped');
      if (level > 4) this.losses.add('Headings deeper than level 4, made level 4');
      level = Math.max(1, Math.min(level, 4));
      style = `h${level}`;
    } else if (kind === 'quote') {
      style = 'quote';
    } else if (kind === 'code') {
      style = 'code';
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
    const segments = this.inline(node, own, baseline, { ...context, align });

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
      const block = kind === 'heading'
        ? { kind: 'heading', level, style, align, runs }
        : { kind, style, align, runs };
      if (index === 0 && breakBefore) block.breakBefore = true;
      this.blocks.push(block);
    });
  }

  /** A paragraph's content as segments: runs, broken where pictures and line breaks fall. */
  inline(node, paragraphProps, baseline, context) {
    const segments = [{ runs: [] }];
    const state = { lastSpace: true };
    const current = () => segments[segments.length - 1];

    const emit = (text, look) => {
      const run = { text };
      for (const mark of MARKS) if (look[mark] && !baseline[mark]) run[mark] = true;
      if (look.color && look.color !== baseline.color && look.color !== '#000000') run.color = look.color;
      if (look.highlight && look.highlight !== baseline.highlight) run.highlight = look.highlight;
      if (look.size && baseline.size && Math.abs(look.size - baseline.size) > 0.1) run.size = look.size;
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
              walk(child, { ...props, ...this.styles.resolve('text', spanStyle, 'text') });
              continue;
            }
            case 'a':
              this.losses.add('Links, kept as their text');
              walk(child, { ...props, ...this.styles.resolve('text', attr(child, NS.text, 'style-name'), 'text') });
              continue;
            case 'ruby':
              this.losses.add('Reading guides above characters (ruby), kept as the base text');
              walk(kid(child, NS.text, 'ruby-base') ?? child, props);
              continue;
            case 'note': {
              const body = kid(child, NS.text, 'note-body');
              this.notes.push(this.plainRuns(body));
              emit(`[${this.notes.length}]`, { ...look, sup: true });
              state.lastSpace = false;
              continue;
            }
            case 'soft-page-break': case 'bookmark': case 'bookmark-start': case 'bookmark-end':
            case 'reference-mark': case 'reference-mark-start': case 'reference-mark-end':
            case 'change': case 'change-start': case 'change-end': case 'alphabetical-index-mark':
            case 'alphabetical-index-mark-start': case 'alphabetical-index-mark-end':
            case 'toc-mark': case 'toc-mark-start': case 'toc-mark-end':
              continue;
            case 'page-number':
            case 'page-count':
            case 'date':
            case 'time':
            case 'title':
            case 'subject':
            case 'chapter':
            case 'sequence':
            case 'file-name':
            case 'author-name':
            case 'user-defined':
            case 'variable-get':
            case 'variable-set':
            case 'user-field-get':
            case 'bookmark-ref':
            case 'reference-ref':
            case 'sequence-ref':
            case 'note-ref':
              this.losses.add('Fields, kept as the text they showed');
              walk(child, props);
              continue;
            default:
              walk(child, props);
              continue;
          }
        }
        if (is(child, NS.draw, 'frame') || is(child, NS.draw, 'a')) {
          const found = this.frameBlocks(child, context, context.align ?? 'left');
          for (const block of found) segments.push(block.kind === 'image' ? { image: block } : { blocks: [block] });
          if (found.length > 0) segments.push({ runs: [] });
          continue;
        }
        if (child.namespaceURI === NS.office && child.localName === 'annotation') {
          this.losses.add('Comments');
          continue;
        }
        if (child.namespaceURI === NS.office && child.localName === 'annotation-end') continue;
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

  /** Text without formatting, for notes. */
  plainRuns(element) {
    const parts = [];
    for (const p of element ? element.getElementsByTagNameNS(NS.text, 'p') : []) {
      parts.push(p.textContent.replace(/\s+/g, ' ').trim());
    }
    return [{ text: parts.filter(Boolean).join(' ') }];
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
        if (current.listType === null) current.listType = type;
        else if (type !== current.listType) this.losses.add('Lists mixing bullets and numbers, shown with one kind');
        if (entry.level > 5) this.losses.add('Lists nested deeper than six levels, flattened');
        current.items.push({ level: Math.min(entry.level, 5), runs: normaliseRuns(runs) });
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
        entries.push({ kind: 'item', level, listStyle: own || listStyle, paragraphs });
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

  table(node, context) {
    this.losses.add('Tables, kept as text with a tab between cells');
    const rows = node.getElementsByTagNameNS(NS.table, 'table-row');
    for (const row of rows) {
      const cells = kids(row).filter((cell) => is(cell, NS.table, 'table-cell'));
      const text = cells.map((cell) => kids(cell)
        .map((child) => child.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean).join(' ')).join('\t');
      this.blocks.push(paragraph('body', 'left', [{ text }]));
    }
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

    if (kid(frame, NS.draw, 'object') || kid(frame, NS.draw, 'object-ole')) {
      this.losses.add('Charts, formulas and other embedded objects');
      return [];
    }
    return [];
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
  paperStyles() {
    const out = {};
    const wellKnown = {
      body: ['Text_20_body', 'Standard', 'Default_20_Paragraph_20_Style'],
      h1: ['Heading_20_1', 'Title'],
      h2: ['Heading_20_2', 'Subtitle'],
      h3: ['Heading_20_3'],
      h4: ['Heading_20_4'],
      quote: ['Quotations'],
      code: ['Preformatted_20_Text'],
    };
    for (const name of PAPER_STYLES) {
      const used = [...(this.usage.get(name) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0];
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
    if (/^Title$/i.test(name)) return 1;
    if (/^Subtitle$/i.test(name)) return 2;
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
