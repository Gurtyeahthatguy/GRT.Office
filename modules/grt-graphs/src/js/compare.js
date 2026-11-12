/** Comparing two diagrams: nodes and lines added, taken away and changed, matched by id and then by their text. */

const look = (node) => JSON.stringify([node.text, node.shape, node.style]);

/**
 * What changed from `other` (the older diagram) to `model` (this one).
 * @returns {{added: Set<string>, changed: Set<string>, moved: Set<string>, removed: Object[], addedEdges: Set<string>, changedEdges: Set<string>, removedEdges: Object[]}}
 */
export function compareDiagrams(model, other) {
  const theirs = (other.nodes ?? []).filter((n) => n && typeof n.id === 'string');
  const byId = new Map(theirs.map((n) => [n.id, n]));
  const pairs = new Map();
  for (const node of model.nodes) if (byId.has(node.id)) pairs.set(node.id, byId.get(node.id));
  // Nodes made again with new ids, as an import does, are matched by text when it is unique on both sides.
  const taken = new Set([...pairs.values()].map((n) => n.id));
  const count = (list, text) => list.filter((n) => n.text === text).length;
  for (const node of model.nodes) {
    if (pairs.has(node.id) || count(model.nodes, node.text) !== 1) continue;
    const match = theirs.find((n) => !taken.has(n.id) && n.text === node.text);
    if (match && count(theirs, node.text) === 1) {
      pairs.set(node.id, match);
      taken.add(match.id);
    }
  }
  const result = { added: new Set(), changed: new Set(), moved: new Set(), removed: [], addedEdges: new Set(), changedEdges: new Set(), removedEdges: [] };
  for (const node of model.nodes) {
    const old = pairs.get(node.id);
    if (!old) result.added.add(node.id);
    else if (look(old) !== look(node)) result.changed.add(node.id);
    else if (Math.abs(old.x - node.x) > 1 || Math.abs(old.y - node.y) > 1 || Math.abs(old.w - node.w) > 1 || Math.abs(old.h - node.h) > 1) result.moved.add(node.id);
  }
  result.removed = theirs.filter((n) => !taken.has(n.id) && ![...pairs.values()].includes(n));
  // Lines are matched by the nodes at their ends.
  const mine = new Map([...pairs].map(([id, old]) => [old.id, id]));
  const key = (from, to) => `${from}>${to}`;
  const theirEdges = new Map((other.edges ?? []).map((e) => [key(mine.get(e.from) ?? `?${e.from}`, mine.get(e.to) ?? `?${e.to}`), e]));
  const seen = new Set();
  for (const edge of model.edges) {
    const old = theirEdges.get(key(edge.from, edge.to));
    if (!old) result.addedEdges.add(edge.id);
    else {
      seen.add(key(edge.from, edge.to));
      if ((old.label ?? '') !== (edge.label ?? '') || (old.routing ?? 'orthogonal') !== (edge.routing ?? 'orthogonal')) result.changedEdges.add(edge.id);
    }
  }
  result.removedEdges = [...theirEdges].filter(([k]) => !seen.has(k)).map(([, e]) => e);
  return result;
}

export const isSame = (diff) => !diff.added.size && !diff.changed.size && !diff.moved.size && !diff.removed.length
  && !diff.addedEdges.size && !diff.changedEdges.size && !diff.removedEdges.length;
