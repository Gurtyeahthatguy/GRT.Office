/** Edit, Track Changes and the comments in Paper: recording, going through changes, and a margin of comment threads. */

import {
  listChanges, settle, rejectButTrack, noteChange, listComments, addComment, replyTo, resolve, deleteOne, deleteThread,
  promote, deleteAllComments, containers,
} from './core/editor/review.js';
import { point, normalise, isCollapsed } from './core/editor/selection.js';
import { showPanel, showChoice, readFields, escapeHtml } from './core/panel.js';

/**
 * @param {{editor: Object, model: () => Object, edit: Function, settings: () => Object, saveSettings: Function,
 *   toast: Function, surface: HTMLElement, scroll: HTMLElement, sheet: HTMLElement, refresh: Function}} app
 */
export function reviewTools(app) {
  const model = () => app.model();
  let current = null;

  // Where things are, in reading order: a container's index and an offset in it.
  const order = () => containers(model());
  const indexOf = (blockId, itemIndex) => order().findIndex((c) => c.blockId === blockId && (c.itemIndex ?? null) === (itemIndex ?? null));
  const before = (a, b) => a.index < b.index || (a.index === b.index && a.offset < b.offset);
  const caret = () => {
    const at = app.editor.selection?.focus ?? app.editor.selection?.anchor;
    return at ? { index: indexOf(at.blockId, at.itemIndex), offset: at.offset } : { index: -1, offset: 0 };
  };

  function select(change) {
    app.editor.selection = { anchor: point(change.blockId, change.from, change.itemIndex), focus: point(change.blockId, change.to, change.itemIndex) };
    app.editor.draw();
    app.surface.focus();
    app.refresh();
  }

  /** The change the caret is in, or the first one the selection touches. */
  function changeHere() {
    const changes = listChanges(model());
    const sel = app.editor.selection;
    if (!sel) return null;
    if (!isCollapsed(sel)) {
      const { start, end } = normalise(sel, model());
      const a = { index: indexOf(start.blockId, start.itemIndex), offset: start.offset };
      const b = { index: indexOf(end.blockId, end.itemIndex), offset: end.offset };
      return changes.find((c) => {
        const from = { index: indexOf(c.blockId, c.itemIndex), offset: c.from };
        const to = { index: from.index, offset: c.to };
        return before(from, b) && before(a, to);
      }) ?? null;
    }
    const at = caret();
    return changes.find((c) => indexOf(c.blockId, c.itemIndex) === at.index && c.from <= at.offset && at.offset <= c.to) ?? null;
  }

  function step(direction) {
    const changes = listChanges(model());
    if (changes.length === 0) return app.toast('There are no recorded changes');
    const at = caret();
    const place = (c) => ({ index: indexOf(c.blockId, c.itemIndex), offset: c.from });
    const found = direction > 0
      ? changes.find((c) => before(at, place(c)) && !(place(c).index === at.index && c.from <= at.offset && at.offset <= c.to)) ?? changes[0]
      : [...changes].reverse().find((c) => before(place(c), at) && !(place(c).index === at.index && c.from <= at.offset && at.offset <= c.to)) ?? changes[changes.length - 1];
    select(found);
  }

  /** Accepts, rejects or rejects-and-records the change here, then goes on to the next when asked. */
  function act(how, { next = false } = {}) {
    const change = changeHere();
    if (!change) return app.toast('Put the caret in a recorded change first, or go to one with Next');
    app.edit(() => {
      const at = how === 'track' ? rejectButTrack(model(), change) : settle(model(), change, how === 'accept');
      return { anchor: at, focus: at };
    }, { read: false });
    if (next && listChanges(model()).length) step(1);
  }

  function all(how) {
    let count = 0;
    app.edit(() => {
      // From the end, so the places of the others hold.
      for (const change of listChanges(model()).reverse()) {
        if (how === 'track') rejectButTrack(model(), change);
        else settle(model(), change, how === 'accept');
        count += 1;
      }
      return app.editor.selection;
    }, { read: false });
    app.toast(count ? `${count} change(s) ${how === 'accept' ? 'accepted' : 'rejected'}` : 'There are no recorded changes');
  }

  // Recording, and the password that guards stopping it.

  const sha = async (text) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`GRT review\n${text}`)))));

  async function record() {
    const review = model().review;
    if (review.recording && review.protect) {
      const confirmed = await showPanel('Stop recording changes', `
        <div class="form-grid"><label for="rv-pass">Password</label><input id="rv-pass" type="password" data-field="password" /></div>
        <p class="hint">Recording was protected with a password.</p>`, 'Stop recording');
      if (!confirmed) return;
      if (await sha(readFields().password ?? '') !== review.protect) return app.toast('That is not the password');
    }
    model().review = { ...review, recording: !review.recording };
    model().dirty = true;
    app.toast(model().review.recording ? 'Recording changes' : 'Changes no longer recorded');
    app.refresh();
  }

  async function protect() {
    const review = model().review;
    const confirmed = await showPanel(review.protect ? 'Remove protection of recording' : 'Protect recording', `
      <div class="form-grid"><label for="rv-pass">Password</label><input id="rv-pass" type="password" data-field="password" /></div>
      <p class="hint">${review.protect ? 'Type the password to let recording be stopped freely again.' : 'Recording is turned on, and only this password can turn it off. The file keeps a hash of it, never the password.'}</p>`, 'OK');
    if (!confirmed) return;
    const password = readFields().password ?? '';
    if (!password) return app.toast('Type a password');
    if (review.protect) {
      if (await sha(password) !== review.protect) return app.toast('That is not the password');
      model().review = { ...review, protect: null };
    } else model().review = { recording: true, protect: await sha(password) };
    model().dirty = true;
    app.refresh();
  }

  function toggleView(key) {
    app.settings()[key] = app.settings()[key] === false;
    app.saveSettings();
    apply();
  }

  /** The views of review: changes shown or the text as it would be, comments and resolved ones shown or not. */
  function apply() {
    const s = app.settings();
    app.surface.classList.toggle('hide-changes', s.showChanges === false);
    app.surface.classList.toggle('hide-comments', s.showComments === false);
    app.surface.classList.toggle('hide-resolved', s.showResolved === false);
    drawMargin();
  }

  async function changeNote() {
    const change = changeHere();
    if (!change) return app.toast('Put the caret in a recorded change first');
    const confirmed = await showPanel('Comment on the change', `
      <textarea id="rv-note" data-field="note" rows="4" maxlength="10000" style="width: 100%; box-sizing: border-box">${escapeHtml(change.note ?? '')}</textarea>`, 'OK');
    if (!confirmed) return;
    app.edit(() => {
      noteChange(model(), change, String(readFields().note ?? '').trim());
      return app.editor.selection;
    }, { read: false });
  }

  async function manage() {
    for (;;) {
      const changes = listChanges(model());
      if (changes.length === 0) {
        app.toast('There are no recorded changes');
        return;
      }
      const rows = changes.map((c, i) => `<label class="change-row"><input type="radio" name="rv-pick" data-field="pick" value="${i}"${i === 0 ? ' checked' : ''} />
        <span class="change-kind">${c.kind === 'insert' ? 'Insertion' : 'Deletion'}</span> <span class="change-text">${escapeHtml(c.text.slice(0, 80))}</span>${c.note ? ` <em>${escapeHtml(c.note.slice(0, 60))}</em>` : ''}</label>`).join('');
      const answer = await showChoice('Manage changes', `<div class="change-list">${rows}</div><p class="hint">GRT records no names or dates with changes.</p>`, [
        { id: 'close', label: 'Close' }, { id: 'reject-all', label: 'Reject All' }, { id: 'accept-all', label: 'Accept All' },
        { id: 'reject', label: 'Reject' }, { id: 'accept', label: 'Accept', primary: true },
      ]);
      if (answer === 'close' || !answer) return;
      if (answer === 'accept-all' || answer === 'reject-all') {
        all(answer === 'accept-all' ? 'accept' : 'reject');
        return;
      }
      const picked = [...document.querySelectorAll('input[name="rv-pick"]')].find((r) => r.checked);
      const change = changes[Number(picked?.value ?? 0)];
      app.edit(() => {
        const at = settle(model(), change, answer === 'accept');
        return { anchor: at, focus: at };
      }, { read: false });
    }
  }

  // Comments

  /** The thread the caret is in or just after, or the one last chosen in the margin. */
  function commentHere() {
    const comments = listComments(model());
    if (current && comments.some((c) => c.id === current || c.replies?.some((r) => r.id === current))) return current;
    const at = app.editor.selection?.anchor;
    if (!at) return null;
    const runs = model().runsOf(at.blockId, at.itemIndex);
    let seen = 0;
    for (const run of runs) {
      const end = seen + run.text.length;
      if (run.cmt && seen <= at.offset && at.offset <= end) return run.cmt;
      seen = end;
    }
    const inHere = comments.filter((c) => c.blockId === at.blockId && (c.itemIndex ?? null) === (at.itemIndex ?? null) && c.offset <= at.offset);
    return inHere[inHere.length - 1]?.id ?? null;
  }

  async function ask(title, value = '') {
    const confirmed = await showPanel(title, `
      <textarea id="rv-comment" data-field="text" rows="5" maxlength="100000" style="width: 100%; box-sizing: border-box">${escapeHtml(value)}</textarea>
      <p class="hint">GRT keeps no name or date with a comment.</p>`, 'OK');
    if (!confirmed) return null;
    const text = String(readFields().text ?? '');
    return text.trim() ? text : null;
  }

  async function insert() {
    const selection = app.editor.selection;
    if (!selection) return app.toast('Put the caret in the text first');
    const text = await ask('Comment');
    if (!text) return;
    app.editor.selection = selection;
    app.edit(() => {
      current = addComment(model(), selection, text);
      return selection;
    }, { read: false });
    if (app.settings().showComments === false) toggleView('showComments');
  }

  const onThread = (fn, message = 'Put the caret in a comment, or choose one in the margin') => {
    const id = commentHere();
    if (!id) return app.toast(message);
    app.edit(() => {
      fn(id);
      return app.editor.selection;
    }, { read: false });
  };

  async function reply(id = commentHere()) {
    if (!id) return app.toast('Put the caret in a comment, or choose one in the margin');
    const text = await ask('Reply');
    if (text) app.edit(() => { replyTo(model(), id, text); return app.editor.selection; }, { read: false });
  }

  const isDone = (id) => {
    const thread = listComments(model()).find((c) => c.id === id || c.replies?.some((r) => r.id === id));
    return thread?.id === id ? !!thread.done : !!thread?.replies?.find((r) => r.id === id)?.done;
  };

  // The margin: one card a thread, beside the line its mark is on.

  let margin = null;
  let shown = '';
  function drawMargin() {
    if (!margin) {
      margin = document.createElement('aside');
      margin.id = 'comment-margin';
      margin.className = 'comment-margin';
      margin.setAttribute('aria-label', 'Comments');
      app.sheet.after(margin);
      margin.addEventListener('click', onMarginClick);
      // The caret stays in the text while the margin's buttons are pressed.
      margin.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
    }
    const s = app.settings();
    const threads = listComments(model()).filter((c) => s.showResolved !== false || !(c.done && (c.replies ?? []).every((r) => r.done)));
    margin.hidden = s.showComments === false || threads.length === 0;
    margin.style.fontSize = `${s.commentSize ?? 12}px`;
    // The page moves over to leave the margin room, as Writer's does.
    app.scroll.classList.toggle('with-comments', !margin.hidden);
    if (margin.hidden) return;
    const entry = (e, root) => `<div class="comment-entry${e.done ? ' done' : ''}${current === e.id ? ' current' : ''}" data-id="${escapeHtml(e.id)}">
        <div class="comment-text">${escapeHtml(e.text)}</div>
        <div class="comment-actions">
          ${root ? '<button type="button" data-act="reply">Reply</button>' : '<button type="button" data-act="promote">To root</button>'}
          <button type="button" data-act="resolve">${e.done ? 'Reopen' : 'Resolve'}</button>
          <button type="button" data-act="delete">Delete</button>
        </div></div>`;
    // Built again only when what it shows has changed, so a press on one of its buttons finds the button still there.
    const html = threads.map((t) => `<div class="comment-card" data-thread="${escapeHtml(t.id)}">${entry(t, true)}${(t.replies ?? []).map((r) => entry(r, false)).join('')}</div>`).join('');
    if (html !== shown) {
      margin.innerHTML = html;
      shown = html;
    }
    requestAnimationFrame(place);
  }

  /** Each card as near the line of its mark as the cards above it let it be. */
  function place() {
    if (!margin || margin.hidden) return;
    const sheet = app.sheet.getBoundingClientRect();
    const scroll = app.scroll.getBoundingClientRect();
    margin.style.left = `${sheet.right - scroll.left + app.scroll.scrollLeft + 16}px`;
    margin.style.top = `${sheet.top - scroll.top + app.scroll.scrollTop}px`;
    const top = sheet.top;
    let floor = 0;
    for (const card of margin.querySelectorAll('.comment-card')) {
      const anchor = app.surface.querySelector(`.object-comment[data-comment="${CSS.escape(card.dataset.thread)}"]`);
      const want = anchor ? anchor.getBoundingClientRect().top - top : floor;
      const y = Math.max(want, floor);
      card.style.top = `${y}px`;
      floor = y + card.offsetHeight + 8;
    }
  }

  function onMarginClick(event) {
    const entryNode = event.target.closest('.comment-entry');
    if (!entryNode) return;
    const id = entryNode.dataset.id;
    current = id;
    const act = event.target.closest('button')?.dataset.act;
    if (act === 'reply') reply(id);
    else if (act === 'resolve') app.edit(() => { resolve(model(), id, !isDone(id)); return app.editor.selection; }, { read: false });
    else if (act === 'delete') app.edit(() => { deleteOne(model(), id); return app.editor.selection; }, { read: false });
    else if (act === 'promote') app.edit(() => { promote(model(), id); return app.editor.selection; }, { read: false });
    else drawMargin();
  }

  async function formatAll() {
    const confirmed = await showPanel('Format all comments', `
      <div class="form-grid"><label for="rv-size">Size of the comments' text, in pixels</label>
      <input id="rv-size" type="number" min="8" max="32" data-field="size" value="${app.settings().commentSize ?? 12}" /></div>`, 'OK');
    if (!confirmed) return;
    const size = Number(readFields().size);
    if (size >= 8 && size <= 32) {
      app.settings().commentSize = size;
      app.saveSettings();
      drawMargin();
    }
  }

  return {
    record, protect, manage, changeNote, apply, drawMargin, place,
    recording: () => Boolean(model().review?.recording),
    showChanges: () => toggleView('showChanges'), changesShown: () => app.settings().showChanges !== false,
    showComments: () => toggleView('showComments'), commentsShown: () => app.settings().showComments !== false,
    showResolved: () => toggleView('showResolved'), resolvedShown: () => app.settings().showResolved !== false,
    previous: () => step(-1), next: () => step(1),
    accept: () => act('accept'), acceptNext: () => act('accept', { next: true }), acceptAll: () => all('accept'),
    reject: () => act('reject'), rejectNext: () => act('reject', { next: true }), rejectAll: () => all('reject'),
    rejectTrack: () => act('track'), rejectTrackNext: () => act('track', { next: true }), rejectTrackAll: () => all('track'),
    insertComment: insert, reply: () => reply(),
    resolve: () => onThread((id) => resolve(model(), id, !isDone(id))),
    resolveThread: () => onThread((id) => {
      const thread = listComments(model()).find((c) => c.id === id || c.replies?.some((r) => r.id === id));
      resolve(model(), thread.id, !thread.done, { thread: true });
    }),
    promote: () => onThread((id) => promote(model(), id), 'Choose a reply in the margin first'),
    deleteComment: () => onThread((id) => deleteOne(model(), id)),
    deleteThread: () => onThread((id) => deleteThread(model(), id)),
    deleteAll: () => app.edit(() => { deleteAllComments(model()); return app.editor.selection; }, { read: false }),
    formatAll,
  };
}
