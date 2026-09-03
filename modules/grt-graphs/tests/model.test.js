/** The graph, without a browser anywhere near it. */

import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/js/model.js';
import { UndoStack } from '../src/js/core/undo.js';
import { toJson } from '../src/js/export.js';

function twoConnectedNodes() {
  const model = new GraphModel();
  const a = model.addNode({ x: 0, y: 0, text: 'A' });
  const b = model.addNode({ x: 300, y: 0, text: 'B' });
  const edge = model.addEdge({ from: a.id, to: b.id });
  return { model, a, b, edge };
}

describe('Identifiers', () => {
  it('are not sequential, so the file does not record creation order', () => {
    const model = new GraphModel();
    const ids = Array.from({ length: 20 }, () => model.addNode({ x: 0, y: 0 }).id);

    expect(new Set(ids).size).toBe(20);
    // A counter would show up as a shared prefix and a rising tail.
    const tails = ids.map((id) => id.slice(1));
    expect(new Set(tails.map((t) => t[0])).size).toBeGreaterThan(1);
  });
});

describe('The data field belongs to the caller', () => {
  it('survives a save and load untouched', () => {
    const model = new GraphModel();
    const payload = {
      condition: 'has_key && !door_open',
      weights: [1, 2, 3],
      nested: { deep: { value: null } },
      'odd key': 'kept',
    };
    model.addNode({ x: 0, y: 0, data: payload });

    const reloaded = new GraphModel(JSON.parse(JSON.stringify(model.toJSON())));

    expect(reloaded.nodes[0].data).toEqual(payload);
  });

  it('is not reordered or normalised', () => {
    const model = new GraphModel();
    model.addNode({ x: 0, y: 0, data: { zebra: 1, apple: 2, mango: 3 } });

    const json = JSON.stringify(new GraphModel(model.toJSON()).nodes[0].data);
    expect(json).toBe('{"zebra":1,"apple":2,"mango":3}');
  });

  it('survives export to logic-only JSON', () => {
    const model = new GraphModel();
    const a = model.addNode({ x: 0, y: 0, data: { line: 'Hello' } });
    const b = model.addNode({ x: 200, y: 0 });
    model.addEdge({ from: a.id, to: b.id, data: { requires: 'gold >= 10' } });

    const exported = JSON.parse(toJson(model, { logicOnly: true }));

    expect(exported.nodes[0].data).toEqual({ line: 'Hello' });
    expect(exported.edges[0].data).toEqual({ requires: 'gold >= 10' });
    // A game should not have to read coordinates to find a condition.
    expect(exported.nodes[0].x).toBeUndefined();
  });

  it('an edge keeps its data through a reroute', () => {
    const { model, edge } = twoConnectedNodes();
    model.edge(edge.id).data = { weight: 7 };
    model.setWaypoints(edge.id, [{ x: 50, y: 50 }]);

    expect(model.edge(edge.id).data).toEqual({ weight: 7 });
  });
});

describe('Deleting a node', () => {
  it('takes its connectors with it', () => {
    const { model, a } = twoConnectedNodes();
    model.deleteNodes([a.id]);

    expect(model.nodes).toHaveLength(1);
    expect(model.edges).toHaveLength(0);
  });

  it('and undo brings all of them back', () => {
    const { model, a } = twoConnectedNodes();
    const undo = new UndoStack(model);

    undo.do(() => model.deleteNodes([a.id]));
    expect(model.edges).toHaveLength(0);

    undo.undo();
    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toHaveLength(1);
  });
});

describe('Edges reference nodes by id', () => {
  it('moving a node does not touch the edge', () => {
    const { model, a, edge } = twoConnectedNodes();
    const before = JSON.stringify(model.edge(edge.id));

    model.moveNodes([a.id], 120, -40);

    expect(JSON.stringify(model.edge(edge.id))).toBe(before);
  });

  it('refuses an edge to a node that does not exist', () => {
    const model = new GraphModel();
    const a = model.addNode({ x: 0, y: 0 });

    expect(model.addEdge({ from: a.id, to: 'nsomewhere' })).toBeNull();
  });
});

describe('Waypoints turn the router off', () => {
  it('and clearing them turns it back on', () => {
    const { model, edge } = twoConnectedNodes();

    model.setWaypoints(edge.id, [{ x: 10, y: 10 }]);
    expect(model.edge(edge.id).waypoints).toHaveLength(1);

    model.setWaypoints(edge.id, []);
    expect(model.edge(edge.id).waypoints).toHaveLength(0);
  });

  it('changing routing mode discards them, so the new mode is visible', () => {
    const { model, edge } = twoConnectedNodes();
    model.setWaypoints(edge.id, [{ x: 10, y: 10 }]);

    model.setEdgeRouting([edge.id], 'curved');

    expect(model.edge(edge.id).waypoints).toEqual([]);
    expect(model.edge(edge.id).routing).toBe('curved');
  });
});

