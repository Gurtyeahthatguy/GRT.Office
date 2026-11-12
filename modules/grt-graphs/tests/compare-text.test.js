// @vitest-environment jsdom

/** Diagrams compared, and written as text and read back. */

import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/js/model.js';
import { compareDiagrams, isSame } from '../src/js/compare.js';
import { toMermaid, applyMermaid } from '../src/js/diagram-text.js';

function diagram() {
  const model = new GraphModel();
  const a = model.addNode({ x: 0, y: 0, text: 'Start' });
  const b = model.addNode({ x: 300, y: 0, text: 'Check stock', shape: 'diamond' });
  const c = model.addNode({ x: 600, y: 0, text: 'Ship "fast"' });
  model.edges.push({ id: 'e1', from: a.id, to: b.id, label: '', fromPort: 'auto', toPort: 'auto', routing: 'orthogonal', waypoints: [], data: {} });
  model.edges.push({ id: 'e2', from: b.id, to: c.id, label: 'yes', fromPort: 'auto', toPort: 'auto', routing: 'orthogonal', waypoints: [], data: {} });
  return { model, a, b, c };
}

describe('comparing diagrams', () => {
  it('finds nothing between a diagram and itself', () => {
    const { model } = diagram();
    expect(isSame(compareDiagrams(model, model.toJSON()))).toBe(true);
  });

  it('finds what was added, changed, moved and taken away, nodes and lines', () => {
    const { model, a, b, c } = diagram();
    const old = model.toJSON();
    model.setText(b.id, 'Check stock twice');
    model.moveNodes([a.id], 50, 0);
    model.deleteNodes([c.id]);
    const d = model.addNode({ x: 0, y: 200, text: 'Refund' });
    model.edges.push({ id: 'e3', from: b.id, to: d.id, label: 'no', fromPort: 'auto', toPort: 'auto', routing: 'orthogonal', waypoints: [], data: {} });
    const diff = compareDiagrams(model, old);
    expect([...diff.added]).toEqual([d.id]);
    expect([...diff.changed]).toEqual([b.id]);
    expect([...diff.moved]).toEqual([a.id]);
    expect(diff.removed.map((n) => n.text)).toEqual(['Ship "fast"']);
    expect([...diff.addedEdges]).toEqual(['e3']);
    expect(diff.removedEdges.map((e) => e.id)).toEqual(['e2']);
  });
});

describe('a diagram as text', () => {
  it('is written as Mermaid and read back the same, places and looks kept', () => {
    const { model } = diagram();
    const before = model.toJSON();
    const text = toMermaid(model);
    expect(text).toMatch(/^flowchart TD/);
    applyMermaid(model, text);
    expect(isSame(compareDiagrams(model, before))).toBe(true);
  });

  it('takes edits: a new node and line come in, a node no longer written goes', () => {
    const { model, a, c } = diagram();
    const text = toMermaid(model).replace(new RegExp(`.*${c.id}.*\\n`, 'g'), '') + `  ${a.id} --> late[Late step]\n`;
    const { added, removed } = applyMermaid(model, text);
    expect([added, removed]).toEqual([1, 1]);
    expect(model.nodes.map((n) => n.text)).toEqual(['Start', 'Check stock', 'Late step']);
    expect(model.edges.length).toBe(2);
    expect(model.node(a.id).x).toBe(0);
  });
});
