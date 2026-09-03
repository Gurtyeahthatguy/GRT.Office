/** Static-grid tables, sections and document fonts. */

import { describe, it, expect } from 'vitest';
import { SlidesModel } from '../src/js/model.js';
import { toHtml, slideToSvg, slideToPrintPage, elementMarkup } from '../src/js/export.js';
import { describeFont, fontFaceRules, fontMediaType } from '../src/js/fonts.js';

function deckWithTable() {
  const model = new SlidesModel();
  const slide = model.slides[0];
  const table = model.addElement(slide.id, {
    kind: 'table', x: 100, y: 100, w: 800, h: 300, rows: 2, cols: 3,
  });
  return { model, slide, table };
}

describe('Tables', () => {
  it('start as an empty grid of the right shape', () => {
    const { model, slide, table } = deckWithTable();
    const stored = model.element(slide.id, table.id);

    expect(stored.cells).toHaveLength(2);
    expect(stored.cells[0]).toHaveLength(3);
    expect(stored.cells[0][0]).toBe('');
  });

  it('hold text per cell', () => {
    const { model, slide, table } = deckWithTable();
    model.setCell(slide.id, table.id, 0, 0, 'Name');
    model.setCell(slide.id, table.id, 1, 2, 'Last');

    expect(model.element(slide.id, table.id).cells[0][0]).toBe('Name');
    expect(model.element(slide.id, table.id).cells[1][2]).toBe('Last');
  });

  it('ignore a cell that is not there rather than growing one', () => {
    const { model, slide, table } = deckWithTable();
    model.setCell(slide.id, table.id, 9, 9, 'nowhere');

    expect(model.element(slide.id, table.id).cells).toHaveLength(2);
  });

  it('keep the grid rectangular when resized', () => {
    const { model, slide, table } = deckWithTable();
    model.setCell(slide.id, table.id, 0, 0, 'kept');
    model.resizeTable(slide.id, table.id, { rows: 4, cols: 2 });

    const cells = model.element(slide.id, table.id).cells;
    expect(cells).toHaveLength(4);
    expect(cells.every((row) => row.length === 2)).toBe(true);
    // Content inside the surviving area stays put.
    expect(cells[0][0]).toBe('kept');
  });

  it('refuse a table with no rows', () => {
    const { model, slide, table } = deckWithTable();
    model.resizeTable(slide.id, table.id, { rows: 0, cols: 0 });

    expect(model.element(slide.id, table.id).rows).toBe(1);
    expect(model.element(slide.id, table.id).cols).toBe(1);
  });

  it('survive a save and reload with their contents', () => {
    const { model, slide, table } = deckWithTable();
    model.setCell(slide.id, table.id, 1, 1, 'middle');

    const reloaded = new SlidesModel(JSON.parse(JSON.stringify(model.toJSON())));
    const stored = reloaded.slides[0].elements[0];

    expect(stored.kind).toBe('table');
    expect(stored.cells[1][1]).toBe('middle');
  });

  it('reach the HTML, the SVG and the PDF', () => {
    const { model, slide, table } = deckWithTable();
    model.setCell(slide.id, table.id, 0, 0, 'CELLTEXT');

    expect(toHtml(model)).toContain('CELLTEXT');
    expect(slideToSvg(model, slide.id)).toContain('CELLTEXT');
    expect(slideToPrintPage(model, slide.id).primitives
      .some((p) => p.type === 'text' && p.text === 'CELLTEXT')).toBe(true);
  });

  it('escape cell text that would otherwise break the page', () => {
    const { model, slide, table } = deckWithTable();
    model.setCell(slide.id, table.id, 0, 0, '<script>x</script>');

    const markup = elementMarkup(model.element(slide.id, table.id), model);
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

describe('Sections', () => {
  it('a deck with none is one unnamed group', () => {
    const model = new SlidesModel();
    model.addSlide();

    const sections = model.sections();
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBeNull();
    expect(sections[0].slides).toHaveLength(2);
  });

  it('a heading starts a group at the slide carrying it', () => {
    const model = new SlidesModel();
    const second = model.addSlide();
    model.addSlide();
    model.setSection(second.id, 'Part two');

    const sections = model.sections();
    expect(sections.map((s) => s.title)).toEqual([null, 'Part two']);
    expect(sections[1].slides).toHaveLength(2);
  });

  it('clearing a heading merges the group back', () => {
    const model = new SlidesModel();
    const second = model.addSlide();
    model.setSection(second.id, 'Part two');
    model.setSection(second.id, '');

    expect(model.sections()).toHaveLength(1);
  });

  it('reordering slides is unaffected by sections', () => {
    // The point of storing a marker rather than a container.
    const model = new SlidesModel();
    const second = model.addSlide();
    model.setSection(second.id, 'Later');
    model.moveSlide(1, 0);

    expect(model.slides[0].id).toBe(second.id);
    expect(model.sections()[0].title).toBe('Later');
  });
});

describe('Document fonts', () => {
  it('are listed as resources so they are saved with the document', () => {
    const model = new SlidesModel();
    model.addFont('Inter', 'resources/fonts/Inter.ttf');

    expect(model.usedResources()).toContain('resources/fonts/Inter.ttf');
  });

  it('resolve to a stack that names them first', () => {
    const model = new SlidesModel();
    const id = model.addFont('Inter', 'resources/fonts/Inter.ttf');

    expect(model.stackFor(id)).toContain('"Inter"');
    // With a fallback behind them, so text still appears if the font fails.
    expect(model.stackFor(id).split(',').length).toBeGreaterThan(1);
  });

  it('survive a save and reload', () => {
    const model = new SlidesModel();
    model.addFont('Inter', 'resources/fonts/Inter.ttf');

    const reloaded = new SlidesModel(JSON.parse(JSON.stringify(model.toJSON())));
    expect(reloaded.fonts).toHaveLength(1);
  });

  it('are embedded in the HTML only when asked for', () => {
    const model = new SlidesModel();
    model.addFont('Inter', 'resources/fonts/Inter.ttf');
    const sources = new Map([['resources/fonts/Inter.ttf', 'data:font/ttf;base64,AAAA']]);

    expect(toHtml(model, sources, { embedFonts: true })).toContain('@font-face');
    expect(toHtml(model, sources, { embedFonts: false })).not.toContain('@font-face');
  });

  it('produce no rule at all for a font whose bytes are missing', () => {
    expect(fontFaceRules([{ id: 'a', name: 'Gone', resource: 'x' }], new Map())).toBe('');
  });

  it('map file extensions to the right media type', () => {
    expect(fontMediaType('a.woff2')).toBe('font/woff2');
    expect(fontMediaType('a.ttf')).toBe('font/ttf');
    expect(fontMediaType('a.unknown')).toBe('application/octet-stream');
  });
});

describe('Reading what a font says about itself', () => {
  it('recognises a WOFF2 and admits it cannot read inside', () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    const described = describeFont(bytes);

    expect(described.format).toBe('WOFF2');
    expect(described.readable).toBe(false);
  });

  it('reads the name table of a TrueType file', () => {
    expect(describeFont(makeFont()).names.Copyright).toBe('(c) Somebody');
  });

  it('does not throw on a truncated font', () => {
    // Files of unknown provenance are an attack surface.
    expect(() => describeFont(new Uint8Array([0, 1, 0, 0, 0, 5]))).not.toThrow();
  });

  it('says so plainly when the file is not a font at all', () => {
    expect(describeFont(new TextEncoder().encode('not a font')).format).toBe('unknown');
  });
});

/** A minimal TrueType file carrying one name record. */
function makeFont() {
  const value = new TextEncoder().encode('(c) Somebody');
  const nameTable = 12 + 16;                 // header plus one table record.
  const stringsAt = 6 + 12;                  // name header plus one record.

  const total = nameTable + stringsAt + value.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x00010000);             // sfnt version.
  view.setUint16(4, 1);                      // one table.
  bytes.set(new TextEncoder().encode('name'), 12);
  view.setUint32(12 + 8, nameTable);         // offset of the name table.

  view.setUint16(nameTable + 0, 0);          // format.
  view.setUint16(nameTable + 2, 1);          // one record.
  view.setUint16(nameTable + 4, stringsAt);  // where the strings begin.

  const record = nameTable + 6;
  view.setUint16(record + 0, 1);             // platform: Macintosh, single byte.
  view.setUint16(record + 6, 0);             // name id 0: copyright.
  view.setUint16(record + 8, value.length);
  view.setUint16(record + 10, 0);
  bytes.set(value, nameTable + stringsAt);

  return bytes;
}
