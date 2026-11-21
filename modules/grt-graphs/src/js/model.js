/** The graph, independent of how it is drawn. */

import { makeId } from './ids.js';
import { cleanComments, newComment, COMMENT_LIMITS } from './core/comments.js';
import { presetDefinition } from './core/draw/geometry.js';
import { cleanDrawing } from './core/draw/objects.js';

export const FORMAT_VERSION = 1;
export const PORTS = ['auto', 'top', 'right', 'bottom', 'left'];
export const ROUTINGS = ['orthogonal', 'straight', 'curved'];
/** The shape palette of the toolbar; every shape of LibreOffice's menus can be a node's too. */
export const SHAPES = [
  'rectangle', 'round-rectangle', 'ellipse', 'diamond', 'parallelogram', 'hexagon', 'isosceles-triangle',
];

/** Graphs' first shape names, read from older files as LibreOffice's. */
const LEGACY = { rect: 'rectangle', rounded: 'round-rectangle', triangle: 'isosceles-triangle' };

/** A node's shape as LibreOffice names it; anything unknown is a rectangle. */
export const nodeShape = (name) => LEGACY[name] ?? (presetDefinition(name) ? name : 'rectangle');

/** The text looks a node or text box can carry, as Format, Text sets them on the whole of its text. */
export const TEXT_MARKS = ['bold', 'italic', 'underline', 'double', 'strike', 'overline', 'sup', 'sub', 'shadow', 'outline', 'smallcaps'];

