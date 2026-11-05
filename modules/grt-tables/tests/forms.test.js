// @vitest-environment jsdom

/** Forms and reports: fields by type, values for the database, groups and totals. */

import { describe, it, expect } from 'vitest';
import { inputFor, valuesFrom, searchFilter, buildReport, reportHtml, isOwnTable } from '../src/js/forms.js';

const COLUMNS = [{ name: 'name', type: 'TEXT' }, { name: 'qty', type: 'INTEGER' }, { name: 'price', type: 'REAL' }, { name: 'paid', type: 'BOOLEAN' }, { name: 'day', type: 'DATE' }];

describe('a form', () => {
  it('gives each column the field its type asks for', () => {
    expect(inputFor(COLUMNS[1], 3)).toContain('type="number" step="1"');
    expect(inputFor(COLUMNS[3], 1)).toContain('checked');
    expect(inputFor(COLUMNS[4], '2026-11-02')).toContain('type="date"');
    expect(inputFor({ name: 'shop', type: 'INTEGER' }, '2', { choices: new Map([['1', 'Rome'], ['2', 'Milan']]) })).toMatch(/<option value="2" selected>Milan/);
    expect(inputFor(COLUMNS[0], '<b>')).toContain('&lt;b&gt;');
  });

  it('turns fields back into values: numbers, yes or no, nothing for empty', () => {
    expect(valuesFrom(COLUMNS, { name: 'Pen', qty: '3', price: '1.5', paid: true, day: '' })).toEqual({ name: 'Pen', qty: 3, price: 1.5, paid: 1, day: null });
  });

  it('searches every column with the search text taken literally', () => {
    const { where, params } = searchFilter(COLUMNS, '50%_off');
    expect(where).toMatch(/LIKE \? ESCAPE/);
    expect(params[0]).toBe('%50\\%\\_off%');
  });

  it('keeps its own tables out of the list', () => {
    expect(isOwnTable('_grt_reports')).toBe(true);
    expect(isOwnTable('orders')).toBe(false);
  });
});

describe('a report', () => {
  const columns = ['region', 'item', 'qty', 'price'];
  const rows = [['North', 'Pen', 3, 1.5], ['South', 'Ink', 1, 4], ['North', 'Ink', 2, 4], ['South', 'Pen', 5, 1.5]];

  it('groups rows, totals each group and the whole', () => {
    const report = buildReport({ title: 'Sales', groupBy: 'region', sortBy: 'qty', descending: true, totals: { qty: 'sum', price: 'avg' } }, columns, rows);
    expect(report.groups.map((g) => [g.key, g.rows.map((r) => r[1]), g.totals.qty])).toEqual([['North', ['Pen', 'Ink'], 5], ['South', ['Pen', 'Ink'], 6]]);
    expect(report.totals).toEqual({ qty: 11, price: 2.75 });
    expect(report.columns).toEqual(['item', 'qty', 'price']);
  });

  it('is drawn with its groups, totals and a chart', () => {
    const definition = { title: 'Sales', groupBy: 'region', totals: { qty: 'sum' }, chart: true };
    const html = reportHtml(buildReport(definition, columns, rows), definition);
    expect(html).toContain('region: North');
    expect(html).toContain('<svg');
    expect(html).toMatch(/All 4 row\(s\)/);
  });
});

describe('a report names what a foreign key points at', () => {
  it('groups by the names, not the numbers', () => {
    const labels = new Map([['region', new Map([['1', 'North'], ['2', 'South']])]]);
    const report = buildReport({ groupBy: 'region', totals: { qty: 'sum' } }, ['item', 'qty', 'region'], [['Pen', 3, 1], ['Ink', 1, 2], ['Clip', 5, 2]], { labels });
    expect(report.groups.map((g) => [g.key, g.totals.qty])).toEqual([['North', 3], ['South', 6]]);
  });
});
