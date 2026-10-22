/** Outlines as SVG path data in absolute M, L, C, Q and Z. */

/**
 * Reads SVG path data, relative commands, shorthand and arcs included, as absolute segments.
 * @returns {Array<['M'|'L', number, number]|['C', ...number[]]|['Q', ...number[]]|['Z']>}
 */
export function parsePath(d) {
  const tokens = String(d ?? '').match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const out = [];
  let i = 0;
  let command = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl = null;
  let lastQuad = null;
  const number = () => {
    const value = Number(tokens[i]);
    i += 1;
    if (!Number.isFinite(value)) throw new Error('Path data is broken');
    return value;
  };
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) {
      command = tokens[i];
      i += 1;
      if (command === 'z' || command === 'Z') {
        out.push(['Z']);
        x = startX;
        y = startY;
        lastControl = null;
        lastQuad = null;
        continue;
      }
    } else if (command === null) {
      throw new Error('Path data does not start with a command');
    }
    const relative = command === command.toLowerCase();
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case 'M': {
        x = ox + number();
        y = oy + number();
        startX = x;
        startY = y;
        out.push(['M', x, y]);
        // Pairs after a move are lines.
        command = relative ? 'l' : 'L';
        lastControl = null;
        lastQuad = null;
        break;
      }
      case 'L':
        x = ox + number();
        y = oy + number();
        out.push(['L', x, y]);
        lastControl = null;
        lastQuad = null;
        break;
      case 'H':
        x = ox + number();
        out.push(['L', x, y]);
        lastControl = null;
        lastQuad = null;
        break;
      case 'V':
        y = oy + number();
        out.push(['L', x, y]);
        lastControl = null;
        lastQuad = null;
        break;
      case 'C': {
        const c = [ox + number(), oy + number(), ox + number(), oy + number(), ox + number(), oy + number()];
        out.push(['C', ...c]);
        lastControl = [c[2], c[3]];
        [x, y] = [c[4], c[5]];
        lastQuad = null;
        break;
      }
      case 'S': {
        const first = lastControl ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y];
        const c = [ox + number(), oy + number(), ox + number(), oy + number()];
        out.push(['C', first[0], first[1], ...c]);
        lastControl = [c[0], c[1]];
        [x, y] = [c[2], c[3]];
        lastQuad = null;
        break;
      }
      case 'Q': {
        const c = [ox + number(), oy + number(), ox + number(), oy + number()];
        out.push(['Q', ...c]);
        lastQuad = [c[0], c[1]];
        [x, y] = [c[2], c[3]];
        lastControl = null;
        break;
      }
      case 'T': {
        const control = lastQuad ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]] : [x, y];
        const end = [ox + number(), oy + number()];
        out.push(['Q', ...control, ...end]);
        lastQuad = control;
        [x, y] = end;
        lastControl = null;
        break;
      }
      case 'A': {
        const rx = number();
        const ry = number();
        const rotation = number();
        const large = number();
        const sweep = number();
        const end = [ox + number(), oy + number()];
        out.push(...arcToCurves(x, y, rx, ry, rotation, large, sweep, end[0], end[1]));
        [x, y] = end;
        lastControl = null;
        lastQuad = null;
        break;
      }
      default:
        throw new Error(`Path command ${command} is not known`);
    }
  }
  return out;
}

/** SVG's endpoint arc as cubic curves, each at most a quarter turn. */
export function arcToCurves(x1, y1, rxIn, ryIn, degrees, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  const phi = (degrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = Number(large) === Number(sweep) ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const factor = sign * Math.sqrt(Math.max(0, numerator / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let sweepAngle = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!Number(sweep) && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (Number(sweep) && sweepAngle < 0) sweepAngle += 2 * Math.PI;
  return ellipseCurves(cx, cy, rx, ry, phi, start, sweepAngle);
}

/** Part of an ellipse as cubic curves, from an angle through a sweep, in radians. */
export function ellipseCurves(cx, cy, rx, ry, phi, start, sweep) {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const point = (a, along = 0) => {
    const ex = rx * (Math.cos(a) - along * Math.sin(a));
    const ey = ry * (Math.sin(a) + along * Math.cos(a));
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const out = [];
  for (let n = 0; n < pieces; n += 1) {
    const a1 = start + n * step;
    const a2 = a1 + step;
    out.push(['C', ...point(a1, k), ...point(a2, -k), ...point(a2)]);
  }
  return out;
}

/** Applies a function to every point of a path. */
export function mapPath(segments, fn) {
  return segments.map((segment) => {
    if (segment[0] === 'Z') return segment;
    const out = [segment[0]];
    for (let i = 1; i < segment.length; i += 2) out.push(...fn(segment[i], segment[i + 1]));
    return out;
  });
}

/** Path data to write, numbers rounded to a few places. */
export function formatPath(segments, places = 2) {
  const round = (v) => {
    const r = Number(v.toFixed(places));
    return Object.is(r, -0) ? 0 : r;
  };
  return segments.map((segment) => [segment[0], ...segment.slice(1).map(round)].join(' ')).join(' ');
}

/** The box a path's points span, control points included. */
export function pathBounds(segments) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  mapPath(segments, (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    return [x, y];
  });
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

/** A path's data in a 0 to 100 box, from coordinates in a box of the given size. */
export function normalisePath(segments, width, height) {
  const sx = width > 0 ? 100 / width : 1;
  const sy = height > 0 ? 100 / height : 1;
  return formatPath(mapPath(segments, (x, y) => [x * sx, y * sy]), 3);
}

/** The outline of each of the suite's shapes, in a 0 to 100 box. */
export function presetOutline(shape, path = null) {
  const polygon = (points) => `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
  switch (shape) {
    case 'path': return path ?? polygon([[0, 0], [100, 0], [100, 100], [0, 100]]);
    case 'ellipse': return `M 100 50 ${formatPath(ellipseCurves(50, 50, 50, 50, 0, 0, 2 * Math.PI), 3)} Z`;
    case 'rounded': {
      const r = 10;
      const corner = (cx, cy, start) => formatPath(ellipseCurves(cx, cy, r, r, 0, start, Math.PI / 2), 3);
      return `M ${r} 0 L ${100 - r} 0 ${corner(100 - r, r, -Math.PI / 2)} L 100 ${100 - r} ${corner(100 - r, 100 - r, 0)}`
        + ` L ${r} 100 ${corner(r, 100 - r, Math.PI / 2)} L 0 ${r} ${corner(r, r, Math.PI)} Z`;
    }
    case 'diamond': return polygon([[50, 0], [100, 50], [50, 100], [0, 50]]);
    case 'parallelogram': return polygon([[20, 0], [100, 0], [80, 100], [0, 100]]);
    case 'hexagon': return polygon([[18, 0], [82, 0], [100, 50], [82, 100], [18, 100], [0, 50]]);
    case 'triangle': return polygon([[50, 0], [100, 100], [0, 100]]);
    default: return polygon([[0, 0], [100, 0], [100, 100], [0, 100]]);
  }
}

/** A 0 to 100 outline turned over left to right, top to bottom, or both. */
export function mirrorOutline(d, flipH, flipV) {
  return formatPath(mapPath(parsePath(d), (x, y) => [flipH ? 100 - x : x, flipV ? 100 - y : y]), 3);
}
