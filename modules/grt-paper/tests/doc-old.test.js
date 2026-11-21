// @vitest-environment jsdom

/** Word 6, 95 and Word for Windows 2 documents, made here byte by byte: LibreOffice reads each as Paper does, which proves the files are what the format says. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readDoc } from '../src/js/core/formats/doc.js';
import { writeCfb } from '../src/js/core/formats/cfb.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { decodeBlock } from '../src/js/core/package.js';
import { runsText } from '../src/js/core/editor/model.js';
import { oracleAvailable, scratch, cleanup, readBlock, convert } from '../../../scripts/oracle.mjs';

const TEXT = 'Primo paragrafo con città.\rSecondo\x02 con nota.\rUn campo: \x13PAGE\x141\x15 qui.\rFine.\r';
const NOTES = '\x02 La nota.\r\r';
const latin = (s) => Uint8Array.from([...s].map((c) => (c === 'à' ? 0xe0 : c.charCodeAt(0))));

/** A Word 6 document: the text where fcMin says, or, fast-saved, in two pieces in reverse order through the piece table. */
function word6({ complex = false } = {}) {
  const all = TEXT + NOTES;
  const fcMin = 0x400;
  const body = new Uint8Array(0x1000);
  const v = new DataView(body.buffer);
  v.setUint16(0, 0xa5dc, true); v.setUint16(2, 101, true); v.setUint16(4, 0x6027, true); v.setUint16(6, 0x0409, true);
  v.setUint16(10, complex ? 0x0004 : 0, true);
  v.setUint32(0x18, fcMin, true);
  v.setUint32(0x1c, fcMin + all.length, true);
  v.setUint32(0x20, body.length, true);
  v.setUint32(0x34, TEXT.length, true);
  v.setUint32(0x38, NOTES.length, true);
  let at = 0x800;
  const plc = (list) => { const start = at; for (const x of list) { v.setUint32(at, x, true); at += 4; } return [start, at - start]; };
  const [fRef, lRef] = plc([TEXT.indexOf('\x02'), TEXT.length]);
  v.setUint16(at, 1, true); at += 2;
  v.setUint32(0x68, fRef, true); v.setUint32(0x6c, lRef + 2, true);
  const [fTxt, lTxt] = plc([0, NOTES.length - 1, NOTES.length]);
  v.setUint32(0x70, fTxt, true); v.setUint32(0x74, lTxt, true);
  if (!complex) body.set(latin(all), fcMin);
  else {
    // The second half first in the file, the piece table putting them back in order.
    const half = 20;
    body.set(latin(all.slice(half)), fcMin);
    body.set(latin(all.slice(0, half)), fcMin + all.length - half + 16);
    at = 0xa00;
    const clx = at;
    body[at] = 0x02; at += 1;
    v.setUint32(at, 3 * 4 + 2 * 8, true); at += 4;
    for (const cp of [0, half, all.length]) { v.setUint32(at, cp, true); at += 4; }
    for (const fc of [fcMin + all.length - half + 16, fcMin]) { v.setUint16(at, 0, true); v.setUint32(at + 2, fc, true); v.setUint16(at + 6, 0, true); at += 8; }
    v.setUint32(0x160, clx, true); v.setUint32(0x164, at - clx, true);
  }
  return writeCfb(new Map([['WordDocument', body]]));
}

function winword2() {
  const text = 'Testo di Word 2 con città.\rSecondo.\r';
  const data = new Uint8Array(0x180 + text.length + 256);
  const v = new DataView(data.buffer);
  v.setUint16(0, 0xa5db, true); v.setUint16(2, 45, true); v.setUint16(6, 0x0409, true);
  v.setUint32(0x18, 0x180, true); v.setUint32(0x1c, 0x180 + text.length, true); v.setUint32(0x20, data.length, true); v.setUint32(0x34, text.length, true);
  data.set(latin(text), 0x180);
  return data;
}

const paragraphs = (doc) => doc.blocks.filter((b) => b.kind === 'paragraph').map((b) => runsText(b.runs).replace(/￼/g, '').trim()).filter(Boolean);
const noteOf = (doc) => doc.blocks.flatMap((b) => b.runs ?? []).find((r) => r.object?.type === 'note');

describe('Word 6, 95 and Word for Windows 2', () => {
  for (const complex of [false, true]) {
    it(`Word 6, ${complex ? 'fast-saved, through its piece table' : 'its text in one run'}: paragraphs, a field's result and a footnote`, () => {
      const { document, losses } = readDoc(word6({ complex }));
      expect(paragraphs(document)).toEqual(['Primo paragrafo con città.', 'Secondo con nota.', 'Un campo: 1 qui.', 'Fine.']);
      expect(runsText(noteOf(document).object.runs)).toBe('La nota.');
      expect(losses.lines().join()).toMatch(/Looks of Word 6 and 95/);
    });
  }

  it('Word for Windows 2: its text and paragraphs', () => {
    expect(paragraphs(readDoc(winword2()).document)).toEqual(['Testo di Word 2 con città.', 'Secondo.']);
  });

  it('refuse damaged ones quickly, with an error and nothing else', () => {
    for (const good of [word6(), word6({ complex: true }), winword2()]) {
      let seed = 5;
      const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      for (let n = 0; n < 200; n += 1) {
        const bad = good.slice();
        for (let k = 0; k < 10; k += 1) bad[Math.floor(random() * bad.length)] = Math.floor(random() * 256);
        try { readDoc(bad); } catch (error) { expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(RangeError); }
      }
    }
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Word 6, 95 and 2', () => {
  it('reads the documents made here as Paper does', () => {
    const dir = scratch();
    try {
      for (const complex of [false, true]) {
        const file = join(dir, `w6${complex ? 'c' : ''}.doc`);
        writeFileSync(file, word6({ complex }));
        const back = readOdt(decodeBlock(readBlock(convert(file, 'odt', join(dir, 'odt'))))).document;
        // The field is left out: without the list of fields a real file has, LibreOffice shows its marks as characters.
        expect(paragraphs(back).filter((p) => !p.startsWith('Un campo'))).toEqual(['Primo paragrafo con città.', 'Secondo con nota.', 'Fine.']);
        expect(runsText(noteOf(back).object.runs).trim()).toBe('La nota.');
      }
      writeFileSync(join(dir, 'w2.doc'), winword2());
      expect(paragraphs(readOdt(decodeBlock(readBlock(convert(join(dir, 'w2.doc'), 'odt', join(dir, 'odt2'))))).document)).toEqual(['Testo di Word 2 con città.', 'Secondo.']);
    } finally { cleanup(dir); }
  }, 120000);
});
