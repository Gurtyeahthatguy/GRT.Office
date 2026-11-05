/** Model to DOM. */

import { runsText, OBJECT } from './model.js';
import { documentFields, referenceText, referenceBlock } from './fields.js';
import { chartSvg } from '../charts.js';
import { mathSvg } from '../math.js';
import { ownChartSpec } from '../formats/chart-object.js';

/** What the objects of the document being drawn resolve to; set for the length of one draw. */
let current = null;

const FONT_STACKS = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
};

export function fontStack(name, model = null) {
  const custom = model?.fonts?.find((f) => f.id === name);
  if (custom) return `"${custom.name}", ${FONT_STACKS.serif}`;
  return FONT_STACKS[name] ?? FONT_STACKS.serif;
}

/**
 * Points to CSS pixels at 96 dpi, which is what the page box is measured in.
 */
export const PT = 96 / 72;
export const MM = 96 / 25.4;

/** The CSS a named style produces. */
export function styleCss(style, model) {
  return {
    fontFamily: fontStack(style.font, model),
    fontSize: `${(style.size ?? 11) * PT}px`,
    lineHeight: String(style.lineHeight ?? 1.5),
    fontWeight: style.bold ? '700' : '400',
    fontStyle: style.italic ? 'italic' : 'normal',
    marginTop: `${(style.spaceBefore ?? 0) * PT}px`,
    marginBottom: `${(style.spaceAfter ?? 0) * PT}px`,
    paddingLeft: style.indent ? `${style.indent * PT}px` : '0px',
    textIndent: style.firstLine ? `${style.firstLine * PT}px` : '',
    color: style.color ?? '',
    textDecoration: [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' '),
    borderBottom: style.rule ? '1px solid #808080' : '',
  };
}

/** A style with a paragraph's own spacing laid over it. */
export function withPara(style, para) {
  return para ? { ...style, ...para } : style;
}

/** The CSS a character style gives the text it is on. */
function charCss(style, model) {
  const css = {};
  if (style.font) css.fontFamily = fontStack(style.font, model);
  if (style.size) css.fontSize = `${style.size * PT}px`;
  if (style.bold !== undefined) css.fontWeight = style.bold ? '700' : '400';
  if (style.italic !== undefined) css.fontStyle = style.italic ? 'italic' : 'normal';
  if (style.color) css.color = style.color;
  if (style.highlight) css.backgroundColor = style.highlight;
  const lines = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (lines) css.textDecoration = lines;
  return css;
}

let currentModel = null;

export class Renderer {
  /**
   * @param {HTMLElement} surface the editable region
   */
  constructor(surface) {
    this.surface = surface;
  }

  /** Rebuilds the whole document. */
  draw(model, images = new Map(), { footnotesAtEnd = true } = {}) {
    // The sheet's own padding defines the text column; setting a width here
    // as well made the two disagree by a fraction of a millimetre.
    current = documentFields(model);
    currentModel = model;
    try {
      // Blocks after a section mark flow in its columns, up to the next mark.
      const out = [];
      let flow = null;
      for (const block of model.blocks) {
        const element = this.blockElement(block, model, images);
        if (block.kind === 'section') {
          out.push(element);
          flow = null;
          if (block.columns > 1) {
            flow = document.createElement('div');
            flow.className = 'section-columns';
            flow.dataset.section = block.id;
            Object.assign(flow.style, { columnCount: String(block.columns), columnGap: `${block.gap * MM}px` });
            out.push(flow);
          }
          continue;
        }
        (flow ?? { append: (e) => out.push(e) }).append(element);
      }
      const notes = notesElement(footnotesAtEnd ? current : { ...current, footnotes: [] });
      this.surface.replaceChildren(...out, ...(notes ? [notes] : []));
    } finally {
      current = null;
      currentModel = null;
    }
  }

