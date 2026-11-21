/** Mouse and keyboard on the slide: the drawing layer every program shares, with what is Slides' own. */

import { DrawLayer } from './core/draw/layer.js';
import { cleanDrawing } from './core/draw/objects.js';

const SNAP = 8;

/** What the pointer is over, in Slides' words: a handle, an element, or the stage. */
export function hitTarget(element) {
  const none = { kind: 'stage', id: null, handle: null };
  if (!element || typeof element.closest !== 'function') return none;
  const handle = element.closest('.handle');
  if (handle) return { kind: 'handle', id: handle.dataset.id, handle: handle.dataset.handle };
  const owner = element.closest('[data-id]');
  if (owner) return { kind: 'element', id: owner.dataset.id, handle: null };
  return none;
}

let counter = 0;
const newId = () => `e${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export class Interaction extends DrawLayer {
  constructor(surface, renderer) {
    const host = {};
    super(surface, host);
    this.renderer = renderer;
    this.model = null;
    this.slideId = null;
    this.snapEnabled = true;
    this.onChange = () => {};
    this.onCommit = () => {};
    this.onEditText = () => {};
    this.onSelectionChange = () => {};
    Object.assign(host, {
      objects: () => (this.model?.slide(this.slideId)?.elements ?? []).filter((e) => !e.fromMaster),
      toPage: (x, y) => renderer.toSlide(x, y),
      snapshot: () => this.model.snapshot(),
      commit: (before) => { this.model.dirty = true; this.onCommit(before); },
      redraw: () => this.onChange(),
      selectionChanged: () => this.onSelectionChange(),
      page: () => this.model?.canvas ?? { w: 1920, h: 1080 },
      makeId: newId,
      add: (o) => this.model.addDrawing(this.slideId, o),
      remove: (ids) => this.model.deleteElements(this.slideId, ids),
      grid: () => ({ step: SNAP, snap: this.snapEnabled }),
      helplines: () => this.helplines !== false,
      snapLines: () => this.model?.slide(this.slideId)?.guides ?? [],
      // Shift on a cell of the one table chosen stretches the choice of cells instead.
      keepsOnShift: (event) => event.shiftKey && event.target?.closest?.('td[data-row]') && this.selection.size === 1,
      create: (tool, box) => (tool.kind === 'text' ? { kind: 'text', ...box, content: [{ text: '' }] } : null),
      doubleClick: (hit, point) => this.doubleClickAt(hit, point),
    });
  }

  attach(model, slideId) {
    this.model = model;
    this.slideId = slideId;
    this.selection.clear();
    this.scope = [];
    this.onSelectionChange();
  }

  doubleClickAt(hit, point) {
    const element = hit.id && this.model.element(this.slideId, hit.id);
    if (element?.kind === 'table') {
      // Which cell was hit matters.
      const cell = document.elementFromPoint?.(this.lastClient?.x ?? 0, this.lastClient?.y ?? 0)?.closest?.('td[data-row]');
      if (cell) this.onEditText(element.id, { row: Number(cell.dataset.row), col: Number(cell.dataset.col) });
      return;
    }
    if (element?.kind === 'text' || element?.kind === 'chart' || element?.kind === 'formula') {
      this.onEditText(element.id);
      return;
    }
    if (element) return;
    // Empty space: a new text box where the click landed, ready to type in.
    const before = this.model.snapshot();
    const snap = (v) => (this.snapEnabled ? Math.round(v / SNAP) * SNAP : v);
    const created = this.model.addElement(this.slideId, { kind: 'text', x: snap(point.x - 300), y: snap(point.y - 60), w: 600, h: 120, content: [{ text: '' }] });
    this.onCommit(before);
    this.selection = new Set([created.id]);
    this.onSelectionChange();
    this.onChange();
    this.onEditText(created.id);
  }

  doubleClick(event) {
    this.lastClient = { x: event.clientX, y: event.clientY };
    super.doubleClick(event);
  }
}

/** Drawing fields a slide element keeps, cleaned as every program cleans them. */
export const drawingFields = cleanDrawing;
