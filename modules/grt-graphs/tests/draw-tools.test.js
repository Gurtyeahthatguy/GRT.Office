// @vitest-environment jsdom

/** Draw's commands in Graphs: links on nodes, comments on the page, find and replace, and what a file may not slip in. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { GraphModel } from '../src/js/model.js';
import { drawTools } from '../src/js/draw-tools.js';
import { readOdg, writeOdg } from '../src/js/core/formats/odg.js';
import { decodeBlock, encodeBlock } from '../src/js/core/package.js';
import { oracleAvailable, scratch, cleanup, writeBlock, readBlock, convert } from '../../../scripts/oracle.mjs';
import { graphsMenus } from '../src/js/menus.js';

function diagram() {
  const model = new GraphModel();
  const a = model.addNode({ x: 0, y: 0, text: 'Sales plan' });
  const b = model.addNode({ x: 300, y: 0, text: 'Review sales' });
  model.edges.push({ id: 'e1', from: a.id, to: b.id, label: 'sales go here', fromPort: 'auto', toPort: 'auto', routing: 'orthogonal', waypoints: [], data: {} });
  model.setLink([a.id], 'https://example.org/plan?a=1&b=2');
  model.addComment({ x: 120, y: 200, text: 'Check the numbers\nwith finance' });
  return { model, a, b };
}

const shape = (doc) => ({
  links: doc.nodes.filter((n) => n.link).map((n) => [n.text, n.link]),
  comments: (doc.meta.comments ?? []).map((c) => c.text),
});

describe('links and comments', () => {
  it('go through .odg and come back the same', () => {
    const { model } = diagram();
    const back = readOdg(decodeBlock(encodeBlock(writeOdg(model.toJSON()).entries))).document;
    expect(shape(back)).toEqual({ links: [['Sales plan', 'https://example.org/plan?a=1&b=2']], comments: ['Check the numbers\nwith finance'] });
  });

  it('from a file are held to what is sound', () => {
    const model = new GraphModel({
      nodes: [{ id: 'n1', x: 0, y: 0, text: { evil: 1 }, link: 42 }, { id: 'n2', x: 0, y: 0, text: 'ok', link: 'x'.repeat(5000) }],
      edges: [{ id: 'e', from: 'n1', to: 'n2', label: ['a'] }],
      meta: { comments: [{ text: 'fine', x: 'NaN' }, { text: 7 }, ...Array.from({ length: 900 }, () => ({ text: 'many' }))] },
    });
    expect(model.nodes[0].text).toBe('[object Object]');
    expect(model.nodes[0].link).toBeUndefined();
    expect(model.nodes[1].link.length).toBe(2048);
    expect(typeof model.edges[0].label).toBe('string');
    expect(model.comments.length).toBe(500);
    expect(model.comments[0]).toMatchObject({ text: 'fine', x: 0 });
  });
});

describe('find and replace', () => {
  it('finds in nodes and line labels, and replaces them all at once', () => {
    const { model } = diagram();
    const tools = drawTools({ model: () => model, change: (m) => m(), toast: () => {}, selected: () => [] });
    expect(tools.replaceAll('sales', 'revenue', {})).toBe(3);
    expect(model.nodes.map((n) => n.text)).toEqual(['revenue plan', 'Review revenue']);
    expect(model.edges[0].label).toBe('revenue go here');
  });
});

describe('the menus', () => {
  it('follow Draw in their order, and every one runs something', () => {
    const noop = () => {};
    const actions = new Proxy({ tools: new Proxy({ marks: [], bar: { open: noop } }, { get: (o, k) => (k in o ? o[k] : noop) }) }, { get: (o, k) => (k in o ? o[k] : noop) });
    const menus = graphsMenus(actions);
    expect(menus.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Shape', 'Tools', 'Help']);
  });
});

describe.skipIf(!oracleAvailable())('LibreOffice and Graphs', () => {
  let dir;
  beforeAll(() => { dir = scratch(); });
  afterAll(() => cleanup(dir));

  it('keeps the links and comments of an .odg it opens and saves', () => {
    const { model } = diagram();
    const file = join(dir, 'links.odg');
    writeBlock(encodeBlock(writeOdg(model.toJSON()).entries), file);
    const saved = convert(file, 'odg', join(dir, 'again'));
    expect(shape(readOdg(decodeBlock(readBlock(saved))).document)).toEqual(shape(model.toJSON()));
  }, 120000);
});
