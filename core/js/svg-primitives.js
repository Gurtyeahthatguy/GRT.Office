/** The shapes of a simple SVG, such as the chart engine's, as the PDF engine's primitives. */

const number = (value, fallback = 0) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

/** A path of absolute M, L, A and Z commands, moved and scaled. */
function movePath(d, place) {
  const tokens = String(d).match(/[MLAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const out = [];
  let i = 0;
  const take = () => number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M' || command === 'L') {
      const [x, y] = place(take(), take());
      out.push(`${command}${x},${y}`);
    } else if (command === 'A') {
      const rx = take() * place.scale;
      const ry = take() * place.scale;
      const rotation = take();
      const large = take();
      const sweep = take();
      const [x, y] = place(take(), take());
      out.push(`A${rx},${ry} ${rotation} ${large} ${sweep} ${x},${y}`);
    } else if (command === 'Z' || command === 'z') out.push('Z');
    else break;
  }
  return out.join(' ');
}

/**
 * The primitives of an SVG drawn at a point, at a scale.
 * @param {string} svg
 * @param {{x: number, y: number, scale: number}} at
 */
export function svgToPrimitives(svg, { x = 0, y = 0, scale = 1 } = {}) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg') return [];
  const place = (px, py) => [x + px * scale, y + py * scale];
  place.scale = scale;
  const out = [];
  for (const node of root.querySelectorAll('rect, line, path, circle, polygon, text')) {
    const fill = node.getAttribute('fill');
    const paint = fill && fill !== 'none' ? fill : null;
    const stroke = node.getAttribute('stroke');
    const strokeWidth = number(node.getAttribute('stroke-width'), 1) * scale;
    switch (node.localName) {
      case 'rect': {
        const [rx, ry] = place(number(node.getAttribute('x')), number(node.getAttribute('y')));
        out.push({ type: 'rect', x: rx, y: ry, w: number(node.getAttribute('width')) * scale, h: number(node.getAttribute('height')) * scale, fill: paint });
        break;
      }
      case 'line': {
        const a = place(number(node.getAttribute('x1')), number(node.getAttribute('y1')));
        const b = place(number(node.getAttribute('x2')), number(node.getAttribute('y2')));
        out.push({ type: 'polyline', points: [a, b], stroke: stroke ?? '#333333', strokeWidth });
        break;
      }
      case 'path':
        out.push({ type: 'path', d: movePath(node.getAttribute('d'), place), fill: paint, stroke: stroke && stroke !== 'none' ? stroke : null, strokeWidth });
        break;
      case 'circle': {
        const [cx, cy] = place(number(node.getAttribute('cx')), number(node.getAttribute('cy')));
        const r = number(node.getAttribute('r')) * scale;
        out.push({ type: 'ellipse', cx, cy, rx: r, ry: r, fill: paint });
        break;
      }
      case 'polygon': {
        const values = (node.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
        const points = [];
        for (let k = 0; k + 1 < values.length; k += 2) points.push(place(values[k], values[k + 1]));
        out.push({ type: 'polygon', points, fill: paint, stroke: stroke ?? null, strokeWidth });
        break;
      }
      case 'text': {
        // Turned text, such as an axis title, has no primitive yet and is left out.
        if (node.getAttribute('transform')) break;
        const size = number(node.getAttribute('font-size'), 11) * scale;
        const [tx, ty] = place(number(node.getAttribute('x')), number(node.getAttribute('y')));
        const anchor = node.getAttribute('text-anchor');
        out.push({
          type: 'text', x: tx, y: ty - size * 0.8, text: node.textContent, size,
          align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
          bold: Number(node.getAttribute('font-weight')) >= 600, fill: paint ?? '#333333',
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}
