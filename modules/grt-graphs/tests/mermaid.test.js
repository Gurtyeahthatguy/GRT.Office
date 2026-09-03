/** Importing Mermaid flowcharts. */

import { describe, it, expect } from 'vitest';
import { parseMermaid } from '../src/js/mermaid.js';
import { GraphModel } from '../src/js/model.js';

describe('Basic flowcharts', () => {
  it('reads nodes and connectors', () => {
    const document = parseMermaid(`graph TD
      A[Start] --> B[Middle]
      B --> C[End]`);

    expect(document.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C']);
    expect(document.edges).toHaveLength(2);
    expect(document.nodes[0].text).toBe('Start');
  });

  it('accepts flowchart as well as graph', () => {
    expect(parseMermaid('flowchart LR\n A --> B').edges).toHaveLength(1);
  });

  it('declares a node mentioned only as a connector endpoint', () => {
    const document = parseMermaid('graph TD\n A --> B');

    expect(document.nodes).toHaveLength(2);
    // With no label of its own, a node shows its id.
    expect(document.nodes[1].text).toBe('B');
  });

  it('takes a label given later in the file', () => {
    const document = parseMermaid(`graph TD
      A --> B
      B[Described afterwards]`);

    expect(document.nodes.find((n) => n.id === 'B').text).toBe('Described afterwards');
  });
});

describe('Shapes', () => {
  it('maps Mermaid delimiters onto the palette', () => {
    const document = parseMermaid(`graph TD
      A[Rect] --> B(Round)
      B --> C{Choice}
      C --> D([Stadium])`);

    const shapeOf = (id) => document.nodes.find((n) => n.id === id).shape;
    expect(shapeOf('A')).toBe('rect');
    expect(shapeOf('B')).toBe('ellipse');
    expect(shapeOf('C')).toBe('diamond');
    expect(shapeOf('D')).toBe('rounded');
  });

  it('does not read a stadium as a bracket containing a parenthesis', () => {
    const document = parseMermaid('graph TD\n A([Round]) --> B');
    expect(document.nodes[0].text).toBe('Round');
  });
});

describe('Connector labels', () => {
  it('reads the pipe form', () => {
    const document = parseMermaid('graph TD\n A -->|yes| B');
    expect(document.edges[0].label).toBe('yes');
  });

  it('strips quotes from a label', () => {
    const document = parseMermaid('graph TD\n A -->|"with spaces"| B');
    expect(document.edges[0].label).toBe('with spaces');
  });
});

describe('What it refuses and what it skips', () => {
  it('refuses a diagram type it does not understand', () => {
    // Better than importing a sequence diagram as nonsense.
    expect(() => parseMermaid('sequenceDiagram\n Alice->>Bob: Hi'))
      .toThrow(/graph.*flowchart/i);
  });

  it('refuses an empty document', () => {
    expect(() => parseMermaid('   \n\n')).toThrow();
  });

  it('ignores comments', () => {
    const document = parseMermaid(`graph TD
      %% this is a note
      A --> B`);
    expect(document.nodes).toHaveLength(2);
  });

  it('flattens a subgraph rather than mis-parsing it', () => {
    // Container nodes are deferred, so members arrive as ordinary nodes
    // and nothing is lost except the grouping.
    const document = parseMermaid(`graph TD
      subgraph one
      A --> B
      end
      B --> C`);

    expect(document.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C']);
    expect(document.edges).toHaveLength(2);
  });

  it('skips styling directives', () => {
    const document = parseMermaid(`graph TD
      A --> B
      style A fill:#f9f
      classDef big font-size:20px`);

    expect(document.nodes).toHaveLength(2);
  });
});

describe('The result is a document this program can open', () => {
  it('loads straight into the model with defaults filled in', () => {
    const model = new GraphModel(parseMermaid(`graph TD
      A[Start] -->|go| B{Choose}
      B --> C[Done]`));

    expect(model.nodes).toHaveLength(3);
    expect(model.edges).toHaveLength(2);
    expect(model.nodes[0].w).toBe(160);
    expect(model.validate().dangling).toEqual([]);
  });

  it('carries no positions, so the caller must lay it out', () => {
    const document = parseMermaid('graph TD\n A --> B');
    expect(document.nodes.every((n) => n.x === undefined)).toBe(true);
  });
});
