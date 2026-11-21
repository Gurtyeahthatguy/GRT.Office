/** The Gallery deck of the sidebar: Draw's shapes as pictures, one pressed to draw it. */

import { SHAPE_MENUS, shapeLabel } from './geometry.js';
import { drawingSvg } from './render.js';

const GROUPS = [['basic', 'Basic Shapes'], ['arrows', 'Block Arrows'], ['symbol', 'Symbol Shapes'], ['stars', 'Stars and Banners'], ['callout', 'Callout Shapes'], ['flowchart', 'Flowchart']];
const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** The shapes, grouped, each a button carrying its kind. */
export function galleryHtml() {
  return GROUPS.map(([group, title]) => `<div class="deck-group">${esc(title)}</div><div class="deck-gallery">${(SHAPE_MENUS[group] ?? []).map((type) => {
    const svg = drawingSvg({ id: `g-${type}`, kind: 'shape', shape: type, x: 0, y: 0, w: 40, h: 30, fillLook: { type: 'solid', color: '#cfe0f5' }, line: { color: '#3a6ea5', width: 1 } }, { idPrefix: 'gal' });
    return `<button type="button" data-gallery-shape="${esc(type)}" title="${esc(shapeLabel(type))}" aria-label="${esc(shapeLabel(type))}">${svg}<span>${esc(shapeLabel(type))}</span></button>`;
  }).join('')}</div>`).join('');
}

/** The kind a press in the gallery chose, or null. */
export const galleryChoice = (event) => event.target.closest?.('[data-gallery-shape]')?.dataset.galleryShape ?? null;
