/** Where the pages break. */

import { MM } from './core/editor/render.js';

/**
 * Works out which blocks sit on which page.
 * @param {{id: string, height: number, keepWithNext?: boolean,
 * @param {number} pageHeight usable height in pixels
 * @returns {{pages: string[][], breakAfter: Set<string>}}
 */
export function paginate(blocks, pageHeight) {
  const pages = [];
  const breakAfter = new Set();

  let current = [];
  let used = 0;

  const flush = () => {
    if (current.length > 0) pages.push(current);
    current = [];
    used = 0;
  };

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    if (block.breakBefore && current.length > 0) {
      breakAfter.add(current[current.length - 1]);
      flush();
    }

    // "Keep with the next" is what stops a heading being left alone at the
    // foot of a page.
    let groupHeight = block.height;
    let groupEnd = i;
    while (blocks[groupEnd]?.keepWithNext && groupEnd + 1 < blocks.length) {
      groupEnd += 1;
      groupHeight += blocks[groupEnd].height;
    }

    const fits = used + groupHeight <= pageHeight;

    if (!fits && current.length > 0) {
      // A paragraph too tall for what is left may be split, but only where at
      // least two lines land on each side.
      const splittable = groupEnd === i
        && block.lines >= 4
        && block.lineHeight > 0
        && !block.keepWithNext;

      const roomForLines = splittable
        ? Math.floor((pageHeight - used) / block.lineHeight)
        : 0;

      if (splittable && roomForLines >= 2 && block.lines - roomForLines >= 2) {
        current.push(block.id);
        breakAfter.add(block.id);
        flush();
        used = (block.lines - roomForLines) * block.lineHeight;
        current.push(block.id);
        continue;
      }

      breakAfter.add(current[current.length - 1]);
      flush();
    }

    for (let j = i; j <= groupEnd; j += 1) current.push(blocks[j].id);
    used += groupHeight;
    i = groupEnd;
  }

  flush();
  return { pages: pages.length > 0 ? pages : [[]], breakAfter };
}

/** Measures blocks, reusing what has not changed. */
export class Measurer {
  constructor() {
    this.cache = new Map();
  }

  /** Forgets one block, or everything. */
  invalidate(id = null) {
    if (id === null) this.cache.clear();
    else this.cache.delete(id);
  }

  /**
   * @param {PaperModel} model
   * @param {HTMLElement} surface where the blocks are rendered
   * @returns {Object[]} one entry per block, ready for paginate()
   */
  measure(model, surface) {
    return model.blocks.map((block) => {
      const signature = signatureOf(block);
      const cached = this.cache.get(block.id);
      if (cached && cached.signature === signature) return cached.entry;

      const element = surface.querySelector(
        `[data-block="${block.id}"], [data-block-container="${block.id}"]`,
      );
      const style = model.styles[block.style] ?? model.styles.body ?? {};
      const lineHeight = (style.size ?? 11) * (style.lineHeight ?? 1.5) * (96 / 72);

      const height = element?.getBoundingClientRect().height ?? lineHeight;

      const entry = {
        id: block.id,
        height,
        lineHeight,
        lines: Math.max(1, Math.round(height / lineHeight)),
        // A heading belongs with what follows it; an image cannot be split.
        keepWithNext: block.kind === 'heading',
        breakBefore: !!block.breakBefore,
      };

      this.cache.set(block.id, { signature, entry });
      return entry;
    });
  }
}

function signatureOf(block) {
  // Cheap and sufficient: anything that changes the text or the style changes
  // this string, and nothing else does.
  return JSON.stringify([
    block.kind, block.style, block.align, block.level, block.breakBefore,
    block.w, block.h,
    block.kind === 'list'
      ? block.items.map((i) => [i.level, i.runs.map((r) => r.text).join('')])
      : (block.runs ?? []).map((r) => r.text).join(''),
  ]);
}

/** The usable height of a page, in pixels. */
export function pageHeightPx(model) {
  return model.pageBox().contentHeight * MM;
}

/** Defers work while typing continues. */
export class Deferred {
  constructor(run, delay = 220) {
    this.run = run;
    this.delay = delay;
    this.timer = null;
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.delay);
  }

  /** Runs it now, if something is waiting. */
  flush() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.run();
  }
}
