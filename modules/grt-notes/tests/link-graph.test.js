// @vitest-environment jsdom

/** The graph of notes: links resolved, a note's neighbourhood, a layout that is the same each time and keeps notes apart. */

import { describe, it, expect } from 'vitest';
import { linkGraph, around, forceLayout, graphSvg } from '../src/js/core/link-graph.js';

const notes = [
  { path: 'a.md', title: 'Alfa', links: ['Beta', 'Gamma', 'Nessuna', 'Alfa'] },
  { path: 'b.md', title: 'Beta', links: ['Gamma', 'Gamma'] },
  { path: 'c.md', title: 'Gamma', links: [] },
  { path: 'd.md', title: 'Delta <x>', links: ['Epsilon'] },
  { path: 'e.md', title: 'Epsilon', links: [] },
];
const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.path]));
const resolve = (t) => byTitle.get(t.toLowerCase()) ?? null;

describe('The graph of notes', () => {
  it('links to notes that exist become edges, once each, none to itself', () => {
    const graph = linkGraph(notes, resolve);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toEqual([{ from: 'a.md', to: 'b.md' }, { from: 'a.md', to: 'c.md' }, { from: 'b.md', to: 'c.md' }, { from: 'd.md', to: 'e.md' }]);
  });

  it('around a note: its links either way, as deep as asked', () => {
    const graph = linkGraph(notes, resolve);
    expect(around(graph, 'c.md', 1).nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(around(graph, 'e.md', 1).nodes.map((n) => n.id).sort()).toEqual(['d.md', 'e.md']);
  });

  it('the layout is the same each time, keeps notes apart, and a big vault is laid out quickly', () => {
    const graph = linkGraph(notes, resolve);
    const one = forceLayout(graph);
    expect([...forceLayout(graph)]).toEqual([...one]);
    const points = [...one.values()];
    for (let i = 0; i < points.length; i += 1) for (let j = i + 1; j < points.length; j += 1) expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThan(20);
    const many = Array.from({ length: 5000 }, (_, i) => ({ path: `n${i}`, title: `N${i}`, links: [`N${(i * 7) % 5000}`, `N${(i + 1) % 5000}`] }));
    const index = new Map(many.map((n) => [n.title.toLowerCase(), n.path]));
    const started = Date.now();
    const big = linkGraph(many, (t) => index.get(t.toLowerCase()) ?? null);
    const placed = forceLayout(big);
    expect(placed.size).toBe(5000);
    expect([...placed.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
  });

  it('the picture marks the note shown and keeps titles as text', () => {
    const graph = linkGraph(notes, resolve);
    const svg = graphSvg(graph, forceLayout(graph), { current: 'a.md' });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('.graph-note.current').getAttribute('data-path')).toBe('a.md');
    expect([...doc.querySelectorAll('text')].map((t) => t.textContent)).toContain('Delta <x>');
    expect(doc.querySelectorAll('line')).toHaveLength(4);
  });
});
