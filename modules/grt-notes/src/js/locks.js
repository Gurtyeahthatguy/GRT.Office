/** Notebooks protected with a password: which they are, and the passwords given while the program runs. */

/** The file that marks a notebook as protected, sealed with its password. */
export const MARKER = '.protected.grt';

/** What the marker holds, so a password can be checked without opening a note. */
export const MARKER_PARTS = { 'content/main.json': '{"kind":"protected-notebook"}\n' };

const inside = (path, folder) => {
  const text = String(path);
  return text === folder || text.startsWith(`${folder}/`) || text.startsWith(`${folder}\\`);
};

/** The notebook a path lies in, or null. */
export function notebookOf(archive, path) {
  return (archive?.notebooks ?? []).find((notebook) => inside(path, notebook.path)) ?? null;
}

/** Whether a path lies in a protected notebook. */
export const isProtected = (archive, path) => Boolean(notebookOf(archive, path)?.protected);

/** A note's file name in a protected notebook: its order only, never its title. */
export const lockedFileName = (order) => `${String(order).padStart(3, '0')}-note.grt`;

/** The passwords of the notebooks opened so far, kept in memory only. */
export class Keys {
  constructor() {
    this.byNotebook = new Map();
  }

  get(archive, path) {
    const notebook = notebookOf(archive, path);
    return notebook ? this.byNotebook.get(notebook.path) ?? null : null;
  }

  set(notebookPath, password) {
    this.byNotebook.set(notebookPath, password);
  }

  drop(notebookPath) {
    this.byNotebook.delete(notebookPath);
  }

  forget() {
    this.byNotebook.clear();
  }
}
