/** The properties sidebar: what is selected and its properties, changed in place, in every program the same way. */

import { livePreview } from './live-preview.js';

const escape = (text) => String(text ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** One field's control, by kind: number, text, select, colour or checkbox. */
function control(field, id) {
  const value = field.value ?? '';
  const common = `data-prop="${id}"${field.disabled ? ' disabled' : ''} aria-label="${escape(field.label)}"`;
  switch (field.kind) {
    case 'number':
      return `<input type="number" ${common} value="${escape(value)}"${field.min !== undefined ? ` min="${field.min}"` : ''}${field.max !== undefined ? ` max="${field.max}"` : ''}${field.step !== undefined ? ` step="${field.step}"` : ''}>`;
    case 'select':
      return `<select ${common}>${(field.options ?? []).map(([v, l]) => `<option value="${escape(v)}"${String(v) === String(value) ? ' selected' : ''}>${escape(l)}</option>`).join('')}</select>`;
    case 'color':
      return `<input type="color" ${common} value="${escape(/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000')}">`;
    case 'buttons':
      // A few choices shown at once, so one click chooses.
      return `<span class="choices" role="radiogroup" aria-label="${escape(field.label)}">${(field.options ?? []).map(([v, l]) => `<button type="button" role="radio" data-prop="${id}" data-value="${escape(v)}" aria-checked="${String(v) === String(value)}"${String(v) === String(value) ? ' class="active"' : ''}>${escape(l)}</button>`).join('')}</span>`;
    case 'checkbox':
      return `<input type="checkbox" ${common}${value ? ' checked' : ''}>`;
    case 'textarea':
      return `<textarea rows="3" ${common}>${escape(value)}</textarea>`;
    default:
      return `<input ${common} value="${escape(value)}">`;
  }
}

/**
 * Puts the sidebar in `host`.
 * @param {HTMLElement} host
 * @param {() => {title: string, fields: {label: string, kind?: string, value?: any, options?: [any, string][], apply: (value: any) => void, row?: string}[]}[]} describe
 *   the sections for what is selected now; an empty list says nothing is
 * @returns {{refresh: () => void}}
 */
export function createProperties(host, describe) {
  host.classList.add('grt-properties');
  host.setAttribute('role', 'complementary');
  host.setAttribute('aria-label', 'Properties');
  let fields = [];
  let editing = false;

  function refresh() {
    // A field being typed into is not redrawn under the cursor.
    if (editing && host.contains(document.activeElement) && document.activeElement.matches('input:not([type="checkbox"]), textarea')) return;
    const sections = describe() ?? [];
    fields = sections.flatMap((s) => s.fields);
    if (!sections.length) {
      host.innerHTML = '<p class="empty">Select something to see its properties here.</p>';
      return;
    }
    let index = 0;
    host.innerHTML = sections.map((section) => {
      const groups = [];
      for (const field of section.fields) {
        const id = index++;
        const html = field.kind === 'checkbox'
          ? `<label class="inline">${control(field, id)} ${escape(field.label)}</label>`
          : `<label>${escape(field.label)}${control(field, id)}</label>`;
        const last = groups[groups.length - 1];
        if (field.row && last?.row === field.row) last.html.push(html);
        else groups.push({ row: field.row, html: [html] });
      }
      return `<section><h3>${escape(section.title)}</h3>${groups.map((g) => (g.row ? `<div class="row">${g.html.join('')}</div>` : g.html.join(''))).join('')}</section>`;
    }).join('');
    // A list that can show its choices on the document before one is chosen does so.
    fields.forEach((field, i) => {
      if (field.kind !== 'select' || !field.preview) return;
      const select = host.querySelector(`select[data-prop="${i}"]`);
      if (select) livePreview(select, { look: field.look, preview: field.preview, restore: field.restore ?? (() => {}) });
    });
  }

  const valueOf = (input) => {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number') return input.value === '' ? null : Number(input.value);
    return input.value;
  };

  host.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-prop][data-value]');
    if (!button) return;
    const field = fields[Number(button.dataset.prop)];
    if (field) field.apply(button.dataset.value);
  });

  // Text applies when it is left or Enter is pressed; choices apply at once.
  host.addEventListener('change', (event) => {
    const input = event.target.closest('[data-prop]');
    if (!input) return;
    const field = fields[Number(input.dataset.prop)];
    editing = false;
    if (field) field.apply(valueOf(input));
  });
  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-prop]');
    if (input && (input.type === 'color' || input.tagName === 'SELECT')) return;
    editing = true;
  });
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input[data-prop]')) event.target.blur();
    // Keys typed here are not shortcuts of the document behind.
    event.stopPropagation();
  });

  refresh();
  return { refresh };
}
