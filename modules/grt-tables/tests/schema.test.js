/** The designer, and the SQL it shows before it runs anything. */

import { describe, it, expect } from 'vitest';
import {
  TYPES, quoteIdent, quoteLiteral, checkName, newTable, newColumn,
  createTableSql, dropTableSql, createIndexSql, addColumnSql, renameTableSql,
  guessType, columnsFromSchema, inferSchema, alterationsPossible,
} from '../src/js/schema.js';

describe('quoting', () => {
  it('quotes an identifier by doubling its quotes', () => {
    expect(quoteIdent('plain')).toBe('"plain"');
    expect(quoteIdent('has"quote')).toBe('"has""quote"');
  });

  it('makes a name containing an attack into just a name', () => {
    expect(quoteIdent('x"; DROP TABLE y; --')).toBe('"x""; DROP TABLE y; --"');
  });

  it('quotes a literal the same way', () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });
});

describe('names', () => {
  it('accepts an ordinary one', () => {
    expect(checkName('contacts')).toBeNull();
  });

  it('refuses what cannot be typed again', () => {
    expect(checkName('')).toBeTruthy();
    expect(checkName('with\nnewline')).toBeTruthy();
    expect(checkName('x'.repeat(200))).toBeTruthy();
  });

  it('refuses names SQLite reserves for itself', () => {
    expect(checkName('sqlite_master')).toBeTruthy();
  });
});

describe('CREATE TABLE', () => {
  const table = (columns, name = 'contacts') => ({ name, columns });

  it('builds a statement from the designer', () => {
    const { sql, problems } = createTableSql(newTable('contacts'));
    expect(problems).toEqual([]);
    expect(sql).toContain('CREATE TABLE "contacts"');
    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
  });

  it('writes the constraints that were ticked', () => {
    const column = { ...newColumn('email'), notNull: true, unique: true };
    const { sql } = createTableSql(table([column]));
    expect(sql).toContain('"email" TEXT NOT NULL UNIQUE');
  });

  it('does not repeat NOT NULL on a primary key', () => {
    const column = { ...newColumn('id'), type: 'INTEGER', primaryKey: true, notNull: true };
    const { sql } = createTableSql(table([column]));
    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
    expect(sql).not.toContain('PRIMARY KEY NOT NULL');
  });

  it('maps the offered types onto what SQLite stores', () => {
    for (const type of TYPES) {
      const { sql } = createTableSql(table([{ ...newColumn('v'), type: type.id }]));
      expect(sql).toContain(`"v" ${type.sqlite}`);
    }
  });

  it('makes a boolean a constrained integer, since SQLite has no boolean', () => {
    const { sql } = createTableSql(table([{ ...newColumn('done'), type: 'BOOLEAN' }]));
    expect(sql).toContain('"done" INTEGER');
    expect(sql).toContain('CHECK ("done" IN (0, 1))');
  });

  it('quotes a text default and leaves a number alone', () => {
    const text = createTableSql(table([{ ...newColumn('a'), default: "it's" }])).sql;
    expect(text).toContain("DEFAULT 'it''s'");

    const number = createTableSql(table([{ ...newColumn('n'), type: 'INTEGER', default: '7' }])).sql;
    expect(number).toContain('DEFAULT 7');
  });

  it('passes a SQLite function through rather than quoting it', () => {
    const { sql } = createTableSql(table([{ ...newColumn('at'), type: 'DATE', default: 'CURRENT_TIMESTAMP' }]));
    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP');
    expect(sql).not.toContain("'CURRENT_TIMESTAMP'");
  });

  it('writes a foreign key with its delete action', () => {
    const column = {
      ...newColumn('author_id'),
      type: 'INTEGER',
      references: { table: 'author', column: 'id', onDelete: 'CASCADE' },
    };
    const { sql } = createTableSql(table([column], 'book'));
    expect(sql).toContain('FOREIGN KEY ("author_id") REFERENCES "author"("id") ON DELETE CASCADE');
  });

  it('reports problems instead of producing broken SQL', () => {
    expect(createTableSql(table([], '')).problems.length).toBeGreaterThan(0);
    expect(createTableSql(table([newColumn('a'), newColumn('a')])).problems.join(' '))
      .toContain('both called');
    expect(createTableSql(table([
      { ...newColumn('a'), primaryKey: true },
      { ...newColumn('b'), primaryKey: true },
    ])).problems.join(' ')).toContain('Only one');
  });

  it('still shows the statement when there are problems, so it can be read', () => {
    const { sql } = createTableSql(table([newColumn('a'), newColumn('a')]));
    expect(sql).toContain('CREATE TABLE');
  });
});

