/** Obsidian's Markdown to the editor's blocks and back, unchanged blocks written as they were read. */

import { markdownParser } from '../markdown.js';
import { normaliseRuns, makeBlock } from '../editor/model.js';

const HIGHLIGHT = '#fff3a8';

// Parsing

/** ==text==, Obsidian's highlight. */
function highlightRule(state, silent) {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x3D || src.charCodeAt(start + 1) !== 0x3D) return false;
  let end = start + 2;
  for (; end < state.posMax - 1; end += 1) {
    if (src.charCodeAt(end) === 0x5C) {
      end += 1;
    } else if (src.charCodeAt(end) === 0x3D && src.charCodeAt(end + 1) === 0x3D) break;
  }
  if (end >= state.posMax - 1 || end === start + 2) return false;
  if (/\s/.test(src[start + 2]) || /\s/.test(src[end - 1])) return false;
  if (!silent) {
    const max = state.posMax;
    state.push('mark_open', 'mark', 1).markup = '==';
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push('mark_close', 'mark', -1).markup = '==';
  }
  state.pos = end + 2;
  return true;
}

function parser() {
  const md = markdownParser({ html: true }).enable(['table', 'strikethrough']);
  md.block.ruler.disable('reference');
  // Escapes and entities keep the characters they were written with.
  md.core.ruler.disable('text_join');
  md.inline.ruler.before('emphasis', 'grt_highlight', highlightRule);
  return md;
}

let shared = null;

/** The runs a line of inline tokens makes, keeping what is not formatting as written. */
function inlineRuns(children) {
  const runs = [];
  const marks = {};
  const links = [];
  const add = (text) => {
    if (text !== '') runs.push({ text, ...marks });
  };
  for (const token of children ?? []) {
    switch (token.type) {
      case 'text': add(token.content); break;
      case 'text_special': add(token.markup); break;
      case 'softbreak': case 'hardbreak': add('\n'); break;
      case 'strong_open': marks.bold = true; break;
      case 'strong_close': delete marks.bold; break;
      case 'em_open': marks.italic = true; break;
      case 'em_close': delete marks.italic; break;
      case 's_open': marks.strike = true; break;
      case 's_close': delete marks.strike; break;
      case 'mark_open': marks.highlight = HIGHLIGHT; break;
      case 'mark_close': delete marks.highlight; break;
      case 'code_inline': add(`${token.markup}${token.content}${token.markup}`); break;
      case 'html_inline': add(token.content); break;
      case 'link_open':
        links.push(token);
        add('[');
        break;
      case 'link_close': {
        const open = links.pop();
        const href = open?.attrGet('href') ?? '';
        const title = open?.attrGet('title');
        add(`](${href}${title ? ` "${title}"` : ''})`);
        break;
      }
      case 'image': {
        const title = token.attrGet('title');
        add(`![${token.content}](${token.attrGet('src') ?? ''}${title ? ` "${title}"` : ''})`);
        break;
      }
      default:
        if (token.content) add(token.content);
    }
  }
  return normaliseRuns(runs);
}

/** A block's content without its identity, to see later whether it changed. */
function signature(block) {
  const { id, md, style, align, ...content } = block;
  return JSON.stringify(content);
}

/** The tokens of one top-level block: from an opening token to its close. */
function topLevel(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.level !== 0 || !token.map) continue;
    let end = i;
    if (token.nesting === 1) {
      let depth = 0;
      for (end = i; end < tokens.length; end += 1) {
        depth += tokens[end].nesting;
        if (depth === 0) break;
      }
    }
    out.push({ tokens: tokens.slice(i, end + 1), map: token.map });
    i = end;
  }
  return out;
}

