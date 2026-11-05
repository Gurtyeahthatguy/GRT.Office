/** Planning and live values: the critical path against one worked out by hand, and a Tables database read without its engine. */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphModel } from '../src/js/model.js';
import { criticalPath, ganttSvg, deadlinesIcs, durationOf } from '../src/js/planning.js';
import { readSqlite, pickValue, parseCell, sheetTables, cellValue, shownValue } from '../src/js/sources.js';

// The test makes its databases with Node's own SQLite, which the bundler does not know as a built-in.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/** A small project: A, then B and C side by side, D after both, E last. */
function project() {
  const model = new GraphModel();
  const node = (text, duration) => model.addNode({ x: 0, y: 0, text, data: { duration: String(duration) } });
  const [a, b, c, d, e] = [node('Design', 3), node('Build', 4), node('Buy parts', 2), node('Assemble', 2), node('Test', 1)];
  model.addNode({ x: 0, y: 0, text: 'A note, not a task' });
  for (const [from, to] of [[a, b], [a, c], [b, d], [c, d], [d, e]]) model.addEdge({ from: from.id, to: to.id });
  return { model, ids: { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id } };
}

describe('the critical path', () => {
  it('matches the one worked out by hand', () => {
    const { model } = project();
    const plan = criticalPath(model, { start: '2026-03-02' });
    // By hand: Design 0-3, Build 3-7, Buy parts 3-5 with 2 days to spare, Assemble 7-9, Test 9-10.
    expect(plan.finish).toBe(10);
    expect(plan.tasks.map((t) => [t.name, t.es, t.ef, t.slack, t.critical])).toEqual([
      ['Design', 0, 3, 0, true], ['Build', 3, 7, 0, true], ['Buy parts', 3, 5, 2, false], ['Assemble', 7, 9, 0, true], ['Test', 9, 10, 0, true],
    ]);
    expect(plan.tasks.find((t) => t.name === 'Assemble')).toMatchObject({ startDate: '2026-03-09', endDate: '2026-03-10' });
    expect(plan.edges.size).toBe(3);
  });

  it('names the tasks of a loop instead of planning it', () => {
    const { model, ids } = project();
    model.addEdge({ from: ids.e, to: ids.a });
    expect(criticalPath(model).cycle.sort()).toEqual(['Assemble', 'Build', 'Buy parts', 'Design', 'Test']);
  });

  it('reads durations written either way, and nothing else', () => {
    expect(durationOf({ data: { duration: '2,5' } })).toBe(2.5);
    expect(durationOf({ data: { days: 3 } })).toBe(3);
    expect(durationOf({ data: { duration: 'soon' } })).toBe(null);
    expect(durationOf({ data: { duration: '-1' } })).toBe(null);
    expect(durationOf({ data: {} })).toBe(null);
  });

  it('draws the Gantt chart and sends the deadlines to Dates as to-dos', () => {
    const plan = criticalPath(project().model, { start: '2026-03-02' });
    const svg = ganttSvg(plan, { start: '2026-03-02' });
    expect(svg.match(/fill="#cf222e"/g)).toHaveLength(4);
    expect(svg).toContain('Buy parts');
    const ics = deadlinesIcs(plan, { title: 'Shed, phase 1' });
    expect(ics).toContain('X-WR-CALNAME:Shed\\, phase 1');
    expect(ics).toContain('SUMMARY:Test\r\nDTSTART;VALUE=DATE:20260311\r\nDUE;VALUE=DATE:20260311');
    expect(ics.match(/BEGIN:VTODO/g)).toHaveLength(5);
  });
});

