/** Markdown, one note or the whole archive. */

import { runsText } from './core/editor/model.js';
import { slugify } from './tree.js';

const escapeMarkdown = (text) => String(text ?? '').replace(/([\\`*_[\]])/g, '\\$1');

function runsToMarkdown(runs, lost) {
  return (runs ?? []).map((run) => {
    let text = escapeMarkdown(run.text);
    if (run.italic) text = `*${text}*`;
    if (run.bold) text = `**${text}**`;
    if (run.strike) text = `~~${text}~~`;
    if (run.underline) lost.add('underlining');
    if (run.color || run.highlight) lost.add('text colour and highlighting');
    if (run.sup || run.sub) lost.add('superscript and subscript');
    return text;
  }).join('');
}

/**
 * One note as Markdown.
 * @returns {{text: string, lost: string[]}}
 */
export function noteToMarkdown(note) {
  const lost = new Set();
  const lines = [];

  if (note.title) lines.push(`# ${escapeMarkdown(note.title)}`, '');
  if (note.tags?.length) lines.push(note.tags.map((tag) => `#${tag}`).join(' '), '');

  for (const block of note.blocks ?? []) {
    switch (block.kind) {
      case 'heading':
        lines.push(`${'#'.repeat(Math.min((block.level ?? 1) + 1, 6))} ${runsToMarkdown(block.runs, lost)}`, '');
        break;

      case 'quote':
        lines.push(`> ${runsToMarkdown(block.runs, lost)}`, '');
        break;

      case 'code':
        lines.push('```', runsText(block.runs), '```', '');
        break;

      case 'list':
        block.items.forEach((item, i) => {
          const marker = block.listType === 'number' ? `${i + 1}.` : '-';
          lines.push(`${'  '.repeat(item.level)}${marker} ${runsToMarkdown(item.runs, lost)}`);
        });
        lines.push('');
        break;

      case 'todo':
        lines.push(`- [${block.done ? 'x' : ' '}] ${runsToMarkdown(block.runs, lost)}`, '');
        break;

      case 'callout':
        // A blockquote with the tone named.
        lost.add('callout styling, which becomes a quotation');
        lines.push(`> **${(block.tone ?? 'note').toUpperCase()}**`, `> ${runsToMarkdown(block.runs, lost)}`, '');
        break;

      case 'embed':
        lost.add('embedded documents, which become a path');
        lines.push(`\`${block.target ?? ''}\``, '');
        break;

      case 'image':
        lost.add('images, which are referenced rather than embedded');
        lines.push(`![](${block.resource ?? ''})`, '');
        break;

      default:
        lines.push(runsToMarkdown(block.runs, lost), '');
    }
  }

  if ((note.blocks ?? []).some((b) => runsText(b.runs ?? []).includes('[['))) {
    lost.add('links between notes, which stay as [[title]] text');
  }

  return {
    text: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`,
    lost: [...lost],
  };
}

/**
 * The whole archive as a list of files to write.
 * @returns {{files: {path: string, text: string}[], lost: string[]}}
 */
export function archiveToMarkdown(entries) {
  const lost = new Set();
  const files = [];
  const used = new Set();

  for (const entry of entries) {
    const { text, lost: theseLost } = noteToMarkdown(entry.note);
    for (const item of theseLost) lost.add(item);

    const folders = [entry.notebook, entry.section].filter(Boolean).map(folderPart);
    const base = slugify(entry.note.title || entry.file || 'note');

    let relative = [...folders, `${base}.md`].join('/');
    let n = 2;
    while (used.has(relative.toLowerCase())) {
      relative = [...folders, `${base}-${n}.md`].join('/');
      n += 1;
    }
    used.add(relative.toLowerCase());

    files.push({ path: relative, text });
  }

  return { files, lost: [...lost] };
}

/** Folder names keep their shape but lose anything a filesystem dislikes. */
function folderPart(name) {
  return String(name).replace(/[/\\:*?"<>|]/g, '').trim() || 'Untitled';
}
