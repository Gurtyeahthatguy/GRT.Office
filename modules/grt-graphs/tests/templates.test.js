// @vitest-environment jsdom

/** Drawing templates: written as .otg, read back, and read by LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readOdg, writeOdg } from '../src/js/core/formats/odg.js';
import { asTemplate } from '../src/js/core/formats/templates.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { GraphModel } from '../src/js/model.js';

function diagram() {
  const model = new GraphModel();
  const a = model.addNode({ x: 40, y: 40, text: 'Start' });
  const b = model.addNode({ x: 300, y: 40, text: 'End' });
  model.addEdge({ from: a.id, to: b.id });
  return model.toJSON();
}

describe('drawing templates', () => {
  it('are marked as templates and read like drawings', () => {
    const otg = asTemplate(writeOdg(diagram()).entries, 'otg');
    const pkg = decodeBlock(encodeBlock(otg));
    expect(new TextDecoder().decode(pkg.bytes('mimetype'))).toBe('application/vnd.oasis.opendocument.graphics-template');
    expect(readOdg(pkg).document.nodes.map((n) => n.text)).toEqual(['Start', 'End']);
  });

  it.skipIf(!oracleAvailable())('LibreOffice opens one and saves the drawing back', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'flow.otg');
      writeBlock(encodeBlock(asTemplate(writeOdg(diagram()).entries, 'otg')), file);
      const saved = convert(file, 'odg', join(dir, 'again'));
      expect(readOdg(decodeBlock(readBlock(saved))).document.nodes.map((n) => n.text).sort()).toEqual(['End', 'Start']);
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
