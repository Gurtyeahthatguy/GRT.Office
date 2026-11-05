// @vitest-environment jsdom

/** Formula files: MathML on its own and LibreOffice Math's .odf, checked against LibreOffice. */

import { describe, it, expect } from 'vitest';

describe('formula files and LibreOffice Math', async () => {
  const { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } = await import('../../../scripts/oracle.mjs');
  const { readFormulaFile, formulaPackage } = await import('../src/js/core/formats/math-ml.js');
  const { decodeBlock, encodeBlock } = await import('../src/js/core/package.js');
  const { join } = await import('node:path');
  const { readFileSync } = await import('node:fs');
  const M = 'http://www.w3.org/1998/Math/MathML';
  const object = { type: 'math', tex: 'a^2+b^2', mathml: `<math xmlns="${M}"><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup></math>` };
  it('reads a MathML file and writes a .odf that reads back the same', () => {
    const written = decodeBlock(encodeBlock(formulaPackage(object)));
    expect(written.text('mimetype')).toBe('application/vnd.oasis.opendocument.formula');
    expect(readFormulaFile(written.text('content.xml'))).toMatchObject({ tex: 'a^2+b^2', display: true });
    expect(readFormulaFile('<p>no formula</p>')).toBe(null);
  });
  it.skipIf(!oracleAvailable())('LibreOffice Math opens the .odf, and its MathML comes back', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'formula.odf');
      writeBlock(encodeBlock(formulaPackage(object)), file);
      const mml = convert(file, 'mml', join(dir, 'out'));
      const back = readFormulaFile(readFileSync(mml, 'utf8'));
      expect(back.mathml).toMatch(/<msup>.*<mi>a<\/mi>.*<mn>2<\/mn>/s);
      const odf = convert(mml, 'odf', join(dir, 'again'));
      expect(readFormulaFile(decodeBlock(readBlock(odf)).text('content.xml')).mathml).toMatch(/<msup>/);
    } finally {
      cleanup(dir);
    }
  }, 120000);
});
