/** The editor's document model as OpenDocument text, packaged or flat. */

import { tag, xmlDocument } from '../xml.js';
import { formatLength, toMm } from '../units.js';
import { pageDimensions, DEFAULT_PAGE, normaliseRunning, normaliseHeadingNumbers, normaliseNoteSettings } from '../editor/model.js';

/** Paper's number formats as OpenDocument writes them. */
const ODF_NUMBER = { decimal: '1', 'lower-alpha': 'a', 'upper-alpha': 'A', 'lower-roman': 'i', 'upper-roman': 'I' };
import { documentFields, runListsOf, referenceText } from '../editor/fields.js';
import { odfChartDocument, CHART_MIMETYPE } from './chart-object.js';
import { mathmlWithTex, odfFormulaXml, FORMULA_MIMETYPE } from './math-ml.js';
import { Losses } from '../losses.js';
import {
  MIMETYPES, ODF_VERSION, ROOT_NAMESPACES, odfPackage, MEDIA_TYPES, extensionOf, toBase64,
} from './odf.js';

const FONTS = {
  serif: { name: 'Liberation Serif', generic: 'roman', pitch: 'variable' },
  sans: { name: 'Liberation Sans', generic: 'swiss', pitch: 'variable' },
  mono: { name: 'Liberation Mono', generic: 'modern', pitch: 'fixed' },
};

const NAMED = {
  body: { name: 'Text_20_body', display: 'Text body' },
  h1: { name: 'Heading_20_1', display: 'Heading 1', level: 1 },
  h2: { name: 'Heading_20_2', display: 'Heading 2', level: 2 },
  h3: { name: 'Heading_20_3', display: 'Heading 3', level: 3 },
  h4: { name: 'Heading_20_4', display: 'Heading 4', level: 4 },
  quote: { name: 'Quotations', display: 'Quotations' },
  code: { name: 'Preformatted_20_Text', display: 'Preformatted Text' },
  caption: { name: 'Caption', display: 'Caption' },
  title: { name: 'Title', display: 'Title' },
  subtitle: { name: 'Subtitle', display: 'Subtitle' },
  hr: { name: 'Horizontal_20_Line', display: 'Horizontal Line' },
};

const REF_FORMAT = { number: 'category-and-value', text: 'caption', page: 'page' };

const LISTS = {
  bullet: { name: 'List_20_1', display: 'Bullet •' },
  number: { name: 'Numbering_20_123', display: 'Numbering 123' },
};

const pt = (value) => `${Math.round(value * 100) / 100}pt`;
const mmFromPt = (value) => toMm(value, 'pt');
const mmFromPx = (value) => toMm(value, 'px');

/**
 * @param {object} document the model's toJSON()
 * @param {Map<string, Uint8Array>} images resource name to bytes
 * @param {{flat?: boolean}} options
 * @returns {{entries?: object[], text?: string, losses: Losses}}
 */
export function writeOdt(document, images = new Map(), { flat = false } = {}) {
  const writer = new TextWriter(document, images, flat);
  return writer.write();
}

/** Paper's kinds of source as ODF names them. */
const ODF_CITE = { book: 'book', article: 'article', website: 'www', thesis: 'phdthesis', report: 'techreport', misc: 'misc' };

