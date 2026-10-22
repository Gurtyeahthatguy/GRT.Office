/** The editor's document model as OpenDocument text, packaged or flat. */

import { tag, xmlDocument } from '../xml.js';
import { formatLength, toMm } from '../units.js';
import { pageDimensions, DEFAULT_PAGE, normaliseRunning } from '../editor/model.js';
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
};

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
    this.page = { ...DEFAULT_PAGE, ...(document.page ?? {}), running: normaliseRunning(document.page?.running) };
    this.styles = document.styles ?? {};
    this.customFonts = new Map((document.fonts ?? []).map((font) => [font.id, font]));
  }

  write() {
    const body = this.doc.blocks.flatMap((block) => this.block(block));
    const master = this.masterPage();

    if (this.flat) {
      const root = tag('office:document', {
        ...ROOT_NAMESPACES,
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

    const content = tag('office:document-content', { ...ROOT_NAMESPACES, 'office:version': ODF_VERSION },
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
    return tag('style:text-properties', props);
  }

  paragraphProps(style) {
    const props = {
      'fo:margin-top': formatLength(mmFromPt(style.spaceBefore ?? 0), 'cm'),
      'fo:margin-bottom': formatLength(mmFromPt(style.spaceAfter ?? 0), 'cm'),
      'fo:line-height': `${Math.round(((style.lineHeight ?? 1.5) / 1.15) * 100)}%`,
    };
    if (style.indent) props['fo:margin-left'] = formatLength(mmFromPt(style.indent), 'cm');
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
    styles.push(
      tag('style:style', {
        'style:name': 'Figure', 'style:family': 'paragraph', 'style:parent-style-name': 'Standard', 'style:class': 'extra',
      }, tag('style:paragraph-properties', { 'fo:text-align': 'center' }),
      tag('style:text-properties', { 'fo:font-size': pt((body.size ?? 11) * 0.85), 'fo:font-style': 'italic' })),
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
    );
    return tag('office:styles', {}, styles);
  }

  listStyle(type) {
    const named = LISTS[type];
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
        ? tag('text:list-level-style-bullet', { 'text:level': String(level), 'text:bullet-char': level % 2 === 1 ? '•' : '◦' }, props)
        : tag('text:list-level-style-number', { 'text:level': String(level), 'style:num-suffix': '.', 'style:num-format': '1' }, props));
    }
    return tag('text:list-style', { 'style:name': named.name, 'style:display-name': named.display }, levels);
  }

  // Automatic styles

  paragraphStyle(parent, { align = 'left', breakBefore = false } = {}) {
    const needsOwn = (align && align !== 'left') || breakBefore;
    if (!needsOwn) return parent;
    const key = `${parent}|${align}|${breakBefore}`;
    if (!this.paragraphStyles.has(key)) {
      this.paragraphStyles.set(key, { name: `P${this.paragraphStyles.size + 1}`, parent, align, breakBefore });
    }
    return this.paragraphStyles.get(key).name;
  }

  textStyle(run) {
    const props = {};
    if (run.bold) Object.assign(props, { 'fo:font-weight': 'bold', 'style:font-weight-asian': 'bold', 'style:font-weight-complex': 'bold' });
    if (run.italic) Object.assign(props, { 'fo:font-style': 'italic', 'style:font-style-asian': 'italic', 'style:font-style-complex': 'italic' });
    if (run.underline) Object.assign(props, { 'style:text-underline-style': 'solid', 'style:text-underline-width': 'auto', 'style:text-underline-color': 'font-color' });
    if (run.strike) Object.assign(props, { 'style:text-line-through-style': 'solid', 'style:text-line-through-type': 'single' });
    if (run.sup) props['style:text-position'] = 'super 58%';
    else if (run.sub) props['style:text-position'] = 'sub 58%';
    if (run.color) props['fo:color'] = run.color;
    if (run.highlight) props['fo:background-color'] = run.highlight;
    if (run.size) Object.assign(props, { 'fo:font-size': pt(run.size), 'style:font-size-asian': pt(run.size), 'style:font-size-complex': pt(run.size) });
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
      out.push(tag('style:style', {
        'style:name': style.name, 'style:family': 'paragraph', 'style:parent-style-name': style.parent,
      }, tag('style:paragraph-properties', props)));
    }
    for (const style of this.textStyles.values()) {
      out.push(tag('style:style', { 'style:name': style.name, 'style:family': 'text' }, tag('style:text-properties', style.props)));
    }
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
        return [tag('text:h', { 'text:style-name': style, 'text:outline-level': String(level) }, this.runs(block.runs))];
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
      default: {
        if (!['paragraph', 'heading', 'quote', 'code', 'list', 'image'].includes(block.kind)) {
          return this.foreign(block);
        }
        const named = NAMED[block.style]?.name ?? NAMED.body.name;
        return [tag('text:p', { 'text:style-name': this.paragraphStyle(named, block) }, this.runs(block.runs))];
      }
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
    const named = LISTS[block.listType === 'number' ? 'number' : 'bullet'].name;
    const paragraphStyle = this.paragraphStyle(NAMED.body.name, { align: block.align, breakBefore: block.breakBefore });
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
      top.item = tag('text:list-item', {}, tag('text:p', { 'text:style-name': paragraphStyle }, this.runs(item.runs)));
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
  runs(runs, { keepNewlines = true } = {}) {
    const out = [];
    let afterSpace = true;
    for (const run of runs ?? []) {
      if (!run.text) continue;
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
      out.push(style ? tag('text:span', { 'text:style-name': style }, content) : content);
    }
    return out;
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

