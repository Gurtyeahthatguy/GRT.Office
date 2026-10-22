/** Driving the shared editor. */

import {
  point, collapsed, isCollapsed, fromDom, toDom, clampSelection,
  containersInRange, normalise,
} from './selection.js';
import {
  insertText, splitBlock, deleteBackward, deleteForward, deleteRange,
  applyFormat, hasFormat, indentList, insertBlockAt, insertBlocks,
} from './commands.js';
import { TypingGroup } from './input.js';
import { runsText, splitRuns, makeBlock } from './model.js';
import { blocksFromHtml, blocksFromText } from './paste.js';
import { UndoStack } from '../undo.js';

const samePoint = (a, b) => !!a && !!b
  && a.blockId === b.blockId && a.offset === b.offset && (a.itemIndex ?? null) === (b.itemIndex ?? null);

/** Blocks whose text is lines, where Enter breaks the line. */
const LINE_KINDS = new Set(['code', 'raw']);

/** Blocks Enter goes on writing in, line after line, until it is pressed on an empty last line. */
const CONTINUED_KINDS = new Set(['callout']);

export class EditorController {
  /**
   * @param {HTMLElement} surface the contenteditable region
   * @param {{draw: Function}} renderer
   * @param {{onChange?: Function, getSelection?: Function}} options
   */
  constructor(surface, renderer, options = {}) {
    this.surface = surface;
    this.renderer = renderer;
    this.onChange = options.onChange ?? (() => {});
    this.getSelection = options.getSelection
      ?? (() => surface.ownerDocument.defaultView.getSelection());

    // What a redraw needs beyond the model.
    this.images = options.images ?? (() => new Map());

    // How a copied selection becomes clipboard data.
    this.serialiseCopy = options.serialiseCopy ?? defaultSerialiseCopy;

    this.lineBreaks = !!options.lineBreaks;

    this.model = null;
    this.undo = null;
    this.selection = null;
    this.typing = new TypingGroup();
    this.pending = {};
    this.pendingAt = null;
  }

  /** Points the controller at a document, with a fresh undo history. */
  attach(model) {
    this.model = model;
    this.undo = new UndoStack(model);
    this.selection = null;
    this.pending = {};
    this.pendingAt = null;
    this.typing.end();

    const first = model.blocks[0];
    if (first) {
      this.selection = collapsed(point(first.id, 0, first.kind === 'list' ? 0 : null));
    }

    this.draw();
    this.readSelection();
    return this;
  }

  /** Redraws, and puts the caret back. */
  draw() {
    this.renderer.draw(this.model, this.images());
    if (!this.selection) return;

    this.selection = clampSelection(this.selection, this.model);
    if (!toDom(this.surface, this.selection) && this.model.blocks[0]) {
      this.selection = collapsed(point(this.model.blocks[0].id, 0));
      toDom(this.surface, this.selection);
    }
  }

  /** Reads where the caret is. */
  readSelection() {
    const read = fromDom(this.surface, this.getSelection());
    if (read) this.selection = clampSelection(read, this.model);
    return this.selection;
  }

  /** A selection, one way or another. */
  ensureSelection() {
    if (this.readSelection()) return this.selection;

    const last = this.model.blocks[this.model.blocks.length - 1];
    if (!last) return null;

    const itemIndex = last.kind === 'list' ? Math.max(0, (last.items?.length ?? 1) - 1) : null;
    const runs = last.kind === 'list' ? (last.items?.[itemIndex]?.runs ?? []) : (last.runs ?? []);
    this.selection = collapsed(point(last.id, runsText(runs).length, itemIndex));
    return this.selection;
  }

  /** Applies a change, records undo, redraws. */
  edit(mutate, { merge = false, typed = false } = {}) {
    if (!this.ensureSelection()) return false;

    const before = this.model.snapshot();
    const selectionBefore = this.selection;

    const after = mutate();
    this.selection = clampSelection(after ?? this.selection, this.model);
    this.model.dirty = true;

    if (!merge) {
      this.undo.past.push({ ...before, selection: selectionBefore });
      if (this.undo.past.length > this.undo.limit) this.undo.past.shift();
      this.undo.future.length = 0;
    }

    this.draw();
    this.onChange({ typed });
    return true;
  }

  /** Undo when direction is negative, redo when positive. */
  step(direction) {
    this.typing.end();

    const stack = direction > 0 ? this.undo.future : this.undo.past;
    const entry = stack[stack.length - 1];
    if (!entry) return false;

    const moved = direction > 0 ? this.undo.redo() : this.undo.undo();
    if (!moved) return false;

    if (entry.selection) this.selection = clampSelection(entry.selection, this.model);
    this.draw();
    this.onChange({});
    return true;
  }

