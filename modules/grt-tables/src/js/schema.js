/** The table designer, and the SQL it is about to run. */

/** The types lists, and what SQLite stores them as. */
export const TYPES = [
  { id: 'TEXT', label: 'Text', sqlite: 'TEXT' },
  { id: 'INTEGER', label: 'Whole number', sqlite: 'INTEGER' },
  { id: 'REAL', label: 'Decimal', sqlite: 'REAL' },
  { id: 'BOOLEAN', label: 'Yes or no', sqlite: 'INTEGER' },
  { id: 'DATE', label: 'Date', sqlite: 'TEXT' },
  { id: 'TIME', label: 'Time', sqlite: 'TEXT' },
  { id: 'BLOB', label: 'File', sqlite: 'BLOB' },
];

export const ON_DELETE = ['NO ACTION', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'CASCADE'];

/** Quotes an identifier. */
export function quoteIdent(name) {
  return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

/** A SQL string literal, for default values. */
export function quoteLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** Whether a name is usable. */
export function checkName(name) {
  const text = String(name ?? '').trim();
  if (!text) return 'A name is needed';
  if (text.length > 128) return 'That name is too long';
  if (/[\0\n\r]/.test(text)) return 'A name cannot contain a line break';
  if (/^sqlite_/i.test(text)) return 'Names beginning with sqlite_ are reserved';
  return null;
}

/** A blank column for the designer. */
export function newColumn(name = '') {
  return {
    name,
    type: 'TEXT',
    notNull: false,
    unique: false,
    primaryKey: false,
    default: '',
    check: '',
    references: null,     // { table, column, onDelete }.
  };
}

export function newTable(name = '') {
  return {
    name,
    columns: [
      { ...newColumn('id'), type: 'INTEGER', primaryKey: true, notNull: true },
    ],
  };
}

/**
 * The `CREATE TABLE` for a designed table.
 * @param {Object} table
 * @returns {{sql: string, problems: string[]}}
 */
export function createTableSql(table) {
  const problems = [];

  const nameProblem = checkName(table.name);
  if (nameProblem) problems.push(nameProblem);

  const columns = table.columns ?? [];
  if (columns.length === 0) problems.push('A table needs at least one column');

  const seen = new Set();
  for (const column of columns) {
    const problem = checkName(column.name);
    if (problem) problems.push(`Column: ${problem}`);
    const key = String(column.name ?? '').toLowerCase();
    if (seen.has(key)) problems.push(`Two columns are both called ${column.name}`);
    seen.add(key);
  }

  const keys = columns.filter((column) => column.primaryKey);
  if (keys.length > 1) {
    problems.push('Only one column can be the primary key here; use a table constraint for more');
  }

  const lines = columns.map((column) => columnSql(column));

  for (const column of columns) {
    if (!column.references?.table) continue;
    const target = column.references;
    lines.push(
      `FOREIGN KEY (${quoteIdent(column.name)}) REFERENCES ${quoteIdent(target.table)}`
      + `(${quoteIdent(target.column ?? 'id')})`
      + (target.onDelete && target.onDelete !== 'NO ACTION'
        ? ` ON DELETE ${target.onDelete}` : ''),
    );
  }

  const sql = `CREATE TABLE ${quoteIdent(table.name)} (\n  ${lines.join(',\n  ')}\n);`;

  return { sql, problems };
}

function columnSql(column) {
  const parts = [quoteIdent(column.name), typeOf(column)];

  if (column.primaryKey) parts.push('PRIMARY KEY');
  if (column.notNull && !column.primaryKey) parts.push('NOT NULL');
  if (column.unique && !column.primaryKey) parts.push('UNIQUE');

  if (column.default !== '' && column.default !== null && column.default !== undefined) {
    parts.push(`DEFAULT ${defaultSql(column)}`);
  }

  if (column.check) parts.push(`CHECK (${column.check})`);

  // A boolean is an integer in SQLite, so the constraint is what makes it
  // one.
  if (column.type === 'BOOLEAN') {
    parts.push(`CHECK (${quoteIdent(column.name)} IN (0, 1))`);
  }

  return parts.join(' ');
}

function typeOf(column) {
  return TYPES.find((type) => type.id === column.type)?.sqlite ?? 'TEXT';
}

function defaultSql(column) {
  const value = String(column.default);
  if (column.type === 'INTEGER' || column.type === 'REAL') {
    return Number.isFinite(Number(value)) ? value : quoteLiteral(value);
  }
  if (column.type === 'BOOLEAN') {
    return /^(true|1|yes)$/i.test(value) ? '1' : '0';
  }
  // A bare word that is a SQLite function is passed through; anything else is
  // a literal.
  if (/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NULL)$/i.test(value.trim())) {
    return value.trim().toUpperCase();
  }
  return quoteLiteral(value);
}

