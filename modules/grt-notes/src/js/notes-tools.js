/** Notes' tools for an archive of linked notes: mentions not yet linked, search operators, renaming with links, merging and splitting. */

import { linkTarget } from './links.js';
import { runsText, normaliseRuns, itemsOf } from './core/editor/model.js';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A title as a whole word or words in text, not inside a link already. */
function mentionPattern(title) {
  return new RegExp(`(?<![\\p{L}\\p{N}_\\[])${escape(title)}(?![\\p{L}\\p{N}_\\]])`, 'iu');
}

/**
 * Notes whose text names this note's title without linking it.
 * @param {{path: string, title: string, links: string[], body?: string}[]} catalogue
 */
export function unlinkedMentions(title, path, catalogue, { limit = 200 } = {}) {
  const name = String(title ?? '').trim();
  if (name.length < 3) return [];
  const pattern = mentionPattern(name);
  const out = [];
  for (const row of catalogue) {
    if (row.path === path || !row.body) continue;
    if ((row.links ?? []).some((l) => l.toLowerCase() === name.toLowerCase())) continue;
    const plain = row.body.replace(/\[\[[^\]\n]+\]\]/g, ' ');
    const match = pattern.exec(plain);
    if (!match) continue;
    out.push({ path: row.path, title: row.title, snippet: plain.slice(Math.max(0, match.index - 40), match.index + name.length + 40).trim() });
    if (out.length >= limit) break;
  }
  return out;
}

/** Every run list of a note: its paragraphs, list items and table cells. */
function* runLists(note) {
  for (const block of note.blocks ?? []) {
    const items = itemsOf(block);
    if (items) for (const item of items) yield item;
    else if (Array.isArray(block.runs)) yield block;
  }
}

/** Turns the first mention of a title in a note into a link; true when it found one. */
export function linkFirstMention(note, title) {
  const pattern = mentionPattern(title);
  for (const holder of runLists(note)) {
    for (const run of holder.runs) {
      if (run.object || /\[\[/.test(run.text)) continue;
      const match = pattern.exec(run.text);
      if (!match) continue;
      run.text = `${run.text.slice(0, match.index)}[[${match[0]}]]${run.text.slice(match.index + match[0].length)}`;
      holder.runs = normaliseRuns(holder.runs);
      note.dirty = true;
      return true;
    }
  }
  return false;
}

/**
 * Links to an old title, in any of their forms, made to name the new one; the rest of each link is kept.
 * @returns {number} how many links changed
 */
export function renameLinks(note, oldTitle, newTitle) {
  const old = String(oldTitle).trim().toLowerCase();
  let count = 0;
  for (const holder of runLists(note)) {
    let changed = false;
    for (const run of holder.runs) {
      if (run.object || !run.text.includes('[[')) continue;
      run.text = run.text.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inner) => {
        if (linkTarget(inner).toLowerCase() !== old) return whole;
        // [[Folder/Old#Heading|shown]]: the name changes, the heading and the words shown stay.
        const [target, ...shown] = inner.split('|');
        const [name, ...heading] = target.split('#');
        const folder = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
        count += 1;
        changed = true;
        return `[[${folder}${newTitle}${heading.length ? `#${heading.join('#')}` : ''}${shown.length ? `|${shown.join('|')}` : ''}]]`;
      });
    }
    if (changed) {
      holder.runs = normaliseRuns(holder.runs);
      note.dirty = true;
    }
  }
  return count;
}

/**
 * A search as typed, its operators taken out: tag:, path:, task: (or task-todo:, task-done:), and [property:value].
 * @returns {{text: string, tags: string[], paths: string[], tasks: {state: ?boolean, text: string}[], properties: {key: string, value: string}[]}}
 */
export function parseQuery(query) {
  const out = { text: '', tags: [], paths: [], tasks: [], properties: [] };
  let rest = String(query ?? '');
  rest = rest.replace(/\[([^\]:]+):([^\]]*)\]/g, (_, key, value) => {
    out.properties.push({ key: key.trim().toLowerCase(), value: value.trim().toLowerCase() });
    return ' ';
  });
  const token = /(tag|path|task|task-todo|task-done):(?:"([^"]*)"|(\S+))/gi;
  rest = rest.replace(token, (_, kind, quoted, bare) => {
    const value = (quoted ?? bare ?? '').trim();
    const lower = kind.toLowerCase();
    if (lower === 'tag') out.tags.push(value.replace(/^#/, '').toLowerCase());
    else if (lower === 'path') out.paths.push(value.toLowerCase());
    else out.tasks.push({ state: lower === 'task-done' ? true : lower === 'task-todo' ? false : null, text: value.toLowerCase() });
    return ' ';
  });
  out.text = rest.replace(/\s+/g, ' ').trim();
  return out;
}

/** Whether a note meets a query's operators; its text is matched by the index. */
export function meetsOperators(note, path, parsed) {
  const tags = (note.tags ?? []).map((t) => t.toLowerCase());
  if (!parsed.tags.every((t) => tags.some((own) => own === t || own.startsWith(`${t}/`)))) return false;
  if (!parsed.paths.every((p) => path.toLowerCase().includes(p))) return false;
  if (parsed.tasks.length) {
    const todos = (note.blocks ?? []).filter((b) => b.kind === 'todo').map((b) => ({ done: !!b.done, text: runsText(b.runs ?? []).toLowerCase() }));
    if (!parsed.tasks.every((t) => todos.some((todo) => (t.state === null || todo.done === t.state) && todo.text.includes(t.text)))) return false;
  }
  if (parsed.properties.length) {
    const props = new Map((note.properties ?? []).map((p) => [String(p.key ?? p.name ?? '').toLowerCase(), p.value]));
    if (!parsed.properties.every(({ key, value }) => {
      if (!props.has(key)) return false;
      const own = props.get(key);
      const values = Array.isArray(own) ? own : [own];
      return value === '' || values.some((v) => String(v ?? '').toLowerCase().includes(value));
    })) return false;
  }
  return true;
}

export const hasOperators = (parsed) => parsed.tags.length + parsed.paths.length + parsed.tasks.length + parsed.properties.length > 0;

/** One note's blocks put after another's, under a heading with its title. */
export function mergeInto(target, source) {
  const heading = { kind: 'heading', level: 2, style: 'h2', align: 'left', runs: [{ text: source.title || 'Merged note' }] };
  target.blocks.push(heading, ...structuredClone(source.blocks));
  target.tags = [...new Set([...(target.tags ?? []), ...(source.tags ?? [])])];
  target.dirty = true;
}

/** The blocks from one on, taken out of a note for a new one. */
export function splitAt(note, blockIndex) {
  if (blockIndex <= 0 || blockIndex >= note.blocks.length) return null;
  const moved = note.blocks.splice(blockIndex);
  note.dirty = true;
  return moved;
}
