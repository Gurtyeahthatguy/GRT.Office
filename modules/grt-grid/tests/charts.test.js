/** The chart engine, and Grid's charts drawn from ranges that follow the cells. */

import { describe, it, expect } from 'vitest';
import { chartSvg, niceScale } from '../src/js/core/charts.js';
import { chartSpec, chartFromArea } from '../src/js/charts.js';
import { GridModel } from '../src/js/model.js';
import { SheetController } from '../src/js/controller.js';

const count = (svg, tag) => (svg.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
const months = { categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Rome', values: [1, 2, 3] }, { name: 'Milan', values: [4, 5, 6] }] };

describe('the chart engine', () => {
  it('steps the scale by 1, 2 or 5 times a power of ten', () => {
    expect(niceScale(0, 87)).toMatchObject({ min: 0, max: 100, step: 20 });
    expect(niceScale(-3, 7).ticks).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceScale(5, 5)).toMatchObject({ min: 0 });
  });

  it('draws a bar for every value of every series, and a legend entry for each series', () => {
    const svg = chartSvg({ type: 'column', ...months });
    expect(count(svg, 'rect')).toBe(6 + 2);
    expect(svg).toContain('>Rome</text>');
  });

  it('draws a slice per category in a pie, and a path per line', () => {
    expect(count(chartSvg({ type: 'pie', legend: 'none', ...months }), 'path')).toBe(3);
    expect(count(chartSvg({ type: 'line', legend: 'none', ...months }), 'path')).toBe(2);
  });

  it('stacks to the sum, and to 100 when asked', () => {
    expect(chartSvg({ type: 'column', stacked: 'stacked', ...months })).toContain('>10</text>');
    expect(chartSvg({ type: 'column', stacked: 'percent', ...months })).toContain('>100%</text>');
  });

  it('leaves a gap where a value is missing', () => {
    const svg = chartSvg({ type: 'line', legend: 'none', categories: ['a', 'b', 'c'], series: [{ values: [1, null, 3] }] });
    expect(svg.match(/d="([^"]+)"/)[1].match(/M/g)).toHaveLength(2);
  });

  it('writes text from a file as text, and a colour from a file only when it is a colour', () => {
    const svg = chartSvg({ type: 'column', title: '<script>x</script>', series: [{ name: 'a"b', values: [1], color: '" onload="x' }] });
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('onload');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('draws no more than its limit of points from a huge range', () => {
    const svg = chartSvg({ type: 'column', legend: 'none', series: [{ values: Array.from({ length: 100000 }, (_, i) => i) }] });
    expect(count(svg, 'rect')).toBe(4000);
  });
});

function workbook() {
  const model = new GridModel({ version: 1, sheets: [{ name: 'Sales', cells: {
    '0,0': { v: 'Month' }, '0,1': { v: 'Rome' }, '0,2': { v: 'Milan' },
    '1,0': { v: 'Jan' }, '1,1': { v: 10 }, '1,2': { v: 7 },
    '2,0': { v: 'Feb' }, '2,1': { v: 12 }, '2,2': { f: '=B3*2' },
  } }] });
  return { model, sheet: new SheetController(model, { onChange: () => {} }) };
}

describe('charts in Grid', () => {
  it('takes series names from the first row and labels from the first column', () => {
    const { model, sheet } = workbook();
    const chart = chartFromArea(model.sheet, { top: 0, left: 0, bottom: 2, right: 2 });
    expect(chart.series).toEqual([
      { nameRef: 'Sales!$B$1', values: 'Sales!$B$2:$B$3', categories: 'Sales!$A$2:$A$3' },
      { nameRef: 'Sales!$C$1', values: 'Sales!$C$2:$C$3', categories: 'Sales!$A$2:$A$3' },
    ]);
    const spec = chartSpec(chart, sheet.engine, model);
    expect(spec.categories).toEqual(['Jan', 'Feb']);
    expect(spec.series.map((s) => [s.name, s.values])).toEqual([['Rome', [10, 12]], ['Milan', [7, 24]]]);
  });

  it('follows the data when a value changes and when rows are inserted above it', () => {
    const { model, sheet } = workbook();
    sheet.select(0, 0);
    const id = sheet.insertChart(chartFromArea(model.sheet, { top: 0, left: 0, bottom: 2, right: 2 }));
    sheet.setCell(1, 1, '99');
    expect(chartSpec(model.charts[0], sheet.engine, model).series[0].values).toEqual([99, 12]);
    sheet.insertRows(0, 2);
    expect(model.charts[0].series[0].values).toBe('Sales!$B$4:$B$5');
    expect(model.charts[0].anchor.row).toBe(2);
    expect(chartSpec(model.charts[0], sheet.engine, model).series[0].values).toEqual([99, 12]);
    sheet.step(-1);
    sheet.deleteChart(id);
    expect(model.charts).toHaveLength(0);
    sheet.step(-1);
    expect(model.charts).toHaveLength(1);
  });

  it('makes a scatter chart with the first column as the x values', () => {
    const model = new GridModel({ version: 1, sheets: [{ name: 'S', cells: { '0,0': { v: 1 }, '0,1': { v: 5 }, '1,0': { v: 2 }, '1,1': { v: 6 } } }] });
    const sheet = new SheetController(model, { onChange: () => {} });
    const chart = chartFromArea(model.sheet, { top: 0, left: 0, bottom: 1, right: 1 }, { type: 'scatter' });
    expect(chart.series).toEqual([{ values: 'S!$B$1:$B$2', x: 'S!$A$1:$A$2' }]);
    expect(chartSpec(chart, sheet.engine, model).series[0].x).toEqual([1, 2]);
  });
});
