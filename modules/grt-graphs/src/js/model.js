/** The graph, independent of how it is drawn. */

import { makeId } from './ids.js';

export const FORMAT_VERSION = 1;
export const PORTS = ['auto', 'top', 'right', 'bottom', 'left'];
export const ROUTINGS = ['orthogonal', 'straight', 'curved'];
/** The shape palette. */
export const SHAPES = [
  'rect', 'rounded', 'ellipse', 'diamond', 'parallelogram', 'hexagon', 'triangle',
];

const DEFAULT_STYLES = {
  default: { fill: '#ffffff', stroke: '#333333', strokeWidth: 2 },
  accent: { fill: '#e8f0fe', stroke: '#1f6feb', strokeWidth: 2 },
  warn: { fill: '#fff4e5', stroke: '#b26a00', strokeWidth: 2 },
};

export class GraphModel {
  constructor(document = null) {
    this.nodes = [];
    this.edges = [];
    this.styles = structuredClone(DEFAULT_STYLES);
    this.meta = { gridSize: 10, snapToGrid: true };
    this.path = null;
    this.dirty = false;

    if (document) this.load(document);
  }

  // Nodes

  addNode({ x, y, w = 160, h = 60, text = '', shape = 'rect', style = 'default', data = {} }) {
    const node = {
      id: makeId('n'),
      shape: SHAPES.includes(shape) ? shape : 'rect',
      x, y, w, h,
      text,
      style,
      data,
    };
    this.nodes.push(node);
    this.dirty = true;
    return node;
  }

  node(id) {
    return this.nodes.find((n) => n.id === id) ?? null;
  }

  /** Removes nodes and every edge touching them. */
  deleteNodes(ids) {
    const doomed = new Set(ids);
    this.nodes = this.nodes.filter((n) => !doomed.has(n.id));
    this.edges = this.edges.filter((e) => !doomed.has(e.from) && !doomed.has(e.to));
    this.dirty = true;
  }

  moveNodes(ids, dx, dy) {
    const moving = new Set(ids);
    for (const node of this.nodes) {
      if (!moving.has(node.id)) continue;
      node.x += dx;
      node.y += dy;
    }
    this.dirty = true;
  }

  setNodeBounds(id, bounds) {
    const node = this.node(id);
    if (!node) return;
    // A node small enough to be invisible cannot be grabbed again.
    node.x = bounds.x;
    node.y = bounds.y;
    node.w = Math.max(bounds.w, 20);
    node.h = Math.max(bounds.h, 20);
    this.dirty = true;
  }

  setText(id, text) {
    const node = this.node(id);
    if (!node) return;
    node.text = text;
    this.dirty = true;
  }

  setStyle(ids, style) {
    const chosen = new Set(ids);
    for (const node of this.nodes) {
      if (chosen.has(node.id)) node.style = style;
    }
    this.dirty = true;
  }

  setShape(ids, shape) {
    if (!SHAPES.includes(shape)) return;
    const chosen = new Set(ids);
    for (const node of this.nodes) {
      if (chosen.has(node.id)) node.shape = shape;
    }
    this.dirty = true;
  }

  /**
   * Lines up the given nodes on one edge or through their centres.
   * @param {string[]} ids
   * @param {'left'|'right'|'top'|'bottom'|'centre-x'|'centre-y'} how
   */
  alignNodes(ids, how) {
    const chosen = this.nodes.filter((n) => ids.includes(n.id));
    if (chosen.length < 2) return;

    const lefts = chosen.map((n) => n.x);
    const rights = chosen.map((n) => n.x + n.w);
    const tops = chosen.map((n) => n.y);
    const bottoms = chosen.map((n) => n.y + n.h);

    for (const node of chosen) {
      switch (how) {
        case 'left': node.x = Math.min(...lefts); break;
        case 'right': node.x = Math.max(...rights) - node.w; break;
        case 'top': node.y = Math.min(...tops); break;
        case 'bottom': node.y = Math.max(...bottoms) - node.h; break;
        case 'centre-x': {
          const middle = (Math.min(...lefts) + Math.max(...rights)) / 2;
          node.x = middle - node.w / 2;
          break;
        }
        case 'centre-y': {
          const middle = (Math.min(...tops) + Math.max(...bottoms)) / 2;
          node.y = middle - node.h / 2;
          break;
        }
        default: return;
      }
    }

    this.dirty = true;
  }

  /**
   * Spreads nodes so the gaps between them are equal.
   * @param {string[]} ids
   * @param {'horizontal'|'vertical'} axis
   */
  distributeNodes(ids, axis) {
    const chosen = this.nodes.filter((n) => ids.includes(n.id));
    if (chosen.length < 3) return;

    const horizontal = axis === 'horizontal';
    const size = (n) => (horizontal ? n.w : n.h);
    const get = (n) => (horizontal ? n.x : n.y);
    const set = (n, v) => { if (horizontal) n.x = v; else n.y = v; };

    const sorted = [...chosen].sort((a, b) => get(a) - get(b));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const span = (get(last) + size(last)) - get(first);
    const occupied = sorted.reduce((total, n) => total + size(n), 0);
    const gap = (span - occupied) / (sorted.length - 1);

    let cursor = get(first);
    for (const node of sorted) {
      set(node, cursor);
      cursor += size(node) + gap;
    }

    this.dirty = true;
  }

