// @vitest-environment jsdom

/** Diagrams in other programs' formats: OpenDocument drawings and JSON Canvas. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readOdg, writeOdg } from '../src/js/core/formats/odg.js';
import { readCanvas, writeCanvas } from '../src/js/core/formats/canvas.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { GraphModel } from '../src/js/model.js';
import {
  oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert, pdfPages,
} from '../../../scripts/oracle.mjs';

const through = (entries) => decodeBlock(encodeBlock(entries));

function diagram() {
  const model = new GraphModel();
  const start = model.addNode({ x: 40, y: 40, text: 'Start', shape: 'rounded' });
  const check = model.addNode({ x: 300, y: 40, text: 'Check  twice', shape: 'diamond', style: 'accent' });
  const done = model.addNode({ x: 300, y: 220, text: 'Done\nfor today', shape: 'ellipse', style: 'warn' });
  model.styles.mine = { fill: '#ffeeaa', stroke: '#aa5500', strokeWidth: 3 };
  const extra = model.addNode({ x: 40, y: 220, text: 'Mine', shape: 'hexagon', style: 'mine' });
  model.addEdge({ from: start.id, to: check.id, label: 'go' });
  model.addEdge({ from: check.id, to: done.id, fromPort: 'bottom', toPort: 'top', routing: 'straight' });
  model.addEdge({ from: done.id, to: extra.id, routing: 'curved' });
  return model;
}

const view = (document) => ({
  nodes: document.nodes.map((n) => ({ shape: n.shape, x: n.x, y: n.y, w: n.w, h: n.h, text: n.text, look: document.styles[n.style] })),
  edges: document.edges.map((e) => {
    const index = (id) => document.nodes.findIndex((n) => n.id === id);
    return { from: index(e.from), to: index(e.to), fromPort: e.fromPort, toPort: e.toPort, routing: e.routing, label: e.label };
  }),
});

describe('OpenDocument drawings', () => {
  it('come back as they were written, packed or flat', () => {
    const model = diagram();
    const { entries, losses } = writeOdg(model.toJSON());
    expect(losses.empty).toBe(true);
    const packed = readOdg(through(entries));
    expect(packed.losses.empty).toBe(true);
    expect(view(packed.document)).toEqual(view(model.toJSON()));
    const flat = readOdg(writeOdg(model.toJSON(), { flat: true }).text);
    expect(view(flat.document)).toEqual(view(model.toJSON()));
  });

  it('move a drawing that reaches left of the page onto it, keeping its shape', () => {
    const model = diagram();
    model.moveNodes(model.nodes.map((n) => n.id), -100, -100);
    const back = readOdg(through(writeOdg(model.toJSON()).entries)).document;
    expect(back.nodes[0].x - back.nodes[1].x).toBe(model.nodes[0].x - model.nodes[1].x);
    expect(Math.min(...back.nodes.map((n) => n.x))).toBe(20);
  });

  it('are the same, byte for byte, written twice', () => {
    expect(JSON.stringify(writeOdg(diagram().toJSON()).entries)).toBe(JSON.stringify(writeOdg(diagram().toJSON()).entries));
  });
});

describe('JSON Canvas', () => {
  const obsidian = '{\n\t"nodes":[\n'
    + '\t\t{"id":"6f0ad84f44ce9c17","type":"text","text":"An idea","x":-120,"y":-60,"width":250,"height":60},\n'
    + '\t\t{"id":"a9d0f3b1c3e4d5f6","type":"file","file":"Notes/Plan.md","x":300,"y":-60,"width":400,"height":300,"color":"4"},\n'
    + '\t\t{"id":"b1","type":"group","label":"Area","x":-200,"y":-200,"width":1000,"height":600,"color":"#8844aa"}\n'
    + '\t],\n\t"edges":[\n'
    + '\t\t{"id":"e1","fromNode":"6f0ad84f44ce9c17","fromSide":"right","toNode":"a9d0f3b1c3e4d5f6","toSide":"left","label":"leads to"}\n'
    + '\t]\n}';

  it('comes back byte for byte when nothing changed', () => {
    const { document } = readCanvas(obsidian);
    expect(writeCanvas(new GraphModel(document).toJSON()).text).toBe(obsidian);
  });

  it('reads cards, colours, groups and lines', () => {
    const { document, losses } = readCanvas(obsidian);
    const [idea, plan, group] = document.nodes;
    expect(idea).toMatchObject({ x: -120, y: -60, w: 250, h: 60, text: 'An idea', shape: 'rounded', style: 'default' });
    expect(plan).toMatchObject({ text: 'Notes/Plan.md', style: 'canvas-4' });
    expect(document.styles['canvas-4'].stroke).toBe('#44cf6e');
    expect(group).toMatchObject({ text: 'Area', style: 'canvas-group-8844aa' });
    expect(document.styles['canvas-group-8844aa'].fill).toBe('none');
    expect(document.edges[0]).toMatchObject({ fromPort: 'right', toPort: 'left', label: 'leads to' });
    expect(losses.lines()).toEqual(['Notes and files on the canvas, shown by name']);
  });

  it('writes back only what changed, where Obsidian keeps it', () => {
    const model = new GraphModel(readCanvas(obsidian).document);
    model.moveNodes([model.nodes[0].id], 10, 0);
    model.setText(model.nodes[0].id, 'A better idea');
    const lines = writeCanvas(model.toJSON()).text.split('\n');
    expect(lines[2]).toBe('\t\t{"id":"6f0ad84f44ce9c17","type":"text","text":"A better idea","x":-110,"y":-60,"width":250,"height":60},');
    expect(lines[3]).toBe(obsidian.split('\n')[3]);
  });

  it('writes a new diagram the way Obsidian writes its own, and reads it back', () => {
    const model = diagram();
    const { text } = writeCanvas(model.toJSON());
    expect(text.startsWith('{\n\t"nodes":[\n\t\t{"id":')).toBe(true);
    const back = new GraphModel(readCanvas(text).document);
    expect(back.nodes.map((n) => [n.text, n.x, n.y, n.w, n.h])).toEqual(model.nodes.map((n) => [n.text, n.x, n.y, n.w, n.h]));
    expect(back.edges.map((e) => [e.label, e.fromPort, e.toPort])).toEqual(model.edges.map((e) => [e.label, e.fromPort, e.toPort]));
  });

  it('refuses what is not a canvas', () => {
    expect(() => readCanvas('not json')).toThrow(/not valid JSON/);
    expect(() => readCanvas('[1, 2]')).toThrow(/not a canvas/);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Graphs’ .odg', () => {
  let dir;
  beforeAll(() => {
    dir = scratch();
  });
  afterAll(() => cleanup(dir));

  it('draws every shape with its text, and keeps the connectors joined when it saves', () => {
    const file = join(dir, 'diagram.odg');
    writeBlock(encodeBlock(writeOdg(diagram().toJSON()).entries), file);
    const [page] = pdfPages(convert(file, 'pdf', join(dir, 'pdf')));
    for (const word of ['Start', 'Check', 'Done', 'today', 'Mine', 'go']) expect(page).toContain(word);
    const saved = readOdg(decodeBlock(readBlock(convert(file, 'odg', join(dir, 'odg'))))).document;
    const ours = view(diagram().toJSON());
    const theirs = view(saved);
    expect(theirs.nodes.map((n) => [n.shape, n.x, n.y, n.w, n.h, n.text])).toEqual(ours.nodes.map((n) => [n.shape, n.x, n.y, n.w, n.h, n.text]));
    expect(theirs.edges.map((e) => [e.from, e.to, e.label])).toEqual(ours.edges.map((e) => [e.from, e.to, e.label]));
  }, 120000);
});
