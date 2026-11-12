/**
 * The document inspector every program shares: what a file would carry to whoever receives it,
 * each kind with a box to leave it out of a clean copy. The document itself is not changed.
 */

import { showPanel, readFields, escapeHtml } from './panel.js';

/**
 * Shows what the document carries and asks what a clean copy leaves out.
 * @param {{id: string, label: string, count: number, detail?: string, keep?: boolean}[]} findings
 * @returns {Promise<?string[]>} the ids to leave out, or null when cancelled or nothing was found
 */
export async function inspect(findings, { toast } = {}) {
  const present = findings.filter((f) => f.count > 0);
  if (present.length === 0) {
    toast?.('The inspector found nothing hidden or personal to leave out');
    return null;
  }
  const rows = present.map((f) => `
    <div class="setting inspector-row">
      <span class="label"><strong>${escapeHtml(f.label)}</strong>: ${f.count}${f.detail ? `<br><span class="hint">${escapeHtml(f.detail)}</span>` : ''}</span>
      <input type="checkbox" data-field="out-${escapeHtml(f.id)}"${f.keep ? '' : ' checked'} aria-label="Leave out ${escapeHtml(f.label)}" />
    </div>`).join('');
  const confirmed = await showPanel('Document inspector', `
    <p>What this document carries to whoever receives a copy. Ticked kinds are left out of the clean copy.</p>
    ${rows}
    <p class="hint">GRT never writes author names, dates or editing time into files. The document stays as it is; only the copy is cleaned.</p>`, 'Write a clean copy…');
  if (!confirmed) return null;
  const fields = readFields();
  return present.filter((f) => fields[`out-${f.id}`]).map((f) => f.id);
}
