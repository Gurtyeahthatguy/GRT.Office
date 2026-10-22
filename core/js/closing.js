/** Closing a window whose work saves itself: the last save is finished first. */

import { CLOSE_REQUESTED } from './keeper.js';
import { showChoice, isDialogOpen, escapeHtml } from './panel.js';

const message = (err) => err?.message ?? String(err);

/**
 * pending()  whether something is not on disk yet
 * flush()    writes it now; resolves true when everything was written
 */
export class SaveBeforeClose {
  constructor({ pending, flush, toast = () => {} }) {
    // The bridge of the page that made this, and no later one.
    this.bridge = window.__TAURI__;
    this.pending = pending;
    this.flush = flush;
    this.toast = toast;
    this.held = false;
    this.asking = false;
  }

  invoke(...args) {
    return this.bridge.core.invoke(...args);
  }

  async start() {
    await this.bridge.event.listen(CLOSE_REQUESTED, () => this.closeRequested());
    this.update();
  }

  /** Holds the window while something is pending; call after every change and save. */
  update() {
    const held = !!this.pending();
    if (held === this.held) return;
    this.held = held;
    this.invoke('set_close_guard', { held }).catch(() => {});
  }

  async closeRequested() {
    this.invoke('close_ack').catch(() => {});
    if (this.asking) return;
    if (isDialogOpen()) {
      this.toast('Close the open panel first');
      return;
    }
    this.asking = true;
    try {
      let problem = null;
      try {
        if (await this.flush()) {
          await this.invoke('close_window');
          return;
        }
      } catch (err) {
        problem = message(err);
      }
      const choice = await showChoice(
        'Close without saving?',
        `<p>The last changes could not be saved${problem ? `: ${escapeHtml(problem)}` : ''}.
         Closing now loses them.</p>`,
        [
          { id: 'cancel', label: 'Cancel', primary: true },
          { id: 'close', label: 'Close anyway' },
        ],
      );
      if (choice === 'close') await this.invoke('close_window');
    } catch (err) {
      this.toast(`Could not close: ${message(err)}`, true);
    } finally {
      this.asking = false;
      this.update();
    }
  }
}
