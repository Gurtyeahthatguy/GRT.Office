/** The modal panel and the forms shown in it. */

import { THEMES } from './core/theme.js';
import { showPanel, readFields, isDialogOpen, escapeHtml } from './core/panel.js';

// The panel itself lives in the shared core; this module contributes the
// forms that go inside it.
export { showPanel, readFields, isDialogOpen };

const ui = {
  overlay: () => el('overlay'),
  title: () => el('panel-title'),
  body: () => el('panel-body'),
  cancel: () => el('panel-cancel'),
  confirm: () => el('panel-confirm'),
};

// Form builders

export function stampForm(current) {
  const w = current.watermark ?? {};
  const n = current.pageNumbers ?? {};
  return `
    <h3 class="form-heading">Watermark</h3>
    <div class="form-grid">
      <label for="wm-text">Text</label>
      <input id="wm-text" type="text" data-field="watermarkText"
             value="${escape(w.text)}" placeholder="leave empty for none" />
      <label for="wm-opacity">Opacity</label>
      <input id="wm-opacity" type="number" data-field="watermarkOpacity"
             min="0.02" max="1" step="0.02" value="${w.opacity ?? 0.18}" />
    </div>

    <h3 class="form-heading">Page numbers</h3>
    <div class="form-grid">
      <label for="pn-on">Add them</label>
      <input id="pn-on" type="checkbox" data-field="numbersOn" ${n.enabled ? 'checked' : ''} />
      <label for="pn-format">Format</label>
      <input id="pn-format" type="text" data-field="numbersFormat"
             value="${escape(n.format ?? '{n}')}" />
      <label for="pn-start">Start at</label>
      <input id="pn-start" type="number" data-field="numbersStart"
             min="0" step="1" value="${n.start ?? 1}" />
      <label for="pn-position">Position</label>
      <select id="pn-position" data-field="numbersPosition">
        ${['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left']
    .map((p) => `<option value="${p}"${(n.position ?? 'bottom-center') === p ? ' selected' : ''}>${p.replace('-', ' ')}</option>`)
    .join('')}
      </select>
    </div>
    <p class="fp-note">
      <code>{n}</code> is the page number and <code>{total}</code> the count.
      Both are drawn at save time using a standard PDF font, so no font program
      is embedded in the file.
    </p>
  `;
}

export function cropForm(pageCount) {
  return `
    <p class="fp-note" style="margin-top:0">
      Margins to trim, as a percentage of each side. Applies to
      ${pageCount === 1 ? 'the current page' : `${pageCount} selected pages`}.
    </p>
    <div class="form-grid">
      <label for="crop-top">Top %</label>
      <input id="crop-top" type="number" data-field="top" min="0" max="45" step="1" value="0" />
      <label for="crop-bottom">Bottom %</label>
      <input id="crop-bottom" type="number" data-field="bottom" min="0" max="45" step="1" value="0" />
      <label for="crop-left">Left %</label>
      <input id="crop-left" type="number" data-field="left" min="0" max="45" step="1" value="0" />
      <label for="crop-right">Right %</label>
      <input id="crop-right" type="number" data-field="right" min="0" max="45" step="1" value="0" />
    </div>
    <p class="fp-note">
      Cropping hides material without deleting it — the content stays in the
      file, outside the visible box. To remove something permanently, delete
      the page instead.
    </p>
  `;
}

export function metadataForm(current = {}) {
  const field = (id, key, label) => `
      <label for="${id}">${label}</label>
      <input id="${id}" type="text" data-field="${key}" value="${escape(current[key])}" />`;
  return `
    <p class="fp-note" style="margin-top:0">
      Metadata is cleared on every save. Anything typed here is written back
      afterwards, deliberately. Leave a field empty to keep it empty.
    </p>
    <div class="form-grid">
      ${field('md-title', 'title', 'Title')}
      ${field('md-author', 'author', 'Author')}
      ${field('md-subject', 'subject', 'Subject')}
      ${field('md-keywords', 'keywords', 'Keywords')}
      ${field('md-creator', 'creator', 'Creator')}
      ${field('md-producer', 'producer', 'Producer')}
    </div>
    <p class="fp-note">
      Dates stay at the Unix epoch whatever is set here: a real timestamp would
      say when the file was made and, through the time zone, roughly where.
    </p>
  `;
}

export function splitForm(pageCount) {
  return `
    <p class="fp-note" style="margin-top:0">
      Writes several files into a folder you choose. ${pageCount} pages in
      total.
    </p>
    <div class="form-grid">
      <label for="split-size">Pages per file</label>
      <input id="split-size" type="number" data-field="size" min="1" step="1"
             value="1" max="${pageCount}" />
      <label for="split-prefix">Name prefix</label>
      <input id="split-prefix" type="text" data-field="prefix" value="part" />
    </div>
    <p class="fp-note">
      Each file is built through the same pipeline as a normal save: rebuilt
      from scratch, metadata cleared.
    </p>
  `;
}

export function settingsForm(current, canPersist) {
  const option = (value, label, selected) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;

  return `
    <div class="setting">
      <span class="label">Theme
        <span class="hint">System follows the desktop, live. The rest are
        fixed whatever the desktop does.</span>
      </span>
      <select data-field="theme">
        ${THEMES.map((t) => option(t.id, t.label, current.theme)).join('')}
      </select>
    </div>

    <div class="setting">
      <span class="label">Show thumbnails
        <span class="hint">The page sidebar. Hiding it also stops them rendering.</span>
      </span>
      <input type="checkbox" data-field="showThumbnails" ${current.showThumbnails ? 'checked' : ''} />
    </div>

    <div class="setting">
      <span class="label">Zoom when opening</span>
      <select data-field="openZoom">
        ${option('fit', 'Fit width', current.openZoom)}
        ${option('actual', 'Actual size', current.openZoom)}
      </select>
    </div>

    <div class="setting">
      <span class="label">Fingerprint before saving
        <span class="hint">Shows what the file will contain, and waits for
        approval. Turning this off saves without asking.</span>
      </span>
      <input type="checkbox" data-field="fingerprintBeforeSave" ${current.fingerprintBeforeSave ? 'checked' : ''} />
    </div>

    <p class="fp-note">
      ${canPersist
    ? `Stored as a single settings.json holding these four values. There is no
       record of which documents were opened — no recent-files list, no
       history — so the file says how the window looks and nothing about you.`
    : `<strong>Ephemeral mode:</strong> changes apply now but are not written to
       disk, and nothing stored previously is being read.`}
    </p>
  `;
}
