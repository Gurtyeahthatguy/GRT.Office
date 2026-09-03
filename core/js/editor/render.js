/** Model to DOM. */

import { runsText } from './model.js';

const FONT_STACKS = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
};

export function fontStack(name, model = null) {
  const custom = model?.fonts?.find((f) => f.id === name);
  if (custom) return `"${custom.name}", ${FONT_STACKS.serif}`;
  return FONT_STACKS[name] ?? FONT_STACKS.serif;
}

/**
 * Points to CSS pixels at 96 dpi, which is what the page box is measured in.
 */
export const PT = 96 / 72;
export const MM = 96 / 25.4;

/** The CSS a named style produces. */
export function styleCss(style, model) {
  return {
    fontFamily: fontStack(style.font, model),
    fontSize: `${(style.size ?? 11) * PT}px`,
    lineHeight: String(style.lineHeight ?? 1.5),
    fontWeight: style.bold ? '700' : '400',
    fontStyle: style.italic ? 'italic' : 'normal',
    marginTop: `${(style.spaceBefore ?? 0) * PT}px`,
    marginBottom: `${(style.spaceAfter ?? 0) * PT}px`,
    paddingLeft: style.indent ? `${style.indent * PT}px` : '0px',
  };
}

export class Renderer {
  /**
   * @param {HTMLElement} surface the editable region
   */
  constructor(surface) {
    this.surface = surface;
  }

  /** Rebuilds the whole document. */
  draw(model, images = new Map()) {
    // The sheet's own padding defines the text column; setting a width here
    // as well made the two disagree by a fraction of a millimetre.
    this.surface.replaceChildren(
      ...model.blocks.map((block) => this.blockElement(block, model, images)),
    );
  }

  blockElement(block, model, images) {
    const style = model.styles[block.style] ?? model.styles.body ?? {};

    if (block.kind === 'image') {
      const figure = document.createElement('figure');
      figure.className = 'block image';
      figure.dataset.block = block.id;
      figure.style.textAlign = block.align ?? 'center';
      figure.style.margin = `${(style.spaceBefore ?? 8) * PT}px 0 ${(style.spaceAfter ?? 8) * PT}px`;

      const source = images.get(block.resource);
      if (source) {
        const image = document.createElement('img');
        image.src = source;
        image.alt = '';
        image.style.width = `${block.w}px`;
        image.style.maxWidth = '100%';
        figure.append(image);
      } else {
        // A missing image is a visible frame, not a silent hole.
        const missing = document.createElement('div');
        missing.className = 'missing-image';
        missing.style.height = `${block.h}px`;
        figure.append(missing);
      }

      if (runsText(block.caption) !== '') {
        const caption = document.createElement('figcaption');
        caption.append(...block.caption.map(runElement));
        figure.append(caption);
      }

      return figure;
    }

    if (block.kind === 'list') {
      const list = document.createElement(block.listType === 'number' ? 'ol' : 'ul');
      list.className = 'block list';
      list.dataset.blockContainer = block.id;
      Object.assign(list.style, styleCss(style, model));

      list.append(...block.items.map((item, index) => {
        const li = document.createElement('li');
        li.dataset.block = block.id;
        li.dataset.item = String(index);
        li.style.marginLeft = `${item.level * 24}px`;
        li.append(...runElements(item.runs));
        return li;
      }));

      return list;
    }

    const tag = block.kind === 'heading' ? `h${Math.min(block.level ?? 1, 6)}`
      : block.kind === 'quote' ? 'blockquote'
        : block.kind === 'code' ? 'pre' : 'p';

    const element = document.createElement(tag);
    element.className = `block ${block.kind}`;
    element.dataset.block = block.id;
    element.style.textAlign = block.align ?? 'left';
    Object.assign(element.style, styleCss(style, model));
    element.append(...runElements(block.runs));

    return element;
  }
}

/** The elements for a run list. */
export function runElements(runs) {
  if (!runs || runs.length === 0 || runsText(runs) === '') {
    return [document.createTextNode('')];
  }
  return runs.map(runElement);
}

function runElement(run) {
  const text = document.createTextNode(run.text);

  // Marks are applied as nested elements for display only.
  let node = text;
  if (run.sub) node = wrap('sub', node);
  if (run.sup) node = wrap('sup', node);
  if (run.strike) node = wrap('s', node);
  if (run.underline) node = wrap('u', node);
  if (run.italic) node = wrap('em', node);
  if (run.bold) node = wrap('strong', node);

  if (run.color || run.highlight || run.size) {
    const span = document.createElement('span');
    if (run.color) span.style.color = run.color;
    if (run.highlight) span.style.backgroundColor = run.highlight;
    if (run.size) span.style.fontSize = `${run.size * PT}px`;
    span.append(node);
    node = span;
  }

  return node;
}

function wrap(tag, child) {
  const element = document.createElement(tag);
  element.append(child);
  return element;
}
