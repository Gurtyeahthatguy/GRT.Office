/** The in-place editing loop. */

/**
 * Starts editing `node` in place.
 * @param {HTMLElement} node
 * @param {object} options
 * @param {string} options.className     marks the node as being edited
 * @param {() => void} options.seed      writes the current value into the node
 * @param {() => any} options.read       reads the value back out of the node
 * @param {(value: any) => boolean} options.changed
 * @param {(value: any) => void} options.commit  applies the change and records undo
 * @param {() => void} options.after     always runs at the end, kept or not
 * @param {(event: KeyboardEvent, finish: (keep: boolean) => void) => boolean}
 *        [options.keys]                 module-specific keys; true if handled
 * @param {boolean} [options.selectAll]  put the caret past the whole text
 * @returns {(keep: boolean) => void}    finishes the edit from outside
 */
export function editInPlace(node, {
  className, seed, read, changed, commit, after, keys = () => false, selectAll = false,
}) {
  node.classList.add(className);
  node.contentEditable = 'true';
  seed();
  node.focus();

  if (selectAll) {
    const selection = window.getSelection();
    selection.selectAllChildren(node);
    selection.collapseToEnd();
  }

  // Blur fires while the edit is being torn down.
  let finished = false;

  const finish = (keep) => {
    if (finished) return;
    finished = true;

    node.removeEventListener('keydown', onKey);
    node.removeEventListener('blur', onBlur);
    node.contentEditable = 'false';
    node.classList.remove(className);

    if (keep) {
      const value = read();
      // An edit that changed nothing records nothing.
      if (changed(value)) commit(value);
    }
    after();
  };

  function onKey(event) {
    // The document's own shortcuts must not fire while a caret is in a node.
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
      return;
    }
    keys(event, finish);
  }

  const onBlur = () => finish(true);

  node.addEventListener('keydown', onKey);
  node.addEventListener('blur', onBlur);

  return finish;
}
