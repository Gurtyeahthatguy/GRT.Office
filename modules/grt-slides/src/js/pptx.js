/** Reading PowerPoint files, partially and honestly. */

/** OOXML measures in English Metric Units: 914400 to the inch. */
const EMU_PER_INCH = 914400;

/** What we can read, mapped onto the shapes this program has. */
const SHAPE_MAP = {
  rect: 'rect', roundRect: 'rounded', ellipse: 'ellipse', diamond: 'diamond',
  hexagon: 'hexagon', triangle: 'triangle', parallelogram: 'parallelogram',
  flowChartProcess: 'rect', flowChartDecision: 'diamond',
  flowChartTerminator: 'rounded', flowChartPredefinedProcess: 'rect',
};

/**
 * Converts a parsed .pptx into a presentation document.
 * @param {{parts: Object<string,string>, binaries: string[]}} archive
 * @param {(name: string) => (string|null)} imageUrlFor resolves a media part
 * @returns {{document: Object, warnings: string[]}}
 */
export function convertPptx(archive, imageUrlFor = () => null) {
  const parts = archive?.parts ?? {};
  const warnings = [];
  const parser = new DOMParser();

  const parse = (name) => {
    const text = parts[name];
    if (!text) return null;
    const xml = parser.parseFromString(text, 'application/xml');
    return xml.querySelector('parsererror') ? null : xml;
  };

  const presentation = parse('ppt/presentation.xml');
  if (!presentation) {
    throw new Error('This does not look like a PowerPoint presentation');
  }

  // Slide size, in EMU.
  const sldSz = presentation.getElementsByTagNameNS('*', 'sldSz')[0];
  const emuW = Number(sldSz?.getAttribute('cx')) || 12192000;
  const emuH = Number(sldSz?.getAttribute('cy')) || 6858000;

  const canvas = {
    w: Math.round((emuW / EMU_PER_INCH) * 96),
    h: Math.round((emuH / EMU_PER_INCH) * 96),
  };

  const slideNames = Object.keys(parts)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slideNames.length === 0) {
    throw new Error('This presentation contains no slides');
  }

  const slides = slideNames.map((name, index) => {
    const xml = parse(name);
    if (!xml) {
      warnings.push(`Slide ${index + 1} could not be read and was left empty`);
      return { elements: [], notes: '' };
    }

    const relationships = readRelationships(
      parse(name.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels'),
    );

    const { elements, slideWarnings } = readShapes(xml, relationships, imageUrlFor);
    for (const warning of slideWarnings) {
      warnings.push(`Slide ${index + 1}: ${warning}`);
    }

    return {
      elements,
      notes: readNotes(parse(`ppt/notesSlides/notesSlide${slideNumber(name)}.xml`)),
      transition: 'none',
      background: null,
      master: null,
    };
  });

  // Features that exist across the whole file rather than on one slide.
  if (Object.keys(parts).some((n) => n.startsWith('ppt/charts/'))) {
    warnings.push('Charts were not imported: GRT Slides has none yet');
  }
  if (Object.keys(parts).some((n) => n.startsWith('ppt/diagrams/'))) {
    warnings.push('SmartArt was not imported: it has no equivalent here');
  }
  if (Object.keys(parts).some((n) => n.startsWith('ppt/embeddings/'))) {
    warnings.push('Embedded objects (spreadsheets, equations) were not imported');
  }
  if (slideNames.some((n) => (parts[n] ?? '').includes('<p:transition'))) {
    warnings.push('Slide transitions were not imported; set them again if wanted');
  }
  warnings.push('Theme colours and fonts were not imported: the deck uses this program’s styles');

  return {
    document: {
      version: 1,
      type: 'slides',
      canvas,
      slides,
    },
    warnings,
  };
}

function slideNumber(name) {
  return Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
}

/** r:id to target, from a part's .rels file. */
function readRelationships(xml) {
  const map = new Map();
  if (!xml) return map;

  for (const node of xml.getElementsByTagNameNS('*', 'Relationship')) {
    map.set(node.getAttribute('Id'), node.getAttribute('Target') ?? '');
  }
  return map;
}

