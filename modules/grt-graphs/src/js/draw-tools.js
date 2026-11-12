/** Graphs' Draw commands: find and replace, links on nodes, special characters, comments on the page and the document's properties. */

import { createFindBar, searchPattern, findAll, replaceInText } from './core/find.js';
import { specialCharacter } from './core/special-chars.js';
import { FORMATTING_MARKS } from './core/text-case.js';
import { showPanel, showChoice, readFields, escapeHtml } from './core/panel.js';
import { showLink } from './core/honest-links.js';

/**
 * @param {{model: () => Object, selected: () => string[], select: (ids: string[]) => void, change: Function, toast: Function,
 *   reveal: (box: {x: number, y: number, w: number, h: number}) => void, centre: () => {x: number, y: number},
 *   editText: (id: string) => void, file: () => {name: string, location: string, format: string}, draw: Function}} app
 */
export function drawTools(app) {
  // Find and replace, over the text of nodes and the labels of lines.

  function matches(pattern) {
    const out = [];
    for (const node of app.model().nodes) for (const m of findAll(node.text, pattern)) out.push({ kind: 'node', id: node.id, ...m });
    for (const edge of app.model().edges) for (const m of findAll(edge.label, pattern)) out.push({ kind: 'edge', id: edge.id, ...m });
    return out;
  }

  function show(place) {
    app.select([place.id]);
    const model = app.model();
    if (place.kind === 'node') {
      const node = model.node(place.id);
      if (node) app.reveal(node);
    } else {
      const edge = model.edges.find((e) => e.id === place.id);
      const from = edge && model.node(edge.from);
      const to = edge && model.node(edge.to);
      if (from && to) app.reveal({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x) + to.w, h: Math.abs(to.y - from.y) + to.h });
    }
  }

  const bar = createFindBar({ matches, show, toast: app.toast });

  function replaceAll(query, replacement, options) {
    let pattern;
    try {
      pattern = searchPattern(query, options);
    } catch (error) {
      app.toast(error.message);
      return 0;
    }
    let count = 0;
    app.change(() => {
      const model = app.model();
      for (const node of model.nodes) {
        const done = replaceInText(node.text, pattern, replacement, options);
        if (done.count) {
          model.setText(node.id, done.text);
          count += done.count;
        }
      }
      for (const edge of model.edges) {
        const done = replaceInText(edge.label, pattern, replacement, options);
        if (done.count) {
          model.setEdgeLabel(edge.id, done.text);
          count += done.count;
        }
      }
      return count > 0;
    });
    return count;
  }

  async function findReplace() {
    const confirmed = await showPanel('Find and replace', `
      <div class="form-grid">
        <label for="fr-find">Find</label><input id="fr-find" type="text" data-field="find" maxlength="1000" />
        <label for="fr-replace">Replace with</label><input id="fr-replace" type="text" data-field="replace" maxlength="10000" />
      </div>
      <div class="setting"><span class="label">Match case</span><input type="checkbox" data-field="matchCase" /></div>
      <div class="setting"><span class="label">Whole words only</span><input type="checkbox" data-field="wholeWords" /></div>
      <div class="setting"><span class="label">Regular expressions</span><input type="checkbox" data-field="regex" /></div>
      <p class="fp-note">Replace All changes every node and line label in one step that Ctrl+Z takes back. To look first, use Find on the bar below.</p>`, 'Replace All');
    if (!confirmed) return;
    const f = readFields();
    if (!f.find) return;
    const count = replaceAll(f.find, f.replace ?? '', { matchCase: !!f.matchCase, wholeWords: !!f.wholeWords, regex: !!f.regex });
    app.toast(count > 0 ? `Replaced ${count} occurrence(s)` : 'Nothing matched');
  }

  // Links on nodes, shown before anything is done with them.

  async function hyperlink() {
    const ids = app.selected();
    if (ids.length === 0) return app.toast('Choose a node first');
    const first = app.model().node(ids[0]);
    const confirmed = await showPanel('Hyperlink', `
      <div class="form-grid">
        <label for="hl-href">URL</label><input id="hl-href" data-field="href" value="${escapeHtml(first?.link ?? '')}" placeholder="https://…" maxlength="2048" />
      </div>
      <p class="fp-note">An empty URL takes the link away. GRT opens no web page itself: Ctrl and a click on a node shows where its link goes.</p>`, 'OK');
    if (!confirmed) return;
    const href = String(readFields().href ?? '').trim();
    app.change(() => app.model().setLink(ids, href));
  }

  function followLink(id) {
    const node = app.model().node(id);
    if (node?.link) showLink(node.link, node.text, { toast: app.toast });
  }

  // Special characters and formatting marks go into the text being typed, or at the end of the one node chosen.

  function insertChars(text) {
    const input = document.getElementById('text-editor');
    if (input.classList.contains('hidden')) {
      const ids = app.selected();
      if (ids.length !== 1) return app.toast('Choose one node, or type in one, to put a character there');
      app.editText(ids[0]);
      input.setSelectionRange(input.value.length, input.value.length);
    }
    const from = input.selectionStart ?? input.value.length;
    const to = input.selectionEnd ?? from;
    input.value = input.value.slice(0, from) + text + input.value.slice(to);
    input.setSelectionRange(from + text.length, from + text.length);
    input.focus();
  }

  async function special() {
    const input = document.getElementById('text-editor');
    const typing = !input.classList.contains('hidden');
    const kept = typing ? { from: input.selectionStart, to: input.selectionEnd, id: input.dataset.node } : null;
    const text = await specialCharacter();
    if (!text) return;
    if (kept && !input.classList.contains('hidden')) input.setSelectionRange(kept.from, kept.to);
    else if (kept?.id) {
      // The dialog ended the typing; the character goes where the caret was, in the node's text as kept.
      const node = app.model().node(kept.id);
      if (node) {
        app.change(() => app.model().setText(node.id, node.text.slice(0, kept.from) + text + node.text.slice(kept.to)));
        return;
      }
    }
    insertChars(text);
  }

  // Comments on the page.

  async function comment(existing = null) {
    const confirmed = await showPanel(existing ? 'Edit comment' : 'Comment', `
      <textarea id="comment-text" data-field="text" rows="6" maxlength="100000" style="width: 100%; box-sizing: border-box">${escapeHtml(existing?.text ?? '')}</textarea>
      <p class="hint">GRT keeps no name or date with a comment. An empty comment is taken away.</p>`, 'OK');
    if (!confirmed) return;
    const text = String(readFields().text ?? '');
    if (existing) {
      app.change(() => app.model().setComment(existing.id, text));
      return;
    }
    if (text.trim() === '') return;
    // Beside the chosen node, or in the middle of the view.
    const node = app.selected().map((id) => app.model().node(id)).find(Boolean);
    const at = node ? { x: node.x + node.w + 8, y: node.y - 10 } : app.centre();
    app.change(() => app.model().addComment({ ...at, text }));
  }

  async function openComment(id) {
    const existing = app.model().comments.find((c) => c.id === id);
    if (!existing) return;
    const answer = await showChoice('Comment', `<p style="white-space: pre-wrap">${escapeHtml(existing.text)}</p>`, [
      { id: 'delete', label: 'Delete Comment' }, { id: 'close', label: 'Close' }, { id: 'edit', label: 'Edit', primary: true },
    ]);
    if (answer === 'edit') await comment(existing);
    if (answer === 'delete') app.change(() => app.model().deleteComment(existing.id));
  }

  // The document's properties: what it holds, counted; GRT writes no author or dates, so there are none to show.

  async function properties() {
    const model = app.model();
    const file = app.file();
    const rows = [
      ['Name', file.name], ['Location', file.location], ['Format', file.format.toUpperCase()],
      ['Nodes', model.nodes.length], ['Lines', model.edges.length], ['Comments', model.comments.length],
      ['Nodes with links', model.nodes.filter((n) => n.link).length],
    ];
    await showChoice('Properties', `<div class="form-grid">${rows.map(([k, v]) => `<span class="label">${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span>`).join('')}</div>
      <p class="hint">GRT writes no author, dates or editing time into the file.</p>`, [{ id: 'ok', label: 'Close', primary: true }]);
  }

  return { bar, findReplace, replaceAll, matches, show, hyperlink, followLink, insertChars, special, comment, openComment, properties, marks: FORMATTING_MARKS };
}
