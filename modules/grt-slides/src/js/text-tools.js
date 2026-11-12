/** Format, Text and Paragraph in Slides: on the selected text while a box is edited, on whole boxes otherwise. */

import { changeCase, stepSize, FORMATTING_MARKS } from './core/text-case.js';
import { specialCharacter } from './core/special-chars.js';
import { showPanel, readFields, escapeHtml } from './core/panel.js';
import { MARKS } from './core/editor/model.js';
import {
  editMarkup, readEdit, offsetIn, selectIn, formatPart, mapPart, paragraphsIn, parasFor, setList, shiftLevel, moveParagraphs,
} from './paragraphs.js';

/**
 * @param {{model: () => Object, slideId: () => string, editing: () => ?{node: HTMLElement, id: string},
 *   chosen: () => Object[], change: Function, toast: Function, baseSize: (element: Object) => number}} app
 */
export function textTools(app) {
  const model = () => app.model();

  /** The selection in the edited box when the pointer reached the menus, which a click there may collapse. */
  let remembered = null;

  function remember() {
    remembered = null;
    const at = liveRange();
    if (at) remembered = at;
  }

  /** The range of the edited box's text the selection covers, or null; what was remembered comes first, once. */
  function editRange() {
    const kept = remembered;
    remembered = null;
    if (kept && app.editing()?.node === kept.edit.node) return kept;
    return liveRange();
  }

  function liveRange() {
    const edit = app.editing();
    if (!edit) return null;
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!edit.node.contains(range.startContainer)) return null;
    return { edit, from: offsetIn(edit.node, range.startContainer, range.startOffset), to: offsetIn(edit.node, range.endContainer, range.endOffset) };
  }

  /** Changes the edited box in place, its selection kept; `op` gets {content, paras} and the range. */
  function inEdit(op) {
    const at = editRange();
    if (!at) return false;
    const element = model().element(app.slideId(), at.edit.id);
    const value = readEdit(at.edit.node);
    const next = op(value, at.from, at.to, element);
    if (!next) return true;
    at.edit.node.innerHTML = editMarkup({ ...element, content: next.content, paras: next.paras });
    selectIn(at.edit.node, next.from ?? at.from, next.to ?? at.to);
    return true;
  }

  /** Changes every chosen text box whole. */
  function onBoxes(op) {
    const boxes = app.chosen().filter((e) => e.kind === 'text');
    if (boxes.length === 0) {
      app.toast('Choose a text box, or select text in one');
      return;
    }
    app.change(() => {
      for (const element of boxes) {
        const length = element.content.map((r) => r.text).join('').length;
        const next = op({ content: element.content, paras: parasFor(element) }, 0, length, element);
        if (next) model().setContent(app.slideId(), element.id, next.content, next.paras);
      }
    });
  }

  const apply = (op) => { if (!inEdit(op)) onBoxes(op); };

  /**
   * Runs a change on a range taken before a dialog: in the box if it is still being edited,
   * otherwise on the text the edit left in the slide, at the same places.
   */
  function onRange(at, op) {
    const live = app.editing();
    if (live && live.node === at.edit.node && live.node.isConnected && live.node.isContentEditable) {
      live.node.focus();
      selectIn(live.node, at.from, at.to);
      apply(op);
      return;
    }
    const element = model().element(app.slideId(), at.edit.id);
    if (!element || element.kind !== 'text') return;
    app.change(() => {
      const next = op({ content: element.content, paras: parasFor(element) }, at.from, at.to, element);
      if (!next) return false;
      model().setContent(app.slideId(), element.id, next.content, next.paras);
      return true;
    });
  }

  function mark(name, value = null) {
    apply((v, from, to) => {
      if (from === to) return null;
      // Single and double underline are one choice; superscript and subscript too.
      let content = v.content;
      const on = value ?? !hasMark(content, from, to, name);
      if (name === 'double' && on) content = formatPart(content, from, to, 'underline', false);
      if (name === 'underline' && on) content = formatPart(content, from, to, 'double', false);
      if (name === 'sup' && on) content = formatPart(content, from, to, 'sub', false);
      if (name === 'sub' && on) content = formatPart(content, from, to, 'sup', false);
      return { ...v, content: formatPart(content, from, to, name, on) };
    });
  }

  function hasMark(content, from, to, name) {
    let at = 0;
    for (const run of content) {
      const end = at + run.text.length;
      if (end > from && at < to && run.text.trim() !== '' && !run[name]) return false;
      at = end;
    }
    return true;
  }

  function textCase(mode) {
    apply((v, from, to) => {
      if (from === to) return null;
      const text = v.content.map((r) => r.text).join('').slice(from, to);
      const whole = changeCase(text, mode);
      let content;
      if (whole.length === text.length) {
        let at = 0;
        content = mapPart(v.content, from, to, (runs) => runs.map((run) => {
          const piece = whole.slice(at, at + run.text.length);
          at += run.text.length;
          return { ...run, text: piece };
        }));
      } else content = mapPart(v.content, from, to, (runs) => runs.map((run) => ({ ...run, text: changeCase(run.text, mode) })));
      return { ...v, content, to: from + content.map((r) => r.text).join('').length - (v.content.map((r) => r.text).join('').length - to) };
    });
  }

  function resize(direction) {
    apply((v, from, to, element) => {
      if (from === to) return null;
      const base = app.baseSize(element);
      return { ...v, content: mapPart(v.content, from, to, (runs) => runs.map((run) => ({ ...run, size: stepSize(run.size ?? base, direction) }))) };
    });
  }

  function clearDirect() {
    apply((v, from, to) => {
      if (from === to) return null;
      return { ...v, content: mapPart(v.content, from, to, (runs) => runs.map((run) => ({ text: run.text, ...(run.link ? { link: run.link } : {}) }))) };
    });
  }

  /** Lists, levels and moves work on whole paragraphs: those the selection touches, or all of a box. */
  const paragraphs = (op) => apply((v, from, to, element) => {
    const [first, last] = paragraphsIn(v.content, from, to);
    return op({ ...element, content: v.content, paras: v.paras }, first, last);
  });

  const list = (type) => paragraphs((element, first, last) => ({ content: element.content, paras: setList(element, type === 'none' ? null : type, first, last) }));
  const level = (by) => paragraphs((element, first, last) => ({ content: element.content, paras: shiftLevel(element, by, first, last) }));
  const move = (by) => paragraphs((element, first, last) => moveParagraphs(element, by, first, last));

  /** Box-wide spacing: line height in times, space and indent steps as Impress's (0.1 cm, 1.25 cm at 96 ppi). */
  function spacing(patch) {
    const boxes = app.editing() ? [model().element(app.slideId(), app.editing().id)] : app.chosen().filter((e) => e.kind === 'text');
    if (boxes.length === 0 || !boxes[0]) return app.toast('Choose a text box first');
    if (app.editing()) app.editing().finish(true);
    app.change(() => {
      for (const element of boxes) model().setSpacing(app.slideId(), element.id, typeof patch === 'function' ? patch(element) : patch);
    });
  }
  const lineSpacing = (times) => spacing({ lineHeight: times });
  const paragraphSpacing = (sign) => spacing((e) => ({ spaceBefore: Math.max(0, (e.spaceBefore ?? 0) + sign * 3.78), spaceAfter: Math.max(0, (e.spaceAfter ?? 0) + sign * 3.78) }));
  const indent = (sign) => level(sign);

  function insertChars(text) {
    if (!editRange()) return app.toast('Click into a text box to type there');
    document.execCommand('insertText', false, text);
  }

  async function special() {
    const at = editRange();
    if (!at) return app.toast('Click into a text box to type there');
    const text = await specialCharacter();
    if (!text) return;
    onRange(at, (v, from, to) => ({ ...v, content: mapPart(v.content, from, to, (runs) => [{ ...(runs[0] ?? {}), text }]), from: from + text.length, to: from + text.length }));
  }

  async function characterDialog() {
    const at = editRange();
    const element = at ? model().element(app.slideId(), at.edit.id) : app.chosen().find((e) => e.kind === 'text');
    if (!element) return app.toast('Choose a text box, or select text in one');
    const content = at ? readEdit(at.edit.node).content : element.content;
    let seen = 0;
    const run = content.find((r) => { seen += r.text.length; return seen > (at?.from ?? 0); }) ?? content[0] ?? {};
    const check = (field, label) => `<div class="setting"><span class="label">${label}</span><input type="checkbox" data-field="${field}"${run[field] ? ' checked' : ''} /></div>`;
    const confirmed = await showPanel('Character', `
      <div class="form-grid">
        <label for="sc-size">Size, in pixels of the slide</label>
        <input id="sc-size" type="number" min="4" max="999" data-field="size" value="${run.size ?? app.baseSize(element)}" />
        <label for="sc-colour">Font colour</label>
        <input id="sc-colour" type="color" data-field="color" value="${escapeHtml(run.color ?? '#333333')}" />
      </div>
      ${['bold', 'italic', 'underline', 'double', 'overline', 'strike', 'shadow', 'outline', 'smallcaps', 'sup', 'sub'].map((m) => check(m, {
        bold: 'Bold', italic: 'Italic', underline: 'Single underline', double: 'Double underline', overline: 'Overline', strike: 'Strikethrough',
        shadow: 'Shadow', outline: 'Outline', smallcaps: 'Small capitals', sup: 'Superscript', sub: 'Subscript' }[m])).join('')}`, 'OK');
    if (!confirmed) return;
    const f = readFields();
    const set = (v, from, to) => {
      let next = v.content;
      for (const m of MARKS) if (m in f) next = formatPart(next, from, to, m, !!f[m]);
      if (Number(f.size) > 0) next = formatPart(next, from, to, 'size', Number(f.size));
      next = formatPart(next, from, to, 'color', f.color);
      return { ...v, content: next };
    };
    if (at) onRange(at, set);
    else apply(set);
  }

  /** Puts a link on the chosen text, changes the one there, or types a new linked text at the caret. */
  async function hyperlink() {
    const at = editRange();
    const element = at ? model().element(app.slideId(), at.edit.id) : app.chosen().find((e) => e.kind === 'text');
    if (!element) return app.toast('Choose a text box, or select text in one');
    const content = at ? readEdit(at.edit.node).content : element.content;
    let seen = 0;
    const run = content.find((r) => { seen += r.text.length; return seen > (at?.from ?? 0); }) ?? {};
    const typing = at && at.from === at.to;
    const confirmed = await showPanel('Hyperlink', `
      <div class="form-grid">
        <label for="hl-href">URL</label>
        <input id="hl-href" data-field="href" value="${escapeHtml(run.link ?? '')}" placeholder="https://…" maxlength="2048" />
        ${typing ? '<label for="hl-text">Text</label><input id="hl-text" data-field="text" placeholder="the address, if left empty" />' : ''}
      </div>
      <p class="fp-note">An empty URL takes the link away. GRT opens no web page itself: Ctrl and a click on a link shows where it goes.</p>`, 'OK');
    if (!confirmed) return;
    const f = readFields();
    const href = String(f.href ?? '').trim();
    const put = (v, from, to) => {
      if (from === to) {
        if (!href) return null;
        const text = String(f.text ?? '').trim() || href;
        const next = mapPart(v.content, from, from, () => [{ ...run, text, link: href }]);
        return { ...v, content: next, from, to: from + text.length };
      }
      return { ...v, content: formatPart(v.content, from, to, 'link', href) };
    };
    if (at) onRange(at, put);
    else apply(put);
  }

  async function paragraphDialog() {
    const element = app.editing() ? model().element(app.slideId(), app.editing().id) : app.chosen().find((e) => e.kind === 'text');
    if (!element) return app.toast('Choose a text box first');
    const confirmed = await showPanel('Paragraph', `
      <div class="form-grid">
        <label for="sp-line">Line spacing, times</label><input id="sp-line" type="number" min="0.5" max="10" step="0.05" data-field="lineHeight" value="${element.lineHeight ?? 1}" />
        <label for="sp-above">Above paragraph, px</label><input id="sp-above" type="number" min="0" step="1" data-field="spaceBefore" value="${element.spaceBefore ?? 0}" />
        <label for="sp-below">Below paragraph, px</label><input id="sp-below" type="number" min="0" step="1" data-field="spaceAfter" value="${element.spaceAfter ?? 0}" />
        <label for="sp-indent">Indent of each level, px</label><input id="sp-indent" type="number" min="0" step="1" data-field="indent" value="${element.indent ?? 36}" />
      </div>`, 'OK');
    if (!confirmed) return;
    const f = readFields();
    spacing({ lineHeight: Number(f.lineHeight), spaceBefore: Number(f.spaceBefore), spaceAfter: Number(f.spaceAfter), indent: Number(f.indent) });
  }

  /** What a button's state is read from: the edited box's selection, or each chosen text box whole. */
  function stateSources() {
    const at = liveRange();
    if (at) return [{ v: readEdit(at.edit.node), from: at.from, to: at.to }];
    return app.chosen().filter((e) => e.kind === 'text')
      .map((e) => ({ v: { content: e.content, paras: parasFor(e) }, from: 0, to: e.content.map((r) => r.text).join('').length }));
  }

  /** The run the caret writes into: the one before it, or the first. */
  function runAt(content, offset) {
    let at = 0;
    for (const run of content) {
      at += run.text.length;
      if (at >= offset && run.text !== '\n') return run;
    }
    return content[0];
  }

  /** Whether a mark is on where the person works, as LibreOffice lights its buttons. */
  function markOn(name) {
    const sources = stateSources();
    return sources.length > 0 && sources.every(({ v, from, to }) => {
      if (from === to) return Boolean(runAt(v.content, from)?.[name]);
      return v.content.some((r) => r.text.trim() !== '') && hasMark(v.content, from, to, name);
    });
  }

  /** Whether every paragraph touched is a list of this kind. */
  function listOn(type) {
    const sources = stateSources();
    return sources.length > 0 && sources.every(({ v, from, to }) => {
      const [first, last] = paragraphsIn(v.content, from, to);
      return v.paras.slice(first, last + 1).every((p) => p.list === type);
    });
  }

  return {
    mark, markOn, listOn, textCase, resize, clearDirect, list, level, move, lineSpacing, paragraphSpacing, indent,
    insertChars, special, characterDialog, paragraphDialog, hyperlink, remember, marks: FORMATTING_MARKS,
  };
}
