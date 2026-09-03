/** Logical state of the open document. */

export class DocumentModel {
  /**
   * @param {Uint8Array} bytes contents of the file that was opened
   * @param {number} pageCount
   * @param {string} [path] where it came from, null for an unsaved merge
   */
  constructor(bytes, pageCount, path = null) {
    // Sources are kept whole and never mutated.
    this.sources = [{ id: 0, bytes }];
    this.path = path;
    this.pages = Array.from({ length: pageCount }, (_, i) => ({
      sourceId: 0,
      originalIndex: i,
      rotation: 0,      // degrees: 0, 90, 180, 270.
      crop: null,       // {left, bottom, right, top} as fractions of the page.
      marks: [],        // highlights and redactions, in fractions of the page.
      deleted: false,
    }));
    this.dirty = false;
  }

  /** Bytes of the file the document was opened from. */
  get originalBytes() {
    return this.sources[0].bytes;
  }

  /** Pages actually visible, in their current order. */
  get visiblePages() {
    return this.pages.filter((p) => !p.deleted);
  }

  get visibleCount() {
    return this.visiblePages.length;
  }

  /**
   * Appends the pages of another PDF at the end of this document.
   * @param {Uint8Array} bytes
   * @param {number} pageCount
   * @returns {number} id of the source that was added
   */
  appendSource(bytes, pageCount) {
    const id = this.sources.length;
    this.sources.push({ id, bytes });
    for (let i = 0; i < pageCount; i += 1) {
      this.pages.push({
        sourceId: id,
        originalIndex: i,
        rotation: 0,
        crop: null,
        marks: [],
        deleted: false,
      });
    }
    this.dirty = true;
    return id;
  }

  /**
   * Marks a page as deleted.
   * @param {number} viewIndex index in the view, not the original one
   */
  deletePage(viewIndex) {
    const page = this.visiblePages[viewIndex];
    if (!page) throw new RangeError(`Page ${viewIndex} does not exist`);
    if (this.visibleCount <= 1) {
      throw new Error('Cannot delete the last remaining page');
    }
    page.deleted = true;
    this.dirty = true;
  }

  /**
   * Deletes several pages at once.
   * @param {number[]} viewIndices
   */
  deletePages(viewIndices) {
    const visible = this.visiblePages;
    const targets = viewIndices.map((i) => visible[i]).filter(Boolean);
    if (targets.length === 0) return;
    if (visible.length - targets.length < 1) {
      throw new Error('Cannot delete every page');
    }
    for (const page of targets) page.deleted = true;
    this.dirty = true;
  }

  restorePage(sourceId, originalIndex) {
    const page = this.pages.find(
      (p) => p.sourceId === sourceId && p.originalIndex === originalIndex,
    );
    if (page) {
      page.deleted = false;
      this.dirty = true;
    }
  }

  /**
   * Rotates a page by a multiple of 90 degrees.
   * @param {number} viewIndex
   * @param {number} degrees positive or negative
   */
  rotatePage(viewIndex, degrees) {
    const page = this.visiblePages[viewIndex];
    if (!page) throw new RangeError(`Page ${viewIndex} does not exist`);
    // Normalise into [0, 360) while handling negatives correctly.
    page.rotation = (((page.rotation + degrees) % 360) + 360) % 360;
    this.dirty = true;
  }

  /**
   * Records a highlight or a redaction on a page.
   * @param {number} viewIndex
   * @param {'highlight'|'redact'} type
   * @param {{x: number, y: number, width: number, height: number}} rect
   */
  addMark(viewIndex, type, rect) {
    const page = this.visiblePages[viewIndex];
    if (!page) throw new RangeError(`Page ${viewIndex} does not exist`);
    if (rect.width <= 0.001 || rect.height <= 0.001) return;

    page.marks.push({
      type,
      rect: {
        x: clampFraction01(rect.x),
        y: clampFraction01(rect.y),
        width: clampFraction01(rect.width),
        height: clampFraction01(rect.height),
      },
    });
    this.dirty = true;
  }

