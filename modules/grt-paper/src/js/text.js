/** Format, Text and Character: case, size, font effects, special characters, the Character and Paragraph dialogs, and zoom. */

import { applyFormat, transformCase, resizeText, insertText, blocksInRange } from './core/editor/commands.js';
import { MARKS } from './core/editor/model.js';
import { withPara } from './core/editor/render.js';
import { FORMATTING_MARKS } from './core/text-case.js';
import { specialCharacter } from './core/special-chars.js';
import { showPanel, readFields, escapeHtml } from './core/panel.js';

const PT = 4 / 3;

/**
 * @param {{editor: Object, model: () => Object, edit: Function, readSelection: Function, refresh: Function,
 *   invalidate: Function, settings: () => Object, saveSettings: Function, toast: Function}} app
 */
export function textTools(app) {
  const { editor, edit, readSelection } = app;
  const model = () => app.model();
  const sizeOf = (block) => (block ? withPara(model().styles[block.style] ?? {}, block.para).size ?? 11 : 11);

  function textCase(mode) {
    readSelection();
    edit(() => transformCase(model(), editor.selection, mode));
    app.invalidate();
  }

  function resize(direction) {
    readSelection();
    edit(() => resizeText(model(), editor.selection, direction, sizeOf));
    app.invalidate();
  }

  function insertChars(text) {
    readSelection();
    edit(() => insertText(model(), editor.selection, text));
  }

  async function special() {
    readSelection();
    const selection = editor.selection;
    const text = await specialCharacter();
    if (!text) return;
    editor.selection = selection;
    edit(() => insertText(model(), editor.selection, text), { read: false });
  }

  /** The look the selection starts with, for the dialog to show. */
  function lookAtStart() {
    const start = editor.selection?.anchor;
    const block = start ? model().block(start.blockId) : null;
    const runs = block ? model().runsOf(block.id, start.itemIndex ?? null) : [];
    let seen = 0;
    const run = runs.find((r) => {
      seen += r.text.length;
      return seen > (start?.offset ?? 0);
    }) ?? runs[runs.length - 1] ?? {};
    return { run, base: block ? withPara(model().styles[block.style] ?? {}, block.para) : {} };
  }

  async function characterDialog() {
    readSelection();
    const selection = editor.selection;
    const { run, base } = lookAtStart();
    const check = (field, label, on) => `<div class="setting"><span class="label">${label}</span><input type="checkbox" data-field="${field}"${on ? ' checked' : ''} /></div>`;
    const underline = run.double ? 'double' : run.underline ? 'single' : 'none';
    const position = run.sup ? 'sup' : run.sub ? 'sub' : 'normal';
    const confirmed = await showPanel('Character', `
      <h3 class="form-heading">Font</h3>
      <div class="form-grid">
        <label for="ch-size">Size, in points</label>
        <input id="ch-size" type="number" min="2" max="999" step="0.5" data-field="size" value="${run.size ?? base.size ?? 11}" />
        <label for="ch-color">Font colour</label>
        <input id="ch-color" type="color" data-field="color" value="${escapeHtml(run.color ?? '#000000')}" />
        <label for="ch-highlight">Highlighting</label>
        <input id="ch-highlight" type="color" data-field="highlight" value="${escapeHtml(run.highlight ?? '#ffff00')}" />
      </div>
      ${check('bold', 'Bold', run.bold)}${check('italic', 'Italic', run.italic)}
      ${check('noColor', 'Automatic font colour', !run.color)}${check('noHighlight', 'No highlighting', !run.highlight)}
      <h3 class="form-heading">Font effects</h3>
      <div class="form-grid">
        <label for="ch-underline">Underlining</label>
        <select id="ch-underline" data-field="underline">${[['none', '(Without)'], ['single', 'Single'], ['double', 'Double']].map(([v, l]) => `<option value="${v}"${underline === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label for="ch-position">Position</label>
        <select id="ch-position" data-field="position">${[['normal', 'Normal'], ['sup', 'Superscript'], ['sub', 'Subscript']].map(([v, l]) => `<option value="${v}"${position === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      ${check('overline', 'Overlining', run.overline)}${check('strike', 'Strikethrough', run.strike)}
      ${check('shadow', 'Shadow', run.shadow)}${check('outline', 'Outline', run.outline)}${check('smallcaps', 'Small capitals', run.smallcaps)}`, 'OK');
    if (!confirmed) return;
    const f = readFields();
    editor.selection = selection;
    edit(() => {
      const m = model();
      const on = { bold: f.bold, italic: f.italic, overline: f.overline, strike: f.strike, shadow: f.shadow, outline: f.outline, smallcaps: f.smallcaps,
        underline: f.underline === 'single', double: f.underline === 'double', sup: f.position === 'sup', sub: f.position === 'sub' };
      for (const mark of MARKS) if (mark in on) applyFormat(m, selection, mark, !!on[mark]);
      const size = Number(f.size);
      if (size > 0) applyFormat(m, selection, 'size', size);
      applyFormat(m, selection, 'color', f.noColor ? '' : f.color);
      applyFormat(m, selection, 'highlight', f.noHighlight ? '' : f.highlight);
      return selection;
    }, { read: false });
    app.invalidate();
  }

  async function paragraphDialog() {
    readSelection();
    const selection = editor.selection;
    const id = blocksInRange(model(), selection)[0];
    const block = id ? model().block(id) : null;
    if (!block) return;
    const look = withPara(model().styles[block.style] ?? {}, block.para);
    const cm = (points) => Math.round(((points ?? 0) / 72) * 2.54 * 100) / 100;
    const confirmed = await showPanel('Paragraph', `
      <h3 class="form-heading">Indents and spacing</h3>
      <div class="form-grid">
        <label for="pa-before">Before text, in cm</label><input id="pa-before" type="number" step="0.05" data-field="indent" value="${cm(look.indent)}" />
        <label for="pa-first">First line, in cm</label><input id="pa-first" type="number" step="0.05" data-field="firstLine" value="${cm(look.firstLine)}" />
        <label for="pa-above">Above paragraph, in cm</label><input id="pa-above" type="number" min="0" step="0.05" data-field="spaceBefore" value="${cm(look.spaceBefore)}" />
        <label for="pa-below">Below paragraph, in cm</label><input id="pa-below" type="number" min="0" step="0.05" data-field="spaceAfter" value="${cm(look.spaceAfter)}" />
        <label for="pa-line">Line spacing, times</label><input id="pa-line" type="number" min="0.5" max="10" step="0.05" data-field="lineHeight" value="${look.lineHeight ?? 1.5}" />
      </div>
      <h3 class="form-heading">Alignment</h3>
      <div class="form-grid">
        <label for="pa-align">Options</label>
        <select id="pa-align" data-field="align">${[['left', 'Start'], ['center', 'Centre'], ['right', 'End'], ['justify', 'Justified']].map(([v, l]) => `<option value="${v}"${(block.align ?? 'left') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </div>`, 'OK');
    if (!confirmed) return;
    const f = readFields();
    const points = (value) => (Number.isFinite(Number(value)) ? (Number(value) / 2.54) * 72 : 0);
    editor.selection = selection;
    edit(() => {
      const m = model();
      for (const blockId of blocksInRange(m, selection)) {
        m.setPara(blockId, {
          indent: Math.max(0, points(f.indent)), firstLine: points(f.firstLine), spaceBefore: Math.max(0, points(f.spaceBefore)),
          spaceAfter: Math.max(0, points(f.spaceAfter)), lineHeight: Math.min(10, Math.max(0.5, Number(f.lineHeight) || 1.5)),
        });
        const b = m.block(blockId);
        if (b) b.align = f.align;
      }
      m.dirty = true;
      return selection;
    }, { read: false });
    app.invalidate();
  }

  // Zoom, kept with the settings and never in the document.

  const sheet = () => document.getElementById('sheet');
  const scroll = () => document.getElementById('scroll');

  function setZoom(factor) {
    const value = Math.min(6, Math.max(0.2, factor));
    sheet().style.zoom = String(value);
    app.settings().zoom = value;
    app.saveSettings();
    const label = document.getElementById('zoom-label');
    if (label) label.textContent = `${Math.round(value * 100)}%`;
    app.invalidate();
  }

  function zoomTo(mode) {
    const page = sheet();
    const current = Number(page.style.zoom || 1);
    const width = page.offsetWidth / (current === 0 ? 1 : 1);
    const area = scroll();
    const margin = 32;
    if (mode === 'width') return setZoom((area.clientWidth - margin) / width);
    if (mode === 'page') {
      const pageHeight = width * (297 / 210);
      return setZoom(Math.min((area.clientWidth - margin) / width, (area.clientHeight - margin) / pageHeight));
    }
    // Optimal: the text area, without the page margins, fills the window.
    const surface = document.getElementById('surface');
    const text = surface.offsetWidth;
    return setZoom((area.clientWidth - margin) / Math.max(1, text));
  }

  async function zoomDialog() {
    const current = Math.round(Number(sheet().style.zoom || 1) * 100);
    const confirmed = await showPanel('Zoom and view layout', `
      <div class="form-grid">
        <label for="zm-value">Variable, in %</label>
        <input id="zm-value" type="number" min="20" max="600" step="5" data-field="value" value="${current}" />
      </div>`, 'OK');
    if (!confirmed) return;
    const value = Number(readFields().value);
    if (value >= 20 && value <= 600) setZoom(value / 100);
  }

  function restoreZoom() {
    const saved = app.settings().zoom;
    if (typeof saved === 'number' && saved !== 1) setZoom(saved);
  }

  return {
    textCase, resize, insertChars, special, characterDialog, paragraphDialog,
    setZoom, zoomTo, zoomDialog, restoreZoom, marks: FORMATTING_MARKS,
  };
}

export { PT };
