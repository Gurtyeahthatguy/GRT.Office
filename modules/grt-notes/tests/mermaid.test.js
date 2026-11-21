// @vitest-environment jsdom

/** Mermaid blocks in a note: drawn as a diagram under their source, which stays the text of the note. */

import { describe, it, expect } from 'vitest';
import { mermaidSvg, parseMermaid } from '../src/js/core/mermaid.js';
import { NotesRenderer } from '../src/js/render-notes.js';
import { readObsidianNote, writeObsidianNote } from '../src/js/core/formats/obsidian.js';

const SOURCE = 'graph TD\n  A[Inizio] --> B{Scelta}\n  B -->|sì| C(Fine)\n  B -->|no| A\n  D["<script>x</script>"]';

describe('Mermaid diagrams', () => {
  it('a flowchart becomes a picture: each node with its text, an arrow for each link, a cycle drawn once', () => {
    const svg = mermaidSvg(SOURCE);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const texts = [...doc.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toEqual(expect.arrayContaining(['Inizio', 'Scelta', 'Fine', 'sì', 'no', '<script>x</script>']));
    expect(doc.querySelectorAll('line').length).toBe(3);
    expect(doc.querySelector('script')).toBeNull();
  });

  it('left to right puts the ranks across the page', () => {
    const doc = new DOMParser().parseFromString(mermaidSvg('graph LR\nA-->B-->C'), 'image/svg+xml');
    const xs = [...doc.documentElement.children].filter((g) => g.tagName === 'g').map((g) => Number(/translate\(([\d.]+)/.exec(g.getAttribute('transform'))[1]));
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });

  it('what is not a flowchart says so instead of a picture', () => {
    expect(mermaidSvg('sequenceDiagram\nA->>B: hi')).toMatch(/Only Mermaid &quot;graph&quot; and &quot;flowchart&quot;/);
  });

  it('a note shows the diagram under the code, and the note written back is the same text', () => {
    const md = `Testo\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n`;
    const note = readObsidianNote(md);
    const surface = document.createElement('div');
    const renderer = new NotesRenderer(surface);
    const block = note.blocks.find((b) => b.kind === 'code');
    const model = { styles: { body: {}, code: {} }, blocks: note.blocks, fonts: [] };
    const element = renderer.blockElement(block, model, new Map());
    expect(element.querySelector('.mermaid-diagram[contenteditable="false"] svg')).toBeTruthy();
    expect(writeObsidianNote(note)).toContain('```mermaid\n' + SOURCE + '\n```');
  });
});

describe('Mermaid directions', () => {
  it('are the five Mermaid knows, any other drawn top to bottom', () => {
    expect(parseMermaid('graph LR\n A --> B').meta.mermaidDirection).toBe('LR');
    expect(parseMermaid('graph XY\n A --> B').meta.mermaidDirection).toBe('TD');
  });
});