  /** Removes every mark from the given pages. */
  clearMarks(viewIndices) {
    const visible = this.visiblePages;
    for (const i of viewIndices) {
      if (visible[i]) visible[i].marks = [];
    }
    this.dirty = true;
  }

  /** How many marks of a kind exist across the document. */
  countMarks(type) {
    return this.visiblePages.reduce(
      (total, page) => total + page.marks.filter((m) => m.type === type).length,
      0,
    );
  }

  /**
   * Restricts pages to a region, given as fractions trimmed from each side.
   * @param {number[]} viewIndices
   * @param {{left: number, bottom: number, right: number, top: number}} crop
   */
  cropPages(viewIndices, crop) {
    const visible = this.visiblePages;
    const clean = {
      left: clampFraction(crop.left),
      bottom: clampFraction(crop.bottom),
      right: clampFraction(crop.right),
      top: clampFraction(crop.top),
    };
    if (clean.left + clean.right >= 0.95 || clean.top + clean.bottom >= 0.95) {
      throw new Error('That crop would leave nothing visible');
    }

    const targets = viewIndices.map((i) => visible[i]).filter(Boolean);
    if (targets.length === 0) return;
    for (const page of targets) page.crop = { ...clean };
    this.dirty = true;
  }

  /** Removes cropping from the given pages. */
  clearCrop(viewIndices) {
    const visible = this.visiblePages;
    for (const i of viewIndices) {
      if (visible[i]) visible[i].crop = null;
    }
    this.dirty = true;
  }

  /** Moves a page to another position (drag & drop in the thumbnails). */
  movePage(fromViewIndex, toViewIndex) {
    const visible = this.visiblePages;
    const target = visible[fromViewIndex];
    if (!target) throw new RangeError(`Page ${fromViewIndex} does not exist`);

    const fromReal = this.pages.indexOf(target);
    const toReal = toViewIndex >= visible.length
      ? this.pages.length - 1
      : this.pages.indexOf(visible[toViewIndex]);

    this.pages.splice(fromReal, 1);
    this.pages.splice(toReal, 0, target);
    this.dirty = true;
  }

  /**
   * Build plan for saving.
   * @returns {{sourceId: number, originalIndex: number, rotation: number}[]}
   */
  buildPlan() {
    return this.visiblePages.map((p) => ({
      sourceId: p.sourceId,
      originalIndex: p.originalIndex,
      rotation: p.rotation,
      crop: p.crop,
      marks: p.marks,
    }));
  }

  /**
   * Build plan limited to a subset of the visible pages, for "extract".
   * @param {number[]} viewIndices
   */
  buildPlanFor(viewIndices) {
    const visible = this.visiblePages;
    return viewIndices
      .map((i) => visible[i])
      .filter(Boolean)
      .map((p) => ({
        sourceId: p.sourceId,
        originalIndex: p.originalIndex,
        rotation: p.rotation,
        crop: p.crop,
        marks: p.marks,
      }));
  }

  /** Snapshot for the undo stack. */
  snapshot() {
    return {
      // Marks are copied element by element.
      pages: this.pages.map((p) => ({
        ...p,
        marks: p.marks.map((m) => ({ ...m, rect: { ...m.rect } })),
      })),
      sourceCount: this.sources.length,
      dirty: this.dirty,
    };
  }

  restore(snapshot) {
    this.pages = snapshot.pages.map((p) => ({
      ...p,
      marks: (p.marks ?? []).map((m) => ({ ...m, rect: { ...m.rect } })),
    }));
    // Sources added after the snapshot are dropped; sources are only ever
    // appended, so truncating is enough to undo an append.
    this.sources.length = snapshot.sourceCount ?? this.sources.length;
    this.dirty = snapshot.dirty;
  }
}

/** Crop fractions are per side and must leave a usable page behind. */
function clampFraction(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, 0.9);
}

function clampFraction01(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, 1);
}
