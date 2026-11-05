/** Obsidian's everyday helpers: notes shown inside notes, the note of the day, templates, notes named by the minute. */

const pad = (n, size = 2) => String(n).padStart(size, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A date written with the tokens Obsidian's date formats use: YYYY, MM, DD, HH, mm, dddd and the rest. */
export function formatDate(date, format = 'YYYY-MM-DD') {
  const tokens = {
    YYYY: () => String(date.getFullYear()), YY: () => pad(date.getFullYear() % 100),
    MMMM: () => MONTHS[date.getMonth()], MMM: () => MONTHS[date.getMonth()].slice(0, 3), MM: () => pad(date.getMonth() + 1), M: () => String(date.getMonth() + 1),
    dddd: () => DAYS[date.getDay()], ddd: () => DAYS[date.getDay()].slice(0, 3),
    DD: () => pad(date.getDate()), D: () => String(date.getDate()),
    HH: () => pad(date.getHours()), H: () => String(date.getHours()), mm: () => pad(date.getMinutes()), ss: () => pad(date.getSeconds()),
  };
  // Text in square brackets is kept as it is, as Obsidian's formats allow.
  return String(format).replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|mm|ss/g, (match, literal) => (literal !== undefined ? literal : tokens[match]()));
}

/** A template's text with its placeholders filled in: {{title}}, {{date}}, {{time}}, {{date:FORMAT}}, {{time:FORMAT}}. */
export function fillTemplate(text, { title = '', now = new Date(), dateFormat = 'YYYY-MM-DD', timeFormat = 'HH:mm' } = {}) {
  return String(text).replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi, (_, name, format) => {
    const key = name.toLowerCase();
    if (key === 'title') return title;
    return formatDate(now, format?.trim() || (key === 'date' ? dateFormat : timeFormat));
  });
}

/** The blocks of one part of a note: from the heading named to the next heading as high or higher. */
export function sectionBlocks(blocks, section) {
  if (!section) return blocks;
  const wanted = section.trim().toLowerCase();
  const start = blocks.findIndex((b) => b.kind === 'heading' && (b.runs ?? []).map((r) => r.text).join('').trim().toLowerCase() === wanted);
  if (start === -1) return null;
  const level = blocks[start].level ?? 1;
  const end = blocks.findIndex((b, i) => i > start && b.kind === 'heading' && (b.level ?? 1) <= level);
  return blocks.slice(start, end === -1 ? undefined : end);
}

/** A name made of the minute it was made, as Obsidian's unique note creator writes it. */
export const uniqueName = (now = new Date()) => formatDate(now, 'YYYYMMDDHHmm');

/** Obsidian's settings for daily notes and templates, read from the vault, with its defaults when missing. */
export async function vaultSettings(root, readText) {
  const read = async (name) => {
    try {
      return JSON.parse(await readText(`${root}/.obsidian/${name}`));
    } catch {
      return {};
    }
  };
  const daily = await read('daily-notes.json');
  const templates = await read('templates.json');
  const unique = await read('zk-prefixer.json');
  const clean = (path) => String(path ?? '').replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');
  return {
    daily: { folder: clean(daily.folder), format: daily.format || 'YYYY-MM-DD', template: clean(daily.template) },
    templates: { folder: clean(templates.folder) || 'Templates', dateFormat: templates.dateFormat || 'YYYY-MM-DD', timeFormat: templates.timeFormat || 'HH:mm' },
    unique: { folder: clean(unique.folder), format: unique.format || 'YYYYMMDDHHmm' },
  };
}

/**
 * The cache of notes shown inside others: each read once, shown again when it has been read.
 * @param {{resolve: (title: string) => ?string, read: (path: string) => Promise<object>, redraw: Function}} options
 */
export function embedLoader({ resolve, read, redraw }) {
  const cache = new Map();
  return {
    forget: () => cache.clear(),
    /** The blocks to show for `Note#Section`, null while reading, 'missing' when there is no such note. */
    content(target) {
      const [title, section] = String(target).split('#');
      const path = resolve(title.trim());
      if (!path) return 'missing';
      if (!cache.has(path)) {
        cache.set(path, null);
        read(path).then((note) => {
          cache.set(path, note?.blocks ?? 'missing');
          redraw();
        }, () => {
          cache.set(path, 'missing');
          redraw();
        });
      }
      const blocks = cache.get(path);
      if (!Array.isArray(blocks)) return blocks;
      return sectionBlocks(blocks, section) ?? 'missing';
    },
  };
}
