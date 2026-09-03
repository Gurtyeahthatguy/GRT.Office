/** What is about to end up in the file. */

import { PDFDocument, PDFName, PDFDict, PDFRawStream } from '../vendor/pdf-lib.esm.js';
import { readMetadata, auditBytes, readableForms } from './core/metadata.js';

/**
 * @param {Uint8Array} bytes the bytes that are about to be written
 * @returns {Promise<Object>} report for the fingerprint panel
 */
export async function inspectBytes(bytes) {
  const report = {
    size: bytes.byteLength,
    pageCount: 0,
    metadata: {},
    hasXmp: false,
    fonts: [],
    embeddedFontCount: 0,
    imageCount: 0,
    imagesWithExif: 0,
    auditHits: [],
    deepScan: false,
    errors: [],
  };

  // Cheap pass first, then the thorough one.
  report.auditHits = auditBytes(bytes);
  try {
    const deep = await deepAuditBytes(bytes);
    report.deepScan = true;
    report.auditHits = [...new Set([...report.auditHits, ...deep])];
  } catch (err) {
    report.errors.push(`Compressed streams not inspected: ${err.message}`);
  }

  let doc;
  try {
    doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });
  } catch (err) {
    report.errors.push(`Could not re-read the output: ${err.message}`);
    return report;
  }

  report.pageCount = doc.getPageCount();

  const { info, hasXmp } = readMetadata(doc);
  report.metadata = info;
  report.hasXmp = hasXmp;

  const fonts = new Set();

  try {
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      inspectObject(object, report, fonts);
    }
  } catch (err) {
    report.errors.push(`Object scan incomplete: ${err.message}`);
  }

  report.fonts = [...fonts].sort();
  return report;
}

/** Classifies one indirect object: font, image, or neither. */
function inspectObject(object, report, fonts) {
  const dict = object instanceof PDFRawStream ? object.dict
    : object instanceof PDFDict ? object
      : null;
  if (!dict) return;

  const type = nameOf(dict, 'Type');
  const subtype = nameOf(dict, 'Subtype');

  if (type === 'Font') {
    const base = nameOf(dict, 'BaseFont');
    if (base) fonts.add(base);
    return;
  }

  // Font programs actually carried inside the document, as opposed to fonts
  // merely named and left to the reader to find.
  if (dict.has(PDFName.of('FontFile'))
    || dict.has(PDFName.of('FontFile2'))
    || dict.has(PDFName.of('FontFile3'))) {
    report.embeddedFontCount += 1;
  }

  if (subtype === 'Image') {
    report.imageCount += 1;
    if (object instanceof PDFRawStream && hasExif(object.contents)) {
      report.imagesWithExif += 1;
    }
  }
}

function nameOf(dict, key) {
  try {
    const value = dict.get(PDFName.of(key));
    if (!value) return null;
    const raw = value.asString?.() ?? String(value);
    return raw.replace(/^\//, '');
  } catch {
    return null;
  }
}

/**
 * A JPEG kept inside a PDF keeps whatever APP1 segment it arrived with, which
 * is where camera model, software and GPS coordinates live.
 */
function hasExif(contents) {
  if (!contents || contents.length < 8) return false;
  const limit = Math.min(contents.length, 4096);
  for (let i = 0; i < limit - 5; i += 1) {
    if (contents[i] === 0x45 && contents[i + 1] === 0x78
      && contents[i + 2] === 0x69 && contents[i + 3] === 0x66
      && contents[i + 4] === 0x00) {
      return true;
    }
  }
  return false;
}

/**
 * Searches the file with every compressed stream inflated.
 * @param {Uint8Array} bytes
 * @returns {Promise<string[]>}
 */
async function deepAuditBytes(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream unavailable in this webview');
  }

  const raw = new TextDecoder('latin1').decode(bytes);
  const found = new Set();
  let cursor = 0;

  while (true) {
    const start = raw.indexOf('stream', cursor);
    if (start === -1) break;
    cursor = start + 'stream'.length;
    if (raw.slice(start - 3, start) === 'end') continue;

    let dataStart = start + 'stream'.length;
    if (raw[dataStart] === '\r') dataStart += 1;
    if (raw[dataStart] === '\n') dataStart += 1;

    const end = raw.indexOf('endstream', dataStart);
    if (end === -1) break;

    let inflated;
    try {
      inflated = await inflate(bytes.subarray(dataStart, end));
    } catch {
      // Not deflate-compressed, or damaged: the plain pass already covered
      // it.
      continue;
    }

    for (const term of SUSPICIOUS_TERMS) {
      if (readableForms(inflated).includes(term)) found.add(term);
    }
  }

  return [...found];
}

