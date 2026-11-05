/** Formula text to tokens. */

export const ERRORS = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!', '#SPILL!', '#CALC!'];

export const TOKEN = {
  number: 'number',
  string: 'string',
  boolean: 'boolean',
  error: 'error',
  identifier: 'identifier',   // a function name, or a defined name.
  reference: 'reference',     // A1, $A$1.
  operator: 'operator',
  open: 'open',
  close: 'close',
  separator: 'separator',
  colon: 'colon',
  sheet: 'sheet',             // Sheet2! prefix.
  spill: 'spill',             // the # after A1#.
  array: 'array',             // {1,2;3,4}.
};

const OPERATORS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '%', '&', '=', '<', '>'];

class Failure extends Error {}

/**
 * @param {string} text with or without the leading `=`
 * @returns {{tokens: Object[], error: ?string}}
 */
export function tokenize(text) {
  const source = String(text ?? '').replace(/^=/, '');
  const tokens = [];
  let i = 0;

  try {
    while (i < source.length) {
      const character = source[i];

      if (/\s/.test(character)) { i += 1; continue; }

      if (character === '"') { i = readString(source, i, tokens); continue; }
      if (character === '{') { i = readArray(source, i, tokens); continue; }
      if (character === '(') { tokens.push({ type: TOKEN.open }); i += 1; continue; }
      if (character === ')') { tokens.push({ type: TOKEN.close }); i += 1; continue; }
      if (character === ',' || character === ';') {
        tokens.push({ type: TOKEN.separator }); i += 1; continue;
      }
      if (character === ':') { tokens.push({ type: TOKEN.colon }); i += 1; continue; }

      // A1# is the whole of what A1 spills.
      if (character === '#' && tokens.at(-1)?.type === TOKEN.reference && !ERRORS.some((e) => source.startsWith(e, i))) {
        tokens.push({ type: TOKEN.spill }); i += 1; continue;
      }
      if (character === '#') { i = readError(source, i, tokens); continue; }
      if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
        i = readNumber(source, i, tokens); continue;
      }
      if (/[A-Za-z_$']/.test(character)) { i = readWord(source, i, tokens); continue; }

      const operator = OPERATORS.find((op) => source.startsWith(op, i));
      if (operator) { tokens.push({ type: TOKEN.operator, value: operator }); i += operator.length; continue; }

      throw new Failure(`Unexpected character ${character}`);
    }
  } catch (failure) {
    if (failure instanceof Failure) return { tokens: [], error: failure.message };
    throw failure;
  }

  return { tokens, error: null };
}

/** Reads an array constant: columns split by commas, rows by semicolons. */
function readArray(source, start, tokens) {
  const rows = [[]];
  let i = start + 1;
  for (;;) {
    while (/\s/.test(source[i] ?? '')) i += 1;
    const c = source[i];
    if (c === undefined) throw new Failure('An array was never closed');
    if (c === '}') { i += 1; break; }
    if (c === ',') { i += 1; continue; }
    if (c === ';') { rows.push([]); i += 1; continue; }
    const found = [];
    if (c === '"') i = readString(source, i, found);
    else if (c === '#') i = readError(source, i, found);
    else if (/[0-9.+-]/.test(c)) {
      const sign = c === '-' ? -1 : 1;
      if (c === '-' || c === '+') i += 1;
      i = readNumber(source, i, found);
      found[0].value *= sign;
    } else {
      const word = /^(TRUE|FALSE)/i.exec(source.slice(i));
      if (!word) throw new Failure('An array may hold only numbers, text, logical values and errors');
      found.push({ type: TOKEN.boolean, value: word[1].toUpperCase() === 'TRUE' });
      i += word[1].length;
    }
    rows[rows.length - 1].push(found[0].value);
  }
  const width = rows[0].length;
  if (width === 0 || rows.some((row) => row.length !== width)) throw new Failure('Every row of an array must be as long as the first');
  tokens.push({ type: TOKEN.array, value: rows });
  return i;
}

/** Reads a literal string. */
function readString(source, start, tokens) {
  let i = start + 1;
  let value = '';

  while (i < source.length) {
    if (source[i] === '"') {
      if (source[i + 1] === '"') { value += '"'; i += 2; continue; }
      tokens.push({ type: TOKEN.string, value });
      return i + 1;
    }
    value += source[i];
    i += 1;
  }

  throw new Failure('A quoted string was never closed');
}

function readNumber(source, start, tokens) {
  let i = start;
  while (i < source.length && /[0-9]/.test(source[i])) i += 1;
  if (source[i] === '.') {
    i += 1;
    while (i < source.length && /[0-9]/.test(source[i])) i += 1;
  }
  if (/[eE]/.test(source[i] ?? '')) {
    let j = i + 1;
    if (/[+-]/.test(source[j] ?? '')) j += 1;
    if (/[0-9]/.test(source[j] ?? '')) {
      i = j;
      while (i < source.length && /[0-9]/.test(source[i])) i += 1;
    }
  }

  tokens.push({ type: TOKEN.number, value: Number.parseFloat(source.slice(start, i)) });
  return i;
}

function readError(source, start, tokens) {
  const found = ERRORS.find((error) => source.startsWith(error, start));
  if (!found) throw new Failure('Unrecognised error value');
  tokens.push({ type: TOKEN.error, value: found });
  return start + found.length;
}

/** Reads a word: a reference, a sheet name, a function name, or a boolean. */
function readWord(source, start, tokens) {
  let i = start;

  // A quoted sheet name: 'My Sheet'!A1.
  if (source[i] === "'") {
    i += 1;
    let name = '';
    while (i < source.length && source[i] !== "'") { name += source[i]; i += 1; }
    if (source[i] !== "'") throw new Failure('A quoted sheet name was never closed');
    i += 1;
    if (source[i] !== '!') throw new Failure('A quoted name must be followed by !');
    tokens.push({ type: TOKEN.sheet, value: name });
    return i + 1;
  }

  while (i < source.length && /[A-Za-z0-9_.$]/.test(source[i])) i += 1;
  const word = source.slice(start, i);

  if (source[i] === '!') {
    tokens.push({ type: TOKEN.sheet, value: word });
    return i + 1;
  }

  if (/^(TRUE|FALSE)$/i.test(word) && source[i] !== '(') {
    tokens.push({ type: TOKEN.boolean, value: word.toUpperCase() === 'TRUE' });
    return i;
  }

  // DAYS360( and LOG10( are functions, not cells.
  if (/^\$?[A-Za-z]+\$?[0-9]+$/.test(word) && source[i] !== '(') {
    tokens.push({ type: TOKEN.reference, value: word });
    return i;
  }

  tokens.push({ type: TOKEN.identifier, value: word.toUpperCase() });
  return i;
}
