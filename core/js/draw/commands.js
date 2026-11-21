/** The commands of drawing objects and the menu items that run them, named as LibreOffice names them in each program. */

import { SHAPE_MENUS, shapeLabel } from './geometry.js';
import { objectLabel } from './layer.js';
import {
  arrange, align, distribute, equalize, flip, rotateBy, makeGroup, ungroup, duplicate, convert, convertTo3d, unionBox,
} from './objects.js';
import { SOLIDS } from './three.js';
import { showPanel, readFields } from '../panel.js';
import { drawingSvg } from './render.js';
import {
  positionSizeDialog, lineDialog, areaDialog, textAttributesDialog, nameDialog, descriptionDialog, duplicateDialog,
  cropDialog, imageColorDialog, compressDialog, distributeDialog, snapGuideDialog, rotateDialog, sizeCheckDialog, textPathDialog,
} from './dialogs.js';
import { FILTERS, FILTER_MENU, decodePixels, encodePixels, rasterizeSvg } from './image-filters.js';

const GROUP_TITLES = { basic: 'Basic Shapes', symbol: 'Symbol Shapes', arrows: 'Block Arrows', flowchart: 'Flowchart', callout: 'Callout Shapes', stars: 'Stars and Banners' };

const sizeText = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * @param {Object} ctx
 * @param {import('./layer.js').DrawLayer} ctx.layer
 * @param {Object} ctx.host the layer's host, with snapshot(), commit(before), redraw(), makeId(), page()
 * @param {(message: string) => void} ctx.toast
 * @param {{per: number, label: string}} [ctx.unit]
 * @param {Object} [ctx.images] bytes(o), put(bytes, type) -> resource, natural(o) -> {w, h}, pick(), save(o), label(o)
 * @param {(o: Object) => ?Object} [ctx.cell] the box of the cell an object sits in, for Fit to Cell Size
 * @param {Object} [ctx.guides] add(guide) for Snap Guide
 */