const SUSPICIOUS_TERMS = [
  'xmpmeta', 'pdf-lib', 'Microsoft', 'Acrobat', 'LibreOffice', 'Skia',
  'C:\\Users\\', '/home/', '/Users/',
];

async function inflate(slice) {
  const stream = new Blob([slice]).stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Human-readable size, for the panel. */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Renders the report as a table. */
export function renderReport(report, context = {}) {
  const rows = [];
  const clean = (text) => `<span class="fp-clean">${text}</span>`;
  const dirty = (text) => `<span class="fp-dirty">${text}</span>`;
  const escape = (value) => String(value).replace(/[<>&]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  rows.push(['Size', formatSize(report.size)]);
  rows.push(['Pages', String(report.pageCount)]);

  // Stated first because it is the one line where the difference between two
  // similar-looking features actually matters to the person reading it.
  if (context.redactions > 0) {
    rows.push([
      'Redactions',
      clean(`${context.redactions} region(s) — content deleted from the file`),
    ]);
  }
  if (context.highlights > 0) {
    rows.push([
      'Highlights',
      `${context.highlights} region(s) — drawn over the page, nothing removed`,
    ]);
  }
  if (context.cropped > 0) {
    rows.push([
      'Cropped pages',
      `${context.cropped} — hidden outside the visible box, still in the file`,
    ]);
  }

  const named = Object.entries(report.metadata)
    .filter(([, value]) => value !== null && value !== '' && !isEpoch(value));
  rows.push([
    'Metadata fields',
    named.length === 0
      ? clean('all cleared')
      : dirty(named.map(([k, v]) => `${k}: ${escape(v)}`).join('<br>')),
  ]);

  rows.push(['XMP block', report.hasXmp ? dirty('present') : clean('removed')]);

  rows.push([
    'Embedded fonts',
    report.embeddedFontCount === 0
      ? clean('none')
      : `${report.embeddedFontCount} font program(s)`,
  ]);

  if (report.fonts.length > 0) {
    rows.push(['Font names', escape(report.fonts.join(', '))]);
  }

  rows.push(['Images', String(report.imageCount)]);
  rows.push([
    'Images carrying EXIF',
    report.imagesWithExif === 0
      ? clean('none')
      : dirty(`${report.imagesWithExif} — camera and GPS data may survive`),
  ]);

  rows.push([
    report.deepScan ? 'Byte scan (streams expanded)' : 'Byte scan (surface only)',
    report.auditHits.length === 0
      ? (report.deepScan
        ? clean('no known fingerprints')
        : `${clean('nothing on the surface')} — compressed streams not inspected`)
      : dirty(escape(report.auditHits.join(', '))),
  ]);

  for (const error of report.errors) {
    rows.push(['Warning', dirty(escape(error))]);
  }

  return `
    <table class="fp-table">
      <tbody>
        ${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}
      </tbody>
    </table>
    <p class="fp-note">
      This is what the saved file will contain, read back from the bytes
      themselves rather than from what the program meant to write.
    </p>
  `;
}

/** Epoch dates are the cleared value, not a real one. */
function isEpoch(value) {
  return value instanceof Date && value.getUTCFullYear() === 1970;
}
