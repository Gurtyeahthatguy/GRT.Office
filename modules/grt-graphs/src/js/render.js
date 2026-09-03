/** Model to SVG, on screen. */

import { routeEdge, pathData } from './routing.js';
import { shapeMarkup, textLines } from './export.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class Renderer {
  /**
   * @param {SVGSVGElement} svg
   */
  constructor(svg) {
    this.svg = svg;
    this.view = { x: 0, y: 0, scale: 1 };

    this.layers = {
      grid: document.createElementNS(SVG_NS, 'g'),
      edges: document.createElementNS(SVG_NS, 'g'),
      nodes: document.createElementNS(SVG_NS, 'g'),
      overlay: document.createElementNS(SVG_NS, 'g'),
    };

    // Edges under nodes, overlay above everything.
    this.root = document.createElementNS(SVG_NS, 'g');
    for (const layer of Object.values(this.layers)) this.root.append(layer);

    this.svg.append(defs(), this.root);
    this.applyView();
  }

  /** Screen coordinates to diagram coordinates. */
  toDiagram(clientX, clientY) {
    const box = this.svg.getBoundingClientRect();
    return {
      x: (clientX - box.left) / this.view.scale + this.view.x,
      y: (clientY - box.top) / this.view.scale + this.view.y,
    };
  }

  applyView() {
    const { x, y, scale } = this.view;
    this.root.setAttribute('transform', `scale(${scale}) translate(${-x} ${-y})`);
  }

  panBy(dx, dy) {
    this.view.x -= dx / this.view.scale;
    this.view.y -= dy / this.view.scale;
    this.applyView();
  }

  /**
   * Zoom centred on a point, so the diagram does not slide away under the
   * cursor.
   */
  zoomAt(clientX, clientY, factor) {
    const before = this.toDiagram(clientX, clientY);
    this.view.scale = Math.min(Math.max(this.view.scale * factor, 0.1), 8);
    const after = this.toDiagram(clientX, clientY);
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
    this.applyView();
  }

  /**
   * Zoom from a button: centred on the canvas, not on the window's corner.
   */
  zoomCentre(factor) {
    const box = this.svg.getBoundingClientRect();
    this.zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
  }

  fit(model, padding = 40) {
    if (model.nodes.length === 0) {
      this.view = { x: 0, y: 0, scale: 1 };
      this.applyView();
      return;
    }

    const xs = model.nodes.flatMap((n) => [n.x, n.x + n.w]);
    const ys = model.nodes.flatMap((n) => [n.y, n.y + n.h]);
    const width = Math.max(...xs) - Math.min(...xs) + padding * 2;
    const height = Math.max(...ys) - Math.min(...ys) + padding * 2;
    const box = this.svg.getBoundingClientRect();

    this.view.scale = Math.min(Math.max(Math.min(box.width / width, box.height / height), 0.1), 4);
    this.view.x = Math.min(...xs) - padding;
    this.view.y = Math.min(...ys) - padding;
    this.applyView();
  }

  /** Redraws everything from the model. */
  draw(model, selection = new Set(), extras = {}) {
    this.drawGrid(model);

    const nodesById = new Map(model.nodes.map((n) => [n.id, n]));

    this.layers.edges.replaceChildren(
      ...model.edges.flatMap((edge) => {
        const from = nodesById.get(edge.from);
        const to = nodesById.get(edge.to);
        if (!from || !to) return [];
        return edgeElements(edge, routeEdge(edge, from, to), selection.has(edge.id));
      }),
    );

    this.layers.nodes.replaceChildren(
      ...model.nodes.map((node) => nodeElement(node, model, selection.has(node.id))),
    );

    this.layers.overlay.replaceChildren(...overlayElements(model, selection, extras));
  }

  drawGrid(model) {
    const size = model.meta.gridSize ?? 10;
    // Redrawn only when the spacing changes.
    if (this.layers.grid.dataset.size === String(size)) return;
    this.layers.grid.dataset.size = String(size);

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '-100000');
    rect.setAttribute('y', '-100000');
    rect.setAttribute('width', '200000');
    rect.setAttribute('height', '200000');
    rect.setAttribute('fill', 'url(#grid)');
    this.layers.grid.replaceChildren(rect);
  }
}

