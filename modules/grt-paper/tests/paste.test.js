/** What the clipboard is allowed to put in a document. */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { blocksFromHtml, blocksFromText, isRepresentable } from '../src/js/core/editor/paste.js';
import { PaperModel, runsText } from '../src/js/core/editor/model.js';

let document;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
});

const paste = (html) => blocksFromHtml(html, document);

describe('Nothing unrepresentable gets through', () => {
  it('a script is dropped, tag and contents alike', () => {
    const { blocks, dropped } = paste('<p>before</p><script>alert(1)</script><p>after</p>');

    expect(blocks).toHaveLength(2);
    expect(JSON.stringify(blocks)).not.toContain('alert');
    expect(dropped).toContain('script');
  });

  it('styles, iframes and forms go the same way', () => {
    const { blocks } = paste(
      '<style>p{color:red}</style><iframe src="x"></iframe><form><input></form><p>kept</p>',
    );

    expect(blocks).toHaveLength(1);
    expect(runsText(blocks[0].runs)).toBe('kept');
  });

  it('inline styles and classes do not survive', () => {
    const { blocks } = paste('<p style="color:red" class="x" onclick="hack()">text</p>');

    expect(JSON.stringify(blocks)).not.toContain('color:red');
    expect(JSON.stringify(blocks)).not.toContain('onclick');
    expect(JSON.stringify(blocks)).not.toContain('class');
  });

  it('a link keeps its words and loses its address', () => {
    // forbids the network outright, so an address the program will never
    // follow is a trace to carry and nothing else.
    const { blocks } = paste('<p>see <a href="https://example.com/track?id=99">this</a></p>');

    expect(runsText(blocks[0].runs)).toBe('see this');
    expect(JSON.stringify(blocks)).not.toContain('example.com');
  });

  it('a remote image is reported rather than kept', () => {
    const { blocks, dropped } = paste('<p>a<img src="https://example.com/pixel.gif">b</p>');

    expect(JSON.stringify(blocks)).not.toContain('example.com');
    expect(dropped).toContain('images');
  });

  it('everything produced passes the representable check', () => {
    const { blocks } = paste(`
      <h1>Title</h1><p>Some <b>bold</b> and <i>italic</i>.</p>
      <ul><li>one</li><li>two</li></ul><blockquote>quoted</blockquote>`);

    expect(isRepresentable(blocks)).toBe(true);
  });

  it('and the check itself can fail', () => {
    // Otherwise the assertion above would prove nothing.
    expect(isRepresentable([{ kind: 'paragraph', runs: [{ text: 'x', onclick: 'hack()' }] }]))
      .toBe(false);
    expect(isRepresentable([{ kind: 'video', runs: [] }])).toBe(false);
  });
});

describe('What is worth keeping is kept', () => {
  it('headings arrive as headings, at their level', () => {
    const { blocks } = paste('<h1>One</h1><h3>Three</h3>');

    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3 });
  });

  it('bold and italic survive as run marks', () => {
    const { blocks } = paste('<p>plain <b>bold</b> <i>italic</i></p>');
    const runs = blocks[0].runs;

    expect(runs.find((r) => r.text === 'bold')?.bold).toBe(true);
    expect(runs.find((r) => r.text === 'italic')?.italic).toBe(true);
  });

  it('nested marks become one run with both attributes', () => {
    // The model does not nest runs: one state, one representation.
    const { blocks } = paste('<p><b><i>both</i></b></p>');

    expect(blocks[0].runs[0]).toEqual({ text: 'both', bold: true, italic: true });
  });

  it('lists arrive as list blocks with their items', () => {
    const { blocks } = paste('<ul><li>alpha</li><li>beta</li></ul>');

    expect(blocks[0].kind).toBe('list');
    expect(blocks[0].items).toHaveLength(2);
    expect(runsText(blocks[0].items[1].runs)).toBe('beta');
  });

  it('an ordered list is a numbered one', () => {
    expect(paste('<ol><li>x</li></ol>').blocks[0].listType).toBe('number');
  });

  it('a table is flattened to its text and reported', () => {
    const { blocks, dropped } = paste('<table><tr><td>left</td><td>right</td></tr></table>');

    expect(dropped).toContain('tables');
    expect(blocks.map((b) => runsText(b.runs))).toEqual(['left', 'right']);
  });

  it('whitespace from the source markup is collapsed', () => {
    const { blocks } = paste('<p>\n   spaced      out\n</p>');
    expect(runsText(blocks[0].runs)).toBe(' spaced out ');
  });

  it('empty paragraphs are not carried over', () => {
    const { blocks } = paste('<p>text</p><p></p><p>   </p><p>more</p>');
    expect(blocks).toHaveLength(2);
  });
});

describe('Plain text', () => {
  it('becomes one paragraph per line', () => {
    const blocks = blocksFromText('first\nsecond\nthird');

    expect(blocks).toHaveLength(3);
    expect(runsText(blocks[2].runs)).toBe('third');
  });

  it('blank lines separate rather than producing empty paragraphs', () => {
    expect(blocksFromText('one\n\n\ntwo')).toHaveLength(2);
  });
});

describe('The result loads into a document', () => {
  it('pasted blocks survive being put through the model', () => {
    const { blocks } = paste('<h2>Heading</h2><p>Body <b>text</b></p><ul><li>item</li></ul>');
    const model = new PaperModel({ blocks });

    expect(model.blocks).toHaveLength(3);
    expect(model.blocks[0].style).toBe('h2');
    expect(model.blocks[2].items[0].runs[0].text).toBe('item');
  });
});
