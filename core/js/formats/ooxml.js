/** What every Office Open XML format shares: parts, relationships and content types. */

import { NS, parseXml, kids, attr, tag, xmlDocument } from '../xml.js';

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  sharedStrings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  font: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font',
};

// Strict OOXML names the same relationships under another root.
const STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships/';

/** Whether a relationship type is the one named, in either flavour. */
export function relIs(type, name) {
  return type === REL[name] || type === `${STRICT}${REL[name].split('/').pop()}`;
}

export function partDir(part) {
  const at = part.lastIndexOf('/');
  return at === -1 ? '' : part.slice(0, at + 1);
}

/** A relationship target as a part name, from the part that holds it. */
export function resolvePart(from, target) {
  if (target.startsWith('/')) return target.slice(1);
  const segments = `${partDir(from)}${target}`.split('/');
  const out = [];
  for (const segment of segments) {
    if (segment === '..') out.pop();
    else if (segment !== '.' && segment !== '') out.push(segment);
  }
  return out.join('/');
}

function relsPath(part) {
  const dir = partDir(part);
  return `${dir}_rels/${part.slice(dir.length)}.rels`;
}

/**
 * The relationships of a part, by id.
 * @returns {Map<string, {type: string, target: string, external: boolean}>}
 */
export function relationships(pkg, part) {
  const text = pkg.text(part === '' ? '_rels/.rels' : relsPath(part));
  const out = new Map();
  if (text === null) return out;
  const doc = parseXml(text, `the relationships of ${part || 'the package'}`);
  for (const rel of kids(doc.documentElement, NS.rel, 'Relationship')) {
    const external = attr(rel, null, 'TargetMode') === 'External' || rel.getAttribute('TargetMode') === 'External';
    const target = rel.getAttribute('Target') ?? '';
    out.set(rel.getAttribute('Id'), {
      type: rel.getAttribute('Type') ?? '',
      target: external ? target : resolvePart(part, decodeURIComponent(target)),
      external,
    });
  }
  return out;
}

/** The part a package's own relationship of some type points at. */
export function mainPart(pkg, name = 'officeDocument') {
  for (const rel of relationships(pkg, '').values()) {
    if (relIs(rel.type, name)) return rel.target;
  }
  return null;
}

/** Strict OOXML's namespaces, and the transitional ones the readers know. */
const STRICT_NAMESPACES = [
  ['http://purl.oclc.org/ooxml/spreadsheetml/main', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'],
  ['http://purl.oclc.org/ooxml/wordprocessingml/main', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'],
  ['http://purl.oclc.org/ooxml/presentationml/main', 'http://schemas.openxmlformats.org/presentationml/2006/main'],
  ['http://purl.oclc.org/ooxml/drawingml/main', 'http://schemas.openxmlformats.org/drawingml/2006/main'],
  ['http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'],
  ['http://purl.oclc.org/ooxml/drawingml/picture', 'http://schemas.openxmlformats.org/drawingml/2006/picture'],
  ['http://purl.oclc.org/ooxml/officeDocument/relationships', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'],
  // Office 2007's beta wrote workbooks under a namespace of its own.
  ['http://schemas.microsoft.com/office/excel/2006/2', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'],
];

/** A part as XML; a Strict part is read as its transitional twin, which says the same. */
export function readPart(pkg, part, what = part) {
  let text = pkg.text(part);
  if (text === null) return null;
  if (text.includes('purl.oclc.org/ooxml/') || text.includes('office/excel/2006/2')) {
    for (const [strict, transitional] of STRICT_NAMESPACES) text = text.split(`"${strict}"`).join(`"${transitional}"`);
  }
  return parseXml(text, what);
}

/** A relationships part to write, ids in the order given. */
export function relsXml(rels) {
  return xmlDocument(tag('Relationships', { xmlns: NS.rel },
    rels.map((rel) => tag('Relationship', {
      Id: rel.id, Type: rel.type, Target: rel.target, TargetMode: rel.external ? 'External' : null,
    }))));
}

/** [Content_Types].xml for the parts written. */
export function contentTypesXml(defaults, overrides) {
  return xmlDocument(tag('Types', { xmlns: NS.ct },
    Object.entries(defaults).sort(([a], [b]) => a.localeCompare(b)).map(([extension, type]) => tag('Default', { Extension: extension, ContentType: type })),
    overrides.map(([part, type]) => tag('Override', { PartName: `/${part}`, ContentType: type }))));
}

export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** EMU, the unit DrawingML measures in. */
export const EMU_PER_PX = 9525;
