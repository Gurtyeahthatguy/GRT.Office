/** JSON Canvas, the open format Obsidian keeps canvases in, to and from Graphs' document. */

import { Losses } from '../losses.js';

const PRESETS = { 1: '#fb464c', 2: '#e9973f', 3: '#e0de71', 4: '#44cf6e', 5: '#53dfdd', 6: '#a882ff' };
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const NODE_ORDER = ['id', 'type', 'text', 'file', 'subpath', 'url', 'label', 'x', 'y', 'width', 'height', 'color'];
const EDGE_ORDER = ['id', 'fromNode', 'fromSide', 'fromEnd', 'toNode', 'toSide', 'toEnd', 'color', 'label'];

/** A colour a little of the way from white, for a card's fill. */
function tint(hex, amount = 0.18) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${[r, g, b].map((c) => Math.round(255 - (255 - c) * amount).toString(16).padStart(2, '0')).join('')}`;
}

const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/**
 * @param {string} text the .canvas file
 * @returns {{document: object, losses: Losses}}
 */
export function readCanvas(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This canvas is not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('This is not a canvas');
  const losses = new Losses();
  const styles = {
    default: { fill: '#ffffff', stroke: '#333333', strokeWidth: 2 },
    accent: { fill: '#e8f0fe', stroke: '#1f6feb', strokeWidth: 2 },
    warn: { fill: '#fff4e5', stroke: '#b26a00', strokeWidth: 2 },
    'canvas-group': { fill: 'none', stroke: '#888888', strokeWidth: 2 },
  };
  const styleFor = (color, group) => {
    const hex = PRESETS[color] ?? (isHex(color) ? color.toLowerCase() : null);
    if (!hex) return group ? 'canvas-group' : 'default';
    const name = `canvas-${group ? 'group-' : ''}${PRESETS[color] ? color : hex.slice(1)}`;
    styles[name] ??= { fill: group ? 'none' : tint(hex), stroke: hex, strokeWidth: 2 };
    return name;
  };

  const nodes = [];
  const ids = new Set();
  for (const raw of Array.isArray(data.nodes) ? data.nodes : []) {
    if (!raw || typeof raw.id !== 'string' || ids.has(raw.id)) continue;
    ids.add(raw.id);
    const group = raw.type === 'group';
    let label = '';
    if (raw.type === 'text') label = String(raw.text ?? '');
    else if (raw.type === 'file') {
      label = `${raw.file ?? ''}${raw.subpath ?? ''}`;
      losses.add('Notes and files on the canvas, shown by name');
    } else if (raw.type === 'link') {
      label = String(raw.url ?? '');
      losses.add('Web pages on the canvas, shown by address');
    } else if (group) {
      label = String(raw.label ?? '');
      if (raw.background) losses.add('Group backgrounds');
    } else {
      losses.add('Cards of kinds Graphs does not know, shown empty');
    }
    nodes.push({
      id: raw.id,
      shape: group ? 'rect' : 'rounded',
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      w: Math.max(20, Number(raw.width) || 250),
      h: Math.max(20, Number(raw.height) || 60),
      text: label,
      style: styleFor(raw.color, group),
      canvas: raw,
      data: {},
    });
  }

  const edges = [];
  for (const raw of Array.isArray(data.edges) ? data.edges : []) {
    if (!raw || !ids.has(raw.fromNode) || !ids.has(raw.toNode)) {
      losses.add('Lines whose ends are missing, left out');
      continue;
    }
    const fromEnd = raw.fromEnd ?? 'none';
    const toEnd = raw.toEnd ?? 'arrow';
    if (fromEnd !== 'none' || toEnd !== 'arrow') losses.add('Lines with no arrowhead or two, drawn with one');
    if (raw.color) losses.add('Line colours');
    edges.push({
      id: String(raw.id ?? `edge-${edges.length + 1}`),
      from: raw.fromNode,
      to: raw.toNode,
      fromPort: SIDES.has(raw.fromSide) ? raw.fromSide : 'auto',
      toPort: SIDES.has(raw.toSide) ? raw.toSide : 'auto',
      routing: 'curved',
      label: String(raw.label ?? ''),
      style: 'arrow',
      waypoints: [],
      canvas: raw,
      data: {},
    });
  }

  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'nodes' && key !== 'edges'));
  return {
    document: {
      version: 1, type: 'graphs', nodes, edges, styles,
      meta: { gridSize: 10, snapToGrid: true, canvas: { layout: layoutOf(text), rest, keys: Object.keys(data) } },
    },
    losses,
  };
}

/** Sets a field, keeping the place it had and putting a new one where the format usually has it. */
function place(object, key, value, order) {
  if (value === undefined) {
    delete object[key];
    return object;
  }
  if (key in object) {
    object[key] = value;
    return object;
  }
  const entries = Object.entries(object);
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  const at = entries.findIndex(([k]) => rank(k) > rank(key));
  entries.splice(at === -1 ? entries.length : at, 0, [key, value]);
  return Object.fromEntries(entries);
}

/** The colour a card or line is written with, from its Graphs style. */
function colorOf(styleName, styles) {
  const preset = /^canvas-(?:group-)?([1-6])$/.exec(styleName);
  if (preset) return preset[1];
  const hex = /^canvas-(?:group-)?([0-9a-f]{6})$/i.exec(styleName);
  if (hex) return `#${hex[1]}`;
  if (styleName === 'default' || styleName === 'canvas-group' || !styles[styleName]) return undefined;
  return isHex(styles[styleName].stroke) ? styles[styleName].stroke : undefined;
}

