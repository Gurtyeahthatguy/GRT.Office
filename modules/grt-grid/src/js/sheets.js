/** The sheets of a document: renamed, deleted, hidden, moved, copied and coloured, from the tabs or the Sheet menu. */

import { showPanel, readFields, escapeHtml } from './core/panel.js';

const TAB_COLOURS = ['#c9211e', '#ff8000', '#e6a700', '#2a6099', '#00a933', '#55308d', '#bf0041', '#808080'];

/** Asks for a sheet's new name until one is free, or the dialog is closed. */
export async function renameSheetDialog(controller, id, toast) {
  const target = controller.model.sheetById(id);
  if (!target) return;
  const confirmed = await showPanel('Rename sheet', `
    <label>Name<input data-field="name" maxlength="100" value="${escapeHtml(target.name)}"></label>
    <p class="hint">A name cannot hold [ ] * ? : / or \\.</p>`, 'Rename');
  if (!confirmed) return;
  if (!controller.renameSheet(id, readFields().name)) toast('That name is empty, taken or holds a character a sheet name cannot have');
}

/** Deletes a sheet after asking, as it cannot be read back other than by undoing. */
export async function deleteSheetDialog(controller, id) {
  const target = controller.model.sheetById(id);
  if (!target || controller.model.sheets.length <= 1) return;
  const confirmed = await showPanel('Delete sheet', `<p>Delete the sheet <strong>${escapeHtml(target.name)}</strong>? Formulas that point at it show #REF!.</p>`, 'Delete');
  if (confirmed) controller.deleteSheet(id);
}

/** Lists the hidden sheets and shows the ones chosen. */
export async function showSheetsDialog(controller, toast) {
  const hidden = controller.model.sheets.filter((s) => s.hidden);
  if (!hidden.length) {
    toast('No sheet is hidden');
    return;
  }
  const confirmed = await showPanel('Show sheets', `
    <p>Hidden sheets:</p>
    ${hidden.map((s, i) => `<label class="inline"><input type="checkbox" data-field="s${i}"${i === 0 ? ' checked' : ''}> ${escapeHtml(s.name)}</label>`).join('')}`, 'Show');
  if (!confirmed) return;
  const fields = readFields();
  hidden.forEach((s, i) => { if (fields[`s${i}`]) controller.setSheetHidden(s.id, false); });
}

/** Moves or copies a sheet before another, or to the end. */
export async function moveCopySheetDialog(controller, id) {
  const target = controller.model.sheetById(id);
  if (!target) return;
  const others = controller.model.sheets;
  const confirmed = await showPanel('Move or copy sheet', `
    <fieldset><legend>Action</legend>
      <label class="inline"><input type="radio" name="sheet-action" data-field="action" value="move" checked> Move</label>
      <label class="inline"><input type="radio" name="sheet-action" data-field="action" value="copy"> Copy</label>
    </fieldset>
    <label>Insert before<select data-field="before">
      ${others.map((s, i) => `<option value="${i}"${s === target ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      <option value="${others.length}">(at the end)</option>
    </select></label>
    <label>Name of the copy<input data-field="name" maxlength="100" value="${escapeHtml(`${target.name}_2`)}"></label>`, 'OK');
  if (!confirmed) return;
  const { action, before, name } = readFields();
  const at = Number(before);
  if (action === 'copy') {
    controller.moveSheet(id, at, { copy: true, name: String(name ?? '').trim() || null });
  } else {
    // Taken out first, the sheet lands one place earlier when it moves right.
    const from = others.indexOf(target);
    controller.moveSheet(id, at > from ? at - 1 : at);
  }
}

/** Chooses the colour of a sheet's tab, or none. */
export async function tabColourDialog(controller, id) {
  const target = controller.model.sheetById(id);
  if (!target) return;
  const confirmed = await showPanel('Tab colour', `
    <div class="choices" role="radiogroup" aria-label="Colours">
      <label class="inline"><input type="radio" name="tab-colour" data-field="colour" value=""${target.tab ? '' : ' checked'}> None</label>
      ${TAB_COLOURS.map((c) => `<label class="inline"><input type="radio" name="tab-colour" data-field="colour" value="${c}"${target.tab === c ? ' checked' : ''}> <span class="swatch" style="background:${c}"></span></label>`).join('')}
    </div>
    <label>Another colour<input type="color" data-field="custom" value="${target.tab && !TAB_COLOURS.includes(target.tab) ? target.tab : '#2a6099'}"></label>
    <label class="inline"><input type="checkbox" data-field="useCustom"${target.tab && !TAB_COLOURS.includes(target.tab) ? ' checked' : ''}> Use the other colour</label>`, 'Apply');
  if (!confirmed) return;
  const { colour, custom, useCustom } = readFields();
  controller.setTabColour(id, useCustom ? custom : colour || null);
}

/** Goes to a sheet chosen by name. */
export async function goToSheetDialog(controller) {
  const shown = controller.model.sheets.filter((s) => !s.hidden);
  const confirmed = await showPanel('Go to sheet', `
    <label>Sheet<select data-field="sheet">
      ${shown.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === controller.model.activeSheetId ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
    </select></label>`, 'Go');
  if (confirmed) controller.switchSheet(readFields().sheet);
}

/** The menu a sheet's tab opens. */
export function tabMenuItems(controller, id, toast) {
  const many = () => controller.model.sheets.filter((s) => !s.hidden).length > 1;
  return [
    { label: 'Insert sheet', run: () => controller.addSheet() },
    { label: 'Rename sheet…', run: () => renameSheetDialog(controller, id, toast) },
    { label: 'Delete sheet…', run: () => deleteSheetDialog(controller, id), enabled: () => controller.model.sheets.length > 1 },
    'separator',
    { label: 'Duplicate sheet', run: () => controller.moveSheet(id, null, { copy: true }) },
    { label: 'Move or copy sheet…', run: () => moveCopySheetDialog(controller, id) },
    'separator',
    { label: 'Hide sheet', run: () => controller.setSheetHidden(id, true), enabled: many },
    { label: 'Show sheets…', run: () => showSheetsDialog(controller, toast), enabled: () => controller.model.sheets.some((s) => s.hidden) },
    { label: 'Tab colour…', run: () => tabColourDialog(controller, id) },
  ];
}
