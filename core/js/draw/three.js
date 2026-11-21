/** Draw's 3D objects: solids, extruded and turned outlines, drawn as lit polygons seen from where the object is turned. */

import { least, greatest } from '../extent.js';

/** The solids of Shape, Insert, 3D Objects, by LibreOffice's names. */
export const SOLIDS = { cube: 'Cube', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone', pyramid: 'Pyramid', torus: 'Torus', shell: 'Shell', 'half-sphere': 'Half-Sphere' };

const MAX_FACES = 6000;
const STEPS = 24;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };

/** A face's outward normal from its first three corners, wound counter-clockwise seen from outside. */
const normalOf = (pts) => unit(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));

/** A profile turned about the vertical axis: points as [radius, height], radius 0 on the axis. */
function lathe(profile, steps = STEPS, sweep = Math.PI * 2) {
  const faces = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (sweep * i) / steps;
    const b = (sweep * (i + 1)) / steps;
    for (let k = 0; k + 1 < profile.length; k += 1) {
      const [r1, y1] = profile[k];
      const [r2, y2] = profile[k + 1];
      const p = (r, y, t) => [r * Math.cos(t), y, r * Math.sin(t)];
      // Wound so the normal points away from the axis for a profile that runs from top to bottom.
      const pts = [p(r1, y1, a), p(r1, y1, b), p(r2, y2, b), p(r2, y2, a)];
      // A corner on the axis makes a triangle of the quad.
      const shown = pts.filter((q, j) => j === 0 || Math.hypot(...sub(q, pts[j - 1])) > 1e-9);
      if (shown.length >= 3) faces.push(shown);
    }
  }
  return faces;
}

/** An outline pushed back to a depth: front, back and the sides between. */
function extrude(polygons, depth) {
  const faces = [];
  const d = depth / 2;
  for (const given of polygons) {
    if (given.length < 3) continue;
    // Counter-clockwise, so the front faces forward and the sides face out.
    const area = given.reduce((sum, [x1, y1], i) => { const [x2, y2] = given[(i + 1) % given.length]; return sum + x1 * y2 - x2 * y1; }, 0);
    const poly = area < 0 ? [...given].reverse() : given;
    faces.push(poly.map(([x, y]) => [x, y, d]));
    faces.push([...poly].reverse().map(([x, y]) => [x, y, -d]));
    for (let i = 0; i < poly.length; i += 1) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      faces.push([[x1, y1, d], [x1, y1, -d], [x2, y2, -d], [x2, y2, d]]);
    }
  }
  return faces;
}

/** The faces of a 3D object in a unit box about the origin, y up. */
export function mesh(o) {
  const half = 0.5;
  switch (o.solid ?? 'cube') {
    case 'cube': {
      const v = (x, y, z) => [x * half, y * half, z * half];
      return [
        [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)], [v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1)],
        [v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1)], [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)],
        [v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1)], [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
      ];
    }
    case 'sphere': return lathe(Array.from({ length: 13 }, (_, i) => { const t = -Math.PI / 2 + (Math.PI * i) / 12; return [half * Math.cos(t), half * Math.sin(t)]; }).reverse());
    case 'half-sphere': return lathe([[0, 0], ...Array.from({ length: 7 }, (_, i) => { const t = (Math.PI / 2) * (i / 6); return [half * Math.cos(t), half * Math.sin(t)]; })].reverse().concat([]));
    case 'shell': return lathe([...Array.from({ length: 7 }, (_, i) => { const t = (Math.PI / 2) * (i / 6); return [half * Math.cos(t), half * Math.sin(t) - 0.2]; }).reverse(), ...Array.from({ length: 7 }, (_, i) => { const t = (Math.PI / 2) * (i / 6); return [half * 0.85 * Math.cos(t), half * 0.85 * Math.sin(t) - 0.2]; })]);
    case 'cylinder': return lathe([[0, half], [half, half], [half, -half], [0, -half]]);
    case 'cone': return lathe([[0, half], [half, -half], [0, -half]]);
    case 'pyramid': return lathe([[0, half], [half, -half], [0, -half]], 4);
    case 'torus': return lathe(Array.from({ length: 13 }, (_, i) => { const t = (-Math.PI * 2 * i) / 12; return [0.32 + 0.16 * Math.cos(t), 0.16 * Math.sin(t)]; }));
    case 'extrude': return extrude(o.profile ?? [], o.depth ?? 0.3);
    case 'lathe': return lathe((o.profile?.[0] ?? []).map(([x, y]) => [Math.abs(x), y]));
    default: return [];
  }
}

