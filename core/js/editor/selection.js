/** Where the cursor is, in the model's own terms. */

/**
 * A position: a block, optionally one item of a list, and a character offset.
 */
export function point(blockId, offset = 0, itemIndex = null) {
  return { blockId, offset, itemIndex };
}

export function collapsed(at) {
  return { anchor: { ...at }, focus: { ...at } };
}

export function isCollapsed(selection) {
  return samePoint(selection?.anchor, selection?.focus);
}

export function samePoint(a, b) {
  return !!a && !!b
    && a.blockId === b.blockId
    && (a.itemIndex ?? null) === (b.itemIndex ?? null)
    && a.offset === b.offset;
}

/**
 * The selection in document order, whichever way it was made.
 * @param {Object} selection
 * @param {DocumentModel} model
 * @returns {{start: Object, end: Object}}
 */
export function normalise(selection, model) {
  const { anchor, focus } = selection;
  return isBefore(focus, anchor, model)
    ? { start: { ...focus }, end: { ...anchor } }
    : { start: { ...anchor }, end: { ...focus } };
}

export function isBefore(a, b, model) {
  const ai = model.indexOf(a.blockId);
  const bi = model.indexOf(b.blockId);
  if (ai !== bi) return ai < bi;

  const aItem = a.itemIndex ?? 0;
  const bItem = b.itemIndex ?? 0;
  if (aItem !== bItem) return aItem < bItem;

  return a.offset < b.offset;
}

/**
 * Every text container the selection touches, in order.
 * @returns {{blockId: string, itemIndex: ?number, from: number, to: number,
 */
export function containersInRange(selection, model) {
  const { start, end } = normalise(selection, model);
  const out = [];

  const startIndex = model.indexOf(start.blockId);
  const endIndex = model.indexOf(end.blockId);
  if (startIndex === -1 || endIndex === -1) return out;

  for (let i = startIndex; i <= endIndex; i += 1) {
    const block = model.blocks[i];
    const items = block.kind === 'list'
      ? block.items.map((_, index) => index)
      : [null];

    for (const itemIndex of items) {
      const isFirst = i === startIndex && (itemIndex ?? 0) === (start.itemIndex ?? 0);
      const isLast = i === endIndex && (itemIndex ?? 0) === (end.itemIndex ?? 0);

      // Items of a list block before the start, or after the end, are outside
      // the range even though their block is inside it.
      if (i === startIndex && itemIndex !== null && itemIndex < (start.itemIndex ?? 0)) continue;
      if (i === endIndex && itemIndex !== null && itemIndex > (end.itemIndex ?? 0)) continue;

      const length = lengthOf(model, block, itemIndex);
      const from = isFirst ? Math.min(start.offset, length) : 0;
      const to = isLast ? Math.min(end.offset, length) : length;

      out.push({
        blockId: block.id,
        itemIndex,
        from,
        to,
        whole: from === 0 && to === length,
      });
    }
  }

  return out;
}

export function lengthOf(model, block, itemIndex = null) {
  if (!block) return 0;
  if (block.kind === 'image') return 0;
  const runs = block.kind === 'list'
    ? block.items[itemIndex ?? 0]?.runs ?? []
    : block.runs ?? [];
  return runs.reduce((total, run) => total + run.text.length, 0);
}

/**
 * Clamps a point to something that exists, after the document has changed.
 */
export function clamp(at, model) {
  const block = model.block(at?.blockId) ?? model.blocks[0];
  if (!block) return null;

  const itemIndex = block.kind === 'list'
    ? Math.max(0, Math.min(at?.itemIndex ?? 0, block.items.length - 1))
    : null;

  return {
    blockId: block.id,
    itemIndex,
    offset: Math.max(0, Math.min(at?.offset ?? 0, lengthOf(model, block, itemIndex))),
  };
}

export function clampSelection(selection, model) {
  if (!selection) return collapsed(point(model.blocks[0].id, 0));
  return {
    anchor: clamp(selection.anchor, model),
    focus: clamp(selection.focus, model),
  };
}

/**
 * The position one step forward, crossing into the next container if needed.
 */
export function forward(at, model) {
  const block = model.block(at.blockId);
  if (!block) return at;

  const length = lengthOf(model, block, at.itemIndex);
  if (at.offset < length) return { ...at, offset: at.offset + 1 };

  return startOfNext(at, model) ?? at;
}

/**
 * The position one step back, crossing into the previous container if needed.
 */
export function backward(at, model) {
  if (at.offset > 0) return { ...at, offset: at.offset - 1 };
  return endOfPrevious(at, model) ?? at;
}