describe('a Tables database, read without its engine', () => {
  function database(build) {
    const dir = mkdtempSync(join(tmpdir(), 'grt-graphs-'));
    const file = join(dir, 'db.sqlite');
    const db = new DatabaseSync(file);
    build(db);
    db.close();
    const bytes = new Uint8Array(readFileSync(file));
    rmSync(dir, { recursive: true, force: true });
    return bytes;
  }

  it('gives every table with its columns and rows, long values and many pages included', () => {
    const bytes = database((db) => {
      db.exec('CREATE TABLE "staff" (id INTEGER PRIMARY KEY, name TEXT, boss INTEGER, pay REAL, photo BLOB)');
      db.exec("CREATE TABLE notes (\"the note\" TEXT, CONSTRAINT x CHECK (length(\"the note\") > 0))");
      const insert = db.prepare('INSERT INTO staff (name, boss, pay, photo) VALUES (?, ?, ?, ?)');
      // One transaction, as a commit per row waits on the disk and takes a minute on Windows.
      db.exec('BEGIN');
      for (let i = 1; i <= 3000; i += 1) insert.run(i === 1 ? 'Città' : `Person ${i}`, i === 1 ? null : Math.ceil(i / 3), i * 1.5, i === 2 ? new Uint8Array(10) : null);
      db.exec('COMMIT');
      db.prepare('INSERT INTO notes VALUES (?)').run('x'.repeat(20000));
      db.exec('ALTER TABLE staff ADD COLUMN team TEXT');
      db.exec("UPDATE staff SET team = 'red' WHERE id = 3000");
    });
    const { tables } = readSqlite(bytes);
    const staff = tables.find((t) => t.name === 'staff');
    expect(staff.columns).toEqual(['id', 'name', 'boss', 'pay', 'photo', 'team']);
    expect(staff.rows).toHaveLength(3000);
    expect(staff.rows[0]).toEqual([1, 'Città', null, 1.5, null, null]);
    expect(staff.rows[1][4]).toBe('«10 bytes»');
    expect(staff.rows[2999]).toEqual([3000, 'Person 3000', 1000, 4500, null, 'red']);
    expect(tables.find((t) => t.name === 'notes').rows[0][0]).toHaveLength(20000);
    expect(pickValue(staff, { column: 'pay', aggregate: 'sum', where: 'boss', equals: '2' })).toBe(4 * 1.5 + 5 * 1.5 + 6 * 1.5);
    expect(pickValue(staff, { column: 'name', where: 'id', equals: '1' })).toBe('Città');
    expect(pickValue(staff, { column: 'id', aggregate: 'count' })).toBe(3000);
  });

  it('refuses a file that is not one, and pages that point in a circle', () => {
    expect(() => readSqlite(new TextEncoder().encode('not a database at all, honest'))).toThrow(/not a SQLite/);
    const bytes = database((db) => {
      db.exec('CREATE TABLE t (a TEXT)');
      const insert = db.prepare('INSERT INTO t VALUES (?)');
      db.exec('BEGIN');
      for (let i = 0; i < 2000; i += 1) insert.run(`row ${i} ${'x'.repeat(50)}`);
      db.exec('COMMIT');
    });
    // The table's root becomes an interior page whose children include itself.
    const pageSize = (bytes[16] << 8) | bytes[17];
    const tableRoot = 2;
    const at = (tableRoot - 1) * pageSize;
    expect(bytes[at]).toBe(0x05);
    new DataView(bytes.buffer).setUint32(at + 8, tableRoot);
    expect(() => readSqlite(bytes)).toThrow(/point somewhere/);
  });
});

describe('spreadsheet values', () => {
  it('reads a cell by its reference, on a named sheet or the first', () => {
    const tables = sheetTables({ sheets: [
      { name: 'Sales', cells: { '0,0': { v: 'Region' }, '0,1': { v: 'Total' }, '1,0': { v: 'North' }, '1,1': { v: 1234.567 } } },
      { name: 'Other', cells: { '2,2': { v: 'here' } } },
    ] });
    expect(parseCell("'My sheet'.$B$3")).toEqual({ sheet: 'My sheet', row: 2, col: 1 });
    expect(cellValue(tables, 'B2')).toBe(1234.567);
    expect(cellValue(tables, 'Other.C3')).toBe('here');
    expect(shownValue(cellValue(tables, 'B2'))).toBe('1234.57');
    expect(tables[0].columns).toEqual(['Region', 'Total']);
    expect(pickValue(tables[0], { column: 'Total', where: 'Region', equals: 'North' })).toBe(1234.567);
  });
});

describe('the data table and diagrams from tables', async () => {
  const { dataTableHtml, dataFromTable, treeFromTable, liveText } = await import('../src/js/tools.js');

  it('edits every node data in one grid: renamed fields, emptied ones gone, a new one added', () => {
    const model = new GraphModel();
    const a = model.addNode({ x: 0, y: 0, text: 'A', data: { duration: '3', owner: 'Ada' } });
    const b = model.addNode({ x: 0, y: 0, text: 'B', data: { duration: '1' } });
    const { keys, html } = dataTableHtml(model);
    expect(keys).toEqual(['duration', 'owner']);
    expect(html).toContain('value="Ada"');
    const updated = new Map(dataFromTable(model, keys, {
      key_0: 'days', key_1: 'owner', key_new: 'cost',
      cell_0_0: '4', cell_0_1: '', cell_0_new: '100', cell_1_0: '1', cell_1_1: 'Bea', cell_1_new: '',
    }));
    expect(updated.get(a.id)).toEqual({ days: '4', cost: '100' });
    expect(updated.get(b.id)).toEqual({ days: '1', owner: 'Bea' });
  });

  it('draws a tree from rows that name their parent, ignoring a row that names itself', () => {
    const table = { columns: ['id', 'name', 'boss'], rows: [[1, 'Ada', null], [2, 'Bea', 1], [3, 'Carlo', 3], [4, 'Dina', 9]] };
    const tree = treeFromTable(table, { id: 'id', parent: 'boss', label: 'name' });
    expect(tree.nodes.map((n) => n.text)).toEqual(['Ada', 'Bea', 'Carlo', 'Dina']);
    expect(tree.links).toEqual([['1', '2']]);
    expect(tree.nodes[1].data).toEqual({ id: '2', name: 'Bea', boss: '1' });
  });

  it('puts a value where the text says', () => {
    expect(liveText({ template: 'Sales: {value} ({value})' }, 41.999)).toBe('Sales: 42 (42)');
    expect(liveText({}, null)).toBe('');
  });
});