export function drawCommands(ctx) {
  const { layer, host, toast } = ctx;
  const unit = ctx.unit ?? { per: 1, label: 'px' };
  // A program may add its own items to what the commands of shape and place act on, as Graphs adds its nodes.
  const chosen = () => [...layer.chosen(), ...(ctx.alsoChosen?.() ?? [])];
  const one = () => (chosen().length === 1 ? chosen()[0] : null);
  const images = () => chosen().filter((o) => o.kind === 'image');

  /** One undo step around a change; nothing is recorded when nothing was chosen. */
  const change = (mutate, need = 1) => {
    if (chosen().length < need) {
      toast(need > 1 ? `Choose at least ${need} objects first` : 'Choose an object first');
      return false;
    }
    const before = host.snapshot();
    const result = mutate();
    if (result === false) return false;
    layer.refitConnectors();
    host.commit(before);
    host.redraw();
    host.selectionChanged?.();
    return true;
  };

  const act = {
    /** Select First Object: from the text or the cells to the drawings, with the keyboard; Tab then goes on to the next. */
    selectFirst: () => {
      const list = [...layer.objects()].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      if (!list.length) { toast('There are no drawings here'); return; }
      layer.select([list[0].id]);
      host.selectionChanged?.();
      (ctx.announce ?? toast)(objectLabel(list[0]));
    },
    tool: (tool) => layer.useTool(tool),
    shape: (type) => layer.useTool({ kind: 'shape', type }),
    pointEdit: () => {
      if (!chosen().some((o) => o.kind === 'path' || o.kind === 'shape')) { toast('Choose a curve or a polygon; Convert, To Curve makes one of a shape'); return; }
      layer.setMode('points');
    },
    glue: () => layer.setMode('glue'),
    arrange: (how) => change(() => arrange(layer.objects(), layer.selection, how)),
    /** In Front of Object and Behind Object: the next object clicked is the one to go beside. */
    arrangeBeside: (how) => {
      if (!chosen().length) { toast('Choose an object first'); return; }
      toast(how === 'in-front-of' ? 'Click the object to go in front of' : 'Click the object to go behind');
      const ids = [...layer.selection];
      const pick = (event) => {
        layer.surface.removeEventListener('mousedown', pick, true);
        const id = event.target?.closest?.('[data-id]')?.dataset.id;
        if (!id || ids.includes(id)) return;
        event.stopPropagation();
        event.preventDefault();
        const before = host.snapshot();
        arrange(layer.objects(), ids, how, id);
        host.commit(before);
        layer.select(ids);
      };
      layer.surface.addEventListener('mousedown', pick, true);
    },
    align: (how) => change(() => align(chosen(), how, chosen().length === 1 ? host.page?.() : null)),
    distribute: async () => {
      if (chosen().length < 3) { toast('Choose at least three objects first'); return; }
      const f = await distributeDialog();
      if (!f) return;
      change(() => { if (f.h !== 'none') distribute(chosen(), f.h); if (f.v !== 'none') distribute(chosen(), f.v); }, 3);
    },
    equalize: (what) => change(() => equalize(chosen(), what), 2),
    rotate: (degrees) => change(() => rotateBy(chosen(), degrees)),
    resetRotation: () => change(() => { for (const o of chosen()) o.rotation = 0; }),
    rotateDialog: async () => {
      const o = chosen()[0];
      if (!o) { toast('Choose an object first'); return; }
      const angle = await rotateDialog(o.rotation ?? 0);
      if (angle !== null) change(() => { for (const x of chosen()) x.rotation = angle; });
    },
    flip: (vertical) => change(() => flip(chosen(), vertical)),
    group: () => change(() => {
      const members = chosen();
      const group = makeGroup(members.map((m) => structuredClone(m)), host.makeId());
      layer.removeObjects(members.map((m) => m.id));
      layer.addObject(group);
      layer.selection = new Set([group.id]);
    }, 2),
    ungroup: () => change(() => {
      const groups = chosen().filter((o) => o.kind === 'group');
      if (!groups.length) { toast('Choose a group first'); return false; }
      const freed = [];
      for (const g of groups) {
        layer.removeObjects([g.id]);
        for (const c of ungroup(g)) { c.z = (g.z ?? 0) + freed.length * 0.001; freed.push(layer.addObject(c)); }
      }
      layer.selection = new Set(freed.map((o) => o.id));
      return true;
    }),
    enterGroup: () => { const g = one(); if (g?.kind === 'group') layer.enterGroup(g.id); else toast('Choose a group first'); },
    exitGroup: () => { if (!layer.exitGroup()) toast('No group is entered'); },
    duplicate: async () => {
      const o = one();
      if (!o) { toast('Choose one object first'); return; }
      const how = await duplicateDialog(unit);
      if (!how) return;
      change(() => {
        const copies = duplicate(o, how, () => host.makeId());
        for (const c of copies) layer.addObject(c);
        layer.selection = new Set(copies.map((c) => c.id));
      });
    },
    convert: async (to) => {
      if (to === 'bitmap' || to === 'metafile') { await act.toPicture(to); return; }
      change(() => chosen().map((o) => convert(o, to)).some(Boolean) || (toast('Choose a shape, a line or a curve to convert'), false));
    },
    convert3d: (how) => change(() => chosen().map((o) => convertTo3d(o, how)).some(Boolean) || (toast('Choose a shape or a curve to make 3D'), false)),
    /** 3D Effects: the angles a 3D object is seen from, its depth and its colour. */
    effects3d: async () => {
      const o = chosen().find((x) => x.kind === 'scene3d');
      if (!o) { toast('Choose a 3D object first'); return; }
      const field = (name, label, value, min, max) => `<label class="field"><span>${label}</span><input type="number" data-field="${name}" min="${min}" max="${max}" step="1" value="${Math.round(value)}"></label>`;
      const html = `<div class="form-grid">${field('rotX', 'Turn about X (°)', o.rotX ?? 20, -360, 360)}${field('rotY', 'Turn about Y (°)', o.rotY ?? -30, -360, 360)}${field('rotZ', 'Turn about Z (°)', o.rotZ ?? 0, -360, 360)}${field('depth', 'Depth (%)', (o.depth ?? 0.3) * 100, 1, 500)}<label class="field"><span>Colour</span><input type="color" data-field="color" value="${o.color ?? '#729fcf'}"></label></div>`;
      if (!(await showPanel('3D Effects', html, 'OK'))) return;
      const f = readFields();
      change(() => { Object.assign(o, { rotX: f.rotX, rotY: f.rotY, rotZ: f.rotZ, depth: Math.max(0.01, f.depth / 100), color: f.color }); });
    },
    /** To Bitmap draws the object as a picture; To Metafile keeps it drawn, as an SVG picture. */
    toPicture: async (to) => {
      const o = one();
      if (!o || !ctx.images?.put) { toast('Choose one object first'); return; }
      const svg = drawingSvg({ ...o, x: 0, y: 0, rotation: 0 }, { objects: layer.objects(), image: (x) => ctx.images.href?.(x), standalone: true });
      let resource;
      try {
        resource = to === 'bitmap'
          ? await ctx.images.put(await rasterizeSvg(svg, o.w, o.h), 'image/png')
          : await ctx.images.put(new TextEncoder().encode(svg), 'image/svg+xml');
      } catch (error) {
        toast(`Could not make a picture: ${error.message}`);
        return;
      }
      change(() => {
        const keep = { id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, rotation: o.rotation ?? 0, z: o.z, name: o.name, description: o.description };
        for (const key of Object.keys(o)) delete o[key];
        Object.assign(o, keep, { kind: 'image', resource });
      });
    },
    positionSize: async () => {
      const o = one();
      if (!o) { toast('Choose one object first'); return; }
      const f = await positionSizeDialog(o, unit);
      if (!f) return;
      change(() => {
        const sx = f.w / o.w;
        const sy = f.h / o.h;
        Object.assign(o, { x: f.x, y: f.y, w: f.w, h: f.h, rotation: f.rotation });
        if (o.kind === 'path') o.subpaths = o.subpaths.map((s) => ({ closed: s.closed, nodes: s.nodes.map((n) => ({ x: n.x * sx, y: n.y * sy, ...(n.in ? { in: { x: n.in.x * sx, y: n.in.y * sy } } : {}), ...(n.out ? { out: { x: n.out.x * sx, y: n.out.y * sy } } : {}) })) }));
        if (f.keepRatio) o.keepRatio = true; else delete o.keepRatio;
        if (f.protect.position || f.protect.size) o.protect = f.protect; else delete o.protect;
      });
    },
    line: async () => {
      const o = chosen()[0];
      if (!o) { toast('Choose an object first'); return; }
      const line = await lineDialog(o);
      if (line) change(() => { for (const x of chosen()) x.line = line; });
    },
    area: async () => {
      const o = chosen()[0];
      if (!o) { toast('Choose an object first'); return; }
      const f = await areaDialog(o);
      if (f) change(() => { for (const x of chosen()) { x.fillLook = f.fillLook; if (f.shadow) x.shadow = true; else delete x.shadow; } });
    },
    textAttributes: async () => {
      const o = chosen()[0];
      if (!o) { toast('Choose an object first'); return; }
      const f = await textAttributesDialog(o);
      if (f) change(() => { for (const x of chosen()) x.textLook = f; });
    },
    textPath: async () => {
      const o = one();
      if (o?.kind !== 'shape') { toast('Choose a shape first'); return; }
      if (o.textPath) { change(() => { delete o.textPath; }); return; }
      const text = await textPathDialog(ctx.shapeText?.(o) ?? o.pathText ?? '');
      if (text === null) return;
      change(() => { o.textPath = true; o.pathText = text; ctx.setShapeText?.(o, text); });
    },
    name: async () => {
      const o = one();
      if (!o) { toast('Choose one object first'); return; }
      const name = await nameDialog(o);
      if (name !== null) change(() => { if (name) o.name = name; else delete o.name; });
    },
    description: async () => {
      const o = one();
      if (!o) { toast('Choose one object first'); return; }
      const f = await descriptionDialog(o);
      if (f) change(() => { for (const k of ['title', 'description']) { if (f[k]) o[k] = f[k]; else delete o[k]; } });
    },
    snapGuide: async () => {
      const g = await snapGuideDialog(unit);
      if (g && ctx.guides?.add) { const before = host.snapshot(); ctx.guides.add(g); host.commit(before); host.redraw(); }
    },
    // Images
    crop: async () => {
      const o = images()[0];
      if (!o) { toast('Choose an image first'); return; }
      const f = await cropDialog(o);
      if (!f) return;
      change(() => {
        const old = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
        if (!f.keepSize) {
          // The frame shrinks with what is hidden, so the picture keeps its scale.
          const fullW = o.w / Math.max(1 - old.l - old.r, 0.05);
          const fullH = o.h / Math.max(1 - old.t - old.b, 0.05);
          o.x += (f.crop.l - old.l) * fullW;
          o.y += (f.crop.t - old.t) * fullH;
          o.w = fullW * Math.max(1 - f.crop.l - f.crop.r, 0.05);
          o.h = fullH * Math.max(1 - f.crop.t - f.crop.b, 0.05);
        }
        o.crop = f.crop;
      });
    },
    originalSize: () => change(() => {
      for (const o of images()) {
        const n = ctx.images?.natural?.(o);
        if (!n) continue;
        const c = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
        o.w = n.w * (1 - c.l - c.r);
        o.h = n.h * (1 - c.t - c.b);
      }
    }),
    fitToCell: () => change(() => {
      for (const o of chosen()) {
        const cell = ctx.cell?.(o);
        if (cell) Object.assign(o, { x: cell.x, y: cell.y, w: cell.w, h: cell.h, rotation: 0 });
      }
    }),
    replaceImage: async () => {
      const o = images()[0];
      if (!o || !ctx.images?.pick) { toast('Choose an image first'); return; }
      const picked = await ctx.images.pick();
      if (!picked) return;
      const resource = await ctx.images.put(picked.bytes, picked.type);
      change(() => { o.resource = resource; delete o.crop; });
    },
    saveImage: async () => {
      const o = images()[0];
      if (!o || !ctx.images?.save) { toast('Choose an image first'); return; }
      await ctx.images.save(o);
    },
    color: async () => {
      const o = images()[0];
      if (!o) { toast('Choose an image first'); return; }
      const f = await imageColorDialog(o);
      if (f) change(() => { for (const x of images()) x.adjust = f; });
    },
    compress: async () => {
      const o = images()[0];
      const source = o && ctx.images?.bytes?.(o);
      if (!source) { toast('Choose an image first'); return; }
      let pixels;
      try { pixels = await decodePixels(source.bytes, source.type); } catch (error) { toast(`Could not read the image: ${error.message}`); return; }
      const how = await compressDialog({ pixels: `${pixels.width} × ${pixels.height}`, size: sizeText(source.bytes.length), format: source.type.includes('png') ? 'png' : 'jpeg' });
      if (!how) return;
      const made = await encodePixels(pixels, how);
      const resource = await ctx.images.put(made.bytes, made.type);
      change(() => { o.resource = resource; });
      toast(`Now ${made.width} × ${made.height} pixels, ${sizeText(made.bytes.length)}`);
    },
    filter: async (name) => {
      const o = images()[0];
      const source = o && ctx.images?.bytes?.(o);
      if (!source || !FILTERS[name]) { toast('Choose an image first'); return; }
      try {
        const pixels = await decodePixels(source.bytes, source.type);
        const made = await encodePixels(FILTERS[name](pixels), { format: 'png' });
        const resource = await ctx.images.put(made.bytes, made.type);
        change(() => { o.resource = resource; });
      } catch (error) {
        toast(`Could not apply the filter: ${error.message}`);
      }
    },
    sizeCheck: async () => {
      const all = layer.objects().filter((o) => o.kind === 'image');
      const rows = all.map((o) => {
        const n = ctx.images?.natural?.(o, true);
        const inches = (o.w / unit.per) / (unit.inch ?? 96);
        return n ? { name: ctx.images?.label?.(o) ?? o.name ?? 'Image', pixels: `${n.w} × ${n.h}`, shown: `${(o.w / unit.per).toFixed(1)} × ${(o.h / unit.per).toFixed(1)} ${unit.label}`, dpi: Math.round(n.w / Math.max(inches, 1e-6)) } : null;
      }).filter(Boolean);
      await sizeCheckDialog(rows);
    },
  };

  // Menus

  const lineItems = [
    { label: 'Line', run: () => act.tool({ kind: 'line' }), aliases: ['Insert Line', 'Draw a line'] },
    { label: 'Freeform Line', run: () => act.tool({ kind: 'freeform' }), aliases: ['Freehand', 'Draw freehand'] },
    { label: 'Freeform Line, Filled', run: () => act.tool({ kind: 'freeform', filled: true }), aliases: ['Freeform Line Filled'] },
    { label: 'Curve', run: () => act.tool({ kind: 'curve' }), aliases: ['Bézier curve', 'Bezier'] },
    { label: 'Curve, Filled', run: () => act.tool({ kind: 'curve', filled: true }), aliases: ['Curve Filled'] },
    { label: 'Polygon', run: () => act.tool({ kind: 'polygon' }) },
    { label: 'Polygon (45°)', run: () => act.tool({ kind: 'polygon', at45: true }) },
    { label: 'Polygon (45°), Filled', run: () => act.tool({ kind: 'polygon', at45: true, filled: true }), aliases: ['Polygon (45°) Filled'] },
  ];
  const connectorItems = [
    { label: 'Connector', run: () => act.tool({ kind: 'connector', routing: 'standard' }), aliases: ['Standard Connector'] },
    { label: 'Line Connector', run: () => act.tool({ kind: 'connector', routing: 'lines' }) },
    { label: 'Straight Connector', run: () => act.tool({ kind: 'connector', routing: 'line' }) },
    { label: 'Curved Connector', run: () => act.tool({ kind: 'connector', routing: 'curve' }) },
  ];
  // The group's own name finds its first shape in the command palette, as Insert Shape always found the rectangle.
  const shapeGroup = (group) => ({ label: GROUP_TITLES[group], items: SHAPE_MENUS[group].map((type, i) => ({ label: shapeLabel(type), run: () => act.shape(type), ...(i === 0 ? { aliases: [GROUP_TITLES[group], ...(group === 'basic' ? ['Shape', 'Insert Shape'] : [])] } : {}) })) });

  const menus = {
    /** Edit, Select First Object, as Writer's Shift+F4 does for its frames. */
    selectFirst: () => ({ label: 'Select First Object', shortcut: 'Shift+F4', run: act.selectFirst, aliases: ['Select drawing', 'Go to the drawings', 'Object navigation'] }),
    /** Insert, Shape: Line, Connectors and the six groups of shapes. */
    shape: () => ({ label: 'Shape', items: [
      { label: 'Line', items: lineItems },
      { label: 'Connectors', items: connectorItems },
      'separator',
      ...['basic', 'arrows', 'symbol', 'stars', 'callout', 'flowchart'].map(shapeGroup),
    ] }),
    lineItems: () => lineItems,
    shapeGroup,
    /** Arrange, with Writer's and Impress's names for the one-step moves. */
    arrange: (names = 'impress') => ({ label: 'Arrange', items: [
      { label: 'Bring to Front', shortcut: names === 'calc' ? undefined : 'Ctrl+Shift++', run: () => act.arrange('front') },
      { label: 'Forward One', shortcut: names === 'calc' ? undefined : 'Ctrl++', run: () => act.arrange('forward'), aliases: ['Bring Forward'] },
      { label: names === 'writer' || names === 'calc' ? 'Back One' : 'Backward One', shortcut: names === 'calc' ? undefined : 'Ctrl+-', run: () => act.arrange('backward'), aliases: ['Send Backward', 'Back One', 'Backward One'] },
      { label: 'Send to Back', shortcut: names === 'calc' ? undefined : 'Ctrl+Shift+-', run: () => act.arrange('back') },
      ...(names === 'impress' || names === 'draw' ? [
        'separator',
        { label: 'In Front of Object', run: () => act.arrangeBeside('in-front-of') },
        { label: 'Behind Object', run: () => act.arrangeBeside('behind') },
        'separator',
        { label: 'Reverse', run: () => act.arrange('reverse') },
      ] : []),
    ] }),
    alignObjects: () => ({ label: 'Align Objects', items: [
      { label: 'Left', run: () => act.align('left'), aliases: ['Align Left'] },
      { label: 'Centered', run: () => act.align('center'), aliases: ['Align Center'] },
      { label: 'Right', run: () => act.align('right'), aliases: ['Align Right'] },
      'separator',
      { label: 'Top', run: () => act.align('top'), aliases: ['Align Top'] },
      { label: 'Center', run: () => act.align('middle'), aliases: ['Align Middle', 'Align Center Vertically'] },
      { label: 'Bottom', run: () => act.align('bottom'), aliases: ['Align Bottom'] },
    ] }),
    flip: (label = 'Flip', names = 'impress') => ({ label, items: [
      { label: names === 'impress' || names === 'draw' ? 'Vertically' : 'Flip Vertically', run: () => act.flip(true) },
      { label: names === 'impress' || names === 'draw' ? 'Horizontally' : 'Flip Horizontally', run: () => act.flip(false) },
    ] }),
    rotateOrFlip: () => ({ label: 'Rotate or Flip', items: [
      { label: 'Rotate', run: act.rotateDialog },
      { label: 'Rotate 90° Left', run: () => act.rotate(-90) },
      { label: 'Rotate 90° Right', run: () => act.rotate(90) },
      { label: 'Rotate 180°', run: () => act.rotate(180) },
      { label: 'Reset Rotation', run: act.resetRotation },
      'separator',
      { label: 'Flip Vertically', run: () => act.flip(true) },
      { label: 'Flip Horizontally', run: () => act.flip(false) },
    ] }),
    group: (label = 'Group') => ({ label, items: [
      { label: 'Group', shortcut: 'Ctrl+Shift+G', run: act.group },
      { label: 'Ungroup', shortcut: 'Ctrl+Alt+Shift+G', run: act.ungroup },
      // Writer's AutoText shares these keys: they are the group's only while a group is chosen or entered.
      { label: 'Enter Group', shortcut: 'F3', run: act.enterGroup, enabled: () => one()?.kind === 'group' },
      { label: 'Exit Group', shortcut: 'Ctrl+F3', run: act.exitGroup, enabled: () => layer.scope.length > 0 },
    ] }),
    threeD: () => ({ label: '3D Objects', items: Object.entries(SOLIDS).map(([solid, label]) => ({ label, run: () => layer.useTool({ kind: 'scene3d', solid }) })) }),
    convert3dItems: () => [
      { label: 'To 3D', run: () => act.convert3d('extrude') },
      { label: 'To 3D Rotation Object', run: () => act.convert3d('lathe') },
    ],
    convert: () => ({ label: 'Convert', items: [
      { label: 'To Curve', run: () => act.convert('curve') },
      { label: 'To Polygon', run: () => act.convert('polygon') },
      { label: 'To Contour', run: () => act.convert('contour') },
      { label: 'To Bitmap', run: () => act.convert('bitmap') },
      { label: 'To Metafile', run: () => act.convert('metafile') },
    ] }),
    textBoxAndShape: ({ points = true, textPath = false } = {}) => ({ label: 'Text Box and Shape', items: [
      // With nothing chosen F4 is the program's own, as Calc's reference types.
      { label: 'Position and Size…', shortcut: 'F4', run: act.positionSize, enabled: () => chosen().length > 0 },
      { label: 'Line…', run: act.line },
      { label: 'Area…', run: act.area },
      { label: 'Text…', run: act.textAttributes },
      ...(textPath ? [{ label: 'Text along Path', run: act.textPath }] : []),
      ...(points ? [{ label: 'Toggle Point Edit Mode', shortcut: 'F8', run: act.pointEdit, checked: () => layer.mode === 'points', aliases: ['Points', 'Edit Points'] }] : []),
    ] }),
    image: ({ fitToCell = false, filters = false, color = true } = {}) => ({ label: 'Image', items: [
      { label: 'Crop', run: act.crop, aliases: ['Crop Image'] },
      { label: 'Original Size', run: act.originalSize },
      ...(fitToCell ? [{ label: 'Fit to Cell Size', run: act.fitToCell }] : []),
      'separator',
      { label: 'Replace…', run: act.replaceImage, aliases: ['Replace Image'] },
      { label: 'Compress…', run: act.compress, aliases: ['Compress Image'] },
      { label: 'Save…', run: act.saveImage, aliases: ['Save Image', 'Export Image'] },
      ...(filters ? ['separator', ...FILTER_MENU.map(([label, name]) => ({ label, run: () => act.filter(name) }))] : []),
      ...(color ? ['separator', { label: 'Color', run: act.color, aliases: ['Image Color', 'Brightness', 'Contrast', 'Image Mode'] }] : []),
      ...(filters ? [{ label: 'Graphic Size Check…', run: act.sizeCheck }] : []),
    ] }),
    nameItems: () => [
      { label: 'Name…', run: act.name, aliases: ['Object name'] },
      { label: 'Description…', run: act.description, aliases: ['Alt text', 'Alternative text', 'Title and description'] },
    ],
  };

  return { act, menus, change, layerMode: () => layer.mode };
}

/** The upright box of the chosen objects, for programs that show it in the status bar. */
export const selectionBox = (objects) => unionBox(objects);
