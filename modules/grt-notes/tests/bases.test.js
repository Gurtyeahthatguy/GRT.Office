/** Views over notes, as Obsidian's .base files describe them. */

import { describe, it, expect } from 'vitest';
import { parseYaml, parseExpression, evaluate, noteFacts, runBase } from '../src/js/bases.js';

const ROOT = '/vault';
const note = (path, text, modified = 1700000000) => noteFacts(`${ROOT}/${path}`, ROOT, text, { modified });
const FILES = [
  note('Books/Dune.md', '---\ntags: [book, scifi]\nstatus: read\npages: 412\nrating: 5\nfinished: 2024-03-01\n---\nA classic. See [[Foundation]].'),
  note('Books/Foundation.md', '---\ntags:\n  - book\nstatus: reading\npages: 255\nrating: 4\n---\nAsimov #scifi/classic'),
  note('Books/Notes on reading.md', 'No properties, mentions #book in passing.'),
  note('Projects/Garden.md', '---\nstatus: active\n---\nPlant [[Dune]] seeds?'),
];

const BASE = `
filters:
  and:
    - file.hasTag("book")
    - 'file.inFolder("Books")'
formulas:
  per_star: (pages / rating).toFixed(1)
  label: 'if(status == "read", "done", "open")'
properties:
  formula.per_star:
    displayName: Pages per star
views:
  - type: table
    name: All books
    order:
      - file.name
      - status
      - formula.per_star
      - formula.label
    sort:
      - property: pages
        direction: DESC
  - type: cards
    name: Unread
    filters:
      not:
        - status == "read"
    limit: 5
`;

describe('a base file', () => {
  it('reads as YAML: maps, lists, quoted strings', () => {
    const base = parseYaml(BASE);
    expect(base.filters.and).toEqual(['file.hasTag("book")', 'file.inFolder("Books")']);
    expect(base.views[0].sort).toEqual([{ property: 'pages', direction: 'DESC' }]);
    expect(base.views[1].filters.not).toEqual(['status == "read"']);
    expect(base.properties['formula.per_star'].displayName).toBe('Pages per star');
  });

  it('works out expressions as Obsidian does', () => {
    const [dune] = FILES;
    const value = (source) => evaluate(parseExpression(source), dune);
    expect(value('pages > 400 && status == "read"')).toBe(true);
    expect(value('file.tags.contains("scifi")')).toBe(true);
    expect(value('file.hasLink("Foundation")')).toBe(true);
    expect(value('file.basename + " (" + rating + ")"')).toBe('Dune (5)');
    expect(value('(finished + "1M").format("YYYY-MM-DD")')).toBe('2024-04-01');
    expect(value('missing == null')).toBe(true);
    expect(() => parseExpression('pages >')).toThrow();
  });

  it('gives the rows of a view, filtered, with formulas and sorted', () => {
    const result = runBase(parseYaml(BASE), FILES, 0);
    expect(result.views.map((v) => v.name)).toEqual(['All books', 'Unread']);
    expect(result.columns.map((c) => c.label)).toEqual(['file.name', 'status', 'Pages per star', 'label']);
    expect(result.groups[0].rows.map((r) => r.file.basename)).toEqual(['Dune', 'Foundation', 'Notes on reading']);
    expect(result.groups[0].rows[0].values['formula.per_star']).toBe('82.4');
    expect(result.groups[0].rows[1].values['formula.label']).toBe('open');
  });

  it('adds a view’s own filters to the base’s', () => {
    const result = runBase(parseYaml(BASE), FILES, 1);
    expect(result.view.type).toBe('cards');
    expect(result.groups[0].rows.map((r) => r.file.basename).sort()).toEqual(['Foundation', 'Notes on reading']);
  });

  it('says what is wrong with a formula rather than failing', () => {
    expect(runBase({ filters: 'pages >', views: [] }, FILES).error).toMatch(/formula/);
  });

  it('does not go round in circles when formulas use each other', () => {
    const result = runBase(parseYaml('formulas:\n  a: formula.b + 1\n  b: formula.a + 1\nviews:\n  - type: table\n    order: [formula.a]'), FILES.slice(0, 1));
    expect(result.error).toBeUndefined();
  });
});
