/** Mouse and keyboard on the canvas. */

import { portCentre } from './render.js';

const DRAG_THRESHOLD = 3;

/**
 * What the pointer is actually over.
 * @param {Element|null} element
 * @returns {{kind: 'port'|'handle'|'element'|'canvas', id: ?string,
 */
export function hitTarget(element) {
  const none = { kind: 'canvas', id: null, port: null, handle: null };
  if (!element || typeof element.closest !== 'function') return none;

  // Ports and handles sit above the node they belong to, so they are checked
  // first.
  const port = element.closest('.port');
  if (port) {
    return { kind: 'port', id: port.dataset.id, port: port.dataset.port, handle: null };
  }

  const handle = element.closest('.handle');
  if (handle) {
    return { kind: 'handle', id: handle.dataset.id, port: null, handle: handle.dataset.handle };
  }

  const owner = element.closest('[data-id]');
  if (owner) {
    return { kind: 'element', id: owner.dataset.id, port: null, handle: null };
  }

  return none;
}

export class Interaction {
  /**
   * @param {SVGSVGElement} svg
   * @param {Renderer} renderer
   */
  constructor(svg, renderer) {
    this.svg = svg;
    this.renderer = renderer;
    this.model = null;
    this.selection = new Set();

    this.gesture = null;
    this.extras = {};

    // Filled in by main.js.
    this.onChange = () => {};          // model changed, needs redraw.
    this.onCommit = () => {};          // gesture finished: record one undo entry.
    this.onBeginGesture = () => {};    // about to change the model.
    this.onEditText = () => {};
    this.onSelectionChange = () => {};

    svg.addEventListener('mousedown', (e) => this.down(e));
    window.addEventListener('mousemove', (e) => this.move(e));
    window.addEventListener('mouseup', (e) => this.up(e));
    svg.addEventListener('dblclick', (e) => this.doubleClick(e));
    svg.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  attach(model) {
    this.model = model;
    this.selection.clear();
    this.onSelectionChange();
  }

  /** Snaps to the grid unless the document says otherwise. */
  snap(value) {
    const { snapToGrid, gridSize } = this.model.meta;
    if (!snapToGrid || !gridSize) return value;
    return Math.round(value / gridSize) * gridSize;
  }

  down(event) {
    if (event.button === 1 || event.altKey) {
      this.gesture = { kind: 'pan', lastX: event.clientX, lastY: event.clientY };
      return;
    }
    if (event.button !== 0) return;

    const point = this.renderer.toDiagram(event.clientX, event.clientY);
    const hit = hitTarget(event.target);
    const id = hit.id;

    if (hit.kind === 'port' && this.model.node(id)) {
      this.gesture = {
        kind: 'connect',
        from: id,
        fromPort: hit.port,
        origin: portCentre(this.model.node(id), hit.port),
      };
      return;
    }

    if (hit.kind === 'handle' && this.model.node(id)) {
      this.gesture = {
        kind: 'resize',
        id,
        handle: hit.handle,
        before: this.model.snapshot(),
        start: { ...this.model.node(id) },
      };
      return;
    }

    // Dragging a connector bends it by hand.
    if (id && this.model.edge(id)) {
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) this.selection.clear();
      this.selection.add(id);
      this.onSelectionChange();

      this.gesture = {
        kind: 'reroute',
        id,
        before: this.model.snapshot(),
        moved: false,
      };
      this.onChange();
      return;
    }

    if (id) {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (!this.selection.has(id)) {
        if (!additive) this.selection.clear();
        this.selection.add(id);
      } else if (additive) {
        this.selection.delete(id);
      }
      this.onSelectionChange();

      const nodeIds = [...this.selection].filter((s) => this.model.node(s));
      this.gesture = {
        kind: 'move',
        ids: nodeIds,
        before: this.model.snapshot(),
        origin: point,
        applied: { dx: 0, dy: 0 },
        moved: false,
      };
      this.onChange();
      return;
    }

    // Empty canvas: rubber-band selection.
    if (!event.shiftKey) {
      this.selection.clear();
      this.onSelectionChange();
    }
    this.gesture = { kind: 'band', origin: point, current: point };
    this.onChange();
  }

