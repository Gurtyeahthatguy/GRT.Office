/** Long documents: notes, bookmarks, references, captions, the table of contents and the index. */

import { makeBlock, OBJECT, runsText, NUMBER_FORMATS, normaliseHeadingNumbers, normaliseNoteSettings } from './core/editor/model.js';
import { insertObject, objectAt, insertBlockAt } from './core/editor/commands.js';
import { fromDom, point, collapsed } from './core/editor/selection.js';
import { documentFields } from './core/editor/fields.js';
import { tableAt } from './core/editor/tables.js';
import { formulaDialog } from './core/formula-dialog.js';

const escape = (text) => String(text ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * @param {{model: () => object, editor: object, edit: Function, showPanel: Function, readFields: Function, toast: Function, done: Function}} app
 */
export function longDocument(app) {
  const model = () => app.model();
  const sel = () => {
    app.editor.readSelection();
    return app.editor.selection;
  };
  const put = (object) => {
    if (!sel()) return;
    app.edit(() => insertObject(model(), app.editor.selection, object));
    app.done();
  };

  async function noteText(title, runs = []) {
    const confirmed = await app.showPanel(title, `<label class="stacked">Text of the note<textarea data-field="text" rows="5" data-enter-confirms>${escape(runsText(runs))}</textarea></label>`, 'Apply');
    return confirmed ? app.readFields().text.trim() : null;
  }

  async function insertNote(kind) {
    if (!sel()) return;
    const text = await noteText(kind === 'end' ? 'Endnote' : 'Footnote');
    if (text === null) return;
    put({ type: 'note', kind, runs: [{ text }] });
  }

  /** A footnote or endnote shown by a character of the person's choosing rather than a number, as LibreOffice's special notes. */
  async function insertSpecialNote() {
    if (!sel()) return;
    const confirmed = await app.showPanel('Footnote or endnote', `
      <fieldset><legend>Kind</legend>
        <label class="inline"><input type="radio" name="note-kind" data-field="kind" value="foot" checked> Footnote</label>
        <label class="inline"><input type="radio" name="note-kind" data-field="kind" value="end"> Endnote</label>
      </fieldset>
      <fieldset><legend>Numbering</legend>
        <label class="inline"><input type="radio" name="note-mark" data-field="numbering" value="auto" checked> Automatic</label>
        <label class="inline"><input type="radio" name="note-mark" data-field="numbering" value="mark"> Character</label>
        <input data-field="mark" maxlength="4" size="4" value="*" aria-label="Character">
      </fieldset>
      <label class="stacked">Text of the note<textarea data-field="text" rows="4"></textarea></label>`, 'Insert');
    if (!confirmed) return;
    const { kind, numbering, mark, text } = app.readFields();
    const own = numbering === 'mark' ? String(mark ?? '').trim().slice(0, 4) : '';
    put({ type: 'note', kind: kind === 'end' ? 'end' : 'foot', runs: [{ text: String(text ?? '').trim() }], ...(own ? { mark: own } : {}) });
  }

  const FORMAT_LABELS = { decimal: '1, 2, 3', 'lower-alpha': 'a, b, c', 'upper-alpha': 'A, B, C', 'lower-roman': 'i, ii, iii', 'upper-roman': 'I, II, III' };
  const formatOptions = (chosen, none = false) => [...(none ? [['', 'None']] : []), ...NUMBER_FORMATS.map((f) => [f, FORMAT_LABELS[f]])]
    .map(([v, l]) => `<option value="${v}"${v === chosen ? ' selected' : ''}>${escape(l)}</option>`).join('');

  /** How headings are numbered, as LibreOffice's chapter numbering. */
  async function headingNumbering() {
    const now = model().headingNumbers ?? { format: '', full: true, after: '', depth: 3 };
    const confirmed = await app.showPanel('Heading numbering', `
      <label class="stacked">Number<select data-field="format">${formatOptions(now.format, true)}</select></label>
      <label class="stacked">Levels numbered<select data-field="depth">${[1, 2, 3, 4].map((n) => `<option value="${n}"${n === now.depth ? ' selected' : ''}>Heading 1${n > 1 ? ` to ${n}` : ''}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" data-field="full"${now.full ? ' checked' : ''}> Show the levels above, as 1.2.3</label>
      <label class="stacked">After the number<input data-field="after" maxlength="5" value="${escape(now.after)}" placeholder="such as . or )"></label>`, 'Apply');
    if (!confirmed) return;
    const fields = app.readFields();
    app.edit(() => {
      model().headingNumbers = normaliseHeadingNumbers({ ...fields, depth: Number(fields.depth) });
      model().dirty = true;
      return app.editor.selection;
    });
    app.done();
  }

  /** How footnotes and endnotes count. */
  async function noteSettings() {
    const now = model().noteSettings;
    const part = (kind, label) => `<fieldset><legend>${label}</legend>
      <label class="stacked">Numbers<select data-field="${kind}Format">${formatOptions(now[kind].format)}</select></label>
      <label class="stacked">Start at<input type="number" min="1" max="9999" data-field="${kind}Start" value="${now[kind].start}"></label>
    </fieldset>`;
    const confirmed = await app.showPanel('Footnotes and endnotes', `${part('foot', 'Footnotes')}${part('end', 'Endnotes')}`, 'Apply');
    if (!confirmed) return;
    const f = app.readFields();
    app.edit(() => {
      model().noteSettings = normaliseNoteSettings({ foot: { format: f.footFormat, start: f.footStart }, end: { format: f.endFormat, start: f.endStart } });
      model().dirty = true;
      return app.editor.selection;
    });
    app.done();
  }

  /** Edits the note whose number was clicked. */
  async function editNote(holder) {
    const char = holder.querySelector('.object-char')?.firstChild;
    const at = char ? fromDom(app.editor.surface, { rangeCount: 1, anchorNode: char, anchorOffset: 0, focusNode: char, focusOffset: 0 })?.anchor : null;
    const object = at ? objectAt(model(), at) : null;
    if (object?.type !== 'note') return;
    const text = await noteText(object.kind === 'end' ? 'Endnote' : 'Footnote', object.runs);
    if (text === null) return;
    app.edit(() => {
      object.runs = [{ text }];
      return collapsed(point(at.blockId, at.offset + 1, at.itemIndex));
    });
    app.done();
  }

  async function insertBookmark() {
    if (!sel()) return;
    const confirmed = await app.showPanel('Bookmark', '<label class="stacked">Name<input data-field="name" placeholder="Results"></label>', 'Insert');
    const name = confirmed ? app.readFields().name.trim() : '';
    if (!name) return;
    if (documentFields(model()).bookmarks.has(name)) {
      app.toast(`There is already a bookmark called ${name}`);
      return;
    }
    put({ type: 'bookmark', name });
  }

  /** A reference to a heading, a caption or a bookmark, showing its words, its number or its page. */
  async function insertReference() {
    if (!sel()) return;
    const fields = documentFields(model());
    const targets = [
      ...fields.headings.map((h) => [`heading:${h.blockId}`, `Heading: ${h.text}`]),
      ...[...fields.seqs].map(([id, seq]) => [id, `${seq.name} ${seq.number}: ${seq.text.replace(OBJECT, '').slice(0, 60)}`]),
      ...[...fields.bookmarks.keys()].map((name) => [name, `Bookmark: ${name}`]),
    ];
    if (targets.length === 0) {
      app.toast('Nothing to refer to yet: add headings, captions or bookmarks first');
      return;
    }
    const confirmed = await app.showPanel('Cross-reference', `
      <label class="stacked">Refer to<select data-field="target">${targets.map(([v, l]) => `<option value="${escape(v)}">${escape(l)}</option>`).join('')}</select></label>
      <label class="stacked">Show<select data-field="show"><option value="number">Its name and number, or its heading</option><option value="text">Its text</option><option value="page">Its page</option></select></label>`, 'Insert');
    if (!confirmed) return;
    const f = app.readFields();
    put({ type: 'ref', target: f.target, show: f.show });
  }

  /** A numbered caption: on a picture its own, after a table a paragraph of its own. */
  async function insertCaption() {
    if (!sel()) return;
    const at = app.editor.selection.anchor;
    const block = model().block(at.blockId);
    const table = tableAt(model(), app.editor.selection)?.block;
    const kind = block?.kind === 'image' ? 'Figure' : table ? 'Table' : 'Figure';
    const confirmed = await app.showPanel('Caption', `
      <label class="stacked">Category<select data-field="name">${['Figure', 'Table', 'Illustration', 'Drawing', 'Text'].map((n) => `<option${n === kind ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="stacked">Caption<input data-field="text" placeholder="What it shows"></label>`, 'Insert');
    if (!confirmed) return;
    const f = app.readFields();
    const runs = [{ text: `${f.name} ` }, { text: OBJECT, object: { type: 'seq', name: f.name } }, ...(f.text ? [{ text: `: ${f.text}` }] : [])];
    app.edit(() => {
      if (block?.kind === 'image') {
        block.caption = runs;
        return app.editor.selection;
      }
      const anchor = table ?? block;
      const caption = { ...makeBlock('paragraph'), style: 'caption', runs };
      const index = model().indexOf(anchor.id) + 1;
      model().insertBlock(caption, index);
      return collapsed(point(caption.id, runsText(runs).length));
    });
    app.done();
  }

  function insertGenerated(kind) {
    if (!sel()) return;
    app.edit(() => insertBlockAt(model(), app.editor.selection, makeBlock(kind)));
    app.done();
  }

  async function insertIndexEntry() {
    if (!sel()) return;
    const { start, end } = { start: app.editor.selection.anchor, end: app.editor.selection.focus };
    const chosen = start.blockId === end.blockId && start.itemIndex === end.itemIndex
      ? runsText(model().runsOf(start.blockId, start.itemIndex)).slice(Math.min(start.offset, end.offset), Math.max(start.offset, end.offset)).replaceAll(OBJECT, '') : '';
    const confirmed = await app.showPanel('Index entry', `
      <label class="stacked">Entry<input data-field="term" value="${escape(chosen)}"></label>
      <label class="stacked">Under it, a second level<input data-field="sub"></label>`, 'Insert');
    if (!confirmed) return;
    const f = app.readFields();
    if (!f.term.trim()) return;
    // The entry marks the place after the selected words.
    app.editor.selection = collapsed(Math.max(start.offset, end.offset) === start.offset ? start : end);
    app.edit(() => insertObject(model(), app.editor.selection, { type: 'index', term: f.term.trim(), ...(f.sub.trim() ? { sub: f.sub.trim() } : {}) }));
    app.done();
  }

  async function insertLink() {
    if (!sel()) return;
    const fields = documentFields(model());
    const places = [...fields.headings.map((h) => [`#${h.blockId}`, `Heading: ${h.text}`]), ...[...fields.bookmarks.keys()].map((n) => [`#${n}`, `Bookmark: ${n}`])];
    const confirmed = await app.showPanel('Hyperlink', `
      <label class="stacked">Address, or a place in this document<input data-field="href" list="link-places" placeholder="https://… or #Results"></label>
      <datalist id="link-places">${places.map(([v, l]) => `<option value="${escape(v)}">${escape(l)}</option>`).join('')}</datalist>
      <p class="fp-note">GRT never opens a web address by itself; the link is kept in the document for whoever reads it.</p>`, 'Apply');
    if (!confirmed) return;
    const href = app.readFields().href.trim();
    app.edit(() => {
      const { anchor, focus } = app.editor.selection;
      if (anchor.blockId !== focus.blockId || anchor.itemIndex !== focus.itemIndex || anchor.offset === focus.offset) return app.editor.selection;
      const runs = model().runsOf(anchor.blockId, anchor.itemIndex);
      const from = Math.min(anchor.offset, focus.offset);
      const to = Math.max(anchor.offset, focus.offset);
      let seen = 0;
      const out = [];
      for (const run of runs) {
        const a = seen;
        const b = seen + run.text.length;
        seen = b;
        if (b <= from || a >= to || run.object) { out.push(run); continue; }
        if (a < from) out.push({ ...run, text: run.text.slice(0, from - a) });
        out.push({ ...run, text: run.text.slice(Math.max(0, from - a), Math.min(run.text.length, to - a)), link: href || undefined });
        if (b > to) out.push({ ...run, text: run.text.slice(to - a) });
      }
      model().setRuns(anchor.blockId, out, anchor.itemIndex);
      return app.editor.selection;
    });
    app.done();
  }

  /** The formula dialog every program shares. */
  const formulaText = (object = {}) => formulaDialog(object);

  async function insertFormula() {
    if (!sel()) return;
    const object = await formulaText();
    if (object) put(object);
  }

  /** Edits the formula that was clicked. */
  async function editFormula(holder) {
    const char = holder.querySelector('.object-char')?.firstChild;
    const at = char ? fromDom(app.editor.surface, { rangeCount: 1, anchorNode: char, anchorOffset: 0, focusNode: char, focusOffset: 0 })?.anchor : null;
    const object = at ? objectAt(model(), at) : null;
    if (object?.type !== 'math') return;
    const next = await formulaText(object);
    if (!next) return;
    app.edit(() => {
      Object.assign(object, next);
      if (!next.display) delete object.display;
      if (!next.mathml) delete object.mathml;
      return collapsed(point(at.blockId, at.offset + 1, at.itemIndex));
    });
    app.done();
  }

  return {
    insertFormula, editFormula,
    insertNote, insertSpecialNote, headingNumbering, noteSettings, editNote, insertBookmark, insertReference, insertCaption, insertIndexEntry, insertLink,
    insertToc: () => insertGenerated('toc'),
    insertIndex: () => insertGenerated('index'),
    insertField: (field) => put({ type: 'field', field }),
  };
}

/** Page numbers in what the layout knows: the contents, the index, references and page fields. */
export function fillPageNumbers(root, pageOfBlock, total) {
  for (const holder of root.querySelectorAll('[data-page-of]')) {
    const pages = [...new Set(holder.dataset.pageOf.split(' ').filter(Boolean).map((id) => pageOfBlock(id)).filter((n) => n !== null))].sort((a, b) => a - b);
    holder.textContent = pages.length ? pages.join(', ') : '?';
  }
  for (const field of root.querySelectorAll('.field-page')) {
    const id = field.closest('[data-block]')?.dataset.block;
    field.textContent = String((id && pageOfBlock(id)) ?? 1);
  }
  for (const field of root.querySelectorAll('.field-pages')) field.textContent = String(total);
}

/** Goes where a link of the document points, when it points inside it. */
export function followLink(surface, element) {
  const href = element.dataset.href ?? '';
  const goto = element.dataset.goto ?? (href.startsWith('#') ? href.slice(1) : null);
  if (!goto) return false;
  const target = surface.querySelector(`[data-block="${CSS.escape(goto)}"]`)
    ?? [...surface.querySelectorAll('.object-bookmark')].find((mark) => mark.dataset.name === goto);
  target?.scrollIntoView({ block: 'center' });
  return !!target;
}
