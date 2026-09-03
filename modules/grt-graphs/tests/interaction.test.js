/** Hit resolution. */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { hitTarget } from '../src/js/interaction.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let document;

beforeEach(() => {
  document = new JSDOM('<!doctype html><html><body></body></html>').window.document;
});

/**
 * A node group as render.js builds it: id on the group, not on the children.
 */
function nodeGroup(id) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'node');
  group.dataset.id = id;

  const shape = document.createElementNS(SVG_NS, 'rect');
  const text = document.createElementNS(SVG_NS, 'text');
  group.append(shape, text);
  document.body.append(group);

  return { group, shape, text };
}

describe('Clicking a node', () => {
  it('resolves from the shape inside it', () => {
    const { shape } = nodeGroup('nabc');
    expect(hitTarget(shape)).toMatchObject({ kind: 'element', id: 'nabc' });
  });

  it('resolves from the text inside it', () => {
    const { text } = nodeGroup('nabc');
    expect(hitTarget(text)).toMatchObject({ kind: 'element', id: 'nabc' });
  });

  it('resolves from the group itself', () => {
    const { group } = nodeGroup('nabc');
    expect(hitTarget(group)).toMatchObject({ kind: 'element', id: 'nabc' });
  });
});

describe('Ports and handles win over the node beneath them', () => {
  it('a port resolves as a port, not as the node it sits on', () => {
    const { group } = nodeGroup('nabc');
    const port = document.createElementNS(SVG_NS, 'circle');
    port.setAttribute('class', 'port');
    port.dataset.id = 'nabc';
    port.dataset.port = 'right';
    group.append(port);

    expect(hitTarget(port)).toEqual({
      kind: 'port', id: 'nabc', port: 'right', handle: null,
    });
  });

  it('a resize handle resolves as a handle', () => {
    const handle = document.createElementNS(SVG_NS, 'rect');
    handle.setAttribute('class', 'handle');
    handle.dataset.id = 'nabc';
    handle.dataset.handle = 'se';
    document.body.append(handle);

    expect(hitTarget(handle)).toEqual({
      kind: 'handle', id: 'nabc', port: null, handle: 'se',
    });
  });
});

describe('Connectors', () => {
  it('the invisible wide hit path resolves to the edge', () => {
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('class', 'edge-hit');
    hit.dataset.id = 'exyz';
    document.body.append(hit);

    expect(hitTarget(hit)).toMatchObject({ kind: 'element', id: 'exyz' });
  });
});

describe('Empty canvas', () => {
  it('an element with no id anywhere above it is not a target', () => {
    const background = document.createElementNS(SVG_NS, 'rect');
    document.body.append(background);

    expect(hitTarget(background)).toEqual({
      kind: 'canvas', id: null, port: null, handle: null,
    });
  });

  it('null is handled rather than thrown on', () => {
    // elementFromPoint returns null when the pointer leaves the window
    // mid-gesture, which is exactly when a connector is being dropped.
    expect(hitTarget(null).kind).toBe('canvas');
  });
});
