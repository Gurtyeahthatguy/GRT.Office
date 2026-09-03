/** SVG, JSON and PNG. */

import { routeEdge, pathData } from './routing.js';

const escape = (value) => String(value ?? '')
  .replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));

const round = (value) => Math.round(value * 100) / 100;

/** The drawing's extent, with room to breathe. */
export function bounds(model, padding = 20) {
  if (model.nodes.length === 0) {
    return { x: 0, y: 0, width: 200, height: 200 };
  }

  const xs = model.nodes.flatMap((n) => [n.x, n.x + n.w]);
  const ys = model.nodes.flatMap((n) => [n.y, n.y + n.h]);

  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;

  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX + padding,
    height: Math.max(...ys) - minY + padding,
  };
}

/** The outline of one node, as an SVG element. */
export function shapeMarkup(node, style) {
  const { x, y, w, h } = node;
  const fill = escape(style.fill ?? '#ffffff');
  const stroke = escape(style.stroke ?? '#333333');
  const width = style.strokeWidth ?? 2;
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${width}"`;

  switch (node.shape) {
    case 'ellipse':
      return `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" `
        + `rx="${round(w / 2)}" ry="${round(h / 2)}" ${common}/>`;
    case 'diamond':
      return `<polygon points="${round(x + w / 2)},${round(y)} ${round(x + w)},${round(y + h / 2)} `
        + `${round(x + w / 2)},${round(y + h)} ${round(x)},${round(y + h / 2)}" ${common}/>`;
    case 'parallelogram': {
      const slant = Math.min(w * 0.2, 30);
      return `<polygon points="${round(x + slant)},${round(y)} ${round(x + w)},${round(y)} `
        + `${round(x + w - slant)},${round(y + h)} ${round(x)},${round(y + h)}" ${common}/>`;
    }
    case 'hexagon': {
      const notch = Math.min(w * 0.18, 28);
      return `<polygon points="${round(x + notch)},${round(y)} ${round(x + w - notch)},${round(y)} `
        + `${round(x + w)},${round(y + h / 2)} ${round(x + w - notch)},${round(y + h)} `
        + `${round(x + notch)},${round(y + h)} ${round(x)},${round(y + h / 2)}" ${common}/>`;
    }
    case 'triangle':
      return `<polygon points="${round(x + w / 2)},${round(y)} ${round(x + w)},${round(y + h)} `
        + `${round(x)},${round(y + h)}" ${common}/>`;
    case 'rounded':
      return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" `
        + `rx="${round(Math.min(h / 2, 24))}" ${common}/>`;
    default:
      return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" `
        + `rx="4" ${common}/>`;
  }
}

/** Text inside a node, wrapped crudely by character count. */
export function textLines(text, width) {
  if (!text) return [];
  const perLine = Math.max(Math.floor(width / 7.2), 4);
  const lines = [];

  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && (line + ' ' + word).length > perLine) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }

  return lines;
}

/**
 * The whole drawing as a standalone SVG document.
 * @param {GraphModel} model
 * @returns {string}
 */
export function toSvg(model) {
  const box = bounds(model);
  const parts = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(box.width)}" `
    + `height="${round(box.height)}" viewBox="${round(box.x)} ${round(box.y)} `
    + `${round(box.width)} ${round(box.height)}">`,
  );

  // One arrowhead definition, referenced by every connector.
  parts.push(
    '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
    + 'markerHeight="6" orient="auto-start-reverse">'
    + '<path d="M 0 0 L 10 5 L 0 10 z" fill="#333333"/></marker></defs>',
  );

  for (const edge of model.edges) {
    const from = model.nodes.find((n) => n.id === edge.from);
    const to = model.nodes.find((n) => n.id === edge.to);
    if (!from || !to) continue;      // a dangling edge is simply not drawn.

    const points = routeEdge(edge, from, to);
    parts.push(
      `<path d="${pathData(points, edge.routing)}" fill="none" stroke="#333333" `
      + 'stroke-width="2" marker-end="url(#a)"/>',
    );

    if (edge.label) {
      const middle = points[Math.floor(points.length / 2)];
      parts.push(
        `<text x="${round(middle.x)}" y="${round(middle.y - 6)}" text-anchor="middle" `
        + `font-family="sans-serif" font-size="12" fill="#333333">${escape(edge.label)}</text>`,
      );
    }
  }

  for (const node of model.nodes) {
    const style = model.styles[node.style] ?? model.styles.default ?? {};
    parts.push(shapeMarkup(node, style));

    const lines = textLines(node.text, node.w);
    const startY = node.y + node.h / 2 - ((lines.length - 1) * 15) / 2 + 5;
    lines.forEach((line, i) => {
      parts.push(
        `<text x="${round(node.x + node.w / 2)}" y="${round(startY + i * 15)}" `
        + 'text-anchor="middle" font-family="sans-serif" font-size="13" '
        + `fill="#222222">${escape(line)}</text>`,
      );
    });
  }

  parts.push('</svg>');

  // Joined with newlines and nothing else.
  return `${parts.join('\n')}\n`;
}