/** A list's items, when every one is a line of text, nested lists allowed; null when not. */
function simpleList(tokens) {
  const items = [];
  let depth = -1;
  let open = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') depth += 1;
    else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') depth -= 1;
    else if (token.type === 'list_item_open') {
      open = { level: depth, runs: null, paragraphs: 0 };
      items.push(open);
    } else if (token.type === 'paragraph_open') {
      if (!open || open.paragraphs > 0) return null;
      open.paragraphs += 1;
      open.runs = inlineRuns(tokens[i + 1].children);
      i += 2;
    } else if (!['list_item_close'].includes(token.type)) {
      return null;
    }
  }
  if (items.some((item) => item.level > 5)) return null;
  return items.map((item) => ({ level: item.level, runs: item.runs ?? [{ text: '' }] }));
}

const TASK = /^\[([ xX])\] ?/;

/** Takes a task's checkbox off the front of its runs. */
function withoutTask(runs) {
  const first = runs[0];
  const match = TASK.exec(first?.text ?? '');
  if (!match) return null;
  return {
    done: match[1] !== ' ',
    runs: normaliseRuns([{ ...first, text: first.text.slice(match[0].length) }, ...runs.slice(1)]),
  };
}

/** The blocks one top-level piece of Markdown becomes. */
function blocksOf(piece, lines) {
  const [first] = piece.tokens;
  const source = lines.slice(piece.map[0], piece.map[1]);
  // Markdown the editor has no block for is kept as its own text, edited as lines.
  const raw = () => {
    const block = makeBlock('raw', { style: 'code' });
    block.runs = [{ text: source.join('\n') }];
    return [block];
  };

  if (first.type === 'heading_open') {
    const block = makeBlock('heading', { level: Math.min(Number(first.tag.slice(1)), 4) });
    block.level = Number(first.tag.slice(1));
    block.style = `h${Math.min(block.level, 4)}`;
    block.runs = inlineRuns(piece.tokens[1].children);
    if (first.markup === '=' || first.markup === '-') block.setext = true;
    return [block];
  }
  if (first.type === 'paragraph_open') {
    const block = makeBlock('paragraph');
    block.runs = inlineRuns(piece.tokens[1].children);
    return [block];
  }
  if (first.type === 'fence') {
    const block = makeBlock('code');
    block.runs = [{ text: first.content.replace(/\n$/, '') }];
    block.language = first.info ?? '';
    block.fence = first.markup;
    return [block];
  }
  if (first.type === 'bullet_list_open' || first.type === 'ordered_list_open') {
    const items = simpleList(piece.tokens);
    if (!items) return raw();
    const tasks = items.map((item) => withoutTask(item.runs));
    const ordered = first.type === 'ordered_list_open';
    // A list of tasks and nothing else is a run of task blocks.
    if (!ordered && items.every((item) => item.level === 0) && tasks.every(Boolean)) {
      return tasks.map((task) => {
        const block = makeBlock('todo', { extra: { done: task.done } });
        block.runs = task.runs;
        block.marker = first.markup;
        return block;
      });
    }
    const block = makeBlock('list', { listType: ordered ? 'number' : 'bullet' });
    block.items = items;
    block.marker = first.markup;
    const start = Number(first.attrGet('start') ?? 1);
    if (ordered && start !== 1) block.start = start;
    const nested = source.find((line, i) => i > 0 && /^\s+([-*+]|\d+[.)])\s/.test(line));
    if (nested) block.indent = /^(\s+)/.exec(nested)[1];
    return [block];
  }
  if (first.type === 'blockquote_open') {
    const inner = piece.tokens.slice(1, -1);
    const paragraphs = [];
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i].type === 'paragraph_open') {
        paragraphs.push(inlineRuns(inner[i + 1].children));
        i += 2;
      } else {
        return raw();
      }
    }
    const joined = (list) => normaliseRuns(list.flatMap((runs, i) => (i === 0 ? runs : [{ text: '\n\n' }, ...runs])));
    const head = paragraphs[0] ?? [{ text: '' }];
    const callout = /^\s*>[ \t]?\[!([^\]]+)\]([+-]?)[ \t]*(.*)$/.exec(source[0] ?? '');
    if (callout && paragraphs.length > 0) {
      const text = head.map((r) => r.text).join('');
      const rest = text.indexOf('\n') === -1 ? [] : sliceRuns(head, text.indexOf('\n') + 1);
      const block = makeBlock('callout', { extra: { tone: calloutTone(callout[1]) } });
      block.calloutType = callout[1];
      block.fold = callout[2];
      block.title = callout[3];
      block.runs = joined([rest, ...paragraphs.slice(1)].filter((runs) => runs.length > 0 && runs.some((r) => r.text !== '')));
      return [block];
    }
    const block = makeBlock('quote');
    block.runs = joined(paragraphs);
    return [block];
  }
  if (first.type === 'code_block') {
    const block = makeBlock('code');
    block.runs = [{ text: first.content.replace(/\n$/, '') }];
    block.indented = true;
    return [block];
  }
  return raw();
}