  blockElement(block, model, images) {
    const style = model.styles[block.style] ?? model.styles.body ?? {};

    if (block.kind === 'image') {
      const figure = document.createElement('figure');
      figure.className = 'block image';
      figure.dataset.block = block.id;
      figure.style.textAlign = block.align ?? 'center';
      figure.style.margin = `${(style.spaceBefore ?? 8) * PT}px 0 ${(style.spaceAfter ?? 8) * PT}px`;

      const source = images.get(block.resource);
      if (source) {
        const image = document.createElement('img');
        image.src = source;
        image.alt = '';
        image.style.width = `${block.w}px`;
        image.style.maxWidth = '100%';
        figure.append(image);
      } else {
        // A missing image is a visible frame, not a silent hole.
        const missing = document.createElement('div');
        missing.className = 'missing-image';
        missing.style.height = `${block.h}px`;
        figure.append(missing);
      }

      if (runsText(block.caption) !== '') {
        const caption = document.createElement('figcaption');
        caption.append(...block.caption.map(runElement));
        figure.append(caption);
      }

      return figure;
    }

    if (block.kind === 'table') return tableElement(block, model, style);
    if (block.kind === 'toc' || block.kind === 'index') return generatedElement(block, model);
    if (block.kind === 'section') {
      const mark = document.createElement('div');
      mark.className = 'block section-mark';
      mark.dataset.block = block.id;
      mark.contentEditable = 'false';
      mark.dataset.label = block.columns > 1 ? `${block.columns} columns from here` : 'One column from here';
      return mark;
    }
    if (block.kind === 'chart') {
      const figure = document.createElement('figure');
      figure.className = 'block chart';
      figure.dataset.block = block.id;
      figure.contentEditable = 'false';
      figure.style.textAlign = block.align ?? 'center';
      figure.style.margin = '6pt 0';
      const holder = document.createElement('div');
      holder.className = 'chart-holder';
      Object.assign(holder.style, { display: 'inline-block', width: `${block.w}px`, maxWidth: '100%' });
      holder.innerHTML = chartSvg(ownChartSpec(block), { width: block.w, height: block.h, background: '#ffffff', text: '#222222' });
      figure.append(holder);
      return figure;
    }

    if (block.kind === 'list') {
      const list = document.createElement(block.listType === 'number' ? 'ol' : 'ul');
      list.className = 'block list';
      if (block.listType === 'number' && block.format) list.style.listStyleType = block.format;
      if (block.listType !== 'number' && block.bullet) list.style.listStyleType = `"${block.bullet}  "`;
      list.dataset.blockContainer = block.id;
      Object.assign(list.style, styleCss(withPara(style, block.para), model));

      list.append(...block.items.map((item, index) => {
        const li = document.createElement('li');
        li.dataset.block = block.id;
        li.dataset.item = String(index);
        li.style.marginLeft = `${item.level * 24}px`;
        li.append(...runElements(item.runs));
        return li;
      }));

      return list;
    }

    const tag = block.kind === 'heading' ? `h${Math.min(block.level ?? 1, 6)}`
      : block.kind === 'quote' ? 'blockquote'
        : block.kind === 'code' ? 'pre' : 'p';

    const element = document.createElement(tag);
    element.className = `block ${block.kind}`;
    element.dataset.block = block.id;
    element.style.textAlign = block.align ?? 'left';
    Object.assign(element.style, styleCss(withPara(style, block.para), model));
    // A heading's number is drawn before its text, not part of it.
    const number = block.kind === 'heading' ? current?.headingIndex?.get(block.id)?.number : null;
    if (number) element.dataset.number = number;
    else delete element.dataset.number;
    element.append(...runElements(block.runs));

    return element;
  }
}

