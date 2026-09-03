/** Reading Mermaid flowcharts. */

const DIRECTIONS = new Set(['TB', 'TD', 'BT', 'RL', 'LR']);

/** Node shapes, longest delimiters first so ([x]) is not read as (x). */
const SHAPES = [
  { open: '([', close: '])', shape: 'rounded' },
  { open: '[[', close: ']]', shape: 'rect' },
  { open: '[/', close: '\\]', shape: 'parallelogram' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: '[/', close: '/]', shape: 'parallelogram' },
  { open: '[(', close: ')]', shape: 'rect' },
  { open: '((', close: '))', shape: 'ellipse' },
  { open: '[', close: ']', shape: 'rect' },
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

  const direction = (header[2] ?? 'TD').toUpperCase();
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
    const node = { id, text: label || id, shape: shape || 'rect', data: {} };
    nodes.set(id, node);
    return node;
  };

  for (const line of lines.slice(1)) {
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

    const left = readNode(line.slice(0, arrow.at));
    const rest = line.slice(arrow.at + arrow.token.length);
    const { label, remainder } = readEdgeLabel(rest);
    const right = readNode(remainder);

    if (!left || !right) continue;

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

/** `|yes| B` and `-- yes --> B` both put a label on the connector. */
function readEdgeLabel(text) {
  const piped = text.trim().match(/^\|([^|]*)\|(.*)$/);
  if (piped) return { label: unquote(piped[1].trim()), remainder: piped[2] };

  const trailing = text.trim().match(/^([^->]*?)\s*-->(.*)$/);
  if (trailing) return { label: unquote(trailing[1].trim()), remainder: trailing[2] };

  return { label: '', remainder: text };
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '').trim();
}
