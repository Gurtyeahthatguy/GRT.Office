/** Mind maps: children and siblings in their places, the layout from the root, a list to a map and back. */

import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/js/model.js';
import { addChild, addSibling, childrenOf, rootOf, mindMapLayout, listToMap, mapToList } from '../src/js/mindmap.js';

describe('Mind maps', () => {
  it('Tab makes a child, Enter a sibling just after, and the layout keeps the root and stacks the children to its right', () => {
    const m = new GraphModel();
    const root = m.addNode({ x: 100, y: 200, text: 'Viaggio' }).id;
    const a = addChild(m, root, 'Treni');
    const c = addChild(m, root, 'Alberghi');
    const b = addSibling(m, a, 'Aerei');
    const a1 = addChild(m, a, 'Orari');
    expect(childrenOf(m, root)).toEqual([a, b, c]);
    expect(rootOf(m, a1)).toBe(root);
    mindMapLayout(m, a1);
    const n = (id) => m.node(id);
    expect(n(root)).toMatchObject({ x: 100, y: 200 });
    for (const id of [a, b, c]) expect(n(id).x).toBe(100 + n(root).w + 60);
    expect(n(a).y).toBeLessThan(n(b).y);
    expect(n(b).y).toBeLessThan(n(c).y);
    expect(n(a1).x).toBeGreaterThan(n(a).x);
    const centre = (id) => n(id).y + n(id).h / 2;
    expect(Math.abs(centre(root) - (centre(a) + centre(c)) / 2)).toBeLessThan(1);
  });

  it('a list becomes a map and the map the same list', () => {
    const list = '- Viaggio\n  - Treni\n    - Orari\n  - Aerei\n';
    const doc = listToMap(list);
    expect(doc.nodes.map((x) => x.text)).toEqual(['Viaggio', 'Treni', 'Orari', 'Aerei']);
    const m = new GraphModel(doc);
    expect(mapToList(m, m.nodes[2].id)).toBe(list);
    expect(new Set(m.nodes.map((x) => `${x.x},${x.y}`)).size).toBe(4);
  });

  it('a list with several top lines hangs them from one root', () => {
    const doc = listToMap('Uno\nDue\n\tTre');
    expect(doc.nodes[0].text).toBe('Map');
    expect(doc.edges.map((e) => [e.from, e.to])).toEqual([['n0', 'n1'], ['n0', 'n2'], ['n2', 'n3']]);
  });
});
