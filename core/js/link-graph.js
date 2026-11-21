/** The graph of notes and their links: built from a catalogue, cut around one note, laid out by forces, drawn. */

const MAX_NODES = 20000;

/**
 * Notes as nodes, links between them as edges; a link to no note is left out, a note linked twice counted once.
 * @param {{path: string, title: string, links?: string[]}[]} notes
 * @param {(title: string) => ?string} resolve a link's title to a note's path
 */
export function linkGraph(notes, resolve) {
  const nodes = notes.slice(0, MAX_NODES).map((n) => ({ id: n.path, title: n.title || n.path.split('/').pop().replace(/\.\w+$/, '') }));
  const known = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  const edges = [];
  for (const note of notes.slice(0, MAX_NODES)) {
    for (const title of note.links ?? []) {
      const to = resolve(title);
      if (!to || to === note.path || !known.has(to)) continue;
      const key = `${note.path}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: note.path, to });
    }
  }
  return { nodes, edges };
}

/** The notes within some links of one, either way, and the links among them. */
export function around(graph, center, depth = 1) {
  const next = new Map();
  for (const e of graph.edges) {
    if (!next.has(e.from)) next.set(e.from, []);
    if (!next.has(e.to)) next.set(e.to, []);
    next.get(e.from).push(e.to);
    next.get(e.to).push(e.from);
  }
  const keep = new Set([center]);
  let ring = [center];
  for (let d = 0; d < depth; d += 1) {
    const out = [];
    for (const id of ring) for (const n of next.get(id) ?? []) if (!keep.has(n)) { keep.add(n); out.push(n); }
    ring = out;
  }
  return { nodes: graph.nodes.filter((n) => keep.has(n.id)), edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

/** A number from a text, the same every time, so a layout does not change between showings. */
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Positions by forces: links pull, notes push each other away, only the near ones counted so a big vault stays quick.
 * @returns {Map<string, {x: number, y: number}>}
 */
export function forceLayout(graph, { iterations = null, spacing = 60 } = {}) {
  const n = graph.nodes.length;
  const positions = new Map();
  if (!n) return positions;
  const count = iterations ?? (n > 3000 ? 40 : n > 800 ? 80 : 200);
  const radius = spacing * Math.sqrt(n);
  graph.nodes.forEach((node, i) => {
    const angle = seeded(node.id) * Math.PI * 2;
    const r = radius * Math.sqrt((i + 0.5) / n);
    positions.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  graph.nodes.forEach((node, i) => { xs[i] = positions.get(node.id).x; ys[i] = positions.get(node.id).y; });
  const links = graph.edges.map((e) => [index.get(e.from), index.get(e.to)]).filter(([a, b]) => a !== undefined && b !== undefined);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const cell = spacing * 3;
  for (let step = 0; step < count; step += 1) {
    dx.fill(0);
    dy.fill(0);
    // Pushing apart, through a grid: each note against those in its own cell and the eight around it.
    const grid = new Map();
    for (let i = 0; i < n; i += 1) {
      const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    for (let i = 0; i < n; i += 1) {
      const cx = Math.floor(xs[i] / cell);
      const cy = Math.floor(ys[i] / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
        for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
          for (const j of grid.get(`${gx},${gy}`) ?? []) {
            if (j <= i) continue;
            let ddx = xs[i] - xs[j];
            let ddy = ys[i] - ys[j];
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 < 0.01) { ddx = 0.1 + seeded(String(i)); ddy = 0.1; d2 = ddx * ddx + ddy * ddy; }
            if (d2 > cell * cell) continue;
            const force = (spacing * spacing) / d2;
            dx[i] += ddx * force; dy[i] += ddy * force;
            dx[j] -= ddx * force; dy[j] -= ddy * force;
          }
        }
      }
    }
    for (const [a, b] of links) {
      const ddx = xs[a] - xs[b];
      const ddy = ys[a] - ys[b];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const force = d / spacing;
      dx[a] -= ddx * force * 0.5; dy[a] -= ddy * force * 0.5;
      dx[b] += ddx * force * 0.5; dy[b] += ddy * force * 0.5;
    }
    // Everything drifts a little toward the middle, so unlinked notes do not fly off.
    const cool = spacing * (1 - step / count) + 1;
    for (let i = 0; i < n; i += 1) {
      dx[i] -= xs[i] * 0.01;
      dy[i] -= ys[i] * 0.01;
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (d > 0) { xs[i] += (dx[i] / d) * Math.min(d, cool); ys[i] += (dy[i] / d) * Math.min(d, cool); }
    }
  }
  graph.nodes.forEach((node, i) => positions.set(node.id, { x: xs[i], y: ys[i] }));
  return positions;
}

const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * The graph as an SVG picture, each note a dot with its title, the chosen one marked; a note's dot carries its path to be pressed.
 * @returns {string}
 */
export function graphSvg(graph, positions, { current = null, width = 640, height = 440 } = {}) {
  if (!graph.nodes.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="60"><text x="10" y="35" fill="#888" font-size="13">No links yet.</text></svg>`;
  const xs = graph.nodes.map((n) => positions.get(n.id).x);
  const ys = graph.nodes.map((n) => positions.get(n.id).y);
  const minX = Math.min(...xs) - 60;
  const minY = Math.min(...ys) - 30;
  const w = Math.max(...xs) + 60 - minX;
  const h = Math.max(...ys) + 30 - minY;
  const lines = graph.edges.map((e) => {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
  }).join('');
  const dots = graph.nodes.map((n) => {
    const p = positions.get(n.id);
    const mine = n.id === current;
    return `<g class="graph-note${mine ? ' current' : ''}" data-path="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.title)}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${mine ? 8 : 5}"/><text x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" text-anchor="middle">${esc(n.title)}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" class="link-graph" width="${width}" height="${height}" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" role="img" aria-label="The notes and their links"><g class="graph-links">${lines}</g>${dots}</svg>`;
}
