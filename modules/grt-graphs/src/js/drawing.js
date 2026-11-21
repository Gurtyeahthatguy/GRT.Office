/** Graphs as LibreOffice Draw: pages, drawing objects beside the nodes, and the Format and Shape commands of Draw. */

import { DrawLayer, hitTarget } from './core/draw/layer.js';
import { drawCommands } from './core/draw/commands.js';
import { changeCase, stepSize } from './core/text-case.js';
import { showPanel, showChoice, readFields, escapeHtml } from './core/panel.js';
import { tabs, wireTabs } from './core/draw/dialogs.js';
import { chartDialog } from './core/chart-dialog.js';
import { formulaDialog } from './core/formula-dialog.js';
import { naturalSize } from './core/images.js';
import { stripMetadata } from './core/image-metadata.js';
import { toBase64, fromBase64 } from './core/formats/odf.js';
import { normaliseChartData } from './core/formats/chart-object.js';
import { TEXT_MARKS, cleanTextLook } from './model.js';
import { makeId } from './ids.js';

/** Colour themes, as Format, Theme offers them: each gives the three node styles their fill and outline. */
export const THEMES = {
  LibreOffice: { default: ['#ffffff', '#333333'], accent: ['#e8f0fe', '#1f6feb'], warn: ['#fff4e5', '#b26a00'] },
  Rainbow: { default: ['#fff5f5', '#c9211e'], accent: ['#f0fff0', '#2a6099'], warn: ['#fffbe6', '#ff8000'] },
  Beach: { default: ['#fdf6e3', '#8b6914'], accent: ['#e0f7fa', '#00838f'], warn: ['#fff3e0', '#e65100'] },
  Sunset: { default: ['#fff3e0', '#bf360c'], accent: ['#fce4ec', '#ad1457'], warn: ['#fff8e1', '#ff6f00'] },
  Ocean: { default: ['#e3f2fd', '#0d47a1'], accent: ['#e0f2f1', '#00695c'], warn: ['#ede7f6', '#4527a0'] },
  Forest: { default: ['#f1f8e9', '#33691e'], accent: ['#e8f5e9', '#1b5e20'], warn: ['#fff8e1', '#795548'] },
  Breeze: { default: ['#f5f5f5', '#424242'], accent: ['#e1f5fe', '#0277bd'], warn: ['#fbe9e7', '#d84315'] },
};

const dataUrl = (bytes, type) => `data:${type};base64,${toBase64(bytes)}`;
const fromDataUrl = (url) => {
  const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(String(url ?? ''));
  return m ? { bytes: fromBase64(m[2]), type: m[1] } : null;
};
const option = (value, label, chosen) => `<option value="${escapeHtml(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`;

/**
 * @param {Object} app canvas, renderer, interaction (Graphs' own), model(), change(mutate), draw(), refresh(), toast(message),
 *   snapshot(), commit(before), pickImage() -> {bytes, type, name}|null, saveBytes(bytes, name)
 */
