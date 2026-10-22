/** What a conversion could not carry, counted. */

import { escapeHtml } from './panel.js';

export class Losses {
  constructor() {
    this.counts = new Map();
  }

  /** Records `count` of something, described the same way every time. */
  add(what, count = 1) {
    if (count <= 0) return;
    this.counts.set(what, (this.counts.get(what) ?? 0) + count);
  }

  get empty() {
    return this.counts.size === 0;
  }

  /** In the order first met. */
  list() {
    return [...this.counts].map(([what, count]) => ({ what, count }));
  }

  lines() {
    return this.list().map(({ what, count }) => (count === 1 ? what : `${what} (${count})`));
  }

  html() {
    return `<ul class="problem-list">${this.lines().map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  }
}
