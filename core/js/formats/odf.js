/** What every OpenDocument format shares: the package, the manifest, and styles. */

import { NS, parseXml, kids, kid, attr, tag, xmlDocument } from '../xml.js';
import { parseLength } from '../units.js';

export const MIMETYPES = {
  text: 'application/vnd.oasis.opendocument.text',
  spreadsheet: 'application/vnd.oasis.opendocument.spreadsheet',
  presentation: 'application/vnd.oasis.opendocument.presentation',
  graphics: 'application/vnd.oasis.opendocument.graphics',
};

export const ODF_VERSION = '1.3';

/** The namespace declarations every written root carries. */
export const ROOT_NAMESPACES = {
  'xmlns:office': NS.office,
  'xmlns:style': NS.style,
  'xmlns:text': NS.text,
  'xmlns:table': NS.table,
  'xmlns:draw': NS.draw,
  'xmlns:fo': NS.fo,
  'xmlns:xlink': NS.xlink,
  'xmlns:svg': NS.svg,
  'xmlns:number': NS.number,
  'xmlns:presentation': NS.presentation,
  'xmlns:of': NS.of,
};

/**
 * The XML an ODF file is made of: `content` and `styles`, which are the same
 * document when the file is flat.
 * @param {import('../package.js').Package|string} source a package, or the text of a flat file
 */
export function odfDocuments(source) {
  if (typeof source === 'string') {
    const doc = parseXml(source, 'The document');
    if (doc.documentElement.namespaceURI !== NS.office || doc.documentElement.localName !== 'document') {
      throw new Error('This is not a flat OpenDocument file');
    }
    return {
      content: doc,
      styles: doc,
      flat: true,
      mimetype: attr(doc.documentElement, NS.office, 'mimetype'),
    };
  }

  const manifest = source.text('META-INF/manifest.xml');
  if (manifest && manifest.includes('encryption-data')) {
    throw new Error('This document is protected with a password, which GRT cannot open');
  }
  const content = source.text('content.xml');
  if (content === null) throw new Error('This is not an OpenDocument file: it has no content.xml');
  const styles = source.text('styles.xml');
  return {
    content: parseXml(content, 'content.xml'),
    styles: styles === null ? null : parseXml(styles, 'styles.xml'),
    flat: false,
    mimetype: source.text('mimetype')?.trim() ?? null,
  };
}

/** Property elements by the short name used for them here. */
const PROPERTY_KINDS = {
  'paragraph-properties': 'paragraph',
  'text-properties': 'text',
  'table-properties': 'table',
  'table-column-properties': 'column',
  'table-row-properties': 'row',
  'table-cell-properties': 'cell',
  'graphic-properties': 'graphic',
  'drawing-page-properties': 'page',
  'page-layout-properties': 'layout',
  'header-footer-properties': 'headerFooter',
  'list-level-properties': 'listLevel',
};

/** Every attribute of a properties element, by local name. */
function readProperties(element) {
  const props = {};
  for (const child of kids(element)) {
    const kind = PROPERTY_KINDS[child.localName];
    if (!kind || child.namespaceURI !== NS.style) continue;
    const bag = props[kind] ?? (props[kind] = {});
    for (const attribute of child.attributes) bag[attribute.localName] = attribute.value;
    const columns = kid(child, NS.style, 'columns');
    if (columns) bag.columnCount = attr(columns, NS.fo, 'column-count');
  }
  return props;
}

function readStyle(element, automatic) {
  return {
    name: attr(element, NS.style, 'name'),
    family: attr(element, NS.style, 'family'),
    parent: attr(element, NS.style, 'parent-style-name'),
    displayName: attr(element, NS.style, 'display-name'),
    listStyle: attr(element, NS.style, 'list-style-name'),
    masterPage: attr(element, NS.style, 'master-page-name'),
    outlineLevel: attr(element, NS.style, 'default-outline-level'),
    dataStyle: attr(element, NS.style, 'data-style-name'),
    automatic,
    props: readProperties(element),
    element,
  };
}

