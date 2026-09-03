/** The second screen. */

import { SlidesModel } from './model.js';
import { elementMarkup } from './export.js';
import { applyTheme } from './core/theme.js';

const { listen, emit } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const el = (id) => document.getElementById(id);

let model = null;
let images = new Map();
let index = 0;

let started = Date.now();
let paused = false;
let pausedFor = 0;

// Rendering

/** Draws one slide into a preview box, scaled to fit whatever room it has. */
function preview(container, slideIndex) {
  container.replaceChildren();
  const slide = model?.slides[slideIndex];
  if (!slide) return;

  const surface = document.createElement('div');
  surface.className = 'stage-surface';
  surface.style.width = `${model.canvas.w}px`;
  surface.style.height = `${model.canvas.h}px`;
  surface.style.background = model.slideBackground(slide.id);
  surface.innerHTML = model.renderList(slide.id)
    .map((element) => elementMarkup(element, model, images))
    .join('');

  container.append(surface);

  const box = container.getBoundingClientRect();
  const scale = Math.min(box.width / model.canvas.w, box.height / model.canvas.h);
  surface.style.transform = `scale(${scale})`;
  surface.style.left = `${(box.width - model.canvas.w * scale) / 2}px`;
  surface.style.top = `${(box.height - model.canvas.h * scale) / 2}px`;
}

function render() {
  if (!model) return;

  preview(el('now-preview'), index);
  preview(el('next-preview'), index + 1);

  const slide = model.slides[index];
  const notes = slide?.notes?.trim();
  el('notes-text').textContent = notes || 'No notes for this slide.';
  el('notes-text').classList.toggle('muted', !notes);

  el('position').textContent = `${index + 1} / ${model.slides.length}`;
  el('btn-prev').disabled = index === 0;
  el('btn-next').disabled = index >= model.slides.length - 1;
}

// The clock

function tick() {
  if (paused) return;
  const seconds = Math.floor((Date.now() - started - pausedFor) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  el('elapsed').textContent = `${mm}:${ss}`;
}

setInterval(tick, 250);

el('btn-reset').onclick = () => {
  started = Date.now();
  pausedFor = 0;
  tick();
};

let pauseBegan = 0;
el('btn-pause').onclick = () => {
  paused = !paused;
  if (paused) {
    pauseBegan = Date.now();
    el('btn-pause').textContent = 'Resume';
  } else {
    pausedFor += Date.now() - pauseBegan;
    el('btn-pause').textContent = 'Pause';
    tick();
  }
};

// Talking to the editor

const go = (to) => emit('grt://presenter-goto', { index: to });

el('btn-prev').onclick = () => go(index - 1);
el('btn-next').onclick = () => go(index + 1);

document.addEventListener('keydown', (event) => {
  const k = event.key;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown') {
    event.preventDefault();
    go(index + 1);
  } else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') {
    event.preventDefault();
    go(index - 1);
  } else if (k === 'Home') {
    go(0);
  } else if (k === 'End') {
    go((model?.slides.length ?? 1) - 1);
  } else if (k === 'Escape') {
    emit('grt://presenter-exit', {});
  }
});

window.addEventListener('resize', () => render());

/** The editor broadcasts the whole deck once, then only the index. */
listen('grt://deck', (event) => {
  const { document: deck, images: sent, index: at, theme } = event.payload ?? {};
  if (deck) model = new SlidesModel(deck);
  if (sent) images = new Map(Object.entries(sent));
  if (typeof at === 'number') index = at;
  if (theme) applyTheme(theme);
  render();
});

listen('grt://index', (event) => {
  index = event.payload?.index ?? 0;
  render();
});

// The editor cannot know when this window has finished loading, so this
// window says so and asks for the deck.
emit('grt://presenter-ready', {});

// Closing this window must never disturb the talk in progress.
window.addEventListener('beforeunload', () => {
  invoke('close_presenter').catch(() => {});
});
