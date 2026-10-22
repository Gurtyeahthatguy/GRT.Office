/** Saving after a pause in changes. */

export const PAUSE_MS = 2000;
export const CEILING_MS = 30000;

/** Runs `save` after a pause in changes, at least every `ceiling`, one save at a time. */
export class AutoSave {
  /**
   * @param {() => Promise<void>} save
   * @param {{pause?: number, ceiling?: number, onError?: (err: unknown) => void}} options
   */
  constructor(save, { pause = PAUSE_MS, ceiling = CEILING_MS, onError = () => {} } = {}) {
    this.save = save;
    this.pause = pause;
    this.ceiling = ceiling;
    this.onError = onError;
    this.pauseTimer = null;
    this.ceilingTimer = null;
    this.dirty = false;
    this.running = null;
  }

  /** Whether a change is waiting to be saved. */
  get pending() {
    return this.dirty;
  }

  /** A change happened. */
  touch() {
    this.dirty = true;
    this.arm();
  }

  /** Saves now if anything is waiting; resolves once nothing is in flight. */
  async flush() {
    if (this.running) await this.running;
    if (this.dirty) await this.fire();
  }

  /** Forgets anything waiting, without saving it. */
  cancel() {
    this.dirty = false;
    this.disarm();
  }

  arm() {
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.fire();
    }, this.pause);
    if (this.ceilingTimer === null) {
      this.ceilingTimer = setTimeout(() => {
        this.ceilingTimer = null;
        this.fire();
      }, this.ceiling);
    }
  }

  disarm() {
    clearTimeout(this.pauseTimer);
    clearTimeout(this.ceilingTimer);
    this.pauseTimer = null;
    this.ceilingTimer = null;
  }

  /** Starts a save unless one is running; the running one re-arms when done. */
  fire() {
    if (this.running) return this.running;
    if (!this.dirty) return Promise.resolve();
    this.disarm();
    this.dirty = false;
    this.running = (async () => {
      try {
        await this.save();
      } catch (err) {
        this.dirty = true;
        this.onError(err);
      } finally {
        this.running = null;
        if (this.dirty) this.arm();
      }
    })();
    return this.running;
  }
}
