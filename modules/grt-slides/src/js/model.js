/** The presentation, independent of how it is drawn. */

import { makeId } from './ids.js';

export const FORMAT_VERSION = 1;
export const KINDS = ['text', 'image', 'shape', 'line', 'table'];

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
  }

  // Slides

  slide(id) {
    return this.slides.find((s) => s.id === id) ?? null;
  }

  addSlide(atIndex = this.slides.length) {
    const slide = {
      id: makeId('s'),
      master: null,
      // Present from the start, and null rather than absent.
      background: null,
      section: null,
      notes: '',
      transition: 'none',
      elements: [],
    };
    this.slides.splice(Math.max(0, Math.min(atIndex, this.slides.length)), 0, slide);
    this.dirty = true;
    return slide;
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
        ? { shape: SHAPES.includes(element.shape) ? element.shape : 'rect' }
        : {}),
      ...(element.kind === 'line'
        ? { thickness: element.thickness ?? 4, arrow: element.arrow ?? false }
        : {}),
      // A static grid, as decided against per-cell formatting.
      ...(element.kind === 'table'
        ? {
          rows: element.rows ?? 3,
          cols: element.cols ?? 2,
          header: element.header ?? true,
          cells: normaliseCells(element.cells, element.rows ?? 3, element.cols ?? 2),
        }
        : {}),
      data: element.data ?? {},
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

    element.rows = Math.max(1, Math.min(rows ?? element.rows, 30));
    element.cols = Math.max(1, Math.min(cols ?? element.cols, 12));
    element.cells = normaliseCells(element.cells, element.rows, element.cols);
    this.dirty = true;
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
  setContent(slideId, elementId, runs) {
    const element = this.element(slideId, elementId);
    if (!element || element.kind !== 'text') return;

    element.content = runs
      .filter((run) => typeof run.text === 'string')
      .map((run) => ({
        text: run.text,
        ...(run.bold ? { bold: true } : {}),
        ...(run.italic ? { italic: true } : {}),
        ...(run.underline ? { underline: true } : {}),
        ...(run.color ? { color: run.color } : {}),
      }));

    if (element.content.length === 0) element.content = [{ text: '' }];
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

    const master = slide.master ? this.master(slide.master) : null;
    const fromMaster = (master?.elements ?? []).map((e) => ({ ...e, fromMaster: true }));

    return [...fromMaster, ...slide.elements]
      .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
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
      slide.transition ??= 'none';
      slide.master ??= null;
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
        if (element.kind === 'table') {
          element.rows ??= 3;
          element.cols ??= 2;
          element.header ??= true;
          element.cells = normaliseCells(element.cells, element.rows, element.cols);
        }
        if (element.kind === 'text') element.content ??= [{ text: '' }];
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

/** A rows x cols grid of strings, whatever shape the input was. */
function normaliseCells(cells, rows, cols) {
  const source = Array.isArray(cells) ? cells : [];
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const value = source[r]?.[c];
      return typeof value === 'string' ? value : '';
    }));
}