/** A node's text look, cleaned: marks, size, colour, font, alignment, spacing, list. */
export function cleanTextLook(look) {
  if (!look || typeof look !== 'object') return undefined;
  const out = {};
  for (const mark of TEXT_MARKS) if (look[mark]) out[mark] = true;
  if (Number.isFinite(look.size) && look.size >= 4 && look.size <= 400) out.size = look.size;
  if (typeof look.color === 'string' && /^#[0-9a-f]{6}$/i.test(look.color)) out.color = look.color.toLowerCase();
  if (typeof look.font === 'string' && look.font.length <= 100) out.font = look.font;
  if (['left', 'center', 'right', 'justify'].includes(look.align)) out.align = look.align;
  if (['top', 'middle', 'bottom'].includes(look.valign)) out.valign = look.valign;
  if (Number.isFinite(look.lineSpacing) && look.lineSpacing >= 0.5 && look.lineSpacing <= 5) out.lineSpacing = look.lineSpacing;
  if (Number.isFinite(look.paraSpacing) && look.paraSpacing >= 0 && look.paraSpacing <= 200) out.paraSpacing = look.paraSpacing;
  if (Number.isFinite(look.indent) && look.indent >= 0 && look.indent <= 500) out.indent = look.indent;
  if (['bullet', 'number'].includes(look.list)) out.list = look.list;
  return Object.keys(out).length ? out : undefined;
}

/** A page of the drawing: its nodes, edges, drawing objects and comments. */
const newPage = (name, n) => ({ id: makeId('p'), name: name || `Page ${n}`, nodes: [], edges: [], objects: [], comments: [] });

const DEFAULT_STYLES = {
  default: { fill: '#ffffff', stroke: '#333333', strokeWidth: 2 },
  accent: { fill: '#e8f0fe', stroke: '#1f6feb', strokeWidth: 2 },
  warn: { fill: '#fff4e5', stroke: '#b26a00', strokeWidth: 2 },
};

export class GraphModel {
  constructor(document = null) {
    this.pages = [newPage('', 1)];
    this.current = 0;
    this.styles = structuredClone(DEFAULT_STYLES);
    this.meta = { gridSize: 10, snapToGrid: true };
    this.path = null;
    this.dirty = false;

    if (document) this.load(document);
  }

  // Pages: what the program shows is the current page; nodes, edges, objects and comments are that page's.

  get page() { return this.pages[this.current] ?? this.pages[0]; }

  get nodes() { return this.page.nodes; }

  set nodes(list) { this.page.nodes = list; }

  get edges() { return this.page.edges; }

  set edges(list) { this.page.edges = list; }

  get objects() { return this.page.objects; }

  set objects(list) { this.page.objects = list; }

  /** Page, New Page: after the current one, which it becomes. */
  addPage(name = '') {
    this.pages.splice(this.current + 1, 0, newPage(name, this.pages.length + 1));
    this.current += 1;
    this.dirty = true;
    return this.page;
  }

  /** Page, Duplicate Page: a copy with new ids after the current one. */
  duplicatePage() {
    const copy = structuredClone(this.page);
    const ids = new Map();
    copy.id = makeId('p');
    copy.name = `${this.page.name} (copy)`;
    for (const node of copy.nodes) { const id = makeId('n'); ids.set(node.id, id); node.id = id; }
    for (const edge of copy.edges) { edge.id = makeId('e'); edge.from = ids.get(edge.from) ?? edge.from; edge.to = ids.get(edge.to) ?? edge.to; }
    for (const object of copy.objects) object.id = makeId('o');
    this.pages.splice(this.current + 1, 0, copy);
    this.current += 1;
    this.dirty = true;
    return copy;
  }

  /** Page, Delete Page: never the last one. */
  deletePage() {
    if (this.pages.length <= 1) return false;
    this.pages.splice(this.current, 1);
    this.current = Math.min(this.current, this.pages.length - 1);
    this.dirty = true;
    return true;
  }

  renamePage(name) {
    const clean = String(name ?? '').trim().slice(0, 200);
    if (!clean) return;
    this.page.name = clean;
    this.dirty = true;
  }

  /** Moves the current page by a step, or to the start or the end. */
  movePage(to) {
    const from = this.current;
    const target = to === 'first' ? 0 : to === 'last' ? this.pages.length - 1 : Math.max(0, Math.min(this.pages.length - 1, from + to));
    if (target === from) return;
    const [page] = this.pages.splice(from, 1);
    this.pages.splice(target, 0, page);
    this.current = target;
    this.dirty = true;
  }

  goToPage(index) {
    if (index >= 0 && index < this.pages.length) this.current = index;
  }

  // Drawing objects

  addObject(object) {
    const created = { ...object, ...cleanDrawing(object), id: object.id ?? makeId('o'), rotation: object.rotation ?? 0, z: object.z ?? this.objects.reduce((top, o) => Math.max(top, o.z ?? 0), 0) + 1 };
    this.objects.push(created);
    this.dirty = true;
    return created;
  }

  deleteObjects(ids) {
    const doomed = new Set(ids);
    this.objects = this.objects.filter((o) => !doomed.has(o.id));
    this.dirty = true;
  }

  // Nodes

  addNode({ x, y, w = 160, h = 60, text = '', shape = 'rectangle', style = 'default', data = {} }) {
    const node = {
      id: makeId('n'),
      shape: nodeShape(shape),
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

  setShape(ids, name) {
    const shape = nodeShape(name);
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
      // The first page's nodes and edges stay where older versions look for them.
      nodes: structuredClone(this.pages[0].nodes),
      edges: structuredClone(this.pages[0].edges),
      pages: structuredClone(this.pages),
      styles: structuredClone(this.styles),
      meta: structuredClone(this.meta),
    };
  }

  load(document) {
    if (!document || typeof document !== 'object') {
      throw new Error('Not a graph document');
    }

    this.styles = document.styles ? structuredClone(document.styles) : structuredClone(DEFAULT_STYLES);
    this.meta = { gridSize: 10, snapToGrid: true, ...(document.meta ?? {}) };
    const pages = Array.isArray(document.pages) && document.pages.length
      ? structuredClone(document.pages.slice(0, 1000))
      : [{ nodes: Array.isArray(document.nodes) ? structuredClone(document.nodes) : [], edges: Array.isArray(document.edges) ? structuredClone(document.edges) : [], comments: this.meta.comments }];
    delete this.meta.comments;
    this.pages = pages.map((p, i) => ({
      id: typeof p.id === 'string' ? p.id : makeId('p'),
      name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 200) : `Page ${i + 1}`,
      nodes: Array.isArray(p.nodes) ? p.nodes : [],
      edges: Array.isArray(p.edges) ? p.edges : [],
      objects: (Array.isArray(p.objects) ? p.objects : []).map((o) => ({ ...o, ...cleanDrawing(o), id: typeof o.id === 'string' ? o.id : makeId('o') })),
      comments: cleanComments(p.comments),
    }));
    this.current = 0;
    for (const page of this.pages) this.cleanPage(page);
    this.dirty = false;
  }

  /** Fills in what a page's nodes and edges lack, rather than refusing them; what must be text is made text. */
  cleanPage(page) {
    for (const node of page.nodes) {
      node.shape = node.shape === 'custom' && node.geometry?.path ? 'custom' : nodeShape(node.shape);
      if (node.shape !== 'custom') delete node.geometry;
      const look = cleanTextLook(node.textLook);
      if (look) node.textLook = look; else delete node.textLook;
      node.id ??= makeId('n');
      node.style ??= 'default';
      node.text = typeof node.text === 'string' ? node.text : String(node.text ?? '');
      if (typeof node.link !== 'string' || node.link === '') delete node.link;
      else node.link = node.link.slice(0, 2048);
      node.data ??= {};
      // A place and size from a file are numbers, so nothing else reaches the drawing's markup through them.
      for (const [key, fallback] of [['x', 0], ['y', 0], ['w', 160], ['h', 60], ['rotation', 0]]) {
        if (key === 'rotation' && !('rotation' in node)) continue;
        const value = Number(node[key] ?? fallback);
        node[key] = Number.isFinite(value) ? value : fallback;
      }
      const { shape: _shape, ...drawn } = cleanDrawing({ ...node, kind: 'shape' });
      Object.assign(node, drawn);
    }
    for (const edge of page.edges) {
      edge.id ??= makeId('e');
      edge.fromPort ??= 'auto';
      edge.toPort ??= 'auto';
      edge.routing ??= 'orthogonal';
      edge.label = typeof edge.label === 'string' ? edge.label : String(edge.label ?? '');
      edge.waypoints = (Array.isArray(edge.waypoints) ? edge.waypoints : []).slice(0, 1000)
        .filter((p) => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y))).map((p) => ({ x: Number(p.x), y: Number(p.y) }));
      edge.data ??= {};
    }
  }

  // Links and comments

  /** Gives nodes a link; an empty address takes it away. */
  setLink(ids, href) {
    const clean = String(href ?? '').trim().slice(0, 2048);
    for (const node of this.nodes) {
      if (!ids.includes(node.id)) continue;
      if (clean) node.link = clean;
      else delete node.link;
    }
    this.dirty = true;
  }

  get comments() {
    return this.page.comments ?? [];
  }

  /** A comment on the page, at a place; who wrote it is not kept. */
  addComment({ x, y, text }) {
    const comment = newComment({ x, y, text });
    this.page.comments = [...this.comments, comment].slice(-COMMENT_LIMITS.count);
    this.dirty = true;
    return comment;
  }

  setComment(id, text) {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return;
    if (String(text ?? '').trim() === '') return this.deleteComment(id);
    comment.text = String(text).slice(0, COMMENT_LIMITS.text);
    this.dirty = true;
  }

  deleteComment(id) {
    this.page.comments = this.comments.filter((c) => c.id !== id);
    this.dirty = true;
  }

  // Undo

  snapshot() {
    return {
      pages: structuredClone(this.pages),
      current: this.current,
      styles: structuredClone(this.styles),
      meta: structuredClone(this.meta),
      dirty: this.dirty,
    };
  }

  restore(snapshot) {
    this.pages = structuredClone(snapshot.pages);
    this.current = Math.min(snapshot.current ?? 0, this.pages.length - 1);
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
