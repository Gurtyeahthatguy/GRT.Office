/** Catching what the user does, and refusing to let the browser act. */

/** Groups keystrokes into undo entries. */
export class TypingGroup {
  /**
   * @param {number} [pauseMs=500] silence long enough to end a group
   */
  constructor(pauseMs = 500) {
    this.pauseMs = pauseMs;
    this.open = false;
    this.lastAt = 0;
    this.lastPoint = null;
  }

  /**
   * Whether this keystroke continues the current group.
   * @param {string} text what was typed
   * @param {Object} at where the cursor was
   * @param {number} now
   * @returns {boolean} true when a new undo entry should be started
   */
  shouldStartNew(text, at, now = Date.now()) {
    const paused = now - this.lastAt > this.pauseMs;
    const moved = this.lastPoint !== null && !continues(this.lastPoint, at);
    // A space or a newline closes the group.
    const boundary = /\s/.test(text);

    const start = !this.open || paused || moved || boundary;

    this.open = !boundary;
    this.lastAt = now;
    this.lastPoint = at ? { ...at, offset: at.offset + text.length } : null;

    return start;
  }

  /** Called whenever anything other than typing happens. */
  end() {
    this.open = false;
    this.lastPoint = null;
  }
}

function continues(previous, at) {
  return previous.blockId === at.blockId
    && (previous.itemIndex ?? null) === (at.itemIndex ?? null)
    && previous.offset === at.offset;
}

/** Wires an editable region to a set of handlers. */
export class InputCapture {
  /**
   * @param {HTMLElement} element the contenteditable region
   * @param {Object} handlers
   */
  constructor(element, handlers) {
    this.element = element;
    this.handlers = handlers;
    this.composing = false;

    element.addEventListener('beforeinput', (e) => this.beforeInput(e));
    element.addEventListener('compositionstart', () => { this.composing = true; });
    element.addEventListener('compositionend', (e) => this.compositionEnd(e));
    element.addEventListener('keydown', (e) => this.keyDown(e));
    element.addEventListener('paste', (e) => this.paste(e));
    element.addEventListener('cut', (e) => this.cut(e));
    element.addEventListener('copy', (e) => this.copy(e));
    element.addEventListener('drop', (e) => e.preventDefault());
  }

  /** beforeinput carries what is about to happen, before the DOM changes. */
  beforeInput(event) {
    // During a composition the browser is mid-word: it must be left to
    // finish.
    if (this.composing) return;

    const type = event.inputType;

    if (type === 'insertText' && event.data) {
      event.preventDefault();
      this.handlers.insertText(event.data);
      return;
    }

    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      event.preventDefault();
      this.handlers.splitBlock();
      return;
    }

    if (type === 'deleteContentBackward' || type === 'deleteWordBackward') {
      event.preventDefault();
      this.handlers.deleteBackward(type === 'deleteWordBackward');
      return;
    }

    if (type === 'deleteContentForward' || type === 'deleteWordForward') {
      event.preventDefault();
      this.handlers.deleteForward(type === 'deleteWordForward');
      return;
    }

    if (type === 'insertFromPaste' || type === 'insertFromDrop') {
      // Handled by the paste listener, which has the clipboard data.
      event.preventDefault();
      return;
    }

    if (type?.startsWith('format')) {
      // The browser's own formatting commands produce markup nobody controls.
      event.preventDefault();
      return;
    }

    if (type === 'historyUndo' || type === 'historyRedo') {
      event.preventDefault();
      if (type === 'historyUndo') this.handlers.undo();
      else this.handlers.redo();
    }
  }

  /** The composed text arrives here, once, as a single insertion. */
  compositionEnd(event) {
    this.composing = false;
    const text = event.data ?? '';

    // The browser has already put the composed text into the DOM.
    if (text) this.handlers.insertText(text, { composed: true });
    else this.handlers.redraw();
  }

  keyDown(event) {
    if (this.composing) return;

    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (ctrl && !event.altKey) {
      const mark = { b: 'bold', i: 'italic', u: 'underline' }[key];
      if (mark) {
        event.preventDefault();
        this.handlers.toggleMark(mark);
        return;
      }
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.handlers.redo();
        else this.handlers.undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        this.handlers.redo();
        return;
      }
      if (key === 'a') {
        event.preventDefault();
        this.handlers.selectAll();
        return;
      }
    }

    if (event.key === 'Tab') {
      // Tab indents a list rather than moving focus out of the document.
      event.preventDefault();
      this.handlers.indent(event.shiftKey ? -1 : 1);
      return;
    }

    // Arrow keys, Home, End and the rest are left to the browser.
    if (!ctrl && event.key.startsWith('Arrow')) this.handlers.movingCursor();
  }

  paste(event) {
    event.preventDefault();
    const data = event.clipboardData;
    if (!data) return;

    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    this.handlers.paste({ html, text });
  }

  copy(event) {
    event.preventDefault();
    const payload = this.handlers.copy();
    if (!payload) return;
    event.clipboardData.setData('text/plain', payload.text);
    event.clipboardData.setData('text/html', payload.html);
  }

  cut(event) {
    this.copy(event);
    this.handlers.deleteSelection();
  }
}