/**
 * @param {object} document Graphs' toJSON()
 * @returns {{text: string, losses: Losses}}
 */
export function writeCanvas(document) {
  const losses = new Losses();
  const styles = document.styles ?? {};
  const nodes = (document.nodes ?? []).map((node) => {
    const original = node.canvas;
    let card = original ? { ...original } : { id: node.id, type: 'text' };
    const set = (key, value) => { card = place(card, key, value, NODE_ORDER); };
    const number = (key, value) => {
      if (original && Number(original[key]) === value) return;
      set(key, Math.round(value));
    };
    if (card.type === 'text') set('text', node.text);
    else if (card.type === 'group') set('label', node.text === '' ? undefined : node.text);
    else if (original && node.text !== (card.type === 'link' ? card.url : `${card.file ?? ''}${card.subpath ?? ''}`)) {
      losses.add('Names of notes, files and pages changed in Graphs, kept as they were');
    }
    number('x', node.x);
    number('y', node.y);
    number('width', node.w);
    number('height', node.h);
    const color = colorOf(node.style, styles);
    if (!(original && original.color === color) && !(color === undefined && !('color' in card))) set('color', color);
    if (!original && node.shape !== 'rounded' && node.shape !== 'rect') losses.add('Shapes, which canvas cards do not have');
    return card;
  });
  const edges = (document.edges ?? []).map((edge) => {
    const original = edge.canvas;
    let line = original ? { ...original } : { id: edge.id };
    const set = (key, value) => { line = place(line, key, value, EDGE_ORDER); };
    set('fromNode', edge.from);
    set('toNode', edge.to);
    const side = (key, port) => {
      const value = SIDES.has(port) ? port : undefined;
      if (original?.[key] === value || (value === undefined && !(key in line))) return;
      set(key, value);
    };
    side('fromSide', edge.fromPort);
    side('toSide', edge.toPort);
    if (edge.label || 'label' in line) set('label', edge.label || undefined);
    if ((edge.waypoints ?? []).length > 0) losses.add('Bends placed by hand, which a canvas does not keep');
    return line;
  });

  const meta = document.meta?.canvas;
  const rest = meta?.rest ?? {};
  const keys = meta?.keys ?? ['nodes', 'edges'];
  const out = {};
  for (const key of keys) {
    if (key === 'nodes') out.nodes = nodes;
    else if (key === 'edges') out.edges = edges;
    else if (key in rest) out[key] = rest[key];
  }
  out.nodes ??= nodes;
  out.edges ??= edges;
  return { text: serialise(out, meta?.layout ?? OBSIDIAN), losses };
}


/** Obsidian's own: tabs, and each card or line on a line of its own. */
const OBSIDIAN = { lines: true, indent: '\t', space: '', newline: false };

function layoutOf(text) {
  const indent = /^\{[ \t]*\r?\n([ \t]+)"/.exec(text)?.[1] ?? '';
  return {
    lines: /\[[ \t]*\r?\n[ \t]+\{"/.test(text),
    indent,
    space: /"nodes":\s/.test(text) ? ' ' : '',
    newline: text.endsWith('\n'),
    compact: indent === '' && !text.includes('\n'),
  };
}

function serialise(data, layout) {
  let text;
  if (layout.compact) text = JSON.stringify(data);
  else if (!layout.lines) text = JSON.stringify(data, null, layout.indent || '\t');
  else {
    const { indent, space } = layout;
    const fields = Object.entries(data).map(([key, value]) => {
      if (!Array.isArray(value)) return `${indent}${JSON.stringify(key)}:${space}${JSON.stringify(value)}`;
      if (value.length === 0) return `${indent}${JSON.stringify(key)}:${space}[]`;
      const items = value.map((item) => `${indent}${indent}${JSON.stringify(item)}`).join(',\n');
      return `${indent}${JSON.stringify(key)}:${space}[\n${items}\n${indent}]`;
    });
    text = `{\n${fields.join(',\n')}\n}`;
  }
  return layout.newline ? `${text}\n` : text;
}
