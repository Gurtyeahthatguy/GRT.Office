/** What depends on what. */

export function nodeId(sheetId, row, col) {
  return `${sheetId}!${row},${col}`;
}

export function parseNodeId(id) {
  const bang = id.lastIndexOf('!');
  const [row, col] = id.slice(bang + 1).split(',').map(Number);
  return { sheetId: id.slice(0, bang), row, col };
}

export class DependencyGraph {
  constructor() {
    /**
     * cell → {cells: Set<id>, ranges: [{sheetId, top, left, bottom, right}]}.
     */
    this.precedents = new Map();
    /** cell → Set<id> of cells that read it directly. */
    this.dependents = new Map();
    /** every recorded range, with the cell that watches it. */
    this.rangeWatchers = [];
  }

  /**
   * Records what one cell reads, replacing whatever it read before.
   * @param {string} id
   * @param {{cells?: string[], ranges?: Object[]}} reads
   */
  setDependencies(id, reads = {}) {
    this.remove(id);

    const cells = new Set(reads.cells ?? []);
    const ranges = (reads.ranges ?? []).map(normaliseRange);

    if (cells.size === 0 && ranges.length === 0) return;

    this.precedents.set(id, { cells, ranges });

    for (const precedent of cells) {
      let set = this.dependents.get(precedent);
      if (!set) { set = new Set(); this.dependents.set(precedent, set); }
      set.add(id);
    }

    for (const range of ranges) {
      this.rangeWatchers.push({ id, range });
    }
  }

  /** Forgets a cell's dependencies. */
  remove(id) {
    const held = this.precedents.get(id);
    if (!held) return;

    for (const precedent of held.cells) {
      const set = this.dependents.get(precedent);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.dependents.delete(precedent);
    }

    if (held.ranges.length > 0) {
      this.rangeWatchers = this.rangeWatchers.filter((watcher) => watcher.id !== id);
    }

    this.precedents.delete(id);
  }

  /** Everything that reads this cell directly, by name or through a range. */
  directDependentsOf(id) {
    const found = new Set(this.dependents.get(id) ?? []);
    const { sheetId, row, col } = parseNodeId(id);

    for (const { id: watcher, range } of this.rangeWatchers) {
      if (range.sheetId !== sheetId) continue;
      if (row < range.top || row > range.bottom) continue;
      if (col < range.left || col > range.right) continue;
      found.add(watcher);
    }

    return found;
  }

  /** Everything downstream of a change, including the changed cells. */
  affectedBy(ids) {
    const seen = new Set(ids);
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.pop();
      for (const dependent of this.directDependentsOf(id)) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        queue.push(dependent);
      }
    }

    return seen;
  }

  /**
   * Orders a set of cells so that each comes after everything it reads.
   * @returns {{order: string[], cyclic: string[]}}
   */
  topologicalOrder(ids) {
    const inSet = ids instanceof Set ? ids : new Set(ids);

    const remaining = new Map();
    const feeds = new Map();

    for (const id of inSet) {
      const reads = this.precedentsWithin(id, inSet);
      remaining.set(id, reads.size);
      for (const read of reads) {
        let list = feeds.get(read);
        if (!list) { list = []; feeds.set(read, list); }
        list.push(id);
      }
    }

    const ready = [...remaining.entries()]
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      .sort();

    const order = [];
    while (ready.length > 0) {
      const id = ready.shift();
      order.push(id);
      remaining.delete(id);

      for (const dependent of feeds.get(id) ?? []) {
        const left = remaining.get(dependent);
        if (left === undefined) continue;
        if (left - 1 === 0) { remaining.delete(dependent); ready.push(dependent); }
        else remaining.set(dependent, left - 1);
      }
    }

    return { order, cyclic: [...remaining.keys()] };
  }

  /** The cells this one reads that are also in the set being ordered. */
  precedentsWithin(id, inSet) {
    const held = this.precedents.get(id);
    const found = new Set();
    if (!held) return found;

    for (const precedent of held.cells) {
      if (inSet.has(precedent)) found.add(precedent);
    }

    // A range's members are only interesting when they are being recalculated
    // too, so the set is walked rather than the range expanded.
    if (held.ranges.length > 0) {
      for (const candidate of inSet) {
        if (found.has(candidate)) continue;
        const { sheetId, row, col } = parseNodeId(candidate);
        for (const range of held.ranges) {
          if (range.sheetId !== sheetId) continue;
          if (row < range.top || row > range.bottom) continue;
          if (col < range.left || col > range.right) continue;
          found.add(candidate);
          break;
        }
      }
    }

    return found;
  }

  /** Whether a cell would take part in a cycle, without changing anything. */
  wouldCycle(id, reads) {
    const seen = new Set();
    const queue = [...(reads.cells ?? [])];

    for (const range of (reads.ranges ?? []).map(normaliseRange)) {
      for (const candidate of this.precedents.keys()) {
        const { sheetId, row, col } = parseNodeId(candidate);
        if (range.sheetId !== sheetId) continue;
        if (row < range.top || row > range.bottom) continue;
        if (col < range.left || col > range.right) continue;
        queue.push(candidate);
      }
    }

    while (queue.length > 0) {
      const current = queue.pop();
      if (current === id) return true;
      if (seen.has(current)) continue;
      seen.add(current);

      const held = this.precedents.get(current);
      if (!held) continue;
      queue.push(...held.cells);
      for (const range of held.ranges) {
        for (const candidate of this.precedents.keys()) {
          const { sheetId, row, col } = parseNodeId(candidate);
          if (range.sheetId !== sheetId) continue;
          if (row < range.top || row > range.bottom) continue;
          if (col < range.left || col > range.right) continue;
          queue.push(candidate);
        }
      }
    }

    return false;
  }

  clear() {
    this.precedents.clear();
    this.dependents.clear();
    this.rangeWatchers = [];
  }

  get size() {
    return this.precedents.size;
  }
}

function normaliseRange({ sheetId, from, to }) {
  return {
    sheetId,
    top: Math.min(from.row, to.row),
    bottom: Math.max(from.row, to.row),
    left: Math.min(from.col, to.col),
    right: Math.max(from.col, to.col),
  };
}