/** The styles one part of a document can see: the named ones and that part's automatic ones. */
export class OdfStyles {
  /**
   * @param {Document[]} named documents whose office:styles are shared
   * @param {Document} automatic the document whose office:automatic-styles apply
   */
  constructor(named, automatic) {
    this.styles = new Map();
    this.defaults = new Map();
    this.lists = new Map();
    this.layouts = new Map();
    this.masters = [];
    this.fonts = new Map();
    this.dataStyles = new Map();
    this.outline = null;

    for (const doc of named) {
      const root = doc?.documentElement;
      if (!root) continue;
      this.collectFonts(kid(root, NS.office, 'font-face-decls'));
      this.collect(kid(root, NS.office, 'styles'), false);
      for (const master of kids(kid(root, NS.office, 'master-styles'), NS.style, 'master-page')) {
        if (!this.masters.includes(master)) this.masters.push(master);
      }
    }
    const root = automatic?.documentElement;
    this.collectFonts(kid(root, NS.office, 'font-face-decls'));
    this.collect(kid(root, NS.office, 'automatic-styles'), true);
  }

  collectFonts(holder) {
    for (const face of kids(holder, NS.style, 'font-face')) {
      this.fonts.set(attr(face, NS.style, 'name'), {
        family: unquote(attr(face, NS.svg, 'font-family') ?? attr(face, NS.style, 'name') ?? ''),
        generic: attr(face, NS.style, 'font-family-generic'),
        pitch: attr(face, NS.style, 'font-pitch'),
      });
    }
  }

  collect(holder, automatic) {
    for (const element of kids(holder)) {
      if (element.namespaceURI === NS.style && element.localName === 'style') {
        const style = readStyle(element, automatic);
        this.styles.set(`${style.family}:${style.name}`, style);
      } else if (element.namespaceURI === NS.style && element.localName === 'default-style') {
        this.defaults.set(attr(element, NS.style, 'family'), readProperties(element));
      } else if (element.namespaceURI === NS.text && element.localName === 'list-style') {
        this.lists.set(attr(element, NS.style, 'name'), element);
      } else if (element.namespaceURI === NS.text && element.localName === 'outline-style') {
        this.outline = element;
      } else if (element.namespaceURI === NS.style && element.localName === 'page-layout') {
        this.layouts.set(attr(element, NS.style, 'name'), element);
      } else if (element.namespaceURI === NS.number) {
        this.dataStyles.set(attr(element, NS.style, 'name'), element);
      }
    }
  }

  style(family, name) {
    return name ? this.styles.get(`${family}:${name}`) ?? null : null;
  }

  /** The style and its ancestors, nearest first. */
  chain(family, name) {
    const out = [];
    const seen = new Set();
    let style = this.style(family, name);
    while (style && !seen.has(style.name)) {
      seen.add(style.name);
      out.push(style);
      style = this.style(family, style.parent);
    }
    return out;
  }

  /** One kind of properties as they apply: the default, then the chain from the top. */
  resolve(family, name, kind) {
    const merged = { ...(this.defaults.get(family)?.[kind] ?? {}) };
    for (const style of this.chain(family, name).reverse()) {
      Object.assign(merged, style.props[kind] ?? {});
    }
    return merged;
  }

  /** The nearest named style in a chain, which is what a user chose. */
  named(family, name) {
    return this.chain(family, name).find((style) => !style.automatic) ?? null;
  }

  /** Names and display names of the chain, for recognising well-known styles. */
  names(family, name) {
    return this.chain(family, name).flatMap((style) => [style.name, style.displayName].filter(Boolean));
  }

  font(name) {
    return this.fonts.get(name) ?? null;
  }
}

