/** Slides' document as a PowerPoint presentation. */

import { NS, tag, xmlDocument } from '../xml.js';
import { Losses } from '../losses.js';
import { REL, relsXml, contentTypesXml } from './ooxml.js';
import { naturalSize } from '../images.js';
import { EMU_PER_PX } from './drawingml.js';
import { parsePath } from '../paths.js';

const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = {
  ...REL,
  presProps: `${REL_BASE}/presProps`,
  viewProps: `${REL_BASE}/viewProps`,
  tableStyles: `${REL_BASE}/tableStyles`,
  notesMaster: `${REL_BASE}/notesMaster`,
};
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table';

const PICTURES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };
const GEOMETRY = {
  rect: 'rect', rounded: 'roundRect', ellipse: 'ellipse', diamond: 'diamond',
  parallelogram: 'parallelogram', hexagon: 'hexagon', triangle: 'triangle',
};
// The faces whose metrics match what Slides draws, and that every Office has.
const TYPEFACES = { sans: 'Arial', serif: 'Times New Roman', mono: 'Courier New' };

const emu = (px) => String(Math.round(Number(px ?? 0) * EMU_PER_PX));
const hex = (color, fallback = '000000') => {
  const value = String(color ?? '').replace('#', '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(value)) return value.toUpperCase();
  if (/^[0-9a-f]{3}$/.test(value)) return [...value].map((c) => c + c).join('').toUpperCase();
  return fallback;
};
const solid = (color) => tag('a:solidFill', {}, tag('a:srgbClr', { val: hex(color) }));

/**
 * @param {object} document Slides' toJSON()
 * @param {Map<string, Uint8Array>} images resource path to bytes
 * @returns {{entries: object[], losses: Losses}}
 */
export function writePptx(document, images = new Map()) {
  return new PptxWriter(document, images).write();
}

class PptxWriter {
  constructor(document, images) {
    this.doc = document;
    this.images = images;
    this.losses = new Losses();
    this.media = new Map();
    this.canvas = document.canvas ?? { w: 1920, h: 1080 };
    this.theme = { background: '#ffffff', accent: '#1f6feb', text: '#222222', ...(document.theme ?? {}) };
    this.styles = document.styles ?? {};
    this.fonts = new Map((document.fonts ?? []).map((font) => [font.id, font]));
  }

  write() {
    const slides = this.doc.slides ?? [];
    const masters = this.doc.masters ?? [];
    const withNotes = slides.some((slide) => (slide.notes ?? '').trim() !== '');

    // One layout for slides of no master, then one for each of the document's masters.
    const layouts = [{ name: 'Blank', elements: [], id: null }, ...masters.map((m) => ({ name: m.name ?? 'Master', elements: m.elements ?? [], id: m.id }))];
    const layoutOf = new Map(layouts.map((layout, i) => [layout.id, i + 1]));
    const entries = [];
    const overrides = [['ppt/presentation.xml', `${PML}.presentation.main+xml`]];

    layouts.forEach((layout, i) => {
      const rels = [{ id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }];
      const tree = this.tree(layout.elements, rels, '../media/');
      entries.push({
        name: `ppt/slideLayouts/slideLayout${i + 1}.xml`,
        data: xmlDocument(tag('p:sldLayout', { ...this.namespaces(), type: i === 0 ? 'blank' : 'cust', preserve: '1', userDrawn: i === 0 ? null : '1' },
          tag('p:cSld', { name: layout.name }, tree),
          tag('p:clrMapOvr', {}, tag('a:masterClrMapping')))),
      });
      entries.push({ name: `ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, data: relsXml(rels) });
      overrides.push([`ppt/slideLayouts/slideLayout${i + 1}.xml`, `${PML}.slideLayout+xml`]);
    });

    entries.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: this.masterXml(layouts.length) });
    entries.push({
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: relsXml([
        ...layouts.map((_, i) => ({ id: `rId${i + 1}`, type: REL.slideLayout, target: `../slideLayouts/slideLayout${i + 1}.xml` })),
        { id: `rId${layouts.length + 1}`, type: REL.theme, target: '../theme/theme1.xml' },
      ]),
    });
    overrides.push(['ppt/slideMasters/slideMaster1.xml', `${PML}.slideMaster+xml`]);
    entries.push({ name: 'ppt/theme/theme1.xml', data: this.themeXml('Slides') });
    overrides.push(['ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml']);

    slides.forEach((slide, i) => {
      const n = i + 1;
      const rels = [{ id: 'rId1', type: REL.slideLayout, target: `../slideLayouts/slideLayout${layoutOf.get(slide.master) ?? 1}.xml` }];
      const notes = (slide.notes ?? '').trim() !== '';
      if (notes) rels.push({ id: 'rId2', type: REL.notesSlide, target: `../notesSlides/notesSlide${n}.xml` });
      const tree = this.tree(slide.elements ?? [], rels, '../media/');
      entries.push({
        name: `ppt/slides/slide${n}.xml`,
        data: xmlDocument(tag('p:sld', this.namespaces(),
          tag('p:cSld', {}, slide.background ? background(slide.background) : null, tree),
          tag('p:clrMapOvr', {}, tag('a:masterClrMapping')),
          transition(slide.transition))),
      });
      entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: relsXml(rels) });
      overrides.push([`ppt/slides/slide${n}.xml`, `${PML}.slide+xml`]);
      if (notes) {
        entries.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: this.notesXml(slide.notes) });
        entries.push({
          name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
          data: relsXml([
            { id: 'rId1', type: RELS.notesMaster, target: '../notesMasters/notesMaster1.xml' },
            { id: 'rId2', type: REL.slide, target: `../slides/slide${n}.xml` },
          ]),
        });
        overrides.push([`ppt/notesSlides/notesSlide${n}.xml`, `${PML}.notesSlide+xml`]);
      }
    });

    if (withNotes) {
      entries.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: this.notesMasterXml() });
      entries.push({
        name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels',
        data: relsXml([{ id: 'rId1', type: REL.theme, target: '../theme/theme2.xml' }]),
      });
      entries.push({ name: 'ppt/theme/theme2.xml', data: this.themeXml('Notes') });
      overrides.push(['ppt/notesMasters/notesMaster1.xml', `${PML}.notesMaster+xml`]);
      overrides.push(['ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml']);
    }

    // The presentation and its relationships, ids in a fixed order.
    const presentationRels = [{ id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' }];
    slides.forEach((_, i) => presentationRels.push({ id: `rId${i + 2}`, type: REL.slide, target: `slides/slide${i + 1}.xml` }));
    let next = slides.length + 2;
    const add = (type, target) => {
      const id = `rId${next}`;
      next += 1;
      presentationRels.push({ id, type, target });
      return id;
    };
    const notesMasterId = withNotes ? add(RELS.notesMaster, 'notesMasters/notesMaster1.xml') : null;
    add(RELS.presProps, 'presProps.xml');
    add(RELS.viewProps, 'viewProps.xml');
    add(REL.theme, 'theme/theme1.xml');
    add(RELS.tableStyles, 'tableStyles.xml');

    const presentation = xmlDocument(tag('p:presentation', { ...this.namespaces(), saveSubsetFonts: '1' },
      tag('p:sldMasterIdLst', {}, tag('p:sldMasterId', { id: '2147483648', 'r:id': 'rId1' })),
      notesMasterId ? tag('p:notesMasterIdLst', {}, tag('p:notesMasterId', { 'r:id': notesMasterId })) : null,
      tag('p:sldIdLst', {}, slides.map((_, i) => tag('p:sldId', { id: String(256 + i), 'r:id': `rId${i + 2}` }))),
      tag('p:sldSz', { cx: emu(clampSize(this.canvas.w)), cy: emu(clampSize(this.canvas.h)) }),
      tag('p:notesSz', { cx: '6858000', cy: '9144000' }),
      sectionsXml(slides)));

    const media = [...this.media.values()].map((item) => ({ name: `ppt/media/${item.name}`, data: item.bytes }));
    const types = { rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml' };
    for (const item of this.media.values()) types[item.extension] = PICTURES[item.extension];
    const presProps = xmlDocument(tag('p:presentationPr', this.namespaces()));
    const viewProps = xmlDocument(tag('p:viewPr', this.namespaces()));
    const tableStyles = xmlDocument(tag('a:tblStyleLst', { 'xmlns:a': NS.a, def: '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}' }));
    overrides.push(
      ['ppt/presProps.xml', `${PML}.presProps+xml`],
      ['ppt/viewProps.xml', `${PML}.viewProps+xml`],
      ['ppt/tableStyles.xml', `${PML}.tableStyles+xml`],
    );

    return {
      entries: [
        { name: '[Content_Types].xml', data: contentTypesXml(types, overrides) },
        { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' }]) },
        { name: 'ppt/presentation.xml', data: presentation },
        { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presentationRels) },
        { name: 'ppt/presProps.xml', data: presProps },
        { name: 'ppt/viewProps.xml', data: viewProps },
        { name: 'ppt/tableStyles.xml', data: tableStyles },
        ...entries,
        ...media,
      ],
      losses: this.losses,
    };
  }

  namespaces() {
    return { 'xmlns:a': NS.a, 'xmlns:r': NS.r, 'xmlns:p': NS.p };
  }

  // Shapes

  tree(elements, rels, mediaPath) {
    let id = 1;
    const nextId = () => {
      id += 1;
      return String(id);
    };
    const shapes = [...elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
      .map((element) => this.element(element, nextId, rels, mediaPath)).filter(Boolean);
    return tag('p:spTree', {},
      tag('p:nvGrpSpPr', {}, tag('p:cNvPr', { id: '1', name: '' }), tag('p:cNvGrpSpPr'), tag('p:nvPr')),
      tag('p:grpSpPr', {}, tag('a:xfrm', {}, tag('a:off', { x: '0', y: '0' }), tag('a:ext', { cx: '0', cy: '0' }),
        tag('a:chOff', { x: '0', y: '0' }), tag('a:chExt', { cx: '0', cy: '0' }))),
      shapes);
  }

  element(element, nextId, rels, mediaPath) {
    if (element.kind === 'text') return this.textShape(element, nextId());
    if (element.kind === 'shape') return this.shape(element, nextId());
    if (element.kind === 'line') return this.line(element, nextId());
    if (element.kind === 'image') return this.picture(element, nextId(), rels, mediaPath);
    if (element.kind === 'table') return this.table(element, nextId());
    return null;
  }

  textShape(element, id) {
    const look = this.look(element);
    return tag('p:sp', {},
      tag('p:nvSpPr', {}, tag('p:cNvPr', { id, name: `Text ${id}` }), tag('p:cNvSpPr', { txBox: '1' }), tag('p:nvPr')),
      tag('p:spPr', {}, xfrm(element), geometry('rect'), tag('a:noFill')),
      tag('p:txBody', {},
        tag('a:bodyPr', {
          wrap: 'square', lIns: '0', tIns: '0', rIns: '0', bIns: '0',
          anchor: { middle: 'ctr', bottom: 'b' }[element.valign] ?? 't',
        }, tag('a:noAutofit')),
        tag('a:lstStyle'),
        paragraphs(element.content ?? [], look)));
  }

  /** What an element's text looks like, its own settings over its named style. */
  look(element) {
    const style = this.styles[element.style] ?? this.styles.body ?? {};
    const font = element.font ?? style.font ?? 'sans';
    const custom = this.fonts.get(font);
    if (custom) this.losses.add('Fonts the presentation carries, named but not embedded');
    return {
      size: element.size ?? style.size ?? 32,
      align: element.align ?? style.align ?? 'left',
      color: element.color ?? style.color ?? '#333333',
      bold: !!style.bold,
      italic: !!style.italic,
      typeface: custom?.name ?? TYPEFACES[font] ?? TYPEFACES.sans,
    };
  }

  shape(element, id) {
    const fill = element.fill ?? this.theme.accent;
    return tag('p:sp', {},
      tag('p:nvSpPr', {}, tag('p:cNvPr', { id, name: `Shape ${id}` }), tag('p:cNvSpPr'), tag('p:nvPr')),
      tag('p:spPr', {}, xfrm(element), element.shape === 'path' && element.path ? customGeometry(element.path) : geometry(GEOMETRY[element.shape] ?? 'rect'),
        fill === 'none' ? tag('a:noFill') : solid(fill),
        element.stroke
          ? tag('a:ln', { w: emu(element.strokeWidth ?? 2) }, solid(element.stroke))
          : tag('a:ln', {}, tag('a:noFill'))));
  }

  line(element, id) {
    return tag('p:cxnSp', {},
      tag('p:nvCxnSpPr', {}, tag('p:cNvPr', { id, name: `Line ${id}` }), tag('p:cNvCxnSpPr'), tag('p:nvPr')),
      tag('p:spPr', {}, xfrm(element, { flipH: element.flipH, flipV: element.flipV }), geometry('line'),
        tag('a:ln', { w: emu(element.thickness ?? 4) }, solid(element.fill ?? this.theme.accent),
          element.arrow ? tag('a:tailEnd', { type: 'triangle' }) : null)));
  }

  picture(element, id, rels, mediaPath) {
    const bytes = this.images.get(element.resource);
    const kind = pictureKind(bytes);
    if (!bytes || !kind) {
      this.losses.add(bytes ? 'Pictures in formats PowerPoint does not show (SVG, WebP), left out' : 'Pictures whose file is missing, left out');
      return null;
    }
    const item = this.mediaFor(element.resource, bytes, kind);
    const relId = `rId${rels.length + 1}`;
    rels.push({ id: relId, type: REL.image, target: `${mediaPath}${item.name}` });

    let box = element;
    let crop = null;
    const size = naturalSize(bytes);
    if (size && size.w > 0 && size.h > 0 && element.w > 0 && element.h > 0) {
      const scale = element.fit === 'cover'
        ? Math.max(element.w / size.w, element.h / size.h)
        : Math.min(element.w / size.w, element.h / size.h);
      const w = size.w * scale;
      const h = size.h * scale;
      if (element.fit === 'cover') {
        const cutX = Math.round(((w - element.w) / 2 / w) * 100000);
        const cutY = Math.round(((h - element.h) / 2 / h) * 100000);
        if (cutX > 0 || cutY > 0) crop = { l: String(cutX), r: String(cutX), t: String(cutY), b: String(cutY) };
      } else {
        box = { ...element, x: element.x + (element.w - w) / 2, y: element.y + (element.h - h) / 2, w, h };
      }
    }
    return tag('p:pic', {},
      tag('p:nvPicPr', {}, tag('p:cNvPr', { id, name: `Picture ${id}` }),
        tag('p:cNvPicPr', {}, tag('a:picLocks', { noChangeAspect: '1' })), tag('p:nvPr')),
      tag('p:blipFill', {}, tag('a:blip', { 'r:embed': relId }), crop ? tag('a:srcRect', crop) : null,
        tag('a:stretch', {}, tag('a:fillRect'))),
      tag('p:spPr', {}, xfrm(box), geometry('rect')));
  }

  mediaFor(resource, bytes, kind) {
    if (!this.media.has(resource)) {
      const extension = kind === 'jpeg' ? 'jpeg' : kind;
      this.media.set(resource, { name: `image${this.media.size + 1}.${extension}`, bytes, extension });
    }
    return this.media.get(resource);
  }

  table(element, id) {
    const look = { ...this.look(element), align: 'left' };
    const rows = element.cells ?? [];
    const cols = Math.max(1, element.cols ?? rows[0]?.length ?? 1);
    const width = element.w / cols;
    const height = element.h / Math.max(1, rows.length);
    const border = (name) => tag(`a:${name}`, { w: '12700' }, solid(this.theme.text));
    return tag('p:graphicFrame', {},
      tag('p:nvGraphicFramePr', {}, tag('p:cNvPr', { id, name: `Table ${id}` }),
        tag('p:cNvGraphicFramePr', {}, tag('a:graphicFrameLocks', { noGrp: '1' })), tag('p:nvPr')),
      tag('p:xfrm', {}, tag('a:off', { x: emu(element.x), y: emu(element.y) }), tag('a:ext', { cx: emu(element.w), cy: emu(element.h) })),
      tag('a:graphic', {}, tag('a:graphicData', { uri: TABLE_URI },
        tag('a:tbl', {},
          tag('a:tblPr', { firstRow: element.header ? '1' : null }),
          tag('a:tblGrid', {}, Array.from({ length: cols }, () => tag('a:gridCol', { w: emu(width) }))),
          rows.map((row, r) => tag('a:tr', { h: emu(height) },
            Array.from({ length: cols }, (_, c) => tag('a:tc', {},
              tag('a:txBody', {}, tag('a:bodyPr'), tag('a:lstStyle'),
                paragraphs([{ text: row[c] ?? '', ...(element.header && r === 0 ? { bold: true } : {}) }], look)),
              tag('a:tcPr', {}, border('lnL'), border('lnR'), border('lnT'), border('lnB'), tag('a:noFill'))))))))));
  }

  // Parts

  masterXml(layoutCount) {
    return xmlDocument(tag('p:sldMaster', this.namespaces(),
      tag('p:cSld', {}, background(this.theme.background), this.tree([], [], '')),
      tag('p:clrMap', {
        bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
        accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink',
      }),
      tag('p:sldLayoutIdLst', {}, Array.from({ length: layoutCount }, (_, i) => tag('p:sldLayoutId', { id: String(2147483649 + i), 'r:id': `rId${i + 1}` })))));
  }

  notesXml(text) {
    const lines = String(text).split('\n');
    return xmlDocument(tag('p:notes', this.namespaces(),
      tag('p:cSld', {}, tag('p:spTree', {},
        tag('p:nvGrpSpPr', {}, tag('p:cNvPr', { id: '1', name: '' }), tag('p:cNvGrpSpPr'), tag('p:nvPr')),
        tag('p:grpSpPr'),
        tag('p:sp', {},
          tag('p:nvSpPr', {}, tag('p:cNvPr', { id: '2', name: 'Slide Image' }),
            tag('p:cNvSpPr', {}, tag('a:spLocks', { noGrp: '1', noRot: '1', noChangeAspect: '1' })),
            tag('p:nvPr', {}, tag('p:ph', { type: 'sldImg' }))),
          tag('p:spPr')),
        tag('p:sp', {},
          tag('p:nvSpPr', {}, tag('p:cNvPr', { id: '3', name: 'Notes' }),
            tag('p:cNvSpPr', {}, tag('a:spLocks', { noGrp: '1' })),
            tag('p:nvPr', {}, tag('p:ph', { type: 'body', idx: '1' }))),
          tag('p:spPr'),
          tag('p:txBody', {}, tag('a:bodyPr'), tag('a:lstStyle'),
            lines.map((line) => tag('a:p', {}, line === '' ? tag('a:endParaRPr', { lang: 'en-US' })
              : tag('a:r', {}, tag('a:rPr', { lang: 'en-US', dirty: '0' }), tag('a:t', {}, line)))))))),
      tag('p:clrMapOvr', {}, tag('a:masterClrMapping'))));
  }

  notesMasterXml() {
    const placeholder = (id, name, type, idx, box) => tag('p:sp', {},
      tag('p:nvSpPr', {}, tag('p:cNvPr', { id, name }), tag('p:cNvSpPr', {}, tag('a:spLocks', { noGrp: '1' })),
        tag('p:nvPr', {}, tag('p:ph', { type, idx }))),
      tag('p:spPr', {}, tag('a:xfrm', {}, tag('a:off', { x: box[0], y: box[1] }), tag('a:ext', { cx: box[2], cy: box[3] })),
        geometry('rect')),
      type === 'body' ? tag('p:txBody', {}, tag('a:bodyPr'), tag('a:lstStyle'), tag('a:p', {}, tag('a:endParaRPr', { lang: 'en-US' }))) : null);
    return xmlDocument(tag('p:notesMaster', this.namespaces(),
      tag('p:cSld', {},
        tag('p:bg', {}, tag('p:bgRef', { idx: '1001' }, tag('a:schemeClr', { val: 'bg1' }))),
        tag('p:spTree', {},
          tag('p:nvGrpSpPr', {}, tag('p:cNvPr', { id: '1', name: '' }), tag('p:cNvGrpSpPr'), tag('p:nvPr')),
          tag('p:grpSpPr'),
          placeholder('2', 'Slide Image', 'sldImg', '2', ['685800', '1143000', '5486400', '3086100']),
          placeholder('3', 'Notes', 'body', '3', ['685800', '4400550', '5486400', '3600450']))),
      tag('p:clrMap', {
        bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
        accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink',
      })));
  }

  themeXml(name) {
    const color = (n, value) => tag(`a:${n}`, {}, tag('a:srgbClr', { val: value }));
    const fill = () => tag('a:solidFill', {}, tag('a:schemeClr', { val: 'phClr' }));
    const line = (w) => tag('a:ln', { w }, fill());
    return xmlDocument(tag('a:theme', { 'xmlns:a': NS.a, name },
      tag('a:themeElements', {},
        tag('a:clrScheme', { name },
          color('dk1', hex(this.theme.text, '000000')), color('lt1', 'FFFFFF'), color('dk2', '44546A'), color('lt2', 'E7E6E6'),
          color('accent1', hex(this.theme.accent, '1F6FEB')), color('accent2', 'ED7D31'), color('accent3', 'A5A5A5'),
          color('accent4', 'FFC000'), color('accent5', '5B9BD5'), color('accent6', '70AD47'),
          color('hlink', '0563C1'), color('folHlink', '954F72')),
        tag('a:fontScheme', { name },
          tag('a:majorFont', {}, tag('a:latin', { typeface: 'Arial' }), tag('a:ea', { typeface: '' }), tag('a:cs', { typeface: '' })),
          tag('a:minorFont', {}, tag('a:latin', { typeface: 'Arial' }), tag('a:ea', { typeface: '' }), tag('a:cs', { typeface: '' }))),
        tag('a:fmtScheme', { name },
          tag('a:fillStyleLst', {}, fill(), fill(), fill()),
          tag('a:lnStyleLst', {}, line('6350'), line('12700'), line('19050')),
          tag('a:effectStyleLst', {}, [0, 1, 2].map(() => tag('a:effectStyle', {}, tag('a:effectLst')))),
          tag('a:bgFillStyleLst', {}, fill(), fill(), fill()))),
      tag('a:objectDefaults'),
      tag('a:extraClrSchemeLst')));
  }
}

function clampSize(px) {
  // PowerPoint's slides are between one inch and 56 inches on a side.
  return Math.min(Math.max(px, 96), 5376);
}

function xfrm(element, { flipH = false, flipV = false } = {}) {
  return tag('a:xfrm', {
    rot: element.rotation ? String(Math.round(element.rotation * 60000)) : null,
    flipH: flipH ? '1' : null,
    flipV: flipV ? '1' : null,
  }, tag('a:off', { x: emu(element.x), y: emu(element.y) }), tag('a:ext', { cx: emu(Math.max(0, element.w)), cy: emu(Math.max(0, element.h)) }));
}

function geometry(prst) {
  return tag('a:prstGeom', { prst }, tag('a:avLst'));
}

/** A freeform outline, from a 0 to 100 box to a path of its own 100000 units. */
function customGeometry(d) {
  const unit = (v) => String(Math.round(v * 1000));
  const pt = (x, y) => tag('a:pt', { x: unit(x), y: unit(y) });
  const steps = parsePath(d).map((segment) => {
    const [command, ...v] = segment;
    if (command === 'M') return tag('a:moveTo', {}, pt(v[0], v[1]));
    if (command === 'L') return tag('a:lnTo', {}, pt(v[0], v[1]));
    if (command === 'C') return tag('a:cubicBezTo', {}, pt(v[0], v[1]), pt(v[2], v[3]), pt(v[4], v[5]));
    if (command === 'Q') return tag('a:quadBezTo', {}, pt(v[0], v[1]), pt(v[2], v[3]));
    return tag('a:close');
  });
  return tag('a:custGeom', {}, tag('a:avLst'), tag('a:gdLst'), tag('a:ahLst'), tag('a:cxnLst'),
    tag('a:rect', { l: '0', t: '0', r: 'r', b: 'b' }),
    tag('a:pathLst', {}, tag('a:path', { w: '100000', h: '100000' }, steps)));
}

function background(color) {
  return tag('p:bg', {}, tag('p:bgPr', {}, solid(color), tag('a:effectLst')));
}

function transition(kind) {
  if (kind === 'fade') return tag('p:transition', { spd: 'med' }, tag('p:fade'));
  if (kind === 'slide') return tag('p:transition', { spd: 'med' }, tag('p:push', { dir: 'l' }));
  return null;
}

/** Runs as paragraphs, a new one at each line break. */
function paragraphs(runs, look) {
  const out = [[]];
  for (const run of runs) {
    const pieces = String(run.text ?? '').split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) out.push([]);
      if (piece !== '') out[out.length - 1].push({ ...run, text: piece });
    });
  }
  const size = String(Math.round(look.size * 75));
  const props = (run) => tag('a:rPr', {
    lang: 'en-US', sz: size,
    b: run.bold || look.bold ? '1' : null,
    i: run.italic || look.italic ? '1' : null,
    u: run.underline ? 'sng' : null,
    dirty: '0',
  }, solid(run.color ?? look.color), tag('a:latin', { typeface: look.typeface }));
  return out.map((line) => tag('a:p', {},
    tag('a:pPr', { algn: { center: 'ctr', right: 'r' }[look.align] ?? 'l' }, tag('a:lnSpc', {}, tag('a:spcPct', { val: '104000' }))),
    line.map((run) => tag('a:r', {}, props(run), tag('a:t', {}, run.text))),
    tag('a:endParaRPr', { lang: 'en-US', sz: size })));
}

function pictureKind(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'bmp';
  return null;
}

/** Sections, as PowerPoint 2010 keeps them. */
function sectionsXml(slides) {
  if (!slides.some((slide) => slide.section)) return null;
  const groups = [];
  slides.forEach((slide, i) => {
    if (slide.section || groups.length === 0) groups.push({ name: slide.section ?? 'Default Section', ids: [] });
    groups[groups.length - 1].ids.push(256 + i);
  });
  return tag('p:extLst', {}, tag('p:ext', { uri: '{521415D9-36F7-43E2-AB2F-B90AF26B5E84}' },
    tag('p14:sectionLst', { 'xmlns:p14': P14 }, groups.map((group, i) => tag('p14:section', {
      name: group.name, id: `{00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}}`,
    }, tag('p14:sldIdLst', {}, group.ids.map((id) => tag('p14:sldId', { id: String(id) }))))))));
}
