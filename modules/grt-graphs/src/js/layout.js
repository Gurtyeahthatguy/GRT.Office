/** Automatic arrangement. */

const GAP_X = 60;
const GAP_Y = 90;

/**
 * Positions for a tree layout, without touching the model.
 * @param {GraphModel} model
 * @param {{horizontal?: boolean}} [options]
 * @returns {Map<string, {x: number, y: number}>}
 */
export function treeLayout(model, options = {}) {
  const positions = new Map();
  if (model.nodes.length === 0) return positions;

  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const children = new Map(model.nodes.map((n) => [n.id, []]));
  const hasParent = new Set();

  for (const edge of model.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (edge.from === edge.to) continue;          // a self-loop is not a parent link.
    children.get(edge.from).push(edge.to);
    hasParent.add(edge.to);
  }

  // Nodes nothing points at are the roots.
  let roots = model.nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  if (roots.length === 0) roots = [model.nodes[0].id];

  const placed = new Set();
  let cursor = 0;

  // Two passes over each subtree.
  const place = (id, depth) => {
    if (placed.has(id)) return null;
    placed.add(id);

    const node = byId.get(id);
    const kids = children.get(id).filter((child) => !placed.has(child));

    if (kids.length === 0) {
      const x = cursor;
      cursor += node.w + GAP_X;
      positions.set(id, { x, y: depth * GAP_Y });
      return x + node.w / 2;
    }

    const centres = [];
    for (const child of kids) {
      const centre = place(child, depth + 1);
      if (centre !== null) centres.push(centre);
    }

    if (centres.length === 0) {
      const x = cursor;
      cursor += node.w + GAP_X;
      positions.set(id, { x, y: depth * GAP_Y });
      return x + node.w / 2;
    }

    const middle = (Math.min(...centres) + Math.max(...centres)) / 2;
    positions.set(id, { x: middle - node.w / 2, y: depth * GAP_Y });
    return middle;
  };

  for (const root of roots) place(root, 0);

  // Anything left over is disconnected.
  const leftovers = model.nodes.filter((n) => !positions.has(n.id));
  if (leftovers.length > 0) {
    const depth = Math.max(0, ...[...positions.values()].map((p) => p.y / GAP_Y)) + 1;
    let x = 0;
    for (const node of leftovers) {
      positions.set(node.id, { x, y: depth * GAP_Y });
      x += node.w + GAP_X;
    }
  }

  if (options.horizontal) {
    for (const [id, point] of positions) {
      positions.set(id, { x: point.y, y: point.x });
    }
  }

  return positions;
}
