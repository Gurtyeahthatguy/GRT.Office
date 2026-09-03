/** Mouse and keyboard on the slide. */

const DRAG_THRESHOLD = 2;
const SNAP = 8;

/** What the pointer is over. */
export function hitTarget(element) {
  const none = { kind: 'stage', id: null, handle: null };
  if (!element || typeof element.closest !== 'function') return none;

  const handle = element.closest('.handle');
  if (handle) {
    return { kind: 'handle', id: handle.dataset.id, handle: handle.dataset.handle };
  }

  const owner = element.closest('[data-id]');
  if (owner) return { kind: 'element', id: owner.dataset.id, handle: null };

  return none;
}

export class Interaction {
  constructor(surface, renderer) {
    this.surface = surface;
    this.renderer = renderer;
    this.model = null;
    this.slideId = null;
    this.selection = new Set();
    this.gesture = null;
    this.extras = {};
    this.snapEnabled = true;

    this.onChange = () => {};
    this.onCommit = () => {};
    this.onEditText = () => {};
    this.onSelectionChange = () => {};

    surface.addEventListener('mousedown', (e) => this.down(e));
    window.addEventListener('mousemove', (e) => this.move(e));
    window.addEventListener('mouseup', (e) => this.up(e));
    surface.addEventListener('dblclick', (e) => this.doubleClick(e));
  }

  attach(model, slideId) {
    this.model = model;
    this.slideId = slideId;
    this.selection.clear();
    this.onSelectionChange();
  }

  snap(value) {
    return this.snapEnabled ? Math.round(value / SNAP) * SNAP : value;
  }

  down(event) {
    if (event.button !== 0) return;

    // A box being edited belongs to the caret.
    if (event.target?.closest?.('.editing')) return;
    const point = this.renderer.toSlide(event.clientX, event.clientY);
    const hit = hitTarget(event.target);

    if (hit.kind === 'handle') {
      const element = this.model.element(this.slideId, hit.id);
      if (!element) return;
      event.preventDefault();

      this.gesture = hit.handle === 'rotate'
        ? { kind: 'rotate', id: hit.id, before: this.model.snapshot(), moved: false }
        : {
          kind: 'resize',
          id: hit.id,
          handle: hit.handle,
          before: this.model.snapshot(),
          start: { ...element },
        };
      return;
    }

    if (hit.kind === 'element') {
      event.preventDefault();
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;

      if (!this.selection.has(hit.id)) {
        if (!additive) this.selection.clear();
        this.selection.add(hit.id);
      } else if (additive) {
        this.selection.delete(hit.id);
      }
      this.onSelectionChange();

      this.gesture = {
        kind: 'move',
        ids: [...this.selection],
        before: this.model.snapshot(),
        origin: point,
        applied: { dx: 0, dy: 0 },
        moved: false,
      };
      this.onChange();
      return;
    }

    if (!event.shiftKey) {
      this.selection.clear();
      this.onSelectionChange();
    }
    this.gesture = { kind: 'band', origin: point, current: point };
    this.onChange();
  }

  move(event) {
    if (!this.gesture) return;
    const point = this.renderer.toSlide(event.clientX, event.clientY);

    switch (this.gesture.kind) {
      case 'move': {
        const dx = this.snap(point.x - this.gesture.origin.x);
        const dy = this.snap(point.y - this.gesture.origin.y);
        if (!this.gesture.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
          return;
        }

        // Applied as a delta against what is already applied, so the model
        // never accumulates rounding from every intermediate position.
        this.model.moveElements(
          this.slideId, this.gesture.ids,
          dx - this.gesture.applied.dx, dy - this.gesture.applied.dy,
        );
        this.gesture.applied = { dx, dy };
        this.gesture.moved = true;
        this.extras.guides = this.guides();
        this.onChange();
        return;
      }

      case 'resize': {
        const start = this.gesture.start;
        let { x, y, w, h } = start;

        if (this.gesture.handle.includes('e')) w = this.snap(point.x) - start.x;
        if (this.gesture.handle.includes('s')) h = this.snap(point.y) - start.y;
        if (this.gesture.handle.includes('w')) { x = this.snap(point.x); w = start.x + start.w - x; }
        if (this.gesture.handle.includes('n')) { y = this.snap(point.y); h = start.y + start.h - y; }

        this.model.setBounds(this.slideId, this.gesture.id, { x, y, w, h });
        this.gesture.moved = true;
        this.onChange();
        return;
      }

      case 'rotate': {
        const element = this.model.element(this.slideId, this.gesture.id);
        if (!element) return;

        const cx = element.x + element.w / 2;
        const cy = element.y + element.h / 2;
        const raw = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI + 90;

        // Snapped to 15° unless Shift is held, so the common angles are the
        // easy ones to hit.
        const angle = event.shiftKey ? raw : Math.round(raw / 15) * 15;
        this.model.setRotation(this.slideId, [this.gesture.id], angle);
        this.gesture.moved = true;
        this.onChange();
        return;
      }

      case 'band':
        this.gesture.current = point;
        this.extras.rubberBand = normalise(this.gesture.origin, point);
        this.onChange();
        return;

      default:
    }
  }

