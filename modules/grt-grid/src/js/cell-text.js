/** Text in cells: case, size steps, special characters and formatting marks typed into the edit, and zoom. */

import { changeCase, stepSize, FORMATTING_MARKS } from './core/text-case.js';
import { specialCharacter } from './core/special-chars.js';
import { showPanel, readFields } from './core/panel.js';

/**
 * @param {{sheet: () => import('./controller.js').SheetController, settings: () => Object, saveSettings: Function,
 *   redraw: Function, toast: Function}} app
 */
export function cellText(app) {
  const input = () => document.getElementById('formula-input');

  const textCase = (mode) => app.sheet().changeTextCase((text) => changeCase(text, mode));

  const resize = (direction) => app.sheet().formatCells((look) => ({ ...look, size: stepSize(look.size ?? 10, direction) }));

  /** Types text into the cell being edited at its caret, or starts an edit of the active cell and adds it at the end. */
  function insertChars(text) {
    const field = input();
    const editing = app.sheet().editing !== null;
    if (!editing) {
      field.value = app.sheet().activeText;
      field.focus();
    } else field.focus();
    const from = editing ? field.selectionStart ?? field.value.length : field.value.length;
    const to = editing ? field.selectionEnd ?? from : from;
    field.value = field.value.slice(0, from) + text + field.value.slice(to);
    field.setSelectionRange(from + text.length, from + text.length);
    app.sheet().updateEdit(field.value);
  }

  async function special() {
    const field = input();
    const kept = { start: field.selectionStart, end: field.selectionEnd };
    const text = await specialCharacter();
    if (!text) return;
    if (app.sheet().editing !== null) field.setSelectionRange(kept.start ?? field.value.length, kept.end ?? field.value.length);
    insertChars(text);
  }

  // Zoom, kept with the settings and never in the document.

  function setZoom(factor) {
    const value = Math.min(4, Math.max(0.2, Number(factor) || 1));
    document.getElementById('grid').style.zoom = value === 1 ? '' : String(value);
    app.settings().zoom = value;
    app.saveSettings();
    const label = document.getElementById('zoom-label');
    if (label) label.textContent = `${Math.round(value * 100)}%`;
    app.redraw();
  }

  const zoom = () => Number(app.settings().zoom) || 1;

  /** Fits an area in the window, or only its width, as Calc's Optimal View, Entire Page and Page Width. */
  function zoomToArea(area, { widthOnly = false } = {}) {
    const grid = document.getElementById('grid');
    const s = app.sheet();
    const { top, bottom, left, right } = area;
    let width = 0;
    let height = 0;
    for (let c = left; c <= right && c - left < 2000; c += 1) width += s.sheet.columnWidth(c);
    for (let r = top; r <= bottom && r - top < 20000; r += 1) height += s.sheet.rowHeight(r);
    const head = 60;
    const across = (grid.clientWidth * zoom() - head) / Math.max(1, width);
    const down = (grid.clientHeight * zoom() - head) / Math.max(1, height);
    setZoom(Math.floor((widthOnly ? across : Math.min(across, down)) * 20) / 20);
  }

  const used = () => {
    const bounds = app.sheet().sheet.usedBounds();
    return bounds ? { top: 0, left: 0, bottom: bounds.bottom, right: bounds.right } : { top: 0, left: 0, bottom: 29, right: 9 };
  };
  const zoomToSelection = () => zoomToArea(app.sheet().selection);
  const entirePage = () => zoomToArea(used());
  const pageWidth = () => zoomToArea(used(), { widthOnly: true });

  async function zoomDialog() {
    const confirmed = await showPanel('Zoom and view layout', `
      <div class="form-grid">
        <label for="zm-value">Variable, in %</label>
        <input id="zm-value" type="number" min="20" max="400" step="5" data-field="value" value="${Math.round(zoom() * 100)}" />
      </div>`, 'OK');
    if (!confirmed) return;
    const value = Number(readFields().value);
    if (value >= 20 && value <= 400) setZoom(value / 100);
  }

  function restoreZoom() {
    if (zoom() !== 1) setZoom(zoom());
  }

  return { textCase, resize, insertChars, special, setZoom, zoomToSelection, entirePage, pageWidth, zoomDialog, restoreZoom, zoom, marks: FORMATTING_MARKS };
}
