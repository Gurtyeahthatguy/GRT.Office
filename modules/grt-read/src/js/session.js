/** A document's unsaved state as one file: the edited pages and the PDFs behind them. */


const MAGIC = 'GRTREAD1';
const VERSION = 1;
const ROTATIONS = new Set([0, 90, 180, 270]);

const damaged = () => new Error('The recovery copy is damaged');

/**
 * @param {import('./document-model.js').DocumentModel} model
 * @param {object} exportOptions watermark, page numbers and metadata
 * @returns {Uint8Array}
 */
export function encodeSession(model, exportOptions) {
  const header = new TextEncoder().encode(JSON.stringify({
    version: VERSION,
    sources: model.sources.map((source) => source.bytes.length),
    pages: model.snapshot().pages,
    exportOptions,
  }));

  const size = model.sources.reduce((sum, source) => sum + source.bytes.length, 0);
  const out = new Uint8Array(12 + header.length + size);
  for (let i = 0; i < MAGIC.length; i += 1) out[i] = MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, header.length, true);
  out.set(header, 12);

  let at = 12 + header.length;
  for (const { bytes } of model.sources) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{sources: Uint8Array[], pages: object[], exportOptions: object}}
 */
export function decodeSession(bytes) {
  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  if (bytes.length < 12 || magic !== MAGIC) {
    throw new Error('This is not a recovery copy of GRT Read');
  }

  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (12 + length > bytes.length) throw damaged();

  let header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + length)));
  } catch {
    throw damaged();
  }
  if (header?.version !== VERSION || !Array.isArray(header.sources)
    || !Array.isArray(header.pages) || header.sources.length === 0) {
    throw damaged();
  }

  const sizes = header.sources;
  if (!sizes.every((size) => Number.isInteger(size) && size >= 0)) throw damaged();
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (12 + length + total !== bytes.length) throw damaged();

  const sources = [];
  let at = 12 + length;
  for (const size of sizes) {
    sources.push(bytes.slice(at, at + size));
    at += size;
  }

  if (!header.pages.every((page) => validPage(page, sources.length))) throw damaged();

  const options = header.exportOptions ?? {};
  const objectOrNull = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  return {
    sources,
    pages: header.pages,
    exportOptions: {
      watermark: objectOrNull(options.watermark),
      pageNumbers: objectOrNull(options.pageNumbers),
      metadata: objectOrNull(options.metadata),
    },
  };
}

function validPage(page, sourceCount) {
  if (!page || typeof page !== 'object') return false;
  if (!Number.isInteger(page.sourceId) || page.sourceId < 0 || page.sourceId >= sourceCount) return false;
  if (!Number.isInteger(page.originalIndex) || page.originalIndex < 0) return false;
  if (!ROTATIONS.has(page.rotation) || typeof page.deleted !== 'boolean') return false;
  if (page.crop !== null && (typeof page.crop !== 'object' || !finiteSides(page.crop))) return false;
  return Array.isArray(page.marks) && page.marks.every((mark) =>
    mark && typeof mark.type === 'string' && mark.rect && typeof mark.rect === 'object'
    && finiteSides(mark.rect));
}

function finiteSides(box) {
  return Object.values(box).every((value) => Number.isFinite(value));
}
