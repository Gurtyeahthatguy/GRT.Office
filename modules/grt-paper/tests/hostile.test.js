// @vitest-environment jsdom

/** Files made to hurt the readers: each one opens or gives an error, quickly, and nothing worse. */

import { describe, it, expect } from 'vitest';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { readOds } from '../src/js/core/formats/ods.js';
import { readXlsx } from '../src/js/core/formats/xlsx.js';
import { readOdp } from '../src/js/core/formats/odp.js';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { readOdg } from '../src/js/core/formats/odg.js';
import { readRtf } from '../src/js/core/formats/rtf-read.js';
import { readCanvas } from '../src/js/core/formats/canvas.js';
import { readMarkdown } from '../src/js/core/formats/markdown-read.js';
import { readObsidianNote } from '../src/js/core/formats/obsidian.js';
import { parseCsv } from '../src/js/core/csv.js';
import { drawable } from '../src/js/core/images.js';

const pkg = (entries) => decodeBlock(encodeBlock(Object.entries(entries).map(([name, data]) => ({ name, data }))));

const LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lollollollollollollollollollol">
  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
  <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
  <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
  <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
  <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
]>`;

const ODF = (prefix, body, mime = 'text') => `${prefix}<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
  office:version="1.3"><office:body><office:${mime}>${body}</office:${mime}></office:body></office:document-content>`;

const odfPackage = (kind, content) => pkg({
  mimetype: `application/vnd.oasis.opendocument.${kind}`,
  'content.xml': content,
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (prefix, body) => pkg({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `${prefix}<w:document ${W}><w:body>${body}</w:body></w:document>`,
});

const xlsx = (sheet, extra = {}) => pkg({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="s1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet}</worksheet>`,
  ...extra,
});

/** Runs a reader on a hostile input: it may return or throw, but within the time, and never with a stack overflow. */
async function survives(read, seconds = 5) {
  const start = performance.now();
  let error = null;
  try {
    await read();
  } catch (err) {
    error = err;
  }
  const elapsed = (performance.now() - start) / 1000;
  expect(elapsed).toBeLessThan(seconds);
  if (error) expect(error).not.toBeInstanceOf(RangeError);
  return error;
}

const deep = (open, close, n, inner = '') => open.repeat(n) + inner + close.repeat(n);

describe('XML entities', () => {
  it('are refused in every reader, not expanded', async () => {
    const cases = [
      () => readOdt(odfPackage('text', ODF(LAUGHS, '<text:p>&lol8;</text:p>'))),
      () => readOds(odfPackage('spreadsheet', ODF(LAUGHS, '<table:table><table:table-row><table:table-cell><text:p>&lol8;</text:p></table:table-cell></table:table-row></table:table>', 'spreadsheet'))),
      () => readOdp(odfPackage('presentation', ODF(LAUGHS, '<draw:page><draw:frame><draw:text-box><text:p>&lol8;</text:p></draw:text-box></draw:frame></draw:page>', 'presentation'))),
      () => readOdg(odfPackage('graphics', ODF(LAUGHS, '<draw:page/>', 'drawing'))),
      () => readDocx(docx(LAUGHS, '<w:p><w:r><w:t>&lol8;</w:t></w:r></w:p>')),
      () => readXlsx(xlsx('<sheetData/>', { 'xl/sharedStrings.xml': `${LAUGHS}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&lol8;</t></si></sst>` })),
    ];
    for (const read of cases) {
      const error = await survives(read);
      expect(String(error?.message)).toMatch(/entit/i);
    }
  });
});

describe('nesting a hundred thousand levels deep', () => {
  it('gives an error or a document, never a stack overflow', async () => {
    const n = 100000;
    await survives(() => readOdt(odfPackage('text', ODF('', deep('<text:list><text:list-item>', '</text:list-item></text:list>', n, '<text:p>x</text:p>')))));
    await survives(() => readOdt(odfPackage('text', ODF('', `<text:p>${deep('<text:span>', '</text:span>', n, 'x')}</text:p>`))));
    await survives(() => readDocx(docx('', deep('<w:tbl><w:tr><w:tc>', '</w:tc></w:tr></w:tbl>', n, '<w:p/>'))));
    await survives(() => readOdp(odfPackage('presentation', ODF('', `<draw:page>${deep('<draw:g>', '</draw:g>', n)}</draw:page>`, 'presentation'))));
    await survives(() => readRtf(`{\\rtf1 ${deep('{', '}', n, 'x')}}`));
    await survives(() => readMarkdown(`${'> '.repeat(n)}x`));
    await survives(() => readMarkdown(`${Array.from({ length: 5000 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n')}`));
    await survives(() => readCanvas(JSON.stringify(deep('[', ']', n))));
  });
});

describe('sizes a file only claims', () => {
  it('a spreadsheet that reaches the last cell opens without filling the sheet', async () => {
    await survives(() => readXlsx(xlsx('<dimension ref="A1:XFD1048576"/><cols><col min="1" max="16384" width="9"/></cols><sheetData><row r="1048576" spans="1:16384"><c r="XFD1048576"><v>1</v></c></row></sheetData><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells>')));
    const repeated = '<table:table><table:table-column table:number-columns-repeated="16384"/>'
      + '<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384" office:value-type="float" office:value="1"/></table:table-row></table:table>';
    await survives(() => readOds(odfPackage('spreadsheet', ODF('', repeated, 'spreadsheet'))));
  });

  it('a formula nested a hundred thousand times', async () => {
    const formula = `of:=${'('.repeat(100000)}1${')'.repeat(100000)}`;
    await survives(() => readOds(odfPackage('spreadsheet', ODF('', `<table:table><table:table-row><table:table-cell table:formula="${formula}"/></table:table-row></table:table>`, 'spreadsheet'))));
    await survives(() => readXlsx(xlsx(`<sheetData><row r="1"><c r="A1"><f>${'('.repeat(100000)}1${')'.repeat(100000)}</f></c></row></sheetData>`)));
  });

  it('an RTF that says a binary run is gigabytes long', async () => {
    await survives(() => readRtf('{\\rtf1 {\\pict\\pngblip\\bin2000000000 abc}}'));
    await survives(() => readRtf(`{\\rtf1 \\u${'9'.repeat(400)}? x}`));
  });

  it('text with no line breaks and unbalanced quotes', async () => {
    await survives(() => parseCsv(`"${'a,'.repeat(2_000_000)}`));
    await survives(() => parseCsv('a,'.repeat(1_000_000)));
    await survives(() => readObsidianNote(`---\n${'k: ['.repeat(50000)}\n---\n${'*a'.repeat(100000)}`));
    await survives(() => readMarkdown(`${'*a'.repeat(100000)} ${'[['.repeat(50000)} ${'_'.repeat(100000)}`));
  });
});

describe('pictures', () => {
  const png = (w, h) => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bytes.buffer).setUint32(16, w);
    new DataView(bytes.buffer).setUint32(20, h);
    return bytes;
  };

  it('one that would take gigabytes to decode is not drawn', () => {
    expect(drawable(png(4000, 3000))).toBe(true);
    expect(drawable(png(60000, 60000))).toBe(false);
    expect(drawable(new TextEncoder().encode(`${LAUGHS}<svg xmlns="http://www.w3.org/2000/svg"><text>&lol8;</text></svg>`))).toBe(false);
    expect(drawable(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
  });
});
