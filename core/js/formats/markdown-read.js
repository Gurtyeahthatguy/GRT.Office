/** Markdown into the editor's document model, through markdown-it's tokens. */

import { markdownParser } from '../markdown.js';
import { normaliseRuns } from '../editor/model.js';
import { Losses } from '../losses.js';
import { extensionOf, DRAWABLE } from './odf.js';
import { fittedSize } from '../images.js';

/**
 * @param {string} text
 * @param {(src: string) => Promise<?Uint8Array>} readImage the bytes of a picture
 *        the text refers to by a local path, or null
 * @returns {Promise<{document: object, images: Map<string, Uint8Array>, losses: Losses}>}
 */
export async function readMarkdown(text, readImage = async () => null) {
  const parser = markdownParser().enable(['table', 'strikethrough']);
  const tokens = parser.parse(String(text).replace(/^﻿/, ''), {});
  const losses = new Losses();
  const blocks = [];
  const images = new Map();
  const pending = [];

  let list = null;
  let depth = -1;
  let quote = 0;
  let table = null;

  const inline = (children) => {
    const runs = [];
    const marks = {};
    for (const token of children ?? []) {
      switch (token.type) {
        case 'text': runs.push({ text: token.content.replace(/ {2,}/g, ' '), ...marks }); break;
        case 'code_inline':
          losses.add('Code inside a line, shown as ordinary text');
          runs.push({ text: token.content, ...marks });
          break;
        case 'softbreak': runs.push({ text: ' ', ...marks }); break;
        case 'hardbreak':
          losses.add('Line breaks inside a paragraph, made into spaces');
          runs.push({ text: ' ', ...marks });
          break;
        case 'strong_open': marks.bold = true; break;
        case 'strong_close': delete marks.bold; break;
        case 'em_open': marks.italic = true; break;
        case 'em_close': delete marks.italic; break;
        case 's_open': marks.strike = true; break;
        case 's_close': delete marks.strike; break;
        case 'link_open': losses.add('Links, kept as their text'); break;
        case 'image':
          pending.push({ src: token.attrGet('src') ?? '', alt: token.content ?? '' });
          break;
        default: break;
      }
    }
    return runs;
  };

  const push = (block) => {
    if (quote > 0 && block.kind === 'paragraph') {
      block.kind = 'quote';
      block.style = 'quote';
    }
    blocks.push(block);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1));
        if (level > 4) losses.add('Headings deeper than level 4, made level 4');
        const shown = Math.min(level, 4);
        push({ kind: 'heading', level: shown, style: `h${shown}`, align: 'left', runs: normaliseRuns(inline(tokens[i + 1].children)) });
        i += 2;
        break;
      }
      case 'paragraph_open': {
        const runs = normaliseRuns(inline(tokens[i + 1].children));
        i += 2;
        if (list) {
          const item = list.items[list.items.length - 1];
          if (item && item.runs.length === 0) item.runs = runs;
          else if (item) {
            losses.add('List items of several paragraphs, joined into one');
            item.runs = normaliseRuns([...item.runs, { text: ' ' }, ...runs]);
          }
        } else if (table) {
          table.cell.push(...runs);
        } else if (runs.some((run) => run.text.trim())) {
          push({ kind: 'paragraph', style: 'body', align: 'left', runs });
        }
        await flushImages();
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open':
        depth += 1;
        if (depth === 0) {
          list = { kind: 'list', style: 'body', align: 'left', listType: token.type === 'ordered_list_open' ? 'number' : 'bullet', items: [] };
          blocks.push(list);
        } else if ((token.type === 'ordered_list_open') !== (list.listType === 'number')) {
          losses.add('Lists mixing bullets and numbers, shown with one kind');
        }
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        depth -= 1;
        if (depth < 0) list = null;
        break;
      case 'list_item_open':
        if (depth > 5) losses.add('Lists nested deeper than six levels, flattened');
        list.items.push({ level: Math.min(depth, 5), runs: [] });
        break;
      case 'blockquote_open': quote += 1; break;
      case 'blockquote_close': quote -= 1; break;
      case 'fence':
      case 'code_block':
        push({ kind: 'code', style: 'code', align: 'left', runs: [{ text: token.content.replace(/\n$/, '') }] });
        break;
      case 'hr':
        losses.add('Horizontal rules');
        break;
      case 'table_open':
        losses.add('Tables, kept as text with a tab between cells');
        table = { row: [], cell: [] };
        break;
      case 'tr_open': table.row = []; break;
      case 'th_open': case 'td_open': table.cell = []; break;
      case 'th_close': case 'td_close': table.row.push(table.cell); break;
      case 'inline':
        if (table) table.cell.push(...inline(token.children));
        break;
      case 'tr_close':
        push({
          kind: 'paragraph',
          style: 'body',
          align: 'left',
          runs: normaliseRuns(table.row.flatMap((cell, n) => (n === 0 ? cell : [{ text: '\t' }, ...cell]))),
        });
        break;
      case 'table_close': table = null; break;
      case 'html_block': case 'html_inline':
        losses.add('HTML written into the Markdown, kept as text');
        push({ kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: token.content.trim() }] });
        break;
      default:
        break;
    }
  }
  await flushImages();
  for (const block of blocks) {
    if (block.kind === 'list') {
      for (const item of block.items) item.runs = normaliseRuns(item.runs);
    }
  }
  if (blocks.length === 0) blocks.push({ kind: 'paragraph', style: 'body', align: 'left', runs: [{ text: '' }] });
  losses.add('Page size, margins and styles, which Markdown does not have');

  return {
    document: { version: 1, type: 'paper', blocks },
    images,
    losses,
  };

  /** Pictures found in the text just read, placed after it. */
  async function flushImages() {
    while (pending.length > 0) {
      const { src, alt } = pending.shift();
      const ext = extensionOf(src.split(/[?#]/)[0]);
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('file:')) {
        losses.add('Pictures on the web, which are not fetched');
        continue;
      }
      const bytes = DRAWABLE.has(ext) ? await readImage(decodeURIComponent(src.replace(/^file:\/\//, ''))) : null;
      if (!bytes) {
        losses.add('Pictures that could not be found beside the file');
        continue;
      }
      let resource = `resources/${src.split('/').pop().replace(/[^\w.-]+/g, '_')}`;
      let n = 2;
      while (images.has(resource)) {
        resource = resource.replace(/(-\d+)?(\.[^.]*)$/, `-${n}$2`);
        n += 1;
      }
      images.set(resource, bytes);
      blocks.push({ kind: 'image', style: 'body', resource, ...fittedSize(bytes), align: 'center', caption: alt ? [{ text: alt }] : [] });
    }
  }
}
