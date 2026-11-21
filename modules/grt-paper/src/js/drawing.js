/** Drawing objects in Paper, as Writer has them: shapes, text boxes, frames and pictures anchored to the text, the text running round them. */

import { DrawLayer } from './core/draw/layer.js';
import { drawCommands } from './core/draw/commands.js';
import { fillHolder, drawingHolder, cleanTextDrawing, WRAP_LABELS } from './core/editor/drawings.js';
import { showPanel, readFields, escapeHtml } from './core/panel.js';
import { makeId } from './core/editor/ids.js';
import { OBJECT, normaliseRuns } from './core/editor/model.js';
import { naturalSize } from './core/images.js';

const shiftAll = (o, dx, dy) => {
  o.x += dx;
  o.y += dy;
  for (const c of o.children ?? []) shiftAll(c, dx, dy);
  return o;
};
const option = (value, label, chosen) => `<option value="${escapeHtml(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`;
const CM = 96 / 2.54;

/**
 * @param {Object} app surface, sheet, overlay, pageLayer, model(), editor, images() (resource to URL), toast(message), changed() after an edit,
 *   pickPicture() -> resource, pictureBytes(resource) -> {bytes, type}, putPicture(bytes, type) -> resource, savePicture(resource), refresh()
 */
export function paperDrawing(app) {
  const model = () => app.model();
  /** The drawings as the layer works on them: positions from the top left of the text column, not from their anchors. */
  let view = [];
  /** Where each drawing's anchor puts the top left of its box, and where its holder's own frame starts. */
  const origins = new Map();
  const frames = new Map();
  const placedAt = new Map();

  const zoom = () => { const r = app.surface.getBoundingClientRect(); return app.surface.offsetWidth ? r.width / app.surface.offsetWidth : 1; };
  const toPage = (cx, cy) => { const r = app.surface.getBoundingClientRect(); const z = zoom(); return { x: (cx - r.left) / z, y: (cy - r.top) / z }; };
  const rel = (el) => {
    const r = el.getBoundingClientRect();
    const s = app.surface.getBoundingClientRect();
    const z = zoom();
    return { x: (r.left - s.left) / z, y: (r.top - s.top) / z, w: r.width / z, h: r.height / z };
  };
  const column = () => app.surface.clientWidth;

  /** The top of each page's text area, from the page breaks drawn between them. */
  function pageTops() {
    const tops = [0];
    for (const marker of app.surface.querySelectorAll('.page-break')) {
      const r = rel(marker);
      tops.push(r.y + r.h + (parseFloat(getComputedStyle(marker).marginBottom) || 0));
    }
    return tops;
  }

  /** The top paragraphs with the top of each one's area, in order. */
  function paragraphs() {
    const out = [];
    for (const block of model().blocks) {
      const el = app.surface.querySelector(`[data-block="${CSS.escape(block.id)}"], [data-block-container="${CSS.escape(block.id)}"]`);
      if (!el) continue;
      const r = rel(el);
      out.push({ id: block.id, top: r.y - (parseFloat(getComputedStyle(el).marginTop) || 0), bottom: r.y + r.h });
    }
    return out;
  }

  const options = () => ({ objects: model().drawings, image: (o) => app.images().get(o.resource) ?? null });

  /** Drawings anchored to a page sit on a layer of their own over the sheet. */
  function renderPageDrawings() {
    const tops = pageTops();
    const holders = model().drawings.filter((o) => o.anchor.type === 'page').sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((o) => {
      const top = tops[Math.min(o.anchor.page, tops.length) - 1];
      const holder = drawingHolder(o, options());
      Object.assign(holder.style, { left: `${o.x}px`, top: `${top + o.y}px` });
      return holder;
    });
    app.pageLayer.replaceChildren(...holders);
  }

  const holderOf = (id) => app.sheet.querySelector(`.text-drawing[data-id="${CSS.escape(id)}"]`);

  /** Works out where every drawing is after the text has been drawn or the pages cut, and gives the layer its copies. */
  function layout() {
    if (layer.gesture) return;
    renderPageDrawings();
    origins.clear();
    frames.clear();
    placedAt.clear();
    const tops = pageTops();
    view = model().drawings.map((o) => {
      const holder = holderOf(o.id);
      let origin = { x: 0, y: 0 };
      let frame = { x: 0, y: 0 };
      if (o.anchor.type === 'page') {
        origin = { x: 0, y: tops[Math.min(o.anchor.page, tops.length) - 1] };
      } else if (o.anchor.type === 'as-char') {
        const at = holder?.parentElement ? rel(holder.parentElement) : { x: 0, y: 0 };
        origin = { x: at.x - o.x, y: at.y - o.y };
        frame = null;
      } else if (holder?.parentElement) {
        const mark = rel(holder.parentElement);
        frame = { x: mark.x, y: mark.y };
        origin = { x: mark.x, y: mark.y + (parseFloat(holder.style.top) || 0) - o.y };
      }
      origins.set(o.id, origin);
      frames.set(o.id, frame);
      const copy = shiftAll(structuredClone(o), origin.x, origin.y);
      placedAt.set(o.id, { x: copy.x, y: copy.y });
      return copy;
    });
    const ids = new Set(view.map((o) => o.id));
    for (const id of [...layer.selection]) if (!ids.has(id)) layer.selection.delete(id);
    renderOverlay();
  }

  // The handles have a holder of their own, so drawing them again leaves a text being typed into a shape where it is.
  const handles = document.createElement('div');
  handles.className = 'paper-handles';
  app.overlay.append(handles);
  function renderOverlay() {
    handles.replaceChildren(...layer.overlay());
    app.overlay.classList.toggle('drawing-tool', Boolean(layer.tool || layer.pendingPath));
  }

  /** While the pointer moves an object, its holder follows; the text runs round it again once it is let go. */
  function redraw() {
    for (const v of view) {
      let holder = holderOf(v.id);
      const frame = frames.get(v.id);
      if (!holder) {
        holder = drawingHolder(v, options());
        app.pageLayer.append(holder);
        frames.set(v.id, { x: 0, y: 0 });
      }
      if (holder.classList.contains('editing-text')) continue;
      fillHolder(holder, v, options());
      const at = frames.get(v.id);
      if (at && !holder.classList.contains('as-char')) Object.assign(holder.style, { left: `${v.x - at.x}px`, top: `${v.y - at.y}px` });
      void frame;
    }
    renderOverlay();
  }

  /** The layer's copies back into the document, each moved one anchored again where it now lies. */
  function writeBack() {
    const tops = pageTops();
    const paras = paragraphs();
    const old = new Map(model().drawings.map((o) => [o.id, o]));
    const kept = view.map((v) => {
      const before = old.get(v.id);
      let anchor = structuredClone(v.anchor ?? before?.anchor ?? { type: 'char' });
      const placed = placedAt.get(v.id);
      const moved = !placed || Math.abs(placed.x - v.x) > 0.01 || Math.abs(placed.y - v.y) > 0.01;
      let origin = origins.get(v.id) ?? { x: 0, y: 0 };
      if (anchor.type === 'page') {
        if (moved) {
          let page = 1;
          tops.forEach((top, i) => { if (v.y >= top - 1) page = i + 1; });
          anchor = { type: 'page', page };
          origin = { x: 0, y: tops[page - 1] };
        }
      } else if (anchor.type !== 'as-char' && (moved || !anchor.block)) {
        // Moving a drawing anchors it to the paragraph it now starts in, as Writer does.
        let at = paras[0];
        for (const p of paras) if (v.y >= p.top - 0.5) at = p;
        if (at) { anchor = { ...anchor, block: at.id }; origin = { x: 0, y: at.top }; }
      }
      const out = shiftAll(structuredClone(v), -origin.x, -origin.y);
      if (anchor.type === 'as-char') {
        const stays = before?.anchor?.type === 'as-char';
        out.x = stays ? before.x : 0;
        out.y = stays ? before.y : 0;
      }
      out.anchor = anchor;
      return cleanTextDrawing(out);
    }).filter(Boolean);
    const gone = new Set([...old.keys()].filter((id) => !kept.some((o) => o.id === id)));
    model().drawings = kept;
    if (gone.size) dropCharacters(gone);
  }

  /** Takes out of the text the characters of as-character drawings that are no more. */
  function dropCharacters(ids) {
    const strip = (runs) => normaliseRuns((runs ?? []).filter((r) => !(r.object?.type === 'drawing' && ids.has(r.object.id))));
    for (const block of model().blocks) {
      if (block.runs) block.runs = strip(block.runs);
      for (const item of block.items ?? []) item.runs = strip(item.runs);
      for (const row of block.rows ?? []) for (const cell of row.cells) cell.runs = strip(cell.runs);
    }
  }

  /** One undo step for what the layer did, the text drawn again round the result. */
  function commit(before) {
    writeBack();
    record(before);
  }

  function record(before) {
    const { editor } = app;
    editor.undo.past.push({ ...before, selection: editor.selection });
    if (editor.undo.past.length > editor.undo.limit) editor.undo.past.shift();
    editor.undo.future.length = 0;
    model().dirty = true;
    editor.draw();
    app.changed();
  }

  /** A change to the document's drawings made outside the layer, as one undo step. */
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
    selectionChanged: () => { if (layer.selection.size) app.sheet.focus({ preventScroll: true }); app.refresh(); },
    page: () => ({ w: column(), h: app.surface.offsetHeight }),
    makeId: () => makeId('d'),
    add: (o) => {
      const fresh = { wrap: o.kind === 'image' ? 'optimal' : 'through', anchor: { type: 'char' }, ...o };
      view.push(fresh);
      return fresh;
    },
    remove: (ids) => { const doomed = new Set(ids); view = view.filter((o) => !doomed.has(o.id)); },
    claims: (event, hit) => hit.kind === 'handle' || Boolean(event.target?.closest?.('.text-drawing')),
    create: (tool, box) => {
      if (tool.kind !== 'text') return null;
      const o = {
        id: makeId('d'), kind: 'shape', shape: 'rectangle', x: box.x, y: box.y, w: Math.max(box.w, 120), h: Math.max(box.h, 40), rotation: 0,
        fillLook: { type: 'none' }, line: tool.frame ? { color: '#000000', width: 1 } : { style: 'none' }, text: '', wrap: tool.frame ? 'optimal' : 'through',
        anchor: { type: 'char' }, ...(tool.frame ? { frame: true } : {}), name: tool.frame ? 'Frame' : 'Text Box',
      };
      setTimeout(() => editText(o.id), 0);
      return o;
    },
    doubleClick: (hit) => { if (hit.kind === 'object') editText(hit.id); },
    announce: (text) => app.toast(text),
    grid: () => app.grid?.() ?? null,
    helplines: () => app.helplines?.() ?? true,
  };
  const layer = new DrawLayer(app.sheet, host);

  // Presses in the text let go of the drawings chosen; Alt and a press chooses one behind the text.
  app.surface.addEventListener('mousedown', (event) => {
    if (event.target.closest('.text-drawing')) return;
    if (layer.selection.size) layer.select([]);
  });
  app.sheet.addEventListener('mousedown', (event) => {
    if (!event.altKey || event.button !== 0) return;
    const under = document.elementsFromPoint(event.clientX, event.clientY).find((n) => n.closest?.('.text-drawing'));
    const id = under?.closest('.text-drawing')?.dataset.id;
    if (!id || !view.some((o) => o.id === id)) return;
    event.preventDefault();
    event.stopPropagation();
    layer.select([id]);
  }, true);

  /** The keys of the chosen drawings: arrows move them, Delete takes them away, Escape gives the cursor back to the text. */
  document.addEventListener('keydown', (event) => {
    if (!layer.selection.size && !layer.tool && !layer.pendingPath) return;
    if (event.target.closest?.('input, textarea, select, .panel, .editing') || event.target.isContentEditable) return;
    if (event.key === 'Escape' && layer.selection.size && !layer.scope.length && !layer.tool) {
      layer.select([]);
      app.surface.focus();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && layer.selection.size === 1 && !layer.pendingPath) {
      event.preventDefault();
      editText([...layer.selection][0]);
      return;
    }
    if (layer.key(event)) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  /** Typing into a shape or a text box: a box over it, its text saved when the box is left. */
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
    app.overlay.append(box);
    box.focus();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      box.remove();
      holder?.classList.remove('editing-text');
      // The pages may have been laid out again while typing: the layer's copy of the object is looked up afresh.
      const live = view.find((x) => x.id === id);
      if (keep && live && box.value !== (live.text ?? '')) {
        const before = model().snapshot();
        live.text = box.value;
        commit(before);
      } else if (!o.text && !box.value && o.name === 'Text Box' && !o.frame) {
        // A text box drawn and left empty is not kept, as in Writer.
        change(() => { model().drawings = model().drawings.filter((d) => d.id !== id); });
      }
    };
    box.addEventListener('blur', () => finish(true));
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(true); app.sheet.focus(); }
      event.stopPropagation();
    });
  }

  // The commands of drawing objects, with Writer's names.

  const pictures = {
    bytes: (o) => app.pictureBytes(o.resource),
    put: async (bytes, type) => app.putPicture(bytes, type),
    href: (o) => app.images().get(o.resource),
    natural: (o) => { const d = app.pictureBytes(o.resource); return d ? naturalSize(d.bytes) : null; },
    pick: async () => { const resource = await app.pickPicture(); return resource ? app.pictureBytes(resource) : null; },
    save: (o) => app.savePicture(o.resource),
    label: (o) => o.name ?? 'Image',
  };
  const commands = drawCommands({
    layer,
    host: { snapshot: host.snapshot, commit, redraw, makeId: host.makeId, page: host.page, selectionChanged: host.selectionChanged },
    toast: app.toast,
    unit: { per: CM, label: 'cm', inch: 96 },
    images: pictures,
    shapeText: (o) => o.text ?? '',
    setShapeText: (o, text) => { o.text = text; },
  });

  const chosenIds = () => [...layer.selection];

  /** Format › Align Text › Top, Center or Bottom: where the text sits up and down in the chosen shapes and text boxes. */
  function textAnchor(valign) {
    const ids = new Set(chosenIds());
    if (!ids.size) return false;
    change(() => {
      for (const o of model().drawings) if (ids.has(o.id)) o.textLook = { ...(o.textLook ?? {}), valign };
    });
    return true;
  }
  const needChosen = () => {
    if (layer.selection.size) return true;
    // A picture standing in the text as a paragraph of its own becomes a drawing that can float.
    const id = app.editor.selection?.anchor?.blockId;
    if (model().block(id)?.kind === 'image' && floatImageBlock(id)) return true;
    app.toast('Choose a drawing, a picture or a text box first');
    return false;
  };

  /** Anchor: the chosen drawings anchored again, staying where they are on the page. */
  function anchorTo(type) {
    if (!needChosen()) return;
    const before = model().snapshot();
    const caret = app.editor.selection?.anchor;
    for (const v of view.filter((o) => layer.selection.has(o.id))) {
      const was = v.anchor?.type;
      if (was === type) continue;
      if (type === 'as-char') {
        // As Character puts the drawing in the line where the cursor is, or at the start of its paragraph.
        const block = caret?.blockId ?? v.anchor?.block ?? model().blocks[0].id;
        insertCharacter(v.id, block, caret?.blockId === block ? caret.offset : 0, caret?.blockId === block ? caret.itemIndex : null);
        v.anchor = { type: 'as-char', block };
        v.x = 0; v.y = 0;
        placedAt.delete(v.id);
        continue;
      }
      if (was === 'as-char') dropCharacters(new Set([v.id]));
      v.anchor = type === 'page' ? { type: 'page', page: 1 } : { type, block: v.anchor?.block ?? null };
      // Anchored again, the drawing is placed afresh from where it is now.
      placedAt.delete(v.id);
    }
    writeBack();
    record(before);
  }

  /** The drawing's character put in a paragraph's text. */
  function insertCharacter(id, blockId, offset, itemIndex) {
    const runs = model().runsOf(blockId, itemIndex) ?? [];
    const out = [];
    let seen = 0;
    let done = false;
    for (const run of runs) {
      const length = run.text.length;
      if (!done && seen + length >= offset && !run.object) {
        const cut = offset - seen;
        if (cut > 0) out.push({ ...run, text: run.text.slice(0, cut) });
        out.push({ text: OBJECT, object: { type: 'drawing', id } });
        if (cut < length) out.push({ ...run, text: run.text.slice(cut) });
        done = true;
      } else out.push(run);
      seen += length;
    }
    if (!done) out.push({ text: OBJECT, object: { type: 'drawing', id } });
    model().setRuns(blockId, normaliseRuns(out), itemIndex);
  }

  function wrapAs(wrap) {
    if (!needChosen()) return;
    const before = model().snapshot();
    for (const v of view.filter((o) => layer.selection.has(o.id))) v.wrap = wrap;
    commit(before);
  }
  const wrapOn = (wrap) => view.some((o) => layer.selection.has(o.id) && o.wrap === wrap);
  const anchorOn = (type) => view.some((o) => layer.selection.has(o.id) && o.anchor?.type === type);

  function firstParagraph() {
    if (!needChosen()) return;
    const before = model().snapshot();
    const on = !view.filter((o) => layer.selection.has(o.id)).every((o) => o.wrapFirst);
    for (const v of view.filter((o) => layer.selection.has(o.id))) { if (on) v.wrapFirst = true; else delete v.wrapFirst; }
    commit(before);
  }

  /** Wrap, Edit: the wrap, its spacing and First Paragraph in one dialog, as Writer's Wrap tab. */
  async function wrapDialog() {
    if (!needChosen()) return;
    const o = view.find((x) => layer.selection.has(x.id));
    const html = `<div class="form-grid">
      <label class="field"><span>Settings</span><select data-field="wrap">${Object.entries(WRAP_LABELS).map(([v, l]) => option(v, l.replace(/^Wrap /, ''), o.wrap)).join('')}</select></label>
      <label class="field"><span>Spacing (cm)</span><input type="number" data-field="gap" min="0" max="5" step="0.05" value="${((o.gap ?? 0) / CM).toFixed(2)}"></label>
      <label class="check"><input type="checkbox" data-field="first"${o.wrapFirst ? ' checked' : ''}> First paragraph</label></div>`;
    if (!(await showPanel('Wrap', html, 'OK'))) return;
    const f = readFields();
    const before = model().snapshot();
    for (const v of view.filter((x) => layer.selection.has(x.id))) {
      v.wrap = f.wrap;
      v.gap = Math.max(0, Math.min(5, Number(f.gap) || 0)) * CM;
      if (f.first) v.wrapFirst = true; else delete v.wrapFirst;
    }
    commit(before);
  }

  /** Position and Size of Writer: the anchor and where the drawing stands from it, besides its size. */
  async function anchorDialog() {
    if (!needChosen()) return;
    const o = view.find((x) => layer.selection.has(x.id));
    const stored = model().drawings.find((d) => d.id === o.id);
    const html = `<div class="form-grid">
      <label class="field"><span>Anchor</span><select data-field="anchor">${[['page', 'To page'], ['paragraph', 'To paragraph'], ['char', 'To character'], ['as-char', 'As character']].map(([v, l]) => option(v, l, o.anchor?.type)).join('')}</select></label>
      ${o.anchor?.type === 'page' ? `<label class="field"><span>Page</span><input type="number" data-field="page" min="1" max="10000" value="${o.anchor.page ?? 1}"></label>` : ''}
      <label class="field"><span>Horizontal (cm)</span><input type="number" data-field="x" step="0.05" value="${((stored?.x ?? 0) / CM).toFixed(2)}"></label>
      <label class="field"><span>Vertical (cm)</span><input type="number" data-field="y" step="0.05" value="${((stored?.y ?? 0) / CM).toFixed(2)}"></label>
      <label class="field"><span>Width (cm)</span><input type="number" data-field="w" min="0.05" step="0.05" value="${(o.w / CM).toFixed(2)}"></label>
      <label class="field"><span>Height (cm)</span><input type="number" data-field="h" min="0.05" step="0.05" value="${(o.h / CM).toFixed(2)}"></label>
      <label class="check"><input type="checkbox" data-field="position"${o.protect?.position ? ' checked' : ''}> Protect position</label>
      <label class="check"><input type="checkbox" data-field="size"${o.protect?.size ? ' checked' : ''}> Protect size</label></div>
      <p class="hint">Horizontal is from the left of the text area; vertical from the top of the paragraph, or of the page's text area.</p>`;
    if (!(await showPanel('Position and Size', html, 'OK'))) return;
    const f = readFields();
    const type = f.anchor;
    if (type !== o.anchor?.type) { anchorTo(type); return; }
    change(() => {
      const d = model().drawings.find((x) => x.id === o.id);
      if (!d) return false;
      if (d.anchor.type !== 'as-char') { d.x = (Number(f.x) || 0) * CM; d.y = (Number(f.y) || 0) * CM; }
      if (d.anchor.type === 'page' && f.page) d.anchor.page = Math.max(1, Math.round(Number(f.page)));
      d.w = Math.max(0.05, Number(f.w) || 1) * CM;
      d.h = Math.max(0.05, Number(f.h) || 1) * CM;
      d.protect = { position: Boolean(f.position), size: Boolean(f.size) };
      return true;
    });
  }

  /** To Foreground and To Background: a drawing over the text, or under it. */
  const toBackground = (on) => {
    if (!needChosen()) return;
    const before = model().snapshot();
    for (const v of view.filter((o) => layer.selection.has(o.id))) v.wrap = on ? 'background' : 'through';
    commit(before);
  };

  /** A new drawing placed where the cursor's paragraph starts, chosen. */
  function place(o) {
    const block = app.editor.selection?.anchor?.blockId ?? model().blocks[0].id;
    change(() => {
      model().drawings.push(cleanTextDrawing({ wrap: o.kind === 'image' ? 'optimal' : 'through', ...o, anchor: { type: 'char', block } }));
      return true;
    });
    layer.select([o.id]);
  }

  const insert = {
    textBox: () => layer.useTool({ kind: 'text' }),
    frame: () => {
      // Writer's Insert, Frame without a drag: a frame across the text column under the cursor's paragraph.
      const id = makeId('d');
      place({ id, kind: 'shape', shape: 'rectangle', x: 0, y: 0, w: Math.min(column(), 8 * CM), h: 2 * CM, frame: true, name: 'Frame', text: '', fillLook: { type: 'none' }, line: { color: '#000000', width: 1 }, wrap: 'optimal' });
      setTimeout(() => editText(id), 0);
    },
    floatingImage: async () => {
      const resource = await app.pickPicture();
      if (!resource) return;
      const d = app.pictureBytes(resource);
      const size = (d && naturalSize(d.bytes)) ?? { w: 320, h: 240 };
      const scale = Math.min(1, (column() * 0.6) / Math.max(size.w, 1), 400 / Math.max(size.h, 1));
      place({ id: makeId('d'), kind: 'image', resource, x: 0, y: 0, w: size.w * scale, h: size.h * scale, wrap: 'optimal', name: 'Image' });
    },
    /** Signature Line: a line to sign on by hand, with who signs under it; a picture, not a digital signature. */
    signatureLine: async () => {
      const html = `<div class="form-grid"><label class="field"><span>Name</span><input type="text" data-field="name" maxlength="100"></label>
        <label class="field"><span>Title</span><input type="text" data-field="title" maxlength="100"></label>
        <label class="field"><span>Email</span><input type="text" data-field="email" maxlength="100"></label></div>
        <p class="hint">A line to sign on by hand, with these under it. It is a picture: signing digitally is another matter.</p>`;
      if (!(await showPanel('Signature Line', html, 'OK'))) return;
      const f = readFields();
      const esc = (s) => escapeHtml(String(s ?? '').slice(0, 100));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="110" viewBox="0 0 300 110"><text x="8" y="58" font-family="sans-serif" font-size="28" fill="#555">X</text><line x1="8" y1="64" x2="292" y2="64" stroke="#333" stroke-width="1.5"/><text x="8" y="82" font-family="sans-serif" font-size="13" fill="#222">${esc(f.name)}</text><text x="8" y="97" font-family="sans-serif" font-size="11" fill="#555">${esc(f.title)}</text><text x="8" y="108" font-family="sans-serif" font-size="10" fill="#777">${esc(f.email)}</text></svg>`;
      const resource = await app.putPicture(new TextEncoder().encode(svg), 'image/svg+xml');
      place({ id: makeId('d'), kind: 'image', resource, x: 0, y: 0, w: 300, h: 110, wrap: 'none', name: 'Signature Line' });
    },
  };

  /** An image block made a drawing anchored to the paragraph after it, so it can float and the text run round it. */
  function floatImageBlock(blockId) {
    const block = model().block(blockId);
    if (block?.kind !== 'image' || !block.resource) return false;
    const index = model().indexOf(blockId);
    const next = model().blocks[index + 1] ?? model().blocks[index - 1];
    if (!next) return false;
    const id = makeId('d');
    change(() => {
      model().drawings.push(cleanTextDrawing({ id, kind: 'image', resource: block.resource, x: 0, y: 0, w: block.w, h: block.h, wrap: 'optimal', name: 'Image', anchor: { type: 'char', block: next.id } }));
      model().removeBlock(blockId);
      return true;
    });
    layer.select([id]);
    return true;
  }

  /** The menu items of Writer for drawings: Format, Anchor, Wrap and Arrange, and Insert's shapes. */
  const menus = {
    anchor: () => ({ label: 'Anchor', items: [
      { label: 'To Page', run: () => anchorTo('page'), checked: () => anchorOn('page'), aliases: ['Anchor to page'] },
      { label: 'To Paragraph', run: () => anchorTo('paragraph'), checked: () => anchorOn('paragraph'), aliases: ['Anchor to paragraph'] },
      { label: 'To Character', run: () => anchorTo('char'), checked: () => anchorOn('char'), aliases: ['Anchor to character'] },
      { label: 'As Character', run: () => anchorTo('as-char'), checked: () => anchorOn('as-char'), aliases: ['Anchor as character', 'In line with text'] },
    ] }),
    wrap: () => ({ label: 'Wrap', items: [
      { label: 'Wrap Off', run: () => wrapAs('none'), checked: () => wrapOn('none'), aliases: ['None', 'Top and bottom'] },
      { label: 'Page Wrap', run: () => wrapAs('parallel'), checked: () => wrapOn('parallel'), aliases: ['Parallel', 'Square'] },
      { label: 'Optimal Page Wrap', run: () => wrapAs('optimal'), checked: () => wrapOn('optimal'), aliases: ['Optimal'] },
      { label: 'Wrap Left', run: () => wrapAs('before'), checked: () => wrapOn('before'), aliases: ['Before'] },
      { label: 'Wrap Right', run: () => wrapAs('after'), checked: () => wrapOn('after'), aliases: ['After'] },
      { label: 'Wrap Through', run: () => wrapAs('through'), checked: () => wrapOn('through'), aliases: ['Through', 'In front of text'] },
      { label: 'In Background', run: () => wrapAs('background'), checked: () => wrapOn('background'), aliases: ['Behind text'] },
      'separator',
      { label: 'Contour', run: () => wrapAs('contour'), checked: () => wrapOn('contour'), aliases: ['Tight'] },
      { label: 'Edit Contour…', run: () => { if (needChosen()) { wrapAs('contour'); app.toast('The text follows the drawing\'s outline, turned as it is'); } } },
      { label: 'First Paragraph', run: firstParagraph, checked: () => view.some((o) => layer.selection.has(o.id) && o.wrapFirst) },
      'separator',
      { label: 'Edit…', run: wrapDialog, aliases: ['Wrap settings', 'Text wrap'] },
    ] }),
    arrange: () => {
      const base = commands.menus.arrange('writer');
      const items = base.items.map((item) => (typeof item === 'object' ? { ...item, enabled: () => layer.selection.size > 0 } : item));
      return { ...base, items: [...items, 'separator',
        { label: 'To Foreground', run: () => toBackground(false), aliases: ['In front of text'] },
        { label: 'To Background', run: () => toBackground(true), aliases: ['Behind text'] }] };
    },
  };

  return { layer, commands, insert, menus, layout, redraw: renderOverlay, anchorDialog, wrapDialog, floatImageBlock, editText, chosen: chosenIds, view: () => view, textAnchor };
}
