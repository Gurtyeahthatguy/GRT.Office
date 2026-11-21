/** A note as a presentation: each heading begins a slide, what follows it the slide's points; a rule of three dashes begins one too. */

import { makeId } from '../editor/ids.js';
import { Losses } from '../losses.js';

const CANVAS = { w: 1920, h: 1080 };
const LINES_PER_SLIDE = 10;
const box = (x, y, w, h) => ({ x: Math.round(x * CANVAS.w), y: Math.round(y * CANVAS.h), w: Math.round(w * CANVAS.w), h: Math.round(h * CANVAS.h) });
const plain = (runs) => (runs ?? []).map((r) => (r.object ? '' : r.text)).join('').replace(/\s+/g, ' ').trim();

/** A text element of the presentation: its lines, each a point or plain. */
function textElement(style, placeholder, place, lines) {
  const content = [];
  const paras = [];
  lines.forEach((line, i) => {
    if (i) content.push({ text: '\n' });
    content.push(...(line.runs.length ? line.runs : [{ text: '' }]));
    paras.push(line.list ? { level: line.level ?? 0, list: line.list } : { level: 0 });
  });
  return { id: makeId('e'), kind: 'text', style, placeholder, ...place, content: content.length ? content : [{ text: '' }], ...(paras.some((p) => p.list) ? { paras } : {}) };
}

/** The runs of a line, with their looks and links and nothing a slide cannot show. */
const lineRuns = (runs) => (runs ?? []).filter((r) => !r.object).map((r) => {
  const out = { text: r.text.replace(/\n/g, ' ') };
  for (const key of ['bold', 'italic', 'underline', 'strike', 'color', 'link']) if (r[key]) out[key] = r[key];
  return out;
}).filter((r) => r.text);

/**
 * @param {{title: string, blocks: Object[]}} note
 * @returns {{document: Object, losses: Losses}} a presentation document Slides opens, and what did not come across
 */
export function noteToSlides(note) {
  const losses = new Losses();
  const slides = [];
  const slide = (layout, elements) => slides.push({ id: makeId('s'), master: null, footer: null, background: null, section: null, notes: '', transition: 'none', layout, elements });
  slide('title', [
    textElement('title', 'title', box(0.08, 0.3, 0.84, 0.2), [{ runs: [{ text: note.title || 'Untitled' }] }]),
    textElement('body', 'subtitle', box(0.15, 0.53, 0.7, 0.14), [{ runs: [] }]),
  ]);
  let title = null;
  let lines = [];
  let opening = true;
  const flush = () => {
    // What comes before the first heading is the title slide's subtitle, as far as it holds.
    if (opening) {
      opening = false;
      if (title === null) {
        const subtitle = slides[0].elements[1];
        Object.assign(subtitle, textElement('body', 'subtitle', box(0.15, 0.53, 0.7, 0.14), lines.slice(0, 3).length ? lines.slice(0, 3) : [{ runs: [] }]), { id: subtitle.id });
        lines = lines.slice(3);
        if (!lines.length) return;
        title = note.title || '';
      }
    }
    if (!title && !lines.length) return;
    for (let i = 0; i < Math.max(1, lines.length); i += LINES_PER_SLIDE) {
      const part = lines.slice(i, i + LINES_PER_SLIDE);
      const heading = i ? `${title ?? ''} (continued)` : title ?? '';
      slide('titleContent', [
        textElement('title', 'title', box(0.06, 0.05, 0.88, 0.15), [{ runs: [{ text: heading }] }]),
        textElement('body', 'body', box(0.06, 0.24, 0.88, 0.68), part.length ? part : [{ runs: [] }]),
      ]);
    }
    title = null;
    lines = [];
  };
  for (const block of note.blocks ?? []) {
    if (block.kind === 'heading' && (block.level ?? 1) <= 2) { flush(); title = plain(block.runs); continue; }
    if (block.kind === 'raw' && /^\s*-{3,}\s*$/.test(plain(block.runs))) { flush(); continue; }
    if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote' || block.kind === 'callout') {
      const runs = lineRuns(block.runs);
      if (runs.length) lines.push({ runs: block.kind === 'heading' ? runs.map((r) => ({ ...r, bold: true })) : runs });
    } else if (block.kind === 'todo') {
      lines.push({ runs: [{ text: block.done ? '☑ ' : '☐ ' }, ...lineRuns(block.runs)] });
    } else if (block.kind === 'list') {
      for (const item of block.items ?? []) lines.push({ runs: lineRuns(item.runs), list: block.listType === 'number' ? 'number' : 'bullet', level: Math.min(item.level ?? 0, 8) });
    } else if (block.kind === 'code' || block.kind === 'raw') {
      for (const line of plain(block.runs) ? (block.runs ?? []).map((r) => r.text).join('').split('\n') : []) lines.push({ runs: [{ text: line }] });
    } else if (block.kind === 'table') {
      losses.add('Tables, which a slide of points cannot show');
    } else if (block.kind === 'image' || block.kind === 'embed') {
      losses.add('Pictures and embedded notes');
    }
  }
  flush();
  return {
    document: {
      version: 1, type: 'slides', canvas: { ...CANVAS },
      theme: { background: '#ffffff', accent: '#1f6feb', text: '#222222' },
      styles: {
        title: { font: 'sans', size: 64, color: '#111111', align: 'left', bold: true, italic: false },
        body: { font: 'sans', size: 32, color: '#333333', align: 'left', bold: false, italic: false },
        caption: { font: 'sans', size: 22, color: '#666666', align: 'left', bold: false, italic: false },
      },
      fonts: [], masters: [], slides,
    },
    losses,
  };
}
