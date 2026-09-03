// Enough of the backend for the frontend to start in a plain browser.
const notes = new Map();
const index = new Map();
let nextId = 1;

function makeNote(title, tags, paragraphs) {
  const blocks = paragraphs.map((text) => ({
    id: `b${nextId++}`,
    kind: 'paragraph',
    style: 'body',
    align: 'left',
    runs: [{ text }],
  }));
  return {
    'content/main.json': JSON.stringify({
      version: 1, type: 'notes', title, tags, page: null,
      styles: {}, fonts: [], blocks,
    }, null, 2),
  };
}

notes.set('/preview/Notes/001-kant.grt', {
  parts: makeNote('Kant', ['philosophy'], [
    'The categorical imperative, in the formulation from the Groundwork.',
    'Compare with [[Hume]] on the is-ought problem.',
  ]),
  modified: 100,
});

notes.set('/preview/Notes/002-hume.grt', {
  parts: makeNote('Hume', ['philosophy'], [
    'A treatise of human nature. See also [[Kant]].',
  ]),
  modified: 200,
});

notes.set('/preview/Projects/001-ideas.grt', {
  parts: makeNote('Ideas', ['work'], [
    'Things to try, none of them urgent.',
  ]),
  modified: 300,
});

for (const [path, held] of notes) {
  const document_ = JSON.parse(held.parts['content/main.json']);
  index.set(path, {
    path,
    title: document_.title,
    tags: document_.tags.join(' '),
    body: document_.blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n'),
    modified: held.modified,
  });
}

const folders = () => {
  const seen = new Map();
  for (const path of notes.keys()) {
    const notebook = path.split('/').slice(0, 3).join('/');
    if (!seen.has(notebook)) seen.set(notebook, []);
    seen.get(notebook).push(path);
  }
  return seen;
};

// Every call is recorded, so the same fake can serve the boot test as well as
// the browser preview.
window.__TAURI_CALLS__ = [];

window.__TAURI__ = {
  core: {
    invoke: async (command, payload, options) => {
      window.__TAURI_CALLS__.push({ command, payload, options });
      switch (command) {
        case 'runtime_info':
          return {
            ephemeral: false,
            version: 'preview',
            initialFile: null,
            defaultRoot: '/preview',
          };
        case 'read_settings': return {};
        case 'write_settings': return true;
        case 'forget_settings': return undefined;

        case 'read_archive':
          return {
            root: '/preview',
            notebooks: [...folders().entries()].map(([path, paths]) => ({
              name: path.split('/').pop(),
              path,
              sections: [],
              pages: paths.map((notePath) => ({
                path: notePath,
                file: notePath.split('/').pop().replace(/\.grt$/, ''),
                modified: notes.get(notePath).modified,
              })),
            })),
          };

        case 'create_folder': return undefined;
        case 'rename_entry': return undefined;
        case 'delete_entry': notes.delete(payload.path); index.delete(payload.path); return undefined;

        case 'read_grt':
          return { parts: notes.get(payload.path)?.parts ?? {}, resources: [] };
        case 'write_grt':
          notes.set(payload.path, { parts: payload.parts, modified: Date.now() / 1000 });
          return undefined;
        case 'read_resource': return new Uint8Array();

        case 'index_state':
          return [...index.values()].map((row) => ({ path: row.path, modified: row.modified }));
        case 'index_upsert': index.set(payload.path, payload); return undefined;
        case 'index_remove': index.delete(payload.path); return undefined;
        case 'index_dump':
          return [...index.values()].map((row) => ({
            path: row.path, title: row.title, body: row.body,
          }));
        case 'index_search': {
          const needle = String(payload.query ?? '').toLowerCase();
          return [...index.values()]
            .filter((row) => `${row.title} ${row.body}`.toLowerCase().includes(needle))
            .map((row) => ({
              path: row.path,
              title: row.title,
              tags: row.tags,
              snippet: row.body.slice(0, 80),
            }));
        }
        case 'index_forget': index.clear(); return undefined;

        case 'read_file': return new Uint8Array();
        case 'write_file_atomic': return undefined;
        case 'file_exists': return false;

        default: return null;
      }
    },
  },
};
