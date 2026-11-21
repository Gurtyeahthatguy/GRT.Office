/** Slides' charts, formulas, layouts and masters: the dialogs, the model changes left to the caller's undo. */

import { formulaDialog } from './core/formula-dialog.js';
import { showChoice, readFields, escapeHtml } from './core/panel.js';
import { LAYOUTS } from './model.js';

const option = (value, label, chosen) => `<option value="${escapeHtml(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`;

export { chartDialog } from './core/chart-dialog.js';

/** The formula of a slide: TeX typed, the formula drawn as it is typed. */
export async function slideFormulaDialog(existing = null) {
  const object = await formulaDialog(existing ? { tex: existing.tex, display: true } : { display: true });
  return object ? { tex: object.tex, ...(object.mathml ? { mathml: object.mathml } : {}) } : null;
}

/** Which layout a slide gets: its placeholders put where the layout says. */
export async function layoutDialog(current = 'titleContent') {
  const choice = await showChoice('Layout', `
    <div class="layout-grid">${Object.entries(LAYOUTS).map(([id, layout]) => `
      <label class="layout-option"><input type="radio" name="layout" data-field="layout-${id}"${id === current ? ' checked' : ''}>
        <span class="layout-sketch">${layout.places.map(([name, , x, y, w, h]) => `<i class="${name}" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></i>`).join('')}</span>
        <span>${escapeHtml(layout.label)}</span></label>`).join('')}</div>`, [
    { id: 'cancel', label: 'Cancel' }, { id: 'apply', label: 'Apply', primary: true },
  ]);
  if (choice !== 'apply') return null;
  const fields = readFields();
  return Object.keys(LAYOUTS).find((id) => fields[`layout-${id}`]) ?? null;
}

/** The masters dialog: pick one to edit, make one, rename, delete, or give it to the slide in view. */
export async function mastersDialog(model, slideId) {
  const slide = model.slide(slideId);
  const choice = await showChoice('Masters', `
    ${model.masters.length ? `<label>Master<select data-field="master">${model.masters.map((m) => option(m.id, m.name ?? 'Master', slide?.master ?? '')).join('')}</select></label>`
    : '<p class="hint">No masters yet. A master holds what every slide that uses it shows underneath: a logo, a band of colour, a footer.</p>'}
    <label>Name for a new master, or a new name for this one<input data-field="name" placeholder="Company"></label>`, [
    ...(model.masters.length ? [{ id: 'delete', label: 'Delete' }, { id: 'rename', label: 'Rename' }, { id: 'assign', label: 'Use on this slide' }, { id: 'all', label: 'Use on every slide' }] : []),
    { id: 'new', label: 'New master' }, { id: 'cancel', label: 'Close' },
    ...(model.masters.length ? [{ id: 'edit', label: 'Edit it', primary: true }] : []),
  ]);
  const f = readFields();
  return { choice, master: f.master ?? null, name: (f.name ?? '').trim() };
}
