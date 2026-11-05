/** Styles: paragraph and character styles edited with the text shown as it will look, and list numbering. */

import { styleCss, fontStack, PT } from './core/editor/render.js';
import { NUMBER_FORMATS, BULLETS } from './core/editor/model.js';
import { applyFormat, blocksInRange } from './core/editor/commands.js';

const escape = (text) => String(text ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const option = (value, label, chosen) => `<option value="${escape(value)}"${value === chosen ? ' selected' : ''}>${escape(label)}</option>`;

export const BUILT_IN = { body: 'Body text', title: 'Title', subtitle: 'Subtitle', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', quote: 'Quotations', code: 'Preformatted text', caption: 'Caption', hr: 'Horizontal line' };
const FONTS = [['serif', 'Serif'], ['sans', 'Sans serif'], ['mono', 'Monospace']];

/** The paragraph styles in the order the list shows them: Paper's own, then the person's. */
export function paragraphStyles(model) {
  return [
    ...Object.entries(BUILT_IN).filter(([key]) => model.styles[key]).map(([key, label]) => ({ key, label })),
    ...Object.entries(model.styles).filter(([key]) => key.startsWith('c-')).map(([key, style]) => ({ key, label: style.name ?? key })),
  ];
}

/**
 * @param {{model: () => object, editor: object, edit: Function, showChoice: Function, showPanel: Function, readFields: Function, done: Function, applyStyle: Function}} app
 */
export function paperStyles(app) {
  const form = (style, fonts) => `
    <div class="form-grid">
      <label>Font</label><select data-field="font">${fonts.map(([v, l]) => option(v, l, style.font ?? 'serif')).join('')}</select>
      <label>Size, points</label><input type="number" min="5" max="96" step="0.5" data-field="size" value="${style.size ?? 11}">
      <label>Colour</label><input type="color" data-field="color" value="${style.color ?? '#000000'}">
      <label>Line height</label><input type="number" min="0.8" max="4" step="0.05" data-field="lineHeight" value="${style.lineHeight ?? 1.5}">
      <label>Space above, points</label><input type="number" min="0" max="200" data-field="spaceBefore" value="${style.spaceBefore ?? 0}">
      <label>Space below, points</label><input type="number" min="0" max="200" data-field="spaceAfter" value="${style.spaceAfter ?? 0}">
      <label>Indent, points</label><input type="number" min="0" max="200" data-field="indent" value="${style.indent ?? 0}">
      <label>First line, points</label><input type="number" min="-100" max="200" data-field="firstLine" value="${style.firstLine ?? 0}">
    </div>
    <div class="setting-row">
      <label class="inline"><input type="checkbox" data-field="bold"${style.bold ? ' checked' : ''}> Bold</label>
      <label class="inline"><input type="checkbox" data-field="italic"${style.italic ? ' checked' : ''}> Italic</label>
      <label class="inline"><input type="checkbox" data-field="underline"${style.underline ? ' checked' : ''}> Underline</label>
    </div>`;
  const read = () => {
    const f = app.readFields();
    return {
      font: f.font, size: Number(f.size), color: f.color === '#000000' ? undefined : f.color, lineHeight: Number(f.lineHeight),
      spaceBefore: Number(f.spaceBefore), spaceAfter: Number(f.spaceAfter), indent: Number(f.indent) || undefined, firstLine: Number(f.firstLine) || undefined,
      bold: f.bold, italic: f.italic, underline: f.underline,
    };
  };
  const fontsOf = (model) => [...FONTS, ...(model.fonts ?? []).map((font) => [font.id, font.name])];

  /** The styles dialog: pick a paragraph style, change it with the sample following, or make a new one. */
  async function stylesDialog() {
    const model = app.model();
    app.editor.readSelection();
    const at = app.editor.selection?.anchor;
    let chosen = (at && model.block(at.blockId)?.style) || 'body';
    for (;;) {
      const styles = paragraphStyles(model);
      const style = model.styles[chosen] ?? model.styles.body;
      const answer = app.showChoice('Paragraph styles', `
        <label class="stacked">Style<select data-field="which">${styles.map((s) => option(s.key, s.label, chosen)).join('')}</select></label>
        <div class="style-sample" id="style-sample">The quick brown fox jumps over the lazy dog, and the sample shows the style as it will be.</div>
        ${form(style, fontsOf(model))}
        <label class="stacked">Name for a new style taken from this one<input data-field="newName" placeholder="Abstract"></label>`, [
        ...(chosen.startsWith('c-') ? [{ id: 'delete', label: 'Delete' }] : []),
        { id: 'new', label: 'New style' }, { id: 'cancel', label: 'Close' }, { id: 'apply', label: 'Apply to paragraph' },
        { id: 'save', label: 'Save the style', primary: true },
      ]);
      const body = document.getElementById('panel-body');
      const preview = () => {
        const sample = document.getElementById('style-sample');
        if (sample) Object.assign(sample.style, styleCss({ ...read() }, model));
      };
      const switchTo = (event) => {
        if (event.target.dataset.field !== 'which') return;
        chosen = event.target.value;
        document.querySelector('[data-choice="cancel"]')?.click();
        switched = true;
      };
      let switched = false;
      body.addEventListener('input', preview);
      body.addEventListener('change', switchTo);
      preview();
      const choice = await answer;
      body.removeEventListener('input', preview);
      body.removeEventListener('change', switchTo);
      if (switched) continue;
      if (choice === null || choice === 'cancel') return;
      const f = app.readFields();
      const look = read();
      if (choice === 'save') app.edit(() => {
        model.setStyle(chosen, look);
        return app.editor.selection;
      });
      if (choice === 'new' && f.newName.trim()) {
        app.edit(() => {
          chosen = model.addStyle(f.newName.trim(), chosen);
          model.setStyle(chosen, look);
          return app.editor.selection;
        });
        continue;
      }
      if (choice === 'delete') {
        app.edit(() => {
          model.removeStyle(chosen);
          return app.editor.selection;
        });
        chosen = 'body';
        continue;
      }
      if (choice === 'apply') app.applyStyle(chosen);
      app.done();
      return;
    }
  }

  /** Character styles: a named look for words, applied to the selection. */
  async function characterStyles() {
    const model = app.model();
    app.editor.readSelection();
    const entries = Object.entries(model.charStyles ?? {});
    const answer = app.showChoice('Character styles', `
      ${entries.length ? `<label class="stacked">Style<select data-field="which">${option('', '(none: take it off)', '')}${entries.map(([k, s]) => option(k, s.name ?? k, '')).join('')}</select></label>` : '<p class="fp-note">No character styles yet.</p>'}
      <div class="style-sample" id="style-sample">Emphasised words look like this.</div>
      <label class="stacked">Name for a new style<input data-field="newName" placeholder="Emphasis"></label>
      <div class="form-grid">
        <label>Font</label><select data-field="font">${option('', 'As the paragraph', '')}${fontsOf(model).map(([v, l]) => option(v, l, '')).join('')}</select>
        <label>Colour</label><input type="color" data-field="color" value="#000000">
        <label>Highlight</label><input type="color" data-field="highlight" value="#ffffff">
      </div>
      <div class="setting-row">
        <label class="inline"><input type="checkbox" data-field="bold"> Bold</label>
        <label class="inline"><input type="checkbox" data-field="italic" checked> Italic</label>
        <label class="inline"><input type="checkbox" data-field="underline"> Underline</label>
      </div>`, [
      { id: 'cancel', label: 'Close' }, { id: 'new', label: 'New from these' }, ...(entries.length ? [{ id: 'apply', label: 'Apply to selection', primary: true }] : []),
    ]);
    const body = document.getElementById('panel-body');
    const look = () => {
      const f = app.readFields();
      return { font: f.font || undefined, color: f.color === '#000000' ? undefined : f.color, highlight: f.highlight === '#ffffff' ? undefined : f.highlight, bold: f.bold, italic: f.italic, underline: f.underline };
    };
    const preview = () => {
      const sample = document.getElementById('style-sample');
      if (!sample) return;
      const l = look();
      Object.assign(sample.style, {
        fontFamily: l.font ? fontStack(l.font, model) : '', color: l.color ?? '', backgroundColor: l.highlight ?? '',
        fontWeight: l.bold ? '700' : '400', fontStyle: l.italic ? 'italic' : 'normal', textDecoration: l.underline ? 'underline' : '',
      });
    };
    body.addEventListener('input', preview);
    preview();
    const choice = await answer;
    body.removeEventListener('input', preview);
    const f = app.readFields();
    if (choice === 'new' && f.newName.trim()) {
      app.edit(() => {
        const key = model.addCharStyle(f.newName.trim(), look());
        return applyFormat(model, app.editor.selection, 'cstyle', key);
      });
    } else if (choice === 'apply') {
      app.edit(() => applyFormat(model, app.editor.selection, 'cstyle', f.which || ''));
    } else return;
    app.done();
  }

  /** How the lists in the selection count or what they show. */
  async function listFormat() {
    const model = app.model();
    app.editor.readSelection();
    const lists = blocksInRange(model, app.editor.selection).filter((b) => b.kind === 'list');
    if (lists.length === 0) return;
    const first = lists[0];
    const confirmed = await app.showPanel('Bullets and numbering', `
      <div class="form-grid">
        <label>Numbers</label><select data-field="format">${[['decimal', '1, 2, 3'], ['lower-alpha', 'a, b, c'], ['upper-alpha', 'A, B, C'], ['lower-roman', 'i, ii, iii'], ['upper-roman', 'I, II, III']].map(([v, l]) => option(v, l, first.format ?? 'decimal')).join('')}</select>
        <label>Bullets</label><select data-field="bullet">${BULLETS.map((b) => option(b, b, first.bullet ?? '•')).join('')}</select>
      </div>`, 'Apply');
    if (!confirmed) return;
    const f = app.readFields();
    app.edit(() => {
      for (const list of lists) {
        if (NUMBER_FORMATS.includes(f.format)) list.format = f.format === 'decimal' ? undefined : f.format;
        list.bullet = f.bullet === '•' ? undefined : f.bullet;
        if (!list.format) delete list.format;
        if (!list.bullet) delete list.bullet;
      }
      return app.editor.selection;
    });
    app.done();
  }

  return { stylesDialog, characterStyles, listFormat };
}

export { PT };
