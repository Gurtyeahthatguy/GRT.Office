/** A text document as an EPUB 3 book: chapters at its first-level headings, notes, formulas, pictures and drawings, and clean metadata. */

import { runsText, OBJECT } from '../editor/model.js';
import { documentFields, referenceText } from '../editor/fields.js';
import { chartSvg } from '../charts.js';
import { ownChartSpec } from './chart-object.js';
import { mathmlWithTex } from './math-ml.js';
import { texToMathml } from '../math.js';
import { drawingSvg } from '../draw/render.js';
import { TEXT_DRAWING_DEFAULTS } from '../editor/drawings.js';
import { Losses } from '../losses.js';
import { extensionOf, MEDIA_TYPES } from './odf.js';

const XHTML = 'http://www.w3.org/1999/xhtml';
const OPS = 'http://www.idpf.org/2007/ops';
const SVG = 'http://www.w3.org/2000/svg';
/** The date every book carries: EPUB wants one, and the day it was made says something about who made it. */
export const FIXED_DATE = '2000-01-01T00:00:00Z';

const UNWRITABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (text) => String(text ?? '').replace(UNWRITABLE, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeId = (text) => String(text).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^([^A-Za-z_])/, '_$1');

/** A short hash of the book's words, for an identifier that is the same for the same book and says nothing else. */
function hashOf(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  const all = hex(h1) + hex(h2) + hex(h1 ^ 0x9e3779b9) + hex(h2 ^ 0x7f4a7c15);
  return `${all.slice(0, 8)}-${all.slice(8, 12)}-4${all.slice(13, 16)}-a${all.slice(17, 20)}-${all.slice(20, 32)}`;
}

/**
 * @param {Object} document the editor's document as stored
 * @param {Map<string, Uint8Array>} images resource to bytes
 * @param {{title?: string, author?: string, language?: string, date?: string}} options
 * @returns {{entries: {name: string, data: string|Uint8Array, store?: boolean}[], losses: Losses}}
 */
