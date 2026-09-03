/** PDF metadata stripping. */

import { PDFName, PDFDocument } from '../../vendor/pdf-lib.esm.js';

/** Full list of /Info fields defined by the PDF specification. */
const INFO_FIELDS = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
];

/**
 * Reads a document's metadata without modifying it.
 * @param {PDFDocument} pdfDoc
 * @returns {{info: Object, hasXmp: boolean}}
 */
export function readMetadata(pdfDoc) {
  const info = {
    title: pdfDoc.getTitle() ?? null,
    author: pdfDoc.getAuthor() ?? null,
    subject: pdfDoc.getSubject() ?? null,
    keywords: pdfDoc.getKeywords() ?? null,
    creator: pdfDoc.getCreator() ?? null,
    producer: pdfDoc.getProducer() ?? null,
    creationDate: pdfDoc.getCreationDate() ?? null,
    modificationDate: pdfDoc.getModificationDate() ?? null,
  };

  return { info, hasXmp: hasXmpMetadata(pdfDoc) };
}

/** Checks whether an XMP block is present in the catalog. */
function hasXmpMetadata(pdfDoc) {
  try {
    return pdfDoc.catalog.has(PDFName.of('Metadata'));
  } catch {
    return false;
  }
}

/**
 * Clears ALL identifying metadata from a document.
 * @param {PDFDocument} pdfDoc modified in place
 */
export function stripMetadata(pdfDoc) {
  // 1. /Info dictionary set to an empty string, not undefined.
  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setSubject('');
  pdfDoc.setKeywords([]);
  pdfDoc.setCreator('');
  pdfDoc.setProducer('');

  // 2. Dates pinned to a constant, non-informative value.
  const epoch = new Date(0);
  pdfDoc.setCreationDate(epoch);
  pdfDoc.setModificationDate(epoch);

  // 3. XMP block removed from the catalog, not emptied.
  removeXmpMetadata(pdfDoc);

  // 4. Low-level removal of any non-standard /Info fields left behind by
  // other programs (e.g.
  removeNonStandardInfoFields(pdfDoc);
}

/** Removes the XMP stream from the document catalog. */
function removeXmpMetadata(pdfDoc) {
  try {
    const key = PDFName.of('Metadata');
    if (pdfDoc.catalog.has(key)) {
      pdfDoc.catalog.delete(key);
    }
  } catch (err) {
    // Do not swallow this: if removal fails the user must know before handing
    // the file to anyone.
    throw new Error(`XMP removal failed: ${err.message}`);
  }
}

/** Some generators write non-standard keys into the /Info dictionary. */
function removeNonStandardInfoFields(pdfDoc) {
  const infoDict = pdfDoc.context.lookup(pdfDoc.context.trailerInfo.Info);
  if (!infoDict || typeof infoDict.keys !== 'function') return;

  const allowed = new Set([
    ...INFO_FIELDS,
    'CreationDate',
    'ModDate',
    'Trapped',
  ]);

  for (const key of [...infoDict.keys()]) {
    const name = key.asString().replace(/^\//, '');
    if (!allowed.has(name)) {
      infoDict.delete(key);
    }
  }
}

/**
 * Verification pass: looks for suspicious strings in the final PDF bytes.
 * @param {Uint8Array} bytes
 * @param {string[]} suspiciousTerms e.g. user name, known paths
 * @returns {string[]}
 */
export function auditBytes(bytes, suspiciousTerms = []) {
  const text = readableForms(bytes);
  const found = [];

  // Fingerprints typically left behind by generators.
  const defaultTerms = [
    'xmpmeta',
    'pdf-lib',
    'Microsoft',
    'Acrobat',
    'C:\\Users\\',
    '/home/',
  ];

  for (const term of [...defaultTerms, ...suspiciousTerms]) {
    if (text.includes(term)) found.push(term);
  }

  return found;
}

/**
 * The same bytes rendered in every form a reader could recover text from.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function readableForms(bytes) {
  const raw = new TextDecoder('latin1').decode(bytes);
  const parts = [raw, ...decodeHexStrings(raw)];

  // Catches UTF-16 text that never went through a hex string.
  const joined = parts.join('\n');
  return `${joined}\n${joined.replace(/\u0000/g, '')}`;
}

/** Expands <48656C6C6F> style strings, including UTF-16 ones. */
function decodeHexStrings(text) {
  const out = [];
  const pattern = /<([0-9A-Fa-f\s]{4,})>/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const digits = match[1].replace(/\s+/g, '');
    if (digits.length % 2 !== 0) continue;

    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    }

    out.push(new TextDecoder('latin1').decode(bytes));

    if (bytes.length >= 4) {
      for (const label of ['utf-16be', 'utf-16le']) {
        try {
          const decoded = new TextDecoder(label).decode(bytes);
          if (!decoded.includes('\uFFFD')) out.push(decoded);
        } catch {
          // Encoding unsupported here; the other one still applies.
        }
      }
    }
  }

  return out;
}
