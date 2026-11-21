/** The drawing layer: choosing, moving, sizing, turning and drawing objects with the pointer and the keyboard, for every program that holds drawings. */

import { presetDefinition, shapeGeometry, dragHandle, insertedSquare, shapeLabel } from './geometry.js';
import { corners, toPage, toLocal, gluePoints, scaleSubpaths, fitPathBox, fitGroup, outerBox, subpathsData, unionBox } from './objects.js';
import { fitConnector } from './render.js';

const DRAG = 3;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** What the pointer is over: a handle of some kind, an object, or the page. */
export function hitTarget(node) {
  const none = { kind: 'page', id: null };
  if (!node || typeof node.closest !== 'function') return none;
  const handle = node.closest('[data-handle]');
  if (handle) {
    return {
      kind: 'handle', id: handle.dataset.id, handle: handle.dataset.handle,
      index: handle.dataset.index !== undefined ? Number(handle.dataset.index) : null,
      part: handle.dataset.part ?? null,
    };
  }
  const owner = node.closest('[data-id]');
  if (owner) return { kind: 'object', id: owner.dataset.id };
  return none;
}

/** What the screen reader says for an object. */
export function objectLabel(o) {
  const what = {
    shape: shapeLabel(o.shape), path: 'Drawing', line: 'Line', connector: 'Connector', image: 'Image', group: 'Group',
    text: 'Text box', table: 'Table', chart: 'Chart', formula: 'Formula',
  }[o.kind] ?? 'Object';
  return [o.name || what, o.name ? what : null, o.description].filter(Boolean).join(', ');
}

const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

