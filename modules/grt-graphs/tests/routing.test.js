/** Where connectors go. */

import { describe, it, expect } from 'vitest';
import {
  routeEdge, orthogonalPath, resolveAutoPorts, portPoint, pathCrossesNode, pathData,
} from '../src/js/routing.js';

const node = (x, y, w = 160, h = 60) => ({ id: `n${x}_${y}`, x, y, w, h });
const edge = (extra = {}) => ({
  id: 'e1', from: 'a', to: 'b', fromPort: 'auto', toPort: 'auto',
  routing: 'orthogonal', waypoints: [], ...extra,
});

describe('Automatic port choice', () => {
  it('connects side to side when nodes sit beside each other', () => {
    const ports = resolveAutoPorts(node(0, 0), node(400, 0), 'auto', 'auto');
    expect(ports).toEqual({ fromPort: 'right', toPort: 'left' });
  });

  it('connects top to bottom when one is below the other', () => {
    const ports = resolveAutoPorts(node(0, 0), node(0, 400), 'auto', 'auto');
    expect(ports).toEqual({ fromPort: 'bottom', toPort: 'top' });
  });

  it('reverses when the target is to the left', () => {
    const ports = resolveAutoPorts(node(400, 0), node(0, 0), 'auto', 'auto');
    expect(ports).toEqual({ fromPort: 'left', toPort: 'right' });
  });

  it('leaves a port the user chose alone', () => {
    const ports = resolveAutoPorts(node(0, 0), node(400, 0), 'top', 'auto');
    expect(ports.fromPort).toBe('top');
  });
});

describe('Orthogonal routing', () => {
  it('uses only horizontal and vertical segments', () => {
    const points = orthogonalPath(
      portPoint(node(0, 0), 'right'), portPoint(node(400, 200), 'left'), 'right', 'left',
    );

    for (let i = 0; i < points.length - 1; i += 1) {
      const dx = Math.abs(points[i].x - points[i + 1].x);
      const dy = Math.abs(points[i].y - points[i + 1].y);
      expect(dx < 0.01 || dy < 0.01).toBe(true);
    }
  });

  it('is a straight line when the nodes already line up', () => {
    const a = node(0, 0);
    const b = node(400, 0);
    const points = orthogonalPath(portPoint(a, 'right'), portPoint(b, 'left'), 'right', 'left');

    expect(points).toHaveLength(2);
  });

  it('never runs back through the node it started from', () => {
    // The check, over a spread of relative positions including the
    // awkward ones where the target sits behind the source.
    const source = node(200, 200);

    // Non-overlapping placements, including the close ones where the stubs
    // would otherwise overshoot past each other.
    for (const [dx, dy] of [
      [400, 0], [-400, 0], [0, 400], [0, -400],
      [300, 300], [-300, 300], [300, -300], [-300, -300],
      [40, -70], [-40, 75], [180, -65], [-175, 68],
    ]) {
      const target = node(200 + dx, 200 + dy);
      const points = routeEdge(edge(), source, target);

      expect(
        pathCrossesNode(points, source),
        `path crosses its own source for offset ${dx},${dy}`,
      ).toBe(false);
    }
  });

  it('never runs through the node it arrives at', () => {
    const source = node(200, 200);

    for (const [dx, dy] of [[400, 0], [0, 400], [-400, 120], [250, -260]]) {
      const target = node(200 + dx, 200 + dy);
      const points = routeEdge(edge(), source, target);

      expect(pathCrossesNode(points, target)).toBe(false);
    }
  });
});

describe('Nodes that overlap', () => {
  it('still produce a path rather than throwing', () => {
    // Two boxes on top of each other have no corridor between them, so there
    // is no correct route.
    const points = routeEdge(edge(), node(200, 200), node(240, 220));

    expect(points.length).toBeGreaterThan(1);
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

describe('Manual control wins', () => {
  it('waypoints replace the computed path', () => {
    const points = routeEdge(
      edge({ waypoints: [{ x: 50, y: 500 }] }), node(0, 0), node(400, 0),
    );

    expect(points).toHaveLength(3);
    expect(points[1]).toEqual({ x: 50, y: 500 });
  });
});

describe('Path output', () => {
  it('straight routing gives two points', () => {
    expect(routeEdge(edge({ routing: 'straight' }), node(0, 0), node(400, 0))).toHaveLength(2);
  });

  it('curved routing produces a cubic curve', () => {
    const points = routeEdge(edge({ routing: 'curved' }), node(0, 0), node(400, 0));
    expect(pathData(points, 'curved')).toContain('C');
  });

  it('orthogonal output is all move and line commands', () => {
    const points = routeEdge(edge(), node(0, 0), node(400, 220));
    const d = pathData(points, 'orthogonal');

    expect(d.startsWith('M')).toBe(true);
    expect(d).not.toContain('C');
  });
});
