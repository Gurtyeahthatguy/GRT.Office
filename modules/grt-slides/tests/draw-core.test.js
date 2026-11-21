/** The drawing core every program shares: shape geometry from LibreOffice's presets, and what Format and Shape do. */

import { describe, it, expect } from 'vitest';
import {
  compileFormula, presetDefinition, shapeGeometry, dragHandle, pathData, SHAPE_MENUS, SHAPE_TYPES, ooxmlPreset, odfType, insertedSquare,
} from '../src/js/core/draw/geometry.js';
import {
  arrange, align, distribute, equalize, flip, rotateBy, makeGroup, ungroup, duplicate, convert, gluePoints, toPage, toLocal,
  flattenSubpaths, subpathsData, cleanDrawing,
} from '../src/js/core/draw/objects.js';
import { drawingSvg } from '../src/js/core/draw/render.js';
import { smoothPoints } from '../src/js/core/draw/layer.js';

const bounds = (paths) => {
  const pts = paths.flatMap((p) => p.segments.filter((s) => s.to).map((s) => s.to));
  return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
};

describe('Formulas', () => {
  it('reads ODF formulas without eval: references, functions, signs', () => {
    const c = { f: (n) => [10, 20][n], m: (n) => [3][n], k: (name) => ({ width: 21600, left: 0 })[name] ?? 0 };
    expect(compileFormula('?f0 +?f1 *2')(c)).toBe(50);
    expect(compileFormula('-$0 /2')(c)).toBe(-1.5);
    expect(compileFormula('if(?f0 -100,1,2)')(c)).toBe(2);
    expect(compileFormula('max(width,abs(-5))')(c)).toBe(21600);
    expect(compileFormula('10800*sin(90*(pi/180))')(c)).toBeCloseTo(10800);
    expect(compileFormula('atan2(1,1)*180/pi')(c)).toBeCloseTo(45);
    expect(compileFormula('1/0')(c)).toBe(0);
  });

  it('refuses what is not a formula', () => {
    expect(() => compileFormula('alert(1)')).toThrow();
    expect(() => compileFormula('1;2')).toThrow();
    expect(() => compileFormula('(1')).toThrow();
  });
});

describe('The shapes of LibreOffice', () => {
  it('has the six menus of Insert, Shape, with every shape drawable', () => {
    expect(Object.keys(SHAPE_MENUS)).toEqual(['basic', 'symbol', 'arrows', 'flowchart', 'callout', 'stars']);
    expect(Object.values(SHAPE_MENUS).flat()).toHaveLength(114);
    for (const type of Object.values(SHAPE_MENUS).flat()) {
      const g = shapeGeometry(presetDefinition(type), 300, 200);
      expect(g.paths.length, type).toBeGreaterThan(0);
    }
    expect(SHAPE_TYPES.length).toBeGreaterThan(290);
  });

  it('draws a rectangle on its box, and an ellipse inside it', () => {
    const rect = bounds(shapeGeometry(presetDefinition('rectangle'), 300, 200).paths);
    expect(rect).toEqual({ x0: 0, y0: 0, x1: 300, y1: 200 });
    const ellipse = bounds(shapeGeometry(presetDefinition('ellipse'), 300, 200).paths);
    expect(ellipse.x0).toBeCloseTo(0);
    expect(ellipse.x1).toBeCloseTo(300);
    expect(ellipse.y1).toBeCloseTo(200);
  });

  it('keeps a rounded corner round when the rectangle is stretched', () => {
    const wide = shapeGeometry(presetDefinition('round-rectangle'), 1000, 100);
    const first = wide.paths[0].segments[0].to;
    // The corner starts as far from the edge as the height allows, not stretched with the width.
    expect(first.x).toBeLessThan(30);
  });

  it('works out OOXML presets in the shape\'s own units, arcs included', () => {
    const g = shapeGeometry(presetDefinition('ooxml-pie'), 200, 200);
    const b = bounds(g.paths);
    expect(b.x1).toBeLessThanOrEqual(200.01);
    expect(b.y1).toBeLessThanOrEqual(200.01);
    expect(pathData(g.paths[0].segments)).toMatch(/^M[\d.]+ [\d.]+(L|C)/);
  });

  it('moves a handle within its range, changing the shape', () => {
    const def = presetDefinition('round-rectangle');
    const before = shapeGeometry(def, 400, 400);
    expect(before.handles).toHaveLength(1);
    const mods = dragHandle(def, 400, 400, null, 0, { x: 150, y: 0 });
    expect(mods[0]).toBeCloseTo(150 * 21600 / 400);
    const far = dragHandle(def, 400, 400, null, 0, { x: 390, y: 0 });
    expect(far[0]).toBe(10800);
  });

  it('knows which shapes go in square, and what they are in ODF and OOXML', () => {
    expect(insertedSquare('circle')).toBe(true);
    expect(insertedSquare('ellipse')).toBe(false);
    expect(odfType('circle')).toBe('ellipse');
    expect(odfType('circle-pie')).toBe('mso-spt100');
    expect(ooxmlPreset('smiley')).toBe('smileyFace');
    expect(ooxmlPreset('ooxml-gear6')).toBe('gear6');
    expect(presetDefinition('nothing')).toBeNull();
    expect(presetDefinition('__proto__')).toBeNull();
  });
});