function defs() {
  const element = document.createElementNS(SVG_NS, 'defs');
  element.innerHTML = `
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" class="arrowhead"/>
    </marker>
    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" class="gridline" stroke-width="1"/>
    </pattern>`;
  return element;
}

function nodeElement(node, model, selected) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', `node${selected ? ' selected' : ''}`);
  group.dataset.id = node.id;

  const style = model.styles[node.style] ?? model.styles.default ?? {};
  group.innerHTML = shapeMarkup(node, style);

  const lines = textLines(node.text, node.w);
  const startY = node.y + node.h / 2 - ((lines.length - 1) * 15) / 2 + 5;

  lines.forEach((line, i) => {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(node.x + node.w / 2));
    text.setAttribute('y', String(startY + i * 15));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'node-text');
    text.textContent = line;
    group.append(text);
  });

  return group;
}

function edgeElements(edge, points, selected) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData(points, edge.routing));
  path.setAttribute('class', `edge${selected ? ' selected' : ''}`);
  path.setAttribute('marker-end', 'url(#arrow)');
  path.dataset.id = edge.id;

  // An invisible fat copy underneath.
  const hit = document.createElementNS(SVG_NS, 'path');
  hit.setAttribute('d', path.getAttribute('d'));
  hit.setAttribute('class', 'edge-hit');
  hit.dataset.id = edge.id;

  const elements = [hit, path];

  if (edge.label) {
    const middle = points[Math.floor(points.length / 2)];
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(middle.x));
    label.setAttribute('y', String(middle.y - 6));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'edge-label');
    label.dataset.id = edge.id;
    label.textContent = edge.label;
    elements.push(label);
  }

  return elements;
}

/** Selection handles, connection ports and whatever is being dragged. */
function overlayElements(model, selection, extras) {
  const elements = [];

  const selectedNodes = model.nodes.filter((n) => selection.has(n.id));

  for (const node of selectedNodes) {
    for (const [name, point] of Object.entries(handlePoints(node))) {
      const handle = document.createElementNS(SVG_NS, 'rect');
      handle.setAttribute('x', String(point.x - 4));
      handle.setAttribute('y', String(point.y - 4));
      handle.setAttribute('width', '8');
      handle.setAttribute('height', '8');
      handle.setAttribute('class', 'handle');
      handle.dataset.handle = name;
      handle.dataset.id = node.id;
      elements.push(handle);
    }
  }

  // Ports appear on a single selected node, which is when connecting is what
  // the user is most likely about to do.
  if (selectedNodes.length === 1) {
    const node = selectedNodes[0];
    for (const port of ['top', 'right', 'bottom', 'left']) {
      const point = portCentre(node, port);
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(point.x));
      dot.setAttribute('cy', String(point.y));
      dot.setAttribute('r', '5');
      dot.setAttribute('class', 'port');
      dot.dataset.port = port;
      dot.dataset.id = node.id;
      elements.push(dot);
    }
  }

  if (extras.rubberBand) {
    const { x, y, w, h } = extras.rubberBand;
    const band = document.createElementNS(SVG_NS, 'rect');
    band.setAttribute('x', String(x));
    band.setAttribute('y', String(y));
    band.setAttribute('width', String(w));
    band.setAttribute('height', String(h));
    band.setAttribute('class', 'rubber-band');
    elements.push(band);
  }

  if (extras.pendingEdge) {
    const { from, to } = extras.pendingEdge;
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
    line.setAttribute('class', 'pending-edge');
    elements.push(line);
  }

  for (const guide of extras.guides ?? []) {
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', guide.vertical
      ? `M ${guide.at} ${guide.from} L ${guide.at} ${guide.to}`
      : `M ${guide.from} ${guide.at} L ${guide.to} ${guide.at}`);
    line.setAttribute('class', 'guide');
    elements.push(line);
  }

  return elements;
}

export function handlePoints(node) {
  return {
    nw: { x: node.x, y: node.y },
    ne: { x: node.x + node.w, y: node.y },
    sw: { x: node.x, y: node.y + node.h },
    se: { x: node.x + node.w, y: node.y + node.h },
  };
}

export function portCentre(node, port) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  switch (port) {
    case 'top': return { x: cx, y: node.y };
    case 'bottom': return { x: cx, y: node.y + node.h };
    case 'left': return { x: node.x, y: cy };
    default: return { x: node.x + node.w, y: cy };
  }
}
