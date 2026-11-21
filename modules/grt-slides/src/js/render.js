/** Model to DOM. */

import { elementMarkup, backgroundCss } from './export.js';

export class Renderer {
  /**
   * @param {HTMLElement} stage fills the available space
   * @param {HTMLElement} surface the slide itself, scaled inside the stage
   */
  constructor(stage, surface) {
    this.stage = stage;
    this.surface = surface;
    this.scale = 1;
  }

  /** Fits the slide into the stage, leaving a margin. */
  fit(model) {
    const box = this.stage.getBoundingClientRect();
    const available = { w: box.width - 48, h: box.height - 48 };
    this.scale = Math.max(
      Math.min(available.w / model.canvas.w, available.h / model.canvas.h),
      0.05,
    );
    this.apply(model);
  }

  apply(model, slideId = null, images = this.images ?? new Map()) {
    this.surface.style.width = `${model.canvas.w}px`;
    this.surface.style.height = `${model.canvas.h}px`;
    this.surface.style.transform = `scale(${this.scale})`;
    this.surface.style.background = backgroundCss(model, slideId, images);
  }

  /** Screen coordinates to slide coordinates. */
  toSlide(clientX, clientY) {
    const box = this.surface.getBoundingClientRect();
    return {
      x: (clientX - box.left) / this.scale,
      y: (clientY - box.top) / this.scale,
    };
  }

  /** Redraws a slide. */
  draw(model, slideId, selection = new Set(), extras = {}, images = new Map()) {
    this.images = images;
    this.apply(model, slideId, images);

    const list = model.renderList(slideId);
    const nodes = list.map((element) => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = elementMarkup(element, model, images, list);

      const node = wrapper.firstElementChild;
      if (!node) return null;

      // Master elements are shown but not editable from the slide, so
      // they carry no id and the pointer passes straight through them.
      if (element.fromMaster) {
        node.classList.add('from-master');
        node.style.pointerEvents = 'none';
      } else {
        node.dataset.id = element.id;
        if (selection.has(element.id)) node.classList.add('selected');
      }

      return node;
    }).filter(Boolean);

    // Handles and guides go above everything, in their own layer, so a
    // selected element behind another one is still resizable.
    const overlay = document.createElement('div');
    overlay.className = 'overlay-layer draw-overlay';
    overlay.append(...overlayNodes(model, slideId, selection, extras));
    nodes.push(overlay);

    this.surface.replaceChildren(...nodes);
  }
}

/** What goes over the slide: comment marks, then the drawing layer's handles, guides and previews. */
function overlayNodes(model, slideId, selection, extras) {
  const nodes = [];
  const slide = model.slide(slideId);
  if (!slide) return nodes;

  // Comment marks, their text as the tip under the pointer; never shown in the slide show or in what is exported.
  if (!extras.hideComments) {
    for (const comment of slide.comments ?? []) {
      const mark = document.createElement('div');
      mark.className = 'comment-mark';
      mark.dataset.comment = comment.id;
      mark.title = comment.text;
      Object.assign(mark.style, { left: `${comment.x}px`, top: `${comment.y}px` });
      nodes.push(mark);
    }
  }
  nodes.push(...(extras.overlay ?? []));
  return nodes;
}
