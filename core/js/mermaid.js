/** Mermaid flowcharts: read into a graph, and drawn as a picture where a note shows them. */

import { drawingSvg } from './draw/render.js';

const DIRECTIONS = new Set(['TB', 'TD', 'BT', 'RL', 'LR']);

/** Node shapes, longest delimiters first so ([x]) is not read as (x). */
const SHAPES = [
  { open: '([', close: '])', shape: 'round-rectangle' },
  { open: '[[', close: ']]', shape: 'flowchart-predefined-process' },
  { open: '[/', close: '\\]', shape: 'parallelogram' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: '[/', close: '/]', shape: 'parallelogram' },
  { open: '[(', close: ')]', shape: 'can' },
  { open: '((', close: '))', shape: 'ellipse' },
  { open: '[', close: ']', shape: 'rectangle' },
  { open: '(', close: ')', shape: 'ellipse' },
  { open: '{', close: '}', shape: 'diamond' },
  { open: '>', close: ']', shape: 'parallelogram' },
];

/** Arrow forms, longest first so --> is not read as. */
const ARROWS = ['-->', '---', '==>', '===', '-.->', '-.-', '~~~', '--x', '--o'];

/**
 * Parses Mermaid source into a graph document.
 * @param {string} source
 * @returns {{version: number, type: string, nodes: Object[], edges: Object[]}}
 */
export function parseMermaid(source) {
  const lines = String(source)
    .split('\n')
    .map((line) => line.replace(/%%.*$/, '').trim())   // %% starts a comment.
    .filter((line) => line !== '');

  if (lines.length === 0) throw new Error('Nothing to import');

  const header = lines[0].match(/^(graph|flowchart)\s+([A-Z]{2})?/i);
  if (!header) {
    throw new Error('Only Mermaid "graph" and "flowchart" diagrams are supported');
  }

  // A direction Mermaid does not know is drawn top to bottom, as Mermaid draws it.
  const named = (header[2] ?? 'TD').toUpperCase();
  const direction = DIRECTIONS.has(named) ? named : 'TD';
  const nodes = new Map();
  const edges = [];

  const declare = (id, label, shape) => {
    const existing = nodes.get(id);
    if (existing) {
      // A later declaration with a label wins.
      if (label) existing.text = label;
      if (shape) existing.shape = shape;
      return existing;
    }
    const node = { id, text: label || id, shape: shape || 'rectangle', data: {} };
    nodes.set(id, node);
    return node;
  };

  for (const written of lines.slice(1)) {
    // A label written inside the arrow, A -- yes --> B, is the same as A -->|yes| B.
    const line = written.replace(/(^|\s)--\s+([^-|>][^>|]*?)\s+-->/g, '$1-->|$2|').replace(/(^|\s)==\s+([^=|>][^>|]*?)\s+==>/g, '$1==>|$2|').replace(/(^|\s)-\.\s+([^.|>][^>|]*?)\s+\.->/g, '$1-.->|$2|');
    if (/^(subgraph|end|click|style|classDef|class|linkStyle|direction)\b/i.test(line)) {
      // Subgraphs and styling are recognised and skipped rather than
      // mis-parsed.
      continue;
    }

    const arrow = findArrow(line);
    if (!arrow) {
      const single = readNode(line);
      if (single) declare(single.id, single.label, single.shape);
      continue;
    }

    // A line may chain links, A --> B --> C, each node the start of the next.
    let left = readNode(line.slice(0, arrow.at));
    let rest = line.slice(arrow.at + arrow.token.length);
    for (let hops = 0; left && hops < 100; hops += 1) {
      const { label, remainder } = readEdgeLabel(rest);
      const next = findArrow(remainder);
      const right = readNode(next ? remainder.slice(0, next.at) : remainder);
      if (!right) break;
      declare(left.id, left.label, left.shape);
      declare(right.id, right.label, right.shape);
      edges.push({
        id: `e${edges.length}-${left.id}-${right.id}`,
        from: left.id,
        to: right.id,
        fromPort: 'auto',
        toPort: 'auto',
        // Mermaid's own default look is orthogonal, and it is the suite's too.
        routing: 'orthogonal',
        label,
        waypoints: [],
        data: {},
      });
      if (!next) break;
      left = right;
      rest = remainder.slice(next.at + next.token.length);
    }
  }

  return {
    version: 1,
    type: 'graphs',
    nodes: [...nodes.values()],
    edges,
    meta: { gridSize: 10, snapToGrid: true, mermaidDirection: direction },
  };
}

function findArrow(line) {
  let best = null;
  for (const token of ARROWS) {
    const at = line.indexOf(token);
    if (at === -1) continue;
    if (!best || at < best.at || (at === best.at && token.length > best.token.length)) {
      best = { at, token };
    }
  }
  return best;
}

/** Reads `A`, `A[Label]`, `A{Choice}` and the rest. */
function readNode(text) {
  const trimmed = text.trim().replace(/;+$/, '');
  if (trimmed === '') return null;

  for (const { open, close, shape } of SHAPES) {
    const start = trimmed.indexOf(open);
    if (start <= 0) continue;
    if (!trimmed.endsWith(close)) continue;

    const id = trimmed.slice(0, start).trim();
    const label = trimmed.slice(start + open.length, trimmed.length - close.length);
    if (id === '') continue;

    return { id, label: unquote(label), shape };
  }

  const id = trimmed.split(/\s+/)[0];
  return id ? { id, label: '', shape: null } : null;
}

