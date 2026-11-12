/** The presentation, independent of how it is drawn. */

import { cleanComments, newComment, COMMENT_LIMITS } from './core/comments.js';
import { normaliseTable, insertRows, deleteRows, insertCols, deleteCols, TABLE_LIMITS } from './tables.js';
import { makeId } from './ids.js';
import { cleanRuns, parasFor, normalisePara } from './paragraphs.js';
import { footerBoxes } from './core/formats/slide-footer.js';
import { normaliseChartData } from './core/formats/chart-object.js';

export const FORMAT_VERSION = 1;
export const KINDS = ['text', 'image', 'shape', 'line', 'table', 'chart', 'formula'];

/** Where a layout puts its placeholders, as parts of the slide: x, y, width, height. */
export const LAYOUTS = {
  title: { label: 'Title slide', places: [['title', 'title', 0.08, 0.3, 0.84, 0.2], ['subtitle', 'body', 0.15, 0.53, 0.7, 0.14]] },
  titleContent: { label: 'Title and content', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.88, 0.68]] },
  twoContent: { label: 'Two contents', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.43, 0.68], ['body2', 'body', 0.51, 0.24, 0.43, 0.68]] },
  section: { label: 'Section header', places: [['title', 'title', 0.08, 0.36, 0.84, 0.18], ['subtitle', 'caption', 0.08, 0.56, 0.84, 0.1]] },
  titleOnly: { label: 'Title only', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15]] },
  blank: { label: 'Blank', places: [] },
  centredText: { label: 'Centred text', places: [['body', 'body', 0.12, 0.3, 0.76, 0.4]] },
  threeLeft: { label: 'One left, two right', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.43, 0.68], ['body2', 'body', 0.51, 0.24, 0.43, 0.33], ['body3', 'body', 0.51, 0.59, 0.43, 0.33]] },
  threeRight: { label: 'Two left, one right', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.43, 0.33], ['body2', 'body', 0.06, 0.59, 0.43, 0.33], ['body3', 'body', 0.51, 0.24, 0.43, 0.68]] },
  twoStacked: { label: 'One over another', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.88, 0.33], ['body2', 'body', 0.06, 0.59, 0.88, 0.33]] },
  threeTop: { label: 'Two on top, one below', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.43, 0.33], ['body2', 'body', 0.51, 0.24, 0.43, 0.33], ['body3', 'body', 0.06, 0.59, 0.88, 0.33]] },
  four: { label: 'Four contents', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.43, 0.33], ['body2', 'body', 0.51, 0.24, 0.43, 0.33], ['body3', 'body', 0.06, 0.59, 0.43, 0.33], ['body4', 'body', 0.51, 0.59, 0.43, 0.33]] },
  six: { label: 'Six contents', places: [['title', 'title', 0.06, 0.05, 0.88, 0.15], ['body', 'body', 0.06, 0.24, 0.28, 0.33], ['body2', 'body', 0.36, 0.24, 0.28, 0.33], ['body3', 'body', 0.66, 0.24, 0.28, 0.33], ['body4', 'body', 0.06, 0.59, 0.28, 0.33], ['body5', 'body', 0.36, 0.59, 0.28, 0.33], ['body6', 'body', 0.66, 0.59, 0.28, 0.33]] },
};
export const PLACEHOLDERS = ['title', 'subtitle', 'body', 'body2', 'body3', 'body4', 'body5', 'body6'];

/** Shapes, the same vocabulary GRT Graphs offers. */
export const SHAPES = [
  'rect', 'rounded', 'ellipse', 'diamond', 'parallelogram', 'hexagon', 'triangle',
];

/** Canvas sizes. */
export const CANVAS_PRESETS = {
  '16:9': { label: 'Widescreen 16:9', w: 1920, h: 1080 },
  '4:3': { label: 'Classic 4:3', w: 1440, h: 1080 },
  a4l: { label: 'A4 landscape', w: 1754, h: 1240 },
  a4p: { label: 'A4 portrait', w: 1240, h: 1754 },
};
export const TRANSITIONS = ['none', 'fade', 'slide'];

