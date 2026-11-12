/** The D functions: a table with a header row, a field, and a block of conditions read the way Calc reads them. */

import { ERROR, isError, isBlank, toText, Matrix } from '../engine/values.js';
import { criterion } from './criteria.js';
import { FUNCTIONS } from './index.js';

const normalised = (v) => String(toText(v)).trim().toLowerCase();

/** The column a field names: its header text, or its number counted from 1. */
function fieldIndex(header, arg) {
  if (!arg || arg.missing) return null;
  const v = arg.matrix ? arg.matrix.first : arg.value;
  if (isError(v)) return v;
  if (typeof v === 'number') {
    const i = Math.trunc(v) - 1;
    return i >= 0 && i < header.length ? i : ERROR.value;
  }
  const i = header.findIndex((h) => normalised(h) === normalised(v));
  return i === -1 ? ERROR.value : i;
}

/** The rows of the table that meet the conditions: a row of conditions is AND, the rows are OR. */
function matching(args) {
  const table = args[0]?.matrix;
  const conditions = args[2]?.matrix;
  if (!table || !conditions || table.rows < 1 || conditions.rows < 1) return ERROR.value;
  const header = table.data[0];
  const names = conditions.data[0].map((name) => (isBlank(name) ? null : header.findIndex((h) => normalised(h) === normalised(name))));
  if (names.some((i) => i === -1)) return ERROR.value;
  const tests = [];
  for (let r = 1; r < conditions.rows; r += 1) {
    const row = [];
    conditions.data[r].forEach((value, c) => {
      if (names[c] === null || isBlank(value)) return;
      const test = criterion(typeof value === 'string' && !/^(<=|>=|<>|=|<|>)/.test(value) ? `=${value}` : value);
      if (!isError(test)) row.push([names[c], test]);
    });
    tests.push(row);
  }
  const rows = [];
  for (let r = 1; r < table.rows; r += 1) {
    const record = table.data[r];
    // A row of conditions with nothing in it lets every record through.
    if (tests.length === 0 || tests.some((row) => row.every(([i, test]) => test(record[i] ?? null)))) rows.push(record);
  }
  return { header, rows };
}

/** A D function: the values of one field in the matching rows, handed to the plain function. */
const over = (name, { numbersOnly = true, needsField = true } = {}) => (args, context) => {
  if (args.length < 2 || args.length > 3) return ERROR.value;
  const found = matching(args.length === 2 ? [args[0], { missing: true }, args[1]] : args);
  if (isError(found)) return found;
  const index = fieldIndex(found.header, args.length === 2 ? undefined : args[1]);
  if (isError(index)) return index;
  if (index === null) {
    if (needsField) return ERROR.value;
    return found.rows.length;
  }
  let values = found.rows.map((record) => record[index] ?? null);
  if (numbersOnly) values = values.filter((v) => typeof v === 'number');
  const matrix = Matrix.column(values.length ? values : [null]);
  return FUNCTIONS[name]([{ value: matrix.first, values: matrix.flat, grid: matrix.data, matrix }], context);
};

export const DATABASE = {
  DSUM: over('SUM'),
  DAVERAGE: over('AVERAGE'),
  DCOUNT: over('COUNT', { needsField: false }),
  DCOUNTA: over('COUNTA', { numbersOnly: false, needsField: false }),
  DMAX: over('MAX'),
  DMIN: over('MIN'),
  DPRODUCT: over('PRODUCT'),
  DSTDEV: over('STDEV'),
  DSTDEVP: over('STDEV.P'),
  DVAR: over('VAR.S'),
  DVARP: over('VAR.P'),
  DGET: (args) => {
    if (args.length !== 3) return ERROR.value;
    const found = matching(args);
    if (isError(found)) return found;
    const index = fieldIndex(found.header, args[1]);
    if (isError(index)) return index;
    if (found.rows.length === 0) return ERROR.value;
    if (found.rows.length > 1) return ERROR.num;
    return found.rows[0][index] ?? null;
  },
};
