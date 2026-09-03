/** Save pipeline. */

import { PDFDocument, degrees } from '../vendor/pdf-lib.esm.js';
import { stripMetadata, auditBytes } from './core/metadata.js';
import {
  applyCrops, applyWatermark, applyPageNumbers, applyMetadata, applyMarks,
} from './operations.js';

/**
 * Builds the final PDF bytes from an explicit page plan.
 * @param {DocumentModel} model
 * @param {{sourceId: number, originalIndex: number, rotation: number}[]} plan
 * @param {Object} [options]
 * @param {boolean} [options.audit=true]
 * @param {Object} [options.watermark] {text, opacity, size}
 * @param {Object} [options.pageNumbers] {start, position, format, size}
 * @param {Object} [options.metadata] fields the user asked to set deliberately
 * @returns {Promise<Uint8Array>}
 */
export async function buildBytesFromPlan(model, plan, options = {}) {
  const { audit = true, watermark, pageNumbers, metadata } = options;

  if (plan.length === 0) {
    throw new Error('No pages to save');
  }

  // Destination document: new and empty.
  const output = await PDFDocument.create({ updateMetadata: false });

  // Plan positions grouped by the source they read from.
  const positionsBySource = new Map();
  plan.forEach((step, position) => {
    const list = positionsBySource.get(step.sourceId);
    if (list) list.push(position);
    else positionsBySource.set(step.sourceId, [position]);
  });

  const copiedByPosition = new Array(plan.length);

  for (const [sourceId, positions] of positionsBySource) {
    const source = model.sources[sourceId];
    if (!source) throw new Error(`Unknown page source ${sourceId}`);

    // updateMetadata: false stops pdf-lib from rewriting /Producer and
    // /ModDate as early as load time.
    const sourceDoc = await PDFDocument.load(source.bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    });

    // copyPages copies only the objects actually referenced by the requested
    // pages.
    const indices = positions.map((position) => plan[position].originalIndex);
    const copied = await output.copyPages(sourceDoc, indices);

    copied.forEach((page, i) => {
      copiedByPosition[positions[i]] = page;
    });
  }

  copiedByPosition.forEach((page, i) => {
    const { rotation } = plan[i];
    if (rotation !== 0) {
      // The rotation must be added to whatever the original page already had.
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + rotation) % 360));
    }
    output.addPage(page);
  });

  // Redaction rewrites content streams, so it runs before anything is drawn
  // on top and before the crop box narrows what is visible.
  const marks = applyMarks(output, copiedByPosition, plan);
  if (marks.leaked.length > 0) {
    // Refusing to produce the file is the only safe outcome.
    throw new Error(
      `Redaction incomplete: ${marks.leaked.length} passage(s) survived the `
      + 'rewrite, so the file was not written. Please report the document.',
    );
  }

  applyCrops(copiedByPosition, plan);

  // Decorations are drawn onto the pages already in the output document, so
  // they go through exactly the same serialisation as everything else.
  if (watermark?.text) await applyWatermark(output, copiedByPosition, watermark);
  if (pageNumbers) await applyPageNumbers(output, copiedByPosition, pageNumbers);

  // Metadata stripping AFTER construction.
  stripMetadata(output);
  applyMetadata(output, metadata);

  const bytes = await output.save({
    useObjectStreams: true,   // reduces file size.
    addDefaultPage: false,
  });

  if (audit) {
    const found = auditBytes(bytes);
    if (found.length > 0) {
      // Not fatal: the fingerprint panel is what shows this to the user
      // before saving.
      console.warn('[GRT] Residual fingerprints in the saved file:', found);
    }
  }

  return bytes;
}

/**
 * Builds the final PDF bytes for the whole document.
 * @param {DocumentModel} model
 * @param {Object} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function buildOutputBytes(model, options = {}) {
  return buildBytesFromPlan(model, model.buildPlan(), options);
}

/**
 * Writes bytes to disk through the Rust backend.
 * @param {Uint8Array} bytes
 * @param {string} path
 */
export async function writeBytes(bytes, path) {
  const { invoke } = window.__TAURI__.core;

  await invoke('write_file_atomic', bytes, {
    headers: { 'x-grt-path': encodeURIComponent(path) },
  });
}

/**
 * Saves the document to disk.
 * @param {DocumentModel} model
 * @param {string} path
 */
export async function saveToFile(model, path) {
  const bytes = await buildOutputBytes(model);
  await writeBytes(bytes, path);
  model.path = path;
  model.dirty = false;
}