  /** The formatting a character typed at the caret takes: that of the text before it, with any mark switched since. */
  activeMarks() {
    const format = {};
    if (!this.selection || !this.model) return format;

    // Typing over a selection takes the look of its first character.
    const range = isCollapsed(this.selection) ? null : normalise(this.selection, this.model);
    const at = range ? range.start : this.selection.anchor;
    const [before, after] = splitRuns(this.model.runsOf(at.blockId, at.itemIndex), at.offset);
    const source = !range && at.offset > 0 ? before[before.length - 1] : after[0];
    for (const [key, value] of Object.entries(source ?? {})) if (key !== 'text') format[key] = value;

    if (samePoint(this.pendingAt, at)) {
      for (const [mark, on] of Object.entries(this.pending)) {
        if (on) format[mark] = true;
        else delete format[mark];
      }
    }
    return format;
  }

  /** Whether a mark is on, across the selection or at the caret. */
  markIsOn(mark) {
    if (this.selection && !isCollapsed(this.selection)) {
      return hasFormat(this.model, this.selection, mark);
    }
    return Boolean(this.activeMarks()[mark]);
  }

  /** Deletes to the edge of a word. */
  deleteWord(direction) {
    if (!isCollapsed(this.selection)) {
      return collapsed(deleteRange(this.model, this.selection));
    }

    const at = this.selection.anchor;
    const text = runsText(this.model.runsOf(at.blockId, at.itemIndex));

    let offset = at.offset;
    if (direction < 0) {
      while (offset > 0 && /\s/.test(text[offset - 1])) offset -= 1;
      while (offset > 0 && !/\s/.test(text[offset - 1])) offset -= 1;
    } else {
      while (offset < text.length && /\s/.test(text[offset])) offset += 1;
      while (offset < text.length && !/\s/.test(text[offset])) offset += 1;
    }

    if (offset === at.offset) {
      return direction < 0
        ? deleteBackward(this.model, this.selection)
        : deleteForward(this.model, this.selection);
    }

    const other = point(at.blockId, offset, at.itemIndex);
    return collapsed(deleteRange(this.model, { anchor: at, focus: other }));
  }

  /** The blocks a selection covers, copied. */
  selectedBlocks() {
    const seen = new Map();
    for (const container of containersInRange(this.selection, this.model)) {
      const block = this.model.block(container.blockId);
      if (block && !seen.has(block.id)) seen.set(block.id, structuredClone(block));
    }
    return [...seen.values()];
  }

  /** Toggles a to-do without moving the caret out of the text. */
  toggleTodo(blockId) {
    const block = this.model.block(blockId);
    if (!block) return false;

    const before = this.model.snapshot();
    const selectionBefore = this.selection;

    block.done = !block.done;
    this.model.dirty = true;

    this.undo.past.push({ ...before, selection: selectionBefore });
    this.undo.future.length = 0;

    this.draw();
    this.onChange({});
    return true;
  }

  /** Replaces a block's text and puts the caret at an offset. */
  replaceBlockText(blockId, text, caretOffset) {
    const block = this.model.block(blockId);
    if (!block || block.kind === 'list') return false;

    const before = this.model.snapshot();
    const selectionBefore = this.selection;

    this.model.setRuns(blockId, [{ text }]);
    this.model.dirty = true;
    this.selection = collapsed(point(blockId, caretOffset));

    this.undo.past.push({ ...before, selection: selectionBefore });
    this.undo.future.length = 0;

    this.draw();
    this.onChange({});
    return true;
  }

