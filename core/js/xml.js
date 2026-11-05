/** Reading XML through the platform's parser, and writing it as text. */

export const NS = {
  // ODF
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  number: 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  calcext: 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0',
  of: 'urn:oasis:names:tc:opendocument:xmlns:of:1.2',
  // OOXML
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
};

/** Deeper than this an XML part is refused, as WebKit's own parser does. */
const MAX_DEPTH = 256;
/** Longer than this, in characters, an XML part is refused. */
const MAX_LENGTH = 256 * 1024 * 1024;

/** How deep the elements of a text go, counting no further than the limit. */
function depthOf(text) {
  let depth = 0;
  let at = text.indexOf('<');
  while (at !== -1 && depth <= MAX_DEPTH) {
    const next = text.charCodeAt(at + 1);
    if (next === 47) {
      depth -= 1;
      at = text.indexOf('>', at);
    } else if (text.startsWith('<!--', at)) {
      at = text.indexOf('-->', at);
    } else if (text.startsWith('<![CDATA[', at)) {
      at = text.indexOf(']]>', at);
    } else if (next === 33 || next === 63) {
      at = text.indexOf('>', at);
    } else {
      let quote = 0;
      let i = at + 1;
      for (; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (quote !== 0) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) quote = c;
        else if (c === 62) break;
      }
      if (text.charCodeAt(i - 1) !== 47) depth += 1;
      at = i;
    }
    if (at === -1) break;
    at = text.indexOf('<', at + 1);
  }
  return depth;
}

/** Parses XML, or throws saying which part was not XML. */
export function parseXml(text, what = 'the file') {
  if (text.length > MAX_LENGTH) throw new Error(`${what} is too large to open`);
  if (text.includes('<!ENTITY')) throw new Error(`${what} declares XML entities, which GRT never expands`);
  if (depthOf(text) > MAX_DEPTH) throw new Error(`${what} is nested more than ${MAX_DEPTH} levels deep`);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error || !doc.documentElement) {
    throw new Error(`${what} is not well-formed XML`);
  }
  return doc;
}

/** Element children, optionally only those with a namespace and local name. */
export function kids(element, ns = null, local = null) {
  const out = [];
  for (let node = element?.firstElementChild; node; node = node.nextElementSibling) {
    if ((ns === null || node.namespaceURI === ns) && (local === null || node.localName === local)) {
      out.push(node);
    }
  }
  return out;
}

export function kid(element, ns, local) {
  for (let node = element?.firstElementChild; node; node = node.nextElementSibling) {
    if (node.namespaceURI === ns && node.localName === local) return node;
  }
  return null;
}

/** A path of children, each step [ns, local]. */
export function dig(element, ...steps) {
  let at = element;
  for (const [ns, local] of steps) {
    at = kid(at, ns, local);
    if (!at) return null;
  }
  return at;
}

export function attr(element, ns, local) {
  if (!element) return null;
  return element.hasAttributeNS(ns, local) ? element.getAttributeNS(ns, local) : null;
}

export function is(node, ns, local) {
  return node?.nodeType === 1 && node.namespaceURI === ns && node.localName === local;
}

// Writing

/** An element to write: a name with its prefix, attributes in order, children. */
export function tag(name, attrs = {}, ...children) {
  return { name, attrs, children: children.flat(Infinity) };
}

// Characters XML 1.0 cannot carry at all, and halves of surrogate pairs.
const UNWRITABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeText(value) {
  return String(value).replace(UNWRITABLE, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

/** Writes an element tree as text: no whitespace added, attributes as given. */
export function serialize(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return escapeText(node);
  // Markup already made safe and well formed by its maker, such as a formula's MathML.
  if (typeof node.raw === 'string') return node.raw;
  let out = `<${node.name}`;
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value === null || value === undefined) continue;
    out += ` ${key}="${escapeAttr(value)}"`;
  }
  const inner = node.children.map(serialize).join('');
  return inner === '' ? `${out}/>` : `${out}>${inner}</${node.name}>`;
}

export function xmlDocument(root) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(root)}`;
}
