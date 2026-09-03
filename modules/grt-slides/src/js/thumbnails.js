/** The slide panel. */

import { elementMarkup } from './export.js';

const WIDTH = 168;

export class Thumbnails {
  constructor(container) {
    this.container = container;
    this.model = null;
    this.currentId = null;
    this.dragIndex = null;

    this.onSelect = () => {};
    this.onReorder = () => {};
  }

  draw(model, currentId, images = new Map()) {
    this.model = model;
    this.currentId = currentId;

    const nodes = [];
    let index = -1;

    for (const group of model.sections()) {
      // A heading only where a section actually begins.
      if (group.title) {
        const heading = document.createElement('div');
        heading.className = 'thumb-section';
        heading.textContent = group.title;
        nodes.push(heading);
      }

      for (const slide of group.slides) {
        index += 1;
        nodes.push(this.item(model, slide, index, currentId, images));
      }
    }

    this.container.replaceChildren(...nodes);
  }

  item(model, slide, index, currentId, images) {
    {
      const item = document.createElement('div');
      item.className = `thumb${slide.id === currentId ? ' current' : ''}`;
      item.draggable = true;
      item.dataset.id = slide.id;
      item.dataset.index = String(index);

      const scale = WIDTH / model.canvas.w;
      const frame = document.createElement('div');
      frame.className = 'thumb-frame';
      frame.style.width = `${WIDTH}px`;
      frame.style.height = `${model.canvas.h * scale}px`;

      const surface = document.createElement('div');
      surface.className = 'thumb-surface';
      Object.assign(surface.style, {
        width: `${model.canvas.w}px`,
        height: `${model.canvas.h}px`,
        transform: `scale(${scale})`,
        background: model.slideBackground(slide.id),
      });
      surface.innerHTML = model.renderList(slide.id)
        .map((element) => elementMarkup(element, model, images))
        .join('');

      frame.append(surface);
      item.append(frame);

      const label = document.createElement('div');
      label.className = 'thumb-label';
      label.textContent = String(index + 1);
      item.append(label);

      item.addEventListener('click', () => this.onSelect(slide.id));
      item.addEventListener('dragstart', (event) => {
        this.dragIndex = index;
        item.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag with no data set.
        event.dataTransfer.setData('text/plain', String(index));
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        this.clearMarkers();
        this.dragIndex = null;
      });
      item.addEventListener('dragover', (event) => {
        if (this.dragIndex === null) return;
        event.preventDefault();
        this.clearMarkers();
        item.classList.add('drop-target');
      });
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        this.clearMarkers();
        if (this.dragIndex !== null && this.dragIndex !== index) {
          this.onReorder(this.dragIndex, index);
        }
      });

      return item;
    }
  }

  clearMarkers() {
    for (const item of this.container.children) item.classList.remove('drop-target');
  }
}
