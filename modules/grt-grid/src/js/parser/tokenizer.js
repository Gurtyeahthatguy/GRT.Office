/** Formula text to tokens. */

export const ERRORS = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!'];

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
      if (character === '(') { tokens.push({ type: TOKEN.open }); i += 1; continue; }
      if (character === ')') { tokens.push({ type: TOKEN.close }); i += 1; continue; }
      if (character === ',' || character === ';') {
        tokens.push({ type: TOKEN.separator }); i += 1; continue;
      }
      if (character === ':') { tokens.push({ type: TOKEN.colon }); i += 1; continue; }

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

  if (/^(TRUE|FALSE)$/i.test(word)) {
    tokens.push({ type: TOKEN.boolean, value: word.toUpperCase() === 'TRUE' });
    return i;
  }

  if (/^\$?[A-Za-z]+\$?[0-9]+$/.test(word)) {
    tokens.push({ type: TOKEN.reference, value: word });
    return i;
  }

  tokens.push({ type: TOKEN.identifier, value: word.toUpperCase() });
  return i;
}