  move(event) {
    if (!this.gesture) return;
    const point = this.renderer.toDiagram(event.clientX, event.clientY);

    switch (this.gesture.kind) {
      case 'pan':
        this.renderer.panBy(event.clientX - this.gesture.lastX, event.clientY - this.gesture.lastY);
        this.gesture.lastX = event.clientX;
        this.gesture.lastY = event.clientY;
        return;

      case 'move': {
        const dx = this.snap(point.x - this.gesture.origin.x);
        const dy = this.snap(point.y - this.gesture.origin.y);
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD
          && !this.gesture.moved) return;

        // Applied as a delta against what was already applied, so the model
        // never accumulates rounding from every intermediate mouse position.
        this.model.moveNodes(
          this.gesture.ids,
          dx - this.gesture.applied.dx,
          dy - this.gesture.applied.dy,
        );
        this.gesture.applied = { dx, dy };
        this.gesture.moved = true;
        this.extras.guides = this.alignmentGuides();
        this.onChange();
        return;
      }

      case 'resize': {
        const start = this.gesture.start;
        const handle = this.gesture.handle;
        let { x, y, w, h } = start;

        if (handle.includes('e')) w = this.snap(point.x) - start.x;
        if (handle.includes('s')) h = this.snap(point.y) - start.y;
        if (handle.includes('w')) { x = this.snap(point.x); w = start.x + start.w - x; }
        if (handle.includes('n')) { y = this.snap(point.y); h = start.y + start.h - y; }

        this.model.setNodeBounds(this.gesture.id, { x, y, w, h });
        this.onChange();
        return;
      }

      case 'reroute': {
        // One waypoint, placed where the pointer is.
        this.model.setWaypoints(this.gesture.id, [
          { x: this.snap(point.x), y: this.snap(point.y) },
        ]);
        this.gesture.moved = true;
        this.onChange();
        return;
      }

      case 'connect':
        this.extras.pendingEdge = { from: this.gesture.origin, to: point };
        this.onChange();
        return;

      case 'band':
        this.gesture.current = point;
        this.extras.rubberBand = normalise(this.gesture.origin, point);
        this.onChange();
        return;

      default:
    }
  }

  up(event) {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    this.extras = {};

    switch (gesture.kind) {
      case 'move':
        // One undo entry for the whole drag, or none at all if nothing moved.
        if (gesture.moved) this.onCommit(gesture.before);
        this.onChange();
        return;

      case 'resize':
        this.onCommit(gesture.before);
        this.onChange();
        return;

      case 'reroute':
        if (gesture.moved) this.onCommit(gesture.before);
        this.onChange();
        return;

      case 'connect': {
        // The same climb is needed here.
        const dropped = hitTarget(document.elementFromPoint(event.clientX, event.clientY));
        const toId = dropped.id;

        if (toId && toId !== gesture.from && this.model.node(toId)) {
          const before = this.model.snapshot();
          this.model.addEdge({
            from: gesture.from,
            to: toId,
            fromPort: gesture.fromPort,
            toPort: dropped.port ?? 'auto',
          });
          this.onCommit(before);
        }
        this.onChange();
        return;
      }

      case 'band': {
        const box = normalise(gesture.origin, gesture.current);
        if (box.w > 2 && box.h > 2) {
          for (const node of this.model.nodes) {
            if (node.x + node.w >= box.x && node.x <= box.x + box.w
              && node.y + node.h >= box.y && node.y <= box.y + box.h) {
              this.selection.add(node.id);
            }
          }
          this.onSelectionChange();
        }
        this.onChange();
        return;
      }

      default:
        this.onChange();
    }
  }

  doubleClick(event) {
    const { id } = hitTarget(event.target);

    // Double-clicking a bent connector straightens it.
    if (id && this.model.edge(id)) {
      const edge = this.model.edge(id);
      if (edge.waypoints.length > 0) {
        const before = this.model.snapshot();
        this.model.setWaypoints(id, []);
        this.onCommit(before);
        this.onChange();
      }
      return;
    }

    if (id && this.model.node(id)) {
      this.onEditText(id);
      return;
    }

    // Empty canvas: a new node, centred where the click landed.
    const point = this.renderer.toDiagram(event.clientX, event.clientY);
    const before = this.model.snapshot();
    const node = this.model.addNode({
      x: this.snap(point.x - 80),
      y: this.snap(point.y - 30),
    });
    this.onCommit(before);
    this.selection = new Set([node.id]);
    this.onSelectionChange();
    this.onChange();
    this.onEditText(node.id);
  }

  wheel(event) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      this.renderer.zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.1 : 1 / 1.1);
    } else {
      this.renderer.panBy(-event.deltaX, -event.deltaY);
    }
  }

  /** Lines shown when a dragged node lines up with another. */
  alignmentGuides() {
    const moving = this.model.nodes.filter((n) => this.gesture?.ids?.includes(n.id));
    const still = this.model.nodes.filter((n) => !this.gesture?.ids?.includes(n.id));
    if (moving.length === 0 || still.length === 0) return [];

    const guides = [];
    const tolerance = 2;

    for (const node of moving) {
      for (const other of still) {
        for (const [a, b] of [
          [node.x, other.x], [node.x + node.w / 2, other.x + other.w / 2],
          [node.x + node.w, other.x + other.w],
        ]) {
          if (Math.abs(a - b) <= tolerance) {
            guides.push({
              vertical: true,
              at: b,
              from: Math.min(node.y, other.y) - 20,
              to: Math.max(node.y + node.h, other.y + other.h) + 20,
            });
          }
        }
        for (const [a, b] of [
          [node.y, other.y], [node.y + node.h / 2, other.y + other.h / 2],
          [node.y + node.h, other.y + other.h],
        ]) {
          if (Math.abs(a - b) <= tolerance) {
            guides.push({
              vertical: false,
              at: b,
              from: Math.min(node.x, other.x) - 20,
              to: Math.max(node.x + node.w, other.x + other.w) + 20,
            });
          }
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
