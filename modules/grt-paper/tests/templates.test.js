// @vitest-environment jsdom

/** Text templates: written as .ott and .dotx, read back, and opened by LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { asTemplate } from '../src/js/core/formats/templates.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { readFileSync } from 'node:fs';
import { oracleAvailable, scratch, cleanup, writeBlock, convert } from '../../../scripts/oracle.mjs';
import { sample } from './samples.js';

const text = (entries, name) => new TextDecoder().decode(decodeBlock(encodeBlock(entries)).bytes(name));
const words = (document) => JSON.stringify(document).match(/Lorem|[A-Z][a-z]+/g)?.length ?? 0;

describe('text templates', () => {
  it('are marked as templates and read like documents', () => {
    const { model, images } = sample();
    const document = model.toJSON();
    const ott = asTemplate(writeOdt(document, images).entries, 'ott');
    expect(text(ott, 'mimetype')).toBe('application/vnd.oasis.opendocument.text-template');
    expect(words(readOdt(decodeBlock(encodeBlock(ott))).document)).toBe(words(readOdt(decodeBlock(encodeBlock(writeOdt(document, images).entries))).document));
    const dotx = asTemplate(writeDocx(document, images).entries, 'dotx');
    expect(text(dotx, '[Content_Types].xml')).toContain('wordprocessingml.template.main+xml');
    expect(readDocx(decodeBlock(encodeBlock(dotx))).document.blocks.length).toBeGreaterThan(0);
  });

  it.skipIf(!oracleAvailable())('LibreOffice reads the text inside them', () => {
    const dir = scratch();
    try {
      const { model, images } = sample();
    const document = model.toJSON();
      for (const format of ['ott', 'dotx']) {
        const entries = format === 'ott' ? writeOdt(document, images).entries : writeDocx(document, images).entries;
        const file = join(dir, `letter.${format}`);
        writeBlock(encodeBlock(asTemplate(entries, format)), file);
        const out = convert(file, 'txt:Text', join(dir, `text-${format}`));
        expect(readFileSync(out, 'utf8').trim().length).toBeGreaterThan(10);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
