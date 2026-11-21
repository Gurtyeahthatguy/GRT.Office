/** The dialogs of drawing objects, laid out as LibreOffice's, with their tabs. */

import { showPanel, readFields, escapeHtml } from '../panel.js';
import { ARROWS, DASHES, cleanLine, cleanFill } from './objects.js';

const ARROW_NAMES = { none: 'None', arrow: 'Arrow', 'arrow-short': 'Arrow short', triangle: 'Triangle', concave: 'Concave', circle: 'Circle', square: 'Square', diamond: 'Diamond', dimension: 'Dimension line', line: 'Line' };
const DASH_NAMES = { solid: 'Continuous', dash: 'Dash', dot: 'Dot', 'dash-dot': 'Dash dot', 'long-dash': 'Long dash', none: 'None' };

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const options = (list, names, chosen) => list.map((v) => `<option value="${v}"${v === chosen ? ' selected' : ''}>${escapeHtml(names[v] ?? v)}</option>`).join('');
const number = (field, label, value, { min = -1e6, max = 1e6, step = 'any', unit = '' } = {}) => `<label class="field"><span>${escapeHtml(label)}${unit ? ` (${escapeHtml(unit)})` : ''}</span><input type="number" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${round(value)}"></label>`;
const check = (field, label, value) => `<label class="check"><input type="checkbox" data-field="${field}"${value ? ' checked' : ''}> ${escapeHtml(label)}</label>`;

/** Tabs as LibreOffice's dialogs have them: every tab's fields stay in the one form, so OK reads them all. */
export function tabs(list) {
  const id = `tabs-${Math.random().toString(36).slice(2, 8)}`;
  const heads = list.map((t, i) => `<button type="button" role="tab" class="grt-tab${i === 0 ? ' active' : ''}" data-tab="${id}-${i}" aria-selected="${i === 0}">${escapeHtml(t.label)}</button>`).join('');
  const bodies = list.map((t, i) => `<div role="tabpanel" class="grt-tab-panel" id="${id}-${i}"${i === 0 ? '' : ' hidden'}>${t.html}</div>`).join('');
  return `<div class="grt-tabs" data-tabs="${id}"><div role="tablist" class="grt-tab-list">${heads}</div>${bodies}</div>`;
}

/** Makes the tab buttons of a dialog switch, by click and by arrow keys. */
export function wireTabs(root = document.getElementById('panel-body')) {
  for (const group of root?.querySelectorAll('.grt-tabs') ?? []) {
    const buttons = [...group.querySelectorAll('.grt-tab')];
    const show = (button) => {
      for (const b of buttons) {
        const on = b === button;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        group.querySelector(`#${b.dataset.tab}`).hidden = !on;
      }
      button.focus();
    };
    for (const b of buttons) {
      b.onclick = () => show(b);
      b.onkeydown = (event) => {
        const at = buttons.indexOf(b);
        if (event.key === 'ArrowRight') { event.preventDefault(); show(buttons[(at + 1) % buttons.length]); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); show(buttons[(at - 1 + buttons.length) % buttons.length]); }
      };
    }
  }
}

/** Shows a dialog whose body has tabs. */
async function ask(title, html, confirm = 'OK') {
  const shown = showPanel(title, html, confirm);
  wireTabs();
  return shown;
}

/**
 * Position and Size (F4): place, size, rotation and protection, in the unit the program shows.
 * @param {{per: number, label: string}} unit page units per shown unit, and its name
 */
export async function positionSizeDialog(o, unit = { per: 1, label: 'px' }) {
  const u = (v) => v / unit.per;
  const html = tabs([
    { label: 'Position and Size', html: `<div class="form-grid">${number('x', 'Position X', u(o.x), { unit: unit.label })}${number('y', 'Position Y', u(o.y), { unit: unit.label })}${number('w', 'Width', u(o.w), { min: 0.01, unit: unit.label })}${number('h', 'Height', u(o.h), { min: 0.01, unit: unit.label })}</div>`
      + `${check('keepRatio', 'Keep ratio', o.keepRatio)}${check('protectPosition', 'Protect position', o.protect?.position)}${check('protectSize', 'Protect size', o.protect?.size)}` },
    { label: 'Rotation', html: `<div class="form-grid">${number('rotation', 'Rotation angle', o.rotation ?? 0, { min: 0, max: 360, unit: '°' })}</div>` },
  ]);
  if (!(await ask('Position and Size', html))) return null;
  const f = readFields();
  const out = {
    x: Number.isFinite(f.x) ? f.x * unit.per : o.x,
    y: Number.isFinite(f.y) ? f.y * unit.per : o.y,
    w: f.w > 0 ? f.w * unit.per : o.w,
    h: f.h > 0 ? f.h * unit.per : o.h,
    rotation: Number.isFinite(f.rotation) ? (((f.rotation % 360) + 360) % 360) : o.rotation ?? 0,
    keepRatio: f.keepRatio,
    protect: { position: f.protectPosition, size: f.protectSize },
  };
  return out;
}