  up() {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    this.extras = {};

    if (gesture.kind === 'band') {
      const box = normalise(gesture.origin, gesture.current);
      if (box.w > 4 && box.h > 4) {
        for (const element of this.model.slide(this.slideId)?.elements ?? []) {
          if (element.x + element.w >= box.x && element.x <= box.x + box.w
            && element.y + element.h >= box.y && element.y <= box.y + box.h) {
            this.selection.add(element.id);
          }
        }
        this.onSelectionChange();
      }
    } else if (gesture.moved) {
      // One entry for the whole gesture, and none at all if nothing changed.
      this.onCommit(gesture.before);
    }

    this.onChange();
  }

  doubleClick(event) {
    if (event.target?.closest?.('.editing')) return;

    const { id } = hitTarget(event.target);
    const element = id && this.model.element(this.slideId, id);

    if (element?.kind === 'table') {
      // Which cell was hit matters.
      const cell = event.target?.closest?.('td');
      const row = cell?.parentElement;
      if (cell && row) {
        this.onEditText(id, {
          row: [...row.parentElement.children].indexOf(row),
          col: [...row.children].indexOf(cell),
        });
      }
      return;
    }

    if (element?.kind === 'text') {
      this.onEditText(id);
      return;
    }

    if (!element) {
      // Empty space: a new text box where the click landed, ready to type in.
      const point = this.renderer.toSlide(event.clientX, event.clientY);
      const before = this.model.snapshot();
      const created = this.model.addElement(this.slideId, {
        kind: 'text',
        x: this.snap(point.x - 300),
        y: this.snap(point.y - 60),
        w: 600,
        h: 120,
        content: [{ text: '' }],
      });
      this.onCommit(before);
      this.selection = new Set([created.id]);
      this.onSelectionChange();
      this.onChange();
      this.onEditText(created.id);
    }
  }

  /** Alignment guides, including the slide's own centre lines. */
  guides() {
    const slide = this.model.slide(this.slideId);
    if (!slide) return [];

    const moving = slide.elements.filter((e) => this.gesture?.ids?.includes(e.id));
    const still = slide.elements.filter((e) => !this.gesture?.ids?.includes(e.id));
    if (moving.length === 0) return [];

    const guides = [];
    const tolerance = 3;
    const { w, h } = this.model.canvas;

    for (const element of moving) {
      const centreX = element.x + element.w / 2;
      const centreY = element.y + element.h / 2;

      if (Math.abs(centreX - w / 2) <= tolerance) guides.push({ vertical: true, at: w / 2 });
      if (Math.abs(centreY - h / 2) <= tolerance) guides.push({ vertical: false, at: h / 2 });

      for (const other of still) {
        for (const [a, b] of [
          [element.x, other.x],
          [centreX, other.x + other.w / 2],
          [element.x + element.w, other.x + other.w],
        ]) {
          if (Math.abs(a - b) <= tolerance) guides.push({ vertical: true, at: b });
        }
        for (const [a, b] of [
          [element.y, other.y],
          [centreY, other.y + other.h / 2],
          [element.y + element.h, other.y + other.h],
        ]) {
          if (Math.abs(a - b) <= tolerance) guides.push({ vertical: false, at: b });
        }
      }
    }

    return guides.slice(0, 8);
  }
}

function normalise(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}