export function graphsDrawing(app) {
  const model = () => app.model();
  const nodesChosen = () => [...app.interaction.selection].map((id) => model().node(id)).filter(Boolean);

  const host = {
    objects: () => model().objects,
    toPage: (x, y) => app.renderer.toDiagram(x, y),
    snapshot: () => app.snapshot(),
    commit: (before) => app.commit(before),
    redraw: () => app.draw(),
    selectionChanged: () => app.refresh(),
    page: () => ({ w: 1600, h: 1200 }),
    makeId: () => makeId('o'),
    add: (o) => model().addObject(o),
    remove: (ids) => model().deleteObjects(ids),
    grid: () => ({ step: model().meta.gridSize ?? 10, snap: Boolean(model().meta.snapToGrid) }),
    snapLines: () => model().page.guides ?? [],
    // The layer takes presses on its own handles and objects, and what a drawing tool draws.
    claims: (event, hit) => hit.kind === 'handle' && Boolean(event.target?.closest?.('#draw-overlay'))
      || Boolean(event.target?.closest?.('[data-object]')),
    create: (tool, box) => {
      if (tool.kind !== 'text') return null;
      // A text box is a node with no fill or outline, typed into at once.
      const node = model().addNode({ ...box, w: Math.max(box.w, 60), h: Math.max(box.h, 30), style: 'text' });
      if (!model().styles.text) model().styles.text = { fill: 'none', stroke: 'none', strokeWidth: 0 };
      app.interaction.selection = new Set([node.id]);
      setTimeout(() => app.editText(node.id), 0);
      return null;
    },
  };
  const layer = new DrawLayer(app.canvas, host);

  const images = {
    bytes: (o) => fromDataUrl(o.resource),
    put: async (bytes, type) => dataUrl(bytes, type),
    href: (o) => o.resource,
    natural: (o) => { const d = fromDataUrl(o.resource); return d ? naturalSize(d.bytes) : null; },
    pick: () => app.pickImage(),
    save: async (o) => { const d = fromDataUrl(o.resource); if (d) await app.saveBytes(d.bytes, `picture.${d.type.split('/')[1] ?? 'png'}`); },
    label: (o) => o.name ?? 'Picture',
  };
  const commands = drawCommands({
    layer,
    host: { snapshot: host.snapshot, commit: host.commit, redraw: host.redraw, makeId: host.makeId, page: host.page, selectionChanged: host.selectionChanged },
    toast: app.toast,
    unit: { per: 1, label: 'px', inch: 96 },
    images,
    guides: { add: (g) => { model().page.guides = [...(model().page.guides ?? []), g].slice(0, 100); } },
    // Shape and place commands act on the chosen nodes as on drawings.
    alsoChosen: nodesChosen,
  });

  // Text of nodes: Format, Text and Spacing over the whole of each chosen node's text, as Draw does with a shape chosen.

  const onNodes = (mutate) => {
    const nodes = nodesChosen();
    if (!nodes.length) { app.toast('Choose a shape with text first'); return; }
    app.change(() => { for (const node of nodes) { const look = { ...(node.textLook ?? {}) }; mutate(look, node); const clean = cleanTextLook(look); if (clean) node.textLook = clean; else delete node.textLook; } });
  };
  const markOn = (mark) => nodesChosen().length > 0 && nodesChosen().every((n) => n.textLook?.[mark]);
  const text = {
    mark: (mark) => onNodes((look) => {
      const on = !nodesChosen().every((n) => n.textLook?.[mark]);
      look[mark] = on;
      const partner = { sup: 'sub', sub: 'sup', underline: 'double', double: 'underline' }[mark];
      if (on && partner) delete look[partner];
    }),
    markOn,
    resize: (direction) => onNodes((look) => { look.size = stepSize(look.size ?? 13, direction); }),
    textCase: (mode) => { const nodes = nodesChosen(); if (!nodes.length) { app.toast('Choose a shape with text first'); return; } app.change(() => { for (const n of nodes) n.text = changeCase(n.text, mode); }); },
    lineSpacing: (v) => onNodes((look) => { look.lineSpacing = v; }),
    paragraphSpacing: (step) => onNodes((look) => { look.paraSpacing = Math.max(0, (look.paraSpacing ?? 0) + step * 4); }),
    indent: (step) => onNodes((look) => { look.indent = Math.max(0, (look.indent ?? 0) + step * 12); }),
    align: (a) => onNodes((look) => { look.align = a; }),
    valign: (v) => onNodes((look) => { look.valign = v; }),
    list: (kind) => onNodes((look) => { look.list = look.list === kind ? undefined : kind; }),
    listOn: (kind) => nodesChosen().length > 0 && nodesChosen().every((n) => n.textLook?.list === kind),
    moveLine: (by) => {
      // Move Up and Move Down take the node's last line, the one being written, up or down among the others.
      const nodes = nodesChosen();
      if (nodes.length !== 1) { app.toast('Choose one shape first'); return; }
      app.change(() => {
        const lines = nodes[0].text.split('\n');
        const from = by < 0 ? lines.length - 1 : 0;
        const to = Math.max(0, Math.min(lines.length - 1, from + by));
        const [line] = lines.splice(from, 1);
        lines.splice(to, 0, line);
        nodes[0].text = lines.join('\n');
      });
    },
    clear: () => onNodes((look) => { for (const key of Object.keys(look)) delete look[key]; }),
    character: async () => {
      const node = nodesChosen()[0];
      if (!node) { app.toast('Choose a shape with text first'); return; }
      const look = node.textLook ?? {};
      const html = tabs([
        { label: 'Font', html: `<div class="form-grid"><label class="field"><span>Family</span><input type="text" data-field="font" value="${escapeHtml(look.font ?? '')}" placeholder="Liberation Sans"></label>
          <label class="field"><span>Size</span><input type="number" data-field="size" min="4" max="400" value="${look.size ?? 13}"></label>
          <label class="check"><input type="checkbox" data-field="bold"${look.bold ? ' checked' : ''}> Bold</label><label class="check"><input type="checkbox" data-field="italic"${look.italic ? ' checked' : ''}> Italic</label></div>` },
        { label: 'Font Effects', html: `<div class="form-grid"><label class="field"><span>Font color</span><input type="color" data-field="color" value="${look.color ?? '#222222'}"></label>
          ${['underline', 'double', 'strike', 'overline', 'shadow', 'outline', 'smallcaps'].map((m) => `<label class="check"><input type="checkbox" data-field="${m}"${look[m] ? ' checked' : ''}> ${{ underline: 'Underline', double: 'Double underline', strike: 'Strikethrough', overline: 'Overline', shadow: 'Shadow', outline: 'Outline', smallcaps: 'Small capitals' }[m]}</label>`).join('')}</div>` },
        { label: 'Position', html: `<label class="field"><span>Position</span><select data-field="position">${option('normal', 'Normal', look.sup ? 'sup' : look.sub ? 'sub' : 'normal')}${option('sup', 'Superscript', look.sup ? 'sup' : '')}${option('sub', 'Subscript', look.sub ? 'sub' : '')}</select></label>` },
      ]);
      const shown = showPanel('Character', html, 'OK');
      wireTabs();
      if (!(await shown)) return;
      const f = readFields();
      onNodes((l) => {
        for (const m of [...TEXT_MARKS]) l[m] = Boolean(f[m]);
        l.sup = f.position === 'sup';
        l.sub = f.position === 'sub';
        l.size = Number(f.size) || 13;
        l.color = f.color;
        if (f.font.trim()) l.font = f.font.trim(); else delete l.font;
      });
    },
    paragraph: async () => {
      const node = nodesChosen()[0];
      if (!node) { app.toast('Choose a shape with text first'); return; }
      const look = node.textLook ?? {};
      const html = tabs([
        { label: 'Indents & Spacing', html: `<div class="form-grid"><label class="field"><span>Before text</span><input type="number" data-field="indent" min="0" max="500" value="${look.indent ?? 0}"></label>
          <label class="field"><span>Below paragraph</span><input type="number" data-field="paraSpacing" min="0" max="200" value="${look.paraSpacing ?? 0}"></label>
          <label class="field"><span>Line spacing</span><input type="number" data-field="lineSpacing" min="0.5" max="5" step="0.05" value="${look.lineSpacing ?? 1}"></label></div>` },
        { label: 'Alignment', html: `<label class="field"><span>Text</span><select data-field="align">${[['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justified']].map(([v, l]) => option(v, l, look.align ?? 'center')).join('')}</select></label>
          <label class="field"><span>In the shape</span><select data-field="valign">${[['top', 'Top'], ['middle', 'Center'], ['bottom', 'Bottom']].map(([v, l]) => option(v, l, look.valign ?? 'middle')).join('')}</select></label>` },
      ]);
      const shown = showPanel('Paragraph', html, 'OK');
      wireTabs();
      if (!(await shown)) return;
      const f = readFields();
      onNodes((l) => { l.indent = Number(f.indent) || 0; l.paraSpacing = Number(f.paraSpacing) || 0; l.lineSpacing = Number(f.lineSpacing) || 1; l.align = f.align; l.valign = f.valign; });
    },
    bullets: async () => {
      const node = nodesChosen()[0];
      if (!node) { app.toast('Choose a shape with text first'); return; }
      const choice = await showChoice('Bullets and Numbering', '<p>Each line of the shape\'s text is an item.</p>', [
        { id: 'none', label: 'None' }, { id: 'bullet', label: 'Bullets', primary: node.textLook?.list !== 'number' }, { id: 'number', label: 'Numbers' },
      ]);
      if (choice) onNodes((l) => { l.list = choice === 'none' ? undefined : choice; });
    },
  };

  // Styles and themes

  const styles = {
    edit: async (name = nodesChosen()[0]?.style ?? 'default') => {
      const style = model().styles[name];
      if (!style) { app.toast('Choose a shape first'); return; }
      const html = `<p class="hint">Every shape of the style “${escapeHtml(name)}” changes with it.</p><div class="form-grid">
        <label class="check"><input type="checkbox" data-field="noFill"${style.fill === 'none' ? ' checked' : ''}> No fill</label>
        <label class="field"><span>Fill</span><input type="color" data-field="fill" value="${style.fill === 'none' ? '#ffffff' : style.fill}"></label>
        <label class="check"><input type="checkbox" data-field="noStroke"${style.stroke === 'none' ? ' checked' : ''}> No line</label>
        <label class="field"><span>Line</span><input type="color" data-field="stroke" value="${style.stroke === 'none' ? '#333333' : style.stroke}"></label>
        <label class="field"><span>Line width</span><input type="number" data-field="width" min="0" max="40" value="${style.strokeWidth ?? 2}"></label></div>`;
      if (!(await showPanel(`Edit Style: ${escapeHtml(name)}`, html, 'OK'))) return;
      const f = readFields();
      app.change(() => { model().styles[name] = { fill: f.noFill ? 'none' : f.fill, stroke: f.noStroke ? 'none' : f.stroke, strokeWidth: Math.max(0, Number(f.width) || 0) }; });
    },
    /** Update Selected Style: the chosen shape's own fill and line become its style's. */
    update: () => {
      const node = nodesChosen()[0];
      if (!node) { app.toast('Choose a shape first'); return; }
      app.change(() => {
        const style = model().styles[node.style] ?? {};
        model().styles[node.style] = {
          fill: node.fillLook ? (node.fillLook.type === 'none' ? 'none' : node.fillLook.color) : style.fill,
          stroke: node.line ? (node.line.style === 'none' ? 'none' : node.line.color) : style.stroke,
          strokeWidth: node.line?.width ?? style.strokeWidth ?? 2,
        };
        for (const n of model().nodes) if (n.style === node.style) { delete n.fillLook; delete n.line; }
      });
    },
    /** New Style from Selection: a style made of the chosen shape's look, given to it. */
    fromSelection: async () => {
      const node = nodesChosen()[0];
      if (!node) { app.toast('Choose a shape first'); return; }
      if (!(await showPanel('New Style from Selection', '<label class="field"><span>Style name</span><input type="text" data-field="name" maxlength="60" value=""></label>', 'OK'))) return;
      const name = readFields().name.trim().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60);
      if (!name) return;
      if (model().styles[name]) { app.toast(`There is a style called ${name} already`); return; }
      app.change(() => {
        const base = model().styles[node.style] ?? {};
        model().styles[name] = {
          fill: node.fillLook ? (node.fillLook.type === 'none' ? 'none' : node.fillLook.color) : base.fill ?? '#ffffff',
          stroke: node.line ? (node.line.style === 'none' ? 'none' : node.line.color) : base.stroke ?? '#333333',
          strokeWidth: node.line?.width ?? base.strokeWidth ?? 2,
        };
        node.style = name;
        delete node.fillLook;
        delete node.line;
      });
    },
    manage: async () => {
      const names = Object.keys(model().styles);
      const used = (n) => model().pages.reduce((c, p) => c + p.nodes.filter((x) => x.style === n).length, 0);
      const choice = await showChoice('Manage Styles', `<label class="field"><span>Style</span><select data-field="style">${names.map((n) => option(n, `${n} (${used(n)} shapes)`, nodesChosen()[0]?.style ?? 'default')).join('')}</select></label>
        <label class="field"><span>New name</span><input type="text" data-field="name" maxlength="60"></label>`, [
        { id: 'delete', label: 'Delete' }, { id: 'rename', label: 'Rename' }, { id: 'apply', label: 'Apply to the chosen' }, { id: 'edit', label: 'Edit…', primary: true }, { id: 'close', label: 'Close' },
      ]);
      const f = readFields();
      if (choice === 'edit') await styles.edit(f.style);
      if (choice === 'apply') app.change(() => { for (const n of nodesChosen()) n.style = f.style; });
      if (choice === 'rename') {
        const name = String(f.name ?? '').trim().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60);
        if (!name || model().styles[name] || ['default'].includes(f.style)) { app.toast('Choose a new name; the default style keeps its own'); return; }
        app.change(() => { model().styles[name] = model().styles[f.style]; delete model().styles[f.style]; for (const p of model().pages) for (const n of p.nodes) if (n.style === f.style) n.style = name; });
      }
      if (choice === 'delete') {
        if (f.style === 'default') { app.toast('The default style stays'); return; }
        app.change(() => { delete model().styles[f.style]; for (const p of model().pages) for (const n of p.nodes) if (n.style === f.style) n.style = 'default'; });
      }
    },
    theme: async () => {
      const choice = await showChoice('Theme', `<div class="theme-swatches">${Object.entries(THEMES).map(([name, t]) => `<div><strong>${escapeHtml(name)}</strong> ${Object.values(t).map(([f, s]) => `<span style="display:inline-block;width:18px;height:14px;background:${f};border:2px solid ${s};vertical-align:middle"></span>`).join(' ')}</div>`).join('')}</div>`,
        [...Object.keys(THEMES).map((name) => ({ id: name, label: name })), { id: 'close', label: 'Close' }]);
      if (!THEMES[choice]) return;
      app.change(() => { for (const [style, [fill, stroke]] of Object.entries(THEMES[choice])) model().styles[style] = { ...(model().styles[style] ?? {}), fill, stroke, strokeWidth: model().styles[style]?.strokeWidth ?? 2 }; });
    },
  };

  // Inserting what Draw's Insert menu has

  const centre = () => {
    const box = app.canvas.getBoundingClientRect();
    return app.renderer.toDiagram(box.left + box.width / 2, box.top + box.height / 2);
  };
  const place = (o) => {
    app.change(() => {
      const created = model().addObject(o);
      layer.selection = new Set([created.id]);
    });
  };
  const insert = {
    image: async () => {
      const picked = await app.pickImage();
      if (!picked) return;
      const bytes = stripMetadata(picked.bytes);
      const size = naturalSize(bytes) ?? { w: 320, h: 240 };
      const scale = Math.min(1, 480 / Math.max(size.w, size.h));
      const c = centre();
      place({ kind: 'image', resource: dataUrl(bytes, picked.type), x: c.x - (size.w * scale) / 2, y: c.y - (size.h * scale) / 2, w: size.w * scale, h: size.h * scale });
    },
    chart: async () => {
      const chart = await chartDialog();
      if (!chart) return;
      const c = centre();
      place({ kind: 'chart', ...chart, data: normaliseChartData(chart.data), x: c.x - 200, y: c.y - 130, w: 400, h: 260 });
    },
    formula: async () => {
      const formula = await formulaDialog({ display: true });
      if (!formula) return;
      const c = centre();
      place({ kind: 'formula', tex: formula.tex, ...(formula.mathml ? { mathml: formula.mathml } : {}), x: c.x - 150, y: c.y - 40, w: 300, h: 80 });
    },
    textBox: () => layer.useTool({ kind: 'text' }),
    /** Signature Line: a line to sign on, with who signs under it; a picture, not a digital signature. */
    signatureLine: async () => {
      const html = `<div class="form-grid"><label class="field"><span>Name</span><input type="text" data-field="name" maxlength="100"></label>
        <label class="field"><span>Title</span><input type="text" data-field="title" maxlength="100"></label>
        <label class="field"><span>Email</span><input type="text" data-field="email" maxlength="100"></label></div>
        <p class="hint">A line to sign on by hand, with these under it. It is a picture: signing digitally is another matter.</p>`;
      if (!(await showPanel('Signature Line', html, 'OK'))) return;
      const f = readFields();
      const esc = (s) => escapeHtml(String(s ?? '').slice(0, 100));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="110" viewBox="0 0 300 110"><text x="8" y="58" font-family="sans-serif" font-size="28" fill="#555">X</text><line x1="8" y1="64" x2="292" y2="64" stroke="#333" stroke-width="1.5"/><text x="8" y="82" font-family="sans-serif" font-size="13" fill="#222">${esc(f.name)}</text><text x="8" y="97" font-family="sans-serif" font-size="11" fill="#555">${esc(f.title)}</text><text x="8" y="108" font-family="sans-serif" font-size="10" fill="#777">${esc(f.email)}</text></svg>`;
      const c = centre();
      place({ kind: 'image', resource: dataUrl(new TextEncoder().encode(svg), 'image/svg+xml'), x: c.x - 150, y: c.y - 55, w: 300, h: 110, name: 'Signature Line' });
    },
  };

  /** Connector: how the chosen lines run, and whether bends placed by hand are kept. */
  const connectorDialog = async () => {
    const edges = [...app.interaction.selection].map((id) => model().edge(id)).filter(Boolean);
    if (!edges.length) { app.toast('Choose a connector first'); return; }
    const html = `<label class="field"><span>Type</span><select data-field="routing">${[['orthogonal', 'Standard Connector'], ['straight', 'Straight Connector'], ['curved', 'Curved Connector']].map(([v, l]) => option(v, l, edges[0].routing)).join('')}</select></label>
      <label class="check"><input type="checkbox" data-field="straighten"> Take away bends placed by hand</label>`;
    if (!(await showPanel('Connector', html, 'OK'))) return;
    const f = readFields();
    app.change(() => { model().setEdgeRouting(edges.map((e) => e.id), f.routing); if (f.straighten) for (const e of edges) e.waypoints = []; });
  };

  // Pages

  const pages = {
    add: () => app.change(() => { model().addPage(); layer.select([]); }),
    duplicate: () => app.change(() => { model().duplicatePage(); }),
    remove: async () => {
      if (model().pages.length <= 1) { app.toast('A drawing keeps at least one page'); return; }
      const choice = await showChoice('Delete Page', `<p>Delete “${escapeHtml(model().page.name)}” and everything on it?</p>`, [{ id: 'cancel', label: 'Cancel' }, { id: 'delete', label: 'Delete', primary: true }]);
      if (choice === 'delete') app.change(() => model().deletePage());
    },
    rename: async () => {
      if (!(await showPanel('Rename Page', `<label class="field"><span>Name</span><input type="text" data-field="name" maxlength="200" value="${escapeHtml(model().page.name)}"></label>`, 'OK'))) return;
      const name = readFields().name;
      app.change(() => model().renamePage(name));
    },
    move: (to) => app.change(() => model().movePage(to)),
    go: (index) => { model().goToPage(index); app.interaction.selection.clear(); layer.select([]); app.fitPage(); },
    step: (by) => pages.go(Math.max(0, Math.min(model().pages.length - 1, model().current + by))),
  };

  /** The pages pane: each page a button with a small drawing of its shapes, the current one marked. */
  function renderPages(pane) {
    const m = model();
    pane.replaceChildren(...m.pages.map((page, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `page-item${i === m.current ? ' current' : ''}`;
      item.setAttribute('aria-current', i === m.current ? 'page' : 'false');
      item.title = page.name;
      const things = [...page.nodes, ...page.objects];
      const xs = things.flatMap((t) => [t.x, t.x + t.w]);
      const ys = things.flatMap((t) => [t.y, t.y + t.h]);
      const box = things.length ? [Math.min(...xs) - 10, Math.min(...ys) - 10, Math.max(...xs) - Math.min(...xs) + 20, Math.max(...ys) - Math.min(...ys) + 20] : [0, 0, 100, 60];
      item.innerHTML = `<span class="page-thumb"><svg viewBox="${box.join(' ')}" preserveAspectRatio="xMidYMid meet">${things.map((t) => `<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="3" fill="#e8f0fe" stroke="#1f6feb" stroke-width="${Math.max(box[2], box[3]) / 80}"/>`).join('')}</svg></span><span>${escapeHtml(page.name)}</span>`;
      item.onclick = () => pages.go(i);
      return item;
    }));
  }

  /** The layer's handles over the canvas, in the drawing's coordinates as the view shows them. */
  function renderOverlay(holder) {
    const { x, y, scale } = app.renderer.view;
    holder.style.transform = `scale(${scale}) translate(${-x}px, ${-y}px)`;
    holder.replaceChildren(...layer.overlay());
  }

  /** Arrange for nodes: their order on the page is their stacking, last on top; drawing objects arrange among themselves. */
  const arrange = (how) => {
    const nodes = nodesChosen();
    if (nodes.length) {
      app.change(() => {
        const list = model().nodes;
        const chosen = new Set(nodes.map((n) => n.id));
        const rest = list.filter((n) => !chosen.has(n.id));
        if (how === 'front') model().nodes = [...rest, ...nodes];
        else if (how === 'back') model().nodes = [...nodes, ...rest];
        else {
          const step = how === 'forward' ? 1 : -1;
          const order = [...list];
          const at = order.map((n, i) => (chosen.has(n.id) ? i : -1)).filter((i) => i >= 0);
          for (const i of step > 0 ? at.reverse() : at) { const j = i + step; if (j >= 0 && j < order.length && !chosen.has(order[j].id)) [order[i], order[j]] = [order[j], order[i]]; }
          model().nodes = order;
        }
      });
    }
    if (layer.selection.size) commands.act.arrange(how);
  };

  return { layer, commands, text, styles, insert, connectorDialog, pages, renderPages, renderOverlay, hitTarget, arrange };
}