/** Line: style, colour, width, transparency, and the arrow at each end. */
export async function lineDialog(o) {
  const line = cleanLine(o.line);
  const html = tabs([
    { label: 'Line', html: `<div class="form-grid"><label class="field"><span>Style</span><select data-field="style">${options(DASHES, DASH_NAMES, line.style)}</select></label>`
      + `<label class="field"><span>Color</span><input type="color" data-field="color" value="${line.color}"></label>`
      + `${number('width', 'Width', line.width, { min: 0, max: 200, step: 0.5 })}${number('transparency', 'Transparency', line.transparency ?? 0, { min: 0, max: 100, unit: '%' })}</div>` },
    { label: 'Arrow Styles', html: `<div class="form-grid"><label class="field"><span>Start style</span><select data-field="start">${options(ARROWS, ARROW_NAMES, line.start)}</select></label>`
      + `<label class="field"><span>End style</span><select data-field="end">${options(ARROWS, ARROW_NAMES, line.end)}</select></label></div>` },
  ]);
  if (!(await ask('Line', html))) return null;
  return cleanLine(readFields());
}

/** Area: none, colour, gradient or hatching, and transparency. */
export async function areaDialog(o) {
  const fill = cleanFill(o.fillLook);
  const html = tabs([
    { label: 'Area', html: `<div class="form-grid"><label class="field"><span>Fill</span><select data-field="type">${options(['none', 'solid', 'gradient', 'hatch'], { none: 'None', solid: 'Color', gradient: 'Gradient', hatch: 'Hatch' }, fill.type)}</select></label>`
      + `<label class="field"><span>Color</span><input type="color" data-field="color" value="${fill.color}"></label>`
      + `<label class="field"><span>Gradient to</span><input type="color" data-field="color2" value="${fill.color2 ?? '#ffffff'}"></label>`
      + `<label class="field"><span>Gradient type</span><select data-field="shape">${options(['linear', 'radial'], { linear: 'Linear', radial: 'Radial' }, fill.shape ?? 'linear')}</select></label>`
      + `${number('angle', 'Angle', fill.angle ?? 0, { min: -360, max: 360, unit: '°' })}${number('spacing', 'Hatch spacing', fill.spacing ?? 8, { min: 2, max: 200 })}</div>` },
    { label: 'Shadow', html: check('shadow', 'Use shadow', o.shadow) },
    { label: 'Transparency', html: `<div class="form-grid">${number('transparency', 'Transparency', fill.transparency ?? 0, { min: 0, max: 100, unit: '%' })}</div>` },
  ]);
  if (!(await ask('Area', html))) return null;
  const f = readFields();
  return { fillLook: cleanFill(f), shadow: f.shadow };
}

/** Text: where the text sits in a shape, its padding, and whether the shape grows to fit it. */
export async function textAttributesDialog(o) {
  const t = o.textLook ?? {};
  const html = tabs([
    { label: 'Text', html: `${check('grow', 'Resize shape to fit text', t.grow)}${check('wrap', 'Word wrap text in shape', t.wrap !== false)}`
      + `<div class="form-grid">${number('padding', 'Spacing to borders', t.padding ?? 6, { min: 0, max: 500 })}`
      + `<label class="field"><span>Text anchor</span><select data-field="anchor">${options(['top', 'middle', 'bottom'], { top: 'Top', middle: 'Center', bottom: 'Bottom' }, t.anchor ?? 'middle')}</select></label></div>` },
  ]);
  if (!(await ask('Text', html))) return null;
  const f = readFields();
  return { grow: f.grow, wrap: f.wrap, padding: Math.max(0, f.padding || 0), anchor: f.anchor };
}

