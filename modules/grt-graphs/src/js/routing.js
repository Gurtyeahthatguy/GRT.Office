/** Where a connector actually goes. */

/** Where a port sits on a node's outline. */
export function portPoint(node, port) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;

  switch (port) {
    case 'top': return { x: cx, y: node.y };
    case 'bottom': return { x: cx, y: node.y + node.h };
    case 'left': return { x: node.x, y: cy };
    case 'right': return { x: node.x + node.w, y: cy };
    default: return { x: cx, y: cy };
  }
}

/** The direction a connector leaves a port in. */
export function portNormal(port) {
  switch (port) {
    case 'top': return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
    default: return { x: 1, y: 0 };
  }
}

/** Chooses ports for an edge set to 'auto'. */
export function resolveAutoPorts(from, to, fromPort, toPort) {
  if (fromPort !== 'auto' && toPort !== 'auto') {
    return { fromPort, toPort };
  }

  const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
  const dy = (to.y + to.h / 2) - (from.y + from.h / 2);

  // Whichever axis separates them more decides the pair, so two nodes side by
  // side connect edge to edge rather than looping over the top.
  const horizontal = Math.abs(dx) >= Math.abs(dy);

  const resolved = horizontal
    ? { fromPort: dx >= 0 ? 'right' : 'left', toPort: dx >= 0 ? 'left' : 'right' }
    : { fromPort: dy >= 0 ? 'bottom' : 'top', toPort: dy >= 0 ? 'top' : 'bottom' };

  return {
    fromPort: fromPort === 'auto' ? resolved.fromPort : fromPort,
    toPort: toPort === 'auto' ? resolved.toPort : toPort,
  };
}

/** How far a connector normally steps away from a node before turning. */
const STUB = 20;

/** The stub has to fit in the space between the two nodes. */
function stubLength(from, to, fromPort) {
  const vertical = fromPort === 'top' || fromPort === 'bottom';

  const gap = vertical
    ? Math.max(to.y - (from.y + from.h), from.y - (to.y + to.h))
    : Math.max(to.x - (from.x + from.w), from.x - (to.x + to.w));

  if (!Number.isFinite(gap) || gap >= STUB * 2) return STUB;
  // Overlapping nodes have no corridor at all; a small step is the least bad
  // thing to do and the path is best-effort by definition.
  return Math.max(gap / 2 - 1, 2);
}

/**
 * The points a connector passes through.
 * @param {Object} edge
 * @param {Object} from node
 * @param {Object} to node
 * @returns {{x: number, y: number}[]}
 */
export function routeEdge(edge, from, to) {
  const { fromPort, toPort } = resolveAutoPorts(from, to, edge.fromPort, edge.toPort);
  const start = portPoint(from, fromPort);
  const end = portPoint(to, toPort);

  // Hand-drawn points switch the router off entirely for this edge.
  if (edge.waypoints?.length > 0) {
    return [start, ...edge.waypoints, end];
  }

  if (edge.routing === 'straight') return [start, end];
  if (edge.routing === 'curved') return [start, end];   // the curve is drawn from two points.

  return orthogonalPath(start, end, fromPort, toPort, stubLength(from, to, fromPort));
}

/** Orthogonal routing: horizontal and vertical segments only. */
export function orthogonalPath(start, end, fromPort, toPort, stub = STUB) {
  const out = stepOut(start, fromPort, stub);
  const into = stepOut(end, toPort, stub);

  const fromVertical = fromPort === 'top' || fromPort === 'bottom';
  const toVertical = toPort === 'top' || toPort === 'bottom';

  // Already aligned on the axis the connector leaves along.
  if (fromVertical && toVertical && Math.abs(start.x - end.x) < 0.5) {
    return [start, end];
  }
  if (!fromVertical && !toVertical && Math.abs(start.y - end.y) < 0.5) {
    return [start, end];
  }

  if (fromVertical && toVertical) {
    // Z path: out, across at the midpoint, in.
    const midY = (out.y + into.y) / 2;
    return [start, out, { x: out.x, y: midY }, { x: into.x, y: midY }, into, end];
  }

  if (!fromVertical && !toVertical) {
    const midX = (out.x + into.x) / 2;
    return [start, out, { x: midX, y: out.y }, { x: midX, y: into.y }, into, end];
  }

  // L path: one axis each, so a single corner connects them.
  const corner = fromVertical ? { x: out.x, y: into.y } : { x: into.x, y: out.y };
  return [start, out, corner, into, end];
}

function stepOut(point, port, distance = STUB) {
  const normal = portNormal(port);
  return { x: point.x + normal.x * distance, y: point.y + normal.y * distance };
}

/** An SVG path for the points, curved or straight as the edge asks. */
export function pathData(points, routing) {
  if (points.length < 2) return '';

  if (routing === 'curved' && points.length === 2) {
    const [a, b] = points;
    // Horizontal control points give the S shape node editors use.
    const grip = Math.max(Math.abs(b.x - a.x) / 2, 40);
    return `M ${a.x} ${a.y} C ${a.x + grip} ${a.y}, ${b.x - grip} ${b.y}, ${b.x} ${b.y}`;
  }

  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`)
    .join(' ');
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * Whether a point lies inside a node's box, used for hit tests and checks.
 */
export function pointInNode(point, node) {
  return point.x >= node.x && point.x <= node.x + node.w
    && point.y >= node.y && point.y <= node.y + node.h;
}

/** Whether any segment of a path passes through a node. */
export function pathCrossesNode(points, node) {
  for (let i = 0; i < points.length - 1; i += 1) {
    if (segmentCrossesBox(points[i], points[i + 1], node)) return true;
  }
  return false;
}

function segmentCrossesBox(a, b, node) {
  // Orthogonal segments only, which is all this needs to judge.
  const left = node.x;
  const right = node.x + node.w;
  const top = node.y;
  const bottom = node.y + node.h;

  const strictlyInside = (p) => p.x > left + 0.01 && p.x < right - 0.01
    && p.y > top + 0.01 && p.y < bottom - 0.01;

  if (strictlyInside(a) || strictlyInside(b)) return true;

  if (Math.abs(a.y - b.y) < 0.01) {
    const y = a.y;
    if (y <= top + 0.01 || y >= bottom - 0.01) return false;
    const [x1, x2] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
    return x1 < right - 0.01 && x2 > left + 0.01;
  }

  if (Math.abs(a.x - b.x) < 0.01) {
    const x = a.x;
    if (x <= left + 0.01 || x >= right - 0.01) return false;
    const [y1, y2] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
    return y1 < bottom - 0.01 && y2 > top + 0.01;
  }

  return false;
}
