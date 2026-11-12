/**
 * Live preview for a list of styles or formats: each choice drawn as it looks, and shown on the document while the
 * pointer or the arrow keys rest on it, before it is chosen. The native select stays, hidden, as the value's keeper.
 */

/**
 * @param {HTMLSelectElement} select
 * @param {{look?: (value: string) => Object, preview: (value: string) => void, restore: () => void}} how
 * @returns {{refresh: Function}}
 */
export function livePreview(select, how) {
  const doc = select.ownerDocument;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'live-preview-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-label', select.getAttribute('aria-label') || select.title || 'Choose');
  button.title = select.title;
  select.after(button);
  select.classList.add('live-preview-hidden');
  select.tabIndex = -1;

  let list = null;
  let at = -1;
  let previewing = false;

  const options = () => [...select.options].filter((o) => !o.disabled && o.value !== '');

  function refresh() {
    const chosen = select.selectedOptions[0];
    button.textContent = chosen?.textContent ?? '';
  }

  function close(keep) {
    if (!list) return;
    list.remove();
    list = null;
    doc.removeEventListener('mousedown', outside, true);
    if (previewing && !keep) how.restore();
    previewing = false;
    button.setAttribute('aria-expanded', 'false');
  }

  function outside(event) {
    if (list && !list.contains(event.target) && event.target !== button) close(false);
  }

  function show(index) {
    const rows = [...list.children];
    at = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((row, i) => { row.classList.toggle('active', i === at); row.setAttribute('aria-selected', String(i === at)); });
    rows[at]?.scrollIntoView?.({ block: 'nearest' });
    how.preview(rows[at].dataset.value);
    previewing = true;
  }

  function choose(value) {
    close(true);
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else how.restore();
    refresh();
    button.focus();
  }

  function open() {
    if (list) { close(false); return; }
    list = doc.createElement('div');
    list.className = 'live-preview-list grt-menu';
    list.setAttribute('role', 'listbox');
    for (const option of options()) {
      const row = doc.createElement('div');
      row.setAttribute('role', 'option');
      row.dataset.value = option.value;
      row.textContent = option.textContent;
      Object.assign(row.style, how.look?.(option.value) ?? {});
      row.addEventListener('mouseenter', () => show([...list.children].indexOf(row)));
      row.addEventListener('mousedown', (event) => { event.preventDefault(); choose(option.value); });
      list.append(row);
    }
    const box = button.getBoundingClientRect();
    Object.assign(list.style, { position: 'fixed', left: `${box.left}px`, top: `${box.bottom + 2}px`, minWidth: `${box.width}px` });
    doc.body.append(list);
    doc.addEventListener('mousedown', outside, true);
    list.addEventListener('mouseleave', () => { if (previewing) { how.restore(); previewing = false; } });
    button.setAttribute('aria-expanded', 'true');
    at = options().findIndex((o) => o.value === select.value);
    [...list.children].forEach((row, i) => row.classList.toggle('active', i === at));
  }

  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', open);
  button.addEventListener('keydown', (event) => {
    if (!list && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); return; }
    if (!list) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(at + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter') { event.preventDefault(); const row = list.children[at]; if (row) choose(row.dataset.value); }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(false); }
  });
  // The program sets the select's value and options; the button follows.
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true });
  select.addEventListener('change', refresh);
  refresh();
  return { refresh };
}
