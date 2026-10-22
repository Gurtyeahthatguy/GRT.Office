/** Keeping a document's unsaved work: autosave, recovery copies, closing. */

import { AutoSave } from './autosave.js';
import { showChoice, isDialogOpen, escapeHtml } from './panel.js';

export const CLOSE_REQUESTED = 'grt://close-requested';

/** Where autosave puts unsaved work. */
export const MODES = [
  { id: 'recovery', label: 'In a recovery copy, until you save' },
  { id: 'file', label: 'Onto the file itself' },
];

export const isMode = (value) => MODES.some((mode) => mode.id === value);

const message = (err) => err?.message ?? String(err);

/**
 * Autosave and recovery for one program, through its host:
 *
 * host.name()            what the document is called
 * host.path()            where it is saved, or null
 * host.canSaveInPlace()  whether "onto the file" may write it now: a native
 *                        document that has a path
 * host.writeCopy(path)   writes the whole document to a path
 * host.save(options)     a normal save, or with {silent: true} one that asks
 *                        nothing and reports nothing; resolves false if not saved
 * host.openRecovered(file, meta)  loads a recovered copy, unsaved
 * host.settle()          optional: finishes an edit still being typed
 */
export class Keeper {
  constructor(host, { program, extension, toast = () => {}, pause, ceiling }) {
    // The bridge of the page that made this keeper, and no later one.
    this.bridge = window.__TAURI__;
    this.host = host;
    this.program = program;
    this.extension = extension;
    this.toast = toast;
    this.mode = 'recovery';
    this.slot = null;
    this.held = false;
    this.asking = false;
    this.model = null;
    this.revision = 0;
    this.auto = new AutoSave(() => this.keep(), {
      pause,
      ceiling,
      onError: (err) => this.toast(`Autosave failed: ${message(err)}`, true),
    });
  }

  invoke(...args) {
    return this.bridge.core.invoke(...args);
  }

  isDirty() {
    return !!this.model?.dirty;
  }

  /** Starts keeping; true when it reopened a recovered document. */
  async start({ ephemeral = false, mode = 'recovery', initialFile = null } = {}) {
    this.setMode(mode);
    await this.bridge.event.listen(CLOSE_REQUESTED, () => this.closeRequested());
    if (ephemeral) return false;
    try {
      this.slot = await this.invoke('recovery_begin', { extension: this.extension });
    } catch (err) {
      this.slot = null;
      this.toast(`Recovery copies are unavailable: ${message(err)}`, true);
      return false;
    }
    if (!this.slot) return false;
    return this.offerOrphans(initialFile);
  }

  setMode(mode) {
    this.mode = isMode(mode) ? mode : 'recovery';
  }

  /** Follows a document model. */
  watch(model) {
    this.model = model;
    let dirty = !!model.dirty;
    Object.defineProperty(model, 'dirty', {
      configurable: true,
      enumerable: true,
      get: () => dirty,
      set: (value) => {
        dirty = !!value;
        if (this.model !== model) return;
        if (dirty) this.revision += 1;
        this.changed();
      },
    });
    this.auto.cancel();
    this.changed();
  }

  /** Called when the document changed, or was saved. */
  changed() {
    const dirty = this.isDirty();
    this.guard(dirty);
    if (dirty) this.auto.touch();
  }

  guard(held) {
    if (held === this.held) return;
    this.held = held;
    this.invoke('set_close_guard', { held }).catch(() => {});
  }

  /**
   * After a successful save: nothing is left to keep, unless a change arrived
   * while it wrote, which is then kept like any other.
   */
  async saved() {
    if (this.isDirty()) return;
    this.auto.cancel();
    this.guard(false);
    await this.discardCopy();
  }

  async discardCopy() {
    if (!this.slot) return;
    try {
      await this.invoke('recovery_discard');
    } catch (err) {
      this.toast(`Could not remove the recovery copy: ${message(err)}`, true);
    }
  }

  /** The autosave itself. */
  async keep() {
    if (!this.isDirty()) return;
    if (this.mode === 'file' && this.host.canSaveInPlace()) {
      let saved;
      try {
        saved = await this.host.save({ silent: true });
      } catch (err) {
        await this.writeCopy();
        throw err;
      }
      if (saved) {
        if (!this.isDirty()) await this.discardCopy();
        return;
      }
    }
    await this.writeCopy();
  }

  async writeCopy() {
    if (!this.slot || !this.isDirty()) return;
    await this.host.writeCopy(this.slot.path);
    await this.invoke('recovery_saved', {
      meta: { path: this.host.path() ?? null, name: this.host.name() },
    });
  }

  /**
   * Before the document is dropped, by closing, New or Open: resolves true
   * when it is fine to go on.
   */
  async confirmLeave() {
    this.host.settle?.();
    if (!this.isDirty()) return true;
    if (this.mode === 'file' && this.host.canSaveInPlace()) {
      await this.auto.flush();
      if (!this.isDirty()) return true;
      if (await this.host.save({ silent: true }) && !this.isDirty()) return true;
    }
    const choice = await showChoice(
      `Save changes to “${this.host.name()}”?`,
      '<p>Changes that are not saved will be lost.</p>',
      [
        { id: 'discard', label: 'Don’t save' },
        { id: 'cancel', label: 'Cancel' },
        { id: 'save', label: 'Save', primary: true },
      ],
    );
    if (choice === 'save') {
      return (await this.host.save()) && !this.isDirty();
    }
    if (choice === 'discard') {
      this.auto.cancel();
      await this.discardCopy();
      this.guard(false);
      return true;
    }
    return false;
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
      if (await this.confirmLeave()) await this.invoke('close_window');
    } catch (err) {
      this.toast(`Could not close: ${message(err)}`, true);
    } finally {
      this.asking = false;
    }
  }

  /** Offers back the work of a run that ended without closing properly. */
  async offerOrphans(initialFile) {
    let orphans;
    try {
      orphans = await this.invoke('recovery_list');
    } catch {
      return false;
    }
    if (!Array.isArray(orphans)) return false;
    const candidates = initialFile
      ? orphans.filter((orphan) => orphan.meta?.path === initialFile)
      : orphans;
    const orphan = candidates[0];
    if (!orphan) return false;

    const name = orphan.meta?.name || 'Untitled';
    const choice = await showChoice(
      `Recover “${name}”?`,
      `<p>${escapeHtml(this.program)} closed before these changes were saved.
       They were kept in a recovery copy.</p>
       <p>Discard deletes that copy for good.</p>`,
      [
        { id: 'discard', label: 'Discard' },
        { id: 'later', label: 'Later' },
        { id: 'recover', label: 'Recover', primary: true },
      ],
    );

    if (choice === 'discard') {
      await this.invoke('recovery_remove', { id: orphan.id }).catch((err) => {
        this.toast(`Could not discard the copy: ${message(err)}`, true);
      });
      return false;
    }
    if (choice !== 'recover') return false;

    try {
      await this.host.openRecovered(orphan.path, orphan.meta ?? {});
    } catch (err) {
      this.toast(`Could not recover ${name}: ${message(err)}`, true);
      return false;
    }
    try {
      await this.writeCopy();
      await this.invoke('recovery_remove', { id: orphan.id });
    } catch (err) {
      this.toast(`Recovered, but the old copy remains: ${message(err)}`, true);
    }
    const left = orphans.length - 1;
    if (left > 0) {
      this.toast(`${left} more unsaved document${left === 1 ? '' : 's'} will be offered next time`);
    }
    return true;
  }
}
