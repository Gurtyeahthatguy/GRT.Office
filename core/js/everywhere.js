/** Search everywhere: the words of the GRT documents in a folder the person chose, found from an index kept with the program's data. */

import { showPanel } from './panel.js';
import { copy } from './honest-links.js';

const { invoke } = window.__TAURI__?.core ?? {};

export const PROGRAMS = { paper: 'GRT Paper', grid: 'GRT Grid', slides: 'GRT Slides', graphs: 'GRT Graphs', notes: 'GRT Notes', tables: 'GRT Tables' };

/** A snippet with its found words marked, as nodes; the text is never read as markup. */
export function snippetNodes(snippet) {
  const out = [];
  for (const piece of String(snippet ?? '').split(/(<<[^]*?>>)/)) {
    if (!piece) continue;
    if (piece.startsWith('<<') && piece.endsWith('>>')) {
      const mark = document.createElement('mark');
      mark.textContent = piece.slice(2, -2);
      out.push(mark);
    } else out.push(document.createTextNode(piece));
  }
  return out;
}

const baseName = (path) => String(path).split(/[/\\]/).pop();

/**
 * @param {{kind: string, open: (path: string) => any, toast?: (text: string) => void}} options
 *   `kind` is the program's own kind of document, which `open` opens; others are named and their path copied.
 */
export async function searchEverywhere({ kind, open, toast = () => {} }) {
  let folder = null;
  try {
    folder = await invoke('everywhere_folder');
  } catch (error) {
    toast(`Cannot open the search index: ${error}`);
    return;
  }
  let locked = [];
  let sealedHits = [];
  let round = 0;
  let timer = null;

  const closed = showPanel('Search Everywhere', `
    <div class="everywhere-folder"><span data-ev="folder" class="hint"></span><button type="button" data-ev="choose">Choose Folder…</button></div>
    <label>Find<input data-ev="query" type="search" maxlength="500" placeholder="Words in any GRT document of the folder" autocomplete="off" /></label>
    <p class="hint" data-ev="state"></p>
    <div class="everywhere-list" data-ev="list" role="list"></div>
    <div class="everywhere-locked hidden" data-ev="locked">
      <p class="hint" data-ev="locked-note"></p>
      <label>Password<input data-ev="password" type="password" autocomplete="off" maxlength="1000" /></label>
      <button type="button" data-ev="unlock">Search the Protected Ones</button>
    </div>
    <p class="hint">The index stays with this program's data, never in a temporary place, and holds nothing of a protected document.
      <button type="button" data-ev="forget">Delete the Index</button></p>`, null);

  const body = document.getElementById('panel-body');
  const at = (name) => body.querySelector(`[data-ev="${name}"]`);
  const close = () => document.getElementById('panel-cancel').click();

  function drawFolder() {
    at('folder').textContent = folder ?? 'No folder chosen yet.';
    at('query').disabled = !folder;
  }

  function drawLocked() {
    at('locked').classList.toggle('hidden', locked.length === 0);
    at('locked-note').textContent = `${locked.length} protected document(s) are not in the index. With their password they are searched now, and nothing found is kept.`;
  }

  function drawHits(hits) {
    const rows = [...sealedHits, ...hits].map((hit) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'everywhere-hit';
      row.setAttribute('role', 'listitem');
      row.dataset.path = hit.path;
      row.dataset.kind = hit.kind;
      const name = document.createElement('strong');
      name.textContent = baseName(hit.path).replace(/\.grt$/i, '');
      const program = document.createElement('span');
      program.className = 'hint';
      program.textContent = ` ${PROGRAMS[hit.kind] ?? 'GRT document'}${hit.locked ? ' · protected' : ''}`;
      const snippet = document.createElement('span');
      snippet.className = 'everywhere-snippet';
      snippet.append(...snippetNodes(hit.snippet));
      const where = document.createElement('span');
      where.className = 'hint everywhere-path';
      where.textContent = hit.path;
      row.append(name, program, snippet, where);
      return row;
    });
    at('list').replaceChildren(...rows);
  }

  async function run({ refresh = false } = {}) {
    if (!folder) return;
    const mine = ++round;
    const query = at('query').value.trim();
    if (refresh) at('state').textContent = 'Reading the folder…';
    try {
      const found = await invoke('everywhere_search', { folder, query, refreshFirst: refresh });
      if (mine !== round) return;
      locked = found.locked;
      if (found.summary) {
        const s = found.summary;
        at('state').textContent = `${s.documents} document(s) in the folder${s.locked ? `, ${s.locked} protected` : ''}${s.failed ? `, ${s.failed} unreadable` : ''}.`;
      } else if (query) at('state').textContent = found.hits.length ? `${found.hits.length} document(s) found.` : 'Nothing found.';
      drawLocked();
      drawHits(query ? found.hits : []);
    } catch (error) {
      if (mine === round) at('state').textContent = String(error);
    }
  }

  at('choose').onclick = async () => {
    const picked = await invoke('plugin:dialog|open', { options: { title: 'Folder to search', multiple: false, directory: true } }).catch(() => null);
    const path = typeof picked === 'string' ? picked : picked?.path ?? null;
    if (!path) return;
    folder = path;
    sealedHits = [];
    drawFolder();
    await run({ refresh: true });
    at('query').focus();
  };

  at('query').oninput = () => {
    // What a password found belongs to the words it was asked for.
    sealedHits = [];
    clearTimeout(timer);
    timer = setTimeout(() => run(), 200);
  };

  at('unlock').onclick = async () => {
    const field = at('password');
    const password = field.value;
    const query = at('query').value.trim();
    if (!password || !query) {
      at('state').textContent = 'Type the words to find and the password first.';
      return;
    }
    field.value = '';
    at('unlock').disabled = true;
    at('state').textContent = 'Opening the protected documents…';
    try {
      const found = await invoke('everywhere_search_locked', { query, password });
      sealedHits = found.hits;
      at('state').textContent = `The password opened ${found.opened} of ${found.tried} protected document(s); ${found.hits.length} hold these words.${found.left ? ` ${found.left} more were not tried.` : ''}`;
      const shown = await invoke('everywhere_search', { folder, query, refreshFirst: false });
      drawHits(shown.hits);
    } catch (error) {
      at('state').textContent = String(error);
    }
    at('unlock').disabled = false;
  };

  at('forget').onclick = async () => {
    try {
      await invoke('everywhere_forget');
      folder = null;
      locked = [];
      sealedHits = [];
      at('query').value = '';
      drawFolder();
      drawLocked();
      drawHits([]);
      at('state').textContent = 'The index was deleted.';
    } catch (error) {
      at('state').textContent = String(error);
    }
  };

  at('list').onclick = (event) => {
    const row = event.target.closest('.everywhere-hit');
    if (!row) return;
    if (row.dataset.kind === kind) {
      close();
      open(row.dataset.path);
      return;
    }
    // GRT programs do not start one another: the path is copied for the program that opens it.
    const program = PROGRAMS[row.dataset.kind] ?? 'its program';
    at('state').textContent = copy(row.dataset.path) ? `Path copied: open it with ${program}.` : `Open it with ${program}: ${row.dataset.path}`;
  };

  drawFolder();
  drawLocked();
  if (folder) run({ refresh: true });
  (folder ? at('query') : at('choose')).focus();
  await closed;
  clearTimeout(timer);
  round += 1;
  at('password').value = '';
}