/** A table: each cell a text container of its block, addressed by its index row by row. */
function tableElement(block, model, style) {
  const table = document.createElement('table');
  table.className = `block table borders-${block.borders ?? 'all'}`;
  table.dataset.blockContainer = block.id;
  Object.assign(table.style, styleCss(style, model), { paddingLeft: '0px' });
  const total = block.widths.reduce((a, b) => a + b, 0) || 1;
  const columns = document.createElement('colgroup');
  for (const width of block.widths) {
    const col = document.createElement('col');
    col.style.width = `${(width / total) * 100}%`;
    columns.append(col);
  }
  table.append(columns);
  const cols = block.rows[0]?.cells.length ?? 0;
  const head = document.createElement('thead');
  const body = document.createElement('tbody');
  block.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.cells.forEach((cell, c) => {
      if (cell.covered) return;
      const td = document.createElement(row.header ? 'th' : 'td');
      td.dataset.block = block.id;
      td.dataset.item = String(r * cols + c);
      if (cell.colspan > 1) td.colSpan = cell.colspan;
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      if (cell.bg) td.style.backgroundColor = cell.bg;
      if (cell.align) td.style.textAlign = cell.align;
      if (cell.valign) td.style.verticalAlign = cell.valign;
      td.append(...runElements(cell.runs));
      tr.append(td);
    });
    (row.header && body.childElementCount === 0 ? head : body).append(tr);
  });
  if (head.childElementCount) table.append(head);
  table.append(body);
  return table;
}

/** A table of contents or an index: drawn from the document, not typed, its page numbers filled in by the layout. */
function generatedElement(block, model) {
  const element = document.createElement('div');
  element.className = `block ${block.kind}`;
  element.dataset.block = block.id;
  element.contentEditable = 'false';
  const title = document.createElement('div');
  title.className = 'generated-title';
  title.textContent = block.title;
  Object.assign(title.style, styleCss(model.styles.h2 ?? {}, model));
  element.append(title);
  const fields = current ?? documentFields(model);
  const line = (text, target, level) => {
    const row = document.createElement('a');
    row.className = `generated-line level-${level}`;
    row.dataset.goto = target;
    const label = document.createElement('span');
    label.textContent = text;
    const page = document.createElement('span');
    page.className = 'page-of';
    page.dataset.pageOf = target;
    row.append(label, page);
    return row;
  };
  if (block.kind === 'toc') {
    for (const heading of fields.headings) {
      if (heading.level > block.levels || !heading.text) continue;
      element.append(line(heading.number ? `${heading.number} ${heading.text}` : heading.text, heading.blockId, heading.level));
    }
  } else {
    // Terms in alphabetical order, each with the places it is marked.
    const terms = new Map();
    for (const entry of fields.entries) {
      const key = entry.sub ? `${entry.term}\u0000${entry.sub}` : entry.term;
      if (!terms.has(key)) terms.set(key, { ...entry, blocks: [] });
      if (!terms.get(key).blocks.includes(entry.blockId)) terms.get(key).blocks.push(entry.blockId);
    }
    const sorted = [...terms.values()].sort((a, b) => a.term.localeCompare(b.term) || (a.sub ?? '').localeCompare(b.sub ?? ''));
    let previous = null;
    for (const entry of sorted) {
      if (entry.sub && previous !== entry.term) element.append(line(entry.term, entry.blocks[0], 1));
      const row = line(entry.sub ?? entry.term, entry.blocks[0], entry.sub ? 2 : 1);
      row.lastChild.dataset.pageOf = entry.blocks.join(' ');
      element.append(row);
      previous = entry.term;
    }
  }
  return element;
}

/** The notes at the end of the document as the screen shows them; printed pages put footnotes at their feet. */
function notesElement(fields) {
  if (fields.footnotes.length === 0 && fields.endnotes.length === 0) return null;
  const aside = document.createElement('aside');
  aside.className = 'notes-area';
  aside.contentEditable = 'false';
  for (const [title, list] of [['Footnotes', fields.footnotes], ['Endnotes', fields.endnotes]]) {
    if (list.length === 0) continue;
    const heading = document.createElement('div');
    heading.className = 'notes-title';
    heading.textContent = title;
    aside.append(heading);
    for (const note of list) aside.append(noteLine(note));
  }
  return aside;
}

