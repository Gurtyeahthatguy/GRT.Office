/** Containers: what lies inside moves with them, closed they hide it and take its connectors, and canvas groups are containers. */

import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/js/model.js';
import { makeContainer, membersOf, withMembers, toggleContainer, shownEnds } from '../src/js/containers.js';
import { readCanvas, writeCanvas } from '../src/js/core/formats/canvas.js';
import { toSvg } from '../src/js/export.js';

function diagram() {
  const m = new GraphModel();
  const a = m.addNode({ x: 100, y: 100, w: 100, h: 50, text: 'Dentro A' });
  const b = m.addNode({ x: 260, y: 100, w: 100, h: 50, text: 'Dentro B' });
  const out = m.addNode({ x: 600, y: 100, w: 100, h: 50, text: 'Fuori' });
  const inner = m.addEdge({ from: a.id, to: b.id });
  const across = m.addEdge({ from: b.id, to: out.id });
  const box = makeContainer(m, [a.id, b.id]);
  return { m, a, b, out, inner, across, box };
}

describe('Containers', () => {
  it('drawn round the nodes chosen, they hold them and carry them', () => {
    const { m, a, b, out, box } = diagram();
    expect(membersOf(m, m.node(box)).map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(withMembers(m, [box]).sort()).toEqual([box, a.id, b.id].sort());
    expect(withMembers(m, [box])).not.toContain(out.id);
    expect(m.nodes[0].id).toBe(box);
  });

  it('closed, they hide what they hold: connectors inside go, connectors across arrive at the container; opened, all comes back', () => {
    const { m, a, inner, across, box } = diagram();
    const wide = m.node(box).w;
    toggleContainer(m, box);
    expect(m.node(a.id).hidden).toBe(true);
    expect(m.node(box).h).toBe(40);
    expect(shownEnds(m, inner)).toBeNull();
    expect(shownEnds(m, across).from.id).toBe(box);
    expect(toSvg(m)).not.toContain('Dentro A');
    toggleContainer(m, box);
    expect(m.node(a.id).hidden).toBeUndefined();
    expect(m.node(box).w).toBe(wide);
    expect(shownEnds(m, inner).from.id).toBe(a.id);
  });

  it('a canvas group comes in as a container and goes out as a group, open', () => {
    const canvas = JSON.stringify({ nodes: [
      { id: 'g', type: 'group', label: 'Gruppo', x: 0, y: 0, width: 400, height: 300 },
      { id: 't', type: 'text', text: 'Dentro', x: 40, y: 80, width: 120, height: 60 },
    ], edges: [] });
    const m = new GraphModel(readCanvas(canvas).document);
    expect(m.node('g').container).toBe(true);
    expect(membersOf(m, m.node('g')).map((n) => n.id)).toEqual(['t']);
    toggleContainer(m, 'g');
    const back = JSON.parse(writeCanvas(m.toJSON()).text);
    expect(back.nodes.find((n) => n.id === 'g')).toMatchObject({ type: 'group', label: 'Gruppo', width: 400, height: 300 });
    const made = new GraphModel();
    made.addNode({ x: 0, y: 0, text: 'x' });
    makeContainer(made, []);
    expect(JSON.parse(writeCanvas(made.toJSON()).text).nodes.some((n) => n.type === 'group')).toBe(true);
  });
});