/** 16:9 at a size that makes the numbers readable in the JSON. */
export const DEFAULT_CANVAS = { w: 1920, h: 1080 };

/** The font families offered. */
export const FONTS = {
  sans: { label: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  serif: { label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Monospace', stack: 'ui-monospace, "Cascadia Code", Consolas, monospace' },
};

export const ALIGNMENTS = ['left', 'center', 'right'];

export function fontStack(name) {
  return (FONTS[name] ?? FONTS.sans).stack;
}

const DEFAULT_STYLES = {
  title: { font: 'sans', size: 72, color: '#111111', align: 'left', bold: true, italic: false },
  body: { font: 'sans', size: 32, color: '#333333', align: 'left', bold: false, italic: false },
  caption: { font: 'sans', size: 22, color: '#666666', align: 'left', bold: false, italic: false },
};

/** A slide's footer line: its text, the slide number and the date, each shown or not. */
export function normaliseFooter(footer) {
  if (!footer || typeof footer !== 'object') return null;
  const out = {
    text: typeof footer.text === 'string' ? footer.text.slice(0, 200) : '',
    number: footer.number === true,
    date: ['auto', 'fixed'].includes(footer.date) ? footer.date : null,
    dateText: typeof footer.dateText === 'string' ? footer.dateText.slice(0, 60) : '',
  };
  return out.text || out.number || out.date ? out : null;
}

const DEFAULT_THEME = {
  background: '#ffffff',
  accent: '#1f6feb',
  text: '#222222',
};

/** A few complete looks, so changing the whole deck is one choice. */
export const PRESETS = {
  paper: {
    label: 'Paper',
    theme: { background: '#ffffff', accent: '#1f6feb', text: '#222222' },
    styles: {
      title: { color: '#111111', font: 'sans' },
      body: { color: '#333333', font: 'sans' },
      caption: { color: '#666666', font: 'sans' },
    },
  },
  ink: {
    label: 'Ink',
    theme: { background: '#12151c', accent: '#6aa6ff', text: '#e8ecf3' },
    styles: {
      title: { color: '#f2f5fa', font: 'sans' },
      body: { color: '#d3d9e4', font: 'sans' },
      caption: { color: '#98a2b3', font: 'sans' },
    },
  },
  parchment: {
    label: 'Parchment',
    theme: { background: '#f6efe0', accent: '#a67c00', text: '#2e2519' },
    styles: {
      title: { color: '#2e2519', font: 'serif' },
      body: { color: '#4a4033', font: 'serif' },
      caption: { color: '#7a6a4f', font: 'serif' },
    },
  },
  terminal: {
    label: 'Terminal',
    theme: { background: '#0b0f0b', accent: '#3fd66b', text: '#c8f7d4' },
    styles: {
      title: { color: '#3fd66b', font: 'mono' },
      body: { color: '#c8f7d4', font: 'mono' },
      caption: { color: '#6f9c7c', font: 'mono' },
    },
  },
};

export class SlidesModel {
  constructor(document = null) {
    this.canvas = { ...DEFAULT_CANVAS };
    this.theme = structuredClone(DEFAULT_THEME);
    this.styles = structuredClone(DEFAULT_STYLES);
    this.masters = [];
    this.slides = [];
    /** Fonts carried by the document, as {id, name, resource}. */
    this.fonts = [];
    this.path = null;
    this.dirty = false;

    if (document) this.load(document);
    if (this.slides.length === 0) this.addSlide();
    this.dirty = false;
  }

  // Slides

  /** A slide, or a master being edited as one. */
  slide(id) {
    const master = this.masters?.find((m) => m.id === id);
    if (master) {
      master.elements ??= [];
      return master;
    }
    return this.slides.find((s) => s.id === id) ?? null;
  }

  addSlide(atIndex = this.slides.length, layout = null) {
    const slide = {
      id: makeId('s'),
      master: this.slides[Math.max(0, Math.min(atIndex, this.slides.length) - 1)]?.master ?? null,
      // A new slide carries the footer of the one before it, as LibreOffice does.
      footer: structuredClone(this.slides[Math.max(0, Math.min(atIndex, this.slides.length) - 1)]?.footer ?? null),
      // Present from the start, and null rather than absent.
      background: null,
      section: null,
      notes: '',
      transition: 'none',
      elements: [],
    };
    this.slides.splice(Math.max(0, Math.min(atIndex, this.slides.length)), 0, slide);
    if (layout) this.setLayout(slide.id, layout);
    this.dirty = true;
    return slide;
  }

  /**
   * Gives a slide a layout: its placeholders go where the layout puts them, made when missing,
   * and placeholders the layout has no place for, if empty, go.
   */
  setLayout(slideId, layout) {
    const slide = this.slide(slideId);
    const spec = LAYOUTS[layout];
    if (!slide || !spec) return;
    const { w, h } = this.canvas;
    const wanted = new Set(spec.places.map(([name]) => name));
    slide.elements = slide.elements.filter((e) => !e.placeholder || wanted.has(e.placeholder)
      || (e.kind === 'text' && (e.content ?? []).some((run) => run.text.trim() !== '')));
    for (const [name, style, x, y, width, height] of spec.places) {
      const box = { x: Math.round(x * w), y: Math.round(y * h), w: Math.round(width * w), h: Math.round(height * h) };
      const existing = slide.elements.find((e) => e.placeholder === name);
      if (existing) Object.assign(existing, box);
      else this.addElement(slide.id, { kind: 'text', style, placeholder: name, ...box, content: [{ text: '' }] });
    }
    slide.layout = layout;
    this.dirty = true;
  }

  /** Copies a slide, giving everything in it new identifiers. */
  duplicateSlide(id) {
    const index = this.slides.findIndex((s) => s.id === id);
    if (index === -1) return null;

    const copy = structuredClone(this.slides[index]);
    copy.id = makeId('s');
    for (const element of copy.elements) element.id = makeId('e');

    this.slides.splice(index + 1, 0, copy);
    this.dirty = true;
    return copy;
  }

  deleteSlide(id) {
    // A deck with no slides has nothing to show and no way back to a slide,
    // so the last one stays.
    if (this.slides.length <= 1) {
      throw new Error('Cannot delete the last remaining slide');
    }
    this.slides = this.slides.filter((s) => s.id !== id);
    this.dirty = true;
  }

  moveSlide(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    const [slide] = this.slides.splice(fromIndex, 1);
    if (!slide) return;
    this.slides.splice(Math.max(0, Math.min(toIndex, this.slides.length)), 0, slide);
    this.dirty = true;
  }

  /** The background actually painted for a slide. */
  slideBackground(slideId) {
    return this.slide(slideId)?.background ?? this.theme.background ?? '#ffffff';
  }

  setSlideBackground(id, colour) {
    const slide = this.slide(id);
    if (!slide) return;
    // null means "follow the theme", which is different from white.
    slide.background = colour || null;
    this.dirty = true;
  }

  /** A slide kept but skipped when presenting. */
  /** Sets the footer of some slides, or takes it away with null. */
  setFooter(ids, footer) {
    const clean = normaliseFooter(footer);
    for (const id of ids) {
      const slide = this.slide(id);
      if (slide) slide.footer = clean ? { ...clean } : null;
    }
    this.dirty = true;
  }

  /** Shows the master's objects on a slide, or hides them. */
  setMasterObjects(id, shown) {
    const slide = this.slide(id);
    if (!slide) return;
    if (shown) delete slide.hideMaster; else slide.hideMaster = true;
    this.dirty = true;
  }

  setHidden(id, hidden) {
    const slide = this.slide(id);
    if (!slide) return;
    if (hidden) slide.hidden = true; else delete slide.hidden;
    this.dirty = true;
  }

  setTransition(id, transition) {
    const slide = this.slide(id);
    if (!slide || !TRANSITIONS.includes(transition)) return;
    slide.transition = transition;
    this.dirty = true;
  }

  /** Applies a transition to every slide at once. */
  setAllTransitions(transition) {
    if (!TRANSITIONS.includes(transition)) return;
    for (const slide of this.slides) slide.transition = transition;
    this.dirty = true;
  }

  setNotes(id, notes) {
    const slide = this.slide(id);
    if (!slide) return;
    slide.notes = notes;
    this.dirty = true;
  }

  // Comments on a slide, each at a place; who wrote them is not kept.

  addComment(slideId, { x, y, text }) {
    const slide = this.slide(slideId);
    if (!slide) return null;
    const comment = newComment({ x, y, text });
    slide.comments = [...(slide.comments ?? []), comment].slice(-COMMENT_LIMITS.count);
    this.dirty = true;
    return comment;
  }

  setComment(slideId, id, text) {
    const comment = this.slide(slideId)?.comments?.find((c) => c.id === id);
    if (!comment) return;
    if (String(text ?? '').trim() === '') return this.deleteComment(slideId, id);
    comment.text = String(text).slice(0, COMMENT_LIMITS.text);
    this.dirty = true;
  }

  deleteComment(slideId, id) {
    const slide = this.slide(slideId);
    if (!slide?.comments) return;
    slide.comments = slide.comments.filter((c) => c.id !== id);
    if (slide.comments.length === 0) delete slide.comments;
    this.dirty = true;
  }

  // Sections

  /** Sections group slides in the panel. */
  setSection(slideId, title) {
    const slide = this.slide(slideId);
    if (!slide) return;
    slide.section = title?.trim() ? title.trim() : null;
    this.dirty = true;
  }

  /** Slides grouped for the panel: [{title, slides: []}]. */
  sections() {
    const groups = [];
    let current = null;

    for (const slide of this.slides) {
      if (slide.section || current === null) {
        current = { title: slide.section ?? null, slides: [] };
        groups.push(current);
      }
      current.slides.push(slide);
    }

    return groups;
  }

  // Elements

  /** Adds an element to a slide. */
  addElement(slideId, element) {
    const slide = this.slide(slideId);
    if (!slide) return null;

    const created = {
      id: makeId('e'),
      kind: KINDS.includes(element.kind) ? element.kind : 'text',
      x: element.x ?? 160,
      y: element.y ?? 160,
      w: element.w ?? 600,
      h: element.h ?? 200,
      rotation: element.rotation ?? 0,
      z: element.z ?? this.nextZ(slide),
      style: element.style ?? 'body',
      ...(element.kind === 'text' ? { content: element.content ?? [{ text: '' }] } : {}),
      ...(element.kind === 'image'
        ? { resource: element.resource ?? null, fit: element.fit ?? 'contain' }
        : {}),
      ...(element.kind === 'shape'
        ? (element.shape === 'path' && typeof element.path === 'string'
          ? { shape: 'path', path: element.path }
          : { shape: SHAPES.includes(element.shape) ? element.shape : 'rect' })
        : {}),
      ...(element.kind === 'line'
        ? { thickness: element.thickness ?? 4, arrow: element.arrow ?? false }
        : {}),
      // A static grid, as decided against per-cell formatting.
      ...(element.kind === 'table'
        ? normaliseTable({
          rows: element.rows ?? 3, cols: element.cols ?? 2, header: element.header ?? true, cells: element.cells,
          colW: element.colW, rowH: element.rowH, merges: element.merges,
        })
        : {}),
      ...(element.kind === 'chart'
        ? { type: element.type ?? 'column', data: normaliseChartData(element.data), title: element.title ?? '', legend: element.legend ?? 'right', ...(element.stacked ? { stacked: element.stacked } : {}) }
        : { data: element.data ?? {} }),
      ...(element.kind === 'formula' ? { tex: element.tex ?? '', ...(element.mathml ? { mathml: element.mathml } : {}) } : {}),
      ...(PLACEHOLDERS.includes(element.placeholder) ? { placeholder: element.placeholder } : {}),
    };

    slide.elements.push(created);
    this.dirty = true;
    return created;
  }

  nextZ(slide) {
    return slide.elements.reduce((top, e) => Math.max(top, e.z ?? 0), 0) + 1;
  }

  element(slideId, elementId) {
    return this.slide(slideId)?.elements.find((e) => e.id === elementId) ?? null;
  }

  deleteElements(slideId, ids) {
    const slide = this.slide(slideId);
    if (!slide) return;
    const doomed = new Set(ids);
    slide.elements = slide.elements.filter((e) => !doomed.has(e.id));
    this.dirty = true;
  }

  moveElements(slideId, ids, dx, dy) {
    const slide = this.slide(slideId);
    if (!slide) return;
    const moving = new Set(ids);
    for (const element of slide.elements) {
      if (!moving.has(element.id)) continue;
      element.x += dx;
      element.y += dy;
    }
    this.dirty = true;
  }

  setBounds(slideId, id, bounds) {
    const element = this.element(slideId, id);
    if (!element) return;
    element.x = bounds.x;
    element.y = bounds.y;
    // Too small to grab is too small to be useful.
    element.w = Math.max(bounds.w, 24);
    element.h = Math.max(bounds.h, 24);
    this.dirty = true;
  }

  setRotation(slideId, ids, degrees) {
    const slide = this.slide(slideId);
    if (!slide) return;
    const chosen = new Set(ids);
    for (const element of slide.elements) {
      if (chosen.has(element.id)) {
        element.rotation = (((degrees % 360) + 360) % 360);
      }
    }
    this.dirty = true;
  }

  /** Brings elements to the front or sends them to the back. */
  reorder(slideId, ids, direction) {
    const slide = this.slide(slideId);
    if (!slide) return;

    const chosen = slide.elements.filter((e) => ids.includes(e.id));
    if (chosen.length === 0) return;

    const top = slide.elements.reduce((max, e) => Math.max(max, e.z ?? 0), 0);
    const bottom = slide.elements.reduce((min, e) => Math.min(min, e.z ?? 0), 0);

    chosen.forEach((element, i) => {
      element.z = direction === 'front' ? top + 1 + i : bottom - 1 - i;
    });
    this.dirty = true;
  }

  /** Per-element colour overrides. */
  setElementColour(slideId, ids, { colour = undefined, fill = undefined } = {}) {
    const slide = this.slide(slideId);
    if (!slide) return;
    const chosen = new Set(ids);

    for (const element of slide.elements) {
      if (!chosen.has(element.id)) continue;
      if (colour !== undefined) {
        if (colour) element.color = colour;
        else delete element.color;      // back to the named style.
      }
      if (fill !== undefined) {
        if (fill) element.fill = fill;
        else delete element.fill;
      }
    }
    this.dirty = true;
  }

  setElementShape(slideId, ids, shape) {
    if (!SHAPES.includes(shape)) return;
    const slide = this.slide(slideId);
    if (!slide) return;
    const chosen = new Set(ids);
    for (const element of slide.elements) {
      if (chosen.has(element.id) && element.kind === 'shape') element.shape = shape;
    }
    this.dirty = true;
  }

  setElementFont(slideId, ids, font) {
    if (!FONTS[font]) return;
    const slide = this.slide(slideId);
    if (!slide) return;
    const chosen = new Set(ids);
    for (const element of slide.elements) {
      if (chosen.has(element.id)) element.font = font;
    }
    this.dirty = true;
  }

  /** Applies one of the complete looks from PRESETS. */
  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;

    this.theme = { ...this.theme, ...preset.theme };
    for (const [style, patch] of Object.entries(preset.styles)) {
      if (this.styles[style]) this.styles[style] = { ...this.styles[style], ...patch };
    }
    // Slides carrying their own background keep it.
    this.dirty = true;
  }

  /** Text size, alignment and anchoring for elements that need their own; null follows the style. */
  setElementText(slideId, ids, { size = undefined, align = undefined, valign = undefined } = {}) {
    const slide = this.slide(slideId);
    if (!slide) return;
    const chosen = new Set(ids);
    for (const element of slide.elements) {
      if (!chosen.has(element.id) || !['text', 'table'].includes(element.kind)) continue;
      if (size !== undefined) {
        if (size > 0) element.size = Math.round(size); else delete element.size;
      }
      if (align !== undefined) {
        if (ALIGNMENTS.includes(align)) element.align = align; else delete element.align;
      }
      if (valign !== undefined && element.kind === 'text') {
        if (['middle', 'bottom'].includes(valign)) element.valign = valign; else delete element.valign;
      }
    }
    this.dirty = true;
  }

  setElementStyle(slideId, ids, style) {
    const slide = this.slide(slideId);
    if (!slide || !this.styles[style]) return;
    const chosen = new Set(ids);
    for (const element of slide.elements) {
      if (chosen.has(element.id)) element.style = style;
    }
    this.dirty = true;
  }

  // Tables

  /** Sets the text of one cell. */
  setCell(slideId, elementId, row, col, text) {
    const element = this.element(slideId, elementId);
    if (!element || element.kind !== 'table') return;
    if (!element.cells[row] || element.cells[row][col] === undefined) return;

    element.cells[row][col] = String(text ?? '');
    this.dirty = true;
  }

  /** Adds or removes a row or a column. */
  resizeTable(slideId, elementId, { rows, cols }) {
    const element = this.element(slideId, elementId);
    if (!element || element.kind !== 'table') return;

    const wantRows = Math.max(1, Math.min(rows ?? element.rows, TABLE_LIMITS.rows));
    const wantCols = Math.max(1, Math.min(cols ?? element.cols, TABLE_LIMITS.cols));
    // Rows and columns come and go at the end, keeping the sizes of the others.
    if (wantRows > element.rows) insertRows(element, element.rows, wantRows - element.rows);
    else if (wantRows < element.rows) deleteRows(element, wantRows, element.rows - wantRows);
    if (wantCols > element.cols) insertCols(element, element.cols, wantCols - element.cols);
    else if (wantCols < element.cols) deleteCols(element, wantCols, element.cols - wantCols);
    this.dirty = true;
  }

  /** Runs a change on a table, then holds it to its rules; what the change gives back is returned. */
  changeTable(slideId, elementId, op) {
    const element = this.element(slideId, elementId);
    if (!element || element.kind !== 'table') return false;
    const result = op(element);
    normaliseTable(element);
    this.dirty = true;
    return result;
  }

  setTableHeader(slideId, elementId, header) {
    const element = this.element(slideId, elementId);
    if (!element || element.kind !== 'table') return;
    element.header = !!header;
    this.dirty = true;
  }

  // Text

  /**
   * Replaces a text box's content.
   * @param {string} slideId
   * @param {string} elementId
   * @param {{text: string, bold?: boolean, italic?: boolean, underline?: boolean}[]} runs
   */
  setContent(slideId, elementId, runs, paras = null) {
    const element = this.element(slideId, elementId);
    if (!element || element.kind !== 'text') return;

    // The runs take every mark the editor of Paper knows; a paragraph keeps its list level.
    element.content = cleanRuns((runs ?? []).filter((run) => typeof run.text === 'string'));
    if (paras) element.paras = paras.map(normalisePara);
    element.paras = parasFor(element);
    if (element.paras.every((p) => p.level === 0 && !p.list)) delete element.paras;
    this.dirty = true;
  }

  /** Changes a text box's paragraph spacing: line height (times), space above and below and indent per level (px). */
  setSpacing(slideId, elementId, patch) {
    const element = this.element(slideId, elementId);
    if (!element || element.kind !== 'text') return;
    for (const key of ['lineHeight', 'spaceBefore', 'spaceAfter', 'indent']) {
      if (!(key in patch)) continue;
      const value = Number(patch[key]);
      if (patch[key] === null || !Number.isFinite(value)) delete element[key];
      else element[key] = key === 'lineHeight' ? Math.min(10, Math.max(0.5, value)) : Math.max(0, Math.min(500, value));
    }
    this.dirty = true;
  }

  /** The plain text of an element, with the formatting dropped. */
  static plainText(element) {
    if (element.kind !== 'text') return '';
    return (element.content ?? []).map((run) => run.text).join('');
  }

  // Styles and theme

  setStyle(name, patch) {
    if (!this.styles[name]) return;
    this.styles[name] = { ...this.styles[name], ...patch };
    this.dirty = true;
  }

  setTheme(patch) {
    this.theme = { ...this.theme, ...patch };
    this.dirty = true;
  }

  /** Changes the slide size. */
  setCanvas(size, { scaleElements = true } = {}) {
    if (!(size.w > 0 && size.h > 0)) return;

    const fx = size.w / this.canvas.w;
    const fy = size.h / this.canvas.h;
    this.canvas = { w: Math.round(size.w), h: Math.round(size.h) };

    if (scaleElements) {
      const groups = [...this.slides, ...this.masters];
      for (const group of groups) {
        for (const element of group.elements ?? []) {
          element.x = Math.round(element.x * fx);
          element.y = Math.round(element.y * fy);
          element.w = Math.round(element.w * fx);
          element.h = Math.round(element.h * fy);
        }
      }
    }

    this.dirty = true;
  }

  // Masters

  /** A master is an ordinary slide with a flag. */
  addMaster(name = 'Master') {
    const master = { id: makeId('m'), name, elements: [] };
    this.masters.push(master);
    this.dirty = true;
    return master;
  }

  master(id) {
    return this.masters.find((m) => m.id === id) ?? null;
  }

  renameMaster(id, name) {
    const master = this.master(id);
    if (master) master.name = String(name).slice(0, 100);
    this.dirty = true;
  }

  deleteMaster(id) {
    this.masters = this.masters.filter((m) => m.id !== id);
    for (const slide of this.slides) if (slide.master === id) slide.master = null;
    this.dirty = true;
  }

  assignMaster(slideId, masterId) {
    const slide = this.slide(slideId);
    if (!slide) return;
    slide.master = masterId && this.master(masterId) ? masterId : null;
    this.dirty = true;
  }

  /** Everything drawn on a slide, master elements underneath, sorted by z. */
  renderList(slideId) {
    const slide = this.slide(slideId);
    if (!slide) return [];

    const master = slide.master && !slide.hideMaster ? this.master(slide.master) : null;
    const fromMaster = (master?.elements ?? []).map((e) => ({ ...e, fromMaster: true }));

    return [...fromMaster, ...slide.elements, ...this.footerElements(slide)]
      .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  }

  /** The footer, date and number of a slide as text boxes along its foot, drawn but not edited. */
  footerElements(slide, today = new Date()) {
    return footerBoxes(slide.footer, this.canvas, this.slides.indexOf(slide) + 1, today).map(({ part, align, text, x, y, w, h }) => ({
      id: `footer-${part}`, kind: 'text', style: 'caption', footerPart: part, align, valign: 'middle', rotation: 0, z: 10000, fromMaster: true,
      x, y, w, h, content: [{ text }],
    }));
  }

  // Whole document

  toJSON() {
    return {
      version: FORMAT_VERSION,
      type: 'slides',
      canvas: { ...this.canvas },
      theme: structuredClone(this.theme),
      styles: structuredClone(this.styles),
      fonts: structuredClone(this.fonts),
      masters: structuredClone(this.masters),
      slides: structuredClone(this.slides),
    };
  }

  load(document) {
    if (!document || typeof document !== 'object') {
      throw new Error('Not a presentation document');
    }

    this.canvas = { ...DEFAULT_CANVAS, ...(document.canvas ?? {}) };
    this.theme = { ...DEFAULT_THEME, ...(document.theme ?? {}) };
    this.styles = { ...structuredClone(DEFAULT_STYLES), ...(document.styles ?? {}) };
    this.fonts = Array.isArray(document.fonts) ? structuredClone(document.fonts) : [];
    this.masters = Array.isArray(document.masters) ? structuredClone(document.masters) : [];
    this.slides = Array.isArray(document.slides) ? structuredClone(document.slides) : [];

    // Missing fields are filled in rather than rejected.
    for (const slide of this.slides) {
      slide.id ??= makeId('s');
      slide.notes ??= '';
      slide.comments = cleanComments(slide.comments);
      if (slide.comments.length === 0) delete slide.comments;
      slide.transition ??= 'none';
      slide.master ??= null;
      slide.footer = normaliseFooter(slide.footer);
      if (slide.hideMaster !== true) delete slide.hideMaster;
      slide.background ??= null;
      slide.section ??= null;
      slide.elements ??= [];
      for (const element of slide.elements) {
        element.id ??= makeId('e');
        element.kind ??= 'text';
        element.rotation ??= 0;
        element.z ??= 1;
        element.style ??= 'body';
        element.data ??= {};
        if (element.kind === 'shape') element.shape ??= 'rect';
        if (element.kind === 'line') {
          element.thickness ??= 4;
          element.arrow ??= false;
        }
        // A table from a file is held to the limits before anything is built from its size.
        if (element.kind === 'table') normaliseTable(element);
        if (element.kind === 'text') {
          element.content = cleanRuns(element.content ?? [{ text: '' }]);
          if (element.paras) element.paras = parasFor(element);
        }
        if (element.kind === 'chart') element.data = normaliseChartData(element.data);
        if (element.kind === 'formula') element.tex = typeof element.tex === 'string' ? element.tex.slice(0, 5000) : '';
        if (!KINDS.includes(element.kind)) element.kind = 'text';
      }
    }

    this.dirty = false;
  }

  /** Registers a font the document carries. */
  addFont(name, resource) {
    const id = `custom-${this.fonts.length + 1}`;
    this.fonts.push({ id, name, resource });
    this.dirty = true;
    return id;
  }

  /** Font stack for a name, custom fonts included. */
  stackFor(name) {
    const custom = this.fonts.find((f) => f.id === name);
    if (custom) return `"${custom.name}", ${fontStack('sans')}`;
    return fontStack(name);
  }

  /**
   * Resource paths the document refers to, for saving and for cleaning up.
   */
  usedResources() {
    const used = new Set();
    for (const font of this.fonts) {
      if (font.resource) used.add(font.resource);
    }
    for (const slide of this.slides) {
      for (const element of slide.elements) {
        if (element.kind === 'image' && element.resource) used.add(element.resource);
      }
    }
    for (const master of this.masters) {
      for (const element of master.elements ?? []) {
        if (element.kind === 'image' && element.resource) used.add(element.resource);
      }
    }
    return [...used];
  }

  // Undo

  snapshot() {
    return {
      canvas: { ...this.canvas },
      theme: structuredClone(this.theme),
      styles: structuredClone(this.styles),
      fonts: structuredClone(this.fonts),
      masters: structuredClone(this.masters),
      slides: structuredClone(this.slides),
      dirty: this.dirty,
    };
  }

  restore(snapshot) {
    this.canvas = { ...snapshot.canvas };
    this.theme = structuredClone(snapshot.theme);
    this.styles = structuredClone(snapshot.styles);
    this.fonts = structuredClone(snapshot.fonts ?? []);
    this.masters = structuredClone(snapshot.masters);
    this.slides = structuredClone(snapshot.slides);
    this.dirty = snapshot.dirty;
  }
}