/** `|yes| B` puts a label on the connector; `-- yes --> B` is written that way before this reads it. */
function readEdgeLabel(text) {
  const piped = text.trim().match(/^\|([^|]*)\|(.*)$/);
  if (piped) return { label: unquote(piped[1].trim()), remainder: piped[2] };
  return { label: '', remainder: text };
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '').trim();
}

// Drawing

const MAX_NODES = 500;
const GAP_RANK = 70;
const GAP_NODE = 40;
const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** The shapes Graphs reads Mermaid into, as Draw's own shapes. */
const DRAWN = { 'round-rectangle': 'round-rectangle', 'flowchart-predefined-process': 'flowchart-predefined-process', parallelogram: 'parallelogram', hexagon: 'hexagon', can: 'can', ellipse: 'ellipse', rectangle: 'rectangle', diamond: 'diamond' };

/** Each node's rank, the longest way from a node nothing points at, cycles cut where they close. */
function ranks(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, 0]));
  const targets = new Set(edges.map((e) => e.to));
  const next = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (next.has(e.from) && next.has(e.to) && e.from !== e.to) next.get(e.from).push(e.to);
  const roots = nodes.filter((n) => !targets.has(n.id)).map((n) => n.id);
  const visit = (id, rank, path) => {
    if (path.has(id) || rank > nodes.length) return;
    if (rank < out.get(id) && path.size) return;
    out.set(id, Math.max(out.get(id), rank));
    path.add(id);
    for (const to of next.get(id)) visit(to, out.get(id) + 1, path);
    path.delete(id);
  };
  for (const root of roots.length ? roots : [nodes[0].id]) visit(root, 0, new Set());
  return out;
}

/** Where an edge leaves a box toward a point, on the box's border. */
function border(box, toward) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scale = Math.min(Math.abs((box.w / 2) / (dx || 1e-9)), Math.abs((box.h / 2) / (dy || 1e-9)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * A Mermaid flowchart as an SVG picture, laid out in ranks the way its direction says.
 * @param {string} source
 * @returns {string} the SVG, or a short message in one when the source is not a flowchart GRT draws
 */
export function mermaidSvg(source) {
  let graph;
  try { graph = parseMermaid(source); } catch (error) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="30"><text x="4" y="20" font-size="13" fill="#888">${esc(error.message)}</text></svg>`;
  }
  const nodes = graph.nodes.slice(0, MAX_NODES);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  if (!nodes.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
  const direction = graph.meta.mermaidDirection;
  const across = direction === 'LR' || direction === 'RL';
  const size = new Map(nodes.map((n) => {
    const w = Math.min(260, Math.max(70, [...n.text].length * 7.5 + 28));
    return [n.id, { w, h: n.shape === 'diamond' || n.shape === 'hexagon' ? 56 : 40 }];
  }));
  const rank = ranks(nodes, edges);
  const layers = [];
  for (const n of nodes) (layers[rank.get(n.id)] ??= []).push(n);
  // Ranks one after another along the direction, the nodes of a rank centred across it.
  const boxes = new Map();
  const extent = layers.map((layer) => layer.reduce((sum, n) => sum + (across ? size.get(n.id).h : size.get(n.id).w) + GAP_NODE, -GAP_NODE));
  const widest = Math.max(...extent);
  let along = 10;
  layers.forEach((layer, i) => {
    const depth = Math.max(...layer.map((n) => (across ? size.get(n.id).w : size.get(n.id).h)));
    let side = 10 + (widest - extent[i]) / 2;
    for (const n of layer) {
      const { w, h } = size.get(n.id);
      boxes.set(n.id, across ? { x: along + (depth - w) / 2, y: side, w, h } : { x: side, y: along + (depth - h) / 2, w, h });
      side += (across ? h : w) + GAP_NODE;
    }
    along += depth + GAP_RANK;
  });
  const width = Math.max(...[...boxes.values()].map((b) => b.x + b.w)) + 10;
  const height = Math.max(...[...boxes.values()].map((b) => b.y + b.h)) + 10;
  if (direction === 'BT' || direction === 'RL') {
    for (const b of boxes.values()) { if (direction === 'BT') b.y = height - b.y - b.h; else b.x = width - b.x - b.w; }
  }
  const lines = edges.map((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    const start = border(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const end = border(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
    const label = e.label ? `<text x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 4}" font-size="12" text-anchor="middle" fill="#444" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(e.label)}</text>` : '';
    return `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#555" stroke-width="1.4" marker-end="url(#mm-arrow)"/>${label}`;
  }).join('');
  const shapes = nodes.map((n) => {
    const b = boxes.get(n.id);
    const shape = drawingSvg({ id: n.id, kind: 'shape', shape: DRAWN[n.shape] ?? 'rectangle', x: 0, y: 0, w: b.w, h: b.h, fillLook: { type: 'solid', color: '#eef3fb' }, line: { color: '#5b7db1', width: 1.2 } }, { idPrefix: 'mm' });
    return `<g transform="translate(${b.x} ${b.y})">${shape}<text x="${b.w / 2}" y="${b.h / 2 + 4.5}" font-size="13" text-anchor="middle" fill="#1d2b3a">${esc(n.text)}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Diagram"><defs><marker id="mm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#555"/></marker></defs>${lines}${shapes}</svg>`;
}