/** One note as it reads under the text: its number, then its words. */
export function noteLine(note) {
  const line = document.createElement('div');
  line.className = `note-line note-${note.object.kind}`;
  line.dataset.noteLabel = note.label;
  const label = document.createElement('sup');
  label.textContent = note.label;
  line.append(label, ' ', ...note.object.runs.map((run) => runElement(run)));
  return line;
}

/** The elements for a run list. */
export function runElements(runs) {
  if (!runs || runs.length === 0 || runsText(runs) === '') {
    return [document.createTextNode('')];
  }
  return runs.map(runElement);
}

/** An object of the text: its one character for the caret, and what it shows beside it. */
function objectElement(run) {
  const holder = document.createElement('span');
  holder.className = `object object-${run.object.type}`;
  const char = document.createElement('span');
  char.className = 'object-char';
  char.textContent = OBJECT;
  holder.append(char);
  const shown = document.createElement('span');
  shown.contentEditable = 'false';
  const object = run.object;
  const fields = current;
  if (object.type === 'bookmark') holder.dataset.name = object.name;
  if (object.type === 'index') holder.title = `Index: ${object.term}${object.sub ? `, ${object.sub}` : ''}`;
  switch (object.type) {
    case 'math': {
      const svg = mathSvg(object);
      holder.dataset.math = '1';
      if (svg) shown.innerHTML = svg;
      else {
        // Until the engine has loaded, or when the formula does not parse, its source shows.
        shown.className = 'math-source';
        shown.textContent = object.tex ?? 'formula';
        if (svg === null) holder.dataset.pending = '1';
      }
      if (object.display) holder.classList.add('math-display');
      break;
    }
    case 'note': {
      const sup = document.createElement('sup');
      sup.textContent = fields?.notes.get(object)?.label ?? '*';
      shown.append(sup);
      holder.dataset.note = object.kind;
      holder.dataset.noteLabel = sup.textContent;
      break;
    }
    case 'seq':
      shown.textContent = String(fields?.seqs.get(object.id)?.number ?? '#');
      break;
    case 'ref':
      if (object.show === 'page') {
        shown.className = 'page-of';
        shown.dataset.pageOf = fields ? referenceBlock(object, fields) ?? '' : '';
        shown.textContent = '?';
      } else shown.textContent = fields ? referenceText(object, fields) : object.target;
      break;
    case 'field':
      if (object.field === 'date') shown.textContent = new Date().toISOString().slice(0, 10);
      else if (object.field === 'time') shown.textContent = new Date().toTimeString().slice(0, 5);
      else {
        shown.className = `field-${object.field}`;
        shown.textContent = object.field === 'chapter' ? '' : '#';
      }
      break;
    default:
      break;
  }
  holder.append(shown);
  return holder;
}

function runElement(run) {
  if (run.object) return objectElement(run);
  const text = document.createTextNode(run.text);

  // Marks are applied as nested elements for display only.
  let node = text;
  if (run.sub) node = wrap('sub', node);
  if (run.sup) node = wrap('sup', node);
  if (run.strike) node = wrap('s', node);
  if (run.underline) node = wrap('u', node);
  if (run.italic) node = wrap('em', node);
  if (run.bold) node = wrap('strong', node);

  if (run.link) {
    const link = document.createElement('a');
    link.className = 'text-link';
    link.dataset.href = run.link;
    link.append(node);
    node = link;
  }

  const named = run.cstyle ? currentModel?.charStyles?.[run.cstyle] : null;
  if (named) {
    const span = document.createElement('span');
    span.className = 'char-style';
    span.dataset.cstyle = run.cstyle;
    Object.assign(span.style, charCss(named, currentModel));
    span.append(node);
    node = span;
  }

  if (run.color || run.highlight || run.size) {
    const span = document.createElement('span');
    if (run.color) span.style.color = run.color;
    if (run.highlight) span.style.backgroundColor = run.highlight;
    if (run.size) span.style.fontSize = `${run.size * PT}px`;
    span.append(node);
    node = span;
  }

  return node;
}

function wrap(tag, child) {
  const element = document.createElement(tag);
  element.append(child);
  return element;
}