/** Name: how the object is called in the Navigator and by the screen reader. */
export async function nameDialog(o) {
  const html = `<label class="field"><span>Name</span><input type="text" data-field="name" maxlength="200" value="${escapeHtml(o.name ?? '')}"></label>`;
  if (!(await showPanel('Name', html, 'OK'))) return null;
  return readFields().name.trim();
}

/** Description: the title and the text a screen reader gives, and what an export keeps as alternative text. */
export async function descriptionDialog(o) {
  const html = `<label class="field"><span>Title</span><input type="text" data-field="title" maxlength="200" value="${escapeHtml(o.title ?? '')}"></label>`
    + `<label class="field"><span>Description</span><textarea data-field="description" rows="5" maxlength="5000">${escapeHtml(o.description ?? '')}</textarea></label>`;
  if (!(await showPanel('Description', html, 'OK'))) return null;
  const f = readFields();
  return { title: f.title.trim(), description: f.description.trim() };
}

/** Duplicate (Shift+F3): how many copies, and the step of place, turn, size and colour between them. */
export async function duplicateDialog(unit = { per: 1, label: 'px' }) {
  const html = tabs([
    { label: 'Placement', html: `<div class="form-grid">${number('copies', 'Number of copies', 1, { min: 1, max: 100, step: 1 })}${number('dx', 'X axis', 10, { unit: unit.label })}${number('dy', 'Y axis', 10, { unit: unit.label })}${number('angle', 'Angle', 0, { min: -360, max: 360, unit: '°' })}</div>` },
    { label: 'Enlargement', html: `<div class="form-grid">${number('dw', 'Width', 0, { unit: unit.label })}${number('dh', 'Height', 0, { unit: unit.label })}</div>` },
    { label: 'Colors', html: `${check('colours', 'Change the colour from copy to copy', false)}<div class="form-grid"><label class="field"><span>Start</span><input type="color" data-field="startColor" value="#729fcf"></label><label class="field"><span>End</span><input type="color" data-field="endColor" value="#ffd320"></label></div>` },
  ]);
  if (!(await ask('Duplicate', html))) return null;
  const f = readFields();
  return {
    copies: f.copies, dx: f.dx * unit.per, dy: f.dy * unit.per, angle: f.angle, dw: f.dw * unit.per, dh: f.dh * unit.per,
    ...(f.colours ? { startColor: f.startColor, endColor: f.endColor } : {}),
  };
}

/** Crop: how much of each side of the image is hidden, as a share of the image. */
export async function cropDialog(o) {
  const c = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const html = `<div class="form-grid">${number('l', 'Left', c.l * 100, { min: 0, max: 95, unit: '%' })}${number('r', 'Right', c.r * 100, { min: 0, max: 95, unit: '%' })}${number('t', 'Top', c.t * 100, { min: 0, max: 95, unit: '%' })}${number('b', 'Bottom', c.b * 100, { min: 0, max: 95, unit: '%' })}</div>`
    + check('keepSize', 'Keep the image size, scaling what shows', false);
  if (!(await showPanel('Crop', html, 'OK'))) return null;
  const f = readFields();
  const share = (v) => Math.min(0.95, Math.max(0, (v || 0) / 100));
  return { crop: { l: share(f.l), t: share(f.t), r: share(f.r), b: share(f.b) }, keepSize: f.keepSize };
}

/** Color: brightness, contrast, the three channels, gamma, transparency, and the image mode. */
export async function imageColorDialog(o) {
  const a = o.adjust ?? {};
  const html = `<div class="form-grid">${number('brightness', 'Brightness', a.brightness ?? 0, { min: -100, max: 100, unit: '%' })}${number('contrast', 'Contrast', a.contrast ?? 0, { min: -100, max: 100, unit: '%' })}`
    + `${number('red', 'Red', a.red ?? 0, { min: -100, max: 100, unit: '%' })}${number('green', 'Green', a.green ?? 0, { min: -100, max: 100, unit: '%' })}${number('blue', 'Blue', a.blue ?? 0, { min: -100, max: 100, unit: '%' })}`
    + `${number('gamma', 'Gamma', a.gamma ?? 1, { min: 0.1, max: 10, step: 0.05 })}${number('transparency', 'Transparency', a.transparency ?? 0, { min: 0, max: 100, unit: '%' })}`
    + `<label class="field"><span>Image mode</span><select data-field="mode">${options(['standard', 'grey', 'mono', 'watermark'], { standard: 'Standard', grey: 'Grayscale', mono: 'Black/White', watermark: 'Watermark' }, a.mode ?? 'standard')}</select></label></div>`;
  if (!(await showPanel('Color', html, 'OK'))) return null;
  return readFields();
}

