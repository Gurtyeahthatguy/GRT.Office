/** Paragraphs of a text box: lists at nine levels, spacing, and the runs inside each, as Impress keeps them. */

import { normaliseRuns, formatRuns, splitRuns, MARKS } from './core/editor/model.js';

export const LEVELS = 9;
const BULLETS = ['•', '–', '▪', '◦', '•', '–', '▪', '◦', '•'];

/** A paragraph's own settings: its list level, whether it is a bulleted or numbered item. */
export function normalisePara(para) {
  const level = Math.max(0, Math.min(LEVELS - 1, Math.trunc(Number(para?.level) || 0)));
  const list = para?.list === 'bullet' || para?.list === 'number' ? para.list : null;
  return { level, ...(list ? { list } : {}) };
}

/** The runs of each paragraph; a new line in the text ends a paragraph. */
export function splitParagraphs(content) {
  const out = [[]];
  for (const run of content ?? []) {
    const pieces = run.text.split('\n');
    pieces.forEach((piece, i) => {
      if (i > 0) out.push([]);
      if (piece !== '') out[out.length - 1].push({ ...run, text: piece });
    });
  }
  return out;
}

/** Paragraphs back to one run list and the settings of each. */
export function joinParagraphs(paragraphs) {
  const runs = [];
  paragraphs.forEach((p, i) => {
    if (i > 0) runs.push({ text: '\n' });
    runs.push(...p.runs);
  });
  return { content: cleanRuns(runs), paras: paragraphs.map((p) => normalisePara(p)) };
}

/** Runs merged and cleaned as the core's editor does, kept non-empty. */
export function cleanRuns(runs) {
  return normaliseRuns(runs);
}

/** The settings of each paragraph, one per paragraph of the content. */
export function parasFor(element) {
  const count = splitParagraphs(element.content).length;
  return Array.from({ length: count }, (_, i) => normalisePara(element.paras?.[i]));
}

/** What a list item starts with: its bullet, or its number in the form its level uses. */
export function labelFor(para, number) {
  if (para.list === 'bullet') return BULLETS[para.level];
  if (para.list === 'number') {
    const form = para.level % 3;
    if (form === 1) return `${String.fromCharCode(96 + (((number - 1) % 26) + 1))}.`;
    if (form === 2) return `${toRoman(number).toLowerCase()}.`;
    return `${number}.`;
  }
  return '';
}

function toRoman(n) {
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let rest = n;
  let out = '';
  for (const [value, letters] of table) while (rest >= value) { out += letters; rest -= value; }
  return out;
}

/** The numbers of the numbered items, counted per level and started again when a list breaks. */
export function numbersFor(paras) {
  const counters = Array(LEVELS).fill(0);
  return paras.map((para) => {
    if (para.list !== 'number') {
      if (!para.list) counters.fill(0);
      return 0;
    }
    counters[para.level] += 1;
    for (let l = para.level + 1; l < LEVELS; l += 1) counters[l] = 0;
    return counters[para.level];
  });
}

/** How far a level is indented, in the slide's pixels. */
export const indentOf = (level, element) => level * (element.indent ?? 36);

// Changes to the paragraphs of a whole box

/** Sets the list of the paragraphs between two indices (inclusive), or of all when no range is given. */
export function setList(element, list, from = 0, to = Infinity) {
  const paras = parasFor(element);
  const all = paras.slice(from, to + 1).every((p) => p.list === list);
  return paras.map((p, i) => (i >= from && i <= to ? normalisePara({ ...p, list: all ? null : list }) : p));
}

export function shiftLevel(element, by, from = 0, to = Infinity) {
  return parasFor(element).map((p, i) => (i >= from && i <= to ? normalisePara({ ...p, level: p.level + by }) : p));
}

/** Moves paragraphs up or down past their neighbour, their settings with them. */
export function moveParagraphs(element, by, from, to) {
  const paragraphs = splitParagraphs(element.content).map((runs, i) => ({ runs, ...parasFor(element)[i] }));
  const last = Math.min(to, paragraphs.length - 1);
  if ((by < 0 && from === 0) || (by > 0 && last >= paragraphs.length - 1)) return null;
  const moved = paragraphs.splice(from, last - from + 1);
  paragraphs.splice(from + by, 0, ...moved);
  return joinParagraphs(paragraphs);
}

// Editing in place

