/** The one modal dialog every module reuses. */

const el = (id) => document.getElementById(id);

let open = false;

/** Puts a form in the panel, emptied first so that no field keeps an old value. */
function fill(html) {
  el('panel-body').replaceChildren();
  el('panel-body').innerHTML = html;
}

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
  fill(html);
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

/**
 * Shows the panel with one button per choice and resolves to the chosen id,
 * or null when it is dismissed with Escape.
 * @param {string} title
 * @param {string} html
 * @param {{id: string, label: string, primary?: boolean}[]} choices
 * @returns {Promise<?string>}
 */
export function showChoice(title, html, choices) {
  el('panel-title').textContent = title;
  fill(html);
  const actions = el('panel-confirm').parentElement;
  const original = [...actions.children];
  const buttons = choices.map((choice) => {
    const button = document.createElement('button');
    button.textContent = choice.label;
    button.dataset.choice = choice.id;
    if (choice.primary) button.className = 'primary';
    return button;
  });
  actions.replaceChildren(...buttons);
  el('overlay').classList.remove('hidden');
  open = true;
  const primary = choices.find((choice) => choice.primary);
  (buttons.find((b) => b.dataset.choice === primary?.id) ?? buttons[0])?.focus();

  return new Promise((resolve) => {
    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      actions.replaceChildren(...original);
      el('overlay').classList.add('hidden');
      open = false;
      resolve(result);
    };

    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      } else if (event.key === 'Enter' && primary && !(event.target instanceof HTMLButtonElement)) {
        event.stopPropagation();
        close(primary.id);
      }
    }

    document.addEventListener('keydown', onKey, true);
    for (const button of buttons) {
      button.onclick = () => close(button.dataset.choice);
    }
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