/** The namespaces review needs: Dublin Core for the date a change must carry, and LibreOffice's for comment threads. */
const REVIEW_NAMESPACES = { 'xmlns:dc': 'http://purl.org/dc/elements/1.1/', 'xmlns:loext': 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0' };
/** ODF wants a date on every change; GRT gives the same one to all, as LibreOffice does for changes without a date. */
const NO_DATE = '1970-01-01T00:00:00';

class TextWriter {
  constructor(document, images, flat) {
    this.doc = document;
    this.images = images;
    this.flat = flat;
    this.losses = new Losses();
    this.paragraphStyles = new Map();
    this.textStyles = new Map();
    this.graphicStyles = new Map();
    this.pictures = new Map();
    this.frames = 0;
    this.tableStyles = [];
    this.objects = [];
    this.tableCount = 0;
    this.page = { ...DEFAULT_PAGE, ...(document.page ?? {}), running: normaliseRunning(document.page?.running) };
    this.styles = document.styles ?? {};
    this.customFonts = new Map((document.fonts ?? []).map((font) => [font.id, font]));
  }

  write() {
    this.fields = documentFields({ blocks: this.doc.blocks });
    // A file written from the working document holds the covered text in full; only the redacted export leaves it out.
    if (this.doc.blocks.some((block) => [...runListsOf(block)].some(({ runs }) => runs.some((run) => run.redact)))) {
      this.losses.add('Text marked to be covered, written in full: File, Export Redacted makes a copy without it');
    }
    // Headings a reference points at carry a bookmark for it, as LibreOffice marks them.
    this.headingTargets = new Set();
    for (const block of this.doc.blocks) {
      for (const { runs } of runListsOf(block)) {
        for (const run of runs) if (run.object?.type === 'ref' && run.object.target.startsWith('heading:')) this.headingTargets.add(run.object.target.slice(8));
      }
    }
    const sequences = [...new Set([...this.fields.seqs.values()].map((seq) => seq.name))];
    // The text is written first, so the changes it records are known for the list that leads it.
    this.regions = [];
    this.openComment = null;
    const sections = this.sections();
    const recording = Boolean(this.doc.review?.recording);
    const body = [
      this.regions.length || recording ? tag('text:tracked-changes', { 'text:track-changes': recording ? 'true' : 'false' }, this.regions) : null,
      sequences.length ? tag('text:sequence-decls', {}, sequences.map((name) => tag('text:sequence-decl', { 'text:display-outline-level': '0', 'text:name': name }))) : null,
      ...sections,
    ];
    const master = this.masterPage();

    if (this.flat) {
      const root = tag('office:document', {
        ...ROOT_NAMESPACES,
        ...REVIEW_NAMESPACES,
        'office:version': ODF_VERSION,
        'office:mimetype': MIMETYPES.text,
      },
      this.fontFaces(),
      this.namedStyles(),
      tag('office:automatic-styles', {}, this.automaticStyles(), this.pageLayout(), this.masterAutomatic),
      tag('office:master-styles', {}, master),
      tag('office:body', {}, tag('office:text', {}, body)));
      return { text: xmlDocument(root), losses: this.losses };
    }

    const content = tag('office:document-content', { ...ROOT_NAMESPACES, ...REVIEW_NAMESPACES, 'office:version': ODF_VERSION },
      this.fontFaces(),
      tag('office:automatic-styles', {}, this.automaticStyles()),
      tag('office:body', {}, tag('office:text', {}, body)));
    const styles = tag('office:document-styles', { ...ROOT_NAMESPACES, 'office:version': ODF_VERSION },
      this.fontFaces(),
      this.namedStyles(),
      tag('office:automatic-styles', {}, this.pageLayout(), this.masterAutomatic),
      tag('office:master-styles', {}, master));

    const files = [
      { name: 'content.xml', data: xmlDocument(content), mediaType: 'text/xml' },
      { name: 'styles.xml', data: xmlDocument(styles), mediaType: 'text/xml' },
      ...[...this.pictures].map(([name, bytes]) => ({
        name, data: bytes, mediaType: MEDIA_TYPES[extensionOf(name)] ?? 'application/octet-stream',
      })),
      ...this.fontFiles(),
      ...this.objects.flatMap((object) => [
        { name: `${object.folder}/`, mediaType: object.mediaType ?? CHART_MIMETYPE, manifestOnly: true },
        { name: `${object.folder}/content.xml`, data: object.xml, mediaType: 'text/xml' },
      ]),
    ];
    return { entries: odfPackage(MIMETYPES.text, files), losses: this.losses };
  }

  // Fonts

  fontName(kind) {
    return this.customFonts.get(kind)?.name ?? FONTS[kind]?.name ?? FONTS.serif.name;
  }

  fontFaces() {
    const faces = Object.values(FONTS).map((font) => tag('style:font-face', {
      'style:name': font.name,
      'svg:font-family': `'${font.name}'`,
      'style:font-family-generic': font.generic,
      'style:font-pitch': font.pitch,
    }));
    for (const font of this.customFonts.values()) {
      const embedded = !this.flat && font.resource && this.images.has(font.resource);
      faces.push(tag('style:font-face', {
        'style:name': font.name,
        'svg:font-family': `'${font.name}'`,
      }, embedded ? tag('svg:font-face-src', {},
        tag('svg:font-face-uri', { 'xlink:href': this.fontPath(font), 'xlink:type': 'simple' },
          tag('svg:font-face-format', { 'svg:string': fontFormat(font.resource) }))) : null));
    }
    return tag('office:font-face-decls', {}, faces);
  }

  fontPath(font) {
    return `Fonts/${font.resource.split('/').pop()}`;
  }

  fontFiles() {
    const files = [];
    for (const font of this.customFonts.values()) {
      if (this.flat) {
        this.losses.add('Added fonts, which a flat file does not carry');
        continue;
      }
      const bytes = font.resource ? this.images.get(font.resource) : null;
      if (!bytes) continue;
      files.push({ name: this.fontPath(font), data: bytes, mediaType: MEDIA_TYPES[extensionOf(font.resource)] ?? 'application/octet-stream' });
    }
    return files;
  }

  // Named styles

  textProps(style) {
    const props = {
      'style:font-name': this.fontName(style.font ?? 'serif'),
      'fo:font-size': pt(style.size ?? 11),
      'style:font-size-asian': pt(style.size ?? 11),
      'style:font-size-complex': pt(style.size ?? 11),
    };
    if (style.bold) Object.assign(props, { 'fo:font-weight': 'bold', 'style:font-weight-asian': 'bold', 'style:font-weight-complex': 'bold' });
    if (style.italic) Object.assign(props, { 'fo:font-style': 'italic', 'style:font-style-asian': 'italic', 'style:font-style-complex': 'italic' });
    if (style.color) props['fo:color'] = style.color;
    if (style.underline) Object.assign(props, { 'style:text-underline-style': 'solid', 'style:text-underline-width': 'auto', 'style:text-underline-color': 'font-color' });
    if (style.strike) props['style:text-line-through-style'] = 'solid';
    return tag('style:text-properties', props);
  }

  /** A character style's own properties: only what it sets, the rest left to the paragraph. */
  charProps(style) {
    const props = {};
    if (style.font) props['style:font-name'] = this.fontName(style.font);
    if (style.size) Object.assign(props, { 'fo:font-size': pt(style.size), 'style:font-size-asian': pt(style.size), 'style:font-size-complex': pt(style.size) });
    if (style.bold) Object.assign(props, { 'fo:font-weight': 'bold', 'style:font-weight-asian': 'bold', 'style:font-weight-complex': 'bold' });
    if (style.italic) Object.assign(props, { 'fo:font-style': 'italic', 'style:font-style-asian': 'italic', 'style:font-style-complex': 'italic' });
    if (style.underline) Object.assign(props, { 'style:text-underline-style': 'solid', 'style:text-underline-width': 'auto', 'style:text-underline-color': 'font-color' });
    if (style.strike) props['style:text-line-through-style'] = 'solid';
    if (style.color) props['fo:color'] = style.color;
    if (style.highlight) props['fo:background-color'] = style.highlight;
    return tag('style:text-properties', props);
  }

  /** The name a style of the person's own has in the file. */
  customName(key) {
    return key?.startsWith('c-') && this.styles[key] ? `GRT_${key}` : null;
  }

  paragraphProps(style) {
    const props = {
      'fo:margin-top': formatLength(mmFromPt(style.spaceBefore ?? 0), 'cm'),
      'fo:margin-bottom': formatLength(mmFromPt(style.spaceAfter ?? 0), 'cm'),
      'fo:line-height': `${Math.round(((style.lineHeight ?? 1.5) / 1.15) * 100)}%`,
    };
    if (style.indent) props['fo:margin-left'] = formatLength(mmFromPt(style.indent), 'cm');
    if (style.firstLine) props['fo:text-indent'] = formatLength(mmFromPt(style.firstLine), 'cm');
    if (style.rule) Object.assign(props, { 'fo:border-bottom': '0.06pt solid #808080', 'fo:padding': '0cm' });
    return tag('style:paragraph-properties', props);
  }

  namedStyles() {
    const body = this.styles.body ?? {};
    const styles = [
      tag('style:default-style', { 'style:family': 'paragraph' },
        tag('style:paragraph-properties', { 'style:writing-mode': 'page' }),
        tag('style:text-properties', {
          'style:font-name': this.fontName(body.font ?? 'serif'),
          'fo:font-size': pt(body.size ?? 11),
          'fo:language': 'none',
          'fo:country': 'none',
        })),
      tag('style:style', { 'style:name': 'Standard', 'style:family': 'paragraph', 'style:class': 'text' }),
    ];
    for (const [key, named] of Object.entries(NAMED)) {
      const style = this.styles[key] ?? {};
      styles.push(tag('style:style', {
        'style:name': named.name,
        'style:display-name': named.display,
        'style:family': 'paragraph',
        'style:parent-style-name': 'Standard',
        'style:next-style-name': named.level ? NAMED.body.name : null,
        'style:default-outline-level': named.level ? String(named.level) : null,
        'style:class': named.level ? 'chapter' : 'text',
      }, this.paragraphProps(style), this.textProps(style)));
    }
    // The person's own paragraph and character styles, under the names they gave them.
    for (const [key, style] of Object.entries(this.styles)) {
      if (!key.startsWith('c-')) continue;
      styles.push(tag('style:style', {
        'style:name': `GRT_${key}`, 'style:display-name': style.name ?? key, 'style:family': 'paragraph',
        'style:parent-style-name': NAMED.body.name, 'style:class': 'text',
      }, this.paragraphProps(style), this.textProps(style)));
    }
    for (const [key, style] of Object.entries(this.doc.charStyles ?? {})) {
      styles.push(tag('style:style', { 'style:name': `GRTC_${key}`, 'style:display-name': style.name ?? key, 'style:family': 'text' }, this.charProps(style)));
    }
    styles.push(
      tag('style:style', {
        'style:name': 'Figure', 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'extra',
      }, tag('style:paragraph-properties', { 'fo:text-align': 'center' }),
      tag('style:text-properties', { 'fo:font-size': pt((body.size ?? 11) * 0.85), 'fo:font-style': 'italic' })),
      tag('style:style', { 'style:name': 'Footnote', 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'extra' },
        tag('style:paragraph-properties', { 'fo:margin-left': '0.6cm', 'fo:text-indent': '-0.6cm' }), tag('style:text-properties', { 'fo:font-size': pt((body.size ?? 11) * 0.85) })),
      tag('style:style', { 'style:name': 'Endnote', 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'extra' },
        tag('style:paragraph-properties', { 'fo:margin-left': '0.6cm', 'fo:text-indent': '-0.6cm' }), tag('style:text-properties', { 'fo:font-size': pt((body.size ?? 11) * 0.85) })),
      tag('style:style', { 'style:name': 'Contents_20_Heading', 'style:display-name': 'Contents Heading', 'style:family': 'paragraph', 'style:parent-style-name': NAMED.h2.name, 'style:class': 'index' }),
      tag('style:style', { 'style:name': 'Index_20_Heading', 'style:display-name': 'Index Heading', 'style:family': 'paragraph', 'style:parent-style-name': NAMED.h2.name, 'style:class': 'index' }),
      [1, 2, 3, 4].map((level) => tag('style:style', { 'style:name': `Contents_20_${level}`, 'style:display-name': `Contents ${level}`, 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'index' },
        tag('style:paragraph-properties', { 'fo:margin-left': `${(level - 1) * 0.5}cm` }))),
      [1, 2].map((level) => tag('style:style', { 'style:name': `Index_20_${level}`, 'style:display-name': `Index ${level}`, 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'index' },
        tag('style:paragraph-properties', { 'fo:margin-left': `${(level - 1) * 0.5}cm` }))),
      tag('style:style', { 'style:name': 'Table_20_Contents', 'style:display-name': 'Table Contents', 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'extra' }),
      tag('style:style', { 'style:name': 'Table_20_Heading', 'style:display-name': 'Table Heading', 'style:family': 'paragraph', 'style:parent-style-name': 'Table_20_Contents', 'style:class': 'extra' },
        tag('style:text-properties', { 'fo:font-weight': 'bold', 'style:font-weight-asian': 'bold', 'style:font-weight-complex': 'bold' })),
      tag('style:style', { 'style:name': 'Header', 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'extra' },
        tag('style:text-properties', { 'fo:font-size': pt((body.size ?? 11) * 0.85) })),
      tag('style:style', { 'style:name': 'Footer', 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'extra' },
        tag('style:text-properties', { 'fo:font-size': pt((body.size ?? 11) * 0.85) })),
      tag('style:style', { 'style:name': 'Graphics', 'style:family': 'graphic' },
        tag('style:graphic-properties', {
          'text:anchor-type': 'as-char', 'svg:y': '0cm', 'style:vertical-pos': 'top', 'style:vertical-rel': 'baseline',
        })),
      this.listStyle('bullet'),
      this.listStyle('number'),
      this.outlineStyle(),
      this.notesConfiguration(),
    );
    return tag('office:styles', {}, styles);
  }

  /** Heading numbers, as LibreOffice's chapter numbering. */
  outlineStyle() {
    const numbers = normaliseHeadingNumbers(this.doc.headingNumbers);
    if (!numbers) return null;
    return tag('text:outline-style', { 'style:name': 'Outline' }, Array.from({ length: 10 }, (_, i) => {
      const level = i + 1;
      const on = level <= numbers.depth;
      return tag('text:outline-level-style', {
        'text:level': String(level),
        'style:num-format': on ? ODF_NUMBER[numbers.format] : '',
        'style:num-suffix': on && numbers.after ? numbers.after : null,
        'text:display-levels': on && numbers.full ? String(level) : null,
      }, tag('style:list-level-properties', { 'text:list-level-position-and-space-mode': 'label-alignment' },
        tag('style:list-level-label-alignment', { 'text:label-followed-by': 'listtab' })));
    }));
  }

  /** How footnotes and endnotes count, when it is not the usual way. */
  notesConfiguration() {
    const settings = normaliseNoteSettings(this.doc.noteSettings);
    return [['foot', 'footnote'], ['end', 'endnote']].map(([kind, noteClass]) => tag('text:notes-configuration', {
      'text:note-class': noteClass,
      'style:num-format': ODF_NUMBER[settings[kind].format],
      'text:start-value': String(settings[kind].start - 1),
      ...(kind === 'foot' ? { 'text:footnotes-position': 'page', 'text:start-numbering-at': 'document' } : {}),
    }));
  }

  listStyle(type, variant = null) {
    const named = variant ?? LISTS[type];
    const numFormat = { 'lower-alpha': 'a', 'upper-alpha': 'A', 'lower-roman': 'i', 'upper-roman': 'I' }[named.format] ?? '1';
    const levels = [];
    for (let level = 1; level <= 6; level += 1) {
      const props = tag('style:list-level-properties', { 'text:list-level-position-and-space-mode': 'label-alignment' },
        tag('style:list-level-label-alignment', {
          'text:label-followed-by': 'listtab',
          'text:list-tab-stop-position': formatLength(6.35 * level, 'cm'),
          'fo:text-indent': '-0.635cm',
          'fo:margin-left': formatLength(6.35 * level, 'cm'),
        }));
      levels.push(type === 'bullet'
        ? tag('text:list-level-style-bullet', { 'text:level': String(level), 'text:bullet-char': named.bullet ?? (level % 2 === 1 ? '•' : '◦') }, props)
        : tag('text:list-level-style-number', { 'text:level': String(level), 'style:num-suffix': '.', 'style:num-format': numFormat }, props));
    }
    return tag('text:list-style', { 'style:name': named.name, 'style:display-name': named.display ?? null }, levels);
  }

  // Automatic styles

  paragraphStyle(parent, { align = 'left', breakBefore = false, para = null } = {}) {
    const needsOwn = (align && align !== 'left') || breakBefore || para;
    if (!needsOwn) return parent;
    const key = `${parent}|${align}|${breakBefore}|${JSON.stringify(para ?? {})}`;
    if (!this.paragraphStyles.has(key)) {
      this.paragraphStyles.set(key, { name: `P${this.paragraphStyles.size + 1}`, parent, align, breakBefore, para });
    }
    return this.paragraphStyles.get(key).name;
  }

  textStyle(run) {
    const props = {};
    if (run.bold) Object.assign(props, { 'fo:font-weight': 'bold', 'style:font-weight-asian': 'bold', 'style:font-weight-complex': 'bold' });
    if (run.italic) Object.assign(props, { 'fo:font-style': 'italic', 'style:font-style-asian': 'italic', 'style:font-style-complex': 'italic' });
    if (run.underline || run.double) Object.assign(props, { 'style:text-underline-style': 'solid', 'style:text-underline-width': 'auto', 'style:text-underline-color': 'font-color' });
    if (run.double) props['style:text-underline-type'] = 'double';
    if (run.strike) Object.assign(props, { 'style:text-line-through-style': 'solid', 'style:text-line-through-type': 'single' });
    if (run.overline) Object.assign(props, { 'style:text-overline-style': 'solid', 'style:text-overline-width': 'auto', 'style:text-overline-color': 'font-color' });
    if (run.shadow) props['fo:text-shadow'] = '1pt 1pt';
    if (run.outline) props['style:text-outline'] = 'true';
    if (run.smallcaps) props['fo:font-variant'] = 'small-caps';
    if (run.sup) props['style:text-position'] = 'super 58%';
    else if (run.sub) props['style:text-position'] = 'sub 58%';
    if (run.color) props['fo:color'] = run.color;
    if (run.highlight) props['fo:background-color'] = run.highlight;
    if (run.size) Object.assign(props, { 'fo:font-size': pt(run.size), 'style:font-size-asian': pt(run.size), 'style:font-size-complex': pt(run.size) });
    if (run.lang) {
      const [language, country] = run.lang.split('-');
      Object.assign(props, { 'fo:language': language, 'fo:country': country ?? 'none' });
    }
    if (Object.keys(props).length === 0) return null;
    const key = JSON.stringify(props);
    if (!this.textStyles.has(key)) this.textStyles.set(key, { name: `T${this.textStyles.size + 1}`, props });
    return this.textStyles.get(key).name;
  }

  graphicStyle() {
    if (!this.graphicStyles.has('inline')) this.graphicStyles.set('inline', { name: 'fr1' });
    return 'fr1';
  }

  automaticStyles() {
    const out = [];
    const alignValue = { center: 'center', right: 'end', justify: 'justify', left: 'start' };
    for (const style of this.paragraphStyles.values()) {
      const props = {};
      if (style.align && style.align !== 'left') props['fo:text-align'] = alignValue[style.align];
      if (style.breakBefore) props['fo:break-before'] = 'page';
      const para = style.para ?? {};
      if (para.spaceBefore !== undefined) props['fo:margin-top'] = formatLength(mmFromPt(para.spaceBefore), 'cm');
      if (para.spaceAfter !== undefined) props['fo:margin-bottom'] = formatLength(mmFromPt(para.spaceAfter), 'cm');
      if (para.lineHeight !== undefined) props['fo:line-height'] = `${Math.round((para.lineHeight / 1.15) * 100)}%`;
      if (para.indent !== undefined) props['fo:margin-left'] = formatLength(mmFromPt(para.indent), 'cm');
      out.push(tag('style:style', {
        'style:name': style.name, 'style:family': 'paragraph', 'style:parent-style-name': style.parent,
      }, tag('style:paragraph-properties', props)));
    }
    for (const style of this.textStyles.values()) {
      out.push(tag('style:style', { 'style:name': style.name, 'style:family': 'text' }, tag('style:text-properties', style.props)));
    }
    out.push(...this.tableStyles);
    out.push(...(this.listVariants?.values() ?? []));
    for (const style of this.graphicStyles.values()) {
      out.push(tag('style:style', { 'style:name': style.name, 'style:family': 'graphic', 'style:parent-style-name': 'Graphics' },
        tag('style:graphic-properties', { 'style:vertical-pos': 'top', 'style:vertical-rel': 'baseline' })));
    }
    return out;
  }

  // Page

  pageLayout() {
    const size = pageDimensions(this.page);
    const landscape = this.page.orientation === 'landscape';
    const width = landscape ? size.h : size.w;
    const height = landscape ? size.w : size.h;
    const m = this.page.margins;
    const running = this.page.running;
    const has = (part) => ['default', 'first', 'even'].some((which) => running[part][which]);

    const band = (margin) => ({ edge: margin * 0.4, height: margin * 0.35, gap: margin * 0.25 });
    const top = has('header') ? band(m.top) : null;
    const bottom = has('footer') ? band(m.bottom) : null;

    const bandStyle = (name, measure, gapSide) => tag(`style:${name}-style`, {},
      measure ? tag('style:header-footer-properties', {
        'fo:min-height': formatLength(measure.height, 'cm'),
        [`fo:${gapSide}`]: formatLength(measure.gap, 'cm'),
        'fo:margin-left': '0cm',
        'fo:margin-right': '0cm',
        'style:dynamic-spacing': 'false',
      }) : null);

    return tag('style:page-layout', { 'style:name': 'Mpm1' },
      tag('style:page-layout-properties', {
        'fo:page-width': formatLength(width, 'cm'),
        'fo:page-height': formatLength(height, 'cm'),
        'style:num-format': '1',
        'style:print-orientation': landscape ? 'landscape' : 'portrait',
        'fo:margin-top': formatLength(top ? top.edge : m.top, 'cm'),
        'fo:margin-bottom': formatLength(bottom ? bottom.edge : m.bottom, 'cm'),
        'fo:margin-left': formatLength(m.left, 'cm'),
        'fo:margin-right': formatLength(m.right, 'cm'),
        'style:writing-mode': 'lr-tb',
      }),
      bandStyle('header', top, 'margin-bottom'),
      bandStyle('footer', bottom, 'margin-top'));
  }

  masterPage() {
    const running = this.page.running;
    this.masterAutomatic = [];
    const alignStyles = new Map();
    const alignValue = { center: 'center', right: 'end', left: 'start' };

    const paragraphFor = (part, slot) => {
      const parent = part === 'header' ? 'Header' : 'Footer';
      const key = `${parent}|${slot.align}`;
      if (!alignStyles.has(key)) {
        const name = `MP${alignStyles.size + 1}`;
        alignStyles.set(key, name);
        this.masterAutomatic.push(tag('style:style', {
          'style:name': name, 'style:family': 'paragraph', 'style:parent-style-name': parent,
        }, tag('style:paragraph-properties', { 'fo:text-align': alignValue[slot.align] ?? 'center' })));
      }
      return tag('text:p', { 'text:style-name': alignStyles.get(key) }, slotContent(slot.text));
    };
    const band = (part, which, element) => {
      const slot = running[part][which];
      return tag(element, {}, slot ? paragraphFor(part, slot) : tag('text:p', { 'text:style-name': part === 'header' ? 'Header' : 'Footer' }));
    };

    const children = [];
    for (const part of ['header', 'footer']) {
      const slots = running[part];
      const any = slots.default || (running.evenDifferent && slots.even) || (running.firstDifferent && slots.first);
      if (!any) continue;
      children.push(band(part, 'default', `style:${part}`));
      if (running.evenDifferent) children.push(band(part, 'even', `style:${part}-left`));
      if (running.firstDifferent) children.push(band(part, 'first', `style:${part}-first`));
    }
    return tag('style:master-page', { 'style:name': 'Standard', 'style:page-layout-name': 'Mpm1' }, children);
  }

  // Body

  block(block) {
    switch (block.kind) {
      case 'heading': {
        const level = Math.max(1, Math.min(block.level ?? 1, 4));
        const style = this.paragraphStyle(NAMED[`h${level}`].name, block);
        const mark = this.headingTargets.has(block.id) ? tag('text:bookmark', { 'text:name': `__RefHeading__${block.id}` }) : null;
        return [tag('text:h', { 'text:style-name': style, 'text:outline-level': String(level) }, mark, this.runs(block.runs))];
      }
      case 'quote':
        return [tag('text:p', { 'text:style-name': this.paragraphStyle(NAMED.quote.name, block) }, this.runs(block.runs))];
      case 'code': {
        const lines = splitLines(block.runs);
        return lines.map((runs, i) => tag('text:p', {
          'text:style-name': this.paragraphStyle(NAMED.code.name, { breakBefore: i === 0 && block.breakBefore }),
        }, this.runs(runs, { keepNewlines: false })));
      }
      case 'list':
        return [this.list(block)];
      case 'image':
        return this.image(block);
      case 'table':
        return [this.table(block)];
      case 'toc':
      case 'index':
        return [this.generated(block)];
      case 'chart':
        return [this.chart(block)];
      default: {
        if (!['paragraph', 'heading', 'quote', 'code', 'list', 'image'].includes(block.kind)) {
          return this.foreign(block);
        }
        const named = this.customName(block.style) ?? NAMED[block.style]?.name ?? NAMED.body.name;
        return [tag('text:p', { 'text:style-name': this.paragraphStyle(named, block) }, this.runs(block.runs))];
      }
    }
  }

  /** The body: blocks after a section mark of several columns go inside a section that flows in them. */
  sections() {
    const out = [];
    let section = null;
    for (const block of this.doc.blocks) {
      if (block.kind === 'section') {
        section = null;
        if (block.columns > 1) {
          this.sectionCount = (this.sectionCount ?? 0) + 1;
          const name = `Sect${this.sectionCount}`;
          this.tableStyles.push(tag('style:style', { 'style:name': name, 'style:family': 'section' },
            tag('style:section-properties', { 'text:dont-balance-text-columns': 'false' },
              tag('style:columns', { 'fo:column-count': String(block.columns), 'fo:column-gap': `${(block.gap ?? 6).toFixed(2)}mm` }))));
          section = tag('text:section', { 'text:style-name': name, 'text:name': `Section${this.sectionCount}` });
          out.push(section);
        }
        continue;
      }
      const elements = this.block(block);
      if (section) section.children.push(...elements);
      else out.push(...elements);
    }
    return out;
  }

  /** A table: its width the text column's, its columns in proportion, its borders on each cell. */
  table(block) {
    this.tableCount += 1;
    const name = `Table${this.tableCount}`;
    const size = pageDimensions(this.page);
    const landscape = this.page.orientation === 'landscape';
    const content = (landscape ? size.h : size.w) - this.page.margins.left - this.page.margins.right;
    const cols = block.rows[0]?.cells.length ?? 1;
    const total = block.widths.reduce((a, b) => a + b, 0) || cols;
    this.tableStyles.push(tag('style:style', { 'style:name': name, 'style:family': 'table' },
      tag('style:table-properties', { 'style:width': `${content.toFixed(2)}mm`, 'table:align': 'margins', 'fo:break-before': block.breakBefore ? 'page' : null })));
    const columns = block.widths.map((width, c) => {
      const columnName = `${name}.C${c + 1}`;
      this.tableStyles.push(tag('style:style', { 'style:name': columnName, 'style:family': 'table-column' },
        tag('style:table-column-properties', { 'style:column-width': `${((content * width) / total).toFixed(2)}mm`, 'style:rel-column-width': `${Math.round((width / total) * 65535)}*` })));
      return tag('table:table-column', { 'table:style-name': columnName });
    });
    // One cell style per look a cell has: which of its sides have a line, and its background.
    const cellStyles = new Map();
    const line = '0.5pt solid #000000';
    const cellStyle = (r, c, cell) => {
      const span = { rows: cell.rowspan ?? 1, cols: cell.colspan ?? 1 };
      const edge = { top: r === 0, left: c === 0, bottom: r + span.rows >= block.rows.length, right: c + span.cols >= cols };
      const sides = {};
      for (const side of ['top', 'right', 'bottom', 'left']) {
        sides[side] = block.borders === 'all' || (block.borders === 'outer' && edge[side]) || (block.borders === 'rows' && side === 'top' && !edge.top);
      }
      const key = JSON.stringify([sides, cell.bg ?? null, cell.valign ?? null]);
      if (!cellStyles.has(key)) {
        const styleName = `${name}.cell${cellStyles.size + 1}`;
        const props = { 'fo:padding': '0.1cm', 'fo:background-color': cell.bg ?? null, 'style:vertical-align': cell.valign ?? null };
        for (const [side, on] of Object.entries(sides)) props[`fo:border-${side}`] = on ? line : 'none';
        this.tableStyles.push(tag('style:style', { 'style:name': styleName, 'style:family': 'table-cell' }, tag('style:table-cell-properties', props)));
        cellStyles.set(key, styleName);
      }
      return cellStyles.get(key);
    };
    const rowElement = (row, r) => tag('table:table-row', {}, row.cells.map((cell, c) => (cell.covered
      ? tag('table:covered-table-cell', {})
      : tag('table:table-cell', {
        'table:style-name': cellStyle(r, c, cell), 'office:value-type': 'string',
        'table:number-columns-spanned': cell.colspan > 1 ? String(cell.colspan) : null,
        'table:number-rows-spanned': cell.rowspan > 1 ? String(cell.rowspan) : null,
      }, tag('text:p', { 'text:style-name': this.paragraphStyle(row.header ? 'Table_20_Heading' : 'Table_20_Contents', { align: cell.align ?? 'left' }) }, this.runs(cell.runs))))));
    const headerCount = block.rows.findIndex((row) => !row.header);
    const heads = headerCount === -1 ? block.rows.length : headerCount;
    return tag('table:table', { 'table:name': name, 'table:style-name': name },
      columns,
      heads > 0 ? tag('table:table-header-rows', {}, block.rows.slice(0, heads).map((row, r) => rowElement(row, r))) : null,
      block.rows.slice(heads).map((row, r) => rowElement(row, r + heads)));
  }

  /** The table of contents or the index, its entries as they stand; LibreOffice adds the page numbers when it updates them. */
  generated(block) {
    const title = tag('text:index-title', { 'text:name': `${block.title}_Head` }, tag('text:p', { 'text:style-name': block.kind === 'toc' ? 'Contents_20_Heading' : 'Index_20_Heading' }, block.title));
    if (block.kind === 'toc') {
      this.tocCount = (this.tocCount ?? 0) + 1;
      const entries = this.fields.headings.filter((h) => h.level <= block.levels && h.text)
        .map((h) => tag('text:p', { 'text:style-name': `Contents_20_${h.level}` }, h.number ? `${h.number} ${h.text}` : h.text));
      return tag('text:table-of-content', { 'text:name': `Table of Contents${this.tocCount}` },
        tag('text:table-of-content-source', { 'text:outline-level': String(block.levels) },
          tag('text:index-title-template', { 'text:style-name': 'Contents_20_Heading' }, block.title),
          Array.from({ length: block.levels }, (_, i) => tag('text:table-of-content-entry-template', { 'text:outline-level': String(i + 1), 'text:style-name': `Contents_20_${i + 1}` },
            tag('text:index-entry-link-start', {}), tag('text:index-entry-chapter', {}), tag('text:index-entry-text', {}),
            tag('text:index-entry-tab-stop', { 'style:type': 'right', 'style:leader-char': '.' }), tag('text:index-entry-page-number', {}), tag('text:index-entry-link-end', {})))),
        tag('text:index-body', {}, title, entries));
    }
    this.indexCount = (this.indexCount ?? 0) + 1;
    const terms = [...new Set(this.fields.entries.map((e) => (e.sub ? `${e.term}, ${e.sub}` : e.term)))].sort((a, b) => a.localeCompare(b));
    return tag('text:alphabetical-index', { 'text:name': `Alphabetical Index${this.indexCount}` },
      tag('text:alphabetical-index-source', { 'text:main-entry-style-name': 'Main_20_index_20_entry' },
        tag('text:index-title-template', { 'text:style-name': 'Index_20_Heading' }, block.title),
        [1, 2].map((level) => tag('text:alphabetical-index-entry-template', { 'text:outline-level': String(level), 'text:style-name': `Index_20_${level}` },
          tag('text:index-entry-text', {}), tag('text:index-entry-tab-stop', { 'style:type': 'right', 'style:leader-char': '.' }), tag('text:index-entry-page-number', {})))),
      tag('text:index-body', {}, title, terms.map((term) => tag('text:p', { 'text:style-name': 'Index_20_1' }, term))));
  }

  /** A chart with its data in it, as an embedded chart object LibreOffice can edit. */
  chart(block) {
    this.frames += 1;
    const folder = `Object ${this.objects.length + 1}`;
    const size = { width: block.w ?? 480, height: block.h ?? 300 };
    if (!this.flat) this.objects.push({ folder, xml: xmlDocument(odfChartDocument(block, size)) });
    const frame = tag('draw:frame', {
      'draw:style-name': this.graphicStyle(), 'draw:name': block.title || `Chart${this.frames}`, 'text:anchor-type': 'as-char',
      'svg:width': formatLength(mmFromPx(size.width), 'cm'), 'svg:height': formatLength(mmFromPx(size.height), 'cm'), 'draw:z-index': '0',
    }, tag('draw:object', this.flat ? {} : { 'xlink:href': `./${folder}`, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad' },
      this.flat ? odfChartDocument(block, { ...size, inline: true }) : null));
    if (block.link) this.losses.add('Charts taking their data from a spreadsheet, kept with the data they had');
    return tag('text:p', { 'text:style-name': this.paragraphStyle('Standard', { align: block.align ?? 'center', breakBefore: block.breakBefore }) }, frame);
  }

  /** An object of the text as the OpenDocument element that does the same. */
  object(run) {
    const object = run.object;
    switch (object.type) {
      case 'note': {
        const label = this.fields.notes.get(object)?.label ?? '1';
        this.noteCount = (this.noteCount ?? 0) + 1;
        return tag('text:note', { 'text:id': `ftn${this.noteCount}`, 'text:note-class': object.kind === 'end' ? 'endnote' : 'footnote' },
          tag('text:note-citation', object.mark ? { 'text:label': object.mark } : {}, label),
          tag('text:note-body', {}, tag('text:p', { 'text:style-name': object.kind === 'end' ? 'Endnote' : 'Footnote' }, this.runs(object.runs, { comments: false }))));
      }
      case 'bookmark':
        return tag('text:bookmark', { 'text:name': object.name });
      case 'math': {
        // A formula is an object of its own, its MathML holding the TeX it was typed as.
        this.frames += 1;
        const folder = `Object ${this.objects.length + 1}`;
        if (!this.flat) this.objects.push({ folder, xml: odfFormulaXml(object), mediaType: FORMULA_MIMETYPE });
        const length = (object.tex ?? object.mathml ?? '').length;
        return tag('draw:frame', {
          'draw:style-name': this.graphicStyle(), 'draw:name': `Formula${this.frames}`, 'text:anchor-type': 'as-char',
          'svg:width': `${Math.min(16, 0.4 + length * 0.18).toFixed(2)}cm`, 'svg:height': object.display ? '1.2cm' : '0.6cm', 'draw:z-index': '0',
        }, tag('draw:object', this.flat ? {} : { 'xlink:href': `./${folder}`, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad' },
          this.flat ? { raw: mathmlWithTex(object) } : null));
      }
      case 'seq': {
        const seq = this.fields.seqs.get(object.id);
        return tag('text:sequence', { 'text:ref-name': object.id, 'text:name': object.name, 'text:formula': `ooow:${object.name}+1`, 'style:num-format': '1' }, String(seq?.number ?? 1));
      }
      case 'ref': {
        const shown = object.show === 'page' ? '1' : referenceText(object, this.fields);
        if (this.fields.seqs.has(object.target)) {
          return tag('text:sequence-ref', { 'text:reference-format': REF_FORMAT[object.show], 'text:ref-name': object.target }, shown);
        }
        const name = object.target.startsWith('heading:') ? `__RefHeading__${object.target.slice(8)}` : object.target;
        return tag('text:bookmark-ref', { 'text:reference-format': object.show === 'page' ? 'page' : 'text', 'text:ref-name': name }, shown);
      }
      case 'field':
        if (object.field === 'page') return tag('text:page-number', { 'text:select-page': 'current' }, '1');
        if (object.field === 'pages') return tag('text:page-count', {}, '1');
        if (object.field === 'date') return tag('text:date', {}, new Date().toISOString().slice(0, 10));
        if (object.field === 'time') return tag('text:time', {}, new Date().toTimeString().slice(0, 5));
        return tag('text:chapter', { 'text:display': 'name', 'text:outline-level': '1' }, '');
      case 'merge':
        return tag('text:database-display', { 'text:table-name': 'Data', 'text:table-type': 'table', 'text:column-name': object.name }, `<${object.name}>`);
      case 'cite':
        return tag('text:bibliography-mark', {
          'text:identifier': object.key, 'text:bibliography-type': ODF_CITE[object.kind] ?? 'book',
          'text:author': object.author ?? null, 'text:title': object.title ?? null, 'text:year': object.year ?? null,
          'text:publisher': object.publisher ?? null, 'text:url': object.url ?? null,
        }, `[${object.key}]`);
      case 'comment': {
        // A thread is the comment and, after it, each reply naming it as its parent; no names, no dates.
        const name = `__Annotation__${object.id}`;
        const paragraphs = (text) => String(text).split('\n').map((line) => tag('text:p', {}, this.runs([{ text: line }], { changes: false, comments: false })));
        return [
          tag('office:annotation', { 'office:name': name, 'loext:resolved': object.done ? 'true' : null }, paragraphs(object.text)),
          ...(object.replies ?? []).map((reply) => tag('office:annotation', {
            'office:name': `__Annotation__${reply.id}`, 'loext:parent-name': name, 'loext:resolved': reply.done ? 'true' : null,
          }, paragraphs(reply.text))),
        ];
      }
      case 'index':
        return object.sub
          ? tag('text:alphabetical-index-mark', { 'text:string-value': object.sub, 'text:key1': object.term })
          : tag('text:alphabetical-index-mark', { 'text:string-value': object.term });
      default:
        return null;
    }
  }

  /** Block kinds belonging to another program, such as Notes' to-dos. */
  foreign(block) {
    if (block.kind === 'todo') {
      const box = block.done ? '☑ ' : '☐ ';
      return [tag('text:p', { 'text:style-name': this.paragraphStyle(NAMED.body.name, block) }, box, this.runs(block.runs))];
    }
    if (block.kind === 'callout') {
      return [tag('text:p', { 'text:style-name': this.paragraphStyle(NAMED.quote.name, block) }, this.runs(block.runs))];
    }
    if (block.kind === 'embed') {
      this.losses.add('Links to other documents, kept as their path');
      return [tag('text:p', { 'text:style-name': NAMED.body.name }, block.target ?? '')];
    }
    this.losses.add(`Blocks of a kind ${block.kind} that has no OpenDocument form`);
    return block.runs ? [tag('text:p', { 'text:style-name': NAMED.body.name }, this.runs(block.runs))] : [];
  }

  list(block) {
    const type = block.listType === 'number' ? 'number' : 'bullet';
    let named = LISTS[type].name;
    // A list counting in letters or numerals, or with a bullet of its own, gets a list style of its own.
    const variant = type === 'number' ? block.format : block.bullet;
    if (variant) {
      this.listVariants ??= new Map();
      const key = `${type}:${variant}`;
      if (!this.listVariants.has(key)) {
        const name = `LV${this.listVariants.size + 1}`;
        this.listVariants.set(key, this.listStyle(type, { name, ...(type === 'number' ? { format: variant } : { bullet: variant }) }));
      }
      named = this.listVariants.get(key).attrs['style:name'];
    }
    const paragraphStyle = this.paragraphStyle(NAMED.body.name, { align: block.align, breakBefore: block.breakBefore, para: block.para });
    const root = tag('text:list', { 'text:style-name': named });
    const stack = [{ level: 0, list: root, item: null }];
    for (const item of block.items) {
      const level = Math.max(0, Math.min(item.level ?? 0, 5));
      while (level > stack[stack.length - 1].level) {
        const top = stack[stack.length - 1];
        if (!top.item) {
          top.item = tag('text:list-item', {});
          top.list.children.push(top.item);
        }
        const nested = tag('text:list', {});
        top.item.children.push(nested);
        stack.push({ level: top.level + 1, list: nested, item: null });
      }
      while (level < stack[stack.length - 1].level) stack.pop();
      const top = stack[stack.length - 1];
      top.item = tag(item.unnumbered ? 'text:list-header' : 'text:list-item', item.restart && !item.unnumbered ? { 'text:start-value': '1' } : {},
        tag('text:p', { 'text:style-name': paragraphStyle }, this.runs(item.runs)));
      top.list.children.push(top.item);
    }
    return root;
  }

  image(block) {
    const bytes = this.images.get(block.resource);
    if (!bytes) {
      this.losses.add('Pictures whose file was missing');
      return [];
    }
    const name = `Pictures/${block.resource.split('/').pop()}`;
    this.pictures.set(name, bytes);
    this.frames += 1;
    const width = formatLength(mmFromPx(block.w ?? 400), 'cm');
    const height = formatLength(mmFromPx(block.h ?? 260), 'cm');
    const ext = extensionOf(name);
    const picture = tag('draw:frame', {
      'draw:style-name': this.graphicStyle(),
      'draw:name': `Image${this.frames}`,
      'text:anchor-type': 'as-char',
      'svg:width': width,
      'svg:height': height,
      'draw:z-index': '0',
    }, this.flat
      ? tag('draw:image', { 'draw:mime-type': MEDIA_TYPES[ext] ?? null }, tag('office:binary-data', {}, toBase64(bytes)))
      : tag('draw:image', {
        'xlink:href': name, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad',
        'draw:mime-type': MEDIA_TYPES[ext] ?? null,
      }));

    const style = this.paragraphStyle('Standard', { align: block.align ?? 'center', breakBefore: block.breakBefore });
    const caption = (block.caption ?? []).map((run) => run.text).join('');
    if (!caption) return [tag('text:p', { 'text:style-name': style }, picture)];

    this.frames += 1;
    return [tag('text:p', { 'text:style-name': style },
      tag('draw:frame', {
        'draw:style-name': this.graphicStyle(),
        'draw:name': `Frame${this.frames}`,
        'text:anchor-type': 'as-char',
        'svg:width': width,
        'draw:z-index': '0',
      }, tag('draw:text-box', { 'fo:min-height': height },
        tag('text:p', { 'text:style-name': 'Figure' }, picture, tag('text:line-break', {}), this.runs(block.caption)))))];
  }

  /** Runs as spans, spaces ODF would collapse written as text:s. */
  runs(list, { keepNewlines = true, changes = true, comments = true } = {}) {
    const runs = list ?? [];
    const out = [];
    let afterSpace = true;
    let insertion = null;
    const closeInsertion = () => {
      if (insertion) out.push(tag('text:change-end', { 'text:change-id': insertion.region }));
      insertion = null;
    };
    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i];
      if (!run.text) continue;
      // The stretch a comment is about ends where its runs do.
      if (comments && this.openComment && run.cmt !== this.openComment && !run.object) {
        out.push(tag('office:annotation-end', { 'office:name': `__Annotation__${this.openComment}` }));
        this.openComment = null;
      }
      if (comments && run.cmt && !this.openComment && !run.object) this.openComment = run.cmt;
      if (changes) {
        if (run.del) {
          // Text taken out goes into the change's record; where it stood, a mark.
          closeInsertion();
          const group = [run];
          while (runs[i + 1]?.del && runs[i + 1].del === run.del) group.push(runs[(i += 1)]);
          const region = this.region('deletion', run.chgnote, tag('text:p', {}, this.runs(group.map(({ del: _d, chgnote: _n, cmt: _c, ...rest }) => rest), { changes: false, comments: false })));
          out.push(tag('text:change', { 'text:change-id': region }));
          continue;
        }
        if (run.ins && insertion?.id !== run.ins) {
          closeInsertion();
          insertion = { id: run.ins, region: this.region('insertion', run.chgnote) };
          out.push(tag('text:change-start', { 'text:change-id': insertion.region }));
        } else if (!run.ins) closeInsertion();
      }
      if (run.object) {
        out.push(this.object(run));
        afterSpace = false;
        continue;
      }
      const content = [];
      let text = '';
      let spaces = 0;
      const flushSpaces = () => {
        if (spaces > 0) content.push(tag('text:s', spaces > 1 ? { 'text:c': String(spaces) } : {}));
        spaces = 0;
      };
      const flushText = () => {
        if (text) content.push(text);
        text = '';
      };
      for (const char of run.text) {
        if (char === ' ') {
          if (afterSpace) {
            flushText();
            spaces += 1;
          } else {
            text += ' ';
            afterSpace = true;
          }
        } else if (char === '\t' || (char === '\n' && keepNewlines)) {
          flushText();
          flushSpaces();
          content.push(tag(char === '\t' ? 'text:tab' : 'text:line-break', {}));
          afterSpace = char === '\n';
        } else {
          flushSpaces();
          text += char === '\n' ? ' ' : char;
          afterSpace = char === '\n';
        }
      }
      flushText();
      flushSpaces();
      const style = this.textStyle(run);
      const direct = style ? tag('text:span', { 'text:style-name': style }, content) : content;
      const span = run.cstyle && this.doc.charStyles?.[run.cstyle] ? tag('text:span', { 'text:style-name': `GRTC_${run.cstyle}` }, direct) : direct;
      out.push(run.link ? tag('text:a', { 'xlink:type': 'simple', 'xlink:href': run.link }, span) : span);
    }
    closeInsertion();
    return out;
  }

  /** A recorded change for the list at the head of the text: what it is, a fixed date as the format asks, its note. */
  region(kind, note, content = null) {
    const id = `ct${this.regions.length + 1}`;
    this.regions.push(tag('text:changed-region', { 'xml:id': id, 'text:id': id }, tag(`text:${kind}`, {},
      tag('office:change-info', {}, tag('dc:date', {}, NO_DATE), note ? note.split('\n').map((line) => tag('text:p', {}, line)) : null),
      content)));
    return id;
  }
}

/** The text of a slot, with `{page}` and `{pages}` as fields. */
function slotContent(text) {
  const out = [];
  for (const piece of text.split(/(\{page\}|\{pages\})/)) {
    if (piece === '{page}') out.push(tag('text:page-number', { 'text:select-page': 'current' }, '1'));
    else if (piece === '{pages}') out.push(tag('text:page-count', {}, '1'));
    else if (piece) out.push(piece);
  }
  return out;
}

/** A run list split at its line breaks, formatting kept. */
function splitLines(runs) {
  const lines = [[]];
  for (const run of runs ?? []) {
    const parts = run.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ ...run, text: part });
    });
  }
  return lines;
}

function fontFormat(resource) {
  const ext = extensionOf(resource);
  return { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[ext] ?? 'truetype';
}

