/** A diagram as text, in Mermaid's flowchart language, both ways: written from the drawing, and read back into it. */

import { parseMermaid } from './mermaid.js';

const DELIMITERS = {
  rect: ['[', ']'], rounded: ['([', '])'], ellipse: ['((', '))'], diamond: ['{', '}'],
  parallelogram: ['[/', '/]'], hexagon: ['{{', '}}'], triangle: ['[', ']'],
};
const ARROW = { orthogonal: '-->', straight: '-->', curved: '-->' };

/** Text quoted when it holds what Mermaid would read as syntax. */
const label = (text) => (/^[\p{L}\p{N} _.,:;!?'’-]*$/u.test(text) ? text : `"${text.replace(/"/g, '#quot;')}"`);

/** Ids as Mermaid takes them; the diagram's own when they fit. */
function idsFor(model) {
  const ids = new Map();
  const used = new Set();
  model.nodes.forEach((node, i) => {
    let id = /^[A-Za-z_][\w-]{0,40}$/.test(node.id) ? node.id : `n${i + 1}`;
    while (used.has(id)) id = `${id}_`;
    used.add(id);
    ids.set(node.id, id);
  });
  return ids;
}

export function toMermaid(model) {
  const ids = idsFor(model);
  const lines = ['flowchart TD'];
  for (const node of model.nodes) {
    const [open, close] = DELIMITERS[node.shape] ?? DELIMITERS.rect;
    lines.push(`  ${ids.get(node.id)}${open}${label(node.text.replace(/\n/g, ' '))}${close}`);
  }
  for (const edge of model.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    lines.push(`  ${from} ${ARROW[edge.routing] ?? '-->'}${edge.label ? `|${label(edge.label)}|` : ''} ${to}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads text back into the diagram: nodes keep their place, look, data and links where their id is the same;
 * new ones go to the right of the drawing, and those no longer written go.
 * @returns {{added: number, removed: number}}
 */
export function applyMermaid(model, text) {
  const parsed = parseMermaid(text);
  const ids = idsFor(model);
  const byText = new Map([...ids].map(([own, written]) => [written, model.node(own)]));
  const right = Math.max(0, ...model.nodes.map((n) => n.x + n.w));
  const top = Math.min(0, ...model.nodes.map((n) => n.y));
  let fresh = 0;
  // A node written under an id stands for the diagram's node of that id, which keeps its place, look and data.
  const idOf = (written) => byText.get(written)?.id ?? written;
  const nodes = parsed.nodes.slice(0, 5000).map((p) => {
    const text = p.text.replace(/#quot;/g, '"');
    const old = byText.get(p.id);
    if (old) return { ...old, text, shape: p.shape ?? old.shape };
    fresh += 1;
    return { id: p.id, shape: p.shape ?? 'rect', x: right + 80, y: top + (fresh - 1) * 100, w: 160, h: 60, text, style: 'default', data: {} };
  });
  const present = new Set(nodes.map((n) => n.id));
  const removed = model.nodes.filter((n) => !present.has(n.id)).length;
  const oldEdges = new Map(model.edges.map((e) => [`${e.from}>${e.to}`, e]));
  const edges = parsed.edges.slice(0, 20000).map((p, i) => {
    const from = idOf(p.from);
    const to = idOf(p.to);
    const old = oldEdges.get(`${from}>${to}`);
    const text = (p.label ?? '').replace(/#quot;/g, '"');
    return old ? { ...old, label: text } : { id: `e${Date.now().toString(36)}${i}`, from, to, label: text, fromPort: 'auto', toPort: 'auto', routing: 'orthogonal', waypoints: [], data: {} };
  }).filter((e) => present.has(e.from) && present.has(e.to));
  model.nodes = nodes;
  model.edges = edges;
  model.dirty = true;
  return { added: fresh, removed };
}