/** `DROP TABLE`, which the interface must confirm before running. */
export function dropTableSql(name) {
  return `DROP TABLE ${quoteIdent(name)};`;
}

export function createIndexSql(table, columns, { unique = false, name = null } = {}) {
  const indexName = name ?? `${table}_${columns.join('_')}`;
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(indexName)} `
    + `ON ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')});`;
}

/** Adds a column to a table that already has rows. */
export function addColumnSql(table, column) {
  return `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnSql(column)};`;
}

export function renameTableSql(from, to) {
  return `ALTER TABLE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)};`;
}

/** What SQLite can and cannot change about an existing table. */
export function alterationsPossible() {
  return {
    canDo: ['add a column', 'rename a column', 'rename the table'],
    cannotDo: [
      'change a column’s type',
      'remove a constraint',
      'reorder columns',
    ],
    why: 'SQLite’s ALTER TABLE does not do these. They need the table '
      + 'rebuilt and the data copied, which this program does not do yet.',
  };
}

// Reading a schema back

/** Turns what the backend reports into what the designer edits. */
export function columnsFromSchema(described) {
  return (described?.columns ?? []).map((column) => ({
    ...newColumn(column.name),
    type: guessType(column.type),
    notNull: Boolean(column.notNull),
    primaryKey: Boolean(column.primaryKey),
    default: column.default ?? '',
    references: referenceFor(described, column.name),
  }));
}

function referenceFor(described, columnName) {
  const key = (described?.foreignKeys ?? []).find((entry) => entry.column === columnName);
  if (!key) return null;
  return { table: key.table, column: key.toColumn ?? 'id', onDelete: key.onDelete };
}

/**
 * SQLite's declared types are advisory, so this maps what is there onto what
 * the designer offers rather than insisting on an exact match.
 */
export function guessType(declared) {
  const text = String(declared ?? '').toUpperCase();
  if (text.includes('INT')) return 'INTEGER';
  if (text.includes('REAL') || text.includes('FLOA') || text.includes('DOUB')) return 'REAL';
  if (text.includes('BLOB')) return 'BLOB';
  if (text.includes('BOOL')) return 'BOOLEAN';
  if (text.includes('DATE')) return 'DATE';
  if (text.includes('TIME')) return 'TIME';
  return 'TEXT';
}

// Inferring a schema from a CSV file

/**
 * Proposes column types from the first rows of a file.
 * @param {string[][]} rows including the header row if there is one
 * @returns {{header: boolean, columns: Object[]}}
 */
export function inferSchema(rows, { sampleSize = 200 } = {}) {
  if (!rows || rows.length === 0) return { header: false, columns: [] };

  const width = Math.max(...rows.map((row) => row.length));
  const header = looksLikeHeader(rows);
  const body = (header ? rows.slice(1) : rows).slice(0, sampleSize);

  const columns = [];
  for (let index = 0; index < width; index += 1) {
    const values = body.map((row) => (row[index] ?? '').trim());
    const filled = values.filter((value) => value !== '');

    columns.push({
      ...newColumn(columnName(header ? rows[0][index] : null, index)),
      type: typeFrom(filled),
      notNull: filled.length === values.length && values.length > 0,
      sample: filled.slice(0, 3),
      blanks: values.length - filled.length,
      confident: filled.length >= Math.max(3, values.length / 2),
    });
  }

  return { header, columns };
}

/** Whether the first row is names rather than data. */
function looksLikeHeader(rows) {
  if (rows.length < 2) return false;

  const first = rows[0].map((v) => String(v ?? '').trim());
  if (first.some((value) => value === '')) return false;
  if (first.every((value) => isNumeric(value))) return false;

  const rest = rows.slice(1, 20);
  const anyNumeric = rest.some((row) => row.some((value) => isNumeric(String(value ?? '').trim())));

  return anyNumeric || first.every((value) => /^[\p{L}_][\p{L}\p{N}_ -]*$/u.test(value));
}

function columnName(raw, index) {
  const cleaned = String(raw ?? '').trim().replace(/[\0\n\r]/g, '');
  if (!cleaned) return `column_${index + 1}`;
  if (/^sqlite_/i.test(cleaned)) return `c_${cleaned}`;
  return cleaned;
}

function typeFrom(values) {
  if (values.length === 0) return 'TEXT';
  if (values.every((value) => /^(true|false|yes|no|0|1)$/i.test(value))) {
    // All ones and zeros could equally be numbers; booleans only when the
    // words appear, because guessing wrong here changes what a sum means.
    if (values.some((value) => /^(true|false|yes|no)$/i.test(value))) return 'BOOLEAN';
  }
  if (values.every((value) => /^-?\d+$/.test(value))) return 'INTEGER';
  if (values.every(isNumeric)) return 'REAL';
  if (values.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) return 'DATE';
  return 'TEXT';
}

function isNumeric(value) {
  return /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);
}