const escape = (value) => String(value ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** The inline CSS of a run's formatting. */
export function runCss(run, units = 'px') {
  const css = [];
  const lines = [run.underline || run.double ? 'underline' : '', run.strike ? 'line-through' : '', run.overline ? 'overline' : ''].filter(Boolean);
  if (lines.length) css.push(`text-decoration-line:${lines.join(' ')}`);
  if (run.double) css.push('text-decoration-style:double');
  if (run.bold) css.push('font-weight:700');
  if (run.italic) css.push('font-style:italic');
  if (run.sup) css.push('vertical-align:super;font-size:0.6em');
  if (run.sub) css.push('vertical-align:sub;font-size:0.6em');
  if (run.shadow) css.push('text-shadow:0.06em 0.06em 0 rgba(0,0,0,0.35)');
  if (run.outline) css.push('-webkit-text-stroke:0.04em currentColor;-webkit-text-fill-color:transparent');
  if (run.smallcaps) css.push('font-variant:small-caps');
  if (run.color) css.push(`color:${run.color}`);
  if (run.highlight) css.push(`background-color:${run.highlight}`);
  if (run.size && !run.sup && !run.sub) css.push(`font-size:${run.size}${units}`);
  // While its box is edited, covered text stays readable on black to its author.
  if (run.redact) css.push('background-color:#111;color:#ddd');
  return css.join(';');
}

/** The formatting a span carries, written so the box can be read back without guessing. */
const runData = (run) => {
  const own = {};
  for (const mark of MARKS) if (run[mark]) own[mark] = true;
  for (const key of ['color', 'highlight', 'size', 'link', 'redact']) if (run[key]) own[key] = run[key];
  return JSON.stringify(own);
};

/** A box's content as the markup it is edited in: one block per paragraph, each run a span. */
export function editMarkup(element) {
  const paras = parasFor(element);
  const numbers = numbersFor(paras);
  return splitParagraphs(element.content).map((runs, i) => {
    const para = paras[i];
    const inner = runs.map((run) => `<span data-run="${escape(runData(run))}" style="${escape(runCss(run))}">${escape(run.text)}</span>`).join('') || '<br>';
    const label = labelFor(para, numbers[i]);
    return `<div class="para" data-level="${para.level}"${para.list ? ` data-list="${para.list}"` : ''}${label ? ` data-label="${escape(label)}"` : ''} style="margin-left:${indentOf(para.level, element) + (para.list ? 28 : 0)}px">${inner}</div>`;
  }).join('');
}

/** What an edited box holds now: its runs and the settings of its paragraphs. */
export function readEdit(node) {
  const paragraphs = [];
  let current = null;
  const begin = (block) => {
    current = { runs: [], level: Number(block?.dataset?.level ?? 0), list: block?.dataset?.list ?? null };
    paragraphs.push(current);
  };
  const walk = (child, format) => {
    if (child.nodeType === 3) {
      if (!current) begin(null);
      if (child.nodeValue !== '') current.runs.push({ ...format, text: child.nodeValue });
      return;
    }
    if (child.nodeType !== 1) return;
    const tag = child.nodeName.toLowerCase();
    if (tag === 'br') return;
    let own = format;
    if (child.dataset?.run) {
      try { own = { ...format, ...JSON.parse(child.dataset.run) }; } catch { own = format; }
    }
    if (tag === 'b' || tag === 'strong') own = { ...own, bold: true };
    if (tag === 'i' || tag === 'em') own = { ...own, italic: true };
    if (tag === 'u') own = { ...own, underline: true };
    if (tag === 's' || tag === 'strike') own = { ...own, strike: true };
    if (tag === 'sup') own = { ...own, sup: true };
    if (tag === 'sub') own = { ...own, sub: true };
    for (const grand of child.childNodes) walk(grand, own);
  };
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && (child.nodeName === 'DIV' || child.nodeName === 'P')) {
      begin(child);
      for (const grand of child.childNodes) walk(grand, {});
      current = null;
    } else walk(child, {});
  }
  if (paragraphs.length === 0) begin(null);
  return joinParagraphs(paragraphs.map((p) => ({ ...p, runs: p.runs })));
}

/** Where a point of the DOM falls in the box's text, paragraphs counted as one character apart. */
export function offsetIn(node, container, offset) {
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(container, offset);
  const part = range.cloneContents();
  const blocks = [...part.childNodes].filter((n) => n.nodeType === 1 && (n.nodeName === 'DIV' || n.nodeName === 'P')).length;
  return part.textContent.length + Math.max(0, blocks - 1);
}

/** Puts the DOM selection back over a range of the box's text. */
export function selectIn(node, from, to) {
  const place = (target) => {
    let total = 0;
    const blocks = [...node.childNodes];
    for (let b = 0; b < blocks.length; b += 1) {
      if (b > 0) total += 1;
      const walker = document.createTreeWalker(blocks[b], NodeFilter.SHOW_TEXT);
      let last = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (target <= total + n.nodeValue.length) return [n, target - total];
        total += n.nodeValue.length;
        last = n;
      }
      if (target <= total) return last ? [last, last.nodeValue.length] : [blocks[b], 0];
    }
    return [node, node.childNodes.length];
  };
  const range = document.createRange();
  const [a, aOff] = place(from);
  const [z, zOff] = place(to);
  range.setStart(a, aOff);
  range.setEnd(z, zOff);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Applies a mark (or a value, such as a size) to part of the text. */
export function formatPart(content, from, to, mark, value = null) {
  return formatRuns(content, from, to, mark, value);
}

/** Changes the text of part of the content, each run keeping its formatting. */
export function mapPart(content, from, to, change) {
  const [before, rest] = splitRuns(content, from);
  const [middle, after] = splitRuns(rest, to - from);
  return normaliseRuns([...before, ...change(middle), ...after]);
}

/** The paragraph indices a range of the text covers. */
export function paragraphsIn(content, from, to) {
  const text = (content ?? []).map((r) => r.text).join('');
  const first = text.slice(0, from).split('\n').length - 1;
  const last = text.slice(0, Math.max(from, to)).split('\n').length - 1;
  return [first, last];
}
