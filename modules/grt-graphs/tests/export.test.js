/** What leaves the program. */

import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/js/model.js';
import { toSvg, toJson, bounds, textLines } from '../src/js/export.js';

function sampleGraph() {
  const model = new GraphModel();
  const a = model.addNode({ x: 40, y: 40, text: 'Start', shape: 'ellipse' });
  const b = model.addNode({ x: 340, y: 40, text: 'Decision', shape: 'diamond' });
  model.addEdge({ from: a.id, to: b.id, label: 'yes' });
  return model;
}

describe('The exported SVG leaves no fingerprint', () => {
  it('names no software and carries no comment', () => {
    const svg = toSvg(sampleGraph());

    for (const term of ['GRT', 'Graphs', 'generator', 'Generator', 'Inkscape', 'created']) {
      expect(svg).not.toContain(term);
    }
    expect(svg).not.toContain('<!--');
    expect(svg).not.toContain('<metadata');
  });

  it('carries no date, in any form', () => {
    const svg = toSvg(sampleGraph());

    for (const year of ['2024', '2025', '2026', '2027', '1970']) {
      expect(svg).not.toContain(year);
    }
  });

  it('has no editing artefacts in it', () => {
    // Built from the model rather than by cleaning the live document, so
    // there is nothing to leak in the first place.
    const svg = toSvg(sampleGraph());

    expect(svg).not.toContain('data-');
    expect(svg).not.toContain('class=');
    expect(svg).not.toContain('selected');
  });

  it('is the same bytes every time', () => {
    const model = sampleGraph();
    expect(toSvg(model)).toBe(toSvg(model));
  });
});

describe('The exported SVG is a drawing', () => {
  it('contains one shape per node and one path per edge', () => {
    const svg = toSvg(sampleGraph());

    expect(svg).toContain('<ellipse');
    expect(svg).toContain('<polygon');
    // Counted by the arrow marker rather than by <path>, because the marker
    // definition in <defs> is itself a path.
    expect((svg.match(/marker-end="url\(#a\)"/g) ?? []).length).toBe(1);
  });

  it('escapes text that would otherwise break the markup', () => {
    const model = new GraphModel();
    model.addNode({ x: 0, y: 0, text: '<script>alert("x")</script> & more' });

    const svg = toSvg(model);

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp;');
  });

  it('does not draw a connector whose endpoint is missing', () => {
    const model = new GraphModel({
      nodes: [{ id: 'n1', x: 0, y: 0, w: 100, h: 40 }],
      edges: [{ id: 'e1', from: 'n1', to: 'gone' }],
    });

    expect(toSvg(model)).not.toContain('marker-end');
  });

  it('an empty graph still produces a valid document', () => {
    const svg = toSvg(new GraphModel());

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });
});

describe('Bounds and wrapping', () => {
  it('covers every node with padding', () => {
    const model = new GraphModel();
    model.addNode({ x: 100, y: 100, w: 100, h: 50 });
    model.addNode({ x: -50, y: 400, w: 100, h: 50 });

    const box = bounds(model, 20);

    expect(box.x).toBe(-70);
    expect(box.y).toBe(80);
    expect(box.width).toBeGreaterThanOrEqual(290);
  });

  it('wraps long text rather than letting it run off the shape', () => {
    const lines = textLines('one two three four five six seven eight', 100);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('keeps explicit line breaks', () => {
    expect(textLines('first\nsecond', 400)).toEqual(['first', 'second']);
  });
});

describe('JSON export', () => {
  it('full export round-trips through the model', () => {
    const model = sampleGraph();
    const reloaded = new GraphModel(JSON.parse(toJson(model)));

    expect(reloaded.nodes).toHaveLength(2);
    expect(reloaded.edges).toHaveLength(1);
  });

  it('logic-only export omits presentation entirely', () => {
    const exported = JSON.parse(toJson(sampleGraph(), { logicOnly: true }));

    const asText = JSON.stringify(exported);
    expect(asText).not.toContain('"x"');
    expect(asText).not.toContain('shape');
    expect(asText).not.toContain('#ffffff');
  });
});