export function unquote(value) {
  return String(value).trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** Text properties in the terms the models use. */
export function textLook(props, styles = null) {
  const look = {};
  const weight = props['font-weight'];
  look.bold = weight === 'bold' || (Number(weight) >= 600);
  look.italic = props['font-style'] === 'italic' || props['font-style'] === 'oblique';
  look.underline = !!props['text-underline-style'] && props['text-underline-style'] !== 'none';
  look.strike = !!props['text-line-through-style'] && props['text-line-through-style'] !== 'none';

  const position = String(props['text-position'] ?? '').trim().split(/\s+/)[0];
  if (position === 'super' || (position.endsWith('%') && parseFloat(position) > 0)) look.sup = true;
  if (position === 'sub' || (position.endsWith('%') && parseFloat(position) < 0)) look.sub = true;

  const color = props.color;
  if (color && props['use-window-font-color'] !== 'true') look.color = color.toLowerCase();
  const background = props['background-color'];
  if (background && background !== 'transparent') look.highlight = background.toLowerCase();

  const size = props['font-size'];
  if (size && !size.endsWith('%')) {
    const mm = parseLength(size);
    if (mm !== null) look.size = Math.round(mm * (72 / 25.4) * 100) / 100;
  }

  const face = props['font-name'] ? styles?.font(props['font-name']) : null;
  look.font = face?.family ?? (props['font-family'] ? unquote(props['font-family']) : null);
  look.generic = face?.generic ?? props['font-family-generic'] ?? null;
  return look;
}

/** The family a font name most likely belongs to. */
export function fontKind(name, generic = null) {
  if (generic === 'modern') return 'mono';
  if (generic === 'swiss') return 'sans';
  if (generic === 'roman') return 'serif';
  const lower = String(name ?? '').toLowerCase();
  if (/mono|courier|consol|code|menlo/.test(lower)) return 'mono';
  if (/sans|arial|helvetica|calibri|verdana|tahoma|segoe|roboto|open|noto sans|aptos|carlito/.test(lower)) return 'sans';
  return 'serif';
}

/** Where a draw:image points inside the package, or null if outside it. */
export function internalHref(href) {
  if (!href) return null;
  const clean = href.replace(/^\.\//, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('../') || clean.startsWith('/')) return null;
  return decodeURIComponent(clean);
}

export const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ttf: 'application/x-font-ttf',
  otf: 'application/x-font-otf',
  woff: 'application/font-woff',
  woff2: 'font/woff2',
  xml: 'text/xml',
};

/** Images the webview can draw. */
export const DRAWABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);

export const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(name ?? '')?.[1] ?? '').toLowerCase();

/** The manifest listing every file of the package. */
export function manifestXml(mimetype, files) {
  return xmlDocument(tag('manifest:manifest', {
    'xmlns:manifest': NS.manifest,
    'manifest:version': ODF_VERSION,
  },
  tag('manifest:file-entry', {
    'manifest:full-path': '/', 'manifest:version': ODF_VERSION, 'manifest:media-type': mimetype,
  }),
  files.map((file) => tag('manifest:file-entry', {
    'manifest:full-path': file.name,
    'manifest:media-type': file.mediaType,
  }))));
}

/**
 * The entries of a package in the order ODF wants: the mimetype first and
 * stored, then the parts, then the manifest.
 * @param {string} mimetype
 * @param {{name: string, data: string|Uint8Array, mediaType: string}[]} files
 */
export function odfPackage(mimetype, files) {
  return [
    { name: 'mimetype', data: mimetype, store: true },
    ...files.map((file) => ({ name: file.name, data: file.data })),
    { name: 'META-INF/manifest.xml', data: manifestXml(mimetype, files) },
  ];
}

/**
 * Text as ODF keeps it: runs of spaces, spaces that start a paragraph, tabs
 * and line breaks as their own elements, since the rest is collapsed on reading.
 */
export function odfText(text, afterSpace = true) {
  const out = [];
  let plain = '';
  let spaces = 0;
  const flush = () => {
    if (plain) out.push(plain);
    plain = '';
    if (spaces > 0) out.push(tag('text:s', spaces > 1 ? { 'text:c': String(spaces) } : {}));
    spaces = 0;
  };
  for (const char of String(text)) {
    if (char === ' ') {
      if (afterSpace) {
        if (plain) {
          out.push(plain);
          plain = '';
        }
        spaces += 1;
      } else {
        plain += ' ';
        afterSpace = true;
      }
    } else if (char === '\t' || char === '\n') {
      flush();
      out.push(tag(char === '\t' ? 'text:tab' : 'text:line-break', {}));
      afterSpace = char === '\n';
    } else {
      if (spaces > 0) flush();
      plain += char;
      afterSpace = false;
    }
  }
  flush();
  return out;
}

/** Base64 of bytes, for flat files. */
export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Whether headings of a level carry numbers from the outline style. */
export function outlineNumbered(styles, level) {
  for (const element of kids(styles.outline)) {
    if (Number(attr(element, NS.text, 'level')) !== level) continue;
    const format = attr(element, NS.style, 'num-format');
    return !!format;
  }
  return false;
}
