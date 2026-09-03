/** Turning whatever the clipboard holds into the model. */

import { normaliseRuns, makeBlock, MARKS } from './model.js';

/** Elements that turn into blocks of their own. */
const BLOCK_TAGS = {
  p: { kind: 'paragraph' },
  div: { kind: 'paragraph' },
  h1: { kind: 'heading', level: 1 },
  h2: { kind: 'heading', level: 2 },
  h3: { kind: 'heading', level: 3 },
  h4: { kind: 'heading', level: 4 },
  h5: { kind: 'heading', level: 4 },
  h6: { kind: 'heading', level: 4 },
  blockquote: { kind: 'quote' },
  pre: { kind: 'code' },
};

/** Elements that add a mark to the text inside them. */
const MARK_TAGS = {
  b: 'bold', strong: 'bold',
  i: 'italic', em: 'italic',
  u: 'underline',
  s: 'strike', del: 'strike', strike: 'strike',
  sup: 'sup', sub: 'sub',
  code: null,        // recognised, but it is the block that carries code style.
  mark: 'highlight',
};

/** Never walked into, whatever they contain. */
const IGNORED = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link', 'template',
  'iframe', 'object', 'embed', 'svg', 'canvas', 'form', 'input', 'button', 'select']);

/**
 * Converts pasted HTML into blocks.
 * @param {string} html
 * @param {Document} document the parsing document (the page's own will do)
 * @returns {{blocks: Object[], dropped: string[]}}
 */
export function blocksFromHtml(html, document) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const dropped = new Set();
  const blocks = [];

  let current = null;
  const open = (kind, options = {}) => {
    current = makeBlock(kind, options);
    if (kind !== 'list' && kind !== 'image') current.runs = [];
    blocks.push(current);
    return current;
  };
  const ensure = () => current ?? open('paragraph');

  const addRun = (text, marks) => {
    if (text === '') return;
    const block = ensure();
    const target = block.kind === 'list'
      ? block.items[block.items.length - 1].runs
      : block.runs;
    target.push({ text, ...marks });
  };

  const walk = (node, marks, listContext) => {
    if (node.nodeType === 3) {
      // Collapse whitespace the way HTML does, or a pasted page arrives full
      // of the newlines and indentation of its source.
      const text = node.nodeValue.replace(/\s+/g, ' ');
      if (text.trim() === '' && text !== ' ') return;
      addRun(text, marks);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.nodeName.toLowerCase();

    if (IGNORED.has(tag)) {
      dropped.add(tag);
      return;
    }

    if (tag === 'br') {
      addRun(' ', marks);
      return;
    }

    if (tag === 'img') {
      // An image from a web page points at a URL this program will not fetch.
      dropped.add('images');
      return;
    }

    if (tag === 'table') {
      // Recognised and flattened.
      dropped.add('tables');
      for (const cell of node.querySelectorAll('td,th')) {
        open('paragraph');
        walk(cell, marks, null);
      }
      current = null;
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const block = open('list', { listType: tag === 'ol' ? 'number' : 'bullet' });
      block.items = [];
      const level = (listContext?.level ?? -1) + 1;

      for (const child of node.children) {
        if (child.nodeName.toLowerCase() !== 'li') continue;
        block.items.push({ level, runs: [] });
        walk(child, marks, { block, level });
      }

      if (block.items.length === 0) block.items.push({ level: 0, runs: [{ text: '' }] });
      current = null;
      return;
    }

    if (tag === 'li') {
      for (const child of node.childNodes) walk(child, marks, listContext);
      return;
    }

    const asBlock = BLOCK_TAGS[tag];
    if (asBlock) {
      open(asBlock.kind, asBlock);
      for (const child of node.childNodes) walk(child, marks, listContext);
      current = null;
      return;
    }

    const mark = MARK_TAGS[tag];
    const next = mark === undefined
      ? marks
      : { ...marks, ...(mark ? { [mark]: mark === 'highlight' ? '#ffee88' : true } : {}) };

    if (mark === undefined && !['span', 'a', 'font', 'small', 'big', 'label', 'time',
      'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'dfn', 'ins'].includes(tag)) {
      // An element nobody recognised: its text is kept, its identity is not.
      dropped.add(tag);
    }

    for (const child of node.childNodes) walk(child, next, listContext);
  };

  for (const child of parsed.body.childNodes) walk(child, {}, null);

  const cleaned = blocks
    .map((block) => {
      if (block.kind === 'list') {
        block.items = block.items
          .map((item) => ({ level: item.level, runs: normaliseRuns(item.runs) }))
          .filter((item) => item.runs.some((run) => run.text.trim() !== ''));
        return block.items.length > 0 ? block : null;
      }
      block.runs = normaliseRuns(block.runs);
      return block.runs.some((run) => run.text.trim() !== '') ? block : null;
    })
    .filter(Boolean);

  return { blocks: cleaned, dropped: [...dropped].sort() };
}

/** Converts plain text into blocks, one paragraph per line. */
export function blocksFromText(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const block = makeBlock('paragraph');
      block.runs = [{ text: line }];
      return block;
    });
}

/** Checks that nothing outside the model's vocabulary survived. */
export function isRepresentable(blocks) {
  const allowedRunKeys = new Set(['text', 'color', 'highlight', 'size', ...MARKS]);
  const allowedKinds = new Set(['paragraph', 'heading', 'list', 'quote', 'code', 'image']);

  for (const block of blocks) {
    if (!allowedKinds.has(block.kind)) return false;

    const runLists = block.kind === 'list'
      ? block.items.map((item) => item.runs)
      : [block.runs ?? []];

    for (const runs of runLists) {
      for (const run of runs) {
        for (const key of Object.keys(run)) {
          if (!allowedRunKeys.has(key)) return false;
        }
        if (typeof run.text !== 'string') return false;
      }
    }
  }

  return true;
}
