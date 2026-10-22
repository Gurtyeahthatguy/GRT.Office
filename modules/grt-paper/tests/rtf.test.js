// @vitest-environment jsdom

/** Rich Text Format, read from text written the way word processors write it. */

import { describe, it, expect } from 'vitest';
import { readRtf } from '../src/js/core/formats/rtf-read.js';
import { DocumentModel, runsText } from '../src/js/core/editor/model.js';

const latin1 = (text) => new Uint8Array([...text].map((c) => c.charCodeAt(0) & 0xFF));
const read = (text) => readRtf(latin1(text));
const blocks = (result) => new DocumentModel(result.document).toJSON().blocks;

const HEADER = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman\\fcharset0 Times;}{\\f1\\fswiss\\fcharset204 Arial;}}'
  + '{\\colortbl;\\red255\\green0\\blue0;\\red255\\green255\\blue0;}'
  + '{\\stylesheet{\\s0 Normal;}{\\s1\\outlinelevel0 heading 1;}{\\s2 Quotations;}}';

describe('RTF', () => {
  it('reads formatting, colours and sizes', () => {
    const result = read(`${HEADER}\\pard\\plain Plain {\\b bold} {\\i\\ul both} {\\cf1 red} {\\highlight2 lit} {\\fs36 big} x{\\super 2}\\par}`);
    expect(blocks(result)[0].runs).toEqual([
      { text: 'Plain ' }, { text: 'bold', bold: true }, { text: ' ' }, { text: 'both', italic: true, underline: true },
      { text: ' ' }, { text: 'red', color: '#ff0000' }, { text: ' ' }, { text: 'lit', highlight: '#ffff00' },
      { text: ' ' }, { text: 'big', size: 18 }, { text: ' x' }, { text: '2', sup: true },
    ]);
  });

  it('reads code pages, escaped bytes and Unicode with its fallback', () => {
    const result = read(`${HEADER}\\pard caf\\'e8 {\\f1 \\'cf\\'f0\\'e8} \\uc1\\u8364?\\u-10179?\\u-8704? done\\par}`);
    expect(runsText(blocks(result)[0].runs)).toBe('cafè При €\u{1F600} done');
  });

  it('reads headings by outline level and by style, quotations, alignment and page breaks', () => {
    const result = read(`${HEADER}\\pard\\s1\\outlinelevel0 Title\\par\\pard\\s2\\qc Said\\par\\pard\\pagebb After\\par\\pard Plain\\page Next\\par}`);
    expect(blocks(result).map((b) => [b.kind, b.level ?? null, b.align, !!b.breakBefore, runsText(b.runs)])).toEqual([
      ['heading', 1, 'left', false, 'Title'],
      ['quote', null, 'center', false, 'Said'],
      ['paragraph', null, 'left', true, 'After'],
      ['paragraph', null, 'left', false, 'Plain'],
      ['paragraph', null, 'left', true, 'Next'],
    ]);
  });

  it('reads tables as rows of text, and footnotes at the end', () => {
    const result = read(`${HEADER}\\trowd\\cellx1000\\cellx2000\\pard\\intbl A1\\cell B1\\cell\\row\\pard Text{\\super\\chftn}{\\footnote\\pard\\plain A note.}\\par}`);
    const lines = blocks(result).map((b) => runsText(b.runs));
    expect(lines[0]).toBe('A1\tB1');
    expect(lines[1]).toBe('Text[1]');
    expect(lines.at(-1)).toBe('[1] A note.');
    expect(result.losses.lines()).toContain('Tables, kept as text with a tab between cells');
  });

  it('reads headers, footers, first and even pages, and page fields', () => {
    const fields = '{\\field{\\*\\fldinst PAGE}{\\fldrslt 1}} of {\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 3}}';
    const result = read(`${HEADER}\\facingp\\titlepg{\\headerr\\pard\\qr Odd}{\\headerl\\pard Even}{\\footerf\\pard\\qc Cover}`
      + `{\\footer\\pard\\qc Page ${fields}}\\pard Body\\par}`);
    expect(result.document.page.running).toEqual({
      firstDifferent: true,
      evenDifferent: true,
      header: { default: { text: 'Odd', align: 'right' }, first: null, even: { text: 'Even', align: 'left' } },
      footer: { default: { text: 'Page {page} of {pages}', align: 'center' }, first: { text: 'Cover', align: 'center' }, even: null },
    });
    expect(blocks(result).map((b) => runsText(b.runs))).toEqual(['Body']);
  });

  it('reads the page size and margins', () => {
    const result = read(`${HEADER}\\paperw16838\\paperh11906\\margl1134\\margr1134\\margt1701\\margb1417\\landscape\\pard x\\par}`);
    expect(result.document.page).toMatchObject({
      size: 'A4', orientation: 'landscape', margins: { left: 20, right: 20, top: 30, bottom: 25 },
    });
  });

  it('keeps reading after a footnote or header that opens with a group of its own', () => {
    const result = read(`${HEADER}{\\header{\\pard\\qc Top}}\\pard Note{\\footnote{\\chftn A note.}} after\\par\\pard Last\\par}`);
    expect(blocks(result).map((b) => runsText(b.runs))).toEqual(['Note[1] after', 'Last', '', '[1] A note.']);
    expect(result.document.page.running.header.default).toEqual({ text: 'Top', align: 'center' });
  });

  it('skips binary data by its length, braces and all', () => {
    const result = read(`${HEADER}{\\*\\shprslt\\bin12 }{\\par NOT }}\\pard text\\par}`);
    expect(blocks(result).map((b) => runsText(b.runs))).toEqual(['text']);
  });

  it('skips hidden text', () => {
    expect(runsText(blocks(read(`${HEADER}\\pard shown{\\v hidden} too\\par}`))[0].runs)).toBe('shown too');
  });

  it('reads Word 95 numbering, numbers and bullets apart', () => {
    const result = read(`${HEADER}\\pard{\\*\\pn\\pnlvlbody\\pndec{\\pntxta .}}{One\\par Two\\par}`
      + '\\pard{\\*\\pn\\pnlvlblt{\\pntxtb \\\'b7}}{Dot\\par}}');
    expect(blocks(result).map((b) => [b.listType, b.items.map((i) => runsText(i.runs))])).toEqual([
      ['number', ['One', 'Two']],
      ['bullet', ['Dot']],
    ]);
  });

  it('refuses what is not RTF', () => {
    expect(() => read('Hello')).toThrow('not an RTF file');
  });

  it('CANARY: an unformatted run carries no marks', () => {
    expect(blocks(read(`${HEADER}\\pard plain\\par}`))[0].runs).toEqual([{ text: 'plain' }]);
  });
});