/**
 * The model as JSON.
 * @param {GraphModel} model
 * @param {{logicOnly?: boolean}} [options]
 */
export function toJson(model, options = {}) {
  if (!options.logicOnly) {
    return `${JSON.stringify(model.toJSON(), null, 2)}\n`;
  }

  const document = {
    version: model.toJSON().version,
    type: 'graphs',
    nodes: model.nodes.map((node) => ({
      id: node.id,
      text: node.text,
      data: node.data,
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label,
      data: edge.data,
    })),
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Rasterises the SVG.
 * @param {string} svg
 * @param {number} scale
 * @returns {Promise<Uint8Array>} PNG bytes
 */
export async function toPng(svg, scale = 2) {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);

  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The drawing could not be rasterised'));
      image.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(Math.round(image.width * scale), 1);
    canvas.height = Math.max(Math.round(image.height * scale), 1);

    const context = canvas.getContext('2d');
    // White rather than transparent.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The drawing as primitives for the shared print engine.
 * @param {GraphModel} model
 * @returns {{width: number, height: number, primitives: Object[]}}
 */
export function toPrintPage(model) {
  const box = bounds(model);
  const primitives = [];
  // Shift so the drawing starts at the page origin.
  const ox = -box.x;
  const oy = -box.y;

  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));

  for (const edge of model.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) continue;

    const points = routeEdge(edge, from, to).map((p) => [p.x + ox, p.y + oy]);
    primitives.push({ type: 'polyline', points, stroke: '#333333', strokeWidth: 2 });

    if (edge.label) {
      const middle = points[Math.floor(points.length / 2)];
      primitives.push({
        type: 'text', x: middle[0], y: middle[1] - 14, text: edge.label,
        size: 10, align: 'center', fill: '#333333',
      });
    }
  }

  for (const node of model.nodes) {
    const style = model.styles[node.style] ?? model.styles.default ?? {};
    const x = node.x + ox;
    const y = node.y + oy;

    if (node.shape === 'ellipse') {
      primitives.push({
        type: 'ellipse', cx: x + node.w / 2, cy: y + node.h / 2,
        rx: node.w / 2, ry: node.h / 2,
        fill: style.fill, stroke: style.stroke, strokeWidth: style.strokeWidth ?? 2,
      });
    } else if (POLYGON_SHAPES.has(node.shape)) {
      const points = polygonPoints(node.shape, x, y, node.w, node.h);
      primitives.push({
        type: 'polygon', points,
        fill: style.fill, stroke: style.stroke, strokeWidth: style.strokeWidth ?? 2,
      });
    } else {
      primitives.push({
        type: 'rect', x, y, w: node.w, h: node.h,
        fill: style.fill, stroke: style.stroke, strokeWidth: style.strokeWidth ?? 2,
      });
    }

    const lines = textLines(node.text, node.w);
    const startY = y + node.h / 2 - ((lines.length - 1) * 14) / 2 - 4;
    lines.forEach((line, i) => {
      primitives.push({
        type: 'text', x: x + node.w / 2, y: startY + i * 14,
        text: line, size: 11, align: 'center', fill: '#222222',
      });
    });
  }

  return { width: box.width, height: box.height, primitives };
}

/** Shapes the print engine draws as filled polygons. */
const POLYGON_SHAPES = new Set(['diamond', 'parallelogram', 'hexagon', 'triangle']);

/** Corner coordinates of a polygon shape. */
function polygonPoints(shape, x, y, w, h) {
  switch (shape) {
    case 'diamond':
      return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
    case 'hexagon': {
      const notch = Math.min(w * 0.18, 28);
      return [[x + notch, y], [x + w - notch, y], [x + w, y + h / 2],
        [x + w - notch, y + h], [x + notch, y + h], [x, y + h / 2]];
    }
    case 'triangle':
      return [[x + w / 2, y], [x + w, y + h], [x, y + h]];
    default: {
      const slant = Math.min(w * 0.2, 30);
      return [[x + slant, y], [x + w, y], [x + w - slant, y + h], [x, y + h]];
    }
  }
}