  // Edges

  /** Edges reference nodes by id, never by position. */
  addEdge({ from, to, fromPort = 'auto', toPort = 'auto', label = '', routing = 'orthogonal', data = {} }) {
    if (!this.node(from) || !this.node(to)) return null;

    const edge = {
      id: makeId('e'),
      from,
      to,
      fromPort,
      toPort,
      routing: ROUTINGS.includes(routing) ? routing : 'orthogonal',
      label,
      style: 'arrow',
      waypoints: [],
      data,
    };
    this.edges.push(edge);
    this.dirty = true;
    return edge;
  }

  edge(id) {
    return this.edges.find((e) => e.id === id) ?? null;
  }

  deleteEdges(ids) {
    const doomed = new Set(ids);
    this.edges = this.edges.filter((e) => !doomed.has(e.id));
    this.dirty = true;
  }

  /** Manual control always wins over the automatic router. */
  setWaypoints(id, waypoints) {
    const edge = this.edge(id);
    if (!edge) return;
    edge.waypoints = waypoints.map((p) => ({ x: p.x, y: p.y }));
    this.dirty = true;
  }

  setEdgeRouting(ids, routing) {
    if (!ROUTINGS.includes(routing)) return;
    const chosen = new Set(ids);
    for (const edge of this.edges) {
      if (chosen.has(edge.id)) {
        edge.routing = routing;
        // Switching mode discards hand-drawn points.
        edge.waypoints = [];
      }
    }
    this.dirty = true;
  }

  setEdgeLabel(id, label) {
    const edge = this.edge(id);
    if (!edge) return;
    edge.label = label;
    this.dirty = true;
  }

  // Whole document

  /** The document as it is stored. */
  toJSON() {
    return {
      version: FORMAT_VERSION,
      type: 'graphs',
      nodes: structuredClone(this.nodes),
      edges: structuredClone(this.edges),
      styles: structuredClone(this.styles),
      meta: structuredClone(this.meta),
    };
  }

  load(document) {
    if (!document || typeof document !== 'object') {
      throw new Error('Not a graph document');
    }

    this.nodes = Array.isArray(document.nodes) ? structuredClone(document.nodes) : [];
    this.edges = Array.isArray(document.edges) ? structuredClone(document.edges) : [];
    this.styles = document.styles ? structuredClone(document.styles) : structuredClone(DEFAULT_STYLES);
    this.meta = { gridSize: 10, snapToGrid: true, ...(document.meta ?? {}) };

    // Missing fields are filled in rather than rejected.
    for (const node of this.nodes) {
      node.id ??= makeId('n');
      node.shape ??= 'rect';
      node.style ??= 'default';
      node.text ??= '';
      node.data ??= {};
      node.w ??= 160;
      node.h ??= 60;
    }
    for (const edge of this.edges) {
      edge.id ??= makeId('e');
      edge.fromPort ??= 'auto';
      edge.toPort ??= 'auto';
      edge.routing ??= 'orthogonal';
      edge.label ??= '';
      edge.waypoints ??= [];
      edge.data ??= {};
    }

    this.dirty = false;
  }

  // Undo

  snapshot() {
    return {
      nodes: structuredClone(this.nodes),
      edges: structuredClone(this.edges),
      styles: structuredClone(this.styles),
      meta: structuredClone(this.meta),
      dirty: this.dirty,
    };
  }

  restore(snapshot) {
    this.nodes = structuredClone(snapshot.nodes);
    this.edges = structuredClone(snapshot.edges);
    this.styles = structuredClone(snapshot.styles);
    this.meta = structuredClone(snapshot.meta);
    this.dirty = snapshot.dirty;
  }

  // Validation

  /** Reports problems without refusing anything. */
  validate() {
    const ids = new Set(this.nodes.map((n) => n.id));

    const dangling = this.edges
      .filter((e) => !ids.has(e.from) || !ids.has(e.to))
      .map((e) => e.id);

    const reached = new Set();
    const targets = new Set(this.edges.map((e) => e.to));
    const roots = this.nodes.filter((n) => !targets.has(n.id)).map((n) => n.id);

    const queue = [...roots];
    while (queue.length > 0) {
      const current = queue.pop();
      if (reached.has(current)) continue;
      reached.add(current);
      for (const edge of this.edges) {
        if (edge.from === current && !reached.has(edge.to)) queue.push(edge.to);
      }
    }

    const unreachable = this.nodes
      .filter((n) => !reached.has(n.id))
      .map((n) => n.id);

    return {
      dangling,
      unreachable,
      // Every node being unreachable means every node is in a cycle, which is
      // perfectly valid for a state machine and worth naming rather than
      // reporting as a fault.
      cyclic: roots.length === 0 && this.nodes.length > 0,
    };
  }
}