/** Compress Image: the quality and size to make it again at, with what it weighs now. */
export async function compressDialog(info) {
  const html = `<p class="hint">Now ${escapeHtml(info.pixels)} pixels, ${escapeHtml(info.size)}.</p>`
    + `<div class="form-grid"><label class="field"><span>Kind</span><select data-field="format">${options(['jpeg', 'png'], { jpeg: 'JPEG compression', png: 'Lossless compression' }, info.format === 'png' ? 'png' : 'jpeg')}</select></label>`
    + `${number('quality', 'JPEG quality', 80, { min: 1, max: 100, step: 1 })}${number('scale', 'New size', 100, { min: 1, max: 100, step: 1, unit: '%' })}</div>`;
  if (!(await showPanel('Compress Image', html, 'Compress'))) return null;
  const f = readFields();
  return { format: f.format, quality: Math.min(100, Math.max(1, f.quality || 80)) / 100, scale: Math.min(100, Math.max(1, f.scale || 100)) / 100 };
}

/** Distribute Selection: one choice across, one up and down. */
export async function distributeDialog() {
  const radios = (field, list) => list.map(([v, l], i) => `<label class="check"><input type="radio" name="${field}" data-field="${field}" value="${v}"${i === 0 ? ' checked' : ''}> ${escapeHtml(l)}</label>`).join('');
  const html = `<fieldset><legend>Horizontally</legend>${radios('h', [['none', 'None'], ['left', 'Left'], ['center', 'Center'], ['spacing-h', 'Spacing'], ['right', 'Right']])}</fieldset>`
    + `<fieldset><legend>Vertically</legend>${radios('v', [['none', 'None'], ['top', 'Top'], ['middle', 'Center'], ['spacing-v', 'Spacing'], ['bottom', 'Bottom']])}</fieldset>`;
  if (!(await showPanel('Distribute Selection', html, 'OK'))) return null;
  return readFields();
}

/** Snap Guide: a line objects snap to, across or up and down, at a place on the page. */
export async function snapGuideDialog(unit = { per: 1, label: 'px' }) {
  const html = `<div class="form-grid"><label class="field"><span>Type</span><select data-field="type"><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option></select></label>${number('at', 'Position', 0, { unit: unit.label })}</div>`;
  if (!(await showPanel('Snap Guide', html, 'OK'))) return null;
  const f = readFields();
  return { vertical: f.type === 'vertical', at: (f.at || 0) * unit.per };
}

/** Rotate: the angle of the chosen objects. */
export async function rotateDialog(angle = 0) {
  const html = `<div class="form-grid">${number('angle', 'Rotation angle', angle, { min: 0, max: 360, unit: '°' })}</div>`;
  if (!(await showPanel('Rotation', html, 'OK'))) return null;
  const a = readFields().angle;
  return Number.isFinite(a) ? (((a % 360) + 360) % 360) : null;
}

/** Graphic Size Check: each image's resolution at the size it is shown, and whether it prints well. */
export async function sizeCheckDialog(rows) {
  const body = rows.length
    ? `<table class="report"><thead><tr><th>Image</th><th>Pixels</th><th>Shown at</th><th>Resolution</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${r.pixels}</td><td>${escapeHtml(r.shown)}</td><td>${r.dpi} DPI</td><td>${r.dpi < 150 ? 'Too low for print' : r.dpi > 600 ? 'More than print needs: Compress can make it lighter' : 'Fine'}</td></tr>`).join('')}</tbody></table>`
    : '<p>There are no images.</p>';
  await showPanel('Graphic Size Check', body, null);
}

/** Text along Path, as a dialog: the text a shape carries along its outline. */
export async function textPathDialog(text) {
  const html = `<label class="field"><span>Text along the shape's outline</span><input type="text" data-field="text" maxlength="500" value="${escapeHtml(text ?? '')}"></label>`;
  if (!(await showPanel('Text along Path', html, 'OK'))) return null;
  return readFields().text;
}