describe('Format and Shape on objects', () => {
  const objects = () => [
    { id: 'a', x: 0, y: 0, w: 10, h: 10, z: 1 },
    { id: 'b', x: 50, y: 20, w: 20, h: 10, z: 2 },
    { id: 'c', x: 100, y: 40, w: 10, h: 30, z: 3 },
  ];

  it('arranges: front, back, forward, backward, reverse, in front of and behind another', () => {
    const z = (list) => [...list].sort((p, q) => p.z - q.z).map((o) => o.id).join('');
    let all = objects(); arrange(all, ['a'], 'front'); expect(z(all)).toBe('bca');
    all = objects(); arrange(all, ['c'], 'back'); expect(z(all)).toBe('cab');
    all = objects(); arrange(all, ['a'], 'forward'); expect(z(all)).toBe('bac');
    all = objects(); arrange(all, ['c'], 'backward'); expect(z(all)).toBe('acb');
    all = objects(); arrange(all, ['a', 'b', 'c'], 'reverse'); expect(z(all)).toBe('cba');
    all = objects(); arrange(all, ['a'], 'in-front-of', 'b'); expect(z(all)).toBe('bac');
    all = objects(); arrange(all, ['c'], 'behind', 'a'); expect(z(all)).toBe('cab');
  });

  it('aligns to each other, and one object to the page', () => {
    const all = objects();
    align(all, 'left');
    expect(all.map((o) => o.x)).toEqual([0, 0, 0]);
    align(all, 'bottom');
    expect(all.map((o) => o.y + o.h)).toEqual([70, 70, 70]);
    const one = [{ id: 'x', x: 5, y: 5, w: 10, h: 10 }];
    align(one, 'center', { w: 100, h: 50 });
    expect(one[0].x).toBe(45);
  });

  it('distributes evenly, by edges or by the space between', () => {
    const all = objects();
    distribute(all, 'left');
    expect(all.map((o) => o.x)).toEqual([0, 50, 100]);
    const spaced = objects();
    distribute(spaced, 'spacing-h');
    // Gaps between a (0..10), b and c (100..110): b sits with equal room on each side.
    expect(spaced[1].x - 10).toBeCloseTo(100 - (spaced[1].x + 20));
  });

  it('equalizes width and height, flips and turns', () => {
    const all = objects();
    equalize(all, 'height');
    expect(all.map((o) => o.h)).toEqual([10, 10, 10]);
    flip([all[0]], false);
    expect(all[0].flipH).toBe(true);
    flip([all[0]], false);
    expect(all[0].flipH).toBeUndefined();
    rotateBy([all[1]], -90);
    expect(all[1].rotation).toBe(270);
  });

  it('groups and ungroups, the members following the group when it grows', () => {
    const [a, b] = objects();
    const g = makeGroup([a, b], 'g');
    expect({ x: g.x, y: g.y, w: g.w, h: g.h }).toEqual({ x: 0, y: 0, w: 70, h: 30 });
    g.w = 140;
    const back = ungroup(g);
    expect(back[1].x).toBe(100);
    expect(back[1].w).toBe(40);
  });

  it('duplicates with steps of place, turn, size and colour', () => {
    let n = 0;
    const copies = duplicate({ id: 's', kind: 'shape', shape: 'rectangle', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 1 },
      { copies: 2, dx: 5, dy: 0, angle: 10, dw: 2, dh: 0, startColor: '#000000', endColor: '#ffffff' }, () => `c${(n += 1)}`);
    expect(copies.map((c) => [c.id, c.x, c.w, c.rotation])).toEqual([['c1', 5, 12, 10], ['c2', 10, 14, 20]]);
    expect(copies[1].fillLook.color).toBe('#ffffff');
  });

  it('converts a shape to a curve and to a polygon, keeping its look', () => {
    const o = { id: 's', kind: 'shape', shape: 'ellipse', x: 0, y: 0, w: 100, h: 50, line: { color: '#ff0000' } };
    convert(o, 'curve');
    expect(o.kind).toBe('path');
    expect(o.subpaths[0].closed).toBe(true);
    expect(o.subpaths[0].nodes.some((n) => n.out)).toBe(true);
    expect(o.line.color).toBe('#ff0000');
    convert(o, 'polygon');
    expect(o.subpaths[0].nodes.every((n) => !n.out && !n.in)).toBe(true);
    expect(o.subpaths[0].nodes.length).toBeGreaterThan(20);
  });

  it('maps points to and from a turned and flipped object', () => {
    const o = { x: 100, y: 100, w: 40, h: 20, rotation: 90, flipH: true };
    const p = toPage(o, { x: 10, y: 5 });
    const back = toLocal(o, p);
    expect(back.x).toBeCloseTo(10);
    expect(back.y).toBeCloseTo(5);
    expect(gluePoints({ kind: 'shape', shape: 'rectangle', x: 0, y: 0, w: 100, h: 50, rotation: 0 }).length).toBeGreaterThan(0);
  });

  it('smooths freehand points and writes path data', () => {
    const nodes = smoothPoints([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }]);
    expect(nodes).toHaveLength(4);
    expect(subpathsData([{ closed: false, nodes }])).toMatch(/^M0 0C/);
    expect(flattenSubpaths([{ closed: false, nodes }])[0].nodes.length).toBeGreaterThan(4);
  });

  it('cleans what a file brings, and draws it without anything active', () => {
    const clean = cleanDrawing({ kind: 'shape', shape: 'nope', name: 'x'.repeat(500), line: { color: 'red', width: 1e9, start: 'evil' } });
    expect(clean.shape).toBe('rectangle');
    expect(clean.name).toHaveLength(200);
    expect(clean.line).toMatchObject({ color: '#3465a4', width: 200, start: 'none' });
    const svg = drawingSvg({ id: '"><script>', kind: 'shape', shape: 'smiley', x: 0, y: 0, w: 100, h: 100, name: '<b>', line: { end: 'arrow' } });
    expect(svg).not.toMatch(/<script|<b>/);
    expect(svg).toContain('<path');
  });
});

