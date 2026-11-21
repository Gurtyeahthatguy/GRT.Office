/**
 * Containers: a node that holds the nodes drawn inside it, as JSON Canvas groups do; collapsed, it hides them and
 * the connectors to them arrive at it instead; moved, they go with it.
 */

const TITLE_HEIGHT = 40;

export const isContainer = (node) => node?.container === true;

/** The nodes a container holds: those wholly inside it while it is open, those it hid when it was closed. */
export function membersOf(model, container) {
  if (!isContainer(container)) return [];
  if (container.collapsed) return (container.members ?? []).map((id) => model.node(id)).filter(Boolean);
  return model.nodes.filter((n) => n !== container && !n.hidden && n.x >= container.x && n.y >= container.y
    && n.x + n.w <= container.x + container.w && n.y + n.h <= container.y + container.h);
}

/** The nodes that move when these move: each container's members, and theirs in turn. */
export function withMembers(model, ids) {
  const out = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    const node = model.node(queue.pop());
    for (const member of membersOf(model, node)) if (!out.has(member.id)) { out.add(member.id); queue.push(member.id); }
  }
  return [...out];
}

/** A container drawn round some nodes, or of a size of its own where nothing is chosen. */
export function makeContainer(model, ids, at = { x: 0, y: 0 }) {
  const nodes = ids.map((id) => model.node(id)).filter(Boolean);
  const pad = 24;
  const box = nodes.length
    ? { x: Math.min(...nodes.map((n) => n.x)) - pad, y: Math.min(...nodes.map((n) => n.y)) - pad - TITLE_HEIGHT, w: 0, h: 0 }
    : { x: at.x, y: at.y, w: 320, h: 220 };
  if (nodes.length) {
    box.w = Math.max(...nodes.map((n) => n.x + n.w)) + pad - box.x;
    box.h = Math.max(...nodes.map((n) => n.y + n.h)) + pad - box.y;
  }
  model.styles.container ??= { fill: 'none', stroke: '#7a8699', strokeWidth: 2 };
  const node = model.addNode({ ...box, text: 'Container', shape: 'rectangle', style: 'container' });
  node.container = true;
  node.textLook = { ...(node.textLook ?? {}), valign: 'top', bold: true };
  // Behind what it holds, so they stay pressable.
  model.nodes.splice(model.nodes.indexOf(node), 1);
  model.nodes.unshift(node);
  return node.id;
}

/** Closes a container: its members hidden, it shrunk to its title; opens it again as it was. */
export function toggleContainer(model, id) {
  const node = model.node(id);
  if (!isContainer(node)) return false;
  if (!node.collapsed) {
    const members = withMembers(model, [id]).filter((m) => m !== id);
    node.members = members;
    node.expandedSize = { w: node.w, h: node.h };
    for (const m of members) model.node(m).hidden = true;
    node.h = TITLE_HEIGHT;
    node.w = Math.min(node.w, 260);
    node.collapsed = true;
  } else {
    for (const m of node.members ?? []) { const member = model.node(m); if (member) delete member.hidden; }
    Object.assign(node, node.expandedSize ?? {});
    delete node.collapsed;
    delete node.members;
    delete node.expandedSize;
    // A container closed inside another that is still closed keeps its own members hidden.
    for (const inner of model.nodes.filter((n) => isContainer(n) && n.collapsed && n !== node)) for (const m of inner.members ?? []) { const member = model.node(m); if (member) member.hidden = true; }
  }
  model.dirty = true;
  return true;
}

/** Where a connector shows its end: at the node, or at the closed container hiding it; null when both ends are hidden in the same one. */
export function shownEnds(model, edge) {
  const visible = (id) => {
    let node = model.node(id);
    for (let guard = 0; node?.hidden && guard < 64; guard += 1) {
      node = model.nodes.find((c) => isContainer(c) && c.collapsed && !c.hidden && (c.members ?? []).includes(node.id))
        ?? model.nodes.find((c) => isContainer(c) && c.collapsed && (c.members ?? []).includes(node.id));
    }
    return node && !node.hidden ? node : null;
  };
  const from = visible(edge.from);
  const to = visible(edge.to);
  if (!from || !to || (from === to && edge.from !== edge.to)) return null;
  return { from, to };
}
