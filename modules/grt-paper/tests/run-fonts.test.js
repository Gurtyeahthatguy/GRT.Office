// @vitest-environment jsdom

/** A font of the text's own, from the Font Name box: kept in .odt and .docx, and LibreOffice reads it the same. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { encodeBlock, decodeBlock } from '../src/js/core/package.js';
import { DocumentModel, normaliseRuns } from '../src/js/core/editor/model.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const doc = () => new DocumentModel({ blocks: [{ kind: 'paragraph', runs: [{ text: 'Plain ' }, { text: 'mono', font: 'DejaVu Sans Mono' }, { text: ' and ' }, { text: 'sans', font: 'Liberation Sans', bold: true }] }] }).toJSON();
const fontOf = (d, text) => d.blocks[0].runs.find((r) => r.text === text)?.font ?? null;

describe('Fonts of the text', () => {
  it('are kept by the model, refused when they are not a name', () => {
    expect(normaliseRuns([{ text: 'a', font: ' DejaVu Sans ' }])[0].font).toBe('DejaVu Sans');
    expect(normaliseRuns([{ text: 'a', font: 'x;} body{' }])[0].font).toBeUndefined();
    expect(normaliseRuns([{ text: 'a', font: 'A' }, { text: 'b', font: 'A' }])).toHaveLength(1);
  });

  it('come back from .odt and .docx', () => {
    const odt = readOdt(decodeBlock(encodeBlock(writeOdt(doc()).entries))).document;
    expect(fontOf(odt, 'mono')).toBe('DejaVu Sans Mono');
    expect(fontOf(odt, 'Plain ')).toBeNull();
    const docx = readDocx(decodeBlock(encodeBlock(writeDocx(doc()).entries))).document;
    expect(fontOf(docx, 'sans')).toBe('Liberation Sans');
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and the fonts of the text', () => {
  it('reads them from what Paper writes, and writes them back', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'fonts.odt');
      writeBlock(encodeBlock(writeOdt(doc()).entries), file);
      const docx = readDocx(decodeBlock(readBlock(convert(file, 'docx:MS Word 2007 XML', join(dir, 'docx'))))).document;
      expect(fontOf(docx, 'mono')).toBe('DejaVu Sans Mono');
      expect(fontOf(docx, 'sans')).toBe('Liberation Sans');
      void readFileSync;
    } finally { cleanup(dir); }
  }, 120000);
});
