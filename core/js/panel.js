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
      // A field that reads keys for itself, such as one recording a shortcut, keeps them.
      if (event.target?.closest?.('[data-keeps-keys]')) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(false);
      } else if (event.key === 'Enter' && confirmLabel
        && (!(event.target instanceof HTMLTextAreaElement) || (event.target.dataset.enterConfirms !== undefined && !event.shiftKey))) {
        // A text box that says so takes Enter as OK, and Shift+Enter as a new line.
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
      // A field that reads keys for itself, such as one recording a shortcut, keeps them.
      if (event.target?.closest?.('[data-keeps-keys]')) return;
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
    else if (field.type === 'radio') {
      // A radio with a value of its own names the choice made; one without says whether it is the one chosen.
      if (!field.hasAttribute('value')) values[key] = field.checked;
      else if (field.checked) values[key] = field.value;
    }
    else if (field.type === 'number') values[key] = Number(field.value);
    else values[key] = field.value;
  }
  return values;
}

/** Escapes text for insertion into a form built as a string. */
export const escapeHtml = (value) => String(value ?? '')
  .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

let tabsWired = false;

/**
 * A form whose parts begin with an h3 of class form-heading, shown as tabs, as LibreOffice's dialogs are; every field stays in the form, so readFields reads them all.
 * @param {string} html
 */
export function tabbed(html) {
  const parts = String(html).split(/(?=<h3 class="form-heading">)/);
  const sections = parts.filter((p) => p.startsWith('<h3 class="form-heading">'));
  if (sections.length < 2) return html;
  const lead = parts[0].startsWith('<h3 class="form-heading">') ? '' : parts[0];
  const title = (part) => /<h3 class="form-heading">([\s\S]*?)<\/h3>/.exec(part)?.[1] ?? '';
  const body = (part) => part.replace(/<h3 class="form-heading">[\s\S]*?<\/h3>/, '');
  if (!tabsWired) {
    tabsWired = true;
    document.addEventListener('click', (event) => {
      const tab = event.target.closest?.('.grt-tabs [role="tab"]');
      if (!tab) return;
      const box = tab.closest('.grt-tabbed');
      for (const t of box.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', String(t === tab));
      for (const p of box.querySelectorAll('[role="tabpanel"]')) p.hidden = p.id !== tab.getAttribute('aria-controls');
    });
    document.addEventListener('keydown', (event) => {
      const tab = event.target.closest?.('.grt-tabs [role="tab"]');
      if (!tab || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const all = [...tab.parentElement.querySelectorAll('[role="tab"]')];
      const next = all[(all.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      next.focus();
      next.click();
      event.preventDefault();
    });
  }
  const key = `t${Math.random().toString(36).slice(2, 8)}`;
  return `${lead}<div class="grt-tabbed"><div class="grt-tabs" role="tablist">${sections.map((part, i) => `<button type="button" role="tab" id="${key}-tab${i}" aria-controls="${key}-${i}" aria-selected="${i === 0}">${title(part)}</button>`).join('')}</div>`
    + `${sections.map((part, i) => `<div role="tabpanel" id="${key}-${i}" aria-labelledby="${key}-tab${i}"${i ? ' hidden' : ''}>${body(part)}</div>`).join('')}</div>`;
}
