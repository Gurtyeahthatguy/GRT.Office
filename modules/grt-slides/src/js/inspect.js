/** The document inspector for Slides: what a presentation carries besides what shows, and a clean copy without it. */

import { redactedPresentation, redactedCount } from './redact.js';

/** Whether an element lies wholly outside the slide, where no one sees it in the show. */
const offSlide = (element, canvas) => element.x + element.w <= 0 || element.y + element.h <= 0 || element.x >= canvas.w || element.y >= canvas.h;

export function slideFindings(model) {
  const elements = model.slides.flatMap((s) => s.elements ?? []);
  const links = elements.flatMap((e) => (e.content ?? []).filter((r) => r.link && !r.link.startsWith('#')));
  return [
    { id: 'notes', label: 'Speaker notes', count: model.slides.filter((s) => (s.notes ?? '').trim()).length },
    { id: 'comments', label: 'Comments', count: model.slides.reduce((n, s) => n + (s.comments?.length ?? 0), 0) },
    { id: 'hidden', label: 'Hidden slides', count: model.slides.filter((s) => s.hidden).length },
    { id: 'offslide', label: 'Objects outside the slide', count: elements.filter((e) => offSlide(e, model.canvas)).length },
    { id: 'links', label: 'Links to web addresses', count: links.length, keep: true },
    { id: 'redact', label: 'Text and cells marked to be covered', count: redactedCount(model) },
  ];
}

/** The presentation without what was chosen. */
export function cleanSlidesCopy(model, out) {
  let copy = out.includes('redact') ? redactedPresentation(model.toJSON()) : model.toJSON();
  copy = structuredClone(copy);
  if (out.includes('hidden')) {
    const shown = copy.slides.filter((s) => !s.hidden);
    copy.slides = shown.length ? shown : copy.slides.slice(0, 1).map((s) => ({ ...s, hidden: false, elements: [] }));
  }
  for (const slide of copy.slides) {
    if (out.includes('notes')) slide.notes = '';
    if (out.includes('comments')) delete slide.comments;
    if (out.includes('offslide')) slide.elements = (slide.elements ?? []).filter((e) => !offSlide(e, copy.canvas ?? model.canvas));
    if (out.includes('links')) {
      for (const element of slide.elements ?? []) {
        if (element.content) element.content = element.content.map((run) => {
          if (!run.link || run.link.startsWith('#')) return run;
          const { link: _l, ...rest } = run;
          return rest;
        });
      }
    }
  }
  return copy;
}