export function writeEpub(document, images = new Map(), options = {}) {
  const losses = new Losses();
  const blocks = document.blocks ?? [];
  const fields = documentFields({ blocks, headingNumbers: document.headingNumbers, noteSettings: document.noteSettings });
  const drawings = Array.isArray(document.drawings) ? document.drawings : [];

  // Pictures, each once, under a plain name.
  const pictures = new Map();
  const picture = (resource) => {
    if (pictures.has(resource)) return pictures.get(resource).href;
    const bytes = images.get(resource);
    const ext = extensionOf(resource ?? '');
    if (!bytes || !MEDIA_TYPES[ext] || !/^image\//.test(MEDIA_TYPES[ext])) { losses.add('Pictures whose file was missing'); return null; }
    const href = `images/picture${pictures.size + 1}.${ext}`;
    pictures.set(resource, { href, bytes, type: MEDIA_TYPES[ext] });
    return href;
  };

  // Chapters: a new one at each first-level heading.
  const chapters = [];
  let current = null;
  const start = () => { current = { file: `chapter${chapters.length + 1}.xhtml`, parts: [], notes: [], svg: false, math: false, title: null }; chapters.push(current); };
  start();
  const anchors = new Map();
  const headings = [];

  const runsXhtml = (runs) => {
    const out = [];
    for (const run of runs ?? []) {
      if (run.del) continue;
      if (run.object) { out.push(objectXhtml(run.object)); continue; }
      let html = esc(run.text.replaceAll(OBJECT, '')).replace(/\n/g, '<br/>');
      if (!html) continue;
      if (run.code) html = `<code>${html}</code>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.underline || run.double) html = `<span class="u">${html}</span>`;
      if (run.strike) html = `<del>${html}</del>`;
      if (run.sup) html = `<sup>${html}</sup>`;
      if (run.sub) html = `<sub>${html}</sub>`;
      if (run.smallcaps) html = `<span class="sc">${html}</span>`;
      if (run.color) html = `<span style="color:${esc(run.color)}">${html}</span>`;
      if (run.highlight) html = `<span style="background-color:${esc(run.highlight)}">${html}</span>`;
      if (run.link && /^(https?:\/\/|mailto:|#)/i.test(run.link)) html = `<a href="${esc(run.link)}">${html}</a>`;
      out.push(html);
    }
    return out.join('');
  };

  let noteNumber = 0;
  const objectXhtml = (object) => {
    switch (object.type) {
      case 'note': {
        noteNumber += 1;
        const label = esc(fields.notes.get(object)?.label ?? String(noteNumber));
        const id = `note${noteNumber}`;
        current.notes.push({ id, label, html: runsXhtml(object.runs), end: object.kind === 'end' });
        return `<a epub:type="noteref" href="#${id}" id="${id}-ref" class="noteref">${label}</a>`;
      }
      case 'bookmark': anchors.set(object.name, current.file); return `<a id="${safeId(`b-${object.name}`)}"></a>`;
      case 'ref': return esc(referenceText(object, fields));
      case 'seq': return String(fields.seqs.get(object.id)?.number ?? '');
      case 'math': {
        const mathml = object.mathml ?? (object.tex ? texToMathml(object.tex, !!object.display) : null);
        if (!mathml && object.tex) losses.add('Formulas written as their TeX, the formula engine not having loaded');
        current.math = true;
        return mathmlWithTex({ ...object, mathml });
      }
      case 'field':
        if (object.field === 'date') return esc(new Date().toISOString().slice(0, 10));
        if (object.field === 'page' || object.field === 'pages') { losses.add('Page numbers, which a book reader works out itself'); return ''; }
        return '';
      case 'cite': return `[${esc(object.key)}]`;
      case 'merge': return `«${esc(object.name)}»`;
      case 'comment': losses.add('Comments, left out of the book'); return '';
      case 'drawing': {
        const o = drawings.find((d) => d.id === object.id);
        return o ? drawingXhtml(o, true) : '';
      }
      default: return '';
    }
  };

  const drawingXhtml = (o, inline = false) => {
    current.svg = true;
    const svg = drawingSvg({ ...o, x: 0, y: 0, rotation: 0 }, {
      objects: drawings, image: (x) => picture(x.resource), defaults: TEXT_DRAWING_DEFAULTS, standalone: true, idPrefix: `e${safeId(o.id)}`,
    });
    const label = o.description || o.name ? ` aria-label="${esc([o.name, o.description].filter(Boolean).join(': '))}" role="img"` : '';
    const words = o.text ? o.text.split('\n').map((line) => `<span class="shape-text">${esc(line)}</span>`).join('<br/>') : '';
    const turn = o.rotation ? `transform:rotate(${o.rotation}deg);` : '';
    const side = ['before'].includes(o.wrap) ? 'float:right;' : ['after', 'parallel', 'optimal', 'contour'].includes(o.wrap) ? 'float:left;' : '';
    const tag = inline ? 'span' : 'div';
    return `<${tag} class="drawing"${label} style="width:${Math.round(o.w)}px;max-width:100%;${turn}${inline ? '' : side}">${svg}${words ? `<span class="shape-words">${words}</span>` : ''}</${tag}>`;
  };

  const listXhtml = (block) => {
    const tag = block.listType === 'number' ? 'ol' : 'ul';
    const render = (nodes) => `<${tag}>${nodes.map((n) => `<li${n.plain ? ' class="plain"' : ''}>${n.html}${n.children.length ? render(n.children) : ''}</li>`).join('')}</${tag}>`;
    return render(nested(block.items.map((item) => ({ level: Math.max(0, item.level ?? 0), html: runsXhtml(item.runs), plain: item.unnumbered }))));
  };

  const tableXhtml = (block) => {
    const rows = block.rows.map((row) => `<tr>${row.cells.filter((cell) => !cell.covered).map((cell) => {
      const tag = row.header ? 'th' : 'td';
      const span = `${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}`;
      const style = cell.bg ? ` style="background-color:${esc(cell.bg)}"` : '';
      return `<${tag}${span}${style}>${runsXhtml(cell.runs)}</${tag}>`;
    }).join('')}</tr>`).join('');
    return `<table class="borders-${esc(block.borders ?? 'all')}">${rows}</table>`;
  };

  const anchored = new Map();
  for (const o of drawings) {
    if (o.anchor?.type === 'paragraph' || o.anchor?.type === 'char') {
      if (!anchored.has(o.anchor.block)) anchored.set(o.anchor.block, []);
      anchored.get(o.anchor.block).push(o);
    }
  }
  const onPages = drawings.filter((o) => o.anchor?.type === 'page');
  if (onPages.length) losses.add('Drawings anchored to a page, put at the start of the book');

  for (const block of blocks) {
    if (block.kind === 'heading' && (block.level ?? 1) === 1 && current.parts.length) start();
    if (onPages.length && chapters.length === 1 && current.parts.length === 0) current.parts.push(...onPages.map((o) => drawingXhtml(o)));
    for (const o of anchored.get(block.id) ?? []) current.parts.push(drawingXhtml(o));
    const align = block.align && block.align !== 'left' ? ` style="text-align:${block.align === 'justify' ? 'justify' : block.align}"` : '';
    switch (block.kind) {
      case 'heading': {
        const level = Math.max(1, Math.min(block.level ?? 1, 4));
        const id = `h-${safeId(block.id ?? `${chapters.length}-${current.parts.length}`)}`;
        const number = fields.headingIndex.get(block.id)?.number;
        const text = runsXhtml(block.runs);
        headings.push({ level, id, file: current.file, title: `${number ? `${number} ` : ''}${runsText(block.runs).replaceAll(OBJECT, '')}` });
        if (!current.title) current.title = runsText(block.runs).replaceAll(OBJECT, '').trim();
        current.parts.push(`<h${level} id="${id}"${align}>${number ? `<span class="number">${esc(number)}</span> ` : ''}${text}</h${level}>`);
        break;
      }
      case 'quote': current.parts.push(`<blockquote${align}><p>${runsXhtml(block.runs)}</p></blockquote>`); break;
      case 'code': current.parts.push(`<pre><code>${esc(runsText(block.runs))}</code></pre>`); break;
      case 'list': current.parts.push(listXhtml(block)); break;
      case 'table': current.parts.push(tableXhtml(block)); break;
      case 'image': {
        const href = picture(block.resource);
        const caption = runsText(block.caption ?? []) ? `<figcaption>${runsXhtml(block.caption)}</figcaption>` : '';
        if (href) current.parts.push(`<figure><img src="${href}" alt="${esc(runsText(block.caption ?? []))}" style="width:${Math.round(block.w ?? 400)}px;max-width:100%"/>${caption}</figure>`);
        break;
      }
      case 'chart': {
        current.svg = true;
        let svg = chartSvg(ownChartSpec(block), { width: block.w ?? 480, height: block.h ?? 300, background: '#ffffff' });
        if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', `<svg xmlns="${SVG}"`);
        current.parts.push(`<figure class="chart">${svg}</figure>`);
        break;
      }
      case 'toc': break;
      case 'index': losses.add('Alphabetical indexes, which have no pages in a book'); break;
      case 'section': if ((block.columns ?? 1) > 1) losses.add('Text in columns, which flows in one in a book'); break;
      default: {
        if (block.runs) current.parts.push(`<p${align}${block.style === 'caption' ? ' class="caption"' : ''}>${runsXhtml(block.runs)}</p>`);
        else losses.add('Blocks of another program, left out');
      }
    }
  }

  // Endnotes gather in a last part of their own.
  const endnotes = chapters.flatMap((c) => c.notes.filter((n) => n.end).map((n) => ({ ...n, from: c.file })));
  const page = (chapter, title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML}" xmlns:epub="${OPS}" xml:lang="${esc(options.language ?? 'en')}" lang="${esc(options.language ?? 'en')}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>
`;
  const chapterFiles = chapters.filter((c) => c.parts.length || c.notes.length).map((c, i) => {
    const notes = c.notes.filter((n) => !n.end).map((n) => `<aside epub:type="footnote" id="${n.id}" class="footnote"><p><a href="#${n.id}-ref">${n.label}</a> ${n.html}</p></aside>`);
    let body = [...c.parts, ...(notes.length ? [`<section class="footnotes">${notes.join('\n')}</section>`] : [])].join('\n');
    // A note at the end of the book is linked across files.
    for (const n of c.notes.filter((x) => x.end)) body = body.replace(`href="#${n.id}"`, `href="notes.xhtml#${n.id}"`);
    return { ...c, data: page(c, c.title || options.title || `Part ${i + 1}`, body) };
  });
  if (endnotes.length) {
    chapterFiles.push({
      file: 'notes.xhtml', svg: false, math: false, title: 'Notes',
      data: page(null, 'Notes', `<section epub:type="endnotes"><h1>Notes</h1>\n${endnotes.map((n) => `<aside epub:type="endnote" id="${n.id}"><p><a href="${n.from}#${n.id}-ref">${n.label}</a> ${n.html}</p></aside>`).join('\n')}</section>`),
    });
  }
  // Links to bookmarks in another chapter name its file.
  for (const c of chapterFiles) {
    c.data = c.data.replace(/href="#([^"]+)"/g, (whole, name) => {
      const file = anchors.get(name);
      if (!file) return whole;
      const id = safeId(`b-${name}`);
      return file === c.file ? `href="#${id}"` : `href="${file}#${id}"`;
    });
  }

  const title = (options.title ?? '').trim() || headings[0]?.title?.trim() || 'Untitled';
  const language = options.language || 'en';
  const words = blocks.map((b) => runsText(b.runs ?? [])).join('\n');
  const identifier = `urn:uuid:${hashOf(`${title}\n${words}`)}`;
  const modified = options.date ?? FIXED_DATE;

  // The table of contents: the headings to the third level, nested.
  const shown = headings.filter((x) => x.level <= 3).map((h) => ({ level: h.level - 1, html: `<a href="${h.file}#${h.id}">${esc(h.title.trim() || 'Untitled')}</a>` }));
  const renderNav = (nodes) => `<ol>${nodes.map((n) => `<li>${n.html || '<span>Untitled</span>'}${n.children.length ? renderNav(n.children) : ''}</li>`).join('')}</ol>`;
  const navItems = shown.length ? renderNav(nested(shown)) : `<ol><li><a href="${chapterFiles[0]?.file ?? 'chapter1.xhtml'}">${esc(title)}</a></li></ol>`;
  const nav = page(null, title, `<nav epub:type="toc" id="toc"><h1>${esc(title)}</h1>${navItems}</nav>`);

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...chapterFiles.map((c, i) => {
      const props = [c.svg ? 'svg' : null, c.math ? 'mathml' : null].filter(Boolean).join(' ');
      return `<item id="c${i + 1}" href="${c.file}" media-type="application/xhtml+xml"${props ? ` properties="${props}"` : ''}/>`;
    }),
    ...[...pictures.values()].map((p, i) => `<item id="p${i + 1}" href="${p.href}" media-type="${p.type}"/>`),
  ];
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${esc(language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">${identifier}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:language>${esc(language)}</dc:language>
${options.author?.trim() ? `<dc:creator>${esc(options.author.trim())}</dc:creator>\n` : ''}<meta property="dcterms:modified">${esc(modified)}</meta>
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine>
${chapterFiles.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('\n')}
</spine>
</package>
`;
  const css = `body{font-family:serif;line-height:1.5;margin:0 5%}
h1,h2,h3,h4{font-family:sans-serif;line-height:1.2}
blockquote{margin:1em 2em;font-style:italic}
pre{white-space:pre-wrap;font-size:.9em}
table{border-collapse:collapse;margin:1em 0}
table.borders-all td,table.borders-all th{border:1px solid #888;padding:.2em .4em}
figure{margin:1em 0;text-align:center}
figcaption,.caption{font-size:.9em;font-style:italic}
.u{text-decoration:underline}
.sc{font-variant:small-caps}
.noteref{vertical-align:super;font-size:.75em}
.footnotes{border-top:1px solid #888;margin-top:2em;font-size:.9em}
.drawing{display:inline-block;position:relative;margin:.5em}
.drawing svg{display:block;width:100%;height:auto}
.shape-words{position:absolute;left:0;right:0;top:40%;text-align:center}
li.plain{list-style:none}
`;
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/style.css', data: css },
    ...chapterFiles.map((c) => ({ name: `OEBPS/${c.file}`, data: c.data })),
    ...[...pictures.values()].map((p) => ({ name: `OEBPS/${p.href}`, data: p.bytes })),
  ];
  return { entries, losses };
}

/** Items with levels as a tree: each deeper item goes under the one before it, a level skipped held by an empty item. */
function nested(items) {
  const root = { level: -1, children: [] };
  const stack = [root];
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1].level >= item.level) stack.pop();
    let parent = stack[stack.length - 1];
    while (parent.level + 1 < item.level) {
      const filler = { level: parent.level + 1, html: '', children: [] };
      parent.children.push(filler);
      stack.push(filler);
      parent = filler;
    }
    const node = { ...item, children: [] };
    parent.children.push(node);
    stack.push(node);
  }
  return root.children;
}