export function startOfNext(at, model) {
  const block = model.block(at.blockId);
  if (!block) return null;

  if (block.kind === 'list' && (at.itemIndex ?? 0) < block.items.length - 1) {
    return point(block.id, 0, (at.itemIndex ?? 0) + 1);
  }

  const next = model.blocks[model.indexOf(at.blockId) + 1];
  if (!next) return null;
  return point(next.id, 0, next.kind === 'list' ? 0 : null);
}

export function endOfPrevious(at, model) {
  const block = model.block(at.blockId);
  if (!block) return null;

  if (block.kind === 'list' && (at.itemIndex ?? 0) > 0) {
    const itemIndex = (at.itemIndex ?? 0) - 1;
    return point(block.id, lengthOf(model, block, itemIndex), itemIndex);
  }

  const previous = model.blocks[model.indexOf(at.blockId) - 1];
  if (!previous) return null;

  const itemIndex = previous.kind === 'list' ? previous.items.length - 1 : null;
  return point(previous.id, lengthOf(model, previous, itemIndex), itemIndex);
}

// Translating to and from the browser

/**
 * Reads the browser's selection into the model's terms.
 * @returns {?Object} model selection, or null when the selection is elsewhere
 */
export function fromDom(root, domSelection) {
  if (!domSelection || domSelection.rangeCount === 0) return null;

  const anchor = pointFromDom(root, domSelection.anchorNode, domSelection.anchorOffset);
  const focus = pointFromDom(root, domSelection.focusNode, domSelection.focusOffset);
  if (!anchor || !focus) return null;

  return { anchor, focus };
}

function pointFromDom(root, node, offset) {
  if (!node || !root.contains(node)) return null;

  const host = (node.nodeType === 3 ? node.parentElement : node)?.closest?.('[data-block]');
  if (!host) return null;

  const itemAttribute = host.dataset.item;
  let count = 0;

  const walker = host.ownerDocument.createTreeWalker(host, 4 /** SHOW_TEXT. */);
  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      count += Math.min(offset, current.nodeValue.length);
      return point(host.dataset.block, count,
        itemAttribute === undefined ? null : Number(itemAttribute));
    }
    count += current.nodeValue.length;
    current = walker.nextNode();
  }

  // The anchor was the element itself rather than a text node inside it,
  // which happens in an empty block.
  return point(host.dataset.block, node.nodeType === 3 ? offset : count,
    itemAttribute === undefined ? null : Number(itemAttribute));
}

/** Writes the model's selection back into the browser. */
export function toDom(root, selection) {
  if (!selection) return false;

  const anchor = domPositionFor(root, selection.anchor);
  const focus = domPositionFor(root, selection.focus);
  if (!anchor || !focus) return false;

  const view = root.ownerDocument.defaultView;
  const domSelection = view.getSelection();
  const range = root.ownerDocument.createRange();

  try {
    range.setStart(anchor.node, anchor.offset);
    range.setEnd(focus.node, focus.offset);
    domSelection.removeAllRanges();
    domSelection.addRange(range);

    // A backwards selection has to be rebuilt the other way round, or
    // dragging upwards snaps the wrong way on the next keystroke.
    if (!isDomForward(root, selection)) {
      domSelection.setBaseAndExtent(focus.node, focus.offset, anchor.node, anchor.offset);
    }
    return true;
  } catch {
    // The position no longer exists.
    return false;
  }
}

function isDomForward(root, selection) {
  const a = selection.anchor;
  const b = selection.focus;
  if (a.blockId !== b.blockId) {
    const blocks = [...root.querySelectorAll('[data-block]')].map((n) => n.dataset.block);
    return blocks.indexOf(a.blockId) <= blocks.indexOf(b.blockId);
  }
  if ((a.itemIndex ?? 0) !== (b.itemIndex ?? 0)) return (a.itemIndex ?? 0) < (b.itemIndex ?? 0);
  return a.offset <= b.offset;
}

/** Finds the text node and offset for a model position. */
export function domPositionFor(root, at) {
  if (!at) return null;

  const selector = at.itemIndex === null || at.itemIndex === undefined
    ? `[data-block="${at.blockId}"]:not([data-item])`
    : `[data-block="${at.blockId}"][data-item="${at.itemIndex}"]`;

  const host = root.querySelector(selector) ?? root.querySelector(`[data-block="${at.blockId}"]`);
  if (!host) return null;

  let remaining = at.offset;
  const walker = host.ownerDocument.createTreeWalker(host, 4 /** SHOW_TEXT. */);

  let node = walker.nextNode();
  let last = null;
  while (node) {
    if (remaining <= node.nodeValue.length) return { node, offset: remaining };
    remaining -= node.nodeValue.length;
    last = node;
    node = walker.nextNode();
  }

  if (last) return { node: last, offset: last.nodeValue.length };
  // An empty block has no text node at all; the element itself is the
  // position.
  return { node: host, offset: 0 };
}
