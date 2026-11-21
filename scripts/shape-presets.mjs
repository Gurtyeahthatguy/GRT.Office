// Development only: turns what scripts/shape-presets.py asked LibreOffice for into core/js/draw/presets.js.
// Usage: node scripts/shape-presets.mjs FOLDER, where FOLDER holds own.odg, presets.odp and own.pptx.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const folder = process.argv[2];
const unzip = (file, part) => execFileSync('unzip', ['-p', join(folder, file), part], { maxBuffer: 64 << 20 }).toString();
const attr = (text, name) => {
  const m = new RegExp(`${name.replace(':', '\\:')}="([^"]*)"`).exec(text);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
};

// The menus of LibreOffice, with their labels, from the installed configuration.
const config = readFileSync('/usr/lib/libreoffice/share/registry/main.xcd', 'utf8');
const GROUPS = { BasicShapes: 'basic', SymbolShapes: 'symbol', ArrowShapes: 'arrows', FlowChartShapes: 'flowchart', CalloutShapes: 'callout', StarShapes: 'stars' };
const menus = {};
const labels = {};
for (const [command, group] of Object.entries(GROUPS)) {
  menus[group] = [];
  for (const m of config.matchAll(new RegExp(`\\.uno:${command}\\.([a-zA-Z0-9-]+)" oor:op="replace">([\\s\\S]{0,600}?)</node>`, 'g'))) {
    if (menus[group].includes(m[1])) continue;
    menus[group].push(m[1]);
    const label = /<prop oor:name="Label"[^>]*>\s*<value[^>]*>([^<]+)<\/value>/.exec(m[2]);
    labels[m[1]] = (label?.[1] ?? m[1]).replace(/^Flowchart: /, '');
  }
}

function shapesOf(xml, prefix) {
  const out = {};
  for (const m of xml.matchAll(/<draw:custom-shape\b([^>]*)>([\s\S]*?)<\/draw:custom-shape>/g)) {
    const name = attr(m[1], 'draw:name');
    const g = /<draw:enhanced-geometry\b([^>]*?)(\/>|>([\s\S]*?)<\/draw:enhanced-geometry>)/.exec(m[2]);
    if (!name || !g) continue;
    const head = g[1];
    const body = g[3] ?? '';
    const type = attr(head, 'draw:type');
    const key = prefix ? type?.replace(/^ooxml-/, '') : name;
    const shape = {};
    const box = attr(head, 'svg:viewBox');
    // A missing viewBox is ODF's 21600 square; 0 0 0 0, as OOXML presets have, means the shape's own size.
    if (box === null) shape.box = [0, 0, 21600, 21600];
    else if (box !== '0 0 0 0') shape.box = box.split(/\s+/).map(Number);
    shape.path = attr(head, 'drawooo:enhanced-path') ?? attr(head, 'draw:enhanced-path') ?? '';
    const sub = attr(head, 'drawooo:sub-view-size');
    if (sub) shape.sub = sub.split(/\s+/).map(Number);
    const modifiers = attr(head, 'draw:modifiers');
    if (modifiers) shape.mod = modifiers.split(/\s+/).map(Number);
    const equations = [...body.matchAll(/<draw:equation\b[^>]*draw:formula="([^"]*)"/g)].map((e) => e[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ''));
    if (equations.length) shape.eq = equations;
    const handles = [...body.matchAll(/<draw:handle\b([^>]*)\/>/g)].map((h) => {
      const handle = {};
      for (const a of h[1].matchAll(/draw:handle-([\w-]+)="([^"]*)"/g)) {
        if (a[1] === 'position-x' || a[1] === 'position-y') continue;
        handle[a[1]] = a[2];
      }
      return handle;
    });
    if (handles.length) shape.handles = handles;
    const text = attr(head, 'draw:text-areas');
    if (text) shape.text = text;
    const glue = attr(head, 'draw:glue-points');
    if (glue) shape.glue = glue;
    const mirror = [attr(head, 'draw:mirror-horizontal') === 'true', attr(head, 'draw:mirror-vertical') === 'true'];
    if (mirror[0] || mirror[1]) shape.mirror = mirror;
    const sx = attr(head, 'draw:path-stretchpoint-x');
    const sy = attr(head, 'draw:path-stretchpoint-y');
    if (sx !== null || sy !== null) shape.stretch = [sx === null ? null : Number(sx), sy === null ? null : Number(sy)];
    out[key] = shape;
  }
  return out;
}

const own = shapesOf(unzip('own.odg', 'content.xml'), false);

// Commands whose names are not types: LibreOffice inserts these as another type, square, or with the geometry written out.
const MENU_COMMANDS = readFileSync(join(folder, 'dispatched.txt'), 'utf8').trim().split(',');
const dispatched = [...unzip('dispatched.odg', 'content.xml').matchAll(/<draw:custom-shape\b[^>]*>([\s\S]*?)<\/draw:custom-shape>/g)];
MENU_COMMANDS.forEach((name, i) => {
  const xml = dispatched[i]?.[0];
  if (!xml) throw new Error(`No shape inserted for ${name}`);
  const type = /draw:type="([^"]*)"/.exec(xml)?.[1];
  if (type && own[type]?.path) {
    own[name] = { as: type, square: true };
  } else {
    const [shape] = Object.values(shapesOf(xml.replace(/<draw:custom-shape\b/, `<draw:custom-shape draw:name="${name}"`), false));
    own[name] = { ...shape, odf: type };
  }
});
const ooxml = shapesOf(unzip('presets.odp', 'content.xml'), true);

// What LibreOffice writes into .pptx for each of its own shapes; the rest go out as custom geometry.
const slide = unzip('own.pptx', 'ppt/slides/slide1.xml');
const toOoxml = {};
for (const piece of slide.split(/(?=<p:sp>)/)) {
  const name = /name="O([\w-]+)"/.exec(piece)?.[1];
  const prst = /prstGeom prst="(\w+)"/.exec(piece)?.[1];
  if (name && prst && prst !== 'rect') toOoxml[name] = prst;
}
Object.assign(toOoxml, { rectangle: 'rect', quadrat: 'rect', circle: 'ellipse', 'round-quadrat': 'roundRect' });

// The names of each OOXML preset's adjustments, in order: $0 is the first.
for (const line of readFileSync('/usr/lib/libreoffice/share/filter/oox-drawingml-adj-names', 'utf8').split('\n')) {
  const [preset, name] = line.split('\t');
  if (preset && name && ooxml[preset]) (ooxml[preset].adj ??= []).push(name.trim());
}

const data = { menus, labels, own, ooxml, toOoxml };
const header = [
  '// Geometry of the custom shapes as LibreOffice 26.2 writes them in ODF: its own, and the OOXML presets it reads.',
  '// Derived from LibreOffice and so under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/), as THIRD-PARTY.md says.',
  '// Generated by scripts/shape-presets.mjs; not edited by hand.',
  '',
].join('\n');
writeFileSync(process.argv[3] ?? 'core/js/draw/presets.js', `${header}export const PRESETS = ${JSON.stringify(data)};\n`);
console.log(Object.keys(own).length, 'own,', Object.keys(ooxml).length, 'ooxml,', Object.keys(toOoxml).length, 'mapped');