describe('Loading a document', () => {
  it('fills in what a script left out', () => {
    const model = new GraphModel({
      version: 1,
      type: 'graphs',
      nodes: [{ id: 'n1', x: 0, y: 0, text: 'only the essentials' }],
      edges: [{ id: 'e1', from: 'n1', to: 'n1' }],
    });

    expect(model.nodes[0].shape).toBe('rect');
    expect(model.nodes[0].data).toEqual({});
    expect(model.edges[0].routing).toBe('orthogonal');
  });

  it('a graph with a dangling connector loads and is reported', () => {
    const model = new GraphModel({
      nodes: [{ id: 'n1', x: 0, y: 0 }],
      edges: [{ id: 'e1', from: 'n1', to: 'gone' }],
    });

    expect(model.validate().dangling).toEqual(['e1']);
  });

  it('rejects something that is not a document at all', () => {
    expect(() => new GraphModel('not a graph')).toThrow();
  });
});

describe('Validation reports without refusing', () => {
  it('finds unreachable nodes', () => {
    const model = new GraphModel();
    const a = model.addNode({ x: 0, y: 0 });
    const b = model.addNode({ x: 200, y: 0 });
    const orphan = model.addNode({ x: 400, y: 200 });
    model.addEdge({ from: a.id, to: b.id });

    expect(model.validate().unreachable).toEqual([]);
    model.deleteNodes([a.id]);
    expect(model.validate().unreachable).not.toContain(orphan.id);
  });

  it('names a fully cyclic graph rather than calling it broken', () => {
    const model = new GraphModel();
    const a = model.addNode({ x: 0, y: 0 });
    const b = model.addNode({ x: 200, y: 0 });
    model.addEdge({ from: a.id, to: b.id });
    model.addEdge({ from: b.id, to: a.id });

    // Perfectly valid for a state machine.
    expect(model.validate().cyclic).toBe(true);
  });
});

describe('Tree layout', () => {
  it('puts a parent above its children and centred over them', async () => {
    const { treeLayout } = await import('../src/js/layout.js');
    const model = new GraphModel();
    const root = model.addNode({ x: 0, y: 0, w: 100, h: 40 });
    const a = model.addNode({ x: 0, y: 0, w: 100, h: 40 });
    const b = model.addNode({ x: 0, y: 0, w: 100, h: 40 });
    model.addEdge({ from: root.id, to: a.id });
    model.addEdge({ from: root.id, to: b.id });

    const positions = treeLayout(model);

    expect(positions.get(a.id).y).toBeGreaterThan(positions.get(root.id).y);
    const centre = (positions.get(a.id).x + positions.get(b.id).x) / 2;
    expect(positions.get(root.id).x).toBeCloseTo(centre, 1);
  });

  it('places every node, including disconnected ones', async () => {
    const { treeLayout } = await import('../src/js/layout.js');
    const model = new GraphModel();
    const a = model.addNode({ x: 0, y: 0 });
    const b = model.addNode({ x: 0, y: 0 });
    const lonely = model.addNode({ x: 0, y: 0 });
    model.addEdge({ from: a.id, to: b.id });

    const positions = treeLayout(model);

    expect(positions.size).toBe(3);
    expect(positions.has(lonely.id)).toBe(true);
  });

  it('arranges a fully cyclic graph instead of refusing', async () => {
    const { treeLayout } = await import('../src/js/layout.js');
    const model = new GraphModel();
    const a = model.addNode({ x: 0, y: 0 });
    const b = model.addNode({ x: 0, y: 0 });
    model.addEdge({ from: a.id, to: b.id });
    model.addEdge({ from: b.id, to: a.id });

    expect(treeLayout(model).size).toBe(2);
  });
});

describe('One drag is one undo entry', () => {
  it('however many intermediate positions it passed through', () => {
    // The rule from, tested at the level the interaction layer uses.
    const model = new GraphModel();
    const node = model.addNode({ x: 0, y: 0 });
    const undo = new UndoStack(model);

    const before = model.snapshot();
    for (let i = 0; i < 40; i += 1) model.moveNodes([node.id], 5, 0);
    undo.past.push(before);

    expect(undo.past).toHaveLength(1);
    expect(model.node(node.id).x).toBe(200);

    undo.undo();
    expect(model.node(node.id).x).toBe(0);
  });
});