/** A point turned to the nearest multiple of 45° from another, as Shift and the 45° polygons do. */
function at45(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

/** Freehand points smoothed into curve nodes: a node every few points, with handles a third of the way to its neighbours. */
export function smoothPoints(points, closed = false) {
  const kept = [];
  for (const p of points) if (!kept.length || Math.hypot(p.x - kept[kept.length - 1].x, p.y - kept[kept.length - 1].y) > 6) kept.push(p);
  if (kept.length < 2) return kept.map((p) => ({ x: p.x, y: p.y }));
  return kept.map((p, i) => {
    const prev = kept[i - 1] ?? (closed ? kept[kept.length - 1] : p);
    const next = kept[i + 1] ?? (closed ? kept[0] : p);
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    return { x: p.x, y: p.y, in: { x: p.x - tx, y: p.y - ty }, out: { x: p.x + tx, y: p.y + ty } };
  });
}

export class DrawLayer {
  /**
   * @param {HTMLElement} surface where pointer presses land
   * @param {Object} host what the program gives: objects(), toPage(clientX, clientY), snapshot(), commit(before), redraw(),
   *   selectionChanged(), page() {w,h}, makeId(), add(o), remove(ids), doubleClick?(hit, point, event), grid?() {step, snap},
   *   create?(tool, box) for kinds the program draws itself, such as text boxes
   */
  constructor(surface, host) {
    this.surface = surface;
    this.host = host;
    this.selection = new Set();
    this.gesture = null;
    this.extras = {};
    this.tool = null;
    this.mode = 'select';
    this.pointer = null;
    // The groups entered, innermost last; inside one, the layer works on its members.
    this.scope = [];
    surface.addEventListener('mousedown', (e) => this.down(e));
    this.onMove = (e) => this.move(e);
    this.onUp = (e) => this.up(e);
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    // The second press of a double click counts at once: the page is drawn again between the clicks, and WebKit then may not send dblclick.
    surface.addEventListener('dblclick', (e) => { if (this.doubled) this.doubled = false; else this.doubleClick(e); });
  }

  objects() { return this.scope.length ? this.scope[this.scope.length - 1].children : (this.host.objects() ?? []); }

  /** Adds an object to the page, or to the group entered. */
  addObject(o) {
    if (this.scope.length) { this.scope[this.scope.length - 1].children.push(o); return o; }
    return this.host.add(o) ?? o;
  }

  /** Takes objects away from the page, or from the group entered. */
  removeObjects(ids) {
    const doomed = new Set(ids);
    if (this.scope.length) {
      const group = this.scope[this.scope.length - 1];
      group.children = group.children.filter((o) => !doomed.has(o.id));
      return;
    }
    this.host.remove(ids);
  }

  /** Enter Group: the members can be chosen and changed one by one. */
  enterGroup(id) {
    const group = this.objects().find((o) => o.id === id && o.kind === 'group');
    if (!group) return false;
    this.scope.push(group);
    this.select([]);
    return true;
  }

  /** Exit Group: the group takes the box of its members again. */
  exitGroup() {
    const group = this.scope.pop();
    if (!group) return false;
    const box = unionBox(group.children);
    if (box) Object.assign(group, { x: box.x, y: box.y, w: Math.max(box.w, 1), h: Math.max(box.h, 1) });
    this.select([group.id]);
    return true;
  }

  find(id) { return this.objects().find((o) => o.id === id) ?? null; }

  chosen() { return this.objects().filter((o) => this.selection.has(o.id)); }

  select(ids) {
    this.selection = new Set(ids);
    this.host.selectionChanged?.();
    this.host.redraw();
  }

  /** Picks a tool from Insert, Shape and the Drawing bar; the next press on the page draws with it. */
  useTool(tool) {
    this.tool = tool;
    this.extras = {};
    this.pendingPath = null;
    this.surface.classList.toggle('drawing-tool', Boolean(tool));
    this.host.redraw();
  }

  /** Point edit or glue point edit, on or off. */
  setMode(mode) {
    this.mode = this.mode === mode ? 'select' : mode;
    this.host.redraw();
  }

  snap(v) {
    const grid = this.host.grid?.();
    return grid?.snap && grid.step > 0 ? Math.round(v / grid.step) * grid.step : v;
  }

  /** A point snapped to the grid, and then to a snap guide within reach, as Insert, Snap Guide places them. */
  snapPoint(p) {
    const out = { x: this.snap(p.x), y: this.snap(p.y) };
    for (const g of this.host.snapLines?.() ?? []) {
      if (g.vertical && Math.abs(p.x - g.at) <= 8) out.x = g.at;
      if (!g.vertical && Math.abs(p.y - g.at) <= 8) out.y = g.at;
    }
    return out;
  }

  down(event) {
    if (event.button !== 0) return;
    // Text being typed keeps its presses; a drawing set in text, marked not editable, is the layer's.
    const editable = event.target?.closest?.('.editing, [contenteditable]');
    if (editable && (editable.classList.contains('editing') || editable.isContentEditable)) return;
    // A program that shares the page with the layer says which presses are the layer's; the rest only let go of its choice.
    if (this.host.claims && !this.tool && !this.pendingPath && !this.host.claims(event, hitTarget(event.target))) {
      if (this.selection.size) { this.selection.clear(); this.host.selectionChanged?.(); }
      return;
    }
    const point = this.host.toPage(event.clientX, event.clientY);
    if (event.detail >= 2 && (this.pendingPath || this.tool)) return;
    // A press on a handle is never half of a double click: it starts a drag, however soon it follows another press.
    this.doubled = event.detail === 2 && hitTarget(event.target).kind !== 'handle';
    if (this.doubled) {
      event.preventDefault();
      this.doubleClick(event);
      return;
    }
    if (this.tool) {
      event.preventDefault();
      this.startDrawing(point, event);
      return;
    }
    const hit = hitTarget(event.target);
    if (hit.kind === 'handle') {
      event.preventDefault();
      this.startHandle(hit, point, event);
      return;
    }
    if (hit.kind === 'object' && this.find(hit.id)) {
      event.preventDefault();
      if (this.mode === 'glue') {
        this.addGlue(hit.id, point);
        return;
      }
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (!this.selection.has(hit.id)) {
        if (!additive) this.selection.clear();
        this.selection.add(hit.id);
      } else if (additive && !this.host.keepsOnShift?.(event, hit)) {
        this.selection.delete(hit.id);
      }
      this.host.selectionChanged?.();
      const movable = this.chosen().filter((o) => !o.protect?.position);
      this.gesture = { kind: 'move', ids: movable.map((o) => o.id), before: this.host.snapshot(), origin: point, applied: { dx: 0, dy: 0 }, moved: false, copy: event.altKey };
      this.host.redraw();
      return;
    }
    if (!event.shiftKey && this.selection.size) {
      this.selection.clear();
      this.host.selectionChanged?.();
    }
    this.gesture = { kind: 'band', origin: point, current: point };
    this.host.redraw();
  }

  startHandle(hit, point, event) {
    const o = this.find(hit.id);
    if (!o) return;
    const before = this.host.snapshot();
    if (hit.handle === 'rotate') this.gesture = { kind: 'rotate', id: o.id, before, moved: false };
    else if (hit.handle === 'adjust') this.gesture = { kind: 'adjust', id: o.id, index: hit.index, before, moved: false };
    else if (hit.handle === 'node') {
      this.activeNode = { id: o.id, sub: Number(event.target.dataset.sub ?? 0), index: hit.index };
      this.gesture = { kind: 'node', id: o.id, index: hit.index, part: hit.part, sub: this.activeNode.sub, before, moved: false };
    }
    else if (hit.handle === 'glue') this.gesture = { kind: 'glue', id: o.id, index: hit.index, before, moved: false };
    else if (hit.handle === 'end') this.gesture = { kind: 'end', id: o.id, which: hit.part, before, moved: false };
    else if (HANDLES.includes(hit.handle) && !o.protect?.size) this.gesture = { kind: 'resize', id: o.id, handle: hit.handle, before, start: structuredClone(o), keep: event.shiftKey, moved: false };
  }

  move(event) {
    const point = this.host.toPage?.(event.clientX, event.clientY);
    if (!point) return;
    this.pointer = point;
    if (this.pendingPath) {
      this.pendingPath.hover = this.tool?.at45 ? at45(this.pendingPath.points[this.pendingPath.points.length - 1], point) : point;
      this.host.redraw();
    }
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case 'move': {
        let dx = this.snap(point.x - g.origin.x);
        let dy = this.snap(point.y - g.origin.y);
        if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (!g.moved && Math.abs(dx) < DRAG && Math.abs(dy) < DRAG) return;
        if (!g.moved && g.copy) {
          // Alt while dragging leaves the original and moves a copy, as LibreOffice does with Ctrl.
          const copies = this.chosen().map((o) => ({ ...structuredClone(o), id: this.host.makeId() }));
          copies.forEach((c) => this.addObject(c));
          g.ids = copies.map((c) => c.id);
          this.selection = new Set(g.ids);
        }
        for (const o of this.objects()) {
          if (!g.ids.includes(o.id)) continue;
          o.x += dx - g.applied.dx;
          o.y += dy - g.applied.dy;
        }
        g.applied = { dx, dy };
        g.moved = true;
        this.refitConnectors();
        this.extras.guides = this.host.helplines?.() === false ? [] : this.guides(g.ids);
        this.host.redraw();
        return;
      }
      case 'resize': this.resize(g, point); return;
      case 'rotate': {
        const o = this.find(g.id);
        if (!o) return;
        const raw = (Math.atan2(point.y - (o.y + o.h / 2), point.x - (o.x + o.w / 2)) * 180) / Math.PI + 90;
        o.rotation = ((Math.round(event.shiftKey ? raw : Math.round(raw / 15) * 15) % 360) + 360) % 360;
        g.moved = true;
        this.refitConnectors();
        this.host.redraw();
        return;
      }
      case 'adjust': {
        const o = this.find(g.id);
        const definition = o?.shape === 'custom' ? o.geometry : presetDefinition(o?.shape);
        if (!definition) return;
        o.mods = dragHandle(definition, o.w, o.h, o.mods, g.index, toLocal(o, point));
        g.moved = true;
        this.host.redraw();
        return;
      }
      case 'node': {
        const o = this.find(g.id);
        const node = o?.subpaths?.[g.sub]?.nodes?.[g.index];
        if (!node) return;
        const local = toLocal(o, this.snapPoint(point));
        if (g.part === 'in' || g.part === 'out') node[g.part] = local;
        else {
          const dx = local.x - node.x;
          const dy = local.y - node.y;
          node.x = local.x; node.y = local.y;
          for (const side of ['in', 'out']) if (node[side]) node[side] = { x: node[side].x + dx, y: node[side].y + dy };
        }
        g.moved = true;
        this.host.redraw();
        return;
      }
      case 'glue': {
        const o = this.find(g.id);
        if (!o?.glue?.[g.index]) return;
        const local = toLocal(o, point);
        o.glue[g.index] = { x: Math.min(1, Math.max(0, local.x / o.w)), y: Math.min(1, Math.max(0, local.y / o.h)) };
        g.moved = true;
        this.refitConnectors();
        this.host.redraw();
        return;
      }
      case 'end': {
        const o = this.find(g.id);
        if (!o) return;
        const target = this.glueNear(point, o.id);
        o[g.which] = target;
        if (!target) {
          if (g.which === 'from') { const right = o.x + o.w; const bottom = o.y + o.h; o.x = point.x; o.y = point.y; o.w = right - point.x; o.h = bottom - point.y; } else { o.w = point.x - o.x; o.h = point.y - o.y; }
        }
        g.moved = true;
        if (o.from || o.to) fitConnector(o, this.objects());
        this.host.redraw();
        return;
      }
      case 'band':
        g.current = point;
        this.extras.rubberBand = box(g.origin, point);
        this.host.redraw();
        return;
      case 'draw': this.drawMove(g, point, event); return;
      default:
    }
  }

  resize(g, point) {
    const o = this.find(g.id);
    if (!o) return;
    const s = g.start;
    // Work in the object's own upright frame about its old centre, so a turned object keeps its far corner still.
    const centre = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    const a = ((s.rotation ?? 0) * Math.PI) / 180;
    const local = { x: centre.x + (point.x - centre.x) * Math.cos(-a) - (point.y - centre.y) * Math.sin(-a), y: centre.y + (point.x - centre.x) * Math.sin(-a) + (point.y - centre.y) * Math.cos(-a) };
    let x0 = s.x; let y0 = s.y; let x1 = s.x + s.w; let y1 = s.y + s.h;
    const p = this.snapPoint(local);
    if (g.handle.includes('w')) x0 = p.x;
    if (g.handle.includes('e')) x1 = p.x;
    if (g.handle.includes('n')) y0 = p.y;
    if (g.handle.includes('s')) y1 = p.y;
    let w = Math.max(Math.abs(x1 - x0), 4);
    let h = Math.max(Math.abs(y1 - y0), 4);
    if (g.keep || insertedSquare(o.shape) || o.keepRatio) {
      const ratio = s.w / s.h || 1;
      if (g.handle.length === 2) { if (w / h > ratio) h = w / ratio; else w = h * ratio; } else if (g.handle === 'n' || g.handle === 's') w = h * ratio; else h = w / ratio;
      if (g.handle.includes('w')) x0 = x1 - w; else x1 = x0 + w;
      if (g.handle.includes('n')) y0 = y1 - h; else y1 = y0 + h;
    }
    const mid = { x: (Math.min(x0, x1) + Math.max(x0, x1)) / 2, y: (Math.min(y0, y1) + Math.max(y0, y1)) / 2 };
    const turned = { x: centre.x + (mid.x - centre.x) * Math.cos(a) - (mid.y - centre.y) * Math.sin(a), y: centre.y + (mid.x - centre.x) * Math.sin(a) + (mid.y - centre.y) * Math.cos(a) };
    o.x = turned.x - w / 2;
    o.y = turned.y - h / 2;
    o.w = w;
    o.h = h;
    if (o.kind === 'path' && s.subpaths) o.subpaths = scaleSubpaths(s.subpaths, w / s.w, h / s.h);
    if (o.kind === 'group' && s.children) { o.children = s.children; fitGroup(o); }
    if (x1 < x0 && o.kind === 'line') o.direction = o.direction === 'up' ? 'down' : 'up';
    g.moved = true;
    this.refitConnectors();
    this.host.redraw();
  }

  up(event) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.extras = {};
    if (g.kind === 'band') {
      const b = box(g.origin, g.current);
      if (b.w > 4 && b.h > 4) {
        for (const o of this.objects()) {
          const ob = outerBox(o);
          if (ob.x >= b.x && ob.y >= b.y && ob.x + ob.w <= b.x + b.w && ob.y + ob.h <= b.y + b.h) this.selection.add(o.id);
        }
        this.host.selectionChanged?.();
      }
    } else if (g.kind === 'draw') {
      this.drawUp(g, event);
      return;
    } else if (g.kind === 'node' && g.moved) {
      const o = this.find(g.id);
      if (o) fitPathBox(o);
      this.host.commit(g.before);
    } else if (g.moved) {
      this.host.commit(g.before);
    }
    this.host.redraw();
  }

  doubleClick(event) {
    if (event.target?.closest?.('.editing, [contenteditable="true"]')) return;
    if (this.pendingPath) {
      this.finishPath();
      return;
    }
    const hit = hitTarget(event.target);
    const point = this.host.toPage(event.clientX, event.clientY);
    if (hit.kind === 'object') {
      const o = this.find(hit.id);
      if (o?.kind === 'group') {
        // Into the group, as Enter Group does.
        this.enterGroup(o.id);
        return;
      }
    }
    this.host.doubleClick?.(hit, point, event);
  }

  // Drawing new objects

  startDrawing(point, event) {
    const tool = this.tool;
    const p = this.snapPoint(point);
    if (['polygon', 'curve'].includes(tool.kind)) {
      if (!this.pendingPath) this.pendingPath = { points: [p], hover: p, controls: [] };
      else {
        const last = this.pendingPath.points[this.pendingPath.points.length - 1];
        this.pendingPath.points.push(tool.at45 ? at45(last, p) : p);
      }
      this.gesture = { kind: 'draw', tool, origin: p, current: p, path: true };
      this.host.redraw();
      return;
    }
    this.gesture = { kind: 'draw', tool, origin: p, current: p, points: [p], before: this.host.snapshot(), from: tool.kind === 'connector' ? this.glueNear(point) : null, shift: event.shiftKey };
  }

  drawMove(g, point, event) {
    const p = this.snapPoint(point);
    if (g.path) {
      // Dragging while laying out a curve pulls a handle from the point just placed.
      if (g.tool.kind === 'curve') this.pendingPath.controls[this.pendingPath.points.length - 1] = point;
      this.host.redraw();
      return;
    }
    g.current = event.shiftKey && ['line', 'connector'].includes(g.tool.kind) ? at45(g.origin, p) : p;
    if (g.tool.kind === 'freeform') g.points.push(point);
    this.extras.preview = { tool: g.tool, from: g.origin, to: g.current, points: g.points };
    this.host.redraw();
  }

  drawUp(g, event) {
    if (g.path) { this.host.redraw(); return; }
    const tool = g.tool;
    let b = box(g.origin, g.current);
    const clicked = b.w < DRAG && b.h < DRAG;
    if (clicked && tool.kind !== 'shape' && tool.kind !== 'text') { this.useTool(null); return; }
    if (clicked) b = { x: g.origin.x - 80, y: g.origin.y - 50, w: 160, h: 100 };
    let created = null;
    if (tool.kind === 'shape') {
      if (insertedSquare(tool.type) || event.shiftKey) { const side = Math.max(b.w, b.h); b = { ...b, w: side, h: side }; }
      created = { kind: 'shape', shape: tool.type, ...b };
    } else if (tool.kind === 'line') {
      created = { kind: 'path', x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1), subpaths: [{ closed: false, nodes: [{ x: g.origin.x - b.x, y: g.origin.y - b.y }, { x: g.current.x - b.x, y: g.current.y - b.y }] }], ...(tool.arrow ? { line: { end: 'arrow' } } : {}) };
    } else if (tool.kind === 'freeform') {
      const nodes = smoothPoints(g.points, tool.filled);
      created = { kind: 'path', x: 0, y: 0, w: 1, h: 1, subpaths: [{ closed: Boolean(tool.filled), nodes }] };
      fitPathBox(created);
    } else if (tool.kind === 'scene3d') {
      if (clicked || event.shiftKey) { const side = Math.max(b.w, b.h); b = { ...b, w: side, h: side }; }
      created = { kind: 'scene3d', solid: tool.solid, ...b, rotX: 20, rotY: -30, rotZ: 0, color: '#729fcf', depth: 0.3 };
    } else if (tool.kind === 'connector') {
      created = { kind: 'connector', ...b, from: g.from, to: this.glueNear(g.current), routing: tool.routing ?? 'standard' };
    } else {
      created = this.host.create?.(tool, b) ?? null;
    }
    if (created) {
      created.id ??= this.host.makeId();
      created.rotation ??= 0;
      const added = this.addObject(created);
      if (added.kind === 'connector') fitConnector(added, this.objects());
      this.selection = new Set([added.id]);
      this.host.commit(g.before);
      this.host.selectionChanged?.();
    }
    this.useTool(null);
  }

  /** Ends a polygon or a curve being laid out: a double click, or Enter. */
  finishPath() {
    const pending = this.pendingPath;
    if (!pending) return;
    const tool = this.tool;
    this.pendingPath = null;
    const points = pending.points.filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1);
    if (points.length >= 2) {
      const before = this.host.snapshot();
      const nodes = points.map((p, i) => {
        const c = pending.controls[i];
        if (tool.kind !== 'curve' || !c) return { x: p.x, y: p.y };
        return { x: p.x, y: p.y, out: { x: c.x, y: c.y }, in: { x: 2 * p.x - c.x, y: 2 * p.y - c.y } };
      });
      const created = { id: this.host.makeId(), kind: 'path', x: 0, y: 0, w: 1, h: 1, rotation: 0, subpaths: [{ closed: Boolean(tool.filled), nodes }] };
      fitPathBox(created);
      const added = this.addObject(created);
      this.selection = new Set([added.id]);
      this.host.commit(before);
      this.host.selectionChanged?.();
    }
    this.useTool(null);
  }

  // Glue points

  /** The glue point under a page point, on any object but the one named. */
  glueNear(point, except = null, room = 12) {
    let best = null;
    for (const o of this.objects()) {
      if (o.id === except || o.kind === 'connector') continue;
      gluePoints(o).forEach((g, i) => {
        const d = Math.hypot(g.x - point.x, g.y - point.y);
        if (d <= room && (!best || d < best.d)) best = { id: o.id, glue: i, d };
      });
    }
    return best ? { id: best.id, glue: best.glue } : null;
  }

  addGlue(id, point) {
    const o = this.find(id);
    if (!o) return;
    const before = this.host.snapshot();
    const local = toLocal(o, point);
    o.glue = [...(o.glue ?? []), { x: Math.min(1, Math.max(0, local.x / o.w)), y: Math.min(1, Math.max(0, local.y / o.h)) }];
    this.host.commit(before);
    this.host.redraw();
  }

  /** Keeps connectors on the glue points they hang on as their objects move. */
  refitConnectors() {
    const all = this.objects();
    for (const o of all) if (o.kind === 'connector' && (o.from || o.to)) fitConnector(o, all);
  }

  // Keyboard

  /**
   * Arrows move the chosen, Tab goes from object to object, Delete takes them away, Escape lets go; Enter ends a polygon.
   * @returns {boolean} whether the key was the layer's
   */
  key(event) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target?.isContentEditable) return false;
    if (event.key === 'Escape') {
      if (this.tool || this.pendingPath) { this.pendingPath = null; this.useTool(null); return true; }
      if (this.scope.length && !this.selection.size) { this.exitGroup(); return true; }
      if (this.mode !== 'select') { this.mode = 'select'; this.host.redraw(); return true; }
      if (this.selection.size) { this.select([]); return true; }
      return false;
    }
    if (event.key === 'Enter' && this.pendingPath) { this.finishPath(); return true; }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) {
      const list = [...this.objects()].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      if (!list.length) return false;
      const current = list.findIndex((o) => this.selection.has(o.id));
      const next = (current + (event.shiftKey ? -1 : 1) + list.length) % list.length;
      this.select([list[current < 0 ? (event.shiftKey ? list.length - 1 : 0) : next].id]);
      this.host.announce?.(objectLabel(list[current < 0 ? 0 : next]));
      return true;
    }
    const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (steps && this.selection.size && !event.ctrlKey && !event.metaKey) {
      const unit = event.altKey ? 1 : (this.host.grid?.()?.step || 10);
      const before = this.host.snapshot();
      for (const o of this.chosen()) {
        if (o.protect?.position) continue;
        o.x += steps[0] * unit;
        o.y += steps[1] * unit;
      }
      this.refitConnectors();
      this.host.commit(before);
      this.host.redraw();
      return true;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.mode === 'points' && this.activeNode) {
      const { id, sub, index } = this.activeNode;
      const o = this.find(id);
      const nodes = o?.subpaths?.[sub]?.nodes;
      if (nodes && nodes.length > 2) {
        const before = this.host.snapshot();
        nodes.splice(index, 1);
        fitPathBox(o);
        this.activeNode = null;
        this.host.commit(before);
        this.host.redraw();
      }
      return true;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selection.size) {
      const before = this.host.snapshot();
      this.removeObjects([...this.selection]);
      this.selection.clear();
      this.host.commit(before);
      this.host.selectionChanged?.();
      this.host.redraw();
      return true;
    }
    return false;
  }

  /** Alignment guides to other objects and to the page's centre lines. */
  guides(ids) {
    const all = this.objects();
    const moving = all.filter((o) => ids.includes(o.id)).map(outerBox);
    const still = all.filter((o) => !ids.includes(o.id)).map(outerBox);
    const page = this.host.page?.();
    const out = [];
    const near = 3;
    for (const m of moving) {
      const cx = m.x + m.w / 2;
      const cy = m.y + m.h / 2;
      if (page && Math.abs(cx - page.w / 2) <= near) out.push({ vertical: true, at: page.w / 2 });
      if (page && Math.abs(cy - page.h / 2) <= near) out.push({ vertical: false, at: page.h / 2 });
      for (const s of still) {
        for (const [a, b] of [[m.x, s.x], [cx, s.x + s.w / 2], [m.x + m.w, s.x + s.w]]) if (Math.abs(a - b) <= near) out.push({ vertical: true, at: b });
        for (const [a, b] of [[m.y, s.y], [cy, s.y + s.h / 2], [m.y + m.h, s.y + s.h]]) if (Math.abs(a - b) <= near) out.push({ vertical: false, at: b });
      }
    }
    return out.slice(0, 8);
  }

  // Handles and what is drawn over the page

  /** The handles and marks over the page, as positioned elements in page coordinates. */
  overlay(doc = document) {
    const nodes = [];
    const dot = (cls, x, y, data) => {
      const n = doc.createElement('div');
      n.className = cls;
      Object.assign(n.style, { left: `${x}px`, top: `${y}px` });
      for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) n.dataset[k] = String(v);
      nodes.push(n);
      return n;
    };
    for (const o of this.chosen()) {
      const frame = doc.createElement('div');
      frame.className = 'sel-frame';
      Object.assign(frame.style, { left: `${o.x}px`, top: `${o.y}px`, width: `${o.w}px`, height: `${o.h}px`, transform: o.rotation ? `rotate(${o.rotation}deg)` : '' });
      nodes.push(frame);
      if (this.mode === 'points' && o.kind === 'path') {
        o.subpaths.forEach((s, si) => s.nodes.forEach((n, i) => {
          const at = toPage(o, n);
          dot('handle handle-node', at.x, at.y, { handle: 'node', id: o.id, index: i, sub: si });
          for (const part of ['in', 'out']) {
            if (!n[part]) continue;
            const c = toPage(o, n[part]);
            dot('handle handle-control', c.x, c.y, { handle: 'node', id: o.id, index: i, sub: si, part });
          }
        }));
        continue;
      }
      if (o.kind === 'connector') {
        const all = this.objects();
        const ends = [{ which: 'from', p: { x: o.x, y: o.y } }, { which: 'to', p: { x: o.x + o.w, y: o.y + o.h } }];
        for (const e of ends) {
          const glued = o[e.which] && all.find((x) => x.id === o[e.which].id);
          const at = glued ? (gluePoints(glued)[o[e.which].glue] ?? e.p) : e.p;
          dot('handle handle-end', at.x, at.y, { handle: 'end', id: o.id, part: e.which });
        }
        continue;
      }
      const c = corners(o);
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const places = { nw: c[0], n: mid(c[0], c[1]), ne: c[1], e: mid(c[1], c[2]), se: c[2], s: mid(c[2], c[3]), sw: c[3], w: mid(c[3], c[0]) };
      if (!o.protect?.size) for (const name of HANDLES) dot(`handle handle-${name}`, places[name].x, places[name].y, { handle: name, id: o.id });
      if (this.chosen().length === 1) {
        const top = toPage(o, { x: o.w / 2, y: -36 });
        dot('handle handle-rotate', top.x, top.y, { handle: 'rotate', id: o.id });
        if (o.kind === 'shape') {
          const definition = o.shape === 'custom' ? o.geometry : presetDefinition(o.shape);
          if (definition) {
            for (const h of shapeGeometry(definition, o.w, o.h, o.mods).handles) {
              const at = toPage(o, h);
              dot('handle handle-adjust', at.x, at.y, { handle: 'adjust', id: o.id, index: h.index });
            }
          }
        }
      }
    }
    if (this.mode === 'glue') {
      for (const o of this.objects()) {
        const own = gluePoints(o);
        const added = (o.glue ?? []).length;
        own.forEach((g, i) => {
          const isOwn = i >= own.length - added;
          dot(`handle handle-glue${isOwn ? ' own' : ''}`, g.x, g.y, isOwn ? { handle: 'glue', id: o.id, index: i - (own.length - added) } : {});
        });
      }
    }
    if (this.extras.rubberBand) {
      const b = this.extras.rubberBand;
      const n = doc.createElement('div');
      n.className = 'rubber-band';
      Object.assign(n.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
      nodes.push(n);
    }
    const page = this.host.page?.() ?? { w: 0, h: 0 };
    for (const line of this.host.snapLines?.() ?? []) {
      const n = doc.createElement('div');
      n.className = `snap-guide ${line.vertical ? 'vertical' : 'horizontal'}`;
      Object.assign(n.style, line.vertical ? { left: `${line.at}px` } : { top: `${line.at}px` });
      nodes.push(n);
    }
    for (const guide of this.extras.guides ?? []) {
      const n = doc.createElement('div');
      n.className = `guide ${guide.vertical ? 'vertical' : 'horizontal'}`;
      Object.assign(n.style, guide.vertical ? { left: `${guide.at}px`, top: '0px', height: `${page.h}px` } : { top: `${guide.at}px`, left: '0px', width: `${page.w}px` });
      nodes.push(n);
    }
    const preview = this.previewSvg();
    if (preview) {
      const n = doc.createElement('div');
      n.className = 'draw-preview';
      n.innerHTML = preview;
      nodes.push(n);
    }
    return nodes;
  }

  /** What a tool would draw, while it draws. */
  previewSvg() {
    const page = this.host.page?.() ?? { w: 1, h: 1 };
    const svg = (d) => `<svg width="${page.w}" height="${page.h}" style="position:absolute;left:0;top:0;overflow:visible;pointer-events:none"><path d="${d}" fill="none" stroke="#1f6feb" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`;
    if (this.pendingPath) {
      const pts = [...this.pendingPath.points, this.pendingPath.hover];
      return svg(pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(''));
    }
    const p = this.extras.preview;
    if (!p) return null;
    if (p.tool.kind === 'freeform') return svg(p.points.map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.y}`).join(''));
    if (p.tool.kind === 'line' || p.tool.kind === 'connector') return svg(`M${p.from.x} ${p.from.y}L${p.to.x} ${p.to.y}`);
    const b = box(p.from, p.to);
    if (p.tool.kind === 'shape') {
      const definition = presetDefinition(p.tool.type);
      if (definition && b.w > 1 && b.h > 1) {
        const { paths } = shapeGeometry(definition, b.w, b.h);
        return svg(subpathsData([]) + paths.map((path) => path.segments.map((s) => (s.type === 'Z' ? 'Z' : s.type === 'C' ? `C${s.c1.x + b.x} ${s.c1.y + b.y} ${s.c2.x + b.x} ${s.c2.y + b.y} ${s.to.x + b.x} ${s.to.y + b.y}` : `${s.type}${s.to.x + b.x} ${s.to.y + b.y}`)).join('')).join(''));
      }
    }
    return svg(`M${b.x} ${b.y}h${b.w}v${b.h}h${-b.w}z`);
  }

  destroy() {
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
  }
}