/** Turns a point by the object's angles in degrees: about x, then y, then z. */
function turner(o) {
  const [ax, ay, az] = [o.rotX ?? 20, o.rotY ?? -30, o.rotZ ?? 0].map((d) => (d * Math.PI) / 180);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  return ([x, y, z]) => {
    let [px, py, pz] = [x, y * cx - z * sx, y * sx + z * cx];
    [px, pz] = [px * cy + pz * sy, -px * sy + pz * cy];
    [px, py] = [px * cz - py * sz, px * sz + py * cz];
    return [px, py, pz];
  };
}

const mix = (colour, light) => {
  const c = [1, 3, 5].map((i) => parseInt((/^#[0-9a-f]{6}$/i.test(colour ?? '') ? colour : '#729fcf').slice(i, i + 2), 16));
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v * light))).toString(16).padStart(2, '0')).join('')}`;
};

/**
 * The visible faces of a 3D object as polygons in its box, farthest first, each with its shaded colour.
 * @returns {{points: number[][], fill: string}[]}
 */
export function projectedFaces(o) {
  const faces = mesh(o).slice(0, MAX_FACES);
  const turn = turner(o);
  const light = unit([-0.4, 0.6, 0.8]);
  const turned = faces.map((pts) => pts.map(turn));
  // Fit the turned object to its box, keeping its proportions to the box's.
  const all = turned.flat();
  if (!all.length) return [];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const spanX = greatest(xs) - least(xs) || 1;
  const spanY = greatest(ys) - least(ys) || 1;
  const sx = o.w / spanX;
  const sy = o.h / spanY;
  const minX = least(xs);
  const maxY = greatest(ys);
  const out = [];
  for (const pts of turned) {
    let n = normalOf(pts);
    // Seen from the front, looking down -z: a face turned away is not drawn; an outline of the person's own shows both sides.
    const twoSided = o.solid === 'extrude' || o.solid === 'lathe';
    if (n[2] <= 1e-6) { if (!twoSided) continue; n = n.map((c) => -c); }
    const lit = 0.35 + 0.65 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    out.push({ depth: pts.reduce((s, p) => s + p[2], 0) / pts.length, points: pts.map((p) => [(p[0] - minX) * sx, (maxY - p[1]) * sy]), fill: mix(o.color, lit) });
  }
  return out.sort((a, b) => a.depth - b.depth).map(({ points, fill }) => ({ points, fill }));
}

/** SVG polygons of a 3D object in its box. */
export function sceneSvg(o) {
  const f = (v) => Math.round(v * 100) / 100;
  return projectedFaces(o).map((face) => `<polygon points="${face.points.map((p) => `${f(p[0])},${f(p[1])}`).join(' ')}" fill="${face.fill}" stroke="${face.fill}" stroke-width="0.5" stroke-linejoin="round"/>`).join('');
}

/** A shape's outline made into a profile for Convert, To 3D and To 3D Rotation Object: polygons in a unit box, y up. */
export function profileOf(subpaths, w, h) {
  return subpaths.map((s) => s.nodes.map((n) => [n.x / Math.max(w, 1e-6) - 0.5, 0.5 - n.y / Math.max(h, 1e-6)]));
}


/** A 3D object as a group of its shaded faces, for formats that keep it as a drawing. */
export function sceneAsGroup(o) {
  const children = projectedFaces(o).map((face, i) => {
    const xs = face.points.map((p) => p[0]);
    const ys = face.points.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return {
      id: `${o.id}-f${i}`, kind: 'path', x: o.x + x0, y: o.y + y0, w: Math.max(Math.max(...xs) - x0, 0.01), h: Math.max(Math.max(...ys) - y0, 0.01), rotation: 0, z: i,
      subpaths: [{ closed: true, nodes: face.points.map((p) => ({ x: p[0] - x0, y: p[1] - y0 })) }],
      fillLook: { type: 'solid', color: face.fill }, line: { style: 'none' },
    };
  });
  return { id: o.id, kind: 'group', x: o.x, y: o.y, w: o.w, h: o.h, rotation: 0, z: o.z, name: o.name ?? 'Shape 3D', title: o.title, description: o.description, children };
}