describe('the other statements', () => {
  it('drops, indexes, adds and renames', () => {
    expect(dropTableSql('t')).toBe('DROP TABLE "t";');
    expect(createIndexSql('book', ['title'])).toContain('CREATE INDEX "book_title" ON "book" ("title")');
    expect(createIndexSql('book', ['a', 'b'], { unique: true })).toContain('CREATE UNIQUE INDEX');
    expect(addColumnSql('t', newColumn('extra'))).toBe('ALTER TABLE "t" ADD COLUMN "extra" TEXT;');
    expect(renameTableSql('a', 'b')).toBe('ALTER TABLE "a" RENAME TO "b";');
  });

  it('says what SQLite cannot alter, rather than half-doing it', () => {
    const limits = alterationsPossible();
    expect(limits.cannotDo.join(' ')).toContain('type');
    expect(limits.why).toContain('rebuilt');
  });
});

describe('reading a schema back into the designer', () => {
  it('maps SQLite’s advisory types onto the offered ones', () => {
    expect(guessType('INTEGER')).toBe('INTEGER');
    expect(guessType('BIGINT')).toBe('INTEGER');
    expect(guessType('VARCHAR(200)')).toBe('TEXT');
    expect(guessType('DOUBLE PRECISION')).toBe('REAL');
    expect(guessType('BOOLEAN')).toBe('BOOLEAN');
    expect(guessType('')).toBe('TEXT');
  });

  it('carries the constraints and the foreign key across', () => {
    const columns = columnsFromSchema({
      columns: [
        { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true, default: null },
        { name: 'author_id', type: 'INTEGER', notNull: false, primaryKey: false, default: null },
      ],
      foreignKeys: [{ column: 'author_id', table: 'author', toColumn: 'id', onDelete: 'CASCADE' }],
    });

    expect(columns[0].primaryKey).toBe(true);
    expect(columns[1].references).toEqual({ table: 'author', column: 'id', onDelete: 'CASCADE' });
  });
});

// types are proposed, never inferred in silence

describe('guessing a schema from a CSV file', () => {
  const rows = [
    ['name', 'age', 'joined', 'active'],
    ['Ada', '36', '1815-12-10', 'true'],
    ['Grace', '85', '1906-12-09', 'false'],
    ['Alan', '41', '1912-06-23', 'true'],
  ];

  it('spots a header row', () => {
    expect(inferSchema(rows).header).toBe(true);
  });

  it('does not invent a header when the first row is data', () => {
    expect(inferSchema([['1', '2'], ['3', '4']]).header).toBe(false);
  });

  it('proposes a type for each column', () => {
    const { columns } = inferSchema(rows);
    expect(columns.map((c) => c.type)).toEqual(['TEXT', 'INTEGER', 'DATE', 'BOOLEAN']);
  });

  it('names the columns after the header', () => {
    expect(inferSchema(rows).columns.map((c) => c.name))
      .toEqual(['name', 'age', 'joined', 'active']);
  });

  it('invents names when there is no header', () => {
    expect(inferSchema([['1', '2']]).columns.map((c) => c.name))
      .toEqual(['column_1', 'column_2']);
  });

  it('returns the evidence, so the guess can be judged rather than trusted', () => {
    const { columns } = inferSchema(rows);
    expect(columns[1].sample).toEqual(['36', '85', '41']);
    expect(columns[1].confident).toBe(true);
    expect(columns[1].blanks).toBe(0);
  });

  it('says when it saw too little to be sure', () => {
    const sparse = [['a'], [''], [''], ['']];
    expect(inferSchema(sparse).columns[0].confident).toBe(false);
  });

  it('does not call a column required when it has blanks', () => {
    const withGap = [['n'], ['1'], [''], ['3']];
    expect(inferSchema(withGap).columns[0].notNull).toBe(false);
  });

  it('prefers a number to a boolean when only ones and zeros appear', () => {
    // Guessing boolean here would change what a sum of the column means.
    const digits = [['flag'], ['1'], ['0'], ['1']];
    expect(inferSchema(digits).columns[0].type).toBe('INTEGER');
  });

  it('does not let a column be called something SQLite reserves', () => {
    const reserved = [['sqlite_x'], ['1']];
    expect(inferSchema(reserved).columns[0].name).not.toMatch(/^sqlite_/);
  });

  it('copes with an empty file', () => {
    expect(inferSchema([])).toEqual({ header: false, columns: [] });
  });
});
