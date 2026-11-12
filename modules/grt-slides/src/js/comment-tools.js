/** Comments on slides, and the presentation's properties. */

import { showPanel, showChoice, readFields, escapeHtml } from './core/panel.js';

/**
 * @param {{model: () => Object, slideId: () => string, chosen: () => Object[], change: Function,
 *   file: () => {name: string, location: string, format: string}}} app
 */
export function commentTools(app) {
  async function comment(existing = null) {
    const confirmed = await showPanel(existing ? 'Edit comment' : 'Comment', `
      <textarea id="comment-text" data-field="text" rows="6" maxlength="100000" style="width: 100%; box-sizing: border-box">${escapeHtml(existing?.text ?? '')}</textarea>
      <p class="hint">GRT keeps no name or date with a comment. An empty comment is taken away. Comments never show in the slide show or in what is exported.</p>`, 'OK');
    if (!confirmed) return;
    const text = String(readFields().text ?? '');
    const slideId = app.slideId();
    if (existing) {
      app.change(() => app.model().setComment(slideId, existing.id, text));
      return;
    }
    if (text.trim() === '') return;
    // Beside the chosen element, or at the top left of the slide.
    const element = app.chosen()[0];
    const at = element ? { x: element.x + element.w + 12, y: element.y } : { x: 40, y: 40 };
    app.change(() => app.model().addComment(slideId, { ...at, text }));
  }

  async function open(id) {
    const slideId = app.slideId();
    const existing = app.model().slide(slideId)?.comments?.find((c) => c.id === id);
    if (!existing) return;
    const answer = await showChoice('Comment', `<p style="white-space: pre-wrap">${escapeHtml(existing.text)}</p>`, [
      { id: 'delete', label: 'Delete Comment' }, { id: 'close', label: 'Close' }, { id: 'edit', label: 'Edit', primary: true },
    ]);
    if (answer === 'edit') await comment(existing);
    if (answer === 'delete') app.change(() => app.model().deleteComment(slideId, existing.id));
  }

  /** What the presentation holds, counted; GRT writes no author or dates, so there are none to show. */
  async function properties() {
    const model = app.model();
    const file = app.file();
    const elements = model.slides.flatMap((s) => s.elements ?? []);
    const words = elements.filter((e) => e.kind === 'text').map((e) => (e.content ?? []).map((r) => r.text).join(''))
      .concat(elements.filter((e) => e.kind === 'table').flatMap((e) => e.cells.flat()))
      .join(' ').split(/\s+/).filter(Boolean).length;
    const rows = [
      ['Name', file.name], ['Location', file.location], ['Format', file.format.toUpperCase()],
      ['Slides', model.slides.length], ['Hidden slides', model.slides.filter((s) => s.hidden).length],
      ['Objects', elements.length], ['Words', words],
      ['Slides with notes', model.slides.filter((s) => (s.notes ?? '').trim() !== '').length],
      ['Comments', model.slides.reduce((sum, s) => sum + (s.comments?.length ?? 0), 0)],
    ];
    await showChoice('Properties', `<div class="form-grid">${rows.map(([k, v]) => `<span class="label">${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span>`).join('')}</div>
      <p class="hint">GRT writes no author, dates or editing time into the file.</p>`, [{ id: 'ok', label: 'Close', primary: true }]);
  }

  return { comment, open, properties };
}