describe('3D objects', () => {
  it('draws each solid of Shape, Insert, 3D Objects with its near faces lit and its far ones hidden', async () => {
    const { SOLIDS, projectedFaces, sceneAsGroup } = await import('../src/js/core/draw/three.js');
    for (const solid of Object.keys(SOLIDS)) {
      const faces = projectedFaces({ solid, w: 200, h: 120 });
      expect(faces.length, solid).toBeGreaterThan(1);
      for (const face of faces) for (const [x, y] of face.points) { expect(x).toBeGreaterThanOrEqual(-0.01); expect(x).toBeLessThanOrEqual(200.01); expect(y).toBeLessThanOrEqual(120.01); }
    }
    // A cube seen from a corner shows three faces, each a shade of its colour.
    const cube = projectedFaces({ solid: 'cube', w: 100, h: 100, color: '#ff0000' });
    expect(cube).toHaveLength(3);
    expect(new Set(cube.map((f) => f.fill)).size).toBe(3);
    const group = sceneAsGroup({ id: 'c', solid: 'cube', x: 10, y: 20, w: 100, h: 100 });
    expect(group.kind).toBe('group');
    expect(group.children).toHaveLength(3);
  });

  it('makes a shape 3D by pushing its outline back, or by turning it', async () => {
    const { convertTo3d } = await import('../src/js/core/draw/objects.js');
    const { projectedFaces } = await import('../src/js/core/draw/three.js');
    const star = { id: 's', kind: 'shape', shape: 'star5', x: 0, y: 0, w: 100, h: 100, fillLook: { type: 'solid', color: '#00ff00' } };
    expect(convertTo3d(star, 'extrude')).toBe(true);
    expect(star).toMatchObject({ kind: 'scene3d', solid: 'extrude', color: '#00ff00' });
    expect(projectedFaces(star).length).toBeGreaterThan(10);
    const vase = { id: 'v', kind: 'shape', shape: 'rectangle', x: 0, y: 0, w: 50, h: 100 };
    convertTo3d(vase, 'lathe');
    expect(projectedFaces(vase).length).toBeGreaterThan(20);
  });
});
