/** Model to DOM. */

import { elementMarkup } from './export.js';

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

  apply(model, slideId = null) {
    this.surface.style.width = `${model.canvas.w}px`;
    this.surface.style.height = `${model.canvas.h}px`;
    this.surface.style.transform = `scale(${this.scale})`;
    this.surface.style.background = model.slideBackground(slideId);
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
    this.apply(model, slideId);

    const nodes = model.renderList(slideId).map((element) => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = elementMarkup(element, model, images);

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
    overlay.className = 'overlay-layer';
    overlay.append(...overlayNodes(model, slideId, selection, extras));
    nodes.push(overlay);

    this.surface.replaceChildren(...nodes);
  }
}

const HANDLES = ['nw', 'ne', 'sw', 'se'];

function overlayNodes(model, slideId, selection, extras) {
  const nodes = [];
  const slide = model.slide(slideId);
  if (!slide) return nodes;

  for (const element of slide.elements) {
    if (!selection.has(element.id)) continue;

    const frame = document.createElement('div');
    frame.className = 'sel-frame';
    Object.assign(frame.style, {
      left: `${element.x}px`,
      top: `${element.y}px`,
      width: `${element.w}px`,
      height: `${element.h}px`,
    });
    nodes.push(frame);

    for (const name of HANDLES) {
      const handle = document.createElement('div');
      handle.className = `handle handle-${name}`;
      handle.dataset.handle = name;
      handle.dataset.id = element.id;
      Object.assign(handle.style, {
        left: `${element.x + (name.includes('e') ? element.w : 0)}px`,
        top: `${element.y + (name.includes('s') ? element.h : 0)}px`,
      });
      nodes.push(handle);
    }

    const rotate = document.createElement('div');
    rotate.className = 'handle handle-rotate';
    rotate.dataset.handle = 'rotate';
    rotate.dataset.id = element.id;
    Object.assign(rotate.style, {
      left: `${element.x + element.w / 2}px`,
      top: `${element.y - 48}px`,
    });
    nodes.push(rotate);
  }

  if (extras.rubberBand) {
    const band = document.createElement('div');
    band.className = 'rubber-band';
    Object.assign(band.style, {
      left: `${extras.rubberBand.x}px`,
      top: `${extras.rubberBand.y}px`,
      width: `${extras.rubberBand.w}px`,
      height: `${extras.rubberBand.h}px`,
    });
    nodes.push(band);
  }

  for (const guide of extras.guides ?? []) {
    const line = document.createElement('div');
    line.className = `guide ${guide.vertical ? 'vertical' : 'horizontal'}`;
    if (guide.vertical) {
      Object.assign(line.style, { left: `${guide.at}px`, top: '0px', height: `${model.canvas.h}px` });
    } else {
      Object.assign(line.style, { top: `${guide.at}px`, left: '0px', width: `${model.canvas.w}px` });
    }
    nodes.push(line);
  }

  return nodes;
}