  /** The handlers `InputCapture` expects. */
  get handlers() {
    const self = this;

    return {
      insertText(text, options = {}) {
        self.ensureSelection();
        const merge = !options.composed
          && isCollapsed(self.selection)
          && !self.typing.shouldStartNew(text, self.selection.anchor);
        self.edit(
          () => insertText(self.model, self.selection, text, self.activeMarks()),
          { merge, typed: true },
        );
        // The characters that follow take their formatting from this one.
        self.pending = {};
        self.pendingAt = null;
      },

      splitBlock() {
        self.typing.end();
        const block = self.selection ? self.model.block(self.selection.focus?.blockId ?? self.selection.anchor?.blockId) : null;
        if (block && LINE_KINDS.has(block.kind)) {
          this.insertText('\n');
          return;
        }
        if (block && CONTINUED_KINDS.has(block.kind) && isCollapsed(self.selection)) {
          const text = runsText(block.runs ?? []);
          const at = self.selection.anchor.offset;
          if (at < text.length || !text.endsWith('\n')) {
            this.insertText('\n');
            return;
          }
          // Enter on its empty last line leaves the block for a paragraph after it.
          self.edit(() => {
            self.model.setRuns(block.id, splitRuns(block.runs ?? [], text.length - 1)[0]);
            return insertBlockAt(self.model, collapsed(point(block.id, text.length - 1)), makeBlock('paragraph'), { enter: true });
          });
          return;
        }
        self.edit(() => splitBlock(self.model, self.selection));
      },

      lineBreak() {
        if (!self.lineBreaks) {
          this.splitBlock();
          return;
        }
        this.insertText('\n');
      },

      deleteBackward(byWord = false) {
        self.typing.end();
        self.edit(() => (byWord
          ? self.deleteWord(-1)
          : deleteBackward(self.model, self.selection)));
      },

      deleteForward(byWord = false) {
        self.typing.end();
        self.edit(() => (byWord
          ? self.deleteWord(1)
          : deleteForward(self.model, self.selection)));
      },

      deleteSelection() {
        self.typing.end();
        self.edit(() => collapsed(deleteRange(self.model, self.selection)));
      },

      toggleMark(mark) {
        self.typing.end();
        self.ensureSelection();
        if (isCollapsed(self.selection)) {
          // With nothing selected the mark waits for the next character,
          // which is what pressing Ctrl+B before typing means.
          const on = !self.markIsOn(mark);
          if (!samePoint(self.pendingAt, self.selection.anchor)) self.pending = {};
          self.pending[mark] = on;
          self.pendingAt = self.selection.anchor;
          self.onChange({});
          return;
        }
        self.edit(() => applyFormat(self.model, self.selection, mark));
      },

      indent(delta) {
        self.typing.end();
        self.edit(() => indentList(self.model, self.selection, delta));
      },

      insertBlock(block, options = {}) {
        self.typing.end();
        self.edit(() => insertBlockAt(self.model, self.selection, block, options));
      },

      insertBlocks(blocks) {
        self.typing.end();
        self.edit(() => insertBlocks(self.model, self.selection, blocks));
      },

      selectAll() {
        const first = self.model.blocks[0];
        const last = self.model.blocks[self.model.blocks.length - 1];
        if (!first || !last) return;

        const lastItem = last.kind === 'list' ? Math.max(0, (last.items?.length ?? 1) - 1) : null;
        const lastRuns = last.kind === 'list'
          ? (last.items?.[lastItem]?.runs ?? []) : (last.runs ?? []);

        self.selection = {
          anchor: point(first.id, 0, first.kind === 'list' ? 0 : null),
          focus: point(last.id, runsText(lastRuns).length, lastItem),
        };
        toDom(self.surface, self.selection);
        self.onChange({});
      },

      /** Pasting HTML or text as blocks. */
      paste({ html, text }) {
        self.typing.end();
        const result = html
          ? blocksFromHtml(html, self.surface.ownerDocument)
          : { blocks: blocksFromText(text ?? ''), dropped: [] };

        if (result.blocks.length === 0) return;
        self.edit(() => insertBlocks(self.model, self.selection, result.blocks));
        if (result.dropped.length > 0) self.onChange({ dropped: result.dropped });
      },

      /** Copying. Whole blocks that the selection touches. */
      copy() {
        if (!self.readSelection() || isCollapsed(self.selection)) return null;
        const blocks = self.selectedBlocks();
        if (blocks.length === 0) return null;
        return self.serialiseCopy(blocks, self.model);
      },

      movingCursor() {
        self.typing.end();
        // The browser moves the caret; the model reads where it landed.
        setTimeout(() => { self.readSelection(); self.onChange({ moved: true }); }, 0);
      },

      undo() { self.step(-1); },
      redo() { self.step(1); },
      redraw() { self.draw(); },
    };
  }
}

/** Clipboard data when the host module has nothing better. */
function defaultSerialiseCopy(blocks) {
  const lines = blocks.map((block) => (block.kind === 'list'
    ? (block.items ?? []).map((item) => runsText(item.runs)).join('\n')
    : runsText(block.runs ?? [])));

  return {
    text: lines.join('\n\n'),
    html: lines.map((line) => `<p>${escapeForClipboard(line)}</p>`).join(''),
  };
}

/** Clipboard HTML is built as a string, so its text has to be escaped. */
function escapeForClipboard(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
