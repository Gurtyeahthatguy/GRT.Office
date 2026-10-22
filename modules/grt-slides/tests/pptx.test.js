// @vitest-environment jsdom

/** PowerPoint presentations, read and written. */

import { describe, it, expect } from 'vitest';
import { readPptx } from '../src/js/core/formats/pptx-read.js';
import { writePptx } from '../src/js/core/formats/pptx-write.js';
import { Package, decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { SlidesModel } from '../src/js/model.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const emu = (px) => Math.round(px * 9525);

// A 2 × 1 PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZYAwAZDsH+Wk8l1wAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

const through = (entries) => decodeBlock(encodeBlock(entries));

function rels(list) {
  return `<?xml version="1.0"?><Relationships xmlns="${PR}">${list.map(([id, type, target]) =>
    `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

/** A package as PowerPoint lays one out, with the parts given for the slides. */
function presentation({ slides, layout = '', master = '', theme = null, extra = {} }) {
  const parts = {
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation xmlns:p="${P}" xmlns:r="${R}">
      <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
      <p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).reverse().join('')}</p:sldIdLst>
      <p:sldSz cx="${emu(1280)}" cy="${emu(720)}"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ...slides.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`])]),
    'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0"?><p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
      <p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
      <p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="${emu(80)}" y="${emu(40)}"/><a:ext cx="${emu(1120)}" cy="${emu(120)}"/></a:xfrm></p:spPr></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="${emu(80)}" y="${emu(200)}"/><a:ext cx="${emu(1120)}" cy="${emu(440)}"/></a:xfrm></p:spPr></p:sp>
        ${master}
      </p:spTree></p:cSld>
      <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
      <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
      <p:txStyles>
        <p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
        <p:bodyStyle><a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>
        <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
      </p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0"?><p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
      <p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
        ${layout}
      </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': theme ?? `<?xml version="1.0"?><a:theme xmlns:a="${A}" name="T"><a:themeElements>
      <a:clrScheme name="T"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
        <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>
        <a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
        <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
      <a:fontScheme name="T"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>
      </a:themeElements></a:theme>`,
    ...extra,
  };
  slides.forEach((slide, i) => {
    parts[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0"?><p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
      <p:cSld>${slide.bg ?? ''}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${slide.shapes ?? ''}</p:spTree></p:cSld>
      ${slide.after ?? ''}</p:sld>`;
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...(slide.rels ?? [])]);
  });
  const encoder = new TextEncoder();
  return new Package(new Map(Object.entries(parts).map(([name, data]) => [name, typeof data === 'string' ? encoder.encode(data) : data])));
}

const xfrm = (x, y, w, h, extra = '') => `<a:xfrm${extra}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>`;

