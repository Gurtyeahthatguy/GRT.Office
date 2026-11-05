// @vitest-environment jsdom

/** Presentation templates: written as .otp and .potx, read back, and read by LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readOdp, writeOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { asTemplate } from '../src/js/core/formats/templates.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { SlidesModel } from '../src/js/model.js';

function deck() {
  const model = new SlidesModel();
  model.setCanvas({ w: 1280, h: 720 });
  model.addElement(model.slides[0].id, { kind: 'text', x: 80, y: 40, w: 1000, h: 120, style: 'title', content: [{ text: 'Quarterly review' }] });
  return model.toJSON();
}
const texts = (document) => JSON.stringify(document).includes('Quarterly review');

describe('presentation templates', () => {
  it('are marked as templates and read like presentations', () => {
    const otp = decodeBlock(encodeBlock(asTemplate(writeOdp(deck()).entries, 'otp')));
    expect(new TextDecoder().decode(otp.bytes('mimetype'))).toBe('application/vnd.oasis.opendocument.presentation-template');
    expect(texts(readOdp(otp).document)).toBe(true);
    const potx = decodeBlock(encodeBlock(asTemplate(writePptx(deck()).entries, 'potx')));
    expect(new TextDecoder().decode(potx.bytes('[Content_Types].xml'))).toContain('presentationml.template.main+xml');
    expect(texts(readPptx(potx).document)).toBe(true);
  });

  it.skipIf(!oracleAvailable())('LibreOffice opens them and saves the slides back', () => {
    const dir = scratch();
    try {
      for (const [format, filter, read] of [['otp', 'odp', readOdp], ['potx', 'pptx:Impress MS PowerPoint 2007 XML', readPptx]]) {
        const entries = format === 'otp' ? writeOdp(deck()).entries : writePptx(deck()).entries;
        const file = join(dir, `deck.${format}`);
        writeBlock(encodeBlock(asTemplate(entries, format)), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        expect(texts(read(decodeBlock(readBlock(saved))).document)).toBe(true);
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