function readNotes(xml) {
  if (!xml) return '';
  return [...xml.getElementsByTagNameNS('*', 't')]
    .map((node) => node.textContent ?? '')
    .join('')
    .trim();
}

function readShapes(xml, relationships, imageUrlFor) {
  const elements = [];
  const slideWarnings = [];
  let z = 1;

  const tree = xml.getElementsByTagNameNS('*', 'spTree')[0];
  if (!tree) return { elements, slideWarnings };

  for (const node of tree.children) {
    const tag = node.localName;

    // Grouped shapes would need recursion and a group model this program does
    // not have; saying so beats importing them flattened and wrong.
    if (tag === 'grpSp') {
      slideWarnings.push('a grouped shape was skipped');
      continue;
    }
    if (tag === 'graphicFrame') {
      slideWarnings.push('a table, chart or diagram was skipped');
      continue;
    }

    const box = readBox(node);
    if (!box) continue;

    if (tag === 'pic') {
      const embed = node.getElementsByTagNameNS('*', 'blip')[0]?.getAttribute('r:embed')
        ?? node.getElementsByTagNameNS('*', 'blip')[0]
          ?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      const target = embed ? relationships.get(embed) : null;
      const resource = target ? `ppt/media/${target.split('/').pop()}` : null;
      const url = resource ? imageUrlFor(resource) : null;

      if (!url) {
        slideWarnings.push('an image could not be read and was left as an empty frame');
      }

      elements.push({ kind: 'image', ...box, z: z++, resource, fit: 'contain', data: {} });
      continue;
    }

    if (tag !== 'sp') continue;

    const text = readText(node);
    if (text.runs.length > 0) {
      elements.push({
        kind: 'text', ...box, z: z++,
        content: text.runs,
        style: text.looksLikeTitle ? 'title' : 'body',
        data: {},
      });
      continue;
    }

    const preset = node.getElementsByTagNameNS('*', 'prstGeom')[0]?.getAttribute('prst');
    if (preset && !SHAPE_MAP[preset]) {
      slideWarnings.push(`the shape "${preset}" became a rectangle`);
    }

    elements.push({
      kind: 'shape', ...box, z: z++,
      shape: SHAPE_MAP[preset] ?? 'rect',
      data: {},
    });
  }

  return { elements, slideWarnings };
}

/** Position and size, converted from EMU to pixels at 96 per inch. */
function readBox(node) {
  const off = node.getElementsByTagNameNS('*', 'off')[0];
  const ext = node.getElementsByTagNameNS('*', 'ext')[0];
  if (!off || !ext) return null;

  const toPx = (emu) => Math.round((Number(emu) / EMU_PER_INCH) * 96);

  return {
    x: toPx(off.getAttribute('x')),
    y: toPx(off.getAttribute('y')),
    w: Math.max(toPx(ext.getAttribute('cx')), 24),
    h: Math.max(toPx(ext.getAttribute('cy')), 24),
    rotation: 0,
  };
}

/** Text runs, keeping the bold and italic that survive the trip. */
function readText(node) {
  const runs = [];
  let biggest = 0;

  for (const paragraph of node.getElementsByTagNameNS('*', 'p')) {
    if (runs.length > 0) runs.push({ text: '\n' });

    for (const run of paragraph.getElementsByTagNameNS('*', 'r')) {
      const text = run.getElementsByTagNameNS('*', 't')[0]?.textContent ?? '';
      if (text === '') continue;

      const properties = run.getElementsByTagNameNS('*', 'rPr')[0];
      const size = Number(properties?.getAttribute('sz')) || 0;
      biggest = Math.max(biggest, size);

      runs.push({
        text,
        ...(properties?.getAttribute('b') === '1' ? { bold: true } : {}),
        ...(properties?.getAttribute('i') === '1' ? { italic: true } : {}),
      });
    }
  }

  // A guess, and only a guess: the biggest text on a slide is usually its
  // title.
  return { runs, looksLikeTitle: biggest >= 3200 };
}
