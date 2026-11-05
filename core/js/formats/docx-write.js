/** The editor's document model as a Word document, with no document properties. */

import { NS, tag, xmlDocument } from '../xml.js';
import { fromMm } from '../units.js';
import { pageDimensions, DEFAULT_PAGE, normaliseRunning, normaliseHeadingNumbers, normaliseNoteSettings } from '../editor/model.js';
import { documentFields, runListsOf, referenceText } from '../editor/fields.js';
import { ooxmlChartPart, OOXML_CHART_TYPE, REL_CHART, C as CHART } from './chart-object.js';
import { mathmlToOmml, OMML } from './math-ml.js';
import { Losses } from '../losses.js';
import { REL, relsXml, contentTypesXml, IMAGE_TYPES, EMU_PER_PX } from './ooxml.js';
import { extensionOf } from './odf.js';

const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const FONTS = { serif: 'Liberation Serif', sans: 'Liberation Sans', mono: 'Liberation Mono' };

/** Paper's number formats as Word writes them. */
const WORD_NUMBER = { decimal: 'decimal', 'lower-alpha': 'lowerLetter', 'upper-alpha': 'upperLetter', 'lower-roman': 'lowerRoman', 'upper-roman': 'upperRoman' };
/** The numbering the headings share, kept apart from the lists' numbers. */
const OUTLINE_NUM = '9000';

const STYLE_IDS = {
  body: { id: 'Normal', name: 'Normal' },
  h1: { id: 'Heading1', name: 'heading 1', level: 0 },
  h2: { id: 'Heading2', name: 'heading 2', level: 1 },
  h3: { id: 'Heading3', name: 'heading 3', level: 2 },
  h4: { id: 'Heading4', name: 'heading 4', level: 3 },
  quote: { id: 'Quote', name: 'Quote' },
  code: { id: 'HTMLPreformatted', name: 'HTML Preformatted' },
  title: { id: 'Title', name: 'Title' },
  subtitle: { id: 'Subtitle', name: 'Subtitle' },
  hr: { id: 'HorizontalLine', name: 'Horizontal Line' },
};

/** The cell whose span covers a covered cell, with its row and column. */
function ownerOf(block, r, c) {
  for (let row = r; row >= 0; row -= 1) {
    for (let col = c; col >= 0; col -= 1) {
      const cell = block.rows[row].cells[col];
      if (!cell.covered && row + (cell.rowspan ?? 1) > r && col + (cell.colspan ?? 1) > c) return { cell, row, col };
    }
  }
  return null;
}

/** The Word style id of a paragraph style of the person's own. */
const customId = (key, styles) => (key?.startsWith('c-') && styles[key] ? `GRT${key.slice(2).replace(/[^A-Za-z0-9]/g, '')}` : null);
const charId = (key) => `GRTC${String(key).slice(2).replace(/[^A-Za-z0-9]/g, '')}`;

const twips = (mm) => String(Math.round(fromMm(mm, 'twip')));
const halfPoints = (pt) => String(Math.round(pt * 2));
const twipsFromPt = (pt) => String(Math.round(pt * 20));
const ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'both' };

/** A bookmark name Word accepts: letters, digits and underscores, at most forty. */
const bookmarkName = (name) => String(name).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 40);
const refName = (id) => bookmarkName(`_Ref_${id}`);

/** A complex field: the instruction, then the text it shows until Word or LibreOffice updates it. */
function complexField(instr, shown, props = null) {
  const run = (...children) => tag('w:r', {}, props, children);
  return [
    run(tag('w:fldChar', { 'w:fldCharType': 'begin' })),
    run(tag('w:instrText', { 'xml:space': 'preserve' }, ` ${instr} `)),
    run(tag('w:fldChar', { 'w:fldCharType': 'separate' })),
    run(textPieces(shown)),
    run(tag('w:fldChar', { 'w:fldCharType': 'end' })),
  ];
}

/**
 * @param {object} document the model's toJSON()
 * @param {Map<string, Uint8Array>} images resource name to bytes
 * @returns {{entries: object[], losses: Losses}}
 */
export function writeDocx(document, images = new Map()) {
  return new WordWriter(document, images).write();
}

class WordWriter {
  constructor(document, images) {
    this.doc = document;
    this.images = images;
    this.losses = new Losses();
    this.page = { ...DEFAULT_PAGE, ...(document.page ?? {}), running: normaliseRunning(document.page?.running) };
    this.styles = document.styles ?? {};
    this.headingNumbers = normaliseHeadingNumbers(document.headingNumbers);
    this.noteSettings = normaliseNoteSettings(document.noteSettings);
    this.fonts = new Map((document.fonts ?? []).map((font) => [font.id, font]));
    this.rels = [
      { id: 'rId1', type: REL.styles, target: 'styles.xml' },
      { id: 'rId2', type: REL.settings, target: 'settings.xml' },
      { id: 'rId3', type: REL.numbering, target: 'numbering.xml' },
    ];
    this.media = new Map();
    this.drawings = 0;
    this.nums = [];
    this.bands = [];
    this.footnotes = [];
    this.endnotes = [];
    this.charts = [];
    this.marks = 0;
  }

