/** Formulas in notes: typed as TeX, drawn while typing, kept in the Markdown as `$…$`. */

import { OBJECT } from './core/editor/model.js';
import { insertObject, objectAt } from './core/editor/commands.js';
import { fromDom, point, collapsed } from './core/editor/selection.js';
import { formulaDialog } from './core/formula-dialog.js';

export async function insertFormula(editor) {
  editor.readSelection();
  const at = editor.selection;
  const object = await formulaDialog();
  if (!object || !at) return;
  editor.selection = at;
  editor.edit(() => insertObject(editor.model, editor.selection, object));
}

/** Edits the formula that was clicked. */
export async function editFormula(editor, holder) {
  const char = holder.querySelector('.object-char')?.firstChild;
  const at = char ? fromDom(editor.surface, { rangeCount: 1, anchorNode: char, anchorOffset: 0, focusNode: char, focusOffset: 0 })?.anchor : null;
  const object = at ? objectAt(editor.model, at) : null;
  if (object?.type !== 'math') return;
  const next = await formulaDialog(object);
  if (!next) return;
  editor.edit(() => {
    object.tex = next.tex;
    if (next.display) object.display = true; else delete object.display;
    delete object.mathml;
    return collapsed(point(at.blockId, at.offset + 1, at.itemIndex));
  });
}

export { OBJECT };
