/** PDF, Markdown, HTML and plain text. */

import { runsText, PAGE_SIZES } from './core/editor/model.js';
import { paginate } from './pagination.js';

const escapeHtml = (value) => String(value ?? '')
  .replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));

const PT = 96 / 72;
const MM_TO_PT = 72 / 25.4;

// Markdown

/**
 * @param {PaperModel} model
 * @returns {{text: string, lost: string[]}}
 */
export function toMarkdown(model) {
  const lost = new Set();
  const lines = [];

  const runsToMarkdown = (runs) => (runs ?? []).map((run) => {
    let text = run.text.replace(/([\\`*_[\]])/g, '\\$1');
    if (run.italic) text = `*${text}*`;
    if (run.bold) text = `**${text}**`;
    if (run.strike) text = `~~${text}~~`;
    if (run.underline) lost.add('underlining');
    if (run.color || run.highlight) lost.add('text colour and highlighting');
    if (run.sup || run.sub) lost.add('superscript and subscript');
    return text;
  }).join('');

  for (const block of model.blocks) {
    if (block.kind === 'heading') {
      lines.push(`${'#'.repeat(Math.min(block.level ?? 1, 6))} ${runsToMarkdown(block.runs)}`, '');
      continue;
    }
    if (block.kind === 'quote') {
      lines.push(`> ${runsToMarkdown(block.runs)}`, '');
      continue;
    }
    if (block.kind === 'code') {
      lines.push('```', runsText(block.runs), '```', '');
      continue;
    }
    if (block.kind === 'list') {
      block.items.forEach((item, index) => {
        const marker = block.listType === 'number' ? `${index + 1}.` : '-';
        lines.push(`${'  '.repeat(item.level)}${marker} ${runsToMarkdown(item.runs)}`);
      });
      lines.push('');
      continue;
    }
    if (block.kind === 'image') {
      // Markdown references an image by path; the bytes live in the
      // container, so an exported file on its own will not find them.
      lost.add('images, which are referenced rather than embedded');
      lines.push(`![](${block.resource ?? ''})`, '');
      continue;
    }

    if (block.align && block.align !== 'left') lost.add('paragraph alignment');
    lines.push(runsToMarkdown(block.runs), '');
  }

  lost.add('page size, margins and pagination');

  return { text: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`, lost: [...lost] };
}

// HTML

/** A self-contained page, images inlined. */
export function toHtml(model, images = new Map()) {
  const body = model.blocks.map((block) => blockHtml(block, model, images)).join('\n');
  const box = model.pageBox();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document</title>
<style>
body{margin:0;background:#f4f4f5;font-family:Georgia,"Times New Roman",serif;color:#1a1a1a}
main{max-width:${Math.round(box.contentWidth)}mm;margin:24px auto;padding:${box.height > box.width ? '24mm' : '18mm'};
  background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.15)}
h1,h2,h3,h4{font-family:system-ui,sans-serif}
blockquote{margin:0 0 1em 20px;font-style:italic}
pre{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.9em}
figure{margin:1em 0;text-align:center}
figure img{max-width:100%}
figcaption{font-size:.85em;color:#555;margin-top:.4em}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function blockHtml(block, model, images) {
  const align = block.align && block.align !== 'left'
    ? ` style="text-align:${block.align}"` : '';

  if (block.kind === 'image') {
    const source = images.get(block.resource);
    const picture = source
      ? `<img src="${source}" alt="" style="width:${block.w}px">`
      : '<div style="border:2px dashed #bbb;height:120px"></div>';
    const caption = runsText(block.caption) !== ''
      ? `<figcaption>${runsHtml(block.caption)}</figcaption>` : '';
    return `<figure>${picture}${caption}</figure>`;
  }

  if (block.kind === 'list') {
    const tag = block.listType === 'number' ? 'ol' : 'ul';
    const items = block.items
      .map((item) => `<li style="margin-left:${item.level * 24}px">${runsHtml(item.runs)}</li>`)
      .join('');
    return `<${tag}>${items}</${tag}>`;
  }

  if (block.kind === 'heading') {
    const level = Math.min(block.level ?? 1, 6);
    return `<h${level}${align}>${runsHtml(block.runs)}</h${level}>`;
  }
  if (block.kind === 'quote') return `<blockquote${align}>${runsHtml(block.runs)}</blockquote>`;
  if (block.kind === 'code') return `<pre>${escapeHtml(runsText(block.runs))}</pre>`;

  return `<p${align}>${runsHtml(block.runs)}</p>`;
}

function runsHtml(runs) {
  return (runs ?? []).map((run) => {
    let html = escapeHtml(run.text);
    if (run.bold) html = `<strong>${html}</strong>`;
    if (run.italic) html = `<em>${html}</em>`;
    if (run.underline) html = `<u>${html}</u>`;
    if (run.strike) html = `<s>${html}</s>`;
    if (run.sup) html = `<sup>${html}</sup>`;
    if (run.sub) html = `<sub>${html}</sub>`;
    if (run.color || run.highlight) {
      const styles = [
        run.color ? `color:${escapeHtml(run.color)}` : '',
        run.highlight ? `background:${escapeHtml(run.highlight)}` : '',
      ].filter(Boolean).join(';');
      html = `<span style="${styles}">${html}</span>`;
    }
    return html;
  }).join('');
}

// Plain text

export function toPlainText(model) {
  return model.blocks.map((block) => {
    if (block.kind === 'list') {
      return block.items
        .map((item, i) => `${'  '.repeat(item.level)}`
          + `${block.listType === 'number' ? `${i + 1}. ` : '- '}${runsText(item.runs)}`)
        .join('\n');
    }
    if (block.kind === 'image') return '';
    return runsText(block.runs);
  }).filter((line) => line !== '').join('\n\n') + '\n';
}

// PDF

/**
 * The document as pages of primitives for the shared print engine.
 * @param {PaperModel} model
 * @param {Map<string, Uint8Array>} [imageBytes] resource path to the file's
 * @returns {{width: number, height: number, primitives: Object[]}[]}
 */
export function toPrintPages(model, imageBytes = new Map()) {
  const size = PAGE_SIZES[model.page.size] ?? PAGE_SIZES.A4;
  const portrait = model.page.orientation !== 'landscape';
  const width = (portrait ? size.w : size.h) * MM_TO_PT;
  const height = (portrait ? size.h : size.w) * MM_TO_PT;

  const margins = model.page.margins;
  const left = margins.left * MM_TO_PT;
  const top = margins.top * MM_TO_PT;
  const contentWidth = width - (margins.left + margins.right) * MM_TO_PT;
  const contentHeight = height - (margins.top + margins.bottom) * MM_TO_PT;

  const pages = [];
  let primitives = [];
  let y = top;

  const newPage = () => {
    pages.push({ width, height, primitives });
    primitives = [];
    y = top;
  };

  for (const block of model.blocks) {
    const style = model.styles[block.style] ?? model.styles.body ?? {};
    const size_ = style.size ?? 11;
    const leading = size_ * (style.lineHeight ?? 1.5);
    const indent = (style.indent ?? 0) + (block.kind === 'list' ? 12 : 0);

    if (block.breakBefore && primitives.length > 0) newPage();
    y += style.spaceBefore ?? 0;

    const paragraphs = block.kind === 'list'
      ? block.items.map((item, i) => ({
        prefix: block.listType === 'number' ? `${i + 1}. ` : '• ',
        indent: indent + item.level * 14,
        runs: item.runs,
      }))
      : [{ prefix: '', indent, runs: block.runs ?? [] }];

    for (const paragraph of paragraphs) {
      const usable = contentWidth - paragraph.indent;
      const lines = wrapText(
        paragraph.prefix + runsText(paragraph.runs), usable, size_,
      );

      for (const line of lines) {
        if (y + leading > top + contentHeight) newPage();
        primitives.push({
          type: 'text',
          x: left + paragraph.indent + (block.align === 'center' ? (usable) / 2 : 0),
          y,
          text: line,
          size: size_,
          align: block.align === 'center' ? 'center' : 'left',
          fill: style.color ?? '#111111',
        });
        y += leading;
      }
    }

    if (block.kind === 'image') {
      // Pixels to points, then fitted to the text column.
      const naturalWidth = block.w * 0.75;
      const naturalHeight = block.h * 0.75;
      const fit = Math.min(1, contentWidth / naturalWidth, contentHeight / naturalHeight);
      const boxWidth = naturalWidth * fit;
      const boxHeight = naturalHeight * fit;

      // An image that does not fit in what is left drops to the next page
      // whole.
      if (y + boxHeight > top + contentHeight) newPage();

      const bytes = imageBytes.get(block.resource);
      primitives.push(bytes
        ? {
          type: 'image', bytes,
          x: left + (contentWidth - boxWidth) / 2, y, w: boxWidth, h: boxHeight,
        }
        : {
          type: 'rect',
          x: left + (contentWidth - boxWidth) / 2, y, w: boxWidth, h: boxHeight,
          stroke: '#cccccc', strokeWidth: 1,
        });
      y += boxHeight;

      const caption = runsText(block.caption ?? []);
      if (caption) {
        y += 4;
        for (const line of wrapText(caption, contentWidth, size_ * 0.85)) {
          primitives.push({
            type: 'text', x: left + contentWidth / 2, y, text: line,
            size: size_ * 0.85, align: 'center', fill: '#555555',
          });
          y += size_ * 1.1;
        }
      }
    }

    y += style.spaceAfter ?? 0;
  }

  pages.push({ width, height, primitives });
  return pages;
}

/** Wraps a line by character count. */
export function wrapText(text, width, size) {
  if (!text) return [''];
  const perLine = Math.max(Math.floor(width / (size * 0.5)), 8);
  const lines = [];

  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && (`${line} ${word}`).length > perLine) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }

  return lines;
}

/** Headings, for the table of contents asks for. */
export function outline(model) {
  return model.blocks
    .filter((block) => block.kind === 'heading')
    .map((block) => ({
      id: block.id,
      level: block.level ?? 1,
      text: runsText(block.runs),
    }));
}
