// @vitest-environment jsdom

/** A selection whose ends are elements, as choosing a whole paragraph gives, read as the text it covers. */

import { describe, it, expect } from 'vitest';
import { fromDom } from '../src/js/core/editor/selection.js';

describe('Selections ending on elements', () => {
  it('a whole paragraph chosen through its element is all its text, not a caret at its end', () => {
    document.body.innerHTML = '<div id="root"><p data-block="b1"><strong>Ciao</strong> mondo</p></div>';
    const root = document.getElementById('root');
    const p = root.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const read = fromDom(root, sel);
    expect(read.anchor).toMatchObject({ blockId: 'b1', offset: 0 });
    expect(read.focus).toMatchObject({ blockId: 'b1', offset: 10 });
    const middle = document.createRange();
    middle.setStart(p, 1);
    middle.setEnd(p, 2);
    sel.removeAllRanges();
    sel.addRange(middle);
    expect(fromDom(root, sel)).toMatchObject({ anchor: { offset: 4 }, focus: { offset: 10 } });
  });
});