/** Runs from a character offset to the end. */
function sliceRuns(runs, from) {
  const out = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.text.length;
    if (end > from) out.push({ ...run, text: run.text.slice(Math.max(0, from - at)) });
    at = end;
  }
  return normaliseRuns(out);
}

/** Obsidian's many callout types, as the three looks Notes draws. */
export function calloutTone(type) {
  const name = String(type ?? '').toLowerCase();
  if (/^(warning|caution|attention|danger|error|bug|failure|fail|missing)$/.test(name)) return 'warning';
  if (/^(tip|hint|important|success|check|done|idea|question|help|faq|example)$/.test(name)) return 'idea';
  return 'note';
}

/**
 * Takes note again of what each block holds, once the editor has filled in its defaults.
 */
export function settleSignatures(blocks) {
  for (const block of blocks) if (block.md) block.md.sig = signature(block);
  return blocks;
}

// Properties

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function scalar(text) {
  const value = text.trim();
  if (/^".*"$/.test(value)) return { type: 'text', value: value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
  if (/^'.*'$/.test(value)) return { type: 'text', value: value.slice(1, -1).replace(/''/g, "'") };
  if (value === 'true' || value === 'false') return { type: 'checkbox', value: value === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(value)) return { type: 'number', value: Number(value) };
  if (DATE.test(value)) return { type: 'date', value };
  if (DATETIME.test(value)) return { type: 'datetime', value };
  return { type: 'text', value };
}

/**
 * Obsidian's properties, lines not understood kept as they are.
 * @returns {{key: string, type: string, value: any, lines: string[]}[]}
 */
export function readProperties(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^([^\s#:][^:]*?):(?:[ \t]+(.*))?$/.exec(line);
    if (!match) {
      if (out.length > 0 && out[out.length - 1].type === 'raw') out[out.length - 1].lines.push(line);
      else out.push({ key: null, type: 'raw', value: null, lines: [line] });
      continue;
    }
    const key = match[1];
    const rest = match[2] ?? '';
    const block = [line];
    while (i + 1 < lines.length && /^(\s+|-\s|-$)/.test(lines[i + 1]) && !/^[^\s#:][^:]*:/.test(lines[i + 1])) {
      i += 1;
      block.push(lines[i]);
    }
    if (block.length > 1) {
      const items = block.slice(1).map((l) => /^\s*-\s?(.*)$/.exec(l));
      if (rest === '' && items.every(Boolean)) {
        out.push({ key, type: 'list', value: items.map((m) => scalar(m[1]).value).map(String), lines: block });
      } else {
        out.push({ key, type: 'raw', value: null, lines: block });
      }
      continue;
    }
    if (rest === '') {
      out.push({ key, type: 'text', value: null, lines: block });
    } else if (/^\[.*\]$/.test(rest.trim())) {
      const inner = rest.trim().slice(1, -1).trim();
      out.push({ key, type: 'list', value: inner === '' ? [] : inner.split(',').map((item) => String(scalar(item).value)), lines: block });
    } else if (/^[|>]/.test(rest.trim()) || /^[{&*!]/.test(rest.trim())) {
      out.push({ key, type: 'raw', value: null, lines: block });
    } else {
      const { type, value } = scalar(rest);
      out.push({ key, type, value, lines: block });
    }
  }
  return out;
}

function quoteIfNeeded(text) {
  const value = String(text ?? '');
  const ambiguous = value === '' || /^[\s>|!&*{}[\],#?%@`'"-]/.test(value) || /: |\s#|\s$/.test(value)
    || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value) || DATE.test(value) || DATETIME.test(value);
  return ambiguous ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

/** A property's lines as Obsidian writes them. */
export function propertyLines(property) {
  const { key, type, value } = property;
  if (type === 'raw') return property.lines;
  if (value === null || value === undefined || (type === 'text' && value === '')) return [`${key}:`];
  if (type === 'list') {
    const items = Array.isArray(value) ? value : [];
    return items.length === 0 ? [`${key}: []`] : [`${key}:`, ...items.map((item) => `  - ${quoteIfNeeded(item)}`)];
  }
  if (type === 'checkbox') return [`${key}: ${value ? 'true' : 'false'}`];
  if (type === 'number') return [`${key}: ${Number(value)}`];
  if (type === 'date' || type === 'datetime') return [`${key}: ${value}`];
  return [`${key}: ${quoteIfNeeded(value)}`];
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Reading a note

/**
 * @param {string} text the file
 * @returns {object} a note document: blocks, properties, and what writing it back needs
 */
export function readObsidianNote(text) {
  shared ??= parser();
  const source = String(text);
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);

  let frontmatter = null;
  let offset = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    const closeDots = lines.indexOf('...', 1);
    const end = [close, closeDots].filter((n) => n > 0).sort((a, b) => a - b)[0];
    if (end) {
      frontmatter = { lines: lines.slice(1, end), close: lines[end] };
      offset = end + 1;
    }
  }
  const content = lines.slice(offset);
  const tokens = shared.parse(content.join('\n'), {});
  const blocks = [];
  let previousEnd = 0;
  let group = 0;
  for (const piece of topLevel(tokens)) {
    let end = piece.map[1];
    while (end > piece.map[0] + 1 && content[end - 1].trim() === '') end -= 1;
    const made = blocksOf({ ...piece, map: [piece.map[0], end] }, content);
    group += 1;
    made.forEach((block, i) => {
      block.md = {
        group, size: made.length, index: i, sig: signature(block),
        ...(i === 0 ? { gap: content.slice(previousEnd, piece.map[0]), source: content.slice(piece.map[0], end) } : {}),
      };
      blocks.push(block);
    });
    previousEnd = end;
  }
  const properties = frontmatter ? readProperties(frontmatter.lines) : [];

  return {
    blocks: blocks.length > 0 ? blocks : [makeBlock('paragraph')],
    properties: properties.map((p) => ({ key: p.key, type: p.type, value: p.value, ...(p.type === 'raw' ? { lines: p.lines } : {}) })),
    markdown: {
      bom, eol,
      frontmatter: frontmatter ? { close: frontmatter.close, properties } : null,
      trailing: content.slice(previousEnd),
    },
  };
}

// Writing a note

function runsToMarkdown(runs) {
  return (runs ?? []).map((run) => {
    let text = run.text;
    if (text === '') return '';
    const lead = /^\s*/.exec(text)[0];
    const tail = /\s*$/.exec(text.slice(lead.length))[0];
    let core = text.slice(lead.length, text.length - tail.length);
    if (core === '') return text;
    if (run.underline) core = `<u>${core}</u>`;
    if (run.sup) core = `<sup>${core}</sup>`;
    if (run.sub) core = `<sub>${core}</sub>`;
    if (run.highlight) core = `==${core}==`;
    if (run.strike) core = `~~${core}~~`;
    if (run.italic) core = `*${core}*`;
    if (run.bold) core = `**${core}**`;
    return `${lead}${core}${tail}`;
  }).join('');
}

const prefixLines = (text, first, rest = first) => text.split('\n').map((line, i) => (i === 0 ? first : rest) + line).join('\n');

function blockMarkdown(block) {
  switch (block.kind) {
    case 'heading': {
      const level = Math.max(1, Math.min(block.level ?? 1, 6));
      return `${'#'.repeat(level)} ${runsToMarkdown(block.runs).replace(/\n/g, ' ')}`;
    }
    case 'quote': return runsToMarkdown(block.runs).split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
    case 'callout': {
      const type = block.calloutType ?? block.tone ?? 'note';
      const head = `> [!${type}]${block.fold ?? ''}${block.title ? ` ${block.title}` : ''}`;
      const text = runsToMarkdown(block.runs);
      if (text === '') return head;
      return `${head}\n${text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')}`;
    }
    case 'code': {
      const text = (block.runs ?? []).map((r) => r.text).join('');
      if (block.indented) return text.split('\n').map((line) => `    ${line}`).join('\n');
      const fence = block.fence ?? '```';
      return `${fence}${block.language ?? ''}\n${text}\n${fence}`;
    }
    case 'list': {
      const ordered = block.listType === 'number';
      const indent = block.indent ?? '\t';
      const counters = [];
      return (block.items ?? []).map((item) => {
        counters.length = item.level + 1;
        counters[item.level] = (counters[item.level] ?? (item.level === 0 ? (block.start ?? 1) : 1) - 1) + 1;
        const marker = ordered ? `${counters[item.level]}${block.marker === ')' ? ')' : '.'}` : (block.marker && /^[-*+]$/.test(block.marker) ? block.marker : '-');
        const pad = indent.repeat(item.level);
        return prefixLines(runsToMarkdown(item.runs), `${pad}${marker} `, `${pad}${' '.repeat(marker.length + 1)}`);
      }).join('\n');
    }
    case 'todo': {
      const marker = block.marker && /^[-*+]$/.test(block.marker) ? block.marker : '-';
      return prefixLines(runsToMarkdown(block.runs), `${marker} [${block.done ? 'x' : ' '}] `, '      ');
    }
    case 'embed': return `![[${block.target ?? ''}]]`;
    case 'raw': return (block.runs ?? []).map((r) => r.text).join('');
    case 'image': return `![](${block.resource ?? ''})`;
    default: return runsToMarkdown(block.runs);
  }
}

const tight = (a, b) => a && b && ((a.kind === 'todo' && b.kind === 'todo') || (a.kind === 'list' && b.kind === 'list'));

const isBlank = (block) => block.kind === 'paragraph' && (block.runs ?? []).every((r) => r.text === '');

/**
 * @param {{blocks: object[], properties: object[], markdown?: object}} note
 * @returns {string}
 */
export function writeObsidianNote(note) {
  const meta = note.markdown ?? { bom: '', eol: '\n', frontmatter: null, trailing: [''] };
  const lines = [];

  const original = meta.frontmatter?.properties ?? [];
  const properties = note.properties ?? [];
  if (meta.frontmatter || properties.length > 0) {
    lines.push('---');
    for (const property of properties) {
      const before = property.type === 'raw'
        ? original.find((p) => p.type === 'raw' && sameValue(p.lines, property.lines))
        : original.find((p) => p.key === property.key);
      if (before && before.type === property.type && sameValue(before.value, property.value)) lines.push(...before.lines);
      else lines.push(...propertyLines(property));
    }
    lines.push(meta.frontmatter?.close ?? '---');
  }

  const blocks = (note.blocks ?? []).filter((block, i, all) => !(all.length === 1 && isBlank(block) && !block.md));
  let emitted = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const md = block.md;
    if (md && md.index === 0) {
      // A piece of the file that came through untouched is written as it was.
      const run = blocks.slice(i, i + md.size);
      if (run.length === md.size && run.every((b, n) => b.md?.group === md.group && b.md.index === n && b.md.sig === signature(b))) {
        lines.push(...md.gap, ...md.source);
        emitted += 1;
        i += md.size - 1;
        continue;
      }
    }
    const gap = md?.index === 0 ? md.gap : emitted === 0 ? [] : tight(blocks[i - 1], block) ? [] : [''];
    lines.push(...gap, ...blockMarkdown(block).split('\n'));
    emitted += 1;
  }
  lines.push(...(meta.trailing ?? ['']));
  return `${meta.bom ?? ''}${lines.join(meta.eol ?? '\n')}`;
}
