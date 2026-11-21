/** Mind maps: a child with Tab, a sibling with Enter, laid out from the root to the right; a list becomes a map and a map a list. */

const GAP_X = 60;
const GAP_Y = 18;
const MAX_DEPTH = 64;

/** The node a node hangs from: the first connector that arrives at it. */
export function parentOf(model, id) {
  return model.edges.find((e) => e.to === id && model.node(e.from))?.from ?? null;
}

/** The nodes that hang from one, in the order their connectors were made. */
export function childrenOf(model, id) {
  return model.edges.filter((e) => e.from === id && model.node(e.to) && parentOf(model, e.to) === id).map((e) => e.to);
}

/** The top of the map a node is in, going up until nothing points down to it; a loop stops it. */
export function rootOf(model, id) {
  const seen = new Set([id]);
  let current = id;
  for (let parent = parentOf(model, current); parent && !seen.has(parent); parent = parentOf(model, current)) {
    seen.add(parent);
    current = parent;
  }
  return current;
}

const widthFor = (text) => Math.min(260, Math.max(90, [...String(text ?? '')].length * 8 + 30));

/** A child of a node, joined to it by a curved connector, its words still to type. */
export function addChild(model, id, text = '') {
  const parent = model.node(id);
  if (!parent) return null;
  const node = model.addNode({ x: parent.x + parent.w + GAP_X, y: parent.y, w: widthFor(text), h: 40, text, shape: 'round-rectangle' });
  model.addEdge({ from: id, to: node.id, routing: 'curved' });
  return node.id;
}

/** A sibling just after a node, from the same parent; a root's sibling is a new root under it. */
export function addSibling(model, id, text = '') {
  const parent = parentOf(model, id);
  const self = model.node(id);
  if (!self) return null;
  if (!parent) return model.addNode({ x: self.x, y: self.y + self.h + GAP_Y * 3, w: widthFor(text), h: 40, text, shape: 'round-rectangle' }).id;
  const made = addChild(model, parent, text);
  // The new connector goes just after the node's own, so the sibling comes right after it.
  const edge = model.edges.pop();
  const at = model.edges.findIndex((e) => e.from === parent && e.to === id);
  model.edges.splice(at + 1, 0, edge);
  return made;
}

/** Lays out the map a node belongs to: children to the right of their parent, stacked, the parent at their middle; the root stays where it is. */
export function mindMapLayout(model, anyId) {
  const root = rootOf(model, anyId);
  const top = model.node(root);
  if (!top) return;
  const placed = new Map();
  let cursor = 0;
  const place = (id, x, depth) => {
    const node = model.node(id);
    if (placed.has(id) || depth > MAX_DEPTH) return null;
    placed.set(id, null);
    const kids = childrenOf(model, id).filter((k) => !placed.has(k));
    const right = x + node.w + GAP_X;
    const centres = kids.map((k) => place(k, right, depth + 1)).filter((c) => c !== null);
    let y;
    if (!centres.length) { y = cursor; cursor += node.h + GAP_Y; } else y = (centres[0] + centres[centres.length - 1]) / 2 - node.h / 2;
    placed.set(id, { x, y });
    return y + node.h / 2;
  };
  place(root, top.x, 0);
  const shift = top.y - placed.get(root).y;
  for (const [id, p] of placed) {
    const node = model.node(id);
    if (p && node) { node.x = Math.round(p.x); node.y = Math.round(p.y + shift); }
  }
  model.dirty = true;
}

/** A list as Notes writes one, indented with spaces or tabs, as a map document: one root for the first top line, or one called Map for several. */
export function listToMap(text) {
  const lines = String(text).split(/\r?\n/).slice(0, 5000)
    .map((line) => ({ depth: Math.floor(line.replace(/\t/g, '    ').match(/^ */)[0].length / 2), text: line.trim().replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '') }))
    .filter((line) => line.text);
  const nodes = [];
  const edges = [];
  const stack = [];
  const base = Math.min(...lines.map((x) => x.depth));
  let rootId = null;
  if (lines.filter((l) => l.depth === base).length > 1) { rootId = 'n0'; nodes.push({ id: rootId, text: 'Map', shape: 'round-rectangle', w: 100, h: 40, x: 0, y: 0, data: {} }); }
  lines.forEach((line, i) => {
    const id = `n${i + 1}`;
    nodes.push({ id, text: line.text.slice(0, 500), shape: 'round-rectangle', w: widthFor(line.text), h: 40, x: 0, y: 0, data: {} });
    const depth = line.depth - base;
    stack.length = Math.min(stack.length, depth);
    const parent = stack[stack.length - 1] ?? rootId;
    if (parent) edges.push({ id: `e${edges.length + 1}`, from: parent, to: id, fromPort: 'auto', toPort: 'auto', routing: 'curved', label: '', waypoints: [], data: {} });
    stack.push(id);
  });
  const doc = { version: 1, type: 'graphs', nodes, edges, meta: { gridSize: 10, snapToGrid: false } };
  // Laid out here, from its one root, so the map arrives arranged.
  if (nodes.length) mindMapLayout({ nodes, edges, node: (id) => nodes.find((n) => n.id === id) ?? null }, nodes[0].id);
  return doc;
}

/** The map from a node down as a Markdown list, children indented under their parent. */
export function mapToList(model, id) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (seen.has(node) || depth > MAX_DEPTH || out.length >= 5000) return;
    seen.add(node);
    out.push(`${'  '.repeat(depth)}- ${String(model.node(node)?.text ?? '').replace(/\s+/g, ' ').trim()}`);
    for (const child of childrenOf(model, node)) walk(child, depth + 1);
  };
  walk(rootOf(model, id), 0);
  return `${out.join('\n')}\n`;
}