  write() {
    this.fields = documentFields({ blocks: this.doc.blocks });
    this.headingTargets = new Set();
    for (const block of this.doc.blocks) {
      for (const { runs } of runListsOf(block)) {
        for (const run of runs) if (run.object?.type === 'ref' && run.object.target.startsWith('heading:')) this.headingTargets.add(run.object.target.slice(8));
      }
    }
    // A section mark ends the section before it with a continuous break that says how many columns that one had.
    const body = [];
    let columns = 1;
    let gap = 6;
    const sections = this.doc.blocks.some((block) => block.kind === 'section');
    for (const block of this.doc.blocks) {
      if (block.kind !== 'section') {
        body.push(...this.block(block));
        continue;
      }
      body.push(tag('w:p', {}, tag('w:pPr', {}, this.sectionBreak(columns, gap))));
      columns = block.columns ?? 1;
      gap = block.gap ?? 6;
    }
    this.lastColumns = sections ? { columns, gap } : null;
    for (const [list, part] of [[this.footnotes, 'footnotes'], [this.endnotes, 'endnotes']]) {
      if (list.length === 0) continue;
      const one = part.slice(0, -1);
      const id = `rId${this.rels.length + 1}`;
      this.rels.push({ id, type: REL[part], target: `${part}.xml` });
      this.bands.push({
        file: `${part}.xml`, part,
        xml: xmlDocument(tag(`w:${part}`, { 'xmlns:w': NS.w, 'xmlns:r': NS.r },
          tag(`w:${one}`, { 'w:type': 'separator', 'w:id': '-1' }, tag('w:p', {}, tag('w:r', {}, tag('w:separator', {})))),
          tag(`w:${one}`, { 'w:type': 'continuationSeparator', 'w:id': '0' }, tag('w:p', {}, tag('w:r', {}, tag('w:continuationSeparator', {})))),
          list.map((note) => tag(`w:${one}`, { 'w:id': String(note.id) },
            tag('w:p', {}, tag('w:pPr', {}, tag('w:pStyle', { 'w:val': part === 'footnotes' ? 'FootnoteText' : 'EndnoteText' })),
              tag('w:r', {}, tag('w:rPr', {}, tag('w:rStyle', { 'w:val': part === 'footnotes' ? 'FootnoteReference' : 'EndnoteReference' })),
                note.mark ? tag('w:t', {}, note.mark) : tag(`w:${part === 'footnotes' ? 'footnoteRef' : 'endnoteRef'}`, {})),
              plainRun(' '), this.runs(note.runs)))))),
      });
    }
    const section = this.section();
    const documentXml = xmlDocument(tag('w:document', {
      'xmlns:w': NS.w, 'xmlns:r': NS.r, 'xmlns:wp': NS.wp, 'xmlns:a': NS.a, 'xmlns:pic': NS.pic, 'xmlns:m': OMML,
    }, tag('w:body', {}, body, section)));

    const overrides = [
      ['word/document.xml', `${MAIN}.document.main+xml`],
      ['word/styles.xml', `${MAIN}.styles+xml`],
      ['word/settings.xml', `${MAIN}.settings+xml`],
      ['word/numbering.xml', `${MAIN}.numbering+xml`],
      ...this.bands.map((band) => [`word/${band.file}`, `${MAIN}.${band.part}+xml`]),
      ...this.charts.map((chart) => [`word/${chart.name}`, OOXML_CHART_TYPE]),
    ];
    const defaults = {
      rels: 'application/vnd.openxmlformats-package.relationships+xml',
      xml: 'application/xml',
    };
    for (const name of this.media.keys()) {
      const ext = extensionOf(name);
      defaults[ext] = IMAGE_TYPES[ext] ?? 'application/octet-stream';
    }

    const entries = [
      { name: '[Content_Types].xml', data: contentTypesXml(defaults, overrides) },
      { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' }]) },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/_rels/document.xml.rels', data: relsXml(this.rels) },
      { name: 'word/styles.xml', data: this.stylesXml() },
      { name: 'word/settings.xml', data: this.settingsXml() },
      { name: 'word/numbering.xml', data: this.numberingXml() },
      ...this.bands.map((band) => ({ name: `word/${band.file}`, data: band.xml })),
      ...this.charts.map((chart) => ({ name: `word/${chart.name}`, data: chart.xml })),
      ...[...this.media].map(([name, bytes]) => ({ name: `word/${name}`, data: bytes })),
    ];
    return { entries, losses: this.losses };
  }

  // Styles

  font(kind) {
    return this.fonts.get(kind)?.name ?? FONTS[kind] ?? FONTS.serif;
  }

  runProps(style) {
    const font = this.font(style.font ?? 'serif');
    return tag('w:rPr', {},
      tag('w:rFonts', { 'w:ascii': font, 'w:hAnsi': font, 'w:cs': font, 'w:eastAsia': font }),
      style.bold ? tag('w:b', {}) : null,
      style.bold ? tag('w:bCs', {}) : null,
      style.italic ? tag('w:i', {}) : null,
      style.italic ? tag('w:iCs', {}) : null,
      style.underline ? tag('w:u', { 'w:val': 'single' }) : null,
      style.color ? tag('w:color', { 'w:val': style.color.replace('#', '').toUpperCase() }) : null,
      tag('w:sz', { 'w:val': halfPoints(style.size ?? 11) }),
      tag('w:szCs', { 'w:val': halfPoints(style.size ?? 11) }));
  }

