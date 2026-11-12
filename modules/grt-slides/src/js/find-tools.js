/** Find and replace in a presentation: text boxes, table cells and speaker notes, slide after slide. */

import { createFindBar, searchPattern, findAll, replaceInRuns, replaceInText } from './core/find.js';
import { showPanel, readFields } from './core/panel.js';

/** A range over the text of a drawn box or cell, offsets counted as the model counts them. */
function rangeIn(root, from, to) {
  const blocks = root.matches('td') ? [root] : [...root.children].filter((child) => child.nodeName === 'DIV');
  const stops = [];
  let total = 0;
  blocks.forEach((block, b) => {
    if (b > 0) total += 1;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => (node.nodeType === 1 && node.classList?.contains('para-label') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1) {
        if (node.nodeName === 'BR') total += 1;
        continue;
      }
      const length = node.nodeValue === '​' ? 0 : node.nodeValue.length;
      stops.push({ node, from: total, to: total + length });
      total += length;
    }
  });
  const place = (offset) => {
    const stop = stops.find((s) => offset >= s.from && offset <= s.to) ?? stops[stops.length - 1];
    return stop ? [stop.node, Math.max(0, Math.min(offset - stop.from, stop.node.nodeValue.length))] : null;
  };
  const start = place(from);
  const end = place(to);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
}

/**
 * @param {{model: () => Object, slideId: () => string, goTo: (slideId: string) => void, select: (ids: string[]) => void,
 *   surface: HTMLElement, change: Function, toast: Function, chooseCell: (id: string, row: number, col: number) => void}} app
 */
export function findTools(app) {
  const textOf = (element) => (element.content ?? []).map((r) => r.text).join('');

  /** Every match in the presentation, slide by slide: boxes, then cells, then the notes. */
  function matches(pattern) {
    const out = [];
    for (const slide of app.model().slides) {
      for (const element of slide.elements ?? []) {
        if (element.kind === 'text') {
          for (const m of findAll(textOf(element), pattern)) out.push({ slideId: slide.id, id: element.id, kind: 'text', ...m });
        } else if (element.kind === 'table') {
          element.cells.forEach((row, r) => row.forEach((cell, c) => {
            for (const m of findAll(cell, pattern)) out.push({ slideId: slide.id, id: element.id, kind: 'cell', row: r, col: c, ...m });
          }));
        }
      }
      for (const m of findAll(slide.notes ?? '', pattern)) out.push({ slideId: slide.id, kind: 'notes', ...m });
    }
    return out;
  }

  /** Goes to a match and marks it, leaving the keyboard with the find bar. */
  function show(place) {
    if (place.slideId !== app.slideId()) app.goTo(place.slideId);
    globalThis.CSS?.highlights?.delete('grt-find');
    if (place.kind === 'notes') {
      const notes = document.getElementById('notes');
      notes.setSelectionRange(place.from, place.to);
      notes.scrollTop = Math.max(0, notes.scrollHeight * (place.from / Math.max(1, notes.value.length)) - 20);
      return;
    }
    app.select([place.id]);
    if (place.kind === 'cell') app.chooseCell(place.id, place.row, place.col);
    const box = app.surface.querySelector(`[data-id="${CSS.escape(place.id)}"]`);
    const root = place.kind === 'cell' ? box?.querySelector(`td[data-row="${place.row}"][data-col="${place.col}"]`) : (box?.querySelector(':scope > .text-body') ?? box);
    const range = root ? rangeIn(root, place.from, place.to) : null;
    if (range && globalThis.Highlight && globalThis.CSS?.highlights) CSS.highlights.set('grt-find', new Highlight(range));
  }

  const bar = createFindBar({ matches, show, toast: app.toast });

  /** Replaces every match in the presentation as one step to undo. */
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
      for (const slide of model.slides) {
        for (const element of slide.elements ?? []) {
          if (element.kind === 'text') {
            const done = replaceInRuns(element.content ?? [], pattern, replacement, options);
            if (done.count) {
              model.setContent(slide.id, element.id, done.runs, element.paras ?? null);
              count += done.count;
            }
          } else if (element.kind === 'table') {
            element.cells.forEach((row, r) => row.forEach((cell, c) => {
              const done = replaceInText(cell, pattern, replacement, options);
              if (done.count) {
                model.setCell(slide.id, element.id, r, c, done.text);
                count += done.count;
              }
            }));
          }
        }
        const notes = replaceInText(slide.notes ?? '', pattern, replacement, options);
        if (notes.count) {
          model.setNotes(slide.id, notes.text);
          count += notes.count;
        }
      }
      return count > 0;
    });
    return count;
  }

  async function dialog() {
    const confirmed = await showPanel('Find and replace', `
      <div class="form-grid">
        <label for="fr-find">Find</label><input id="fr-find" type="text" data-field="find" maxlength="1000" />
        <label for="fr-replace">Replace with</label><input id="fr-replace" type="text" data-field="replace" maxlength="10000" />
      </div>
      <div class="setting"><span class="label">Match case</span><input type="checkbox" data-field="matchCase" /></div>
      <div class="setting"><span class="label">Whole words only</span><input type="checkbox" data-field="wholeWords" /></div>
      <div class="setting"><span class="label">Regular expressions</span><input type="checkbox" data-field="regex" /></div>
      <p class="fp-note">Replace All changes every slide, table and note in one step that Ctrl+Z takes back. To look first, use Find on the bar below, which steps through the matches.</p>`, 'Replace All');
    if (!confirmed) return;
    const f = readFields();
    if (!f.find) return;
    const count = replaceAll(f.find, f.replace ?? '', { matchCase: !!f.matchCase, wholeWords: !!f.wholeWords, regex: !!f.regex });
    app.toast(count > 0 ? `Replaced ${count} occurrence(s)` : 'Nothing matched');
  }

  return { bar, dialog, matches, replaceAll, show, open: (query) => bar.open(query) };
}
