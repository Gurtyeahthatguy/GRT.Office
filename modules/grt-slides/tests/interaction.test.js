/** Hit resolution and text round-tripping. */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { hitTarget } from '../src/js/interaction.js';
import { runsToHtml, htmlToRuns } from '../src/js/text.js';

let dom;
let document;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  document = dom.window.document;
  // htmlToRuns walks nodes and needs the Node constants.
  globalThis.Node = dom.window.Node;
});

function textElement(id) {
  const box = document.createElement('div');
  box.className = 'el text';
  box.dataset.id = id;
  const inner = document.createElement('strong');
  inner.textContent = 'Title';
  box.append(inner);
  document.body.append(box);
  return { box, inner };
}

describe('Clicking an element', () => {
  it('resolves from a child of the box', () => {
    const { inner } = textElement('eabc');
    expect(hitTarget(inner)).toMatchObject({ kind: 'element', id: 'eabc' });
  });

  it('resolves from the box itself', () => {
    const { box } = textElement('eabc');
    expect(hitTarget(box)).toMatchObject({ kind: 'element', id: 'eabc' });
  });
});

describe('Handles win over the element beneath them', () => {
  it('a resize handle resolves as a handle', () => {
    const handle = document.createElement('div');
    handle.className = 'handle handle-se';
    handle.dataset.id = 'eabc';
    handle.dataset.handle = 'se';
    document.body.append(handle);

    expect(hitTarget(handle)).toEqual({ kind: 'handle', id: 'eabc', handle: 'se' });
  });

  it('the rotate handle is a handle too', () => {
    const handle = document.createElement('div');
    handle.className = 'handle handle-rotate';
    handle.dataset.id = 'eabc';
    handle.dataset.handle = 'rotate';
    document.body.append(handle);

    expect(hitTarget(handle).handle).toBe('rotate');
  });
});

describe('Empty stage', () => {
  it('an element with no id above it is not a target', () => {
    const loose = document.createElement('div');
    document.body.append(loose);
    expect(hitTarget(loose).kind).toBe('stage');
  });

  it('null is handled rather than thrown on', () => {
    expect(hitTarget(null).kind).toBe('stage');
  });
});

describe('Runs survive a trip through the editor', () => {
  it('plain text comes back unchanged', () => {
    const box = document.createElement('div');
    box.innerHTML = runsToHtml([{ text: 'Hello there' }]);
    document.body.append(box);

    expect(htmlToRuns(box)).toEqual([{ text: 'Hello there' }]);
  });

  it('formatting is preserved per run', () => {
    const runs = [{ text: 'plain ' }, { text: 'bold', bold: true }, { text: ' end' }];
    const box = document.createElement('div');
    box.innerHTML = runsToHtml(runs);
    document.body.append(box);

    expect(htmlToRuns(box)).toEqual(runs);
  });

  it('nested formatting comes back as one run with both flags', () => {
    const box = document.createElement('div');
    box.innerHTML = '<b><i>both</i></b>';
    document.body.append(box);

    expect(htmlToRuns(box)).toEqual([{ text: 'both', bold: true, italic: true }]);
  });

  it('adjacent pieces with identical formatting are merged', () => {
    // Typing produces a node per keystroke in some engines; without merging,
    // a word would become a run per letter.
    const box = document.createElement('div');
    box.innerHTML = '<b>a</b><b>b</b><b>c</b>';
    document.body.append(box);

    expect(htmlToRuns(box)).toEqual([{ text: 'abc', bold: true }]);
  });

  it('a line break becomes a newline in the run', () => {
    const box = document.createElement('div');
    box.innerHTML = 'first<br>second';
    document.body.append(box);

    expect(htmlToRuns(box).map((r) => r.text).join('')).toBe('first\nsecond');
  });

  it('an emptied box yields one empty run rather than nothing', () => {
    const box = document.createElement('div');
    document.body.append(box);

    expect(htmlToRuns(box)).toEqual([{ text: '' }]);
  });

  it('escapes text that would otherwise become markup', () => {
    const box = document.createElement('div');
    box.innerHTML = runsToHtml([{ text: '<b>not bold</b>' }]);
    document.body.append(box);

    expect(box.querySelector('b')).toBeNull();
    expect(htmlToRuns(box)).toEqual([{ text: '<b>not bold</b>' }]);
  });
});