describe('reading PowerPoint', () => {
  it('puts slides in the order the presentation lists them, at the slide size', () => {
    const pkg = presentation({ slides: [{ shapes: '' }, { shapes: '' }] });
    const { document } = readPptx(pkg);
    expect(document.canvas).toEqual({ w: 1280, h: 720 });
    // The list names slide 2 first.
    expect(document.slides).toHaveLength(2);
  });

  it('places a placeholder where its master says, in the look its master gives it', () => {
    const pkg = presentation({ slides: [{ shapes: `
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>
        <p:txBody><a:bodyPr anchor="b"/><a:p><a:r><a:rPr lang="en"/><a:t>Quarterly review</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="B"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>
        <p:txBody><a:bodyPr/><a:p><a:r><a:t>First point</a:t></a:r></a:p><a:p><a:r><a:rPr b="1"/><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp>` }] });
    const { document, losses } = readPptx(pkg);
    const [title, body] = document.slides[0].elements;
    expect([title.x, title.y, title.w, title.h]).toEqual([80, 40, 1120, 120]);
    expect(title.size).toBe(Math.round(44 * 96 / 72));
    expect(title.align).toBe('center');
    expect(title.valign).toBe('bottom');
    expect(title.color).toBe('#000000');
    expect(title.font).toBe('serif');
    expect(title.content).toEqual([{ text: 'Quarterly review' }]);
    expect([body.x, body.y]).toEqual([80, 200]);
    expect(body.size).toBe(Math.round(28 * 96 / 72));
    // accent1 at half its lightness.
    expect(body.color).toBe('#203864');
    expect(body.content).toEqual([{ text: '• First point\n• ' }, { text: 'Second', bold: true }]);
    expect(losses.lines()).toContain('Bulleted lists, kept as text with bullet characters');
  });

  it('reads shapes, lines, groups, pictures, tables and backgrounds', () => {
    const pkg = presentation({
      slides: [{
        bg: '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="102030"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
        shapes: `
          <p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr>${xfrm(10, 20, 300, 100, ' rot="5400000"')}<a:prstGeom prst="ellipse"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
              <a:ln w="${emu(3)}"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln></p:spPr>
            <p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2400"/><a:t>Inside</a:t></a:r></a:p></p:txBody></p:sp>
          <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="3" name="L"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
            <p:spPr>${xfrm(0, 0, 100, 50, ' flipH="1"')}<a:prstGeom prst="straightConnector1"/>
              <a:ln w="${emu(2)}"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>
          <p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
            <p:grpSpPr><a:xfrm><a:off x="${emu(400)}" y="${emu(400)}"/><a:ext cx="${emu(200)}" cy="${emu(200)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(100)}" cy="${emu(100)}"/></a:xfrm></p:grpSpPr>
            <p:pic><p:nvPicPr><p:cNvPr id="5" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
              <p:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
              <p:spPr>${xfrm(50, 50, 50, 25)}<a:prstGeom prst="rect"/></p:spPr></p:pic></p:grpSp>
          <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
            <p:xfrm><a:off x="${emu(700)}" y="${emu(100)}"/><a:ext cx="${emu(400)}" cy="${emu(100)}"/></p:xfrm>
            <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>
              <a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid>
              <a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"/><a:t>Name</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Total</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
              <a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Ada</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>12</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
            </a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
        rels: [['rId9', 'image', '../media/picture.png']],
        after: `<mc:AlternateContent><mc:Choice Requires="p14"><p:transition><p:prism/></p:transition></mc:Choice>
          <mc:Fallback><p:transition><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`,
      }],
      extra: { 'ppt/media/picture.png': PNG },
    });
    const { document, images } = readPptx(pkg);
    const slide = document.slides[0];
    expect(slide.background).toBe('#102030');
    expect(slide.transition).toBe('fade');
    const [shape, label, line, picture, table] = slide.elements;
    expect(shape).toMatchObject({ kind: 'shape', shape: 'ellipse', fill: '#ff0000', stroke: '#00ff00', strokeWidth: 3, rotation: 90 });
    expect(label).toMatchObject({ kind: 'text', x: 10, y: 20, w: 300, h: 100, valign: 'middle', align: 'center', size: 32 });
    expect(line).toMatchObject({ kind: 'line', w: 100, h: 50, flipH: true, arrow: true, thickness: 2, fill: '#0000ff' });
    expect(picture).toMatchObject({ kind: 'image', x: 500, y: 500, w: 100, h: 50, resource: 'resources/picture.png' });
    expect(images.get('resources/picture.png')).toEqual(PNG);
    expect(table).toMatchObject({ kind: 'table', rows: 2, cols: 2, header: true, cells: [['Name', 'Total'], ['Ada', '12']], size: 19 });
  });

  it('draws what a layout puts on every slide as a master of the deck', () => {
    const pkg = presentation({
      slides: [{ shapes: '' }],
      layout: `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>${xfrm(0, 700, 1280, 20)}<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr></p:sp>`,
    });
    const { document } = readPptx(pkg);
    expect(document.masters).toHaveLength(1);
    expect(document.masters[0].name).toBe('Title and Content');
    expect(document.masters[0].elements[0]).toMatchObject({ kind: 'shape', fill: '#ed7d31', y: 700 });
    expect(document.slides[0].master).toBe(document.masters[0].id);
    expect(document.masters[0].elements[0].z).toBeLessThan(0);
  });

  it('refuses what is not a presentation', () => {
    const pkg = new Package(new Map([['_rels/.rels', new TextEncoder().encode(rels([]))]]));
    expect(() => readPptx(pkg)).toThrow(/not a PowerPoint/);
  });
});

function sampleDeck() {
  const model = new SlidesModel();
  model.setCanvas({ w: 1280, h: 720 });
  const first = model.slides[0];
  model.addElement(first.id, { kind: 'text', x: 80, y: 40, w: 1000, h: 120, style: 'title', content: [{ text: 'Hello ' }, { text: 'there', italic: true, color: '#cc0000' }] });
  const body = model.addElement(first.id, { kind: 'text', x: 80, y: 200, w: 600, h: 300, content: [{ text: 'Line one\nLine two' }] });
  model.setElementText(first.id, [body.id], { size: 40, align: 'right', valign: 'middle' });
  const shape = model.addElement(first.id, { kind: 'shape', shape: 'diamond', x: 700, y: 200, w: 200, h: 200 });
  model.setElementColour(first.id, [shape.id], { fill: '#336699' });
  model.addElement(first.id, { kind: 'line', x: 100, y: 600, w: 300, h: 50, arrow: true, thickness: 6 });
  model.addElement(first.id, { kind: 'image', x: 900, y: 450, w: 200, h: 200, resource: 'resources/pic.png' });
  model.addElement(first.id, { kind: 'table', x: 100, y: 500, w: 400, h: 100, rows: 2, cols: 2, cells: [['A', 'B'], ['1', '2']] });
  model.setNotes(first.id, 'Say hello\nThen go on');
  model.setTransition(first.id, 'fade');
  const second = model.addSlide();
  model.setSlideBackground(second.id, '#202020');
  model.setSection(second.id, 'Results');
  const master = model.addMaster('Branded');
  master.elements.push({ id: 'logo', kind: 'shape', shape: 'rect', x: 0, y: 0, w: 1280, h: 10, z: -1, fill: '#ff8800', rotation: 0, data: {} });
  model.assignMaster(second.id, master.id);
  return model;
}

describe('writing PowerPoint', () => {
  it('comes back as it was written', () => {
    const model = sampleDeck();
    const images = new Map([['resources/pic.png', PNG]]);
    const { entries, losses } = writePptx(model.toJSON(), images);
    expect(losses.empty).toBe(true);
    const { document, images: back } = readPptx(through(entries));

    expect(document.canvas).toEqual({ w: 1280, h: 720 });
    expect(document.slides).toHaveLength(2);
    const [title, body, shape, line, picture, table] = document.slides[0].elements;
    expect(title.content).toEqual([{ text: 'Hello ', bold: true }, { text: 'there', bold: true, italic: true, color: '#cc0000' }]);
    expect(title.size).toBe(72);
    expect(body).toMatchObject({ size: 40, align: 'right', valign: 'middle', content: [{ text: 'Line one\nLine two' }] });
    expect(shape).toMatchObject({ kind: 'shape', shape: 'diamond', fill: '#336699', x: 700, w: 200 });
    expect(line).toMatchObject({ kind: 'line', arrow: true, thickness: 6, x: 100, y: 600, w: 300, h: 50 });
    // A 2 × 1 picture contained in a square box keeps its shape.
    expect(picture).toMatchObject({ kind: 'image', x: 900, y: 500, w: 200, h: 100 });
    expect([...back.values()][0]).toEqual(PNG);
    expect(table).toMatchObject({ kind: 'table', cells: [['A', 'B'], ['1', '2']], header: true });
    expect(document.slides[0].notes).toBe('Say hello\nThen go on');
    expect(document.slides[0].transition).toBe('fade');

    expect(document.slides[1].background).toBe('#202020');
    expect(document.slides[1].section).toBe('Results');
    expect(document.masters.map((m) => m.name)).toEqual(['Branded']);
    expect(document.masters[0].elements[0]).toMatchObject({ kind: 'shape', fill: '#ff8800', w: 1280, h: 10 });
    expect(document.slides[1].master).toBe(document.masters[0].id);
    expect(document.slides[0].master).toBeNull();
  });

  it('is the same, byte for byte, written twice, and carries no document properties', () => {
    const write = () => JSON.stringify(writePptx(sampleDeck().toJSON(), new Map([['resources/pic.png', PNG]])).entries,
      (key, value) => (value instanceof Uint8Array ? [...value] : value));
    expect(write()).toBe(write());
    const names = writePptx(sampleDeck().toJSON(), new Map()).entries.map((e) => e.name);
    expect(names.some((name) => name.startsWith('docProps/'))).toBe(false);
  });

  it('says what it leaves out', () => {
    const model = new SlidesModel();
    model.addElement(model.slides[0].id, { kind: 'image', resource: 'resources/drawing.svg' });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { losses } = writePptx(model.toJSON(), new Map([['resources/drawing.svg', svg]]));
    expect(losses.lines()).toContain('Pictures in formats PowerPoint does not show (SVG, WebP), left out');
  });
});