  paragraphProps(style, level = null) {
    return tag('w:pPr', {},
      level !== null ? tag('w:keepNext', {}) : null,
      level !== null && this.headingNumbers && level < this.headingNumbers.depth
        ? tag('w:numPr', {}, tag('w:ilvl', { 'w:val': String(level) }), tag('w:numId', { 'w:val': OUTLINE_NUM })) : null,
      style.rule ? tag('w:pBdr', {}, tag('w:bottom', { 'w:val': 'single', 'w:sz': '2', 'w:space': '0', 'w:color': '808080' })) : null,
      tag('w:spacing', {
        'w:before': twipsFromPt(style.spaceBefore ?? 0),
        'w:after': twipsFromPt(style.spaceAfter ?? 0),
        'w:line': String(Math.round(((style.lineHeight ?? 1.5) / 1.15) * 240)),
        'w:lineRule': 'auto',
      }),
      style.indent || style.firstLine ? tag('w:ind', {
        'w:left': style.indent ? twipsFromPt(style.indent) : null,
        'w:firstLine': style.firstLine > 0 ? twipsFromPt(style.firstLine) : null,
        'w:hanging': style.firstLine < 0 ? twipsFromPt(-style.firstLine) : null,
      }) : null,
      level !== null ? tag('w:outlineLvl', { 'w:val': String(level) }) : null);
  }

