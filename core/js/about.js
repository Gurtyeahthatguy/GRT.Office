/** About and Licences: what the program is, what it never does, and whose code it carries. */

import { showPanel, escapeHtml } from './panel.js';

const THIRD_PARTY = [
  ['pdf-lib', '1.17.1', 'MIT', 'writing and reading PDF files, with a limit on unpacked streams'],
  ['PDF.js', '6.5.438', 'Apache-2.0', 'showing PDF files, in Read; its script engine is left out'],
  ['markdown-it', '15.0.3', 'MIT', 'reading Markdown'],
  ['MathJax', '3.2.2', 'Apache-2.0', 'drawing formulas, in Paper, Slides and Notes'],
  ['Tauri', '2', 'MIT or Apache-2.0', 'the window and the bridge to the system'],
  ['SQLite', '3', 'public domain', 'the databases of Tables'],
  ['RustCrypto', '', 'MIT or Apache-2.0', 'passwords and encryption'],
];

export function aboutDialog({ name, version }) {
  return showPanel(`About ${name}`, `
    <p><strong>${escapeHtml(name)}</strong> ${escapeHtml(version ?? '')}, part of the GRT Suite.</p>
    <p>It never connects to the network: no updates checked, no telemetry, no fonts or pictures fetched.
    It keeps no list of recent files, and what it saves names no one.</p>
    <p class="hint">GRT is free software under the MIT licence. Its code is published by GRT Project.</p>`);
}

export function licencesDialog({ name }) {
  return showPanel('Licences', `
    <p>${escapeHtml(name)} is under the MIT licence. It carries this code of others, each under its own licence:</p>
    <table class="fp-table"><tr><th>Library</th><th>Version</th><th>Licence</th><th>What for</th></tr>
      ${THIRD_PARTY.map(([lib, v, licence, what]) => `<tr><td>${escapeHtml(lib)}</td><td>${escapeHtml(v)}</td><td>${escapeHtml(licence)}</td><td>${escapeHtml(what)}</td></tr>`).join('')}
    </table>
    <p class="hint">The full texts come with the program, beside the libraries they cover.</p>`);
}
