// @vitest-environment jsdom

/** Formulas through the files: MathML objects with their TeX in .odt, Office Math in .docx, and LibreOffice. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DocumentModel, OBJECT } from '../src/js/core/editor/model.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { safeMath, mathmlToOmml } from '../src/js/core/formats/math-ml.js';
import { serialize } from '../src/js/core/xml.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

const M = 'http://www.w3.org/1998/Math/MathML';
const QUADRATIC = `<math xmlns="${M}"><mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac><mo>+</mo><msup><mi>c</mi><mn>2</mn></msup><mo>+</mo><msqrt><mi>d</mi></msqrt></math>`;
const formula = (display = false) => ({ text: OBJECT, object: { type: 'math', tex: 'x = \\frac{-b}{2a} + c^2 + \\sqrt{d}', mathml: QUADRATIC, ...(display ? { display: true } : {}) } });
const document = () => new DocumentModel({ blocks: [{ kind: 'paragraph', runs: [{ text: 'So ' }, formula(), { text: '.' }] }] }).toJSON();

/** The formula as its structure reads: element names and text, independent of how it is written. */
function shape(doc) {
  const run = doc.blocks.flatMap((b) => b.runs ?? []).find((r) => r.object?.type === 'math');
  const math = safeMath(run.object.mathml);
  const walk = (el) => (el.children.length ? [el.localName, ...[...el.children].map(walk)] : `${el.localName}:${el.textContent}`);
  const flat = JSON.stringify(walk(math)).replace(/"mrow",?/g, '').replace(/\[\]/g, '').replace(/,+/g, ',').replace(/\[,/g, '[').replace(/,\]/g, ']');
  return { tex: run.object.tex ?? null, structure: ['mfrac', 'msup', 'msqrt'].map((name) => flat.includes(name)), text: math.textContent.replace(/\s/g, '') };
}

describe('formulas in the files', () => {
  it('keep MathML only, nothing that runs', () => {
    const math = safeMath(`<math xmlns="${M}" onload="x"><mi href="javascript:1">x</mi><script xmlns="http://www.w3.org/1999/xhtml">1</script></math>`);
    const out = new XMLSerializer().serializeToString(math);
    expect(out).not.toMatch(/onload|href|script/);
  });

  it('turn into Office Math with fractions, powers and roots', () => {
    const omml = serialize(mathmlToOmml(QUADRATIC));
    expect(omml).toMatch(/<m:f>.*<m:num>.*<m:den>/);
    expect(omml).toContain('<m:sSup>');
    expect(omml).toContain('<m:rad>');
  });

  it('come back from .odt with their TeX, and from .docx as the same formula', () => {
    const odt = shape(readOdt(decodeBlock(encodeBlock(writeOdt(document()).entries))).document);
    expect(odt).toEqual({ tex: 'x = \\frac{-b}{2a} + c^2 + \\sqrt{d}', structure: [true, true, true], text: 'x=−b2a+c2+d' });
    expect(shape(readOdt(writeOdt(document(), new Map(), { flat: true }).text).document)).toEqual(odt);
    expect(shape(readDocx(decodeBlock(encodeBlock(writeDocx(document()).entries))).document)).toEqual({ ...odt, tex: null });
  });

  it.skipIf(!oracleAvailable())('come back from LibreOffice, in both formats', () => {
    const dir = scratch();
    try {
      for (const [format, filter, write, read] of [['odt', 'odt', writeOdt, readOdt], ['docx', 'docx:MS Word 2007 XML', writeDocx, readDocx]]) {
        const file = join(dir, `formula.${format}`);
        writeBlock(encodeBlock(write(document()).entries), file);
        const saved = convert(file, filter, join(dir, `again-${format}`));
        const back = shape(read(decodeBlock(readBlock(saved))).document);
        expect(back.structure, format).toEqual([true, true, true]);
        expect(back.text, format).toBe('x=−b2a+c2+d');
      }
    } finally {
      cleanup(dir);
    }
  }, 180000);
});
