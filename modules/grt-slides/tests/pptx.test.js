/** Importing PowerPoint, partially and honestly. */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { convertPptx } from '../src/js/pptx.js';
import { SlidesModel } from '../src/js/model.js';

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html></html>');
  globalThis.DOMParser = dom.window.DOMParser;
});

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

/** EMU for a given number of pixels at 96 per inch. */
const emu = (px) => Math.round((px / 96) * 914400);

function presentationXml(w = 1280, h = 720) {
  return `<?xml version="1.0"?>
    <p:presentation xmlns:p="${P}">
      <p:sldSz cx="${emu(w)}" cy="${emu(h)}"/>
    </p:presentation>`;
}

function slideXml(shapes) {
  return `<?xml version="1.0"?>
    <p:sld xmlns:p="${P}" xmlns:a="${A}">
      <p:cSld><p:spTree>${shapes}</p:spTree></p:cSld>
    </p:sld>`;
}

function textShape({ text, x = 100, y = 100, w = 400, h = 100, size = 1800, bold = false }) {
  return `<p:sp>
    <p:spPr><a:xfrm>
      <a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/>
    </a:xfrm></p:spPr>
    <p:txBody><a:p><a:r>
      <a:rPr sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${text}</a:t>
    </a:r></a:p></p:txBody>
  </p:sp>`;
}

function archive(parts) {
  return { parts: { 'ppt/presentation.xml': presentationXml(), ...parts }, binaries: [] };
}

describe('Reading a simple deck', () => {
  it('produces one slide per slide', () => {
    const { document } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(textShape({ text: 'First' })),
      'ppt/slides/slide2.xml': slideXml(textShape({ text: 'Second' })),
    }));

    expect(document.slides).toHaveLength(2);
  });

  it('keeps slides in file order, not alphabetical order', () => {
    // slide10 sorts before slide2 as a string, and a ten-slide deck arriving
    // shuffled would be an unpleasant surprise.
    const parts = {};
    for (let i = 1; i <= 11; i += 1) {
      parts[`ppt/slides/slide${i}.xml`] = slideXml(textShape({ text: `S${i}` }));
    }
    const { document } = convertPptx(archive(parts));
    const first = document.slides.map((s) => s.elements[0].content[0].text);

    expect(first[1]).toBe('S2');
    expect(first[10]).toBe('S11');
  });

  it('converts EMU into the canvas the program uses', () => {
    const { document } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(textShape({ text: 'x', x: 96, y: 48 })),
    }));

    expect(document.canvas).toEqual({ w: 1280, h: 720 });
    expect(document.slides[0].elements[0].x).toBe(96);
    expect(document.slides[0].elements[0].y).toBe(48);
  });

  it('keeps bold on the runs that had it', () => {
    const { document } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(
        `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(400)}" cy="${emu(100)}"/></a:xfrm></p:spPr>
         <p:txBody><a:p>
           <a:r><a:rPr sz="1800"/><a:t>plain </a:t></a:r>
           <a:r><a:rPr sz="1800" b="1"/><a:t>bold</a:t></a:r>
         </a:p></p:txBody></p:sp>`,
      ),
    }));

    const runs = document.slides[0].elements[0].content;
    expect(runs).toHaveLength(2);
    expect(runs[1].bold).toBe(true);
    expect(runs[0].bold).toBeUndefined();
  });

  it('guesses that the biggest text is the title', () => {
    const { document } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(
        textShape({ text: 'Heading', size: 4400 }) + textShape({ text: 'Body', y: 300, size: 1800 }),
      ),
    }));

    expect(document.slides[0].elements[0].style).toBe('title');
    expect(document.slides[0].elements[1].style).toBe('body');
  });

  it('reads the speaker notes', () => {
    const { document } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(textShape({ text: 'x' })),
      'ppt/notesSlides/notesSlide1.xml':
        `<?xml version="1.0"?><p:notes xmlns:p="${P}" xmlns:a="${A}">`
        + '<a:p><a:r><a:t>Remember the thing</a:t></a:r></a:p></p:notes>',
    }));

    expect(document.slides[0].notes).toBe('Remember the thing');
  });
});

describe('It says what it could not convert', () => {
  it('always warns that the theme did not come across', () => {
    const { warnings } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(textShape({ text: 'x' })),
    }));

    expect(warnings.join(' ')).toMatch(/theme/i);
  });

  it('names a skipped grouped shape', () => {
    const { warnings } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml('<p:grpSp><p:grpSpPr/></p:grpSp>'),
    }));

    expect(warnings.join(' ')).toMatch(/grouped shape/i);
  });

  it('names a skipped table or chart frame', () => {
    const { warnings } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml('<p:graphicFrame/>'),
    }));

    expect(warnings.join(' ')).toMatch(/table, chart or diagram/i);
  });

  it('reports SmartArt and charts found anywhere in the file', () => {
    const { warnings } = convertPptx({
      parts: {
        'ppt/presentation.xml': presentationXml(),
        'ppt/slides/slide1.xml': slideXml(textShape({ text: 'x' })),
        'ppt/charts/chart1.xml': '<c/>',
        'ppt/diagrams/data1.xml': '<d/>',
      },
      binaries: [],
    });

    expect(warnings.join(' ')).toMatch(/chart/i);
    expect(warnings.join(' ')).toMatch(/SmartArt/i);
  });

  it('reports transitions rather than pretending they came over', () => {
    const { warnings } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(textShape({ text: 'x' })).replace(
        '</p:cSld>', '</p:cSld><p:transition><p:fade/></p:transition>',
      ),
    }));

    expect(warnings.join(' ')).toMatch(/transition/i);
  });

  it('turns an unknown shape into a rectangle and says so', () => {
    const { document, warnings } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(
        `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(100)}" cy="${emu(100)}"/></a:xfrm>
         <a:prstGeom prst="cloudCallout"/></p:spPr><p:txBody/></p:sp>`,
      ),
    }));

    expect(document.slides[0].elements[0].shape).toBe('rect');
    expect(warnings.join(' ')).toMatch(/cloudCallout/);
  });
});

describe('It refuses rather than producing nonsense', () => {
  it('rejects a file that is not a presentation', () => {
    expect(() => convertPptx({ parts: { 'word/document.xml': '<w/>' }, binaries: [] }))
      .toThrow(/PowerPoint/i);
  });

  it('rejects a presentation with no slides', () => {
    expect(() => convertPptx(archive({}))).toThrow(/no slides/i);
  });
});

describe('The result opens in this program', () => {
  it('loads into the model with defaults filled in', () => {
    const { document } = convertPptx(archive({
      'ppt/slides/slide1.xml': slideXml(textShape({ text: 'Hello' })),
    }));

    const model = new SlidesModel(document);
    expect(model.slides).toHaveLength(1);
    expect(model.slides[0].elements[0].id).toBeTruthy();
    expect(model.slides[0].transition).toBe('none');
  });
});
