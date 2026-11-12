// @vitest-environment jsdom

/** Real documents listed in GRT_CORPUS, compared with the results kept beside the list. */

import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { readRtf } from '../src/js/core/formats/rtf-read.js';
import { decodeBlock } from '../src/js/core/package.js';
import { DocumentModel, itemsOf } from '../src/js/core/editor/model.js';
import { documentFields, referenceText } from '../src/js/core/editor/fields.js';
import {
  oracleAvailable, readBlock, convert, scratch, cleanup,
} from '../../../scripts/oracle.mjs';

const list = process.env.GRT_CORPUS;
const files = list && existsSync(list)
  ? readFileSync(list, 'utf8').split('\n').map((line) => line.trim())
    .filter((line) => /\.(odt|fodt|docx|rtf)$/i.test(line))
  : [];

function ours(file) {
  if (/\.fodt$/i.test(file)) return readOdt(readFileSync(file, 'utf8'));
  if (/\.rtf$/i.test(file)) return readRtf(new Uint8Array(readFileSync(file)));
  const pkg = decodeBlock(readBlock(file));
  return /\.odt$/i.test(file) ? readOdt(pkg) : readDocx(pkg);
}

function words(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** LibreOffice's text with list labels dropped: GRT draws them, it does not store them. */
function unlabelled(text) {
  return text.split('\n').map((line) => line.replace(/^[ \t]+\S+[ \t]/, '')).join('\n');
}

/** How much of LibreOffice's text is in ours, by words, as a fraction. */
function coverage(theirs, mine) {
  const counts = new Map();
  for (const word of mine) counts.set(word, (counts.get(word) ?? 0) + 1);
  let found = 0;
  for (const word of theirs) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      found += 1;
      counts.set(word, left - 1);
    }
  }
  return theirs.length === 0 ? 1 : found / theirs.length;
}

/** The words a reader sees: the runs, with references, notes and numbered captions as they are shown. */
function plain(document) {
  const model = new DocumentModel(document);
  const fields = documentFields(model);
  const shown = (object) => {
    if (object.type === 'note') return `${fields.notes.get(object)?.label ?? ''} ${shown.runs(object.runs)}`;
    if (object.type === 'ref') return referenceText(object, fields);
    if (object.type === 'seq') return String(fields.seqs.get(object.id)?.number ?? '');
    // A mail merge field shows its column's name, as LibreOffice and Word draw it.
    if (object.type === 'merge') return `«${object.name}»`;
    return '';
  };
  shown.runs = (runs) => runs.map((run) => (run.object ? ` ${shown(run.object)} ` : run.text)).join('');
  return model.toJSON().blocks.map((block) => {
    if (itemsOf(block)) return itemsOf(block).map((item) => shown.runs(item.runs)).join('\n');
    if (block.kind === 'image') return shown.runs(block.caption);
    return shown.runs(block.runs ?? []);
  }).join('\n');
}

const baselineFile = list ? `${list}.baseline.json` : null;
const baseline = baselineFile && existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
const results = {};
const key = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

/** Compares with what this document gave last time, or records it. */
function judge(file, share) {
  const id = key(file);
  results[id] = share;
  if (process.env.GRT_CORPUS_UPDATE) return;
  const before = baseline[id];
  if (before === undefined) expect(share).toBeGreaterThan(0.98);
  else expect(share).toBeGreaterThanOrEqual(before - 0.01);
}

describe.skipIf(files.length === 0 || !oracleAvailable())('the corpus', () => {
  const dir = files.length ? scratch() : null;
  afterAll(() => {
    cleanup(dir);
    if (process.env.GRT_CORPUS_UPDATE) writeFileSync(baselineFile, `${JSON.stringify(results, null, 1)}\n`);
  });
  for (const [index, file] of files.entries()) {
    const label = file.includes('/GRT Corpus/') ? file.split('/GRT Corpus/')[1] : `document ${index + 1}`;
    it(`${label} (${file.split('.').pop()})`, () => {
      let result;
      try {
        result = ours(file);
      } catch (error) {
        const out = join(dir, String(index));
        let opened = true;
        try {
          convert(file, 'txt:Text (encoded):UTF8', out);
        } catch {
          opened = false;
        } finally {
          cleanup(out);
        }
        console.log(`[corpus] ${label}: ${opened ? 'ERROR' : 'refused, as LibreOffice did'}: ${error.message.split('\n')[0]}`);
        if (opened) {
          results[key(file)] = 0;
          if (!process.env.GRT_CORPUS_UPDATE) throw error;
        }
        return;
      }
      const mine = words(plain(result.document));
      const out = join(dir, String(index));
      let theirs;
      try {
        theirs = words(unlabelled(readFileSync(convert(file, 'txt:Text (encoded):UTF8', out), 'utf8')));
      } catch {
        console.log(`[corpus] ${label}: ${result.document.blocks.length} blocks; LibreOffice could not convert it`);
        return;
      } finally {
        cleanup(out);
      }
      const share = coverage(theirs, mine);
      const blocks = result.document.blocks.length;
      console.log(`[corpus] ${label}: ${blocks} blocks, ${result.images.size} pictures, `
        + `${Math.round(share * 1000) / 10}% of LibreOffice's ${theirs.length} words; `
        + `lost: ${result.losses.lines().join('; ') || 'nothing'}`);
      judge(file, share);
    }, 120000);
  }
});
