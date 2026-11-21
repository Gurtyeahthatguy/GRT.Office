/** SVG, JSON and PNG. */

import { shownEnds } from './containers.js';
import { routeEdge, pathData, edgePorts, labelPoint, drawnPoints } from './routing.js';
import { pagePaths, drawingSvg } from './core/draw/render.js';
import { chartSvg } from './core/charts.js';
import { ownChartSpec } from './core/formats/chart-object.js';
import { mathSvg } from './core/math.js';
import { svgToPrimitives } from './core/svg-primitives.js';
import { fromBase64 } from './core/formats/odf.js';

/** What Graphs draws itself among its drawing objects: charts and formulas, filling their boxes. */
export function customKind(o) {
  const fill = (svg) => svg.replace(/<svg ([^>]*?)width="[^"]*" height="[^"]*"/, `<svg $1width="${o.w}" height="${o.h}" preserveAspectRatio="xMidYMid meet"`);
  if (o.kind === 'chart') return { defs: '', content: fill(chartSvg(ownChartSpec(o), { width: o.w, height: o.h, background: '#ffffff', text: '#222222' })) };
  if (o.kind === 'formula') {
    const svg = mathSvg({ tex: o.tex ?? '', mathml: o.mathml, display: true });
    return { defs: '', content: svg ? fill(svg) : `<text x="4" y="20" font-size="14">${String(o.tex ?? '').replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</text>` };
  }
  return null;
}


const escape = (value) => String(value ?? '')
  .replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));

const round = (value) => Math.round(value * 100) / 100;

/** What a drawing object of Graphs looks like with no line or area of its own. */
const OBJECT_DEFAULTS = { line: { color: '#333333', width: 2 }, fill: { type: 'solid', color: '#729fcf' } };

/** The drawing's extent, with room to breathe. */
export function bounds(model, padding = 20) {
  const things = [...model.nodes, ...(model.objects ?? [])];
  if (things.length === 0) {
    return { x: 0, y: 0, width: 200, height: 200 };
  }

  const xs = things.flatMap((n) => [n.x, n.x + n.w]);
  const ys = things.flatMap((n) => [n.y, n.y + n.h]);

  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;

  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX + padding,
    height: Math.max(...ys) - minY + padding,
  };
}

/** A node as a drawing object: its shape, place and its style's fill and outline. */
export function nodeObject(node, style = {}) {
  return {
    id: node.id, kind: 'shape', shape: node.shape, ...(node.geometry ? { geometry: node.geometry } : {}), x: node.x, y: node.y, w: node.w, h: node.h, rotation: node.rotation ?? 0,
    ...(node.mods ? { mods: node.mods } : {}), ...(node.flipH ? { flipH: true } : {}), ...(node.flipV ? { flipV: true } : {}),
    fillLook: node.fillLook ?? (style.fill === 'none' ? { type: 'none' } : { type: 'solid', color: style.fill ?? '#ffffff' }),
    line: node.line ?? (style.stroke === 'none' ? { style: 'none' } : { color: style.stroke ?? '#333333', width: style.strokeWidth ?? 2 }),
    ...(node.shadow ? { shadow: true } : {}),
  };
}

/** The outline of one node, as SVG paths where it sits. */
export function shapeMarkup(node, style) {
  return pagePaths(nodeObject(node, style)).map((p) => `<path d="${p.d}" fill="${escape(p.fill ?? 'none')}" stroke="${escape(p.stroke ?? 'none')}" stroke-width="${round(p.strokeWidth)}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ''} fill-rule="evenodd"/>`).join('');
}

/** The SVG attributes of a node's text look: weight, slant, lines, size, colour and alignment. */
export function textAttributes(look = {}) {
  const decoration = [look.underline || look.double ? 'underline' : null, look.strike ? 'line-through' : null, look.overline ? 'overline' : null].filter(Boolean).join(' ');
  const anchor = { left: 'start', right: 'end' }[look.align] ?? 'middle';
  return {
    anchor,
    size: look.size ?? 13,
    attrs: `text-anchor="${anchor}" font-family="${escape(look.font ?? 'sans-serif')}" font-size="${look.size ?? 13}" fill="${escape(look.color ?? '#222222')}"`
      + `${look.bold ? ' font-weight="700"' : ''}${look.italic ? ' font-style="italic"' : ''}${decoration ? ` text-decoration="${decoration}"` : ''}`
      + `${look.smallcaps ? ' font-variant="small-caps"' : ''}${look.outline ? ' stroke="#222222" stroke-width="0.6" fill-opacity="0"' : ''}`,
  };
}

