/** Projection. */

import { elementMarkup } from './export.js';

export class Presentation {
  /**
   * @param {HTMLElement} root a full-screen container, hidden while editing
   */
  constructor(root) {
    this.root = root;
    this.model = null;
    this.index = 0;
    this.typed = '';
    this.typedTimer = null;
    this.wakeLock = null;
    this.onExit = () => {};
    this.onMove = () => {};

    this.onKey = (event) => this.key(event);
    this.onClick = (event) => this.click(event);
    this.onResize = () => this.fit();
  }

  get running() {
    return this.root.classList.contains('running');
  }

  async start(model, fromIndex = 0) {
    this.model = model;
    this.index = Math.max(0, Math.min(fromIndex, model.slides.length - 1));

    this.root.classList.add('running');
    document.addEventListener('keydown', this.onKey, true);
    this.root.addEventListener('click', this.onClick);
    window.addEventListener('resize', this.onResize);

    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // A refused fullscreen request is not a reason to abandon the
      // presentation.
    }

    await this.keepAwake();
    this.render();
  }

  async stop() {
    this.root.classList.remove('running');
    this.root.replaceChildren();
    document.removeEventListener('keydown', this.onKey, true);
    this.root.removeEventListener('click', this.onClick);
    window.removeEventListener('resize', this.onResize);

    if (this.wakeLock) {
      try { await this.wakeLock.release(); } catch { /** already gone. */ }
      this.wakeLock = null;
    }

    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /** already left. */ }
    }

    this.onExit();
  }

  /** Stops the screensaver from interrupting a talk. */
  async keepAwake() {
    try {
      if (navigator.wakeLock?.request) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {
      // Unsupported or refused.
    }
  }

  go(index) {
    if (!this.model) return;
    this.index = Math.max(0, Math.min(index, this.model.slides.length - 1));
    this.render();
    this.onMove(this.index);
  }

  /** Black and white screens are standard practice for moving attention. */
  veil(colour) {
    const current = this.root.dataset.veil;
    if (current === colour) {
      delete this.root.dataset.veil;
      this.root.style.background = '';
    } else {
      this.root.dataset.veil = colour;
      this.root.style.background = colour;
    }
  }

  key(event) {
    if (!this.running) return;
    event.preventDefault();
    event.stopPropagation();

    const k = event.key;
    if (k === 'Escape') this.stop();
    else if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown') this.go(this.index + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') this.go(this.index - 1);
    else if (k === 'Home') this.go(0);
    else if (k === 'End') this.go(this.model.slides.length - 1);
    else if (k === 'b' || k === 'B') this.veil('#000000');
    else if (k === 'w' || k === 'W') this.veil('#ffffff');
    else if (k >= '0' && k <= '9') {
      // Typing a number jumps to that slide, after a pause long enough to
      // finish typing a two-digit one.
      this.typed += k;
      clearTimeout(this.typedTimer);
      this.typedTimer = setTimeout(() => {
        if (this.typed) this.go(parseInt(this.typed, 10) - 1);
        this.typed = '';
      }, 700);
    }
  }

  click(event) {
    // Left third goes back, the rest forward.
    this.go(this.index + (event.clientX < window.innerWidth / 3 ? -1 : 1));
  }

  fit() {
    const surface = this.root.querySelector('.present-surface');
    if (!surface || !this.model) return;

    const scale = Math.min(
      window.innerWidth / this.model.canvas.w,
      window.innerHeight / this.model.canvas.h,
    );
    surface.style.transform = `scale(${scale})`;
  }

  render() {
    const slide = this.model.slides[this.index];
    if (!slide) return;

    const surface = document.createElement('div');
    surface.className = 'present-surface';
    surface.style.width = `${this.model.canvas.w}px`;
    surface.style.height = `${this.model.canvas.h}px`;
    surface.style.background = this.model.slideBackground(slide.id);

    surface.innerHTML = this.model.renderList(slide.id)
      .map((element) => elementMarkup(element, this.model, this.images ?? new Map()))
      .join('');

    // The transition animates a wrapper, not the surface itself.
    const transition = ['fade', 'slide'].includes(slide.transition) ? slide.transition : 'none';
    const frame = document.createElement('div');
    frame.className = `present-frame t-${transition}`;
    frame.append(surface);

    this.root.replaceChildren(frame);
    this.fit();
  }
}
