// @vitest-environment jsdom

/** Word 2003 XML documents: what Paper writes comes back, LibreOffice reads it the same, and what LibreOffice writes Paper reads. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readWordml2003, writeWordml2003 } from '../src/js/core/formats/wordml-2003.js';
import { writeOdt } from '../src/js/core/formats/odt-write.js';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { encodeBlock, decodeBlock } from '../src/js/core/package.js';
import { DocumentModel, OBJECT, runsText } from '../src/js/core/editor/model.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';

function sample() {
  return new DocumentModel({ blocks: [
    { kind: 'heading', level: 1, runs: [{ text: 'Titolo' }] },
    { kind: 'paragraph', runs: [{ text: 'Testo ' }, { text: 'grassetto', bold: true }, { text: ' e ' }, { text: 'rosso', color: '#ff0000', italic: true }, { text: ' con nota' }, { text: OBJECT, object: { type: 'note', kind: 'foot', runs: [{ text: 'La nota.' }] } }, { text: ', più ' }, { text: 'sopra', sup: true }, { text: ' e ' }, { text: 'un link', link: 'https://example.org/' }] },
    { kind: 'heading', level: 2, runs: [{ text: 'Sezione' }] },
    { kind: 'list', listType: 'number', items: [{ level: 0, runs: [{ text: 'uno' }] }, { level: 0, runs: [{ text: 'due' }] }] },
    { kind: 'list', listType: 'bullet', items: [{ level: 0, runs: [{ text: 'punto' }] }] },
    { kind: 'table', rows: [{ cells: [{ runs: [{ text: 'A1' }] }, { runs: [{ text: 'B1' }] }] }, { cells: [{ runs: [{ text: 'A2' }] }, { runs: [{ text: 'B2', bold: true }] }] }] },
    { kind: 'paragraph', align: 'center', runs: [{ text: 'Centrato & <segni>' }] },
  ] }).toJSON();
}

const texts = (blocks) => blocks.flatMap((b) => (b.kind === 'table' ? b.rows.flatMap((r) => r.cells.map((c) => runsText(c.runs))) : b.kind === 'list' ? b.items.map((i) => runsText(i.runs)) : [runsText(b.runs ?? [])])).map((t) => t.replace(/￼/g, '').trim()).filter(Boolean);

function check(doc, { lists = true } = {}) {
  const blocks = doc.blocks;
  expect(texts(blocks)).toEqual(expect.arrayContaining(['Titolo', 'Sezione', 'A1', 'B2', 'Centrato & <segni>', 'uno', 'punto']));
  expect(blocks.find((b) => b.kind === 'heading' && runsText(b.runs) === 'Titolo').level).toBe(1);
  expect(blocks.find((b) => b.kind === 'heading' && runsText(b.runs) === 'Sezione').level).toBe(2);
  const para = blocks.find((b) => b.kind === 'paragraph' && runsText(b.runs).startsWith('Testo'));
  expect(para.runs.find((r) => r.text === 'grassetto').bold).toBe(true);
  expect(para.runs.find((r) => r.text === 'rosso')).toMatchObject({ italic: true, color: '#ff0000' });
  expect(para.runs.find((r) => r.text === 'sopra').sup).toBe(true);
  expect(para.runs.find((r) => r.text === 'un link').link).toMatch(/^https:\/\/example\.org\/?$/);
  const note = para.runs.find((r) => r.object?.type === 'note');
  expect(runsText(note.object.runs).trim()).toBe('La nota.');
  const table = blocks.find((b) => b.kind === 'table');
  expect(table.rows.map((r) => r.cells.map((c) => runsText(c.runs)))).toEqual([['A1', 'B1'], ['A2', 'B2']]);
  expect(blocks.find((b) => runsText(b.runs ?? []) === 'Centrato & <segni>').align).toBe('center');
  if (lists) {
    expect(blocks.find((b) => b.kind === 'list' && runsText(b.items[0].runs) === 'uno').listType).toBe('number');
    expect(blocks.find((b) => b.kind === 'list' && runsText(b.items[0].runs) === 'punto').listType).toBe('bullet');
  }
}

describe('Word 2003 XML documents', () => {
  it('come back as Paper wrote them', () => {
    const { text } = writeWordml2003(sample());
    expect(text).not.toMatch(/DocumentProperties|Author|LastAuthor/);
    check(readWordml2003(text).document);
  });

  it('carry pictures inside the file and back', () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const doc = sample();
    doc.blocks.push({ kind: 'image', resource: 'resources/dot.png', w: 40, h: 40, caption: [] });
    const { text } = writeWordml2003(doc, new Map([['resources/dot.png', png]]));
    expect(text).toMatch(/<w:binData w:name="wordml:\/\/00000001\.png">/);
    const back = readWordml2003(text);
    const image = back.document.blocks.find((b) => b.kind === 'image');
    expect(image).toBeTruthy();
    expect([...back.images.get(image.resource)]).toEqual([...png]);
  });

  it('refuse what is not one, and entities, with an error', () => {
    expect(() => readWordml2003('<?xml version="1.0"?><x/>')).toThrow(/not a Word 2003/);
    expect(() => readWordml2003('<!DOCTYPE x [<!ENTITY a "b">]><w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"/>')).toThrow(/entities/);
  });

  it('read Word 2003 own shapes: sections, hints, nested runs and inline notes', () => {
    const text = `<?xml version="1.0"?><w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml" xmlns:wx="http://schemas.microsoft.com/office/word/2003/auxHint" xmlns:aml="http://schemas.microsoft.com/aml/2001/core">
      <w:body><wx:sect><w:p><w:pPr><w:listPr><w:ilvl w:val="0"/><w:ilfo w:val="1"/><wx:t wx:val="1."/></w:listPr><w:ind w:left="720" w:first-line="0"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:r><w:t>Uno</w:t></w:r></w:r>
      <aml:annotation aml:id="0" w:type="Word.Insertion"><aml:content><w:r><w:t> nuovo</w:t></w:r></aml:content></aml:annotation>
      <aml:annotation aml:id="1" w:type="Word.Deletion"><aml:content><w:r><w:delText>tolto</w:delText></w:r></aml:content></aml:annotation></w:p>
      <wx:sub-section><w:p><w:r><w:t>Due</w:t></w:r><w:r><w:footnote><w:p><w:r><w:t>Nota</w:t></w:r></w:p></w:footnote></w:r></w:p></wx:sub-section></wx:sect></w:body>
      <w:lists><w:listDef w:listDefId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:nfc w:val="0"/><w:lvlText w:val="%1."/></w:lvl></w:listDef><w:list w:ilfo="1"><w:ilst w:val="0"/></w:list></w:lists></w:wordDocument>`;
    const { document, losses } = readWordml2003(text);
    const list = document.blocks.find((b) => b.kind === 'list');
    expect(runsText(list.items[0].runs)).toBe('Uno nuovo');
    expect(list.items[0].runs[0].bold).toBe(true);
    const two = document.blocks.find((b) => runsText(b.runs ?? []).startsWith('Due'));
    expect(runsText(two.runs.find((r) => r.object?.type === 'note').object.runs).trim()).toBe('Nota');
    expect(losses.lines().join()).toMatch(/Tracked changes/);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Word 2003 XML documents', () => {
  it('reads what Paper writes as Paper wrote it', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'paper.xml');
      writeFileSync(file, writeWordml2003(sample()).text);
      const odt = convert(file, 'odt', join(dir, 'odt'));
      check(readOdt(decodeBlock(readBlock(odt))).document);
    } finally { cleanup(dir); }
  }, 120000);

  it('writes what Paper reads', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'paper.odt');
      writeBlock(encodeBlock(writeOdt(sample()).entries), file);
      const xml = convert(file, 'xml:MS Word 2003 XML', join(dir, 'xml'));
      check(readWordml2003(readFileSync(xml, 'utf8')).document);
    } finally { cleanup(dir); }
  }, 120000);
});