describe('Importing a logic-only export', () => {
  it('loads nodes that carry no coordinates', () => {
    // What a game writes back after generating variants in code.
    const model = new GraphModel({
      version: 1,
      type: 'graphs',
      nodes: [
        { id: 'na', text: 'Greeting', data: { line: 'Hello' } },
        { id: 'nb', text: 'Farewell', data: { line: 'Bye' } },
      ],
      edges: [{ id: 'ea', from: 'na', to: 'nb', label: 'leave', data: { flag: 'met' } }],
    });

    expect(model.nodes).toHaveLength(2);
    expect(model.nodes[0].data).toEqual({ line: 'Hello' });
    expect(model.edges[0].data).toEqual({ flag: 'met' });
    // Defaults fill in, so the graph is drawable straight away.
    expect(model.nodes[0].w).toBe(160);
  });

  it('a round trip through logic-only JSON keeps every data field', async () => {
    const { toJson } = await import('../src/js/export.js');
    const original = new GraphModel();
    const a = original.addNode({ x: 10, y: 20, text: 'A', data: { deep: { k: [1, 2] } } });
    const b = original.addNode({ x: 300, y: 20, text: 'B' });
    original.addEdge({ from: a.id, to: b.id, data: { cost: 3 } });

    const back = new GraphModel(JSON.parse(toJson(original, { logicOnly: true })));

    expect(back.nodes[0].data).toEqual({ deep: { k: [1, 2] } });
    expect(back.edges[0].data).toEqual({ cost: 3 });
  });
});

describe('Bending a connector by hand', () => {
  it('a waypoint switches the automatic router off for that connector', async () => {
    const { routeEdge } = await import('../src/js/routing.js');
    const { model, a, b, edge } = twoConnectedNodes();

    const automatic = routeEdge(model.edge(edge.id), model.node(a.id), model.node(b.id));
    model.setWaypoints(edge.id, [{ x: 120, y: 400 }]);
    const manual = routeEdge(model.edge(edge.id), model.node(a.id), model.node(b.id));

    expect(manual).not.toEqual(automatic);
    expect(manual.some((p) => p.x === 120 && p.y === 400)).toBe(true);
  });

  it('clearing the waypoints hands the connector back to the router', async () => {
    const { routeEdge } = await import('../src/js/routing.js');
    const { model, a, b, edge } = twoConnectedNodes();

    const automatic = routeEdge(model.edge(edge.id), model.node(a.id), model.node(b.id));
    model.setWaypoints(edge.id, [{ x: 120, y: 400 }]);
    model.setWaypoints(edge.id, []);

    expect(routeEdge(model.edge(edge.id), model.node(a.id), model.node(b.id)))
      .toEqual(automatic);
  });
});

describe('Aligning and distributing', () => {
  function threeNodes() {
    const model = new GraphModel();
    return {
      model,
      a: model.addNode({ x: 0, y: 0, w: 100, h: 40 }),
      b: model.addNode({ x: 130, y: 25, w: 60, h: 40 }),
      c: model.addNode({ x: 400, y: 70, w: 100, h: 40 }),
    };
  }

  it('aligns left edges', () => {
    const { model, a, b, c } = threeNodes();
    model.alignNodes([a.id, b.id, c.id], 'left');

    expect(model.nodes.map((n) => n.x)).toEqual([0, 0, 0]);
  });

  it('aligns right edges, accounting for different widths', () => {
    const { model, a, b, c } = threeNodes();
    model.alignNodes([a.id, b.id, c.id], 'right');

    const rights = model.nodes.map((n) => n.x + n.w);
    expect(new Set(rights).size).toBe(1);
  });

  it('centres horizontally on the group, not on the page', () => {
    const { model, a, b, c } = threeNodes();
    model.alignNodes([a.id, b.id, c.id], 'centre-x');

    const centres = model.nodes.map((n) => n.x + n.w / 2);
    expect(new Set(centres.map((v) => Math.round(v))).size).toBe(1);
  });

  it('does nothing to a single node', () => {
    const { model, a } = threeNodes();
    const before = a.x;
    model.alignNodes([a.id], 'right');

    expect(model.node(a.id).x).toBe(before);
  });

  it('distributes with equal gaps and leaves the ends alone', () => {
    const { model, a, b, c } = threeNodes();
    const firstBefore = model.node(a.id).x;
    const lastBefore = model.node(c.id).x;

    model.distributeNodes([a.id, b.id, c.id], 'horizontal');

    expect(model.node(a.id).x).toBe(firstBefore);
    expect(model.node(c.id).x).toBeCloseTo(lastBefore, 5);

    const sorted = [...model.nodes].sort((p, q) => p.x - q.x);
    const gaps = [];
    for (let i = 0; i < sorted.length - 1; i += 1) {
      gaps.push(sorted[i + 1].x - (sorted[i].x + sorted[i].w));
    }
    expect(gaps[0]).toBeCloseTo(gaps[1], 5);
  });

  it('needs three nodes before distributing means anything', () => {
    const { model, a, b } = threeNodes();
    const before = model.node(b.id).x;
    model.distributeNodes([a.id, b.id], 'horizontal');

    expect(model.node(b.id).x).toBe(before);
  });
});
