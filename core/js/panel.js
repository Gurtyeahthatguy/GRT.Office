/** The one modal dialog every module reuses. */

const el = (id) => document.getElementById(id);

let open = false;

export function isDialogOpen() {
  return open;
}

/**
 * Shows the panel and resolves to true if the user confirmed.
 * @param {string} title
 * @param {string} html
 * @param {?string} confirmLabel null shows only a Close button
 * @returns {Promise<boolean>}
 */
export function showPanel(title, html, confirmLabel = null) {
  el('panel-title').textContent = title;
  el('panel-body').innerHTML = html;
  el('overlay').classList.remove('hidden');
  el('panel-confirm').classList.toggle('hidden', confirmLabel === null);
  if (confirmLabel) el('panel-confirm').textContent = confirmLabel;
  open = true;

  el('panel-body').querySelector('input, select, textarea')?.focus();

  return new Promise((resolve) => {
    const close = (result) => {
      el('overlay').classList.add('hidden');
      el('panel-confirm').onclick = null;
      el('panel-cancel').onclick = null;
      document.removeEventListener('keydown', onKey, true);
      open = false;
      resolve(result);
    };

    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(false);
      } else if (event.key === 'Enter' && confirmLabel
        && !(event.target instanceof HTMLTextAreaElement)) {
        event.stopPropagation();
        close(true);
      }
    }

    document.addEventListener('keydown', onKey, true);
    el('panel-confirm').onclick = () => close(true);
    el('panel-cancel').onclick = () => close(false);
  });
}

/** Reads the panel's current field values. */
export function readFields() {
  const values = {};
  for (const field of el('panel-body').querySelectorAll('[data-field]')) {
    const key = field.dataset.field;
    if (field.type === 'checkbox') values[key] = field.checked;
    else if (field.type === 'number') values[key] = Number(field.value);
    else values[key] = field.value;
  }
  return values;
}

/** Escapes text for insertion into a form built as a string. */
export const escapeHtml = (value) => String(value ?? '')
  .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