/** A node's lines with what its list puts before each paragraph. */
export function listedLines(node) {
  const look = node.textLook ?? {};
  const paragraphs = String(node.text ?? '').split('\n');
  const marked = look.list ? paragraphs.map((p, i) => `${look.list === 'number' ? `${i + 1}.` : '•'} ${p}`).join('\n') : node.text;
  return textLines(marked, node.w - (look.indent ?? 0));
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

  // Drawing objects first, under the connectors and nodes, as the canvas shows them.
  for (const o of [...(model.objects ?? [])].sort((p, q) => (p.z ?? 0) - (q.z ?? 0))) {
    const turn = o.rotation ? ` rotate(${round(o.rotation)} ${round(o.w / 2)} ${round(o.h / 2)})` : '';
    parts.push(`<g transform="translate(${round(o.x)} ${round(o.y)})${turn}">${drawingSvg(o, { objects: model.objects, image: (x) => x.resource, custom: customKind, idPrefix: `x${parts.length}`, defaults: OBJECT_DEFAULTS })}</g>`);
  }

  // One arrowhead definition, referenced by every connector.
  parts.push(
    '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
    + 'markerHeight="6" orient="auto-start-reverse">'
    + '<path d="M 0 0 L 10 5 L 0 10 z" fill="#333333"/></marker></defs>',
  );

  for (const edge of model.edges) {
    // A dangling edge is simply not drawn; one into a closed container ends at the container.
    const ends = shownEnds(model, edge);
    if (!ends) continue;
    const { from, to } = ends;

    const points = routeEdge(edge, from, to);
    const ports = edgePorts(edge, from, to);
    parts.push(
      `<path d="${pathData(points, edge.routing, ports)}" fill="none" stroke="#333333" `
      + 'stroke-width="2" marker-end="url(#a)"/>',
    );

    if (edge.label) {
      const middle = labelPoint(points, edge.routing, ports);
      parts.push(
        `<text x="${round(middle.x)}" y="${round(middle.y - 6)}" text-anchor="middle" `
        + `font-family="sans-serif" font-size="12" fill="#333333">${escape(edge.label)}</text>`,
      );
    }
  }

  for (const node of model.nodes) {
    if (node.hidden) continue;
    const style = model.styles[node.style] ?? model.styles.default ?? {};
    parts.push(shapeMarkup(node, style));
    const look = node.textLook ?? {};
    const text = textAttributes(look);
    const lines = listedLines(node);
    const step = text.size * 1.15 * (look.lineSpacing ?? 1);
    const middle = look.valign === 'top' ? node.y + text.size + 4 : look.valign === 'bottom' ? node.y + node.h - (lines.length - 1) * step - 6 : node.y + node.h / 2 - ((lines.length - 1) * step) / 2 + text.size * 0.38;
    const x = text.anchor === 'start' ? node.x + 6 + (look.indent ?? 0) : text.anchor === 'end' ? node.x + node.w - 6 : node.x + node.w / 2;
    lines.forEach((line, i) => {
      parts.push(`<text x="${round(x)}" y="${round(middle + i * step)}" ${text.attrs}>${escape(line)}</text>`);
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

  for (const o of [...(model.objects ?? [])].sort((p, q) => (p.z ?? 0) - (q.z ?? 0))) {
    const at = { ...o, x: o.x + ox, y: o.y + oy };
    if (o.kind === 'image') {
      const m = /^data:[\w/+.-]+;base64,(.*)$/.exec(String(o.resource ?? ''));
      if (m) primitives.push({ type: 'image', bytes: fromBase64(m[1]), x: at.x, y: at.y, w: o.w, h: o.h, stretch: true, ...(o.crop ? { crop: o.crop } : {}) });
    } else if (o.kind === 'chart' || o.kind === 'formula') {
      const drawn = customKind(o);
      if (drawn) primitives.push(...svgToPrimitives(`<svg xmlns="http://www.w3.org/2000/svg" width="${o.w}" height="${o.h}">${drawn.content}</svg>`, { x: at.x, y: at.y }));
    } else {
      const placed = model.objects.map((x) => ({ ...x, x: x.x + ox, y: x.y + oy }));
      for (const p of pagePaths(at, placed, OBJECT_DEFAULTS)) primitives.push({ type: 'path', d: p.d, fill: p.fill, ...(p.stroke ? { stroke: p.stroke, strokeWidth: p.strokeWidth } : {}) });
    }
  }

  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));

  for (const edge of model.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) continue;

    const ports = edgePorts(edge, from, to);
    const route = routeEdge(edge, from, to);
    const points = drawnPoints(route, edge.routing, ports).map((p) => [p.x + ox, p.y + oy]);
    primitives.push({ type: 'polyline', points, stroke: '#333333', strokeWidth: 2 });

    if (edge.label) {
      const middle = labelPoint(route, edge.routing, ports);
      primitives.push({
        type: 'text', x: middle.x + ox, y: middle.y + oy - 14, text: edge.label,
        size: 10, align: 'center', fill: '#333333',
      });
    }
  }

  for (const node of model.nodes) {
    const style = model.styles[node.style] ?? model.styles.default ?? {};
    const x = node.x + ox;
    const y = node.y + oy;

    for (const p of pagePaths(nodeObject({ ...node, x, y }, style))) {
      primitives.push({ type: 'path', d: p.d, fill: p.fill, ...(p.stroke ? { stroke: p.stroke, strokeWidth: p.strokeWidth } : {}) });
    }

    const look = node.textLook ?? {};
    const size = Math.round((look.size ?? 13) * 0.85);
    const lines = listedLines(node);
    const step = size * 1.25 * (look.lineSpacing ?? 1);
    const startY = y + node.h / 2 - ((lines.length - 1) * step) / 2 - 4;
    const align = { left: 'left', right: 'right' }[look.align] ?? 'center';
    lines.forEach((line, i) => {
      primitives.push({
        type: 'text', x: align === 'left' ? x + 6 : align === 'right' ? x + node.w - 6 : x + node.w / 2, y: startY + i * step,
        text: line, size, align, fill: look.color ?? '#222222', bold: Boolean(look.bold), italic: Boolean(look.italic),
      });
    });
  }

  return { width: box.width, height: box.height, primitives };
}

