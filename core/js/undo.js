/** Generic command stack. */

export class UndoStack {
  /**
   * @param {{snapshot: Function, restore: Function}} subject
   * @param {number} [limit=100] older states are dropped past this
   */
  constructor(subject, limit = 100) {
    this.subject = subject;
    this.limit = limit;
    this.past = [];
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /**
   * Records the state as it is BEFORE a change, then runs the change.
   * @param {Function} mutate
   */
  do(mutate) {
    const before = this.subject.snapshot();
    mutate();
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    // Any redo history stops being reachable once a new change is made.
    this.future.length = 0;
  }

  undo() {
    if (!this.canUndo) return false;
    this.future.push(this.subject.snapshot());
    this.subject.restore(this.past.pop());
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.past.push(this.subject.snapshot());
    this.subject.restore(this.future.pop());
    return true;
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
  }
}
