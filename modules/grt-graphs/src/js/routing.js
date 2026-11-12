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

/** The ports an edge actually uses, with 'auto' resolved. */
export function edgePorts(edge, from, to) {
  return resolveAutoPorts(from, to, edge.fromPort, edge.toPort);
}

/** A curve's two control points: each leaves its end the way the port faces, so a curve from the bottom starts downwards. */
export function curveControls(a, b, ports = { fromPort: 'right', toPort: 'left' }) {
  const grip = (port) => {
    const n = portNormal(port);
    const reach = Math.max((n.x ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) / 2, 40);
    return { x: n.x * reach, y: n.y * reach };
  };
  const out = grip(ports.fromPort);
  const into = grip(ports.toPort);
  return [{ x: a.x + out.x, y: a.y + out.y }, { x: b.x + into.x, y: b.y + into.y }];
}

/** Points along a curved connector, for outputs that draw only straight lines. */
export function curvePoints(a, b, ports, steps = 16) {
  const [c1, c2] = curveControls(a, b, ports);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    };
  });
}

/** The points a connector is drawn through, a curve's included. */
export function drawnPoints(points, routing, ports) {
  return routing === 'curved' && points.length === 2 ? curvePoints(points[0], points[1], ports) : points;
}

/** Where a connector's label sits: halfway along it, by length. */
export function labelPoint(points, routing, ports) {
  const line = drawnPoints(points, routing, ports);
  const lengths = line.slice(1).map((p, i) => Math.hypot(p.x - line[i].x, p.y - line[i].y));
  let left = lengths.reduce((sum, n) => sum + n, 0) / 2;
  for (let i = 0; i < lengths.length; i += 1) {
    if (left <= lengths[i] && lengths[i] > 0) {
      const t = left / lengths[i];
      return { x: line[i].x + (line[i + 1].x - line[i].x) * t, y: line[i].y + (line[i + 1].y - line[i].y) * t };
    }
    left -= lengths[i];
  }
  return line[0];
}

/** An SVG path for the points, curved or straight as the edge asks. */
export function pathData(points, routing, ports) {
  if (points.length < 2) return '';

  if (routing === 'curved' && points.length === 2) {
    const [a, b] = points;
    const [c1, c2] = curveControls(a, b, ports);
    return `M ${round(a.x)} ${round(a.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(b.x)} ${round(b.y)}`;
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
