/** A drawing on a page of its own, with Draw's tools: what a note keeps as a drawing, made and changed here. */

import { DrawLayer } from './layer.js';
import { drawCommands } from './commands.js';
import { drawingHolder, cleanTextDrawing } from '../editor/drawings.js';
import { showContextMenu } from '../menubar.js';
import { makeId } from '../editor/ids.js';
import { showPanel, readFields, escapeHtml } from '../panel.js';

const STYLE_ID = 'grt-sketch-style';
const CSS = `
#sketch-view { position: fixed; inset: 0; z-index: 45; display: flex; flex-direction: column; background: var(--bg-sunken, #ddd); color: var(--text, #111); }
#sketch-view .sketch-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-raised, #fff); border-bottom: 1px solid var(--border, #ccc); }
#sketch-view .sketch-bar .spacer { flex: 1; }
#sketch-view .sketch-area { flex: 1; overflow: auto; display: flex; align-items: flex-start; justify-content: center; padding: 24px; }
#sketch-view .sketch-page { position: relative; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.25); flex: none; }
#sketch-view .sketch-holders { position: absolute; inset: 0; }
#sketch-view .sketch-holders .text-drawing { position: absolute; display: block; transform-origin: center; cursor: move; }
#sketch-view .sketch-holders .text-drawing svg { position: absolute; left: 0; top: 0; }
#sketch-view .drawing-text { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 4px 6px; box-sizing: border-box; overflow: hidden; font-size: 14.67px; line-height: 1.3; color: #000; white-space: pre-wrap; }
#sketch-view .sketch-overlay { position: absolute; inset: 0; pointer-events: none; }
#sketch-view .sketch-overlay.drawing-tool { pointer-events: auto; cursor: crosshair; }
body:has(#sketch-view) .grt-menu { z-index: 47; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/** A drawing as it is kept: its size and its objects, each cleaned as Paper cleans its own. */
export function cleanSketch(value) {
  const w = Math.min(4000, Math.max(100, Number(value?.w) || 800));
  const h = Math.min(4000, Math.max(60, Number(value?.h) || 450));
  const objects = (Array.isArray(value?.objects) ? value.objects : []).slice(0, 2000).map((o) => cleanTextDrawing({ ...o, anchor: { type: 'page', page: 1 }, wrap: 'through' })).filter(Boolean);
  return { w, h, objects };
}

/**
 * Opens the drawing page and resolves to the drawing when Done is pressed, or null when it is left.
 * @param {{w: number, h: number, objects: Object[]}} start
 * @param {{toast?: (text: string) => void}} options
 */
export function editDrawing(start, { toast = () => {} } = {}) {
  ensureStyle();
  const drawing = cleanSketch(start);
  let objects = structuredClone(drawing.objects);
  const past = [];
  const future = [];

  const view = document.createElement('div');
  view.id = 'sketch-view';
  view.setAttribute('role', 'dialog');
  view.setAttribute('aria-label', 'Drawing');
  view.innerHTML = `<div class="sketch-bar"><div class="sketch-menus"></div><span class="spacer"></span>
    <button type="button" data-sketch="size">Page size…</button>
    <button type="button" data-sketch="cancel">Cancel</button>
    <button type="button" class="primary" data-sketch="done">Done</button></div>
    <div class="sketch-area"><div class="sketch-page"><div class="sketch-holders"></div><div class="sketch-overlay draw-overlay"></div></div></div>`;
  document.body.append(view);
  const page = view.querySelector('.sketch-page');
  const holders = view.querySelector('.sketch-holders');
  const overlay = view.querySelector('.sketch-overlay');
  const size = () => Object.assign(page.style, { width: `${drawing.w}px`, height: `${drawing.h}px` });
  size();

  const host = {
    objects: () => objects,
    toPage: (cx, cy) => { const r = page.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; },
    snapshot: () => structuredClone(objects),
    commit: (before) => { past.push(before); future.length = 0; if (past.length > 200) past.shift(); redraw(); },
    redraw: () => redraw(),
    selectionChanged: () => {},
    page: () => ({ w: drawing.w, h: drawing.h }),
    makeId: () => makeId('d'),
    add: (o) => { const fresh = { anchor: { type: 'page', page: 1 }, wrap: 'through', ...o }; objects.push(fresh); return fresh; },
    remove: (ids) => { const doomed = new Set(ids); objects = objects.filter((o) => !doomed.has(o.id)); },
    claims: (event, hit) => hit.kind === 'handle' || Boolean(event.target?.closest?.('.text-drawing')),
    create: (tool, box) => (tool.kind === 'text' ? {
      id: makeId('d'), kind: 'shape', shape: 'rectangle', x: box.x, y: box.y, w: Math.max(box.w, 120), h: Math.max(box.h, 40), rotation: 0,
      fillLook: { type: 'none' }, line: { style: 'none' }, text: '', name: 'Text Box', anchor: { type: 'page', page: 1 }, wrap: 'through',
    } : null),
    doubleClick: (hit) => { if (hit.kind === 'object') editText(hit.id); },
    announce: (text) => toast(text),
  };
  const layer = new DrawLayer(page, host);

  function redraw() {
    holders.replaceChildren(...[...objects].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((o) => {
      const holder = drawingHolder(o, { objects });
      Object.assign(holder.style, { left: `${o.x}px`, top: `${o.y}px` });
      return holder;
    }));
    overlay.replaceChildren(...layer.overlay());
    overlay.classList.toggle('drawing-tool', Boolean(layer.tool || layer.pendingPath));
  }

  /** The words in a shape, asked for in the panel. */
  async function editText(id) {
    const o = objects.find((x) => x.id === id);
    if (!o || o.kind !== 'shape') return;
    if (!await showPanel('Text', `<label>Text<textarea data-field="text" rows="4" maxlength="5000">${escapeHtml(o.text ?? '')}</textarea></label>`, 'OK')) return;
    const before = host.snapshot();
    o.text = readFields().text ?? '';
    host.commit(before);
  }

  const commands = drawCommands({ layer, host: { snapshot: host.snapshot, commit: host.commit, redraw, makeId: host.makeId, page: host.page, selectionChanged: () => {} }, toast });
  const step = (from, to) => { if (!from.length) return; to.push(structuredClone(objects)); objects = from.pop(); layer.select([]); redraw(); };
  // Menus opened from buttons, so nothing stays listening once the page is closed.
  const menus = [
    { label: 'Edit', items: [
      { label: 'Undo', run: () => step(past, future) },
      { label: 'Redo', run: () => step(future, past) },
      'separator',
      { label: 'Text…', run: () => { const one = layer.chosen()[0]; if (one) editText(one.id); else toast('Choose a shape first'); } },
      { label: 'Delete', run: () => { const ids = [...layer.selection]; if (!ids.length) return; const before = host.snapshot(); layer.removeObjects(ids); layer.select([]); host.commit(before); } },
    ] },
    { label: 'Insert', items: [
      ...commands.menus.shape().items,
      'separator',
      { label: 'Text Box', run: () => layer.useTool({ kind: 'text' }) },
    ] },
    { label: 'Format', items: [commands.menus.arrange('draw'), commands.menus.alignObjects(), commands.menus.flip('Flip', 'draw'), commands.menus.group()] },
  ];
  /** A menu at a place; an item with items of its own opens them there in turn. */
  const openMenu = (where, items) => showContextMenu(where, items.map((item) => (item === 'separator' || !item.items ? item : { label: `${item.label} ▸`, run: () => setTimeout(() => openMenu(where, item.items), 0) })));
  const bar = view.querySelector('.sketch-menus');
  for (const menu of menus) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = menu.label;
    button.setAttribute('aria-haspopup', 'menu');
    button.addEventListener('click', () => {
      const r = button.getBoundingClientRect();
      openMenu({ clientX: r.left, clientY: r.bottom, preventDefault: () => {}, target: button }, menu.items);
    });
    bar.append(button);
  }
  redraw();

  return new Promise((resolve) => {
    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      layer.useTool(null);
      view.remove();
      resolve(result);
    };
    function onKey(event) {
      if (document.getElementById('overlay')?.classList.contains('hidden') === false) return;
      if (event.target.closest?.('input, textarea, select')) return;
      const control = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (layer.tool || layer.selection.size) { layer.useTool(null); layer.select([]); return; }
        close(null);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && layer.selection.size) {
        event.preventDefault();
        const before = host.snapshot();
        layer.removeObjects([...layer.selection]);
        layer.select([]);
        host.commit(before);
      } else if (control && event.key.toLowerCase() === 'z') { event.preventDefault(); step(event.shiftKey ? future : past, event.shiftKey ? past : future); }
      else if (control && event.key.toLowerCase() === 'y') { event.preventDefault(); step(future, past); }
      // The program behind the page answers none of its keys while the page is open.
      if (control || event.key === 'Delete' || event.key === 'Escape') event.stopPropagation();
    }
    document.addEventListener('keydown', onKey, true);
    view.querySelector('[data-sketch="cancel"]').onclick = () => close(null);
    view.querySelector('[data-sketch="done"]').onclick = () => close(cleanSketch({ w: drawing.w, h: drawing.h, objects }));
    view.querySelector('[data-sketch="size"]').onclick = async () => {
      if (!await showPanel('Page size', `<label>Width (px)<input type="number" data-field="w" min="100" max="4000" value="${drawing.w}"></label>
        <label>Height (px)<input type="number" data-field="h" min="60" max="4000" value="${drawing.h}"></label>`, 'OK')) return;
      const f = readFields();
      Object.assign(drawing, cleanSketch({ w: f.w, h: f.h, objects: [] }), { objects: drawing.objects });
      size();
    };
  });
}