  stylesXml() {
    const body = this.styles.body ?? {};
    const styles = Object.entries(STYLE_IDS).map(([key, info]) => {
      const style = this.styles[key] ?? {};
      const isDefault = key === 'body';
      return tag('w:style', { 'w:type': 'paragraph', 'w:styleId': info.id, 'w:default': isDefault ? '1' : null },
        tag('w:name', { 'w:val': info.name }),
        isDefault ? null : tag('w:basedOn', { 'w:val': 'Normal' }),
        info.level !== undefined ? tag('w:next', { 'w:val': 'Normal' }) : null,
        tag('w:qFormat', {}),
        this.paragraphProps(style, info.level ?? null),
        this.runProps(style));
    });
    const small = { ...body, size: (body.size ?? 11) * 0.85, spaceBefore: 0, spaceAfter: 0 };
    styles.push(
      tag('w:style', { 'w:type': 'paragraph', 'w:styleId': 'Caption' },
        tag('w:name', { 'w:val': 'caption' }), tag('w:basedOn', { 'w:val': 'Normal' }), tag('w:qFormat', {}),
        tag('w:pPr', {}, tag('w:jc', { 'w:val': 'center' })),
        this.runProps({ ...small, italic: true })),
      tag('w:style', { 'w:type': 'paragraph', 'w:styleId': 'Header' },
        tag('w:name', { 'w:val': 'header' }), tag('w:basedOn', { 'w:val': 'Normal' }),
        this.paragraphProps(small), this.runProps(small)),
      tag('w:style', { 'w:type': 'paragraph', 'w:styleId': 'Footer' },
        tag('w:name', { 'w:val': 'footer' }), tag('w:basedOn', { 'w:val': 'Normal' }),
        this.paragraphProps(small), this.runProps(small)),
      Object.entries(this.styles).filter(([key]) => key.startsWith('c-')).map(([key, style]) => tag('w:style', { 'w:type': 'paragraph', 'w:customStyle': '1', 'w:styleId': customId(key, this.styles) },
        tag('w:name', { 'w:val': style.name ?? key }), tag('w:basedOn', { 'w:val': 'Normal' }), tag('w:qFormat', {}),
        this.paragraphProps(style), this.runProps(style))),
      Object.entries(this.doc.charStyles ?? {}).map(([key, style]) => tag('w:style', { 'w:type': 'character', 'w:customStyle': '1', 'w:styleId': charId(key) },
        tag('w:name', { 'w:val': style.name ?? key }), tag('w:qFormat', {}),
        tag('w:rPr', {},
          style.font ? tag('w:rFonts', { 'w:ascii': this.font(style.font), 'w:hAnsi': this.font(style.font), 'w:cs': this.font(style.font) }) : null,
          style.bold ? tag('w:b', {}) : null, style.italic ? tag('w:i', {}) : null, style.strike ? tag('w:strike', {}) : null,
          style.underline ? tag('w:u', { 'w:val': 'single' }) : null,
          style.color ? tag('w:color', { 'w:val': style.color.replace('#', '').toUpperCase() }) : null,
          style.size ? tag('w:sz', { 'w:val': halfPoints(style.size) }) : null,
          style.highlight ? tag('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': style.highlight.replace('#', '').toUpperCase() }) : null))),
      tag('w:style', { 'w:type': 'paragraph', 'w:styleId': 'FootnoteText' },
        tag('w:name', { 'w:val': 'footnote text' }), tag('w:basedOn', { 'w:val': 'Normal' }), this.paragraphProps(small), this.runProps(small)),
      tag('w:style', { 'w:type': 'paragraph', 'w:styleId': 'EndnoteText' },
        tag('w:name', { 'w:val': 'endnote text' }), tag('w:basedOn', { 'w:val': 'Normal' }), this.paragraphProps(small), this.runProps(small)),
      tag('w:style', { 'w:type': 'character', 'w:styleId': 'FootnoteReference' },
        tag('w:name', { 'w:val': 'footnote reference' }), tag('w:rPr', {}, tag('w:vertAlign', { 'w:val': 'superscript' }))),
      tag('w:style', { 'w:type': 'character', 'w:styleId': 'EndnoteReference' },
        tag('w:name', { 'w:val': 'endnote reference' }), tag('w:rPr', {}, tag('w:vertAlign', { 'w:val': 'superscript' }))),
      tag('w:style', { 'w:type': 'paragraph', 'w:styleId': 'TOCHeading' },
        tag('w:name', { 'w:val': 'TOC Heading' }), tag('w:basedOn', { 'w:val': 'Heading1' }), tag('w:next', { 'w:val': 'Normal' }), tag('w:qFormat', {})),
      [1, 2, 3, 4].map((level) => tag('w:style', { 'w:type': 'paragraph', 'w:styleId': `TOC${level}` },
        tag('w:name', { 'w:val': `toc ${level}` }), tag('w:basedOn', { 'w:val': 'Normal' }), tag('w:next', { 'w:val': 'Normal' }),
        tag('w:pPr', {}, tag('w:ind', { 'w:left': String((level - 1) * 220) })))),
      tag('w:style', { 'w:type': 'paragraph', 'w:styleId': 'ListParagraph' },
        tag('w:name', { 'w:val': 'List Paragraph' }), tag('w:basedOn', { 'w:val': 'Normal' }), tag('w:qFormat', {})),
    );
    return xmlDocument(tag('w:styles', { 'xmlns:w': NS.w },
      tag('w:docDefaults', {},
        tag('w:rPrDefault', {}, this.runProps(body)),
        tag('w:pPrDefault', {}, tag('w:pPr', {}))),
      styles));
  }

  settingsXml() {
    return xmlDocument(tag('w:settings', { 'xmlns:w': NS.w },
      this.page.running.evenDifferent ? tag('w:evenAndOddHeaders', {}) : null,
      tag('w:defaultTabStop', { 'w:val': '709' }),
      this.notesPr(),
      tag('w:compat', {}, tag('w:compatSetting', {
        'w:name': 'compatibilityMode', 'w:uri': 'http://schemas.microsoft.com/office/word', 'w:val': '15',
      }))));
  }

  /** How footnotes and endnotes count; Word reads it from the settings, LibreOffice from the section. */
  notesPr() {
    return [['footnotePr', 'foot'], ['endnotePr', 'end']].map(([name, kind]) => tag(`w:${name}`, {},
      tag('w:numFmt', { 'w:val': WORD_NUMBER[this.noteSettings[kind].format] }),
      tag('w:numStart', { 'w:val': String(this.noteSettings[kind].start) })));
  }

  // Lists

  /** A numbering instance for one numbered list. */
  /** A numbering instance for a list: its kind, and how it counts or what bullet it shows. */
  numId(type, variant = null) {
    const id = this.nums.length + 1;
    this.nums.push({ type, variant });
    return String(id);
  }

  /** The headings' numbering, as one multilevel definition tied to the heading styles. */
  outlineNumbering() {
    const numbers = this.headingNumbers;
    if (!numbers) return [];
    const levels = Array.from({ length: 9 }, (_, i) => {
      const on = i < numbers.depth;
      const text = on ? `${(numbers.full ? Array.from({ length: i + 1 }, (_, k) => `%${k + 1}`) : [`%${i + 1}`]).join('.')}${numbers.after}` : '';
      return tag('w:lvl', { 'w:ilvl': String(i) },
        tag('w:start', { 'w:val': '1' }),
        tag('w:numFmt', { 'w:val': on ? WORD_NUMBER[numbers.format] : 'none' }),
        on ? tag('w:pStyle', { 'w:val': `Heading${i + 1}` }) : null,
        tag('w:lvlText', { 'w:val': text }),
        tag('w:lvlJc', { 'w:val': 'left' }));
    });
    return [
      tag('w:abstractNum', { 'w:abstractNumId': OUTLINE_NUM }, tag('w:multiLevelType', { 'w:val': 'multilevel' }), levels),
      tag('w:num', { 'w:numId': OUTLINE_NUM }, tag('w:abstractNumId', { 'w:val': OUTLINE_NUM })),
    ];
  }

  numberingXml() {
    const WORD = { decimal: 'decimal', 'lower-alpha': 'lowerLetter', 'upper-alpha': 'upperLetter', 'lower-roman': 'lowerRoman', 'upper-roman': 'upperRoman' };
    const levels = (type, variant) => Array.from({ length: 9 }, (_, level) => tag('w:lvl', { 'w:ilvl': String(level) },
      tag('w:start', { 'w:val': '1' }),
      tag('w:numFmt', { 'w:val': type === 'number' ? WORD[variant ?? 'decimal'] ?? 'decimal' : 'bullet' }),
      tag('w:lvlText', { 'w:val': type === 'number' ? `%${level + 1}.` : (variant ?? (level % 2 === 0 ? '•' : '◦')) }),
      tag('w:lvlJc', { 'w:val': 'left' }),
      tag('w:pPr', {}, tag('w:ind', { 'w:left': String(360 * (level + 1)), 'w:hanging': '360' }))));
    // One abstract numbering per kind and variant the document uses.
    const kinds = [...new Set(['bullet:', 'number:', ...this.nums.map((n) => `${n.type}:${n.variant ?? ''}`)])];
    return xmlDocument(tag('w:numbering', { 'xmlns:w': NS.w },
      kinds.map((key, i) => {
        const [type, variant] = key.split(':');
        return tag('w:abstractNum', { 'w:abstractNumId': String(i) }, tag('w:multiLevelType', { 'w:val': 'hybridMultilevel' }), levels(type, variant || null));
      }),
      this.outlineNumbering(),
      this.nums.map((n, i) => tag('w:num', { 'w:numId': String(i + 1) },
        tag('w:abstractNumId', { 'w:val': String(kinds.indexOf(`${n.type}:${n.variant ?? ''}`)) }),
        n.type === 'number' ? tag('w:lvlOverride', { 'w:ilvl': '0' }, tag('w:startOverride', { 'w:val': '1' })) : null))));
  }

  // Page

  section() {
    const size = pageDimensions(this.page);
    const landscape = this.page.orientation === 'landscape';
    const m = this.page.margins;
    const running = this.page.running;
    const references = [];
    for (const part of ['header', 'footer']) {
      const slots = running[part];
      const any = slots.default || (running.evenDifferent && slots.even) || (running.firstDifferent && slots.first);
      if (!any) continue;
      references.push(this.band(part, 'default', slots.default));
      if (running.evenDifferent) references.push(this.band(part, 'even', slots.even));
      if (running.firstDifferent) references.push(this.band(part, 'first', slots.first));
    }
    return tag('w:sectPr', {},
      references,
      this.notesPr(),
      this.lastColumns ? tag('w:type', { 'w:val': 'continuous' }) : null,
      tag('w:pgSz', {
        'w:w': twips(landscape ? size.h : size.w),
        'w:h': twips(landscape ? size.w : size.h),
        'w:orient': landscape ? 'landscape' : null,
      }),
      tag('w:pgMar', {
        'w:top': twips(m.top), 'w:right': twips(m.right), 'w:bottom': twips(m.bottom), 'w:left': twips(m.left),
        'w:header': twips(m.top * 0.4), 'w:footer': twips(m.bottom * 0.4), 'w:gutter': '0',
      }),
      this.lastColumns ? tag('w:cols', { 'w:num': String(this.lastColumns.columns), 'w:space': twips(this.lastColumns.gap) }) : null,
      running.firstDifferent ? tag('w:titlePg', {}) : null);
  }

  /** The properties of a section that ends in the middle of the document: the page as the document's, and its columns. */
  sectionBreak(columns, gap) {
    const size = pageDimensions(this.page);
    const landscape = this.page.orientation === 'landscape';
    const m = this.page.margins;
    return tag('w:sectPr', {},
      tag('w:type', { 'w:val': 'continuous' }),
      tag('w:pgSz', { 'w:w': twips(landscape ? size.h : size.w), 'w:h': twips(landscape ? size.w : size.h), 'w:orient': landscape ? 'landscape' : null }),
      tag('w:pgMar', { 'w:top': twips(m.top), 'w:right': twips(m.right), 'w:bottom': twips(m.bottom), 'w:left': twips(m.left), 'w:header': twips(m.top * 0.4), 'w:footer': twips(m.bottom * 0.4), 'w:gutter': '0' }),
      tag('w:cols', { 'w:num': String(columns), 'w:space': twips(gap) }));
  }

  band(part, type, slot) {
    const index = this.bands.filter((band) => band.part === part).length + 1;
    const file = `${part}${index}.xml`;
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type: REL[part], target: file });
    const root = part === 'header' ? 'w:hdr' : 'w:ftr';
    const style = part === 'header' ? 'Header' : 'Footer';
    this.bands.push({
      part,
      file,
      xml: xmlDocument(tag(root, { 'xmlns:w': NS.w, 'xmlns:r': NS.r },
        tag('w:p', {},
          tag('w:pPr', {}, tag('w:pStyle', { 'w:val': style }), slot ? tag('w:jc', { 'w:val': ALIGN[slot.align] ?? 'center' }) : null),
          slot ? slotRuns(slot.text) : null))),
    });
    return tag(part === 'header' ? 'w:headerReference' : 'w:footerReference', { 'w:type': type, 'r:id': id });
  }

  // Body

  block(block) {
    switch (block.kind) {
      case 'heading': {
        const level = Math.max(1, Math.min(block.level ?? 1, 4));
        const runs = this.runs(block.runs);
        if (this.headingTargets.has(block.id)) {
          const id = String(++this.marks);
          runs.unshift(tag('w:bookmarkStart', { 'w:id': id, 'w:name': refName(block.id) }));
          runs.push(tag('w:bookmarkEnd', { 'w:id': id }));
        }
        return [this.paragraph(STYLE_IDS[`h${level}`].id, block, runs)];
      }
      case 'quote':
        return [this.paragraph(STYLE_IDS.quote.id, block, this.runs(block.runs))];
      case 'code':
        return splitLines(block.runs).map((runs, i) => this.paragraph(STYLE_IDS.code.id,
          { ...block, breakBefore: i === 0 && block.breakBefore }, this.runs(runs)));
      case 'list': {
        const numId = block.listType === 'number' ? this.numId('number', block.format ?? null) : this.numId('bullet', block.bullet ?? null);
        return block.items.map((item, i) => this.paragraph('ListParagraph',
          { align: block.align, breakBefore: i === 0 && block.breakBefore, para: block.para }, this.runs(item.runs),
          tag('w:numPr', {}, tag('w:ilvl', { 'w:val': String(Math.max(0, Math.min(item.level ?? 0, 8))) }), tag('w:numId', { 'w:val': numId }))));
      }
      case 'image':
        return this.image(block);
      case 'table':
        return [this.table(block)];
      case 'toc':
        return [this.contents(block)];
      case 'chart':
        return [this.chart(block)];
      case 'index':
        return [this.paragraph('Normal', block, complexField('INDEX \\e "\t" \\c "1"', block.title))];
      case 'paragraph':
        return [this.paragraph(block.style === 'caption' ? 'Caption' : customId(block.style, this.styles) ?? STYLE_IDS[block.style]?.id ?? 'Normal', block, this.runs(block.runs))];
      default:
        return this.foreign(block);
    }
  }

  foreign(block) {
    if (block.kind === 'todo') {
      return [this.paragraph('Normal', block, [plainRun(block.done ? '☑ ' : '☐ '), ...this.runs(block.runs)])];
    }
    if (block.kind === 'callout') return [this.paragraph(STYLE_IDS.quote.id, block, this.runs(block.runs))];
    if (block.kind === 'embed') {
      this.losses.add('Links to other documents, kept as their path');
      return [this.paragraph('Normal', block, [plainRun(block.target ?? '')])];
    }
    this.losses.add(`Blocks of a kind ${block.kind} that has no Word form`);
    return block.runs ? [this.paragraph('Normal', block, this.runs(block.runs))] : [];
  }

  /** A table across the text column, its columns in proportion, merged cells as Word spans them. */
  table(block) {
    const size = pageDimensions(this.page);
    const landscape = this.page.orientation === 'landscape';
    const content = (landscape ? size.h : size.w) - this.page.margins.left - this.page.margins.right;
    const cols = block.rows[0]?.cells.length ?? 1;
    const total = block.widths.reduce((a, b) => a + b, 0) || cols;
    const widths = block.widths.map((w) => Math.round(fromMm((content * w) / total, 'twip')));
    const line = (name) => tag(`w:${name}`, { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': '000000' });
    const sides = { all: ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'], outer: ['top', 'left', 'bottom', 'right'], rows: ['insideH'], none: [] }[block.borders ?? 'all'] ?? [];
    const rows = block.rows.map((row, r) => tag('w:tr', {},
      row.header ? tag('w:trPr', {}, tag('w:tblHeader', {})) : null,
      row.cells.map((cell, c) => {
        // A cell covered from the left is left out; one covered from above continues the merge.
        if (cell.covered) {
          const owner = ownerOf(block, r, c);
          // Covered from the left it is part of a span; below the top-left corner it carries the merge on.
          if (!owner || owner.row === r || owner.col !== c) return null;
          const span = owner.cell.colspan ?? 1;
          return tag('w:tc', {}, tag('w:tcPr', {}, tag('w:tcW', { 'w:w': String(widths.slice(c, c + span).reduce((a, b) => a + b, 0)), 'w:type': 'dxa' }),
            span > 1 ? tag('w:gridSpan', { 'w:val': String(span) }) : null, tag('w:vMerge', {})), tag('w:p', {}));
        }
        const span = cell.colspan ?? 1;
        return tag('w:tc', {},
          tag('w:tcPr', {},
            tag('w:tcW', { 'w:w': String(widths.slice(c, c + span).reduce((a, b) => a + b, 0)), 'w:type': 'dxa' }),
            span > 1 ? tag('w:gridSpan', { 'w:val': String(span) }) : null,
            cell.rowspan > 1 ? tag('w:vMerge', { 'w:val': 'restart' }) : null,
            cell.bg ? tag('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': cell.bg.replace('#', '').toUpperCase() }) : null,
            cell.valign ? tag('w:vAlign', { 'w:val': cell.valign === 'middle' ? 'center' : cell.valign }) : null),
          this.paragraph('Normal', { align: cell.align ?? 'left' }, this.runs(row.header ? cell.runs.map((run) => ({ ...run, bold: true })) : cell.runs)));
      })));
    return tag('w:tbl', {},
      tag('w:tblPr', {},
        tag('w:tblW', { 'w:w': '5000', 'w:type': 'pct' }),
        tag('w:tblBorders', {}, ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => (sides.includes(side) ? line(side) : tag(`w:${side}`, { 'w:val': 'nil' })))),
        tag('w:tblLayout', { 'w:type': 'fixed' }),
        tag('w:tblLook', { 'w:val': '04A0', 'w:firstRow': block.rows[0]?.header ? '1' : '0', 'w:lastRow': '0', 'w:firstColumn': '0', 'w:lastColumn': '0', 'w:noHBand': '0', 'w:noVBand': '1' })),
      tag('w:tblGrid', {}, widths.map((w) => tag('w:gridCol', { 'w:w': String(w) }))),
      rows);
  }

  /** A chart with its values cached in its part, drawn inline in its own paragraph. */
  chart(block) {
    const name = `charts/chart${this.charts.length + 1}.xml`;
    this.charts.push({ name, xml: ooxmlChartPart(block) });
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type: REL_CHART, target: name });
    this.drawings += 1;
    const cx = String(Math.round((block.w ?? 480) * EMU_PER_PX));
    const cy = String(Math.round((block.h ?? 300) * EMU_PER_PX));
    if (block.link) this.losses.add('Charts taking their data from a spreadsheet, kept with the data they had');
    const drawing = tag('w:r', {}, tag('w:drawing', {},
      tag('wp:inline', { distT: '0', distB: '0', distL: '0', distR: '0' },
        tag('wp:extent', { cx, cy }),
        tag('wp:docPr', { id: String(this.drawings), name: block.title || `Chart ${this.drawings}` }),
        tag('a:graphic', {}, tag('a:graphicData', { uri: CHART }, tag('c:chart', { 'xmlns:c': CHART, 'r:id': id }))))));
    return this.paragraph('Normal', { align: block.align ?? 'center', breakBefore: block.breakBefore }, [drawing]);
  }

  /** The table of contents as Word keeps it: a field over the entries, inside a block marked as one. */
  contents(block) {
    const entries = this.fields.headings.filter((h) => h.level <= block.levels && h.text);
    const instr = `TOC \\o "1-${block.levels}" \\h \\z \\u`;
    const begin = [
      tag('w:r', {}, tag('w:fldChar', { 'w:fldCharType': 'begin' })),
      tag('w:r', {}, tag('w:instrText', { 'xml:space': 'preserve' }, ` ${instr} `)),
      tag('w:r', {}, tag('w:fldChar', { 'w:fldCharType': 'separate' })),
    ];
    const end = tag('w:r', {}, tag('w:fldChar', { 'w:fldCharType': 'end' }));
    const lines = entries.length ? entries : [{ level: 1, text: '' }];
    const paragraphs = lines.map((entry, i) => this.paragraph(`TOC${entry.level}`, {},
      [...(i === 0 ? begin : []), plainRun(entry.number ? `${entry.number} ${entry.text}` : entry.text), ...(i === lines.length - 1 ? [end] : [])]));
    return tag('w:sdt', {},
      tag('w:sdtPr', {}, tag('w:docPartObj', {}, tag('w:docPartGallery', { 'w:val': 'Table of Contents' }), tag('w:docPartUnique', {}))),
      tag('w:sdtContent', {}, this.paragraph('TOCHeading', {}, [plainRun(block.title)]), paragraphs));
  }

  /** An object of the text as the Word runs, fields and marks that do the same. */
  object(run) {
    const object = run.object;
    switch (object.type) {
      case 'note': {
        const list = object.kind === 'end' ? this.endnotes : this.footnotes;
        const id = list.length + 1;
        list.push({ id, runs: object.runs, mark: object.mark ?? null });
        const end = object.kind === 'end';
        const style = tag('w:rPr', {}, tag('w:rStyle', { 'w:val': end ? 'EndnoteReference' : 'FootnoteReference' }));
        // A character of the note's own follows its reference, as Word writes it.
        return [tag('w:r', {}, style, tag(end ? 'w:endnoteReference' : 'w:footnoteReference', { 'w:id': String(id), 'w:customMarkFollows': object.mark ? '1' : null })),
          object.mark ? tag('w:r', {}, style, tag('w:t', {}, object.mark)) : null].filter(Boolean);
      }
      case 'math': {
        const omml = object.mathml ? mathmlToOmml(object.mathml, !!object.display) : null;
        if (omml) return [omml];
        this.losses.add('Formulas Word cannot hold, kept as their TeX');
        return [plainRun(object.tex ?? '')];
      }
      case 'bookmark': {
        const id = String(++this.marks);
        return [tag('w:bookmarkStart', { 'w:id': id, 'w:name': bookmarkName(object.name) }), tag('w:bookmarkEnd', { 'w:id': id })];
      }
      case 'seq': {
        const id = String(++this.marks);
        const number = String(this.fields.seqs.get(object.id)?.number ?? 1);
        return [tag('w:bookmarkStart', { 'w:id': id, 'w:name': refName(object.id) }),
          ...complexField(`SEQ ${object.name.replace(/\s+/g, '_')} \\* ARABIC`, number), tag('w:bookmarkEnd', { 'w:id': id })];
      }
      case 'ref': {
        const target = object.target.startsWith('heading:') ? refName(object.target.slice(8))
          : this.fields.seqs.has(object.target) ? refName(object.target) : bookmarkName(object.target);
        if (object.show === 'page') return complexField(`PAGEREF ${target} \\h`, '1');
        return complexField(`REF ${target} \\h`, referenceText(object, this.fields));
      }
      case 'field': {
        const instr = { page: 'PAGE', pages: 'NUMPAGES', date: 'DATE \\@ "yyyy-MM-dd"', time: 'TIME \\@ "HH:mm"', chapter: 'STYLEREF 1' }[object.field];
        const shown = object.field === 'date' ? new Date().toISOString().slice(0, 10) : object.field === 'time' ? new Date().toTimeString().slice(0, 5) : '1';
        return complexField(instr, shown);
      }
      case 'index': {
        const term = object.sub ? `${object.term}:${object.sub}` : object.term;
        return [tag('w:r', {}, tag('w:fldChar', { 'w:fldCharType': 'begin' })),
          tag('w:r', {}, tag('w:instrText', { 'xml:space': 'preserve' }, ` XE "${term.replace(/"/g, "'")}" `)),
          tag('w:r', {}, tag('w:fldChar', { 'w:fldCharType': 'end' }))];
      }
      default:
        return [];
    }
  }

  paragraph(styleId, block, runs, numbering = null) {
    return tag('w:p', {},
      tag('w:pPr', {},
        tag('w:pStyle', { 'w:val': styleId }),
        block.breakBefore ? tag('w:pageBreakBefore', {}) : null,
        numbering,
        block.para && ['spaceBefore', 'spaceAfter', 'lineHeight'].some((f) => block.para[f] !== undefined) ? tag('w:spacing', {
          'w:before': block.para.spaceBefore !== undefined ? twipsFromPt(block.para.spaceBefore) : null,
          'w:after': block.para.spaceAfter !== undefined ? twipsFromPt(block.para.spaceAfter) : null,
          'w:line': block.para.lineHeight !== undefined ? String(Math.round((block.para.lineHeight / 1.15) * 240)) : null,
          'w:lineRule': block.para.lineHeight !== undefined ? 'auto' : null,
        }) : null,
        block.para?.indent !== undefined ? tag('w:ind', { 'w:left': twipsFromPt(block.para.indent) }) : null,
        block.align && block.align !== 'left' ? tag('w:jc', { 'w:val': ALIGN[block.align] }) : null),
      runs);
  }

  image(block) {
    const bytes = this.images.get(block.resource);
    if (!bytes) {
      this.losses.add('Pictures whose file was missing');
      return [];
    }
    const name = `media/${block.resource.split('/').pop()}`;
    this.media.set(name, bytes);
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type: REL.image, target: name });
    this.drawings += 1;
    const cx = String(Math.round((block.w ?? 400) * EMU_PER_PX));
    const cy = String(Math.round((block.h ?? 260) * EMU_PER_PX));
    const drawing = tag('w:r', {}, tag('w:drawing', {},
      tag('wp:inline', { distT: '0', distB: '0', distL: '0', distR: '0' },
        tag('wp:extent', { cx, cy }),
        tag('wp:docPr', { id: String(this.drawings), name: `Picture ${this.drawings}` }),
        tag('a:graphic', {},
          tag('a:graphicData', { uri: 'http://schemas.openxmlformats.org/drawingml/2006/picture' },
            tag('pic:pic', {},
              tag('pic:nvPicPr', {}, tag('pic:cNvPr', { id: '0', name: name.split('/').pop() }), tag('pic:cNvPicPr', {})),
              tag('pic:blipFill', {}, tag('a:blip', { 'r:embed': id }), tag('a:stretch', {}, tag('a:fillRect', {}))),
              tag('pic:spPr', {},
                tag('a:xfrm', {}, tag('a:off', { x: '0', y: '0' }), tag('a:ext', { cx, cy })),
                tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst', {})))))))));
    const out = [this.paragraph('Normal', { align: block.align ?? 'center', breakBefore: block.breakBefore }, [drawing])];
    if ((block.caption ?? []).some((run) => run.text)) {
      out.push(this.paragraph('Caption', {}, this.runs(block.caption)));
    }
    return out;
  }

  runs(runs) {
    const out = [];
    let link = null;
    // Runs with the same link go inside one hyperlink element.
    const flush = () => {
      if (!link) return;
      const internal = link.href.startsWith('#');
      let rid = null;
      if (!internal) {
        rid = `rId${this.rels.length + 1}`;
        this.rels.push({ id: rid, type: REL.hyperlink, target: link.href, external: true });
      }
      out.push(tag('w:hyperlink', internal ? { 'w:anchor': bookmarkName(link.href.slice(1)) } : { 'r:id': rid }, link.runs));
      link = null;
    };
    for (const run of runs ?? []) {
      if (!run.text) continue;
      if (run.object) {
        flush();
        out.push(...this.object(run));
        continue;
      }
      const element = this.plainRunElement(run);
      if (run.link) {
        if (link?.href !== run.link) flush();
        link ??= { href: run.link, runs: [] };
        link.runs.push(element);
      } else {
        flush();
        out.push(element);
      }
    }
    flush();
    return out;
  }

  plainRunElement(run) {
    return [run].map((run) => {
      const props = [
        run.cstyle && this.doc.charStyles?.[run.cstyle] ? tag('w:rStyle', { 'w:val': charId(run.cstyle) }) : null,
        run.bold ? tag('w:b', {}) : null,
        run.italic ? tag('w:i', {}) : null,
        run.strike ? tag('w:strike', {}) : null,
        run.underline ? tag('w:u', { 'w:val': 'single' }) : null,
        run.color ? tag('w:color', { 'w:val': run.color.replace('#', '').toUpperCase() }) : null,
        run.size ? tag('w:sz', { 'w:val': halfPoints(run.size) }) : null,
        run.size ? tag('w:szCs', { 'w:val': halfPoints(run.size) }) : null,
        run.highlight ? tag('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': run.highlight.replace('#', '').toUpperCase() }) : null,
        run.sup ? tag('w:vertAlign', { 'w:val': 'superscript' }) : null,
        !run.sup && run.sub ? tag('w:vertAlign', { 'w:val': 'subscript' }) : null,
      ].filter(Boolean);
      return tag('w:r', {}, props.length ? tag('w:rPr', {}, props) : null, textPieces(run.text));
    })[0];
  }
}

/** Text with its tabs and line breaks as Word elements. */
function textPieces(text) {
  const out = [];
  for (const piece of text.split(/(\t|\n)/)) {
    if (piece === '\t') out.push(tag('w:tab', {}));
    else if (piece === '\n') out.push(tag('w:br', {}));
    else if (piece) out.push(tag('w:t', /^\s|\s$/.test(piece) ? { 'xml:space': 'preserve' } : {}, piece));
  }
  return out;
}

function plainRun(text) {
  return tag('w:r', {}, textPieces(text));
}

/** A slot's text, `{page}` and `{pages}` as fields. */
function slotRuns(text) {
  return text.split(/(\{page\}|\{pages\})/).filter(Boolean).map((piece) => {
    if (piece === '{page}' || piece === '{pages}') {
      return tag('w:fldSimple', { 'w:instr': piece === '{page}' ? ' PAGE ' : ' NUMPAGES ' }, plainRun('1'));
    }
    return plainRun(piece);
  });
}

function splitLines(runs) {
  const lines = [[]];
  for (const run of runs ?? []) {
    run.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ ...run, text: part });
    });
  }
  return lines;
}

