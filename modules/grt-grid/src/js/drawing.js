/** Drawing objects on Grid's sheets, as Calc has them: shapes, pictures, text boxes and formulas anchored to a cell or to the page. */

import { DrawLayer } from './core/draw/layer.js';
import { drawCommands } from './core/draw/commands.js';
import { drawingHolder, fillHolder } from './core/editor/drawings.js';
import { cleanSheetDrawings, fromDataUrl } from './core/formats/sheet-drawings.js';
import { showPanel, readFields, escapeHtml } from './core/panel.js';
import { naturalSize } from './core/images.js';
import { stripMetadata } from './core/image-metadata.js';
import { toBase64 } from './core/formats/odf.js';
import { formulaDialog } from './core/formula-dialog.js';
import { mathSvg } from './core/math.js';

const shiftAll = (o, dx, dy) => {
  o.x += dx;
  o.y += dy;
  for (const c of o.children ?? []) shiftAll(c, dx, dy);
  return o;
};
const dataUrl = (bytes, type) => `data:${type};base64,${toBase64(bytes)}`;
const makeId = () => `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const CM = 96 / 2.54;

/**
 * @param {Object} app view() GridView, sheet() SheetController, model(), toast(message), pickImage() -> {bytes, type, name}|null,
 *   saveBytes(bytes, name), refresh()
 */
export function gridDrawing(app) {
  const model = () => app.model();
  let view = [];
  const origins = new Map();
  const placedAt = new Map();
  let body = null;
  let holders = null;
  let overlay = null;
  let handles = null;
  let gridLayer = null;

  /** The drawing grid over the cells, shown as the View menu says. */
  function showGrid() {
    const grid = app.gridOptions?.() ?? { show: false };
    gridLayer.hidden = !grid.show;
    if (grid.show) Object.assign(gridLayer.style, { backgroundSize: `${grid.step}mm ${grid.step}mm`, backgroundPosition: `-${grid.step / 2}mm -${grid.step / 2}mm` });
  }

  /** The layers drawings live in, made in the sheet's body once. */
  function ensureLayers() {
    const current = app.view().body;
    if (body === current && holders?.isConnected) return;
    body = current;
    holders = document.createElement('div');
    holders.className = 'sheet-drawings';
    overlay = document.createElement('div');
    overlay.className = 'draw-overlay sheet-draw-overlay';
    handles = document.createElement('div');
    handles.className = 'sheet-handles';
    overlay.append(handles);
    gridLayer = document.createElement('div');
    gridLayer.className = 'sheet-draw-grid';
    body.append(gridLayer, holders, overlay);
    layer.surface?.removeEventListener?.('mousedown', layer.onDown);
    layer.attach(body);
  }

  const zoom = () => { const r = body.getBoundingClientRect(); return body.offsetWidth ? r.width / body.offsetWidth : 1; };
  const toPage = (cx, cy) => { const r = body.getBoundingClientRect(); const z = zoom(); return { x: (cx - r.left) / z, y: (cy - r.top) / z }; };
  const cellOrigin = (anchor) => ({ x: app.view().offsetAt('cols', anchor.col), y: app.view().offsetAt('rows', anchor.row) });
  const sheetId = () => app.sheet().sheetId;
  const pictureOf = (o) => o.resource ?? null;

  /** The drawings of the sheet in view, placed where their anchors put them, and drawn. */
  function layout() {
    ensureLayers();
    showGrid();
    if (layer.gesture) return;
    origins.clear();
    placedAt.clear();
    view = model().drawings.filter((o) => o.sheet === sheetId()).map((o) => {
      const origin = o.anchor.type === 'cell' ? cellOrigin(o.anchor) : { x: 0, y: 0 };
      origins.set(o.id, origin);
      const copy = shiftAll(structuredClone(o), origin.x, origin.y);
      if (o.anchor.type === 'cell' && o.anchor.resize && o.anchor.end) {
        // Resized with its cells: its far corner stays where it was in the cell it ends in.
        const end = cellOrigin(o.anchor.end);
        copy.w = Math.max(1, end.x + o.anchor.end.dx - copy.x);
        copy.h = Math.max(1, end.y + o.anchor.end.dy - copy.y);
      }
      placedAt.set(o.id, { x: copy.x, y: copy.y });
      return copy;
    });
    const ids = new Set(view.map((o) => o.id));
    for (const id of [...layer.selection]) if (!ids.has(id)) layer.selection.delete(id);
    holders.replaceChildren(...[...view].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((o) => {
      const holder = drawingHolder(o, { objects: view, image: pictureOf });
      holder.classList.add('sheet-drawing');
      holder.classList.toggle('background', Boolean(o.background));
      Object.assign(holder.style, { left: `${o.x}px`, top: `${o.y}px` });
      return holder;
    }));
    renderOverlay();
  }

  function renderOverlay() {
    if (!handles) return;
    handles.replaceChildren(...layer.overlay());
    overlay.classList.toggle('drawing-tool', Boolean(layer.tool || layer.pendingPath));
  }

  const holderOf = (id) => holders?.querySelector(`.sheet-drawing[data-id="${CSS.escape(id)}"]`);

  function redraw() {
    for (const v of view) {
      let holder = holderOf(v.id);
      if (!holder) {
        holder = drawingHolder(v, { objects: view, image: pictureOf });
        holder.classList.add('sheet-drawing');
        holders.append(holder);
      }
      if (holder.classList.contains('editing-text')) continue;
      fillHolder(holder, v, { objects: view, image: pictureOf });
      Object.assign(holder.style, { left: `${v.x}px`, top: `${v.y}px` });
    }
    for (const holder of [...holders.children]) if (!view.some((v) => v.id === holder.dataset.id)) holder.remove();
    renderOverlay();
  }

  /** The layer's copies back into the workbook, each moved one anchored to the cell it now starts in. */
  function writeBack() {
    const others = model().drawings.filter((o) => o.sheet !== sheetId());
    const old = new Map(model().drawings.map((o) => [o.id, o]));
    const mine = view.map((v) => {
      const before = old.get(v.id);
      let anchor = structuredClone(v.anchor ?? before?.anchor ?? { type: 'cell' });
      let origin = origins.get(v.id) ?? { x: 0, y: 0 };
      const placed = placedAt.get(v.id);
      const moved = !placed || Math.abs(placed.x - v.x) > 0.01 || Math.abs(placed.y - v.y) > 0.01;
      if (anchor.type === 'cell' && (moved || anchor.row === undefined)) {
        const at = app.view().anchorAt(v.x, v.y);
        anchor = { ...anchor, row: at.row, col: at.col };
        origin = cellOrigin(anchor);
      }
      if (anchor.type === 'page') origin = { x: 0, y: 0 };
      if (anchor.type === 'cell' && anchor.resize) {
        const end = app.view().anchorAt(v.x + v.w, v.y + v.h);
        anchor.end = { row: end.row, col: end.col, dx: end.dx, dy: end.dy };
      } else delete anchor.end;
      const out = shiftAll(structuredClone(v), -origin.x, -origin.y);
      out.anchor = anchor;
      out.sheet = sheetId();
      return out;
    });
    model().drawings = cleanSheetDrawings([...others, ...mine], model().sheets);
  }

  /** One undo step around what the layer did, the sheet drawn again. */
  function commit(before) {
    writeBack();
    record(before);
  }

  function record(before) {
    const sheet = app.sheet();
    sheet.undo.past.push({ ...before, selection: { active: { ...sheet.active }, anchor: { ...sheet.anchor } } });
    if (sheet.undo.past.length > sheet.undo.limit) sheet.undo.past.shift();
    sheet.undo.future.length = 0;
    model().dirty = true;
    sheet.onChange({ edited: true });
  }

  function change(mutate) {
    const before = model().snapshot();
    if (mutate() === false) return false;
    record(before);
    return true;
  }

  const host = {
    objects: () => view,
    toPage,
    snapshot: () => model().snapshot(),
    commit,
    redraw,
    selectionChanged: () => { if (layer.selection.size) document.activeElement?.blur?.(); app.refresh(); },
    page: () => ({ w: body?.offsetWidth ?? 2000, h: body?.offsetHeight ?? 2000 }),
    makeId,
    add: (o) => { const fresh = { anchor: { type: 'cell' }, sheet: sheetId(), ...o }; view.push(fresh); return fresh; },
    remove: (ids) => { const doomed = new Set(ids); view = view.filter((o) => !doomed.has(o.id)); },
    claims: (event, hit) => hit.kind === 'handle' || Boolean(event.target?.closest?.('.sheet-drawing')),
    grid: () => { const g = app.gridOptions?.(); return g ? { step: g.step * (96 / 25.4), snap: g.snap } : null; },
    helplines: () => app.helplines?.() ?? true,
    create: (tool, box) => {
      if (tool.kind !== 'text') return null;
      const o = { id: makeId(), kind: 'shape', shape: 'rectangle', ...box, w: Math.max(box.w, 120), h: Math.max(box.h, 40), rotation: 0, fillLook: { type: 'none' }, line: { style: 'none' }, text: '', name: 'Text Box', anchor: { type: 'cell' } };
      setTimeout(() => editText(o.id), 0);
      return o;
    },
    doubleClick: (hit) => {
      if (hit.kind !== 'object') return;
      const o = view.find((x) => x.id === hit.id);
      if (o?.tex) editFormula(o);
      else editText(hit.id);
    },
    announce: (text) => app.toast(text),
  };
  const layer = new DrawLayer(document.createElement('div'), host);
  // The layer listens on the sheet's body, which a new sheet view replaces.
  layer.attach = (surface) => {
    layer.surface?.removeEventListener('mousedown', layer.onDown);
    layer.surface = surface;
    layer.onDown ??= (e) => layer.down(e);
    surface.addEventListener('mousedown', layer.onDown);
  };

  /** Typing into a shape or a text box: a box over it, its text kept when the box is left. */
  function editText(id) {
    const o = view.find((x) => x.id === id);
    if (!o || !['shape', 'path'].includes(o.kind)) return;
    const holder = holderOf(id);
    const box = document.createElement('textarea');
    box.className = 'editing drawing-editor';
    box.value = o.text ?? '';
    box.setAttribute('aria-label', 'Text of the shape');
    Object.assign(box.style, { left: `${o.x}px`, top: `${o.y}px`, width: `${Math.max(o.w, 60)}px`, height: `${Math.max(o.h, 30)}px` });
    holder?.classList.add('editing-text');
    overlay.append(box);
    box.focus();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      box.remove();
      holder?.classList.remove('editing-text');
      const live = view.find((x) => x.id === id);
      if (live && box.value !== (live.text ?? '')) {
        const before = model().snapshot();
        live.text = box.value;
        commit(before);
      } else if (live && !live.text && !box.value && live.name === 'Text Box') {
        change(() => { model().drawings = model().drawings.filter((d) => d.id !== id); });
      }
    };
    box.addEventListener('blur', finish);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(); }
      event.stopPropagation();
    });
  }

  async function editFormula(o) {
    const formula = await formulaDialog({ display: true, tex: o.tex });
    if (!formula) return;
    const svg = mathSvg({ tex: formula.tex, display: true });
    if (!svg) { app.toast('The formula could not be drawn'); return; }
    const before = model().snapshot();
    const live = view.find((x) => x.id === o.id);
    if (!live) return;
    live.tex = formula.tex;
    live.resource = dataUrl(new TextEncoder().encode(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')), 'image/svg+xml');
    commit(before);
  }

  /** The keys of chosen drawings, before the sheet's own. */
  function handleKey(event) {
    if (!layer.selection.size && !layer.tool && !layer.pendingPath) return false;
    if (event.target.closest?.('input, textarea, select, .panel, .editing')) return false;
    if (event.key === 'Enter' && layer.selection.size === 1 && !layer.pendingPath) {
      event.preventDefault();
      const o = view.find((x) => layer.selection.has(x.id));
      if (o?.tex) editFormula(o); else editText(o.id);
      return true;
    }
    if (layer.key(event)) { event.preventDefault(); event.stopPropagation(); return true; }
    return false;
  }

  // Commands, by Calc's names

  const pictures = {
    bytes: (o) => fromDataUrl(o.resource),
    put: async (bytes, type) => dataUrl(bytes, type),
    href: (o) => o.resource,
    natural: (o) => { const d = fromDataUrl(o.resource); return d ? naturalSize(d.bytes) : null; },
    pick: () => app.pickImage(),
    save: async (o) => { const d = fromDataUrl(o.resource); if (d) await app.saveBytes(d.bytes, `picture.${d.type.split('/')[1]?.replace('svg+xml', 'svg') ?? 'png'}`); },
    label: (o) => o.name ?? 'Image',
  };
  const commands = drawCommands({
    layer,
    host: { snapshot: host.snapshot, commit, redraw, makeId, page: host.page, selectionChanged: host.selectionChanged },
    toast: app.toast,
    unit: { per: CM, label: 'cm', inch: 96 },
    images: pictures,
    // Fit to Cell Size: the box of the cell the picture is anchored to.
    cell: (o) => {
      const at = app.view().anchorAt(o.x + 1, o.y + 1);
      const origin = cellOrigin(at);
      const sheet = app.sheet().sheet;
      return { x: origin.x, y: origin.y, w: sheet.columnWidth(at.col), h: sheet.rowHeight(at.row) };
    },
  });

  const need = () => { if (layer.selection.size) return true; app.toast('Choose a drawing, a picture or a text box first'); return false; };
  const chosen = () => view.filter((o) => layer.selection.has(o.id));

  /** Anchor: the chosen drawings anchored again where they stand. */
  function anchorTo(type, resize = false) {
    if (!need()) return;
    const before = model().snapshot();
    for (const v of chosen()) {
      v.anchor = type === 'page' ? { type: 'page' } : { type: 'cell', ...(resize ? { resize: true } : {}) };
      placedAt.delete(v.id);
    }
    commit(before);
  }
  const anchorOn = (type, resize = false) => chosen().some((o) => o.anchor?.type === type && Boolean(o.anchor?.resize) === resize);

  const toBackground = (on) => {
    if (!need()) return;
    const before = model().snapshot();
    for (const v of chosen()) { if (on) v.background = true; else delete v.background; }
    commit(before);
  };

  /** A new drawing at the cell the cursor is on, chosen. */
  function place(o) {
    const sheet = app.sheet();
    const at = { row: sheet.active.row, col: sheet.active.col };
    change(() => {
      model().drawings = cleanSheetDrawings([...model().drawings, { ...o, x: 0, y: 0, sheet: sheetId(), anchor: { type: 'cell', ...at } }], model().sheets);
    });
    layer.select([o.id]);
  }

  const insert = {
    image: async () => {
      const picked = await app.pickImage();
      if (!picked) return;
      const bytes = stripMetadata(picked.bytes);
      const size = naturalSize(bytes) ?? { w: 320, h: 240 };
      const scale = Math.min(1, 480 / Math.max(size.w, size.h, 1));
      place({ id: makeId(), kind: 'image', resource: dataUrl(bytes, picked.type), w: size.w * scale, h: size.h * scale, rotation: 0, name: picked.name ?? 'Image' });
    },
    textBox: () => layer.useTool({ kind: 'text' }),
    formula: async () => {
      const formula = await formulaDialog({ display: true });
      if (!formula) return;
      const svg = mathSvg({ tex: formula.tex, display: true });
      if (!svg) { app.toast('The formula could not be drawn'); return; }
      const w = Number(/width="([\d.]+)/.exec(svg)?.[1]) || 200;
      const h = Number(/height="([\d.]+)/.exec(svg)?.[1]) || 60;
      place({ id: makeId(), kind: 'image', tex: formula.tex, resource: dataUrl(new TextEncoder().encode(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')), 'image/svg+xml'), w: w * 1.5, h: h * 1.5, rotation: 0, name: 'Formula' });
    },
    signatureLine: async () => {
      const html = `<div class="form-grid"><label class="field"><span>Name</span><input type="text" data-field="name" maxlength="100"></label>
        <label class="field"><span>Title</span><input type="text" data-field="title" maxlength="100"></label>
        <label class="field"><span>Email</span><input type="text" data-field="email" maxlength="100"></label></div>
        <p class="hint">A line to sign on by hand, with these under it. It is a picture: signing digitally is another matter.</p>`;
      if (!(await showPanel('Signature Line', html, 'OK'))) return;
      const f = readFields();
      const esc = (s) => escapeHtml(String(s ?? '').slice(0, 100));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="110" viewBox="0 0 300 110"><text x="8" y="58" font-family="sans-serif" font-size="28" fill="#555">X</text><line x1="8" y1="64" x2="292" y2="64" stroke="#333" stroke-width="1.5"/><text x="8" y="82" font-family="sans-serif" font-size="13" fill="#222">${esc(f.name)}</text><text x="8" y="97" font-family="sans-serif" font-size="11" fill="#555">${esc(f.title)}</text><text x="8" y="108" font-family="sans-serif" font-size="10" fill="#777">${esc(f.email)}</text></svg>`;
      place({ id: makeId(), kind: 'image', resource: dataUrl(new TextEncoder().encode(svg), 'image/svg+xml'), w: 300, h: 110, rotation: 0, name: 'Signature Line' });
    },
  };

  const menus = {
    anchor: () => ({ label: 'Anchor', items: [
      { label: 'To Page', run: () => anchorTo('page'), checked: () => anchorOn('page'), aliases: ['Anchor to page'] },
      { label: 'To Cell', run: () => anchorTo('cell'), checked: () => anchorOn('cell'), aliases: ['Anchor to cell', 'Move with cells'] },
      { label: 'To Cell (resize with cell)', run: () => anchorTo('cell', true), checked: () => anchorOn('cell', true), aliases: ['Move and size with cells'] },
    ] }),
    arrange: () => {
      const base = commands.menus.arrange('calc');
      return { ...base, items: [...base.items, 'separator',
        { label: 'To Foreground', run: () => toBackground(false), aliases: ['In front of cells'] },
        { label: 'To Background', run: () => toBackground(true), aliases: ['Behind cells'] }] };
    },
  };

  return { layer, commands, insert, menus, layout, handleKey, chosen: () => layer.selection.size, editText };
}
