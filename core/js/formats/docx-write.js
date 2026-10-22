/** The editor's document model as a Word document, with no document properties. */

import { NS, tag, xmlDocument } from '../xml.js';
import { fromMm } from '../units.js';
import { pageDimensions, DEFAULT_PAGE, normaliseRunning } from '../editor/model.js';
import { Losses } from '../losses.js';
import { REL, relsXml, contentTypesXml, IMAGE_TYPES, EMU_PER_PX } from './ooxml.js';
import { extensionOf } from './odf.js';

const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const FONTS = { serif: 'Liberation Serif', sans: 'Liberation Sans', mono: 'Liberation Mono' };

const STYLE_IDS = {
  body: { id: 'Normal', name: 'Normal' },
  h1: { id: 'Heading1', name: 'heading 1', level: 0 },
  h2: { id: 'Heading2', name: 'heading 2', level: 1 },
  h3: { id: 'Heading3', name: 'heading 3', level: 2 },
  h4: { id: 'Heading4', name: 'heading 4', level: 3 },
  quote: { id: 'Quote', name: 'Quote' },
  code: { id: 'HTMLPreformatted', name: 'HTML Preformatted' },
};

const twips = (mm) => String(Math.round(fromMm(mm, 'twip')));
const halfPoints = (pt) => String(Math.round(pt * 2));
const twipsFromPt = (pt) => String(Math.round(pt * 20));
const ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'both' };

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
  }

  write() {
    const body = this.doc.blocks.flatMap((block) => this.block(block));
    const section = this.section();
    const documentXml = xmlDocument(tag('w:document', {
      'xmlns:w': NS.w, 'xmlns:r': NS.r, 'xmlns:wp': NS.wp, 'xmlns:a': NS.a, 'xmlns:pic': NS.pic,
    }, tag('w:body', {}, body, section)));

    const overrides = [
      ['word/document.xml', `${MAIN}.document.main+xml`],
      ['word/styles.xml', `${MAIN}.styles+xml`],
      ['word/settings.xml', `${MAIN}.settings+xml`],
      ['word/numbering.xml', `${MAIN}.numbering+xml`],
      ...this.bands.map((band) => [`word/${band.file}`, `${MAIN}.${band.part}+xml`]),
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
      style.color ? tag('w:color', { 'w:val': style.color.replace('#', '').toUpperCase() }) : null,
      tag('w:sz', { 'w:val': halfPoints(style.size ?? 11) }),
      tag('w:szCs', { 'w:val': halfPoints(style.size ?? 11) }));
  }

  paragraphProps(style, level = null) {
    return tag('w:pPr', {},
      level !== null ? tag('w:keepNext', {}) : null,
      tag('w:spacing', {
        'w:before': twipsFromPt(style.spaceBefore ?? 0),
        'w:after': twipsFromPt(style.spaceAfter ?? 0),
        'w:line': String(Math.round(((style.lineHeight ?? 1.5) / 1.15) * 240)),
        'w:lineRule': 'auto',
      }),
      style.indent ? tag('w:ind', { 'w:left': twipsFromPt(style.indent) }) : null,
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
      tag('w:compat', {}, tag('w:compatSetting', {
        'w:name': 'compatibilityMode', 'w:uri': 'http://schemas.microsoft.com/office/word', 'w:val': '15',
      }))));
  }

  // Lists

  /** A numbering instance for one numbered list. */
  numId(type) {
    const id = this.nums.length + 1;
    this.nums.push(type);
    return String(id);
  }

  numberingXml() {
    const levels = (type) => Array.from({ length: 9 }, (_, level) => tag('w:lvl', { 'w:ilvl': String(level) },
      tag('w:start', { 'w:val': '1' }),
      tag('w:numFmt', { 'w:val': type === 'number' ? 'decimal' : 'bullet' }),
      tag('w:lvlText', { 'w:val': type === 'number' ? `%${level + 1}.` : (level % 2 === 0 ? '•' : '◦') }),
      tag('w:lvlJc', { 'w:val': 'left' }),
      tag('w:pPr', {}, tag('w:ind', { 'w:left': String(360 * (level + 1)), 'w:hanging': '360' }))));
    return xmlDocument(tag('w:numbering', { 'xmlns:w': NS.w },
      tag('w:abstractNum', { 'w:abstractNumId': '0' }, tag('w:multiLevelType', { 'w:val': 'hybridMultilevel' }), levels('bullet')),
      tag('w:abstractNum', { 'w:abstractNumId': '1' }, tag('w:multiLevelType', { 'w:val': 'hybridMultilevel' }), levels('number')),
      this.nums.map((type, i) => tag('w:num', { 'w:numId': String(i + 1) },
        tag('w:abstractNumId', { 'w:val': type === 'number' ? '1' : '0' }),
        type === 'number' ? tag('w:lvlOverride', { 'w:ilvl': '0' }, tag('w:startOverride', { 'w:val': '1' })) : null))));
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
      tag('w:pgSz', {
        'w:w': twips(landscape ? size.h : size.w),
        'w:h': twips(landscape ? size.w : size.h),
        'w:orient': landscape ? 'landscape' : null,
      }),
      tag('w:pgMar', {
        'w:top': twips(m.top), 'w:right': twips(m.right), 'w:bottom': twips(m.bottom), 'w:left': twips(m.left),
        'w:header': twips(m.top * 0.4), 'w:footer': twips(m.bottom * 0.4), 'w:gutter': '0',
      }),
      running.firstDifferent ? tag('w:titlePg', {}) : null);
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
        return [this.paragraph(STYLE_IDS[`h${level}`].id, block, this.runs(block.runs))];
      }
      case 'quote':
        return [this.paragraph(STYLE_IDS.quote.id, block, this.runs(block.runs))];
      case 'code':
        return splitLines(block.runs).map((runs, i) => this.paragraph(STYLE_IDS.code.id,
          { ...block, breakBefore: i === 0 && block.breakBefore }, this.runs(runs)));
      case 'list': {
        const numId = this.numId(block.listType === 'number' ? 'number' : 'bullet');
        return block.items.map((item, i) => this.paragraph('ListParagraph',
          { align: block.align, breakBefore: i === 0 && block.breakBefore }, this.runs(item.runs),
          tag('w:numPr', {}, tag('w:ilvl', { 'w:val': String(Math.max(0, Math.min(item.level ?? 0, 8))) }), tag('w:numId', { 'w:val': numId }))));
      }
      case 'image':
        return this.image(block);
      case 'paragraph':
        return [this.paragraph(STYLE_IDS[block.style]?.id ?? 'Normal', block, this.runs(block.runs))];
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

  paragraph(styleId, block, runs, numbering = null) {
    return tag('w:p', {},
      tag('w:pPr', {},
        tag('w:pStyle', { 'w:val': styleId }),
        block.breakBefore ? tag('w:pageBreakBefore', {}) : null,
        numbering,
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
    return (runs ?? []).filter((run) => run.text).map((run) => {
      const props = [
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
    });
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

